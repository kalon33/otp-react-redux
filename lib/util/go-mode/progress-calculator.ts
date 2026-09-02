import type { Itinerary, LatLngArray, Leg } from '@opentripplanner/types'

import { calculateDistance } from './position-matching'
import { countStopsAhead, hasDegenerateStopList } from './next-stop'
import { selectCueForNavigation } from './turn-by-turn'
import type { RouteMatchResult } from './position-matching'
import type { StepCue } from './turn-by-turn'

export type TripStatus =
  | 'on_track'
  | 'ahead'
  | 'behind'
  | 'deviated'
  | 'completed'

export interface TripProgress {
  // 0-100%
  currentLegIndex: number
  currentLegProgress: number
  // Time used for calculations (simulated or real)
  currentTime: Date
  delay?: number
  // True when departure override is active (user selected a later bus)
  departureIsOverridden?: boolean
  // Epoch ms — arrival at current transit leg's destination
  destinationArrivalTime?: number
  // Metres from the rider's raw fix to the last leg's `to`. Null when either
  // end is unavailable. Feeds the arrival test, and is logged so the daemon
  // can see WHICH condition ended a trip.
  distanceToDestination?: number | null
  distanceToNextTurn?: number
  // Epoch ms — the departure the wait math actually ran on (override, else the
  // live prediction, else the plan). One number for the pacing card, the drift
  // check and waitTimeAtStop to quote, so they can never disagree.
  effectiveDepartureMs?: number
  // 0-100%
  estimatedArrival: Date
  // The turn after `nextTurnCue`, for a "then …" line
  followingTurnCue?: StepCue
  // seconds
  // Walking-specific
  nextInstruction?: string

  nextStopName?: string
  // Structured form of nextInstruction; absent when the leg has no usable steps
  nextTurnCue?: StepCue
  overallProgress: number
  // Epoch ms — the originally planned departure time from itinerary
  plannedDepartureTime?: number
  // The rider's own GPS ground speed in m/s, when the fix carries one. Lets
  // announcement leads scale with how fast the rider actually moves.
  riderSpeedMps?: number
  // seconds
  status: TripStatus

  // Transit-specific
  stopsRemaining?: number
  // What produced stopsRemaining. Only set by trust-assessed paths (the
  // vehicle-sourced producers land with the trust plumbing); absent means a
  // legacy trusted path.
  stopsSource?: 'gps' | 'vehicle' | 'vehicle-stop' | 'schedule'
  // False when the stop count is a guess (stale fix, degenerate stop list) —
  // consumers must not alert on it. Absent = not assessed, treated as
  // trusted so untouched legacy paths don't regress.
  stopsTrusted?: boolean
  timeRemaining: number
  // Seconds until next transit leg departs (walking legs only)
  timeUntilNextDeparture?: number
  // True while turn announcements are settling after a rejoin/projection jump
  // (see selectCueForNavigation) — the cue itself stays current and passive.
  turnAnnouncementsHeld?: boolean
  // True when distanceToNextTurn is a straight line from the rider's raw fix
  // to the turn rather than a distance along the route: the rider is off the
  // corridor, so there is no route under them to measure along.
  turnDistanceIsDirect?: boolean
  // Seconds of estimated wait at next stop (walking legs only)
  waitTimeAtStop?: number
}

/**
 * Calculate overall trip progress based on distance traveled
 */
export function calculateOverallProgress(
  currentLegIndex: number,
  progressInCurrentLeg: number,
  legs: Leg[]
): number {
  if (legs.length === 0) return 0

  // Calculate total distance
  const totalDistance = legs.reduce((sum, leg) => sum + (leg.distance || 0), 0)

  if (totalDistance === 0) return 0

  // Calculate distance completed
  let completedDistance = 0

  // Add completed legs
  for (let i = 0; i < currentLegIndex; i++) {
    completedDistance += legs[i].distance || 0
  }

  // Add progress in current leg
  if (currentLegIndex < legs.length) {
    const currentLeg = legs[currentLegIndex]
    completedDistance += (currentLeg.distance || 0) * progressInCurrentLeg
  }

  return (completedDistance / totalDistance) * 100
}

/**
 * Ground the rider still has to cover: what is left of the leg they are on,
 * plus every leg after it. Plan distances, which is the only distance an
 * itinerary carries — the point is the shape of the remainder, not a survey.
 */
