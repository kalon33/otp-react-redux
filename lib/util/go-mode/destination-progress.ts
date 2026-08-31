/**
 * Whether re-planning is still getting the rider closer to where they are going.
 *
 * `distanceToDestination` is recomputed from scratch on every tick
 * (progress-calculator's distanceToFinalStop) and read by exactly one thing —
 * the arrival latch at ARRIVAL_RADIUS_M. Nothing kept it across ticks, so
 * nothing in the app could notice the one failure mode the arrival latch cannot
 * catch: re-planning that never converges.
 *
 * 2026-08-28 afternoon: the destination was inside the State Fairgrounds, where
 * the street graph stops at the fence. The distance to it never dropped below
 * 454 m across 32 minutes, and the app re-planned into the venue interior over
 * and over — each plan real, each plan routing to the same unreachable point,
 * each one telling the rider they were nearly there. A trip cannot be finished
 * by re-planning when the last stretch is not in the graph; the honest move is
 * to stop asking and say so.
 *
 * The test is deliberately about NET reduction rather than the plan's own
 * claims: a plan that says it reaches the destination but leaves the rider at
 * the same distance three re-plans running is not routing them anywhere,
 * whatever its itinerary says. And a genuine gain clears the count — re-planning
 * that started working again is not stalled.
 *
 * Pure, so the arithmetic is testable without a trip; the caller owns where the
 * state lives (session.destinationProgress) and what it does when it fires.
 */

/**
 * A closer approach has to beat the best by this much to count. Under it, the
 * "improvement" is GPS scatter — the 8/28 afternoon's 454 m floor wandered by
 * tens of metres for half an hour without the rider getting anywhere.
 */
export const DESTINATION_GAIN_MIN_M = 50

/**
 * Re-plans allowed with no net gain before the mode is retired. Three is the
 * smallest number that cannot be an unlucky pair: one bad plan happens, two can
 * be a rider who took a wrong turn between them, three is the graph.
 */
export const DESTINATION_STALL_REPLANS = 3

export interface DestinationProgressState {
  /** Closest the rider has come to the destination on this trip, in metres. */
  bestDistanceM: number
  /** Re-plans issued since bestDistanceM last improved. */
  replansSinceGain: number
  /** Access modes whose re-planning has been retired as non-convergent. */
  stalledModes: string[]
}

/**
 * Fold this tick's distance-to-destination in. A real gain resets the stall
 * bookkeeping entirely, including any mode already retired: whatever changed,
 * the rider is moving again and deserves the machinery back.
 */
export function noteDestinationDistance(
  prev: DestinationProgressState | null,
  distanceM: number | null | undefined
): DestinationProgressState | null {
  if (distanceM == null || !Number.isFinite(distanceM)) return prev
  if (!prev) {
    return { bestDistanceM: distanceM, replansSinceGain: 0, stalledModes: [] }
  }
  if (distanceM <= prev.bestDistanceM - DESTINATION_GAIN_MIN_M) {
    return { bestDistanceM: distanceM, replansSinceGain: 0, stalledModes: [] }
  }
  return prev
}

/**
 * Record that a re-plan just went out for `mode`. The count is of re-plans, not
 * ticks: a rider standing still for ten minutes has not proved anything, and a
 * rider who has been re-planned at three times without getting closer has.
 *
 * A null state means no tick has yet produced a distance to the destination —
 * either end of the measurement can be missing (progress-calculator returns
 * null for it). "No net reduction" is not a fact you can hold about a distance
 * nobody has measured, so re-plans are not counted until one has been: without
 * this, a trip whose destination has no coordinates would retire its own
 * re-planning after three attempts on no evidence at all.
 */
export function noteReplanAttempt(
  prev: DestinationProgressState | null,
  mode: string | null | undefined
): DestinationProgressState | null {
  if (!prev) return prev
  const replansSinceGain = prev.replansSinceGain + 1
  const key = mode || 'UNKNOWN'
  const stalledModes =
    replansSinceGain >= DESTINATION_STALL_REPLANS &&
    !prev.stalledModes.includes(key)
      ? [...prev.stalledModes, key]
      : prev.stalledModes
  return { ...prev, replansSinceGain, stalledModes }
}

/** Has re-planning in this mode been retired as not getting the rider closer? */
export function destinationStalled(
  prev: DestinationProgressState | null,
  mode: string | null | undefined
): boolean {
  return !!prev?.stalledModes.includes(mode || 'UNKNOWN')
}
