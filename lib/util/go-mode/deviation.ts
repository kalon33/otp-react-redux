import type { Leg } from '@opentripplanner/types'

import { accessBoardGates } from './riding'
import { deviationThresholdM, shouldAutoReroute } from './notification-service'
import type { AccessBoardSample } from './riding'
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
 * How long a freshly-installed re-plan gets to be joined before it counts as
 * ignored.
 *
 * A swap hands the rider a new polyline and the matcher starts over on it, so
 * a few seconds at `currentLegProgress` 0 is normal and means nothing. What is
 * NOT normal is still being off that polyline by the mode's own deviation
 * threshold half a minute later — that is a plan the rider never joined, and
 * re-planning again immediately just hands them another one.
 *
 * 30 s is set by the two recorded outcomes, which are cleanly separated.
 * 2026-09-21 17:34:42 (`0921-1727-newbundle`): the rider converged onto the
 * new plan in 14 s (`behind` -> `on_track` at 17:34:57) and rode it for 55 s —
 * that re-plan worked and must not be penalised. 2026-09-21 16:38:05
 * (`0921-1605-465-wrongdir`): `deviated` again at 16:38:16, 11 s in, and stayed
 * deviated through both of the re-plans that followed.
 */
export const QUIET_REPLAN_IGNORED_WINDOW_MS = 30000

/**
 * ...and what the next automatic re-plan then has to wait.
 *
 * The 16:38 loop is three full-trip plans in 61 s, each installed, each
 * abandoned within seconds, and by the third the rider's progress bar had been
 * reset to zero twice and their map redrawn three times. None of the ordinary
 * brakes could stop it: the scaled cooldown was 25-38 s because the leg kept
 * getting shorter, and `QUIET_REPLAN_BURST_MAX` is exactly 3.
 *
 * Two minutes, doubling per consecutive ignored re-plan. It is deliberately
 * far longer than the cooldown: the cooldown asks "has the rider had time to
 * settle onto the last plan", and the answer here is that they had time and
 * did not take it. A rider who is going their own way is better served by a
 * stable map and their own eyes than by a plan a minute.
 */
export const QUIET_REPLAN_IGNORED_BACKOFF_MS = 120000

/** Ceiling on the doubling — five minutes, the burst window. */
export const QUIET_REPLAN_IGNORED_BACKOFF_MAX_MS = 300000

/** The extra silence owed after `streak` consecutive ignored re-plans. */
export function ignoredReplanBackoffMs(streak: number | undefined): number {
  const n = Number.isFinite(streak)
    ? Math.max(0, Math.floor(streak as number))
    : 0
  if (n <= 0) return 0
  return Math.min(
    QUIET_REPLAN_IGNORED_BACKOFF_MAX_MS,
    QUIET_REPLAN_IGNORED_BACKOFF_MS * Math.pow(2, n - 1)
  )
}

/**
 * Did the rider join the re-plan just installed, or ride away from it?
 *
 * Called once per tick with the window's bookkeeping. It closes the window in
 * both directions: drift past the mode's threshold inside the window counts
 * the re-plan ignored and arms the backoff; surviving the window resets the
 * streak, so a rider who settles onto a plan buys back the app's licence to
 * re-plan for them later.
 */
