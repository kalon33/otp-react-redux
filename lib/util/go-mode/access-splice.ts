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