export function remainingTripDistanceM(
  legs: Leg[] | undefined,
  currentLegIndex: number,
  progressInCurrentLeg: number
): number | null {
  if (!legs?.length) return null
  const clamped = Math.max(0, Math.min(1, progressInCurrentLeg))
  let remaining = 0
  for (let i = Math.max(0, currentLegIndex); i < legs.length; i++) {
    const d = legs[i].distance
    if (!Number.isFinite(d as number)) continue
    remaining +=
      i === currentLegIndex ? (d as number) * (1 - clamped) : (d as number)
  }
  return Number.isFinite(remaining) ? remaining : null
}

/**
 * Speeds to fall back on when the rider's own fix carries none, m/s. Ordinary
 * figures, not optimistic ones: a countdown that is a little long is a rider
 * who arrives early, and the alternative this replaces is a countdown of zero.
 */
const PACE_FALLBACK_MPS: Record<string, number> = {
  BICYCLE: 4.5,
  MICROMOBILITY: 4.5,
  MICROMOBILITY_RENT: 4.5,
  SCOOTER: 4.5,
  WALK: 1.35
}
const PACE_FALLBACK_TRANSIT_MPS = 8

/**
 * A rider's fix reports 0 m/s at every stop light. Below this the reported
 * speed is not a pace, so the mode's own figure stands in — otherwise the
 * first red light would divide by nothing and print an infinite countdown.
 */
const PACE_MIN_TRUSTED_MPS = 0.5

/** How the remaining time is measured when no future arrival time is left. */
export interface PaceContext {
  distanceRemainingM?: number | null
  /** Mode of the leg the rider is on, for the fallback speed. */
  mode?: string | null
  /** The rider's own ground speed from this fix, when it carries one. */
  speedMps?: number | null
}

function paceRemainingSeconds(pace?: PaceContext | null): number | null {
  if (!pace) return null
  const distance = pace.distanceRemainingM
  if (distance == null || !Number.isFinite(distance) || distance <= 0) {
    return null
  }
  const reported = pace.speedMps
  const speed =
    reported != null &&
    Number.isFinite(reported) &&
    reported >= PACE_MIN_TRUSTED_MPS
      ? reported
      : PACE_FALLBACK_MPS[pace.mode || ''] ?? PACE_FALLBACK_TRANSIT_MPS
  const seconds = distance / speed
  return Number.isFinite(seconds) ? seconds : null
}

/**
 * Calculate time remaining based on current progress and scheduled times
 */
export function calculateTimeRemaining(
  currentTime: Date,
  itinerary: Itinerary,
  currentLegIndex: number,
  progressInCurrentLeg: number,
  liveTripEndMs?: number | null,
  /**
   * How to answer once the anchor has gone. Optional: without it the old
   * `Math.max(0, ...)` clamp stands, byte for byte.
   */
  pace?: PaceContext | null
): number {
  // A countdown against the clock, not plan-span arithmetic.
  //
  // This used to return (itinerary span) - (plan moving time consumed). Three
  // things were wrong with that at once: the span is wall-clock so it carried
  // every WAIT in the itinerary including wait the rider had already served;
  // `currentTime` was accepted and never used, so the number only moved when
  // GPS moved rather than ticking down; and Math.max(0, ...) clamped only the
  // bottom, so an onward plan whose connection landed on the next service day
  // propagated upward in silence. It printed 2048 min — 34 hours — for a ride
  // that ended in fifteen minutes, and nothing asserted on it.
  //
  // Anchored on the live end of the trip it cannot do that: the answer is
  // bounded by a real arrival time that the feed keeps current.
  const end =
    liveTripEndMs ??
    legEndFallback(itinerary, currentLegIndex, progressInCurrentLeg)
  const remaining = (end - currentTime.getTime()) / 1000
  if (remaining > 0) return remaining

  // The anchor is in the past, so it has stopped being an answer. Clamping to
  // zero is not the honest one: on 2026-09-01 the rider's closing bike leg was
  // measured against a plan end that had already passed, and `timeRemaining`
  // read 0 with `estimatedArrival = now` on all 487 ticks from 1068 m out,
  // while `delay` climbed to 634 s. What is left is a distance and a speed, so
  // the countdown becomes the one thing still true: how long the ground ahead
  // takes at the pace the rider is keeping. This is also the number the bike
  // buffer (6.10a) has to be built on.
  return paceRemainingSeconds(pace) ?? 0
}

