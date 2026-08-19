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
 *    departure — no prompt, no route change. An ambiguous miss surfaces the
 *    regular card instead. The rider who is standing at the stop watching their
 *    bus pull away does not want a question.
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

/** Retry bookkeeping for one missed departure. */
export interface MissedBusAttempt {
  attempts: number
  departureMs: number
  lastAtMs: number
}

export interface MissedBusRecoveryDecision {
  /** Apply the best result without asking, rather than surfacing a card. */
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
  // lastAtMs 0 so the first retry is due immediately.
  let attempt = prev
  if (missed.definitive && prev?.departureMs !== missed.effectiveBoardMs) {
    attempt = { attempts: 0, departureMs: missed.effectiveBoardMs, lastAtMs: 0 }
  }

  // 'idle' and 'none' are both settled — nothing in flight, no card the rider
  // is looking at. Anything else must resolve on its own first.
  const settled = reRouteStatus === 'idle' || reRouteStatus === 'none'
  const retryDue =
    missed.definitive &&
    attempt != null &&
    settled &&
    attempt.attempts < MISSED_BUS_REROUTE_MAX_ATTEMPTS &&
    nowMs - attempt.lastAtMs >= MISSED_BUS_REROUTE_RETRY_MS

  const replan = justRaised
    ? // A definitive miss also supersedes an already-showing card — those
      // alternatives were computed for an itinerary that is now dead. Only an
      // in-flight search is left to resolve on its own.
      reRouteStatus === 'idle' ||
      (missed.definitive && reRouteStatus !== 'searching')
    : !!retryDue

  if (replan && missed.definitive && attempt) {
    attempt = {
      ...attempt,
      attempts: attempt.attempts + 1,
      lastAtMs: nowMs
    }
  }

  return { autoApply: missed.definitive, next: attempt, replan }
}
