import { Itinerary, Leg } from '@opentripplanner/types'

import { epochMs } from './go-mode/time'
import { routeSequence } from './go-mode/round-trip'
import type { RoundTripPlan } from './go-mode/round-trip'

/**
 * Multiple stops (backlog 43.1) — the shared contract between the search form,
 * the plan request, the results card and Go Mode.
 *
 * The rider's answer (2026-10-08): "Just want overall trip stats. Then go mode
 * does each leg at a time". Defaults where they did not say: stops are visited
 * in the order the rider adds them, with no required stay (zero dwell), using
 * the same modes the search already offers.
 *
 * - The stops ride on `currentQuery.intermediatePlaces` — the field otp-ui's
 *   query/URL helpers already carry (`intermediatePlaces=name::lat,lon`,
 *   repeated) — and become OTP `via` VISIT locations in the plan request.
 * - OTP returns ONE itinerary through every stop: the leg that ends at a stop
 *   is followed by the leg that leaves it. `markStopLegs` finds those
 *   boundaries, renames the place to the rider's own label and records them on
 *   the itinerary as `stopLegIndexes`.
 * - Go Mode splits the itinerary at those boundaries and guides one segment at
 *   a time (`MultiStopPlan`).
 *
 * Measured against production OTP 2026-10-08 (home → Perennial Cycle → Micro
 * Center, 10:00): one via call and a chain of two searches both arrive 11:44,
 * so the one call is used for every transit search. A STREET-ONLY plan (walk
 * only, bike only) with a via comes back EMPTY with no routing error, so the
 * street-only combination is planned as a chain of direct segments and
 * stitched (`stitchSegments`).
 *
 * Everything here is pure.
 */

/** The most stops a search carries (the call-taker's AddPlaceButton cap). */
export const MAX_STOPS = 3

/** How close a leg end has to be to a stop to be that stop's boundary. */
const STOP_MATCH_M = 30

export interface StopPlace {
  lat: number
  lon: number
  name?: string
}

/** An itinerary that runs through the rider's stops. */
export type MultiStopItinerary = Itinerary & {
  /** Index of the leg that ENDS at each stop, in visiting order. */
  stopLegIndexes?: number[]
}

/** Go Mode's view of a multi-stop trip: one segment guided at a time. */
export interface MultiStopPlan {
  /** The segment being guided now (0-based). */
  index: number
  /**
   * The return half of a round trip, when the rider asked for one. It belongs
   * to the LAST segment only, so it rides here until that segment starts.
   */
  roundTrip?: RoundTripPlan | null
  /** The planned segments, in order; the last one ends at the destination. */
  segments: Itinerary[]
  /** Where each segment ends (the stops, then the destination). */
  stopNames: string[]
}

/** A usable place: finite lat/lon. */
export function isStopPlace(place: any): place is StopPlace {
  return (
    !!place &&
    Number.isFinite(Number(place.lat)) &&
    Number.isFinite(Number(place.lon))
  )
}

/**
 * The stops a query really carries. `intermediatePlaces` can hold empty
 * placeholders (the call-taker panel pushes `{}` for a field being typed) and,
 * straight off a URL with a single stop, a bare string — neither is a stop.
 */
export function queryStops(query: any): StopPlace[] {
  const raw = query?.intermediatePlaces
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isStopPlace)
    .slice(0, MAX_STOPS)
    .map((p: any) => ({ lat: Number(p.lat), lon: Number(p.lon), name: p.name }))
}

/**
 * `qs.parse` gives a repeated param as an array but a single one as a string,
 * and core-utils' planParamsToQuery calls `.map` on it — so one stop in a URL
 * would throw. Always hand it an array.
 */
export function normalizeIntermediatePlacesParam(
  params: Record<string, any>
): Record<string, any> {
  const value = params?.intermediatePlaces
  if (value == null || Array.isArray(value)) return params
  return { ...params, intermediatePlaces: [value] }
}

/** A short name for a stop: the rider's label, else its coordinates. */
export function stopLabel(stop: StopPlace): string {
  if (stop.name) return stop.name
  return `${stop.lat.toFixed(5)}, ${stop.lon.toFixed(5)}`
}

/**
 * The OTP `via` list for the rider's stops: a VISIT of each coordinate, in
 * order, with no required stay. Empty when there are none.
 */