/**
 * Plan-time end of the trip, for when no live arrival is known yet.
 *
 * Deliberately the itinerary's own endTime rather than the old span
 * subtraction: it is a real moment, so the countdown above stays a countdown.
 */
function legEndFallback(
  itinerary: Itinerary,
  currentLegIndex: number,
  progressInCurrentLeg: number
): number {
  // `new Date`, not `Number`. Itinerary times are `number | string` in
  // @opentripplanner/types and the fixtures use ISO strings; Number('2026-...')
  // is NaN, which silently fell through to the leg-sum branch and returned a
  // countdown measured from the wrong century.
  const end = new Date(itinerary.endTime as string | number).getTime()
  if (Number.isFinite(end)) return end
  // No usable container end: rebuild one from the legs still ahead.
  const legs = itinerary.legs || []
  let remaining = 0
  if (currentLegIndex < legs.length) {
    remaining +=
      (legs[currentLegIndex].duration || 0) * (1 - progressInCurrentLeg)
  }
  for (let i = currentLegIndex + 1; i < legs.length; i++) {
    remaining += legs[i].duration || 0
  }
  return Date.now() + remaining * 1000
}

/**
 * Estimate arrival time based on current progress
 */
export function estimateArrival(
  currentTime: Date,
  timeRemaining: number
): Date {
  return new Date(currentTime.getTime() + timeRemaining * 1000)
}

/**
 * How close to the destination counts as arrived, and how far along the trip
 * the rider must already be for that distance to mean anything.
 *
 * The progress floor is the safety catch, not a formality. setArrived is a
 * ONE-WAY latch: once it fires the trip quiesces and the rider gets an arrival
 * card instead of navigation. A destination that happens to sit near the route
 * — a loop, an out-and-back, a geocoded point a block from a street the rider
 * rides down early on — would otherwise end the trip in the first mile. Losing
 * navigation mid-trip is a worse failure than the one this fixes, so distance
 * alone is never enough.
 */
export const ARRIVAL_RADIUS_M = 75
export const ARRIVAL_MIN_PROGRESS = 90

/**
 * The measured distance that vetoes arrival outright, however complete the
 * progress scalar claims to be.
 *
 * 2026-09-01 ride 3, 11:10:06: the projection snapped `progressAlongLeg`
 * 0.000 -> 1.000 in one 1 s tick (segmentIndex 0 -> 40 on a 41-segment,
 * 1587 m bike polyline, on a 4.3 m fix delta), `overallProgress` went to 100,
 * and the 99.5 branch below fired on it alone. `SET_ARRIVED`, the
 * TRIP_COMPLETE push and the drop to the 30 s arrived tracking interval all
 * went out while `distanceToDestination` was 159 m and `distanceFromRoute`
 * 132 m with `isOnRoute: false`. The rider first came within 32 m of home
 * three and a half minutes later, by which time the trip was recorded at an
 * eighth of the fix rate.
 *
 * A projected scalar is a claim; the metres between the rider's own fix and
 * the last leg's `to` are a measurement, and a measurement outranks a claim.
 * So when that distance is known, it can veto — never grant — arrival.
 *
 * Deliberately LARGER than ARRIVAL_RADIUS_M rather than the ~40 m the finding
 * proposed. Below 75 m this constant would swallow the distance branch above
 * and become the only arrival rule; above it, all it removes is the
 * progress-only override, and only out where no plausible destination
 * geocode or GPS error puts a rider who has actually arrived. The failure it
 * guards against is one-way (setArrived is a latch and the rider loses
 * navigation), but so is the opposite failure — a trip that can never
 * complete tracks forever — so the veto is set where it cannot be wrong.
 *
 * Checked against every arrival in the recorded telemetry: 2026-08-31 16:22:05
 * (70 m), 18:52:55 (41 m) and 2026-09-01 08:59:37 (81 m) all still latch;
 * 2026-09-01 11:10:06 (159 m) no longer does.
 */
export const ARRIVAL_MAX_DISTANCE_M = 120

/**
 * Has the rider reached the destination?
 *
 * Progress alone was the whole test until 2026-08-27, when a rider's final bike
 * leg froze at 99.28% on arrival — under the 99.5 bar — so the trip never
 * completed. It then tracked them for four and a half hours, including their
 * drive home, because every rule downstream kept evaluating a trip that was
 * over. A frozen scalar cannot be the only way to notice arrival, so being
 * physically at the destination counts too.
 */
