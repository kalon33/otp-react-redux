/**
 * "Arrive on time" bike routing (rider ask, 2026-09-01; backlog 6.10b).
 *
 * Every access re-plan Go Mode issues is a depart-now query: `arriveBy: false`
 * at the current wall clock. OTP answers it the only way it can — as fast as
 * possible — so a rider who takes the re-plan gets to the boarding stop with
 * whatever slack the ride happened to leave them, and on 2026-09-01 that was a
 * lot: the closing legs were planned at 3.3 m/s against a rider doing 7.5.
 * Arriving twelve minutes early and standing in the cold is not a better trip
 * than arriving three minutes early, and the rider said so.
 *
 * So, when they ask for it, the scoped access query becomes an ARRIVE-BY one
 * aimed a few minutes ahead of the boarding rather than at the boarding
 * itself. The lead is the point: a target of the departure exactly would mean
 * a plan that succeeds only if nothing at all goes wrong.
 *
 * Deliberately narrow:
 *  - opt-in, off by default. An automatic re-plan that quietly told a rider to
 *    slow down would be the app making a judgement about their trip, which is
 *    the thing the never-force-a-route-change rule exists to stop;
 *  - it only ever changes the TIME the query is anchored to. Modes, levers,
 *    the origin, the boarding stop and the acceptance gate in
 *    replan-acceptance.ts are all untouched, so an arrive-by candidate has to
 *    clear exactly the same bar as a depart-now one before it is applied;
 *  - and it stands down whenever the deadline is not comfortably ahead. A
 *    rider who is already going to be late has no slack to spend, and asking
 *    OTP to arrive by a moment that has passed (or is about to) either fails
 *    or answers with something unusable. Depart-now is the honest query then,
 *    and it is what the caller falls back to.
 */

/**
 * Minutes before the bus leaves that the rider wants to be standing at the
 * stop. Three, per the ask — enough to lock a bike and walk to the kerb,
 * short enough to be worth the trouble. `feedback_gentle_changes`: this is a
 * moderate figure, not an aggressive one.
 */
export const ARRIVE_ON_TIME_LEAD_MINUTES = 3

/**
 * The target must be at least this far ahead to be worth aiming at. Inside a
 * minute the arrive-by query and the depart-now query describe the same ride,
 * and a target the rider cannot make is worse than no target: it asks OTP for
 * a plan into the past.
 */
export const ARRIVE_ON_TIME_MIN_WINDOW_MS = 60000

export interface ArriveOnTimeInput {
  /**
   * When the rider boards: the feed's prediction when it is genuinely live,
   * else the plan's own leg start. Null/absent when the boarding has no time
   * at all, which is when there is nothing to aim at.
   */
  boardEpochMs?: number | null
  /** The rider's opt-in (currentQuery.arriveOnTimeAccess). */
  enabled: boolean
  /** Override for the lead, in minutes. Defaults to the constant above. */
  leadMinutes?: number
  nowMs: number
}

/**
 * The epoch the access re-plan should be told to arrive by, or null to leave
 * the query as the depart-now one it has always been.
 */
export function accessArriveByTarget(input: ArriveOnTimeInput): number | null {
  const { boardEpochMs, enabled, leadMinutes, nowMs } = input
  if (!enabled) return null
  if (boardEpochMs == null || !Number.isFinite(boardEpochMs)) return null
  if (!Number.isFinite(nowMs)) return null
  const lead = Number.isFinite(leadMinutes as number)
    ? (leadMinutes as number)
    : ARRIVE_ON_TIME_LEAD_MINUTES
  const target = boardEpochMs - lead * 60000
  if (target - nowMs < ARRIVE_ON_TIME_MIN_WINDOW_MS) return null
  return target
}