export function viaVisitLocations(stops: StopPlace[]): Array<{
  visit: {
    coordinate: { latitude: number; longitude: number }
    label: string
    minimumWaitTime: string
  }
}> {
  return stops.map((stop) => ({
    visit: {
      coordinate: { latitude: stop.lat, longitude: stop.lon },
      label: stopLabel(stop),
      minimumWaitTime: 'PT0S'
    }
  }))
}

/** Metres between two points; small-distance equirectangular is plenty here. */
function metresBetween(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const rad = Math.PI / 180
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad)
  const y = (b.lat - a.lat) * rad
  return Math.sqrt(x * x + y * y) * 6371000
}

function placeNear(place: any, stop: StopPlace): boolean {
  if (!isStopPlace(place)) return false
  return (
    metresBetween(
      { lat: Number(place.lat), lon: Number(place.lon) },
      { lat: stop.lat, lon: stop.lon }
    ) <= STOP_MATCH_M
  )
}

/**
 * Find where an itinerary reaches each stop and say so on it.
 *
 * OTP marks a visited coordinate only by splitting the street leg there: one
 * leg ends at "<label> (lat, lon)" and the next starts from it. Stops are
 * matched in visiting order, each after the previous one's boundary, and never
 * on the final leg (that one ends at the destination). The place is renamed to
 * the rider's own label on both legs. Stops OTP did not route through are left
 * unmarked. Returns the input unchanged when nothing matched.
 */
export function markStopLegs(
  itinerary: Itinerary,
  stops: StopPlace[]
): MultiStopItinerary {
  const legs = itinerary?.legs || []
  if (!stops.length || legs.length < 2) return itinerary
  const indexes: number[] = []
  let from = 0
  stops.forEach((stop) => {
    for (let i = from; i < legs.length - 1; i++) {
      if (placeNear(legs[i].to, stop)) {
        indexes.push(i)
        from = i + 1
        return
      }
    }
  })
  if (!indexes.length) return itinerary
  const named = legs.map((leg) => leg)
  indexes.forEach((legIndex, n) => {
    const stop = stops[n]
    const name = stopLabel(stop)
    named[legIndex] = {
      ...named[legIndex],
      to: { ...named[legIndex].to, name }
    } as Leg
    named[legIndex + 1] = {
      ...named[legIndex + 1],
      from: { ...named[legIndex + 1].from, name }
    } as Leg
  })
  return { ...itinerary, legs: named, stopLegIndexes: indexes }
}

/** The names of the stops an itinerary runs through, in order. */
export function itineraryStopNames(itinerary: any): string[] {
  const indexes: number[] = itinerary?.stopLegIndexes || []
  const legs = itinerary?.legs || []
  return indexes.map((i) => legs[i]?.to?.name).filter(Boolean)
}

/** Total distance of every leg, in metres. */
export function itineraryDistanceM(itinerary: any): number {
  return (itinerary?.legs || []).reduce(
    (sum: number, leg: any) => sum + (Number(leg?.distance) || 0),
    0
  )
}

/** Recompute the whole-itinerary totals for a run of legs. */
function itineraryOf(base: any, legs: Leg[]): Itinerary {
  const start = epochMs(legs[0]?.startTime as any)
  const end = epochMs(legs[legs.length - 1]?.endTime as any)
  const walkLegs = legs.filter((l) => l.mode === 'WALK')
  const transitLegs = legs.filter((l) => l.transitLeg)
  const next: any = {
    ...base,
    duration:
      Number.isFinite(start) && Number.isFinite(end)
        ? Math.round((end - start) / 1000)
        : base.duration,
    endTime: legs[legs.length - 1]?.endTime,
    legs,
    startTime: legs[0]?.startTime,
    transfers: Math.max(0, transitLegs.length - 1),
    transitTime: transitLegs.reduce((s, l) => s + (l.duration || 0), 0),
    walkDistance: walkLegs.reduce((s, l) => s + (l.distance || 0), 0),
    walkTime: walkLegs.reduce((s, l) => s + (l.duration || 0), 0)
  }
  // The pieces are not themselves multi-stop.
  delete next.stopLegIndexes
  return next as Itinerary
}

/**
 * Split a multi-stop itinerary at its stops: segment k runs from the previous
 * stop (or the origin) to stop k, and the last one to the destination. A plain
 * itinerary comes back as a single segment.
 */