export function hasArrivedAtDestination(
  actualProgress: number,
  distanceToDestination: number | null | undefined
): boolean {
  // The measurement first, and as a veto: a rider this far from where they
  // asked to go has not arrived, whatever the projection says about them.
  // Only a distance we actually have can veto — a missing one leaves the
  // progress rules below exactly as they were.
  if (
    distanceToDestination != null &&
    Number.isFinite(distanceToDestination) &&
    distanceToDestination > ARRIVAL_MAX_DISTANCE_M
  ) {
    return false
  }
  if (actualProgress >= 99.5) return true
  return (
    distanceToDestination != null &&
    Number.isFinite(distanceToDestination) &&
    distanceToDestination <= ARRIVAL_RADIUS_M &&
    actualProgress >= ARRIVAL_MIN_PROGRESS
  )
}

/**
 * Metres from the rider to the trip's final destination, or null when either
 * end of that measurement is missing. The destination is the last leg's `to` —
 * the place the rider actually asked to reach, not the end of whatever leg the
 * matcher currently favours.
 */
export function distanceToFinalStop(
  legs: Leg[] | undefined,
  riderPosition: LatLngArray | null | undefined
): number | null {
  if (!legs?.length || !riderPosition) return null
  const to = legs[legs.length - 1]?.to as
    | { lat?: number; lon?: number }
    | undefined
  if (to?.lat == null || to?.lon == null) return null
  const d = calculateDistance(
    riderPosition[0],
    riderPosition[1],
    to.lat,
    to.lon
  )
  return Number.isFinite(d) ? d : null
}

/**
 * Determine trip status based on position and timing
 */
export function determineTripStatus(
  routeMatch: RouteMatchResult | null,
  expectedProgress: number,
  actualProgress: number,
  distanceToDestination?: number | null
): TripStatus {
  // Arrival is tested FIRST, ahead of the deviation checks. It used to run
  // last, which meant a rider standing at their destination could never be
  // "completed" if the match happened to read off-route — and at a destination
  // it usually does, because the rider has stopped riding the line and GPS
  // jitter around a parked phone easily clears the 100m bike threshold. On
  // 2026-08-27 that flapped completed/deviated ten times and then latched
  // deviated for four and a half hours.
  if (hasArrivedAtDestination(actualProgress, distanceToDestination)) {
    return 'completed'
  }

  if (!routeMatch) {
    return 'deviated'
  }

  if (!routeMatch.isOnRoute) {
    return 'deviated'
  }

  const progressDifference = actualProgress - expectedProgress

  if (Math.abs(progressDifference) < 5) {
    return 'on_track'
  }

  return progressDifference > 0 ? 'ahead' : 'behind'
}

/**
 * Calculate expected progress based on time elapsed
 */
export function calculateExpectedProgress(
  startTime: Date,
  currentTime: Date,
  totalDuration: number
): number {
  const elapsed = (currentTime.getTime() - startTime.getTime()) / 1000
  const progress = (elapsed / totalDuration) * 100
  return Math.max(0, Math.min(100, progress))
}

const STOP_COUNT_MODES = new Set(['BUS', 'RAIL', 'TRAM', 'SUBWAY'])

/**
 * Trust-assessed inputs for stop counting on the leg the rider is aboard,
 * built per tick in handlePositionUpdate. All nullable and entirely optional:
 * callers without them (legacy paths, demo harness) get today's behavior
 * with no trust fields set.
 */
export interface TransitTrustContext {
  /** The rider's own fix is sound (fresh, accurate, on THIS leg's route) —
   * see assessRiderGpsTrust. */
  riderTrusted: boolean
  /** The bus's own feed position projected onto the leg (0-1), when fresh and
   * on the leg's geometry. */
  vehicleProgress: number | null
  /** Feed nextStopId resolved against the leg's stop list — exact identity,
   * no geometry. */
  vehicleStops: { nextStopName: string; stopsRemaining: number } | null
}

/**
 * Get transit-specific progress information. Without a trust context this is
 * the legacy rider-GPS count, unchanged. With one, sources are tried in trust
 * order — sound rider GPS, then the bus's own position, then the feed's
 * next-stop fact — and the result says what produced it; only the final
 * even-spacing guess is marked untrusted. On 7/29 a stale rider fix kept
 * counting stops off the wrong position; the bus knew better all along.
 */