export function noteReplanFollowed(input: {
  /** When the last automatic re-plan was installed; null when none is open. */
  appliedAtMs: number | null
  /** This tick's smoothed distance from the planned route. */
  distanceFromRoute?: number | null
  ignoredStreak: number
  nowMs: number
  /** `deviationThresholdM` for the leg the rider is on. */
  thresholdM: number
}): { appliedAtMs: number | null; ignoredStreak: number } {
  const { appliedAtMs, distanceFromRoute, ignoredStreak, nowMs, thresholdM } =
    input
  if (appliedAtMs == null) return { appliedAtMs, ignoredStreak }
  if (nowMs - appliedAtMs > QUIET_REPLAN_IGNORED_WINDOW_MS) {
    // Joined and stayed: the window closed with the rider on the plan.
    return { appliedAtMs: null, ignoredStreak: 0 }
  }
  if (
    distanceFromRoute != null &&
    Number.isFinite(distanceFromRoute) &&
    distanceFromRoute > thresholdM
  ) {
    return { appliedAtMs: null, ignoredStreak: ignoredStreak + 1 }
  }
  return { appliedAtMs, ignoredStreak }
}

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
 * Consecutive fixes of transit-pace motion on the next transit leg's own shape
 * before the quiet access re-plan stands down (backlog 26.6).
 *
 * The re-plan's other guard is `riding.tripId` — evidence of a specific bus —
 * and on 2026-09-22 09:33 that fact was four seconds late: vehicle 8148's feed
 * record was 52 s stale (`lastSeen` 09:32:43, `STOPPED_AT` Lake St), so the
 * matcher had nothing to establish on while the rider rode away from the
 * platform on it. Meanwhile the matcher was held on the finished bike leg
 * (the board time the app held for the bus leg was 09:40:11, so the transition
 * gate refused it) and every metre down the busway was a metre "off" that bike
 * leg. The scoped re-plan went out on the 09:33:48.999 fix and installed a
 * 284 m BICYCLE leg for a rider doing 15.2 m/s.
 *
 * The fixes of that window, rider speed in m/s:
 *
 *   09:33:42.999 11.37 | :43.999 12.36 | :44.999 12.72 | :45.999 13.13
 *   :46.999 13.30 | :47.999 14.49 | :48.999 15.21 (the re-plan's own fix)
 *
 * — six distinct fixes at or above {@link ACCESS_BOARD_MIN_SPEED_MPS} by the
 * one the re-plan went out on, all within 5 m of the Orange Line's shape. The
 * drift crossed the bike leg's deviation threshold on the 09:33:46.999 fix
 * (`UPDATE_PROGRESS status deviated` 09:33:47.081 on the day), the fourth of
 * them, so four is the most this could ask and still be in hand on the first
 * tick a re-plan could ever run. Three keeps one fix of margin for a phone
 * that drops one, and is still more than a bad fix can manufacture: the one
 * transit-pace sample on record from a rider on a bicycle is a single
 * 13.0 m/s spike, 1,073 m off the corridor (`bike-false-board-1029`,
 * 10:34:13).
 *
 * Counted in FIXES, not ticks: the stream delivers some fixes twice (the
 * 09:33:48.999 and :53.999 fixes above are each dispatched twice), and a
 * repeated fix is not a second observation.
 */
export const TRANSIT_PACE_REPLAN_HOLD_FIXES = 3

/** A run of fixes that look like a rider carried along the next transit leg. */
export interface TransitPaceRun {
  /** The transit leg whose shape the run tracks. */
  boardLegIndex: number
  /** Distinct qualifying fixes in the run. */
  fixes: number
  /** The last fix folded in, by its own clock. */
  lastFixMs: number
  /** The access leg the matcher is on. */
  legIndex: number
}

/**
 * Fold one access-leg fix into the transit-pace run.
 *
 * The same three facts {@link accessBoardGates} asks of a boarding — transit
 * pace, the fix on the next transit leg's own shape inside the establish
 * bound, a fix good enough to place the rider — and NOT the fourth, a vehicle
 * match. That is the whole point: this is the evidence-free arm, for exactly
 * the minutes when the feed is too stale to name the bus. It never boards
 * anybody; all it does is keep the quiet re-plan from answering "the rider is
 * on a bus" with a bicycle.
 */
export function trackTransitPace(
  prev: TransitPaceRun | null,
  sample: AccessBoardSample
): TransitPaceRun | null {
  const gates = accessBoardGates({ ...sample, vehicleMatch: null })
  if (!gates.transitPace || !gates.onCorridor || !gates.fixSound) return null
  const { boardLegIndex, legIndex, nowMs } = sample
  if (
    !prev ||
    prev.legIndex !== legIndex ||
    prev.boardLegIndex !== boardLegIndex
  ) {
    return { boardLegIndex, fixes: 1, lastFixMs: nowMs, legIndex }
  }
  if (nowMs <= prev.lastFixMs) return prev
  return { ...prev, fixes: prev.fixes + 1, lastFixMs: nowMs }
}

/**
 * Should the quiet access re-plan stand down because the rider is, by every
 * measure short of a vehicle id, already on the bus?
 *
 * Only for the access leg the run was measured on. Silence is not asked for
 * anywhere else: a rider who slows below transit pace or leaves the transit
 * leg's shape resets the run on that very fix, and the re-plan is theirs again.
 */
export function transitPaceHoldsAccessReplan(
  run: TransitPaceRun | null | undefined,
  legIndex: number
): boolean {
  return (
    !!run &&
    run.legIndex === legIndex &&
    run.fixes >= TRANSIT_PACE_REPLAN_HOLD_FIXES
  )
}

/**
 * Whether a quiet access-leg re-plan will run on THIS tick — asked BEFORE the
 * notifications are raised, so the ROUTE_DEVIATION card can be held back for a
 * problem the app is about to fix silently.
 *
 * Deliberately nothing but the two predicates the tick already runs, composed:
 * the drift arm of shouldQuietReplanAccessLeg (an empty notification list,
 * because the alert is exactly what this is being asked about) and
 * quietReplanAdmitted's rate gate. Composing rather than restating them is the
 * point — a fourth copy of "is this drift re-plannable" is how the alert and the
 * re-plan end up disagreeing about the same metre, which is the failure
 * deviationThresholdM was extracted to prevent.
 *
 * A re-plan that another arm of the tick pre-empts (missed-bus recovery, the
 * boarded-earlier swap) still counts: from the rider's side those are the same
 * answer — the app is fixing the route. What is NOT modelled is
 * destinationStalled: when re-planning has been retired for the mode, the
 * caller raises DESTINATION_UNREACHABLE, which is a better thing to say than
 * "Off Route" about a route no re-plan is coming for.
 */
export function willQuietReplanAccessLeg(input: {
  currentLeg: Leg | undefined
  distanceFromRoute?: number | null
  ignoredStreak?: number
  lastReplanAtMs: number
  nowMs: number
  reRouteStatus: string
  recentReplanAtMs?: number[]
  remainingAccessMeters?: number | null
}): boolean {
  const {
    currentLeg,
    distanceFromRoute,
    ignoredStreak,
    lastReplanAtMs,
    nowMs,
    recentReplanAtMs,
    remainingAccessMeters,
    reRouteStatus
  } = input
  return (
    shouldQuietReplanAccessLeg({
      currentLeg,
      distanceFromRoute,
      notifications: [],
      reRouteStatus
    }) &&
    quietReplanAdmitted({
      ignoredStreak,
      lastReplanAtMs,
      nowMs,
      recentReplanAtMs,
      remainingAccessMeters,
      reRouteStatus
    })
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
  /** Consecutive re-plans the rider never joined — see ignoredReplanBackoffMs. */
  ignoredStreak?: number
  lastReplanAtMs: number
  nowMs: number
  reRouteStatus: string
  /** Re-plan timestamps within the burst window; omitted means none yet. */
  recentReplanAtMs?: number[]
  /** From remainingAccessDistanceM; omitted takes the full cooldown. */
  remainingAccessMeters?: number | null
}): boolean {
  const {
    ignoredStreak,
    lastReplanAtMs,
    nowMs,
    recentReplanAtMs,
    remainingAccessMeters,
    reRouteStatus
  } = input
  if (reRouteStatus !== 'idle' && reRouteStatus !== 'none') return false
  const wait = Math.max(
    quietReplanCooldownMs(remainingAccessMeters),
    ignoredReplanBackoffMs(ignoredStreak)
  )
  if (nowMs - lastReplanAtMs < wait) {
    return false
  }
  return (
    trimQuietReplanHistory(recentReplanAtMs, nowMs).length <
    QUIET_REPLAN_BURST_MAX
  )
}
