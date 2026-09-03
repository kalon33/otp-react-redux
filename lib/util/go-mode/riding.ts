import type { Leg } from '@opentripplanner/types'

import { shouldRebindRidingTrip } from './transit-trust'
import type { RidingState } from './types'
import type { RouteMatchResult } from './position-matching'
import type { VehicleMatchResult } from './vehicle-matching'

/**
 * Deciding the sticky "riding" fact, as a pure function.
 *
 * This logic used to live inline in handlePositionUpdate, the one part of Go
 * Mode with no test coverage at all — which is where every riding bug of
 * 2026-08-27 lived. Extracting it follows the same shape the rest of this
 * module already uses (a pure evaluator, with the caller owning dispatch).
 */

/** How much progress along a transit leg counts as being aboard it. */
export const RIDING_MIN_PROGRESS = 0.05

/**
 * GPS alone may only ESTABLISH riding within this distance of the leg's shape.
 *
 * The matcher's transit corridor is 250m because sparse polylines demand it —
 * but that is a statement about the match being usable, not about the rider
 * being on a bus. On 2026-08-27 a rider biking a street 248m from a parallel
 * bus route crossed RIDING_MIN_PROGRESS and was declared aboard, which armed a
 * boarded-earlier auto-replan that threw away the bike leg they were actually
 * on. A trusted vehicle match is exempt: it is direct evidence, and it is what
 * keeps the boarded-earlier rescue working. Retention is also exempt — a rider
 * already established keeps the wide corridor, so an urban canyon does not
 * shed the fact (only the sustained off-route timer does).
 */
export const RIDING_ESTABLISH_MAX_DISTANCE_M = 100

/**
 * Rider ground speed that corroborates "I am on a moving vehicle" when nothing
 * else does. Deliberately above a brisk walk and below traffic speed: the point
 * is only to separate a rider standing at a kerb from one being carried.
 */
export const RIDING_ESTABLISH_MIN_SPEED_MPS = 3

/**
 * How close to a transit leg's BOARDING STOP counts as waiting at it.
 *
 * Generous on purpose: a BRT station platform, its two entrances and the kerb
 * a local stops at are all "at the stop", and the fix taken under a shelter is
 * not a good one.
 */
export const BOARD_STOP_DWELL_RADIUS_M = 120

/**
 * How long the rider must have been at the boarding stop before GPS alone may
 * assert they are aboard. The rider's own spec, in his words: "only board
 * after rider is at bus station for x minutes, then begins moving".
 *
 * This is the gate that was missing on 2026-09-01. At 10:47:15 the rider was
 * cycling at 8.0 m/s, 4.3 km from the leg's boarding stop, with no vehicle
 * anywhere in the feed — and the ONLY thing that changed on the tick that
 * declared them aboard was distanceFromRoute crossing
 * RIDING_ESTABLISH_MAX_DISTANCE_M as the bike path converged on the Orange
 * Line's geometry (108.1 m at 10:47:14, 100.0 m at 10:47:15). Proximity to a
 * bus route plus motion is what a cyclist riding beside one looks like.
 *
 * A minute rather than "x minutes": the rider prefers gentle figures, and a
 * minute is already longer than every false board on record survived.
 */
export const BOARD_STOP_DWELL_MIN_MS = 60_000

/**
 * The most one tick may add to the dwell. A backgrounded app delivers fixes
 * minutes apart; those gaps are not proof the rider stood at the kerb.
 */
export const BOARD_STOP_DWELL_MAX_STEP_MS = 10_000

/**
 * A fix this uncertain places the rider nowhere in particular, so it may not
 * ESTABLISH aboard-ness however close its projection lands. On 2026-08-31 at
 * 17:15:01 a fix reporting 1254.7 m of accuracy and no speed at all projected
 * 20.3 m from the shape at progressAlongLeg 0.0514 — a hair over
 * RIDING_MIN_PROGRESS — and boarded the rider 6m22s early (backlog 4.4).
 *
 * Same figure and meaning as transit-trust's FIX_ACCURACY_MAX_M; kept local
 * because transit-trust imports this module.
 */