export function getTransitProgress(
  leg: Leg,
  progressInLeg: number,
  transitCtx?: TransitTrustContext
): {
  nextStopName?: string
  stopsRemaining?: number
  stopsSource?: 'gps' | 'vehicle' | 'vehicle-stop' | 'schedule'
  stopsTrusted?: boolean
} {
  if (!STOP_COUNT_MODES.has(leg.mode as string)) {
    return {}
  }

  if (transitCtx) {
    // A leg that claims intermediate stops but whose usable list collapsed to
    // just the alight stop can only ever say "1 stop remaining" — geometric
    // counts from it are never trusted (see hasDegenerateStopList).
    const degenerate = hasDegenerateStopList(leg)
    if (transitCtx.riderTrusted) {
      const counted = countStopsAhead(leg, progressInLeg)
      if (counted) {
        return { ...counted, stopsSource: 'gps', stopsTrusted: !degenerate }
      }
    }
    if (transitCtx.vehicleProgress != null) {
      const counted = countStopsAhead(leg, transitCtx.vehicleProgress)
      if (counted) {
        return { ...counted, stopsSource: 'vehicle', stopsTrusted: !degenerate }
      }
    }
    if (transitCtx.vehicleStops != null) {
      return {
        ...transitCtx.vehicleStops,
        stopsSource: 'vehicle-stop',
        // Consult `degenerate` like the gps and vehicle branches above. The
        // spec 'a degenerate stop list is never trusted, whatever the source'
        // already asserted this; it was passing only because it never
        // exercised this branch.
        stopsTrusted: !degenerate
      }
    }
    // Every trusted source came up empty: the even-spacing estimate below is
    // a schedule guess — shown nowhere that alerts, per stopsTrusted.
    return {
      ...legacyStopEstimate(leg, progressInLeg),
      stopsSource: 'schedule',
      stopsTrusted: false
    }
  }

  return legacyStopEstimate(leg, progressInLeg)
}

/**
 * The pre-trust stop count: geometry-measured positions when available, an
 * even-spacing estimate over the raw stop list otherwise. Kept verbatim so
 * ctx-less callers behave byte-identically.
 */
function legacyStopEstimate(
  leg: Leg,
  progressInLeg: number
): {
  nextStopName?: string
  stopsRemaining?: number
} {
  // Count from each stop's measured position on the leg geometry — stops sit
  // unevenly along a leg, so a progress-fraction estimate miscounts badly
  // (see countStopsAhead).
  const counted = countStopsAhead(leg, progressInLeg)
  if (counted) return counted

  // No usable geometry or stop coordinates: even-spacing estimate over the
  // raw stop list is the best guess left.
  const stops = leg.intermediateStops
  if (!stops) return {}
  const totalStops = stops.length + 1 // +1 for destination stop
  const stopIndex = Math.floor(progressInLeg * totalStops)

  if (stopIndex < stops.length) {
    return {
      nextStopName: stops[stopIndex].name,
      stopsRemaining: totalStops - stopIndex
    }
  }

  // At or past last intermediate stop, next stop is destination
  return {
    nextStopName: leg.to.name,
    stopsRemaining: 1
  }
}

/**
 * Get walking-specific navigation information.
 *
 * `isOnRoute` defaults to true so legacy callers keep today's behavior; pass
 * the real route-match verdict to get honest guidance. Off the route the
 * nearest-point projection is a fiction (on 7/29 it swept past three turns
 * while the rider rode a parallel street), so the along-route figures are
 * never quoted and the "Continue to X" filler is suppressed — that stale line
 * is exactly what the rider shouldn't see while off the plan.
 *
 * The TURN itself is not suppressed, though, when `riderPosition` is supplied:
 * `selectCueForNavigation` holds the turn the rider is nearest to and measures
 * it as a straight line from their own fix, flagged `turnDistanceIsDirect` so
 * consumers can say so. Going blank instead is what lost the 2026-09-01
 * `LEFT East 32nd Street` cue for the whole 16 s excursion in which the rider
 * rode up to that very turn. The deviation toast and the quiet replan still
 * own the "you are off the plan" message.
 */
