import type { Leg } from '@opentripplanner/types'

import { deviationThresholdM, shouldAutoReroute } from './notification-service'
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

/** The longest wait between quiet access-leg re-plans, on a long leg. */
export const QUIET_REPLAN_MIN_INTERVAL_MS = 60000

/**
 * ...and the shortest, on a very short one. The cooldown exists to let the
 * rider converge onto the geometry a swap just handed them; on a leg with two
 * blocks left there is nothing to converge onto, and waiting is just being
 * wrong for longer. 2026-08-28: a re-plan produced a 670 m leg, the rider was
 * 122 m off it within 55 s, and the app said nothing for nearly three minutes.
 */
export const QUIET_REPLAN_MIN_COOLDOWN_MS = 25000

/** Remaining access distance at which the full cooldown applies. */
export const QUIET_REPLAN_FULL_COOLDOWN_LEG_M = 2000

/**
 * A rolling ceiling on re-plans, on top of the cooldown.
 *
 * Scaling the cooldown down makes a re-plan storm arithmetically possible for
 * the first time, and each quiet re-plan is a real OTP call and a real
 * itinerary swap under a moving rider. Three per five minutes is exactly the
 * ceiling the old behaviour already had — the ROUTE_DEVIATION dedup window is
 * 120 s (notification-service.ts), so the trigger could never fire faster than
 * that — which is the point: the first retry gets to come at 25–60 s instead of
 * 120 s, and the worst case does not move. It also stays at the ride-watch
 * daemon's `reroute-storm` boundary (it warns above 3 in 5 minutes).
 */
export const QUIET_REPLAN_BURST_WINDOW_MS = 300000
export const QUIET_REPLAN_BURST_MAX = 3

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
 * The trigger is the DRIFT, not the alert about it. It used to be the alert:
 * this read `notifications.some(n => n.type === 'ROUTE_DEVIATION')` and nothing
 * else, which quietly borrowed checkRouteDeviation's 120 s dedup window as the
 * re-plan's retry interval. Those two windows answer different questions — one
 * is about how often to interrupt the rider, the other about how soon to fix
 * their route — and conflating them is why scaling QUIET_REPLAN_MIN_INTERVAL_MS
 * on its own would have changed nothing on 8/28. A fresh alert still triggers;
 * so now does a drift that is simply still there, judged against
 * checkRouteDeviation's own per-mode threshold so the two can never disagree
 * about the same metre. Rate is the cooldown's job (quietReplanAdmitted).
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
  /** This tick's smoothed distance from the planned route, when known. */
  distanceFromRoute?: number | null
  notifications: NotificationEvent[]
  reRouteStatus: string
}): boolean {
  const { currentLeg, distanceFromRoute, notifications, reRouteStatus } = input
  if (
    !currentLeg ||
    currentLeg.transitLeg ||
    (currentLeg.mode !== 'WALK' && currentLeg.mode !== 'BICYCLE')
  ) {
    return false
  }
  if (
    shouldAutoReroute(notifications, reRouteStatus) &&
    notifications.some((n) => n.type === 'ROUTE_DEVIATION')
  ) {
    return true
  }
  if (reRouteStatus !== 'idle' && reRouteStatus !== 'none') return false
  return (
    distanceFromRoute != null &&
    Number.isFinite(distanceFromRoute) &&
    distanceFromRoute > deviationThresholdM(currentLeg)
  )
}

/**
 * How much of the access chain the rider still has in front of them, in metres.
 *
 * Sums the planned distance of every leg from the current one up to (not
 * including) the next transit boarding — or the end of the trip when there is
 * none — with the current leg discounted by how far along it the matcher says
 * they are. Null when the legs carry no usable distances, which the cooldown
 * reads as "assume a long leg".
 */
export function remainingAccessDistanceM(
  legs: Leg[] | undefined,
  currentLegIndex: number,
  progressAlongLeg: number | null | undefined
): number | null {
  if (!legs?.length) return null
  let total = 0
  let sawDistance = false
  for (let i = Math.max(0, currentLegIndex); i < legs.length; i++) {
    const leg = legs[i]
    if (leg?.transitLeg) break
    const distance = leg?.distance
    if (typeof distance !== 'number' || !Number.isFinite(distance)) continue
    sawDistance = true
    if (i === currentLegIndex) {
      const done =
        typeof progressAlongLeg === 'number' &&
        Number.isFinite(progressAlongLeg)
          ? Math.min(1, Math.max(0, progressAlongLeg))
          : 0
      total += distance * (1 - done)
    } else {
      total += distance
    }
  }
  return sawDistance ? total : null
}

/**
 * The cooldown to apply given how much access leg is left.
 *
 * Linear in remaining distance, so a leg the rider will be off in ninety
 * seconds is not held to the same patience as a half-hour ride, floored so it
 * can never collapse into a storm and capped at the old flat interval so no
 * long leg gets MORE eager than before. An unknown distance takes the cap.
 */
export function quietReplanCooldownMs(
  remainingAccessMeters?: number | null
): number {
  if (
    remainingAccessMeters == null ||
    !Number.isFinite(remainingAccessMeters)
  ) {
    return QUIET_REPLAN_MIN_INTERVAL_MS
  }
  const scaled =
    (Math.max(0, remainingAccessMeters) / QUIET_REPLAN_FULL_COOLDOWN_LEG_M) *
    QUIET_REPLAN_MIN_INTERVAL_MS
  return Math.min(
    QUIET_REPLAN_MIN_INTERVAL_MS,
    Math.max(QUIET_REPLAN_MIN_COOLDOWN_MS, scaled)
  )
}

/** Drop re-plan timestamps that have fallen out of the burst window. */
export function trimQuietReplanHistory(
  history: number[] | undefined,
  nowMs: number
): number[] {
  return (history ?? []).filter((t) => nowMs - t < QUIET_REPLAN_BURST_WINDOW_MS)
}

/**
 * Whether a quiet re-plan may start now.
 *
 * Debounced because a swap restarts route matching against the new itinerary:
 * the rider needs time to converge onto it before another re-plan is worth
 * considering — and how much time that is depends on how much leg is left
 * (quietReplanCooldownMs). 'none' — a settled empty attempt — is as replannable
 * as 'idle'; anything else is in flight or is a card the rider is looking at.
 * The burst window is the backstop the scaled cooldown needs.
 */
export function quietReplanAdmitted(input: {
  lastReplanAtMs: number
  nowMs: number
  reRouteStatus: string
  /** Re-plan timestamps within the burst window; omitted means none yet. */
  recentReplanAtMs?: number[]
  /** From remainingAccessDistanceM; omitted takes the full cooldown. */
  remainingAccessMeters?: number | null
}): boolean {
  const {
    lastReplanAtMs,
    nowMs,
    recentReplanAtMs,
    remainingAccessMeters,
    reRouteStatus
  } = input
  if (reRouteStatus !== 'idle' && reRouteStatus !== 'none') return false
  if (nowMs - lastReplanAtMs < quietReplanCooldownMs(remainingAccessMeters)) {
    return false
  }
  return (
    trimQuietReplanHistory(recentReplanAtMs, nowMs).length <
    QUIET_REPLAN_BURST_MAX
  )
}
