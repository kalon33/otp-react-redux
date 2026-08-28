/**
 * Pure geometry for Go Mode's GPS simulation and track replay: distances along
 * a leg's polyline, and the timed point streams a simulated rider is played
 * through. Extracted verbatim from actions/go-mode.ts, where 190 lines of
 * trigonometry sat among the thunks.
 *
 * Nothing here reads redux, dispatches, or reads a clock — which is the point:
 * it can be exercised directly from jest.
 */
import polyline from '@mapbox/polyline'
import type { Itinerary, Leg } from '@opentripplanner/types'

import { epochMs } from './time'

/** A single point in a simulated GPS track. */
export interface TimedSimulationPoint {
  // ms before advancing to next point (at 1x speed)
  // Optional recorded fix metadata (trip replay only). When present these are
  // played back verbatim so vehicle-matching heading/speed logic sees the real
  // values instead of the synthetic defaults used for itinerary-derived sims.
  accuracy?: number | null
  coord: [number, number]
  delayMs: number
  heading?: number | null
  speed?: number | null
}

/**
 * Haversine distance in meters between two [lat, lng] points.
 */
export function haversineDistance(
  a: [number, number],
  b: [number, number]
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const R = 6371000
  const dLat = toRad(b[0] - a[0])
  const dLon = toRad(b[1] - a[1])
  const sinLat = Math.sin(dLat / 2)
  const sinLon = Math.sin(dLon / 2)
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * sinLon * sinLon
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * Find the index of the polyline point closest to a given [lat, lng],
 * searching from startIdx onward.
 */
export function findClosestPolylineIndex(
  decoded: Array<[number, number]>,
  lat: number,
  lon: number,
  startIdx: number
): number {
  let bestIdx = startIdx
  let bestDist = Infinity
  for (let i = startIdx; i < decoded.length; i++) {
    const d = haversineDistance(decoded[i], [lat, lon])
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return bestIdx
}

/**
 * Slice a trip's full shape down to the stretch one leg actually rides —
 * between the leg's board and alight stops — and re-encode it. Returns null
 * when the shape or the slice is unusable, so a caller can only ever improve a
 * leg's geometry, never degrade it. Used to repair a leg whose plan geometry
 * is missing (see geometry-trust.ts); buildOnboardItinerary performs the same
 * slice inline for the itinerary it synthesizes.
 */
export function sliceTripGeometryForLeg(
  tripShapePoints: string,
  leg: Leg
): { length: number; points: string } | null {
  const from: any = (leg as any).from
  const to: any = (leg as any).to
  if (
    from?.lat == null ||
    from?.lon == null ||
    to?.lat == null ||
    to?.lon == null
  ) {
    return null
  }
  let decoded: Array<[number, number]>
  try {
    decoded = polyline.decode(tripShapePoints) as Array<[number, number]>
  } catch {
    return null
  }
  if (decoded.length < 2) return null
  const startIdx = findClosestPolylineIndex(decoded, from.lat, from.lon, 0)
  const endIdx = findClosestPolylineIndex(decoded, to.lat, to.lon, startIdx)
  const slice = decoded.slice(startIdx, endIdx + 1)
  if (slice.length < 2) return null
  return { length: slice.length, points: polyline.encode(slice) }
}

interface IntermediatePlace {
  arrivalTime: number
  departureTime: number
  lat: number
  lon: number
  name: string
  stop?: { code: string; gtfsId: string; id: string }
}

/**
 * Build timed simulation points for a transit leg using stop schedule data.
 * Each polyline segment between stops gets timing derived from the timetable.
 */
export function buildTransitTimedPoints(
  leg: Leg,
  decoded: Array<[number, number]>,
  places: IntermediatePlace[]
): TimedSimulationPoint[] {
  const points: TimedSimulationPoint[] = []

  // Build stop sequence: leg origin, intermediate places, leg destination
  const stops: Array<{
    arrivalTime: number
    departureTime: number
    lat: number
    lon: number
    name: string
  }> = []

  // Origin
  const legFrom = (leg as any).from
  stops.push({
    // `number | string` on the wire — see time.ts / HANDOFF trap #5.
    arrivalTime: epochMs(leg.startTime),
    departureTime: epochMs(leg.startTime),
    lat: legFrom?.lat ?? decoded[0][0],
    lon: legFrom?.lon ?? decoded[0][1],
    name: legFrom?.name ?? 'Origin'
  })

  // Intermediate places
  for (const p of places) {
    stops.push({
      arrivalTime: p.arrivalTime,
      departureTime: p.departureTime,
      lat: p.lat,
      lon: p.lon,
      name: p.name
    })
  }

  // Destination
  const legTo = (leg as any).to
  stops.push({
    arrivalTime: epochMs(leg.endTime),
    departureTime: epochMs(leg.endTime),
    lat: legTo?.lat ?? decoded[decoded.length - 1][0],
    lon: legTo?.lon ?? decoded[decoded.length - 1][1],
    name: legTo?.name ?? 'Destination'
  })

  // Map each stop to its nearest polyline index
  const stopPolyIndices: number[] = []
  let searchFrom = 0
  for (const stop of stops) {
    const idx = findClosestPolylineIndex(
      decoded,
      stop.lat,
      stop.lon,
      searchFrom
    )
    stopPolyIndices.push(idx)
    searchFrom = idx
  }

  // Build timed points for each segment between consecutive stops
  for (let s = 0; s < stops.length - 1; s++) {
    const fromIdx = stopPolyIndices[s]
    const toIdx = stopPolyIndices[s + 1]
    const travelTimeMs = stops[s + 1].arrivalTime - stops[s].departureTime
    const segmentPointCount = Math.max(1, toIdx - fromIdx)
    const delayPerPoint = Math.max(50, travelTimeMs / segmentPointCount)

    // Add travel points for this segment
    const endIdx = s < stops.length - 2 ? toIdx : toIdx + 1 // include final point on last segment
    for (let i = fromIdx; i < endIdx && i < decoded.length; i++) {
      // Skip duplicate of previous segment's last point
      if (s > 0 && i === fromIdx) continue
      points.push({ coord: decoded[i], delayMs: delayPerPoint })
    }

    // Add dwell time at the arrival stop (except for the final destination)
    if (s < stops.length - 2) {
      const dwellMs = stops[s + 1].departureTime - stops[s + 1].arrivalTime
      if (dwellMs > 0) {
        // Add a dwell point at the stop location
        points.push({ coord: decoded[toIdx], delayMs: dwellMs })
      }
    }
  }

  // Handle edge case: if no points were generated, fall back to even distribution
  if (points.length === 0) {
    const delayMs = (leg.duration * 1000) / decoded.length
    for (const coord of decoded) {
      points.push({ coord, delayMs: Math.max(50, delayMs) })
    }
  }

  console.info(
    `[Go Mode] Transit leg "${stops[0].name}" → "${
      stops[stops.length - 1].name
    }": ` +
      `${stops.length} stops, ${points.length} simulation points, ` +
      `${Math.round((leg.duration * 1000) / 1000)}s scheduled duration`
  )

  return points
}

/**
 * Extract timed simulation points from an itinerary.
 * Transit legs with intermediatePlaces use schedule-aware timing.
 * Walk/bike legs use even time distribution.
 */
export function extractItineraryTimedPoints(
  itinerary: Itinerary
): TimedSimulationPoint[] {
  const points: TimedSimulationPoint[] = []
  for (const leg of itinerary.legs) {
    if (!leg.legGeometry?.points) continue
    try {
      const decoded = polyline.decode(leg.legGeometry.points)
      if (decoded.length === 0) continue

      const places = (leg as any).intermediatePlaces as
        | IntermediatePlace[]
        | undefined
      if (leg.transitLeg && places && places.length > 0) {
        points.push(...buildTransitTimedPoints(leg, decoded, places))
      } else {
        // Non-transit or no schedule data: even distribution
        const delayMs = Math.max(50, (leg.duration * 1000) / decoded.length)
        for (const coord of decoded) {
          points.push({ coord, delayMs })
        }
      }
    } catch {
      // Skip legs with invalid geometry
    }
  }
  return points
}