export function getWalkingInstruction(
  leg: Leg,
  progressInLeg: number,
  isOnRoute = true,
  riderPosition?: LatLngArray | null
): {
  distanceToNextTurn?: number
  followingTurnCue?: StepCue
  nextInstruction?: string
  nextTurnCue?: StepCue
  turnAnnouncementsHeld?: boolean
  turnDistanceIsDirect?: boolean
} {
  if (leg.mode !== 'WALK' && leg.mode !== 'BICYCLE') {
    return {}
  }

  // Real turn-by-turn when the leg carries usable steps. Always consulted so
  // the per-leg cursor sees every tick, including off-route ones.
  const {
    announceHold,
    cue,
    distanceToNextTurn,
    following,
    turnDistanceIsDirect
  } = selectCueForNavigation(leg, progressInLeg, isOnRoute, riderPosition)

  if (cue) {
    return {
      distanceToNextTurn,
      followingTurnCue: following,
      nextInstruction: cue.instruction,
      nextTurnCue: cue,
      turnAnnouncementsHeld: announceHold,
      turnDistanceIsDirect
    }
  }

  // Off the corridor with no held turn (no steps, no position, or every turn
  // behind the rider): the along-route remainder below would be measured on a
  // projection the rider isn't on, so say nothing.
  if (!isOnRoute) {
    return {}
  }

  // No steps (OTP omits them for some legs), or every turn is behind the rider
  // and only the final straight to the destination is left.
  const remainingDistance = (leg.distance || 0) * (1 - progressInLeg)

  if (progressInLeg < 0.9) {
    return {
      distanceToNextTurn: remainingDistance,
      nextInstruction: `Continue to ${leg.to.name}`
    }
  }

  return {
    distanceToNextTurn: remainingDistance,
    nextInstruction: `Arriving at ${leg.to.name}`
  }
}

/**
 * Get timing info for upcoming transit connections.
 * On walking legs approaching transit: departure countdown + wait time.
 * On transit legs: destination arrival time.
 *
 * `liveBoardMs` is the boarding leg's live GTFS-realtime prediction (from
 * refreshLiveLegTimes), and it is what makes the wait honest: the plan's board
 * time never moves, so without it a bus running six minutes late still reads as
 * on time all the way to the stop, and the pacing card keeps saying hurry.
 *
 * A rider-selected departure still outranks it. `liveLegTimes` tracks the
 * PLANNED leg's trip id, so once the rider picks a different bus that live
 * epoch describes a vehicle they are not taking.
 */
export function getUpcomingTransitTiming(
  currentTime: Date,
  currentLeg: Leg,
  nextLeg: Leg | undefined,
  progressInLeg: number,
  departureOverrideMs?: number | null,
  liveBoardMs?: number | null,
  liveAlightMs?: number | null
): {
  departureIsOverridden?: boolean
  destinationArrivalTime?: number
  effectiveDepartureMs?: number
  plannedDepartureTime?: number
  timeUntilNextDeparture?: number
  waitTimeAtStop?: number
} {
  const mode = currentLeg.mode
  const isWalkOrBike = mode === 'WALK' || mode === 'BICYCLE'
  const isTransit =
    mode === 'BUS' || mode === 'RAIL' || mode === 'SUBWAY' || mode === 'TRAM'

  if (
    isWalkOrBike &&
    nextLeg &&
    (nextLeg.mode === 'BUS' ||
      nextLeg.mode === 'RAIL' ||
      nextLeg.mode === 'SUBWAY' ||
      nextLeg.mode === 'TRAM')
  ) {
    // Leg times are `number | string` in @opentripplanner/types; coerce at the
    // boundary the way the rest of Go Mode does (Number(leg.startTime)) so the
    // arithmetic below and the returned epochs are honestly typed.
    const plannedDepartureTime = Number(nextLeg.startTime)
    const effectiveDeparture = Number(
      departureOverrideMs || liveBoardMs || nextLeg.startTime
    )
    const remainingWalkSeconds =
      (currentLeg.duration || 0) * (1 - progressInLeg)
    const timeUntilNextDeparture =
      (effectiveDeparture - currentTime.getTime()) / 1000
    const waitTimeAtStop = timeUntilNextDeparture - remainingWalkSeconds

    return {
      // Strictly the rider's own pick — a live prediction is the same bus at a
      // new time, not a different departure, and flagging it here would put a
      // "reset" affordance (WalkingNavigation) on a choice nobody made.
      departureIsOverridden: !!departureOverrideMs,
      effectiveDepartureMs: effectiveDeparture,
      plannedDepartureTime,
      timeUntilNextDeparture,
      waitTimeAtStop
    }
  }

  if (isTransit) {
    // The live arrival, not the plan's. currentLeg.endTime is the build-time
    // anchor, frozen when the trip was planned — and this value feeds
    // alightBannerLevel below, so a bus running four minutes late was firing
    // GET READY four minutes early. liveAlightMs comes from legAlight, which
    // already resolves live -> projected -> plan in one place.
    return { destinationArrivalTime: liveAlightMs ?? currentLeg.endTime }
  }

  return {}
}

