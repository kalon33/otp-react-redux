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
 * The access end time is deliberately NOT clamped to the board time: if the
 * rider now arrives after departure the itinerary shows the truth, and the
 * missed-bus machinery (which measures the BUS against the stop, and can fire
 * here because the rider is not riding on an access leg) resolves it under
 * its own same-route rules.
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
