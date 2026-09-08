/**
 * departure-anchor.ts — pure helpers for anchoring Go Mode to the soonest
 * live departure the rider can actually catch at the boarding stop.
 *
 * Extracted from WalkingNavigation (which still uses them for display) so the
 * action layer can dispatch the same value into goMode.departureOverride:
 * the itinerary's planned board time can be far later than the bus the rider
 * will really take (e.g. a later-departing itinerary was activated), and the
 * wait/notification math must target the real bus, not the planned one.
 */
import type { Leg } from '@opentripplanner/types'

import { epochMs } from './time'
import { mergeAndSortStopTimes } from '../stop-times'

// OTP realtimeState values that mean the time reflects live vehicle data
// (as opposed to the static schedule).
export const LIVE_REALTIME_STATES = new Set(['UPDATED', 'ADDED', 'MODIFIED'])

// Auto-anchor only when the catchable bus is at least this much earlier than
// the itinerary's planned board — small differences are realtime jitter, not
// a different bus.
export const AUTO_ANCHOR_MIN_GAIN_MS = 120000

// How long a departure stays catchable after its predicted time has passed.
// Absorbs a late bus that isn't reporting realtime; see getSoonestCatchableMs.
export const DEPARTURE_OVERDUE_GRACE_MS = 60000

// The rider must still have at least this much of the access leg left before
// the anchor is allowed to RELEASE an unreachable departure.
//
// It is the whole of the 7/22 protection. Standing at the stop the rider has
// no ride time left, so "unreachable" degenerates into "overdue" — and an
// overdue bus with no realtime is a LATE bus, not a gone one ("showed 465 at
// 0135 before mine even left"). Releasing is therefore only ever done to a
// rider who is still travelling toward the stop, where the deficit is a
// measured travel-time shortfall rather than a bus running behind.
export const RELEASE_MIN_RIDE_SECONDS = 60

export interface RouteDeparture {
  depMs: number
  realtime: boolean
  routeId?: string
}

/**
 * The service date `findStopTimesForStop` should be asked for so that it
 * returns the departures still runnable *now*: the local calendar date in the
 * feed's timezone, rolled back one day before the 03:30 service break
 * (SERVICE_BREAK in util/api — an after-midnight run belongs to yesterday's
 * service day). The naive `new Date().toISOString()` this replaces was the
 * UTC date, which from 7 PM CDT onward is already *tomorrow* — every evening
 * the anchor fetched a day with no catchable departures and went dead.
 */
export function currentServiceDate(nowMs: number, timeZone: string): string {
  const hourMin = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    timeZone
  }).format(nowMs)
  const beforeServiceBreak = hourMin < '03:30'
  return new Intl.DateTimeFormat('sv-SE', { timeZone }).format(
    beforeServiceBreak ? nowMs - 86400000 : nowMs
  )
}

/**
 * OTP2 returns the route as an object (leg.route.id, aliased to gtfsId);
 * legacy responses use a top-level leg.routeId. Match the stop-time gtfsId.
 */
export function getLegRouteId(leg?: Leg | null): string | null {
  const route = (leg as any)?.route
  return (
    (route && typeof route === 'object' ? route.id || route.gtfsId : null) ||
    (leg as any)?.routeId ||
    null
  )
}

/**
 * All upcoming departures of the given route at the boarding stop, from the
 * stop-times data in the transit index (sorted earliest first). Each entry
 * prefers the live (realtime) departure when the feed reports one and falls
 * back to the static schedule otherwise.
 */
export function getRouteDepartures(
  stopData: any,
  routeId: string | null
): RouteDeparture[] {
  if (!stopData || !routeId) return []
  try {
    return mergeAndSortStopTimes(stopData)
      .map((st: any) => {
        const live =
          LIVE_REALTIME_STATES.has(st.realtimeState) &&
          st.realtimeDeparture != null
        const secs = live ? st.realtimeDeparture : st.scheduledDeparture
        return {
          depMs: (st.serviceDay + secs) * 1000,
          realtime: live,
          routeId: st.route?.gtfsId || st.trip?.route?.gtfsId
        }
      })
      .filter((d: RouteDeparture) => d.routeId === routeId)
      .sort((a: RouteDeparture, b: RouteDeparture) => a.depMs - b.depMs)
  } catch {
    return []
  }
}