/**
 * Measure how far behind (or ahead of) schedule the rider is at their current
 * position on the given leg, in seconds. Positive = running late.
 *
 * Uses only real data: the rider's GPS-derived progress along the leg
 * (progressInLeg) mapped against the leg's scheduled start/end timestamps.
 * Returns undefined when the leg has no scheduled times to compare against.
 */
export function computeCurrentDelay(
  leg: Leg | undefined,
  progressInLeg: number,
  currentTime: Date
): number | undefined {
  if (!leg) return undefined

  // Leg.startTime is typed number | string in @opentripplanner/types; coerce.
  const start = Number(leg.startTime)
  const end = Number(leg.endTime)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return undefined
  }

  // A leg that has not started yet has no delay to measure. Position along it
  // is spatial — GPS can put the rider partway down a leg's polyline while its
  // scheduled window is still entirely in the future, which happens whenever a
  // re-plan briefly makes an itinerary active whose departure is hours out.
  // Subtracting a future scheduled time from now would then report the whole
  // pre-departure wait as if the rider were that far AHEAD of schedule: on
  // 2026-08-27 a rider 14.85% along a leg departing in 7,037s got a delay of
  // -7000.6s and an arrival two hours late (4:57 PM against a true ~3:00 PM),
  // with status still "on_track" so nothing flagged it.
  //
  // The wait itself is not lost — getUpcomingTransitTiming already reports it
  // as waitTimeAtStop, which is the same gap named correctly.
  if (currentTime.getTime() < start) return undefined

  const clamped = Math.max(0, Math.min(1, progressInLeg))
  const scheduledMsAtPosition = start + clamped * (end - start)

  return (currentTime.getTime() - scheduledMsAtPosition) / 1000
}

/**
 * Calculate comprehensive trip progress
 */
export function calculateTripProgress(
  currentTime: Date,
  itinerary: Itinerary,
  routeMatch: RouteMatchResult | null,
  departureOverrideMs?: number | null,
  transitCtx?: TransitTrustContext,
  riderSpeedMps?: number | null,
  liveBoardMs?: number | null,
  liveAlightMs?: number | null,
  riderPosition?: LatLngArray | null
): TripProgress {
  const legs = itinerary.legs
  const currentLegIndex = routeMatch?.legIndex || 0
  const progressInCurrentLeg = routeMatch?.progressAlongLeg || 0

  // The rider's RAW fix, deliberately not routeMatch.nearestPoint: that is the
  // projection onto the route, which is exactly wrong here. A rider who has
  // walked away from the line to their door would measure as still on it, and
  // a rider who never arrives would measure as arrived.
  const distanceToDestination = distanceToFinalStop(legs, riderPosition)

  const overallProgress = calculateOverallProgress(
    currentLegIndex,
    progressInCurrentLeg,
    legs
  )

  // The live end of the trip: the live/projected alight of the current transit
  // leg plus whatever legs follow it. Anything downstream of a live figure is
  // still plan-time, which is the honest best guess for legs not yet started.
  const liveTripEndMs =
    liveAlightMs != null
      ? legs
          .slice(currentLegIndex + 1)
          .reduce((acc, l) => acc + (l.duration || 0) * 1000, liveAlightMs)
      : null

  const timeRemaining = calculateTimeRemaining(
    currentTime,
    itinerary,
    currentLegIndex,
    progressInCurrentLeg,
    liveTripEndMs,
    {
      distanceRemainingM: remainingTripDistanceM(
        legs,
        currentLegIndex,
        progressInCurrentLeg
      ),
      mode: legs[currentLegIndex]?.mode,
      speedMps: riderSpeedMps
    }
  )

  const estimatedArrival = estimateArrival(currentTime, timeRemaining)

  const startTime = new Date(itinerary.startTime)
  const endTime = new Date(itinerary.endTime)
  const totalDuration = (endTime.getTime() - startTime.getTime()) / 1000

  const expectedProgress = calculateExpectedProgress(
    startTime,
    currentTime,
    totalDuration
  )

  const status = determineTripStatus(
    routeMatch,
    expectedProgress,
    overallProgress,
    distanceToDestination
  )

  const currentLeg = legs[currentLegIndex]
  const currentLegProgress = progressInCurrentLeg * 100

  // Get mode-specific progress info
  const transitInfo = getTransitProgress(
    currentLeg,
    progressInCurrentLeg,
    transitCtx
  )
  // Route honesty: a null match already reads as 'deviated' above, and the
  // same suppression applies — no turn guidance from a projection the rider
  // isn't actually on.
  const walkingInfo = getWalkingInstruction(
    currentLeg,
    progressInCurrentLeg,
    routeMatch?.isOnRoute ?? false,
    riderPosition
  )

  // Get upcoming transit timing
  const nextLeg =
    currentLegIndex < legs.length - 1 ? legs[currentLegIndex + 1] : undefined
  const timingInfo = getUpcomingTransitTiming(
    currentTime,
    currentLeg,
    nextLeg,
    progressInCurrentLeg,
    departureOverrideMs,
    liveBoardMs,
    liveAlightMs
  )

  // Measured schedule delay at the rider's current position (real GPS progress
  // vs the current leg's scheduled timing). Feeds connection-risk detection.
  const delay = computeCurrentDelay(
    currentLeg,
    progressInCurrentLeg,
    currentTime
  )

  return {
    currentLegIndex,
    currentLegProgress,
    currentTime,
    delay,
    distanceToDestination,
    estimatedArrival,
    overallProgress,
    riderSpeedMps: riderSpeedMps ?? undefined,
    status,
    timeRemaining,
    ...transitInfo,
    ...walkingInfo,
    ...timingInfo
  }
}