export const RIDING_ESTABLISH_MAX_ACCURACY_M = 100

/**
 * Consecutive same-vehicle polls before the boarding prompt may auto-confirm a
 * vehicle on the rider's behalf.
 *
 * On 2026-09-01 ride 1, 08:26:26, ONE poll did it: `consecutiveMatches: 1`,
 * confidence `medium`, the bus 135 m away and its `nextStopId` still the
 * rider's own boarding stop — i.e. it had not arrived. The auto-confirm minted
 * `confidence: "confirmed"` and CONFIRM_VEHICLE's SET_RIDING landed 3 ms
 * later, so the whole board decision rested on a single poll of a bus that was
 * still approaching. Three polls is ~3 s of agreement, which is what the
 * matcher's own promotion to 'high' already asks for and no more.
 */
export const BOARD_AUTO_CONFIRM_MIN_CONSECUTIVE = 3

/**
 * The rider's continuous wait at one leg's boarding stop.
 *
 * Kept on the trip session rather than derived per tick: "how long have they
 * been here" is not a function of one position, and the whole point of the
 * gate is that it cannot be satisfied by a single fix.
 */
export interface BoardStopDwell {
  /** ms spent continuously within BOARD_STOP_DWELL_RADIUS_M of the stop. */
  dwellMs: number
  /** The fix clock of the last tick folded in. */
  lastTickMs: number
  /** Which leg's boarding stop this dwell is about. */
  legIndex: number
}

/**
 * Fold one fix into the boarding-stop dwell.
 *
 * Leaving the radius, or moving to a different leg, restarts the count from
 * zero — a rider who cycled past a stop has not waited at it. An unknown
 * distance (a leg with no stop coordinates) also clears, because the honest
 * answer to "have they waited here" is then "we cannot say", and this gate
 * exists to refuse on exactly that.
 */
export function trackBoardStopDwell(
  prev: BoardStopDwell | null,
  sample: {
    distanceToBoardStopM: number | null
    legIndex: number
    nowMs: number
  }
): BoardStopDwell | null {
  const { distanceToBoardStopM, legIndex, nowMs } = sample
  const awayFromStop =
    distanceToBoardStopM == null ||
    !Number.isFinite(distanceToBoardStopM) ||
    distanceToBoardStopM > BOARD_STOP_DWELL_RADIUS_M

  // A different leg's boarding stop is a different question; start again.
  if (prev == null || prev.legIndex !== legIndex) {
    return awayFromStop ? null : { dwellMs: 0, lastTickMs: nowMs, legIndex }
  }

  // Once the wait has actually run its course it is a FACT about this leg, not
  // a condition the rider has to keep satisfying — and leaving the stop is
  // precisely what boarding looks like.
  //
  // Without this latch the gate is unsatisfiable on any transit leg longer
  // than BOARD_STOP_DWELL_RADIUS_M / RIDING_MIN_PROGRESS (~2.4 km), because
  // GPS establishment ALSO needs progressAlongLeg >= RIDING_MIN_PROGRESS: on
  // the 2026-07-29 Orange Line leg (13,279 m) 5% is 664 m down the freeway,
  // some 550 m past the point where the dwell had already been erased. The
  // recorded ride shows exactly that — 332 s of genuine waiting at I-35W &
  // 46th St Station, discarded at 17:28:03 as the bus pulled away, so the
  // riding fact could only ever come from whatever the vehicle feed said next.
  const waitCompleted = prev.dwellMs >= BOARD_STOP_DWELL_MIN_MS
  if (awayFromStop) {
    return waitCompleted ? { ...prev, lastTickMs: nowMs } : null
  }

  const step = Math.min(
    Math.max(0, nowMs - prev.lastTickMs),
    BOARD_STOP_DWELL_MAX_STEP_MS
  )
  return {
    dwellMs: prev.dwellMs + step,
    lastTickMs: nowMs,
    legIndex
  }
}

