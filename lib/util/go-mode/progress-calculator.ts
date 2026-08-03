import type { IntlShape } from 'react-intl'
import type { Itinerary, Leg } from '@opentripplanner/types'

import { countStopsAhead, hasDegenerateStopList } from './next-stop'
import { getNextCueWithIntl, selectCueForNavigation } from './turn-by-turn'
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
  distanceToNextTurn?: number
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
 * Calculate time remaining based on current progress and scheduled times
 */
export function calculateTimeRemaining(
  currentTime: Date,
  itinerary: Itinerary,
  currentLegIndex: number,
  progressInCurrentLeg: number
): number {
  const endTime = new Date(itinerary.endTime)
  const startTime = new Date(itinerary.startTime)
  const totalDuration = (endTime.getTime() - startTime.getTime()) / 1000 // seconds

  // Calculate expected time elapsed based on leg progress
  const legs = itinerary.legs
  let expectedElapsed = 0

  for (let i = 0; i < currentLegIndex; i++) {
    expectedElapsed += legs[i].duration || 0
  }

  if (currentLegIndex < legs.length) {
    const currentLeg = legs[currentLegIndex]
    expectedElapsed += (currentLeg.duration || 0) * progressInCurrentLeg
  }

  // Simple calculation: remaining = total - expected elapsed
  const remaining = totalDuration - expectedElapsed

  return Math.max(0, remaining)
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
 * Determine trip status based on position and timing
 */
export function determineTripStatus(
  routeMatch: RouteMatchResult | null,
  expectedProgress: number,
  actualProgress: number
): TripStatus {
  if (!routeMatch) {
    return 'deviated'
  }

  if (!routeMatch.isOnRoute) {
    return 'deviated'
  }

  if (actualProgress >= 99.5) {
    return 'completed'
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
        stopsTrusted: true
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
 * while the rider rode a parallel street), so no turn fields come back at all
 * — not even the "Continue to X" filler, which is exactly the stale line the
 * rider shouldn't see while off the plan. The deviation toast and the quiet
 * replan own that state.
 */
export function getWalkingInstruction(
  leg: Leg,
  progressInLeg: number,
  isOnRoute = true
): {
  distanceToNextTurn?: number
  followingTurnCue?: StepCue
  nextInstruction?: string
  nextTurnCue?: StepCue
  turnAnnouncementsHeld?: boolean
} {
  if (leg.mode !== 'WALK' && leg.mode !== 'BICYCLE') {
    return {}
  }

  // Real turn-by-turn when the leg carries usable steps. Always consulted so
  // the per-leg cursor sees every tick, including off-route ones.
  const { announceHold, cue, distanceToNextTurn, following } =
    selectCueForNavigation(leg, progressInLeg, isOnRoute)

  if (!isOnRoute) {
    return {}
  }

  if (cue) {
    return {
      distanceToNextTurn,
      followingTurnCue: following,
      nextInstruction: cue.instruction,
      nextTurnCue: cue,
      turnAnnouncementsHeld: announceHold
    }
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
 * Get walking-specific navigation information with i18n support for localized turn-by-turn instructions.
 */
export function getWalkingInstructionWithIntl(
  leg: Leg,
  progressInLeg: number,
  intl: IntlShape
): {
  distanceToNextTurn?: number
  followingTurnCue?: StepCue
  nextInstruction?: string
  nextTurnCue?: StepCue
} {
  if (leg.mode !== 'WALK' && leg.mode !== 'BICYCLE') {
    return {}
  }

  // Real turn-by-turn when the leg carries usable steps.
  const { cue, distanceToNextTurn, following } = getNextCueWithIntl(
    leg,
    progressInLeg,
    intl
  )
  if (cue) {
    return {
      distanceToNextTurn,
      followingTurnCue: following,
      nextInstruction: cue.instruction,
      nextTurnCue: cue
    }
  }

  // No steps (OTP omits them for some legs), or every turn is behind the rider
  // and only the final straight to the destination is left.
  const remainingDistance = (leg.distance || 0) * (1 - progressInLeg)

  if (progressInLeg < 0.9) {
    return {
      distanceToNextTurn: remainingDistance,
      nextInstruction: intl.formatMessage(
        { id: 'components.GoMode.turnInstructions.continueTo' },
        { destination: leg.to.name }
      )
    }
  }

  return {
    distanceToNextTurn: remainingDistance,
    nextInstruction: intl.formatMessage(
      { id: 'components.GoMode.turnInstructions.arrivingAt' },
      { destination: leg.to.name }
    )
  }
}

/**
 * Get timing info for upcoming transit connections.
 * On walking legs approaching transit: departure countdown + wait time.
 * On transit legs: destination arrival time.
 */
export function getUpcomingTransitTiming(
  currentTime: Date,
  currentLeg: Leg,
  nextLeg: Leg | undefined,
  progressInLeg: number,
  departureOverrideMs?: number | null
): {
  departureIsOverridden?: boolean
  destinationArrivalTime?: number
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
    const plannedDepartureTime = nextLeg.startTime
    const effectiveDeparture = departureOverrideMs || nextLeg.startTime
    const remainingWalkSeconds =
      (currentLeg.duration || 0) * (1 - progressInLeg)
    const timeUntilNextDeparture =
      (effectiveDeparture - currentTime.getTime()) / 1000
    const waitTimeAtStop = timeUntilNextDeparture - remainingWalkSeconds

    return {
      departureIsOverridden: !!departureOverrideMs,
      plannedDepartureTime,
      timeUntilNextDeparture,
      waitTimeAtStop
    }
  }

  if (isTransit) {
    return { destinationArrivalTime: currentLeg.endTime }
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
  riderSpeedMps?: number | null
): TripProgress {
  const legs = itinerary.legs
  const currentLegIndex = routeMatch?.legIndex || 0
  const progressInCurrentLeg = routeMatch?.progressAlongLeg || 0

  const overallProgress = calculateOverallProgress(
    currentLegIndex,
    progressInCurrentLeg,
    legs
  )

  const timeRemaining = calculateTimeRemaining(
    currentTime,
    itinerary,
    currentLegIndex,
    progressInCurrentLeg
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
    overallProgress
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
    routeMatch?.isOnRoute ?? false
  )

  // Get upcoming transit timing
  const nextLeg =
    currentLegIndex < legs.length - 1 ? legs[currentLegIndex + 1] : undefined
  const timingInfo = getUpcomingTransitTiming(
    currentTime,
    currentLeg,
    nextLeg,
    progressInCurrentLeg,
    departureOverrideMs
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
