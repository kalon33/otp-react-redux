import { getLegRouteId } from './departure-anchor'
import type { Itinerary, Leg } from '@opentripplanner/types'

/**
 * "Is this materially the same trip?" — the last line before an auto-apply
 * swaps the rider's itinerary out from under them.
 *
 * Modelled on collectRerouteCandidates' leg signature (mode + route +
 * endpoints), extended with the trip id and — for a leg with NO trip id — a
 * minute-bucketed start time: live-time jitter must not read as a change, but
 * two departures must stay distinguishable.
 *
 * The start time is deliberately NOT part of a leg that names a trip. That was
 * how this read until 2026-08-31, defended by "a re-applied splice of the same
 * trip reproduces the same times anyway" — which is false for exactly the legs
 * this guard exists to catch. buildOnboardItinerary stamps a synthesized bus
 * leg `busLegStart = Date.now()`, so re-splicing the same trip yields the same
 * bus, the same stops and a start one minute later. On 8/31 that let three
 * substantively identical Orange Line splices through as three "changes":
 * 17:36, 17:37, 17:38, one high-priority push each. Two departures of one route
 * always carry different trip ids, so the id alone keeps them apart and the
 * clock adds nothing but false novelty.
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
      // Only when the leg has no trip of its own to identify it by.
      const startMinute = tripId
        ? ''
        : Math.floor(Number(l.startTime) / 60000) || 0
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
 * The route the rider is planning to catch NEXT — the first transit leg after
 * the one they are riding. This is the identity an automatic update has to
 * preserve: the boarded route is already settled (they are on it), and the
 * standing rule is about the leg they have not boarded yet.
 *
 * Two ways to say "which leg are they on", because the two callers know
 * different things. Mid-ride there is a leg index (`riding.legIndex`), so the
 * search simply starts after it. In the pre-trip onboard flow there is no leg
 * index yet — the rider has just told us they are aboard — so `boardedRouteId`
 * skips a LEADING transit leg of that same route, which is the bus they are on.
 *
 * Returns null when there is no onward transit leg — a bus-then-walk itinerary
 * has nothing to preserve, and null means "no constraint" to every caller.
 */
export function onwardTransitRouteId(
  itinerary: Itinerary | null | undefined,
  {
    afterLegIndex = -1,
    boardedRouteId = null
  }: { afterLegIndex?: number; boardedRouteId?: string | null } = {}
): string | null {
  const legs = itinerary?.legs || []
  let skippedBoarded = false
  for (let i = Math.max(0, afterLegIndex + 1); i < legs.length; i++) {
    if (!legs[i]?.transitLeg) continue
    const routeId = getLegRouteId(legs[i])
    if (!skippedBoarded && boardedRouteId && routeId === boardedRouteId) {
      skippedBoarded = true
      continue
    }
    return routeId
  }
  return null
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
