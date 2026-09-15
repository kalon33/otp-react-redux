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
 * 2026-09-15 is the third shape, and it is the one that made the YARDSTICK
 * wrong rather than the counting. The rider left home at 09:31 and biked
 * north-west into downtown to board an Orange Line that then runs 18 km SOUTH.
 * The destination sat 18 km away the whole time, so the straight line to it
 * ROSE while the trip went exactly to plan — 18,340 m at 09:35:19 to 18,653 m
 * at 09:38:58 — and the three re-plans across that stretch each cleared both
 * of the 09-09 tests: the rider moved hundreds of metres between them, and all
 * three came back with plans ending 0 m from the door. The mode was retired at
 * 09:38:58 and re-planning was dead for 3m43s, through a deviation streak that
 * got no answer, until the rider had ridden far enough south to beat the old
 * low-water mark and the give-up self-cleared.
 *
 * Over that same stretch the distance to the BOARDING STOP fell from 1,920 m
 * to 1,270 m, monotonically, on every fix. Nothing was stalled. The
 * measurement was pointed at the wrong end of the trip.
 *
 * So the test measures along the itinerary's REMAINING PATH: metres from the
 * rider to the boarding stop, plus the planned length of the transit leg and
 * everything after it (destinationReachMeasure). Freezing the counter while an
 * access leg runs was the other option and is the weaker one — it disarms the
 * guard for the whole of a 4 km access leg, and a 4 km access leg is where
 * 08-28's rider spent the 32 minutes this module exists for. Measured this way
 * the guard stays armed for the entire trip, just against a distance the rider
 * can actually shorten.
 *
 * When no boarding lies ahead — a bike-only trip, or the egress leg after the
 * bus — the remaining path IS the straight line to the door, so 08-28 and
 * 09-09 are measured to the metre as they were before. And because the
 * yardstick can move under the rider (a re-plan that picks a different
 * boarding stop moves the zero), the measure carries a key; when the key
 * changes, the best-so-far is re-based on the new measurement. The stall COUNT
 * is deliberately NOT cleared by that re-basing: a swap is not a gain, and a
 * guard any itinerary churn could disarm would be no guard.
 *
 * `bestDistanceM` is therefore the best along the measured path. What the
 * rider is told if this fires is still a straight line to their destination —
 * `bestDestinationM` — because that is what "Nm from <destination>" means.
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

/**
 * One tick's yardstick: how far the rider still has to travel along the
 * itinerary, and what that number is measured against.
 */
export interface DestinationReachMeasure {
  /** Metres of remaining path. */
  distanceM: number
  /**
   * What `distanceM` is measured against — the boarding stop, and the planned
   * length of everything from it onward. A different key is a different
   * yardstick, not a different position, and the two must not be compared.
   */
  key: string
}

/** The straight line to the door: the yardstick when no boarding is ahead. */
export const DESTINATION_MEASURE_KEY = 'destination'

