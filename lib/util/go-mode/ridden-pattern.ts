import type { Itinerary, Leg } from '@opentripplanner/types'

import { getLegRouteId } from './departure-anchor'

/**
 * The whole shape and stop list of the transit pattern a leg rides.
 *
 * A leg's own `legGeometry` runs board stop → alight stop and nothing more, so
 * it cannot answer "where does this line go before I get on and after I get
 * off". That shape only exists in the transit index, under
 * `state.otp.transitIndex.routes[routeId].patterns`, which `findRoute`
 * (`lib/actions/apiV2.js`) fills in with `patternGeometry { points }` and the
 * pattern's ordered `stops`.
 */
export interface RiddenPattern {
  /** Route colour as a CSS hex string, or null when the feed publishes none. */
  color: string | null
  patternId: string | null
  /** Encoded polyline of the WHOLE pattern, not just the ridden hop. */
  points: string | null
  routeId: string
  /** gtfsIds of every stop the pattern calls at, in travel order. */
  stopIds: string[]
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The gtfsId of a leg endpoint, across the shapes OTP2 and the fixtures use. */
function placeStopId(place: any): string | null {
  return place?.stop?.gtfsId || place?.stop?.id || place?.stopId || null
}

/** The display name of a leg endpoint's stop, for the twin-feed fallback. */
function placeStopName(place: any): string | null {
  return place?.stop?.name || place?.name || null
}

function patternStopId(stop: any): string | null {
  return stop?.gtfsId || stop?.id || null
}

/**
 * Where a stop sits in a pattern's stop list: exact gtfsId first, then the
 * stop NAME. Shared stations exist under several GTFS feeds (Burnsville
 * Transit Station is both `1:…` and MVTA's `2:31929`) and a plan leg may name
 * the twin, so an id-only lookup silently finds no pattern at all. The same
 * fallback `findStopTimeIndex` makes in alight-optimizer.ts, for the same
 * reason.
 */
function indexOfStop(
  stops: any[],
  id: string | null,
  name: string | null,
  fromEnd: boolean
): number {
  const byId = fromEnd
    ? stops.map(patternStopId).lastIndexOf(id as string)
    : stops.map(patternStopId).indexOf(id as string)
  if (id && byId >= 0) return byId
  if (!name) return -1
  const names = stops.map((s) => s?.name ?? null)
  return fromEnd ? names.lastIndexOf(name) : names.indexOf(name)
}

/** Every distinct route id ridden by the itinerary's transit legs. */
export function transitLegRouteIds(itinerary?: Itinerary | null): string[] {
  const ids = (itinerary?.legs || [])
    .filter((leg: Leg) => (leg as any)?.transitLeg)
    .map((leg: Leg) => getLegRouteId(leg))
    .filter((id): id is string => !!id)
  return Array.from(new Set(ids))
}

/**
 * The pattern of `route` that this leg actually rides.
 *
 * Exact pattern id when the plan carries one (it usually does not — the
 * shipped planQuery asks for `route`, `trip` and the endpoint stops, never a
 * pattern id). Otherwise the pattern whose stop list contains the board stop
 * BEFORE the alight stop, which is what picks the right direction: the
 * opposite direction's pattern contains both stops in the other order.
 *
 * `findRoute` drops any pattern that is a subsequence of a longer one, so an
 * exact-id lookup can miss even when OTP does name a pattern; the containment
 * match is the one that has to work.
 */
export function matchPatternForLeg(
  leg: Leg | null | undefined,
  patterns: Record<string, any> | null | undefined
): [string, any] | null {
  if (!leg || !patterns) return null
  const anyLeg = leg as any
  const legPatternId =
    anyLeg.patternId ?? anyLeg.pattern?.id ?? anyLeg.trip?.pattern?.id ?? null
  if (legPatternId && patterns[legPatternId]) {
    return [legPatternId, patterns[legPatternId]]
  }

  const boardId = placeStopId(anyLeg.from)
  const boardName = placeStopName(anyLeg.from)
  const alightId = placeStopId(anyLeg.to)
  const alightName = placeStopName(anyLeg.to)
  if (!boardId && !boardName) return null
  if (!alightId && !alightName) return null

  const matches = Object.entries(patterns).filter(([, pattern]) => {
    const stops = pattern?.stops || []
    if (!stops.length) return false
    const board = indexOfStop(stops, boardId, boardName, false)
    if (board < 0) return false
    const alight = indexOfStop(stops, alightId, alightName, true)
    return alight > board
  })
  if (!matches.length) return null

  // Prefer the fullest shape: the point of this is the line beyond the ridden
  // hop, so the longest pattern that still contains the hop is the best answer.
  matches.sort(
    (a, b) => (b[1]?.stops?.length || 0) - (a[1]?.stops?.length || 0)
  )
  return matches[0] as [string, any]
}

/**
 * The full pattern shape and stop list for every transit leg of an itinerary,
 * given the transit index's `routes` map. Legs whose route has not been
 * fetched yet (or whose pattern cannot be identified) are simply absent — this
 * is decoration, so a partial answer is drawn and a missing one draws nothing.
 */
export function riddenPatterns(
  itinerary: Itinerary | null | undefined,
  routes: Record<string, any> | null | undefined
): RiddenPattern[] {
  if (!itinerary?.legs || !routes) return []
  const seen = new Set<string>()
  const out: RiddenPattern[] = []
  itinerary.legs.forEach((leg: Leg) => {
    if (!(leg as any)?.transitLeg) return
    const routeId = getLegRouteId(leg)
    if (!routeId) return
    const route = routes[routeId]
    const matched = matchPatternForLeg(leg, route?.patterns)
    if (!matched) return
    const [patternId, pattern] = matched
    const key = `${routeId}#${patternId}`
    if (seen.has(key)) return
    seen.add(key)
    const rawColor = route?.color || (leg as any)?.route?.color || null
    out.push({
      color: rawColor
        ? `#${String(rawColor).replace(/^#/, '')}`
        : (null as string | null),
      patternId,
      points:
        pattern?.geometry?.points || pattern?.patternGeometry?.points || null,
      routeId,
      stopIds: (pattern?.stops || [])
        .map(patternStopId)
        .filter((id: string | null): id is string => !!id)
    })
  })
  return out
}

/** The encoded shapes to draw, one per ridden pattern, with their colours. */
export function riddenPatternShapes(
  patterns: RiddenPattern[]
): Array<{ color: string | null; points: string }> {
  return patterns
    .filter((p) => !!p.points)
    .map((p) => ({ color: p.color, points: p.points as string }))
}

/** Every stop id on every ridden pattern, de-duplicated. */
export function riddenPatternStopIds(patterns: RiddenPattern[]): string[] {
  return Array.from(new Set(patterns.flatMap((p) => p.stopIds)))
}