/**
 * Has the matched vehicle actually got to the rider's boarding stop?
 *
 * A GTFS-RT record whose `nextStopId` IS the boarding stop is a bus that has
 * not arrived yet: on 2026-09-01 ride 1 the rider stood on the platform at
 * 0.0-0.9 m/s while 8139 reported `nextStopId: 1:56831` — "I-35W & 98th St
 * Station", the rider's own stop — 127-135 m out, and the app declared them
 * aboard it. Once the bus is at or past the stop its next stop is a different
 * one, which is the cheapest honest statement that boarding was possible.
 *
 * A feed that publishes no next stop, or a leg with no boarding stop id,
 * passes: never block a decision on data an agency simply does not publish
 * (the same policy as the null headsign and null accuracy cases above).
 *
 * ...but `nextStopId` alone is not the whole statement, because it does not
 * distinguish a bus APPROACHING the stop from one standing AT it. Metro
 * Transit keeps naming the current stop while the doors are open: measured on
 * `orange-line-0729.json`, 8140 reported `stopStatus: "STOPPED_AT"` with
 * `nextStopId: "1:53543"` — the rider's own stop — on all five records from
 * 17:27:49 to 17:28:48, sitting 39 m and then 23-25 m off the I-35W & 46th St
 * platform at `speed: 0`. It only named a different stop (`1:52719`) at
 * 17:28:52, ON DEPARTURE, by which time it was already 230 m up the freeway.
 * So the plain rule refuses exactly the bus the rider is stepping onto, for
 * the whole minute it is boardable (6.38).
 *
 * `stopStatus` is the field that separates the two cases, so a `STOPPED_AT`
 * naming the boarding stop counts as REACHED. This cannot weaken the
 * 2026-09-01 ride 1 refusal that the gate exists for: 8139 was 127-135 m out
 * and `IN_TRANSIT_TO`, which still fails. A record with no `stopStatus` (or
 * any other status) falls through to the original comparison unchanged.
 */
export function vehicleReachedBoardStop(
  match:
    | { nextStopId?: string | null; stopStatus?: string | null }
    | null
    | undefined,
  matchedLeg: Leg | null | undefined
): boolean {
  const boardStopId =
    (matchedLeg as any)?.from?.stopId ?? (matchedLeg as any)?.from?.stopCode
  const nextStopId = match?.nextStopId
  if (!boardStopId || nextStopId == null) return true
  if (nextStopId !== boardStopId) return true
  // Same stop named — the dwelling case is the only one that is nonetheless
  // "reached". Compared case-insensitively: the field arrives as the GTFS-RT
  // enum name from some producers and lower-cased from others.
  return String(match?.stopStatus ?? '').toUpperCase() === 'STOPPED_AT'
}

/**
 * Every stop id this leg is known to call at, or null when the leg does not
 * say. Ids arrive in three shapes on the same object — `1:53543` on
 * `from`/`to`, the bare code `53543` beside it, and a base64 `Stop:1:52719`
 * on `intermediateStops` — so everything is reduced to the trailing segment.
 *
 * Null unless the leg ENUMERATES its calls: a leg carrying only `from` and
 * `to` may still stop ten times in between (several recorded fixtures have an
 * empty `intermediateStops`), and "not in the list" would then be a statement
 * about the recording rather than about the bus.
 */
function legCalledStopKeys(matchedLeg: any): Set<string> | null {
  const intermediate = matchedLeg?.intermediateStops
  if (!Array.isArray(intermediate) || intermediate.length === 0) return null
  const keys = new Set<string>()
  const add = (v: unknown) => {
    if (typeof v === 'string' && v) keys.add(v.slice(v.lastIndexOf(':') + 1))
  }
  for (const place of [matchedLeg?.from, matchedLeg?.to, ...intermediate]) {
    add(place?.stopId)
    add(place?.stopCode)
    add(place?.stop?.gtfsId)
    add(place?.stop?.code)
  }
  return keys.size ? keys : null
}

