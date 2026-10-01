import type { Itinerary, Leg } from '@opentripplanner/types'

/**
 * Splice a freshly planned access itinerary (rider's GPS → boarding stop,
 * all non-transit legs) onto the transit suffix of the active itinerary.
 * Model: buildOnboardItinerary, the other sanctioned splicer.
 *
 * The suffix legs from `boardLegIndex` on are reused as the SAME objects —
 * their times, stops and routes cannot change, so an access replan can never
 * invent a later bus or move the boarding (7/29 ride: "only reroute the bike
 * leg, don't switch my bus routes"). Only container fields are recomputed.
 *
 * The access end time is still deliberately NOT clamped to the board time: a
 * spliced itinerary states what OTP actually said, and inventing an arrival
 * that fits the departure would hide the defect rather than fix it.
 *
 * What is NOT true — and was asserted here until 2026-09-15 (backlog 16.2) —
 * is that the missed-bus machinery resolves such a splice on its own.
 * `checkMissedBus` measures the BUS against the stop, so it cannot say
 * anything until the bus has actually left; on the 09-15 ride two splices
 * whose bike leg ended 3m05s and 49 s after a 09:54:02 Orange Line departure
 * were auto-applied at 09:43:37 and 09:49:39 and stood in front of the rider
 * as "you will miss the bus" for ten minutes, while the rider reached the stop
 * at 09:52:20 and boarded. No MISSED_BUS ever fired.
 *
 * So an infeasible splice is now refused BEFORE it is applied, by
 * `acceptAutoReplan`'s `access-misses-board` check (util/go-mode/
 * replan-acceptance) — which every automatic path already funnels through.
 * This function's contract is unchanged: it reports, it does not judge.
 */
export function spliceAccessOntoItinerary(
  current: Itinerary,
  access: Itinerary,
  boardLegIndex: number
): Itinerary {
  const legs = [
    ...(access.legs || []),
    ...(current.legs || []).slice(boardLegIndex)
  ]
  const startTime = access.startTime
  const endTime = current.endTime
  return {
    ...current,
    duration: (Number(endTime) - Number(startTime)) / 1000,
    endTime,
    legs,
    startTime,
    // transfers is defined by the untouched transit suffix — inherit it from
    // `current` (via the spread) rather than recounting.
    walkDistance: legs
      .filter((l: Leg) => !l.transitLeg)
      .reduce((sum: number, l: Leg) => sum + (l.distance || 0), 0)
  } as Itinerary
}

/**
 * How short an access leg has to be before it is not a leg at all.
 *
 * Measured over every itinerary in the committed replay fixtures (1,168 plans
 * with a non-transit first leg): the leading access distances are 1.27, 1.96,
 * 2.03, 3.33, 3.37, 3.52, 4.09 and 4.94 m — OTP's "you are already standing
 * here" stub — and then NOTHING until 51.24 m. 20 m sits in the middle of that
 * empty band: every stub goes, no real walk is touched, and it stays well
 * inside AUTO_REPLAN_ORIGIN_MAX_M (75 m) so dropping the leg can never make
 * the replan's own origin gate reject the plan it just improved.
 */
export const DEGENERATE_ACCESS_LEG_M = 20

/**
 * Drop a leading access leg that only says "you are already here".
 *
 * On 2026-09-21 the missed-bus replan handed a rider standing 1-6 m from the
 * I-35W & Lake St platform an itinerary whose first leg was a 3.33 m, ONE
 * SECOND bike ride (17:07:49 -> 17:07:50) to the stop they were already at.
 * The trip then opens on a "ride 3 m" instruction instead of the boarding.
 *
 * Container fields are recomputed the way spliceAccessOntoItinerary does;
 * nothing else is touched, and an itinerary whose first leg is transit, or a
 * real walk, or the only leg there is, comes back unchanged (same object).
 */
export function dropDegenerateAccessLeg(
  itinerary: Itinerary,
  thresholdM: number = DEGENERATE_ACCESS_LEG_M
): Itinerary {
  const legs = itinerary?.legs || []
  if (legs.length < 2) return itinerary
  const first: any = legs[0]
  if (first?.transitLeg) return itinerary
  const distance = Number(first?.distance)
  if (!Number.isFinite(distance) || distance >= thresholdM) return itinerary
  const remaining = legs.slice(1)
  const startTime = remaining[0].startTime
  const endTime = itinerary.endTime
  return {
    ...itinerary,
    duration: (Number(endTime) - Number(startTime)) / 1000,
    legs: remaining,
    startTime,
    walkDistance: remaining
      .filter((l: Leg) => !l.transitLeg)
      .reduce((sum: number, l: Leg) => sum + (l.distance || 0), 0)
  } as Itinerary
}
