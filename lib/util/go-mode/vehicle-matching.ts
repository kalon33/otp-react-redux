import { calculateDistance } from './position-matching'

// --- Types ---

export interface VehiclePosition {
  heading: number
  label: string
  lat: number
  lon: number
  nextStopId: string
  nextStopName: string
  patternId: string
  routeId?: string
  seconds: number // lastUpdated epoch seconds
  speed: number
  stopStatus: string
  tripHeadsign?: string
  tripId?: string
  vehicleId: string
}

export type MatchConfidence = 'none' | 'low' | 'medium' | 'high' | 'confirmed'

export interface VehicleMatchResult {
  confidence: MatchConfidence
  distanceMeters: number | null
  label: string | null
  lastSeen: number // epoch ms
  vehicleId: string | null
}

export interface NearbyVehicleOption {
  distanceMeters: number
  heading: number
  label: string
  nextStopId: string
  nextStopName: string
  routeId?: string
  speed: number
  tripHeadsign?: string
  tripId?: string
  vehicleId: string
}

// --- Functions ---

/**
 * Find vehicles within a given radius of the user, sorted by distance.
 */
export function findNearbyVehicles(
  userLat: number,
  userLon: number,
  vehicles: VehiclePosition[],
  maxDistanceMeters = 200
): NearbyVehicleOption[] {
  return vehicles
    .map((v) => ({
      distanceMeters: calculateDistance(userLat, userLon, v.lat, v.lon),
      heading: v.heading,
      label: v.label,
      nextStopId: v.nextStopId,
      nextStopName: v.nextStopName,
      routeId: v.routeId,
      speed: v.speed,
      tripHeadsign: v.tripHeadsign,
      tripId: v.tripId,
      vehicleId: v.vehicleId
    }))
    .filter((v) => v.distanceMeters <= maxDistanceMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
}

/**
 * Normalize a heading difference to [0, 180].
 */
function headingDifference(h1: number, h2: number): number {
  const diff = Math.abs(h1 - h2) % 360
  return diff > 180 ? 360 - diff : diff
}

/**
 * Attempt to match the user to a specific vehicle.
 *
 * Algorithm:
 * 1. Filter vehicles within 80m proximity
 * 2. Prefer vehicles on the expected route (patternId contains routeId)
 * 3. Use heading correlation as tiebreaker
 * 4. Boost confidence if same vehicle matched consecutively (via previousMatch)
 */
export function matchUserToVehicle(
  userLat: number,
  userLon: number,
  userHeading: number | null,
  vehicles: VehiclePosition[],
  expectedRouteId: string | null,
  previousMatch: VehicleMatchResult | null
): VehicleMatchResult {
  const noMatch: VehicleMatchResult = {
    confidence: 'none',
    distanceMeters: null,
    label: null,
    lastSeen: Date.now(),
    vehicleId: null
  }

  if (!vehicles || vehicles.length === 0) return noMatch

  // Phase 1: Proximity filter — 80m
  const nearby = vehicles
    .map((v) => ({
      distance: calculateDistance(userLat, userLon, v.lat, v.lon),
      vehicle: v
    }))
    .filter((v) => v.distance <= 80)
    .sort((a, b) => a.distance - b.distance)

  if (nearby.length === 0) return noMatch

  // Phase 2: Route filter — prefer vehicles on expected route
  let candidates = nearby
  if (expectedRouteId) {
    const onRoute = nearby.filter((v) =>
      v.vehicle.patternId?.includes(expectedRouteId)
    )
    if (onRoute.length > 0) {
      candidates = onRoute
    }
  }

  // Phase 3: Heading correlation — score each candidate
  const scored = candidates.map((c) => {
    let headingScore = 0
    if (userHeading != null && c.vehicle.heading != null) {
      const diff = headingDifference(userHeading, c.vehicle.heading)
      // 0 diff = 1.0, 45 diff = 0.5, 90+ diff = 0
      headingScore = Math.max(0, 1 - diff / 90)
    }
    return { ...c, headingScore }
  })

  // Sort by: route match already filtered, then distance, then heading
  scored.sort((a, b) => {
    // Prefer closer, then better heading
    const distDiff = a.distance - b.distance
    if (Math.abs(distDiff) > 10) return distDiff
    return b.headingScore - a.headingScore
  })

  const best = scored[0]
  const bestVehicle = best.vehicle

  // Phase 4: Continuity bonus
  const isContinuation =
    previousMatch?.vehicleId != null &&
    previousMatch.vehicleId === bestVehicle.vehicleId

  // Phase 5: Confidence scoring
  let confidence: MatchConfidence

  if (isContinuation) {
    // Consecutive match with same vehicle — high confidence
    confidence = 'high'
  } else if (scored.length === 1 && best.distance <= 50) {
    // Single candidate very close
    confidence = 'high'
  } else if (scored.length === 1) {
    // Single candidate within 80m
    confidence = 'medium'
  } else {
    // Multiple candidates — ambiguous
    const gap = scored[1].distance - best.distance
    if (gap > 30 && best.distance <= 50) {
      // Clear leader
      confidence = 'medium'
    } else {
      confidence = 'low'
    }
  }

  return {
    confidence,
    distanceMeters: Math.round(best.distance),
    label: bestVehicle.label,
    lastSeen: Date.now(),
    vehicleId: bestVehicle.vehicleId
  }
}

/**
 * Determine whether to show the boarding prompt to the user.
 */
export function shouldShowBoardingPrompt(
  match: VehicleMatchResult | null,
  transitLegEnteredAt: number | null,
  now: number,
  lastDismissedAt: number | null
): boolean {
  // Don't prompt if already confirmed or high confidence
  if (match?.confidence === 'confirmed' || match?.confidence === 'high') {
    return false
  }

  // Wait at least 30s after entering transit leg
  if (!transitLegEnteredAt || now - transitLegEnteredAt < 30000) {
    return false
  }

  // Don't re-show within 2 minutes of dismissal
  if (lastDismissedAt && now - lastDismissedAt < 120000) {
    return false
  }

  return true
}
