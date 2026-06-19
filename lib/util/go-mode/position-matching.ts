import { decode } from '@mapbox/polyline'
import type { LatLngArray, Leg } from '@opentripplanner/types'

/**
 * Calculate distance between two lat/lng points using Haversine formula
 * @returns distance in meters
 */
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000 // Earth's radius in meters
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δφ = ((lat2 - lat1) * Math.PI) / 180
  const Δλ = ((lon2 - lon1) * Math.PI) / 180

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return R * c
}

/**
 * Calculate perpendicular distance from point to line segment
 */
function perpendicularDistance(
  point: LatLngArray,
  lineStart: LatLngArray,
  lineEnd: LatLngArray
): number {
  const [px, py] = point
  const [x1, y1] = lineStart
  const [x2, y2] = lineEnd

  const A = px - x1
  const B = py - y1
  const C = x2 - x1
  const D = y2 - y1

  const dot = A * C + B * D
  const lenSq = C * C + D * D
  let param = -1

  if (lenSq !== 0) {
    param = dot / lenSq
  }

  let xx, yy

  if (param < 0) {
    xx = x1
    yy = y1
  } else if (param > 1) {
    xx = x2
    yy = y2
  } else {
    xx = x1 + param * C
    yy = y1 + param * D
  }

  return calculateDistance(px, py, xx, yy)
}

/**
 * Project point onto line segment and calculate distance along segment
 * @returns Object with distance along segment (0-1) and perpendicular distance
 */
function projectPointOntoSegment(
  point: LatLngArray,
  lineStart: LatLngArray,
  lineEnd: LatLngArray
): { alongSegment: number; perpDistance: number } {
  const [px, py] = point
  const [x1, y1] = lineStart
  const [x2, y2] = lineEnd

  const A = px - x1
  const B = py - y1
  const C = x2 - x1
  const D = y2 - y1

  const dot = A * C + B * D
  const lenSq = C * C + D * D

  let param = 0
  if (lenSq !== 0) {
    param = Math.max(0, Math.min(1, dot / lenSq))
  }

  const perpDistance = perpendicularDistance(point, lineStart, lineEnd)

  return {
    alongSegment: param,
    perpDistance
  }
}

/**
 * Decode a leg's polyline and return array of [lat, lng] coordinates
 */
export function decodeLegGeometry(leg: Leg): LatLngArray[] {
  if (!leg.legGeometry?.points) {
    return []
  }
  return decode(leg.legGeometry.points, 5) as LatLngArray[]
}

/**
 * Calculate cumulative distances along a polyline
 * @returns Array of cumulative distances in meters
 */
export function calculateCumulativeDistances(
  polyline: LatLngArray[]
): number[] {
  const distances: number[] = [0]
  let cumulative = 0

  for (let i = 1; i < polyline.length; i++) {
    const [lat1, lon1] = polyline[i - 1]
    const [lat2, lon2] = polyline[i]
    const segmentDistance = calculateDistance(lat1, lon1, lat2, lon2)
    cumulative += segmentDistance
    distances.push(cumulative)
  }

  return distances
}

export interface RouteMatchResult {
  distanceFromRoute: number
  // 0-1
  isOnRoute: boolean
  legIndex: number
  nearestPoint: LatLngArray
  progressAlongLeg: number
  // 0-1
  progressAlongSegment: number
  segmentIndex: number
}

/**
 * Match current position to the nearest point on the route
 */
export function matchPositionToRoute(
  currentPosition: LatLngArray,
  legs: Leg[],
  currentLegIndex = 0
): RouteMatchResult | null {
  let bestMatch: RouteMatchResult | null = null
  let minDistance = Infinity

  // Search current leg and next 2 legs for best match
  const legsToSearch = Math.min(3, legs.length - currentLegIndex)

  for (let legOffset = 0; legOffset < legsToSearch; legOffset++) {
    const legIndex = currentLegIndex + legOffset
    const leg = legs[legIndex]
    const polyline = decodeLegGeometry(leg)

    if (polyline.length < 2) continue

    const cumulativeDistances = calculateCumulativeDistances(polyline)
    const totalLegDistance = cumulativeDistances[cumulativeDistances.length - 1]

    for (let i = 0; i < polyline.length - 1; i++) {
      const start = polyline[i]
      const end = polyline[i + 1]

      const projection = projectPointOntoSegment(currentPosition, start, end)
      const perpDistance = projection.perpDistance

      if (perpDistance < minDistance) {
        minDistance = perpDistance

        // Calculate progress along this segment
        const segmentStartDistance = cumulativeDistances[i]
        const segmentEndDistance = cumulativeDistances[i + 1]
        const segmentLength = segmentEndDistance - segmentStartDistance
        const distanceAlongSegment = segmentLength * projection.alongSegment
        const totalDistanceAlongLeg =
          segmentStartDistance + distanceAlongSegment

        // Calculate nearest point on segment
        const [x1, y1] = start
        const [x2, y2] = end
        const t = projection.alongSegment
        const nearestPoint: LatLngArray = [
          x1 + t * (x2 - x1),
          y1 + t * (y2 - y1)
        ]

        // Use wider threshold for transit legs (sparser polylines)
        const isTransitLeg = leg.mode !== 'WALK' && leg.mode !== 'BICYCLE'
        const onRouteThreshold = isTransitLeg ? 250 : 100

        bestMatch = {
          distanceFromRoute: perpDistance,
          isOnRoute: perpDistance < onRouteThreshold,
          legIndex,
          nearestPoint,

          progressAlongLeg:
            totalLegDistance > 0 ? totalDistanceAlongLeg / totalLegDistance : 0,

          progressAlongSegment: projection.alongSegment,
          segmentIndex: i
        }
      }
    }
  }

  return bestMatch
}

/**
 * Check if user is near the end of current leg (for leg transition detection)
 */
export function isNearLegEnd(
  match: RouteMatchResult,
  threshold = 0.95
): boolean {
  return match.progressAlongLeg >= threshold
}

/**
 * Check if user has likely moved to next leg
 */
export function shouldTransitionToNextLeg(
  match: RouteMatchResult,
  currentLegIndex: number,
  legs: Leg[]
): boolean {
  if (match.legIndex > currentLegIndex) {
    return true
  }

  if (match.legIndex === currentLegIndex) {
    // Check if we're very close to the end and next leg exists
    if (isNearLegEnd(match, 0.98) && currentLegIndex < legs.length - 1) {
      return true
    }
  }

  return false
}