/**
 * Is the vehicle heading for a stop this leg actually calls at?
 *
 * The other half of matchDescribesLeg. A route id says which SERVICE a match
 * is about; it says nothing about which way round the loop the bus is going,
 * and on 2026-07-29 that is the whole incident: one stale position for the
 * rider's own bus (8140 sat at the platform with speed 0 for 44 s after the
 * rider had already pulled away on it) let the OPPOSITE-direction Orange Line
 * across I-35W, 8141 on trip 1:1082792, win the match at 559 m and establish
 * the riding fact. Every direction gate the matcher owns was inert on that
 * data: the feed published `heading: null` for 8141 on the deciding snapshot,
 * and no `directionId` at all.
 *
 * Its next stop, though, was 1:53542 — the NORTHBOUND platform at 46th St —
 * and it never once named a stop on the rider's leg (1:17780, 1:53311,
 * 1:53313, 1:53314 followed). 8140 named nothing else: 1:53543, 1:52719,
 * 1:56832, 1:56884, 1:56833, the leg's five calls in order. Where the leg
 * lists its calls, "your bus is going to a stop you are not going to" is the
 * cheapest honest statement that a match is about a different bus, and it
 * holds when heading, direction_id and headsign are all missing.
 *
 * Silent on the data agencies omit: no next stop in the feed, or a leg that
 * does not enumerate its calls, passes — the same policy as the null headsign
 * and null accuracy cases.
 */
export function matchServesLegStops(
  match: { nextStopId?: string | null } | null | undefined,
  matchedLeg: Leg | null | undefined
): boolean {
  const nextStopId = match?.nextStopId
  if (nextStopId == null) return true
  const calls = legCalledStopKeys(matchedLeg as any)
  if (calls == null) return true
  return calls.has(nextStopId.slice(nextStopId.lastIndexOf(':') + 1))
}

/**
 * Does this riding fact rest on a real bus, or only on a projection?
 *
 * `route:<routeId>` ids are synthetic — minted by the riding lock and by
 * replanFromAboard, in no feed, refreshable by nothing — so they carry exactly
 * as much evidence as a null: none.
 */
export function ridingFactIsEvidenced(
  riding: { vehicleId: string | null } | null | undefined
): boolean {
  const id = riding?.vehicleId
  return !!id && !id.startsWith('route:')
}

export type RidingDecision =
  | { kind: 'none' }
  | { kind: 'set'; riding: RidingState }
  | { kind: 'markOffRoute'; riding: RidingState }
  | { kind: 'clear' }

export interface RidingDecisionInput {
  /**
   * How long the rider has waited at THIS leg's boarding stop, per
   * trackBoardStopDwell. Omitted (or null) reads as "no wait recorded", which
   * refuses a first GPS-only establishment — see BOARD_STOP_DWELL_MIN_MS.
   */
  boardStopDwellMs?: number | null
  /** Reported accuracy of the fix behind this tick, in metres. */
  fixAccuracyM?: number | null
  /** The leg the matcher currently favours. */
  matchedLeg: Leg | null | undefined
  nowMs: number
  /** ms the rider must be off-route before the fact is dropped. */
  offRouteClearMs: number
  prevRiding: RidingState | null
  /** The rider's own GPS ground speed, when the fix carries one. */
  riderSpeedMps: number | null
  routeMatch: RouteMatchResult
  vehicleMatch: {
    consecutiveMatches?: number
    match?: VehicleMatchResult | null
  } | null
}

function legRouteId(leg: any): string | null {
  return leg?.routeId ?? leg?.route?.gtfsId ?? leg?.route?.id ?? null
}

function legTripId(leg: any): string | null {
  return leg?.trip?.gtfsId ?? leg?.tripId ?? null
}

