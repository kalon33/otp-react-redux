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

/**
 * ─── Where on a trip's shape is a point? (backlog 64.1) ─────────────────────
 *
 * The onboard Confirm needs two answers about the rider and the bus's run: how
 * far past the chosen get-off stop the rider's fix already is, and which stop
 * is the first one still ahead of them. Both are questions about position
 * ALONG the run, so they are asked of the trip's own shape, not of straight
 * lines between stops.
 *
 * And always searching FORWARD from an anchor — never a global nearest point.
 * Routes loop back on themselves (the 539 loops past Old Shakopee & 86th
 * before its 98th St stop; downtown couplets run the same street twice), so
 * the closest vertex anywhere on the shape can be the other pass, and a rider
 * read onto the wrong pass is "past" a stop they have not reached. The rule is
 * the one buildOnboardItinerary's own slice has always used: each point is
 * looked for from where the previous one was found.
 */

/** A point's position along a polyline. */
export interface ShapePosition {
  /** Metres along the shape from its first vertex to the projection. */
  alongM: number
  /** Metres from the point to the shape (perpendicular, or to a vertex). */
  offM: number
  /** Index of the segment's first vertex — the next search starts here. */
  segmentIndex: number
}

/** Decode a trip's encoded shape; null when it has none or it will not parse. */
export function decodeTripShape(trip: any): Array<[number, number]> | null {
  const points = trip?.geometry?.points
  if (!points) return null
  try {
    const decoded = polyline.decode(points) as Array<[number, number]>
    return decoded.length ? decoded : null
  } catch {
    return null
  }
}

/** Within this, the shape passes "by" the point — see projectForwardOnShape. */
export const SHAPE_NEAR_M = 60

/**
 * Project `point` onto `shape` (decoded [lat, lon] vertices), looking only
 * forward of `from` — a vertex index, or a position already found on the shape
 * (then nothing behind that position, even on its own segment, is considered).
 * The FIRST stretch of the shape that passes within `nearM` of the point wins
 * — its closest projection — so a later pass of a loop cannot steal the answer
 * even when it happens to run closer. When no stretch comes within `nearM`,
 * the nearest projection ahead is the answer (a sparse shape, a poor fix).
 * Null when there is nothing to project onto.
 */
export function projectForwardOnShape(
  shape: Array<[number, number]> | null | undefined,
  point: [number, number] | null | undefined,
  from: number | ShapePosition = 0,
  nearM: number = SHAPE_NEAR_M
): ShapePosition | null {
  if (!shape || !point || shape.length === 0) return null
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null
  const fromIndex = typeof from === 'number' ? from : from.segmentIndex
  const floorAlongM = typeof from === 'number' ? -Infinity : from.alongM
  const start = Math.max(0, Math.min(fromIndex, shape.length - 1))
  if (shape.length === 1 || start === shape.length - 1) {
    const offM = haversineDistance(shape[start], point)
    let alongM = 0
    for (let i = 0; i < start; i++) {
      alongM += haversineDistance(shape[i], shape[i + 1])
    }
    return { alongM, offM, segmentIndex: start }
  }
  // Metres along the shape to vertex `start`.
  let alongToVertex = 0
  for (let i = 0; i < start; i++) {
    alongToVertex += haversineDistance(shape[i], shape[i + 1])
  }
  let best: ShapePosition | null = null
  let firstNear: ShapePosition | null = null
  let inNearRun = false
  const cosLat = Math.cos((point[0] * Math.PI) / 180)
  for (let i = start; i < shape.length - 1; i++) {
    const a = shape[i]
    const b = shape[i + 1]
    const segM = haversineDistance(a, b)
    // Local equirectangular frame around the point: ample at stop spacing.
    const ax = (a[1] - point[1]) * cosLat
    const ay = a[0] - point[0]
    const bx = (b[1] - point[1]) * cosLat
    const by = b[0] - point[0]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    // Never behind where the search started from (`from` as a position).
    const tMin =
      segM > 0 && floorAlongM > alongToVertex
        ? Math.min(1, (floorAlongM - alongToVertex) / segM)
        : 0
    const t =
      len2 > 0 ? Math.max(tMin, Math.min(1, -(ax * dx + ay * dy) / len2)) : tMin
    const proj: [number, number] = [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t
    ]
    const pos: ShapePosition = {
      alongM: alongToVertex + segM * t,
      offM: haversineDistance(proj, point),
      segmentIndex: i
    }
    if (!best || pos.offM < best.offM) best = pos
    if (pos.offM <= nearM) {
      if (!firstNear || pos.offM < firstNear.offM) firstNear = pos
      inNearRun = true
    } else if (inNearRun) {
      // The first pass by the point is over; whatever comes later is another.
      break
    }
    alongToVertex += segM
  }
  return firstNear || best
}

interface StopLike {
  id?: string | null
  lat?: number | null
  lon?: number | null
}

/**
 * Each stop's position along the shape, in run order, each one searched for
 * from where the stop before it was found (null where a stop has no
 * coordinates; later stops then search from the last one placed).
 */
