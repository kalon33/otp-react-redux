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