/**
 * Does this vehicle match speak for the leg the matcher is on?
 *
 * A match is evidence about ONE bus on ONE route. A confirmed one is also the
 * stickiest fact Go Mode holds: refreshConfirmedMatch never re-matches, and a
 * SYNTHETIC vehicle id (`route:<routeId>`, minted by the riding lock and by
 * replanFromAboard) is in no feed at all, so it can never be refreshed, demoted
 * or aged out. It simply persists — across the alight, across the bike leg,
 * across the transfer.
 *
 * On 2026-08-31 that is exactly what happened. The Orange Line match (route
 * 1:904, trip 1:1268645, vehicle route:1:904, "confirmed" since 17:15:01) was
 * still held when the rider reached the 539's leg at 17:35:57, and decideRiding
 * ranked it ABOVE the leg's own trip id. So the riding fact was established on
 * the 539 carrying the Orange Line's identity — which shouldReplanBoardedEarlier
 * compares against the planned leg's trip and can never match. It fired three
 * times in 2m14s and cost the rider their 539.
 *
 * A route disagreement is the cheapest honest statement of "this match is not
 * about that bus". Missing on either side passes: the matcher does not always
 * carry a routeId, and a decision must never be blocked on data a feed simply
 * does not publish (same policy as the null headsign/accuracy cases).
 */
export function matchDescribesLeg(
  match: { routeId?: string | null } | null | undefined,
  matchedLeg: Leg | null | undefined
): boolean {
  const matchRouteId = match?.routeId ?? null
  const legRoute = legRouteId(matchedLeg)
  if (matchRouteId == null || legRoute == null) return true
  return matchRouteId === legRoute
}

/** Loose headsign agreement — either side may be absent or differently cased. */
function headsignsAgree(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  return (a?.trim?.()?.toLowerCase?.() || a) === (b?.trim?.()?.toLowerCase?.() || b)
}

/**
 * Is there enough evidence to assert, for the FIRST time on this trip, that the
 * rider is aboard a run that is not the one they planned?
 *
 * shouldRebindRidingTrip deliberately waves through first establishment — all
 * of its hysteresis protects *re*binds. That left the very first SET_RIDING,
 * the one that anchors everything downstream, completely unchecked. On
 * 2026-08-27 that is how a rider standing still at 6th St S was bound to the
 * INBOUND 94 (trip 1:1184013, headsign "Express / I-94 / Downtown Mpls") when
 * their leg was the outbound run (trip 1:1177858, "Downtown St Paul"). Because
 * classifyMissedBus opens with `if (riding) return null`, that one assertion
 * disabled missed-bus detection for the whole ten-minute wait.
 *
 * Claiming a DIFFERENT run than planned is a real claim — the rider may well
 * have caught an earlier bus — so it is allowed, but it now has to be
 * corroborated by something: the same headsign (an earlier run of the same
 * service), or the rider actually being carried somewhere.
 */
export function firstEstablishmentIsCorroborated(input: {
  matchedLeg: Leg | null | undefined
  riderSpeedMps: number | null
  ridingTripId: string | null
  vehicleMatch: VehicleMatchResult | null | undefined
  vehicleTrusted: boolean
}): boolean {
  const {
    matchedLeg,
    riderSpeedMps,
    ridingTripId,
    vehicleMatch,
    vehicleTrusted
  } = input
  const plannedTripId = legTripId(matchedLeg)

  // Riding the run we planned needs no extra proof; this is the normal case.
  if (!plannedTripId || !ridingTripId || ridingTripId === plannedTripId) {
    return true
  }

  if (!vehicleTrusted) return false

  const headsignAgrees = headsignsAgree(
    vehicleMatch?.tripHeadsign,
    (matchedLeg as any)?.headsign
  )
  const beingCarried =
    riderSpeedMps != null && riderSpeedMps > RIDING_ESTABLISH_MIN_SPEED_MPS

  return headsignAgrees || beingCarried
}

/**
 * Establish, refresh, mark off-route, or drop the riding fact for this tick.
 */
