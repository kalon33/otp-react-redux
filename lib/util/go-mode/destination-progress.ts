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
 * 2026-09-09 ride 2 is the other half, and it is what an attempt now has to
 * survive to be counted. The rider rode 615 m the wrong way and then stood
 * still for three minutes; three quiet re-plans went out on the 60 s cooldown
 * alone, the mode was retired, and the app told them routing stopped 1,670 m
 * short — while all 27 reroute snapshots of that ride, including the four
 * issued after the give-up, ended at the destination with a gap of 0 m. Two
 * things were being counted that are not evidence about the graph:
 *
 *  - re-plans over a rider who has not moved since the last one. The intent was
 *    written here from the start ("a rider standing still for ten minutes has
 *    not proved anything") and nothing implemented it.
 *  - re-plans that never came back. The third one was counted 11.8 s before its
 *    own fetch aborted at the 12 s Go Mode timeout; a request the server never
 *    answered says nothing about whether the destination can be reached.
 *
 * Pure, so the arithmetic is testable without a trip; the caller owns where the
 * state lives (session.destinationProgress) and what it does when it fires.
 */
import { haversineDistance } from './geometry'

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

/**
 * How far the rider has to have moved since the previous re-plan for the next
 * one to be evidence about anything. Under it, the re-plan is answering the
 * same question from the same place and its failure is the rider's stillness,
 * not the graph's reach.
 *
 * 75 m, the arrival radius (progress-calculator's ARRIVAL_RADIUS_M — named
 * rather than imported, to keep this module free of the tick pipeline). Two
 * measurements from 2026-09-09 ride 2 set the floor: the rider stood still from
 * 09:40:47 to the end of the trip, and across that stretch consecutive fixes
 * a minute apart put them up to 32.4 m apart — one of them a fix reporting
 * 114.4 m of accuracy. 30 m would sit inside that scatter. A radius the app
 * already treats as "there" cannot be a distance that proves a rider went
 * somewhere.
 */
export const DESTINATION_REPLAN_MOTION_MIN_M = 75

/** Where the rider was, [lat, lon]. */
export type DestinationProgressPoint = [number, number]

export interface DestinationProgressState {
  /** Closest the rider has come to the destination on this trip, in metres. */
  bestDistanceM: number
  /**
   * Where the rider was when the last re-plan went out — counted or not. It
   * records where the question was asked from, so it moves on every attempt:
   * an attempt that was thrown away for want of an answer still fixes the
   * place the next one is measured against.
   */
  lastAttemptPoint?: DestinationProgressPoint | null
  /** Re-plans issued since bestDistanceM last improved. */
  replansSinceGain: number
  /** Access modes whose re-planning has been retired as non-convergent. */
  stalledModes: string[]
}

/** What became of one admitted re-plan. */
export interface DestinationReplanAttempt {
  /** Where the rider was when the request went out, if known. */
  point?: DestinationProgressPoint | null
  /**
   * Did a plan come back? False for a timeout, a transport error or a GraphQL
   * error — an unanswered request is not evidence against the destination. An
   * answer that contained nothing usable IS one: the server was asked and the
   * plan it gave does not get the rider closer.
   */
  returned?: boolean
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
    return {
      bestDistanceM: distanceM,
      lastAttemptPoint: null,
      replansSinceGain: 0,
      stalledModes: []
    }
  }
  if (distanceM <= prev.bestDistanceM - DESTINATION_GAIN_MIN_M) {
    return {
      bestDistanceM: distanceM,
      // Not stall bookkeeping: where the last question was asked from is a
      // fact about the ride, and a gain does not unmake it.
      lastAttemptPoint: prev.lastAttemptPoint ?? null,
      replansSinceGain: 0,
      stalledModes: []
    }
  }
  return prev
}

/**
 * Record what became of a re-plan for `mode`. The count is of re-plans, not
 * ticks: a rider standing still for ten minutes has not proved anything, and a
 * rider who has been re-planned at three times without getting closer has.
 *
 * Two of those words are load-bearing and were not enforced until 2026-09-09.
 * A re-plan counts only if
 *
 *  - the rider has moved DESTINATION_REPLAN_MOTION_MIN_M since the last one
 *    (`attempt.point`; an unknown position cannot rule an attempt out), and
 *  - a plan came back (`attempt.returned`).
 *
 * Either way the attempt's position is remembered, so the next re-plan is
 * measured from where this one was asked.
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
  mode: string | null | undefined,
  attempt: DestinationReplanAttempt = {}
): DestinationProgressState | null {
  if (!prev) return prev
  const { point = null, returned = true } = attempt
  const carried: DestinationProgressState = {
    ...prev,
    lastAttemptPoint: point ?? prev.lastAttemptPoint ?? null
  }
  const movedM =
    point && prev.lastAttemptPoint
      ? haversineDistance(prev.lastAttemptPoint, point)
      : null
  // The rider has not been anywhere since the last time this was asked.
  if (movedM != null && movedM < DESTINATION_REPLAN_MOTION_MIN_M) {
    return carried
  }
  // Nobody answered. 2026-09-09 09:41:34.878: the request counted as the third
  // strike against the destination aborted at 09:41:46.878 on the 12 s Go Mode
  // timeout — 11.8 s AFTER the notification it had already produced.
  if (!returned) return carried
  const replansSinceGain = carried.replansSinceGain + 1
  const key = mode || 'UNKNOWN'
  const stalledModes =
    replansSinceGain >= DESTINATION_STALL_REPLANS &&
    !carried.stalledModes.includes(key)
      ? [...carried.stalledModes, key]
      : carried.stalledModes
  return { ...carried, replansSinceGain, stalledModes }
}

/** Has re-planning in this mode been retired as not getting the rider closer? */
export function destinationStalled(
  prev: DestinationProgressState | null,
  mode: string | null | undefined
): boolean {
  return !!prev?.stalledModes.includes(mode || 'UNKNOWN')
}
