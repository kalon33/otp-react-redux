import { getLegRouteId } from './departure-anchor'
import type { Itinerary, Leg } from '@opentripplanner/types'

/**
 * "Is this materially the same trip?" — the last line before an auto-apply
 * swaps the rider's itinerary out from under them.
 *
 * Modelled on collectRerouteCandidates' leg signature (mode + route +
 * endpoints), extended with the trip id and a MINUTE-BUCKETED start time:
 * live-time jitter must not read as a change, but two departures of the same
 * route must stay distinguishable. Bucketing is coarse at the boundary (a few
 * seconds of jitter across :00 lands in the next bucket) — acceptable, because
 * the trip id already carries the identity that matters and a re-applied
 * splice of the same trip reproduces the same times anyway.
 *
 * Deliberately not itinerariesAreEqual (lib/util/itinerary.tsx) — it needs a
 * FareProductSelector, compares fares, and matches legs by lat/lon only, so it
 * would call two different departures "equal". Nor hashItinerary, which hashes
 * live times, so functionally identical itineraries never hash equal.
 */
export function itinerarySignature(
  itinerary: Itinerary | null | undefined
): string {
  if (!itinerary) return ''
  return (itinerary.legs || [])
    .map((l: Leg) => {
      const tripId = (l as any).trip?.gtfsId || (l as any).tripId || ''
      const startMinute = Math.floor(Number(l.startTime) / 60000) || 0
      // getLegRouteId, not leg.routeId: a synthesized onboard leg carries its
      // route as an object while a planner leg carries the flattened id, and
      // the whole point here is to compare across those two provenances.
      return `${l.mode}:${getLegRouteId(l) || ''}:${tripId}:${
        l.from?.name || ''
      }>${l.to?.name || ''}@${startMinute}`
    })
    .join('|')
}

/**
 * Collect re-route itineraries into a browsable list: de-duplicated, sorted
 * shortest-duration first, capped to a handful. The plan response can surface
 * the same option more than once; collapse by a lightweight leg signature
 * (mode + route + endpoints).
 */
export function collectRerouteCandidates(
  itineraries: Itinerary[] | null | undefined,
  limit = 5
): Itinerary[] {
  if (!itineraries?.length) return []
  const seen = new Set<string>()
  const unique: Itinerary[] = []
  for (const itin of itineraries) {
    const sig = (itin.legs || [])
      .map(
        (l: Leg) =>
          `${l.mode}:${(l as any).routeId || ''}:${l.from?.name || ''}>${
            l.to?.name || ''
          }`
      )
      .join('|')
    if (seen.has(sig)) continue
    seen.add(sig)
    unique.push(itin)
  }
  return unique.sort((a, b) => a.duration - b.duration).slice(0, limit)
}