/** All destinationReachMeasure needs of an itinerary leg. */
interface ReachLeg {
  distance?: number | null
  from?: { lat?: number | null; lon?: number | null } | null
  transitLeg?: boolean | null
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Planned metres from `boardIndex` to the end of the trip. Null when any leg
 * in it carries no usable length: one missing leg makes the constant wrong by
 * a whole leg, which would move the baseline under the rider mid-trip, and no
 * measure is better than a measure that walks.
 */
function plannedTailM(legs: ReachLeg[], boardIndex: number): number | null {
  let tailM = 0
  for (let i = boardIndex; i < legs.length; i++) {
    const d = legs[i]?.distance
    if (!isFiniteNumber(d)) return null
    tailM += d
  }
  return tailM
}

/**
 * The remaining path, for a rider on an access leg that ends at a boarding
 * stop: straight line from the rider to that stop, plus the planned length of
 * the transit leg and every leg after it.
 *
 * Null whenever the straight line to the destination is already the right
 * answer — no legs, no fix, the rider aboard the bus, or no boarding left
 * ahead of them — so the caller keeps doing exactly what it did before, and
 * null too when the tail cannot be added up (plannedTailM).
 *
 * The straight line to the boarding stop, not the remaining length of the
 * access legs: the access chain's planned length is what the ROUTE is, and a
 * rider who has left it (which is the only reason a quiet re-plan goes out at
 * all) is not on it. What the rider can shorten by riding is the gap to the
 * stop.
 */
export function destinationReachMeasure(
  legs: ReachLeg[] | null | undefined,
  currentLegIndex: number | null | undefined,
  riderPosition: DestinationProgressPoint | null | undefined
): DestinationReachMeasure | null {
  if (!legs?.length || !riderPosition) return null
  const from = Math.min(
    legs.length - 1,
    Math.max(0, Math.trunc(Number(currentLegIndex) || 0))
  )
  // Aboard: the leg under the rider IS the transit leg, so there is no access
  // chain in front of them and nothing here to correct for.
  if (legs[from]?.transitLeg) return null
  let boardIndex = -1
  for (let i = from; i < legs.length; i++) {
    if (legs[i]?.transitLeg) {
      boardIndex = i
      break
    }
  }
  if (boardIndex < 0) return null
  const board = legs[boardIndex]?.from
  const lat = board?.lat
  const lon = board?.lon
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return null
  const tailM = plannedTailM(legs, boardIndex)
  if (tailM == null) return null
  const toBoardM = haversineDistance(riderPosition, [lat, lon])
  if (!Number.isFinite(toBoardM)) return null
  return {
    distanceM: toBoardM + tailM,
    key: `board:${lat},${lon}@${Math.round(tailM)}`
  }
}

export interface DestinationProgressState {
  /**
   * Closest straight-line approach to the destination itself. Not the stall
   * test: this is the distance the rider is quoted if it ever fires, and the
   * only distance for which "Nm from <destination>" is a true sentence.
   */
  bestDestinationM: number
  /**
   * Closest the rider has come along the MEASURED PATH on this trip, in
   * metres — the straight line to the destination when nothing else is being
   * measured, the remaining path when an access leg runs to a boarding stop.
   * This is the number the stall test is about.
   */
  bestDistanceM: number
  /**
   * Where the rider was when the last re-plan went out — counted or not. It
   * records where the question was asked from, so it moves on every attempt:
   * an attempt that was thrown away for want of an answer still fixes the
   * place the next one is measured against.
   */
  lastAttemptPoint?: DestinationProgressPoint | null
  /**
   * What `bestDistanceM` is measured against (DESTINATION_MEASURE_KEY, or a
   * boarding stop and its tail). Distances under different keys are different
   * measurements and are never compared to each other.
   */
  measureKey: string
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
 * Fold this tick's progress in. A real gain resets the stall bookkeeping
 * entirely, including any mode already retired: whatever changed, the rider is
 * moving again and deserves the machinery back.
 *
 * `distanceM` is the straight line to the destination, as it always was.
 * `measure`, when the caller can build one (destinationReachMeasure), is what
 * the gain is actually judged on — see the 2026-09-15 note above. Omitted, the
 * straight line is both, which is what every call did before 09-15 and what
 * every call still does once no boarding lies ahead.
 */
export function noteDestinationDistance(
  prev: DestinationProgressState | null,
  distanceM: number | null | undefined,
  measure?: DestinationReachMeasure | null
): DestinationProgressState | null {
  if (!isFiniteNumber(distanceM)) return prev
  const usable =
    measure != null && isFiniteNumber(measure.distanceM) ? measure : null
  const reachM = usable ? usable.distanceM : distanceM
  const key = usable ? usable.key : DESTINATION_MEASURE_KEY
  if (!prev) {
    return {
      bestDestinationM: distanceM,
      bestDistanceM: reachM,
      lastAttemptPoint: null,
      measureKey: key,
      replansSinceGain: 0,
      stalledModes: []
    }
  }
  // The closest approach to the door is its own running minimum, kept whatever
  // the stall test happens to be measuring this tick.
  const bestDestinationM = Math.min(prev.bestDestinationM, distanceM)
  // The yardstick moved under the rider — a re-plan picked a different
  // boarding stop, or the rider boarded and the remaining path became the
  // straight line again. The old best is a number about a different question,
  // so it is re-based. The COUNT is not: a swap is not a gain, and a guard
  // that any itinerary churn could disarm would be no guard at all.
  if (key !== prev.measureKey) {
    return { ...prev, bestDestinationM, bestDistanceM: reachM, measureKey: key }
  }
  if (reachM <= prev.bestDistanceM - DESTINATION_GAIN_MIN_M) {
    return {
      bestDestinationM,
      bestDistanceM: reachM,
      // Not stall bookkeeping: where the last question was asked from is a
      // fact about the ride, and a gain does not unmake it.
      lastAttemptPoint: prev.lastAttemptPoint ?? null,
      measureKey: key,
      replansSinceGain: 0,
      stalledModes: []
    }
  }
  return bestDestinationM === prev.bestDestinationM
    ? prev
    : { ...prev, bestDestinationM }
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
