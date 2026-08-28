import { decode } from '@mapbox/polyline'
// Aliased: matchPositionToRoute below has its own local `isTransitLeg`, a
// mode-based guess used to widen the on-route threshold. The two are not
// equivalent and reconciling them is its own change, so keep the names apart.
import { isTransitLeg as legIsTransit } from '@opentripplanner/core-utils/lib/itinerary'
import type { LatLngArray, Leg } from '@opentripplanner/types'

/**
 * Calculate distance between two lat/lng points using Haversine formula
 * @returns distance in meters
 *
 * A non-finite coordinate yields Infinity, not a number. Before 8/2 a null
 * coerced to 0 and the haversine happily returned 10,267,729m — the distance
 * from Minneapolis to null island — which read as a real (if absurd) position
 * rather than as missing data. Infinity specifically, NOT NaN: every caller
 * compares with `<` or `<=`, and NaN would silently flip all of them to false.
 * Infinity makes a coordinateless vehicle lose every comparison, which is the
 * intent.
 */
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  ) {
    return Infinity
  }
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
export function projectPointOntoSegment(
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
export const BACKWARD_JUMP_HYSTERESIS_M = 5

// These corridors answer "is this match usable", nothing more. Transit shapes
// are sparse enough that a rider genuinely aboard can project 200m+ from the
// polyline, so the corridor must stay wide — but that makes isOnRoute far too
// weak to mean "plausibly aboard this vehicle". Anything deciding aboard-ness
// or off-route-ness needs its own, tighter figure (see riding.ts and
// checkRouteDeviation), derived from or reconciled with these so the matcher
// and its consumers can never disagree about the same metre.
export const MATCH_CORRIDOR_TRANSIT_M = 250
export const MATCH_CORRIDOR_ACTIVE_M = 100

export function matchPositionToRoute(
  currentPosition: LatLngArray,
  legs: Leg[],
  currentLegIndex = 0,
  /**
   * Last tick's match, used only to break sub-metre ties on a shape that
   * doubles back on itself. Optional: without it the behaviour is exactly the
   * old global-minimum search.
   */
  previousMatch?: RouteMatchResult | null
): RouteMatchResult | null {
  let bestMatch: RouteMatchResult | null = null
  let minDistance = Infinity
  // The best candidate ignoring hysteresis. If the backward-jump rule ends up
  // rejecting everything — a rider who really has doubled back — this is what
  // is returned, so the rule can only ever REORDER preferences and never turn a
  // match into a null. A null here reads to callers as "no geometry" and is a
  // far worse answer than a backward jump.
  let fallbackMatch: RouteMatchResult | null = null
  let fallbackDistance = Infinity

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
        const onRouteThreshold = isTransitLeg
          ? MATCH_CORRIDOR_TRANSIT_M
          : MATCH_CORRIDOR_ACTIVE_M

        const progressAlongLeg =
          totalLegDistance > 0 ? totalDistanceAlongLeg / totalLegDistance : 0

        // Where a shape doubles back on itself — the 465's downtown loop on 2
        // Av S — two candidate segments sit SUB-METRE apart and the strict
        // global minimum alternates between them tick to tick. Progress then
        // jumps backward by the length of the loop, and the stop counter
        // un-passes a stop the rider has already gone by (13:36:16, :24, :25,
        // :27 on 2026-08-27 — four flips in thirty seconds).
        //
        // So when the winning candidate would move the rider BACKWARD along the
        // same leg, and the position we already hold is within a few metres of
        // it, keep what we have. This only ever breaks near-ties: a candidate
        // that is genuinely closer by more than the hysteresis still wins, so a
        // real correction is never blocked.
        const wouldJumpBackward =
          previousMatch != null &&
          previousMatch.legIndex === legIndex &&
          progressAlongLeg < previousMatch.progressAlongLeg &&
          Math.abs(previousMatch.distanceFromRoute - perpDistance) <=
            BACKWARD_JUMP_HYSTERESIS_M
        const candidate: RouteMatchResult = {
          distanceFromRoute: perpDistance,
          isOnRoute: perpDistance < onRouteThreshold,
          legIndex,
          nearestPoint,
          progressAlongLeg,
          progressAlongSegment: projection.alongSegment,
          segmentIndex: i
        }

        if (perpDistance < fallbackDistance) {
          fallbackDistance = perpDistance
          fallbackMatch = candidate
        }
        if (wouldJumpBackward) continue
        minDistance = perpDistance
        bestMatch = candidate
      }
    }
  }

  return bestMatch ?? fallbackMatch
}

/**
 * Check if the rider has moved on to a later leg.
 *
 * The only evidence taken is the match itself: their position is now nearest to
 * a leg further along the itinerary. Being near the *end* of the current leg is
 * deliberately not enough — waiting at a boarding stop parks you at ~100% of the
 * access leg for as long as the bus takes to arrive, which would advance a rider
 * standing on the curb onto the bus. (Matching only ever searches forward, so
 * that advance is unrecoverable.) Actual boarding is established by the riding
 * state, which wants a vehicle match or real progress along the transit leg.
 *
 * Index order alone is still not enough, because an access leg and the transit
 * leg that follows it SHARE an endpoint: a rider waiting at the boarding stop
 * sits on both polylines at once, so the matcher can honestly return the
 * transit leg while the bus is still hours away. On 2026-08-27 Go Mode started
 * on a trip whose 465 boarded at 20:17Z, and 82ms later — at 18:19Z, with the
 * rider standing at the stop — advanced onto that leg and pushed "Walk to 6th
 * St S & 2nd Ave", a stop 17km away. Since matching only ever searches forward,
 * that advance is unrecoverable without a re-plan.
 *
 * So a transit leg additionally has to be plausibly boardable: the rider is
 * already riding it, or its board time is at hand.
 */
export const TRANSIT_BOARD_EARLY_MS = 5 * 60 * 1000

export type TransitionGate = {
  /** Live board epoch for the target leg, when one is known. */
  boardEpoch?: number | null
  /** True when the riding state already places the rider on the target leg. */
  isRiding?: boolean
  nowMs?: number
  /** The leg the match wants to move to — itinerary.legs[match.legIndex]. */
  targetLeg?: Leg
}
export function shouldTransitionToNextLeg(
  match: RouteMatchResult,
  currentLegIndex: number,
  gate?: TransitionGate
): boolean {
  if (match.legIndex <= currentLegIndex) return false
  if (!gate) return true

  const { boardEpoch, isRiding, nowMs, targetLeg } = gate

  // Aboard is aboard: the riding state is the stronger fact and outranks the
  // clock, which is what lets a rider who caught an earlier run move on.
  if (isRiding) return true

  // Callers that supply no clock or no leg keep the old index-order behaviour.
  if (!targetLeg || nowMs == null) return true
  if (!legIsTransit(targetLeg)) return true

  // Prefer the live board time; a bus running late should not pull the rider
  // onto its leg on the strength of the plan alone.
  const board = Number(boardEpoch ?? targetLeg.startTime)
  if (!Number.isFinite(board)) return true

  return nowMs >= board - TRANSIT_BOARD_EARLY_MS
}