export function splitAtStops(itinerary: MultiStopItinerary): Itinerary[] {
  const legs = itinerary?.legs || []
  const cuts = (itinerary?.stopLegIndexes || []).filter(
    (i) => i >= 0 && i < legs.length - 1
  )
  if (!cuts.length) return [itinerary]
  const segments: Itinerary[] = []
  let start = 0
  cuts.forEach((cut) => {
    segments.push(itineraryOf(itinerary, legs.slice(start, cut + 1)))
    start = cut + 1
  })
  segments.push(itineraryOf(itinerary, legs.slice(start)))
  return segments
}

/**
 * Go Mode's plan for a multi-stop itinerary, starting at the first segment.
 * Null for a plain one — Go Mode then runs exactly as it always has.
 */
export function buildMultiStopPlan(
  itinerary: MultiStopItinerary | null | undefined,
  roundTrip: RoundTripPlan | null = null
): MultiStopPlan | null {
  if (!itinerary?.stopLegIndexes?.length) return null
  const segments = splitAtStops(itinerary)
  if (segments.length < 2) return null
  return {
    index: 0,
    roundTrip,
    segments,
    stopNames: segments.map((s) => {
      const legs = s.legs || []
      return legs[legs.length - 1]?.to?.name || ''
    })
  }
}

/** True while the segment being guided ends at a stop, not the destination. */
export function hasNextSegment(
  plan: MultiStopPlan | null | undefined
): boolean {
  return (
    !!plan &&
    Array.isArray(plan.segments) &&
    plan.index >= 0 &&
    plan.index < plan.segments.length - 1
  )
}

/** The street mode a segment rides when it has no transit, else null. */
export function segmentStreetMode(segment: Itinerary | null | undefined) {
  const legs = segment?.legs || []
  if (!legs.length || legs.some((l) => l.transitLeg)) return null
  return legs.find((l) => l.mode !== 'WALK')?.mode || 'WALK'
}

/**
 * The fresh plan for the next segment that is still the trip the rider chose:
 * the same routes in the same order, ridden the same way (a bike segment stays
 * a bike segment, a walk stays a walk). Null when the fresh answer has no such
 * option — the caller then keeps the stored segment, and Go Mode's own
 * missed-bus handling moves it to the next departure of the same route. Never
 * another route or mode: those are the rider's to choose, from the reroute
 * button (backlog 43.1; the no-forced-route-changes rule).
 */
export function pickNextSegment(
  fresh: Itinerary[] | null | undefined,
  stored: Itinerary | null | undefined
): Itinerary | null {
  if (!fresh?.length || !stored) return null
  const want = routeSequence(stored)
  const bikes = (it: Itinerary) =>
    (it.legs || []).some((l) => l.mode === 'BICYCLE')
  const streetMode = segmentStreetMode(stored)
  return (
    fresh.find(
      (c) =>
        routeSequence(c) === want &&
        bikes(c) === bikes(stored) &&
        (want || segmentStreetMode(c) === streetMode)
    ) || null
  )
}

/**
 * Stitch per-segment street-only itineraries into one trip (the chain used
 * where OTP's via does not apply). Each segment's legs are shifted so it starts
 * when the previous one ends. Null if any segment is missing.
 */
export function stitchSegments(
  segments: Array<Itinerary | null | undefined>
): MultiStopItinerary | null {
  if (!segments.length || segments.some((s) => !s?.legs?.length)) return null
  const legs: Leg[] = []
  const stopLegIndexes: number[] = []
  let cursor = epochMs((segments[0] as Itinerary).startTime as any)
  segments.forEach((segment, n) => {
    const seg = segment as Itinerary
    const segStart = epochMs(seg.startTime as any)
    const shift =
      Number.isFinite(cursor) && Number.isFinite(segStart)
        ? cursor - segStart
        : 0
    seg.legs.forEach((leg) => {
      legs.push({
        ...leg,
        endTime: epochMs(leg.endTime as any) + shift,
        startTime: epochMs(leg.startTime as any) + shift
      } as Leg)
    })
    cursor = epochMs(legs[legs.length - 1].endTime as any)
    if (n < segments.length - 1) stopLegIndexes.push(legs.length - 1)
  })
  return {
    ...itineraryOf(segments[0], legs),
    stopLegIndexes
  }
}