/**
 * Check if should alert for approaching stop
 */
export function shouldAlertForApproachingStop(
  leg: Leg,
  stopsRemaining?: number
): boolean {
  if (!stopsRemaining) return false

  // Alert when 2 stops away from destination
  return stopsRemaining === 2
}

/** Same window the alight NOTIFICATION uses for its 'prepare' stage. */
const ALIGHT_BANNER_URGENT_SECONDS = 120

/**
 * Should the GET READY banner be up, and how loudly?
 *
 * The count alone is not enough. On 8/2 stopsRemaining was 1 from the first
 * tick to the last — both legs of the split ride were single-hop, so the count
 * was arithmetically honest and hasDegenerateStopList was false, which is why
 * the trust gate never saved the banner. It showed "GET READY! Next stop is
 * yours!" for a 30-minute ride.
 *
 * So don't depend on the count MOVING. checkAlightAlerts solved the identical
 * problem for notifications by abandoning the level test for time ("
 * stopsRemaining sits at 1 for the whole final inter-stop segment"); this
 * follows it. Today's gates are kept verbatim, then an ETA is required.
 *
 * Pure and React-free so it is unit testable. When no ETA is available at all,
 * falls through to today's behavior rather than going silent.
 */
export function alightBannerLevel(
  progress: {
    destinationArrivalTime?: number | null
    status?: string
    stopsRemaining?: number
    stopsTrusted?: boolean
  },
  nowMs: number
): 'urgent' | 'warning' | null {
  const stops = progress.stopsRemaining
  if (stops !== 1 && stops !== 2) return null
  if (progress.stopsTrusted === false) return null
  if (progress.status === 'deviated') return null

  const eta = progress.destinationArrivalTime
  // No ETA to judge by — today's behavior, which is the gentle part.
  if (eta == null) return stops === 1 ? 'urgent' : 'warning'

  // Can't be negative-by-inversion: the leg-time clamps guarantee endTime
  // never precedes startTime.
  const etaSeconds = (Number(eta) - nowMs) / 1000
  if (!Number.isFinite(etaSeconds)) return stops === 1 ? 'urgent' : 'warning'

  if (stops === 1) {
    return etaSeconds <= ALIGHT_BANNER_URGENT_SECONDS ? 'urgent' : null
  }
  return etaSeconds <= ALIGHT_BANNER_URGENT_SECONDS * 2 ? 'warning' : null
}

/**
 * Check if should alert for boarding
 */
export function shouldAlertForBoarding(
  leg: Leg,
  previousLeg: Leg | null,
  progressInPreviousLeg: number
): boolean {
  if (!previousLeg) return false

  // Alert when approaching end of previous leg and next leg is transit
  if (
    progressInPreviousLeg > 0.9 &&
    (leg.mode === 'BUS' || leg.mode === 'RAIL')
  ) {
    return true
  }

  return false
}
