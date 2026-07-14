import type { Itinerary, Leg } from '@opentripplanner/types'

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