/**
 * Soonest departure the rider has a chance at. Leaving now they'd reach the
 * stop in ~`rideSecondsRemaining`, but OTP's bike-time estimate is
 * conservative — so also surface departures they'd reach by riding up to 25%
 * faster (capped at 3 min). If there's a chance, you see it.
 *
 * `graceMs` keeps a departure that is slightly overdue in the running. Standing
 * at the stop, `rideSecondsRemaining` is ~0, so without it a bus running a
 * minute late with no realtime update drops out of the list the instant its
 * scheduled time passes — and the anchor slides onto the NEXT trip while the
 * rider's bus is still on its way (7/22: "showed 465 at 0135 before mine even
 * left"). Whether a bus is truly gone is classifyMissedBus's call, not this
 * function's.
 */
export function getSoonestCatchableMs(
  departures: RouteDeparture[],
  nowMs: number,
  rideSecondsRemaining: number,
  graceMs = 0
): number | null {
  const optimismMs = Math.min(180000, rideSecondsRemaining * 1000 * 0.25)
  const reachable = departures.find(
    (d) => d.depMs - nowMs >= rideSecondsRemaining * 1000 - optimismMs - graceMs
  )
  return reachable?.depMs ?? null
}

/**
 * Whether a departure already in force is one the rider provably cannot make —
 * the exact negation of the test `getSoonestCatchableMs` applies when it picks
 * one, so a departure this calls unreachable is one that function would skip.
 *
 * Guarded by RELEASE_MIN_RIDE_SECONDS: with no ride time left the inequality
 * says nothing but "overdue", and an overdue bus may simply be late.
 *
 * 2026-09-08, session mtssjvee-mtc2dx. A `departureOverride` of 10:07:33 was
 * restored from the saved session at 09:57:39. OTP's own bike leg put the
 * rider at the boarding stop at 10:12:59 — five and a half minutes after that
 * bus — and the first progress tick measured `waitTimeAtStop` at -281 s. The
 * override was never re-examined: the anchor leaves alone any override it did
 * not itself set, START_GO_MODE does not clear it, and missed-bus deliberately
 * ignores an override naming another run. So the card headlined 10:07 AM for
 * the whole 11.7-minute ride and, 109 s after the bus had gone, still read
 * "arrives in <1 min" (a negative countdown rounds to "<1 min"), with the
 * rider's actual bus — the live 10:25 — demoted to a "Later departures" row.
 */
export function departureIsUnreachable(
  departureMs: number | null | undefined,
  nowMs: number,
  rideSecondsRemaining: number,
  graceMs = DEPARTURE_OVERDUE_GRACE_MS
): boolean {
  if (departureMs == null || !Number.isFinite(departureMs)) return false
  if (rideSecondsRemaining <= RELEASE_MIN_RIDE_SECONDS) return false
  const optimismMs = Math.min(180000, rideSecondsRemaining * 1000 * 0.25)
  return (
    departureMs - nowMs < rideSecondsRemaining * 1000 - optimismMs - graceMs
  )
}

/**
 * Whether the anchor should adopt `candidateMs` over the departure currently in
 * force (a previous anchor, else the plan's board time).
 *
 * The comparison must be against the EFFECTIVE departure, never the planned
 * one: on 2026-07-22 the anchor had already moved to an earlier bus, that bus
 * ran late with no realtime, and the next trip — still far earlier than the
 * plan — looked like a fresh gain, so the display skipped to it while the
 * rider's bus was still coming ("showed 465 at 0135 before mine even left").
 * The anchor may only ever move earlier; giving up on a bus is the missed-bus
 * path's call, and that one keeps the rider's route.
 */
export function shouldAdoptAnchor(
  candidateMs: number | null,
  effectiveDepartureMs: number
): boolean {
  if (candidateMs == null || !Number.isFinite(effectiveDepartureMs)) {
    return false
  }
  return effectiveDepartureMs - candidateMs >= AUTO_ANCHOR_MIN_GAIN_MS
}