export function stopPositionsOnShape(
  shape: Array<[number, number]> | null | undefined,
  stops: Array<StopLike | null | undefined>
): Array<ShapePosition | null> {
  let from: number | ShapePosition = 0
  return stops.map((stop) => {
    if (stop?.lat == null || stop?.lon == null) return null
    const pos = projectForwardOnShape(shape, [stop.lat, stop.lon], from)
    if (pos) from = pos
    return pos
  })
}

/**
 * How many metres along the run `point` is PAST `stops[stopIndex]` — negative
 * while the stop is still ahead. The stops are placed in run order, each
 * forward of the one before (stopPositionsOnShape), so a stop on the return
 * pass of a loop is found on the return pass even where the outbound street
 * runs beside it; the point is looked for forward of `stops[anchorIndex]`
 * (where the ride is known to be — the leg's boarding stop). Null when the
 * shape, the point or either stop cannot be placed.
 */
export function metersPastOnShape(
  shape: Array<[number, number]> | null | undefined,
  input: {
    anchorIndex: number
    point: [number, number] | null | undefined
    stopIndex: number
    stops: Array<StopLike | null | undefined>
  }
): number | null {
  const { anchorIndex, point, stopIndex, stops } = input
  if (!shape?.length || !point || !stops?.length) return null
  const positions = stopPositionsOnShape(shape, stops)
  const anchorPos = positions[anchorIndex] ?? null
  const stopPos = positions[stopIndex] ?? null
  if (!stopPos) return null
  const pointPos = projectForwardOnShape(shape, point, anchorPos ?? 0)
  if (!pointPos) return null
  return pointPos.alongM - stopPos.alongM
}

/**
 * Index (into `stops`) of the first stop at or after `fromStopIndex` that is
 * still ahead of `point` along the run. A stop up to `atStopM` behind the
 * point still counts as ahead — a bus dwelling at its stop, a fix a few metres
 * long — so the rider standing at a stop is not told it is behind them. Null
 * when nothing is ahead (end of the run) or nothing can be placed.
 */
export function firstStopAheadOnShape(
  shape: Array<[number, number]> | null | undefined,
  stops: Array<StopLike | null | undefined>,
  point: [number, number] | null | undefined,
  options: { atStopM?: number; fromStopIndex?: number } = {}
): number | null {
  if (!shape?.length || !point || !stops?.length) return null
  const atStopM = options.atStopM ?? 30
  const fromStopIndex = Math.max(0, options.fromStopIndex ?? 0)
  const positions = stopPositionsOnShape(shape, stops)
  const anchor = positions
    .slice(0, fromStopIndex + 1)
    .reverse()
    .find((p) => p != null)
  const pointPos = projectForwardOnShape(shape, point, anchor ?? 0)
  if (!pointPos) return null
  for (let i = fromStopIndex; i < stops.length; i++) {
    const pos = positions[i]
    if (pos && pos.alongM >= pointPos.alongM - atStopM) return i
  }
  return null
}

/**
 * How close the shape comes to `point` BEHIND and AHEAD of a position along it
 * (`splitAlongM`, metres from the first vertex) — the two closest approaches,
 * each searched over its own half of the shape only. Null for a half the
 * shape does not have (the split at either end). Backlog 63.1: an added stop
 * the bus has left behind is one the run came nearer to before the rider's
 * position than it will after it.
 */
export function closestApproachEitherSide(
  shape: Array<[number, number]> | null | undefined,
  point: [number, number] | null | undefined,
  splitAlongM: number
): { aheadM: number | null; behindM: number | null } | null {
  if (!shape?.length || !point) return null
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null
  if (!Number.isFinite(splitAlongM)) return null
  if (shape.length === 1) {
    const d = haversineDistance(shape[0], point)
    return { aheadM: d, behindM: d }
  }
  const cosLat = Math.cos((point[0] * Math.PI) / 180)
  let aheadM: number | null = null
  let behindM: number | null = null
  let alongToVertex = 0
  const at = (a: [number, number], b: [number, number], t: number) =>
    haversineDistance(
      [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      point
    )
  for (let i = 0; i < shape.length - 1; i++) {
    const a = shape[i]
    const b = shape[i + 1]
    const segM = haversineDistance(a, b)
    const ax = (a[1] - point[1]) * cosLat
    const ay = a[0] - point[0]
    const dx = (b[1] - point[1]) * cosLat - ax
    const dy = b[0] - point[0] - ay
    const len2 = dx * dx + dy * dy
    // Closest point of the whole segment; within a sub-range of it the
    // closest is that point clamped into the range (distance is convex in t).
    const tStar =
      len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0
    // Where the split falls on this segment, as t (may be outside [0, 1]).
    const tSplit =
      segM > 0
        ? (splitAlongM - alongToVertex) / segM
        : splitAlongM >= alongToVertex
        ? 1
        : 0
    if (tSplit > 0) {
      const hi = Math.min(1, tSplit)
      const d = at(a, b, Math.min(tStar, hi))
      if (behindM == null || d < behindM) behindM = d
    }
    if (tSplit < 1) {
      const lo = Math.max(0, tSplit)
      const d = at(a, b, Math.max(tStar, lo))
      if (aheadM == null || d < aheadM) aheadM = d
    }
    alongToVertex += segM
  }
  return { aheadM, behindM }
}