export function decideRiding(input: RidingDecisionInput): RidingDecision {
  const {
    boardStopDwellMs,
    fixAccuracyM,
    matchedLeg,
    nowMs,
    offRouteClearMs,
    prevRiding,
    riderSpeedMps,
    routeMatch,
    vehicleMatch
  } = input

  const onTransit = routeMatch.isOnRoute && !!(matchedLeg as any)?.transitLeg
  if (!onTransit) {
    if (!prevRiding) return { kind: 'none' }
    if (prevRiding.offRouteSince == null) {
      return {
        kind: 'markOffRoute',
        riding: { ...prevRiding, offRouteSince: nowMs }
      }
    }
    return nowMs - prevRiding.offRouteSince > offRouteClearMs
      ? { kind: 'clear' }
      : { kind: 'none' }
  }

  const match = vehicleMatch?.match ?? null
  const vehicleTrusted =
    match?.confidence === 'confirmed' || match?.confidence === 'high'
  // Trusted AND about this leg. A confirmed match for a different route is not
  // evidence the rider is aboard THIS bus, and it must not get to name this
  // ride's trip or vehicle — see matchDescribesLeg for the 8/31 transfer.
  const vehicleSpeaksForLeg =
    vehicleTrusted &&
    matchDescribesLeg(match, matchedLeg) &&
    matchServesLegStops(match, matchedLeg)
  // What a NEW claim of aboard-ness from GPS alone has to prove.
  //
  // Route proximity plus motion is not it: that is a cyclist riding beside a
  // bus route, which is what the rider was on 2026-09-01 (ride 2, 10:47:15 —
  // 8.0 m/s, 4.3 km from the boarding stop, `vehicleId: null`,
  // `confidence: "none"`, zero nearby vehicles, and the only quantity that
  // moved was distanceFromRoute crossing 100 m). Three things now have to hold
  // together, and each of them is a false board already on record:
  //
  //   - the projection is tight to the shape (the 8/27 parallel-street board);
  //   - the fix is good enough to mean anything (the 8/31 1254 m board, 4.4);
  //   - the rider WAITED at this leg's boarding stop and then moved along the
  //     shape — the rider's own spec, and the only one of the three that a
  //     bicycle overtaking a bus route cannot satisfy.
  //
  // A fact already held is exempt from all of it: refreshes and the
  // offRouteSince reset must not pause just because the rider projects far
  // from a sparse shape, or because their fix degraded in a tunnel.
  const fixIsSound =
    fixAccuracyM == null ||
    !Number.isFinite(fixAccuracyM) ||
    fixAccuracyM <= RIDING_ESTABLISH_MAX_ACCURACY_M
  const waitedAtBoardStop = (boardStopDwellMs ?? 0) >= BOARD_STOP_DWELL_MIN_MS
  const gpsMayEstablish =
    routeMatch.distanceFromRoute <= RIDING_ESTABLISH_MAX_DISTANCE_M &&
    fixIsSound &&
    waitedAtBoardStop
  const gpsPlausiblyAboard =
    routeMatch.progressAlongLeg >= RIDING_MIN_PROGRESS &&
    (prevRiding != null || gpsMayEstablish)
  // A trusted match is direct evidence — but on a FIRST establishment it has
  // to be evidence that boarding was possible. On 2026-09-01 ride 1 the bus
  // was still reporting the rider's own stop as its next one when the match
  // was confirmed; the rider was on the platform watching it approach.
  const vehicleMayEstablish =
    vehicleSpeaksForLeg &&
    (prevRiding != null || vehicleReachedBoardStop(match, matchedLeg))
  const aboard = vehicleMayEstablish || gpsPlausiblyAboard
  if (!aboard) return { kind: 'none' }

  // The trip the rider is ACTUALLY on: a trusted vehicle match knows its
  // GTFS-RT trip, which outranks the planned leg's — the rider may have caught
  // an earlier run of the same route, and the boarded-earlier replan, next-stop
  // anchoring and live leg times all key off this id.
  //
  // Naming asks vehicleSpeaksForLeg, not vehicleMayEstablish: "may this match
  // assert, by itself, that the rider is aboard" and "which bus is it" are
  // different questions, and the first one has already been answered by the
  // time this line runs. Tying them together is what broke 2026-07-29 — GPS
  // established the ride at 17:28:34 while the matcher held 8140 at high
  // confidence, but the board-stop gate (8140's feed record still named the
  // rider's own stop, 44 s stale) suppressed the naming too, so the fact went
  // in with `vehicleId: null` and the first bus it ever named was whatever the
  // feed flapped to. A match that cannot establish can still identify.
  const ridingTripId =
    (vehicleSpeaksForLeg ? match?.tripId : null) ||
    legTripId(matchedLeg) ||
    prevRiding?.tripId ||
    null

  const isFirstEstablishment = !prevRiding || prevRiding.tripId == null
  if (
    isFirstEstablishment &&
    !firstEstablishmentIsCorroborated({
      matchedLeg,
      riderSpeedMps,
      ridingTripId,
      vehicleMatch: match,
      vehicleTrusted: vehicleSpeaksForLeg
    })
  ) {
    return { kind: 'none' }
  }

  // Rebind hysteresis: rewriting riding.tripId to a DIFFERENT trip arms the
  // boarded-earlier replan, so it needs sustained consistent evidence. On 7/29
  // a two-tick stale-feed flap onto the opposite-direction Orange Line rebound
  // the ride and cascaded into auto-replans. When a rebind is disallowed,
  // refreshes (legIndex change, offRouteSince clear) still go out with the
  // EXISTING trip/vehicle.
  const rebindAllowed = shouldRebindRidingTrip(
    prevRiding,
    ridingTripId,
    (matchedLeg as any) ?? null,
    vehicleMatch
  )
  const nextTripId = rebindAllowed ? ridingTripId : prevRiding?.tripId ?? null
  // A match that does not speak for this leg may not name its vehicle either —
  // the same gate the trip id gets above. Whatever was already held is kept, so
  // a leg the matcher merely lost sight of does not shed its bus.
  const nextVehicleId = rebindAllowed
    ? (vehicleSpeaksForLeg ? match?.vehicleId : null) ??
      prevRiding?.vehicleId ??
      null
    : prevRiding?.vehicleId ?? null

  const changed =
    !prevRiding ||
    prevRiding.legIndex !== routeMatch.legIndex ||
    prevRiding.tripId !== nextTripId ||
    // Learning WHICH bus is a change worth recording — and it is the moment
    // the board time above is re-stamped, so it must reach the store.
    prevRiding.vehicleId !== nextVehicleId ||
    prevRiding.offRouteSince != null
  if (!changed) return { kind: 'none' }

  // A board time is only as good as the evidence behind it. On 2026-09-01
  // ride 2 the GPS-only fact of 10:47:15 was carried through the 10:50:55
  // CONFIRM_VEHICLE untouched, so the recorded boarding stayed 3m40s early
  // even once a real bus (1:8216, 127.9 m) had been identified. When
  // unevidenced state first gains a real vehicle id, the confirmation IS the
  // boarding moment.
  const boardedAt =
    prevRiding != null &&
    (ridingFactIsEvidenced(prevRiding) ||
      !ridingFactIsEvidenced({ vehicleId: nextVehicleId }))
      ? prevRiding.boardedAt
      : nowMs

  return {
    kind: 'set',
    riding: {
      boardedAt,
      headsign: (matchedLeg as any)?.headsign ?? null,
      legIndex: routeMatch.legIndex,
      offRouteSince: null,
      routeId: legRouteId(matchedLeg),
      routeShortName:
        (matchedLeg as any)?.routeShortName ??
        (matchedLeg as any)?.route?.shortName ??
        null,
      tripId: nextTripId,
      vehicleId: nextVehicleId
    }
  }
}