/**
 * The boarding stop whose departures the anchor needs this tick, or null when
 * the anchor does not apply — it runs only while the rider is on a walk/bike
 * leg heading into a transit leg.
 *
 * Separate from the decision below because the caller has to go and fetch the
 * departures in between: the trip-start snapshot goes stale, and an earlier bus
 * only ever shows up in a fresh poll.
 */
export function anchorBoardingStopId(
  currentLeg: Leg | undefined,
  nextLeg: Leg | undefined
): string | null {
  const onAccessLeg =
    currentLeg?.mode === 'WALK' || currentLeg?.mode === 'BICYCLE'
  if (!onAccessLeg || !nextLeg?.transitLeg) return null
  return (nextLeg as any)?.from?.stop?.gtfsId ?? null
}

export interface AnchorDecision {
  /** The departure to anchor to, or null to leave the override alone. */
  anchorMs: number | null
  /**
   * Drop the override in force — it names a bus the rider cannot reach. Not
   * the same as `anchorMs: null`, which means "leave it alone"; the caller
   * must dispatch an explicit null so the card falls back to the soonest
   * departure the rider CAN catch.
   */
  clear?: boolean
  /** The last auto-anchored departure, to carry into the next tick. */
  next: number | null
}

/**
 * Decide whether to move the rider onto an earlier same-route departure.
 *
 * `prev` is the departure this anchor last chose — the caller keeps it so it
 * can tell its own override apart from one the rider picked by hand. A manual
 * pick (or a reset) sets `manualLock` and the anchor stays out of the way for
 * the rest of that boarding.
 */
export function evaluateDepartureAnchor(
  prev: number | null,
  input: {
    /** goMode.departureOverride — the departure currently in force. */
    departureOverride: number | null
    /** Departures at the boarding stop for the boarding route, sorted. */
    departures: RouteDeparture[]
    /** True once the rider has chosen a departure themselves. */
    manualLock: boolean
    nowMs: number
    /** The boarding leg's planned start; `number | string` on the wire. */
    plannedBoardMs: number | string | null | undefined
    /** Seconds of walking/riding left before reaching the stop. */
    rideSecondsRemaining: number
  }
): AnchorDecision {
  const {
    departureOverride,
    departures,
    manualLock,
    nowMs,
    plannedBoardMs,
    rideSecondsRemaining
  } = input

  // Never fight the rider's own choice, and never overwrite an override this
  // anchor did not set.
  if (manualLock) return { anchorMs: null, next: prev }

  // ...but "leave it alone" cannot mean "keep it forever". An override naming
  // a departure the rider is measurably too far away to reach is not a choice
  // any more, whoever set it — including one restored from a saved session,
  // which arrives with `prev` rebuilt as null and so is frozen by the very
  // guard below (9/8, see departureIsUnreachable). Release it and let the
  // ordinary path re-acquire: with the override gone the display and the
  // anchor both fall back to the soonest departure the rider CAN catch, which
  // is the same route's next run — the rider's standing rule.
  if (
    departureOverride != null &&
    departureIsUnreachable(departureOverride, nowMs, rideSecondsRemaining)
  ) {
    return { anchorMs: null, clear: true, next: null }
  }

  if (departureOverride != null && departureOverride !== prev) {
    return { anchorMs: null, next: prev }
  }

  const soonest = getSoonestCatchableMs(
    departures,
    nowMs,
    rideSecondsRemaining,
    DEPARTURE_OVERDUE_GRACE_MS
  )

  // Measured against the departure currently in force, never the plan's — see
  // shouldAdoptAnchor for the 7/22 ride that rule comes from. epochMs rather
  // than Number(): the planned board time is `number | string`, and Number()
  // on an ISO string is NaN, which would silently disable the anchor.
  const effectiveDeparture = departureOverride ?? epochMs(plannedBoardMs)
  if (!shouldAdoptAnchor(soonest, effectiveDeparture)) {
    return { anchorMs: null, next: prev }
  }
  if (soonest === departureOverride) return { anchorMs: null, next: prev }

  return { anchorMs: soonest, next: soonest }
}
