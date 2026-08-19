import type { Leg } from '@opentripplanner/types'

import { shouldAutoReroute } from './notification-service'
import type { NotificationEvent } from './notification-service'

/**
 * Drifting off the planned route: how far off the rider really is, and what to
 * do about it.
 *
 * Detection (the ROUTE_DEVIATION notification itself) is checkRouteDeviation in
 * notification-service. This module holds the two decisions either side of it —
 * the smoothing that keeps one bad GPS fix from counting as drift, and whether
 * the drift is the kind the app quietly re-plans around.
 */

/** Nothing shorter than this between quiet access-leg re-plans. */
export const QUIET_REPLAN_MIN_INTERVAL_MS = 60000

/**
 * The distance-from-route to judge deviation on: the smaller of this tick's and
 * the previous tick's matched distance.
 *
 * A single wild fix (urban multipath) can put the matched distance kilometres
 * off-route for one tick — 5836 m mid-ride on 7/22, while the rider sat on the
 * bus dead on its line. Taking the smaller of two consecutive ticks means a
 * one-tick glitch vanishes entirely and sustained drift passes through one tick
 * late, which is the trade worth making: a false "you've gone off route" costs
 * the rider more than a second of delay does.
 *
 * With no previous tick the answer is 0 — on the first fix of a trip there is
 * no baseline, and the app should not accuse the rider of drifting before it
 * has seen them move.
 */
export function smoothDistanceFromRoute(
  prev: number | null,
  current: number
): { distance: number; next: number } {
  return { distance: Math.min(current, prev ?? 0), next: current }
}

/**
 * Whether this tick's drift is the kind to quietly re-plan around.
 *
 * Only on a walk or bike leg. There, the rider going their own way is a
 * navigation problem the app can just solve — re-plan the access path from
 * where they are, car-GPS style, with no card and no screen change.
 *
 * On a transit leg it is deliberately nothing beyond the notification that
 * already fired: an auto-swap would change downstream routes without the
 * rider's consent, and the rider's own tap on the trip sheet lands in the
 * aboard-aware flow instead. (No connection-warning exclusion is needed here —
 * checkConnectionWarning only ever fires on transit legs, so on an access leg
 * it could never be present. The check that used to be here was dead code that
 * read like a policy.)
 */
export function shouldQuietReplanAccessLeg(input: {
  currentLeg: Leg | undefined
  notifications: NotificationEvent[]
  reRouteStatus: string
}): boolean {
  const { currentLeg, notifications, reRouteStatus } = input
  if (!shouldAutoReroute(notifications, reRouteStatus)) return false
  return !!(
    currentLeg &&
    !currentLeg.transitLeg &&
    (currentLeg.mode === 'WALK' || currentLeg.mode === 'BICYCLE') &&
    notifications.some((n) => n.type === 'ROUTE_DEVIATION')
  )
}

/**
 * Whether a quiet re-plan may start now.
 *
 * Debounced because a swap restarts route matching against the new itinerary:
 * the rider needs time to converge onto it before another re-plan is worth
 * considering. 'none' — a settled empty attempt — is as replannable as 'idle';
 * anything else is in flight or is a card the rider is looking at.
 */
export function quietReplanAdmitted(input: {
  lastReplanAtMs: number
  nowMs: number
  reRouteStatus: string
}): boolean {
  const { lastReplanAtMs, nowMs, reRouteStatus } = input
  if (reRouteStatus !== 'idle' && reRouteStatus !== 'none') return false
  return nowMs - lastReplanAtMs >= QUIET_REPLAN_MIN_INTERVAL_MS
}
