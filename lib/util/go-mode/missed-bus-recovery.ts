import type { MissedBusContext } from './notification-service'

/**
 * What to do once the bus is missed.
 *
 * Detection is `classifyMissedBus` in notification-service; this is the other
 * half — whether to re-plan now, whether to apply the result without asking,
 * and how often to keep trying when the attempt fails.
 *
 * Two rules shape it, both paid for:
 *
 * 1. A definitive miss (the realtime feed says the bus left, or the rider is
 *    provably away from the stop) auto-updates to the SAME route's next
 *    departure — no prompt, no route change. The rider who is standing at the
 *    stop watching their bus pull away does not want a question.
 *
 *    An ambiguous miss re-plans too, but never applies the result: `autoApply`
 *    is exactly that gate. It used to be described here as surfacing "the
 *    regular card", and that card was deleted in eb74a9d8 — so from then until
 *    2026-09-03 an ambiguous miss ran a real search, put real itineraries in
 *    `goMode.reRoute`, and showed the rider nothing. The result is now handed
 *    to the planner and announced with its numbers; see the ambiguous branch of
 *    handlePositionUpdate. Which is why the retry schedule below is no longer
 *    definitive-only: an ambiguous miss that settles with nothing is a rider
 *    still standing at a stop, and deserves the same second look.
 *
 * 2. The re-plan keeps its own retry schedule, per missed departure. The
 *    MISSED_BUS notification has a 30-minute dedup window and trip recovery
 *    must not be gated by it: a fetch that fails at 09:02 has to try again at
 *    09:03, not at 09:32. Capped, so a dead network does not retry forever.
 *
 * Split out of handlePositionUpdate, where the attempt record was mutated in
 * place across three separate branches of a 750-line function.
 *
 * Note on the clock: the caller passes wall-clock `Date.now()`, which is what
 * the inline version used and what the retry schedule means (how long the rider
 * has really been stranded). Every other clock in the tick is the simulation
 * aware one, so a replay running at 8x does NOT reproduce this cadence
 * faithfully — retries stay a real minute apart while the simulated trip races
 * past. Preserved rather than changed, because changing it changes what the
 * verify scripts and the recorded rides replay. Worth revisiting deliberately.
 */

/** How long before a failed auto-update tries again. */
export const MISSED_BUS_REROUTE_RETRY_MS = 60000
/** Attempts per missed departure before giving up on it. */
export const MISSED_BUS_REROUTE_MAX_ATTEMPTS = 5

/** Retry bookkeeping for one missed departure (definitive or ambiguous). */
export interface MissedBusAttempt {
  attempts: number
  departureMs: number
  lastAtMs: number
}

export interface MissedBusRecoveryDecision {
  /**
   * Apply the best result without asking. False for an ambiguous miss, which
   * must never swap the rider's route on a guess — its result is shown, not
   * applied.
   */
  autoApply: boolean
  /** The attempt record to carry into the next tick. */
  next: MissedBusAttempt | null
  /** True when the tick should start a same-route re-plan now. */
  replan: boolean
}

/**
 * Decide whether a missed bus should be re-planned on this tick.
 *
 * `prev` is the attempt record carried from the last tick. `justRaised` is
 * whether THIS tick produced the MISSED_BUS notification — the first sight of
 * the miss re-plans immediately; later ticks are the retry schedule.
 */
export function evaluateMissedBusRecovery(
  prev: MissedBusAttempt | null,
  input: {
    justRaised: boolean
    missed: MissedBusContext | null
    nowMs: number
    /** goMode.reRoute.status, after any stuck-search recovery. */
    reRouteStatus: string
  }
): MissedBusRecoveryDecision {
  const { justRaised, missed, nowMs, reRouteStatus } = input

  if (!missed) return { autoApply: false, next: prev, replan: false }

  // A different departure is a different problem: start its count at zero.
  // lastAtMs 0 so the first retry is due immediately — which is also how an
  // ambiguous miss gets its FIRST search. It cannot lean on `justRaised` the
  // way a definitive one does: nothing pushes a notification for an ambiguous
  // miss any more (checkMissedBus returns null for it and waits for the
  // outcome), so `justRaised` is false on every tick of one.
  let attempt = prev
  if (prev?.departureMs !== missed.effectiveBoardMs) {
    attempt = { attempts: 0, departureMs: missed.effectiveBoardMs, lastAtMs: 0 }
  }

  // 'idle' and 'none' are both settled — nothing in flight, and no result the
  // rider is currently being shown. Anything else must resolve on its own
  // first; in particular 'found' means the alternatives are in the planner
  // under them, and re-running the search would pull them out from under.
  const settled = reRouteStatus === 'idle' || reRouteStatus === 'none'
  const retryDue =
    attempt != null &&
    settled &&
    attempt.attempts < MISSED_BUS_REROUTE_MAX_ATTEMPTS &&
    nowMs - attempt.lastAtMs >= MISSED_BUS_REROUTE_RETRY_MS

  const replan = justRaised
    ? // A definitive miss also supersedes an already-showing result — those
      // alternatives were computed for an itinerary that is now dead. Only an
      // in-flight search is left to resolve on its own.
      reRouteStatus === 'idle' ||
      (missed.definitive && reRouteStatus !== 'searching')
    : !!retryDue

  if (replan && attempt) {
    attempt = {
      ...attempt,
      attempts: attempt.attempts + 1,
      lastAtMs: nowMs
    }
  }

  return { autoApply: missed.definitive, next: attempt, replan }
}
