import { calculateDistance } from './position-matching'

/**
 * Consecutive empty vehicle-position polls (15s apart) after which we stop
 * saying "Locating your bus…" and admit the route has no live vehicle data.
 * Six polls ≈ 90s — long enough to ride out a slow first fetch or a brief
 * feed hiccup, short enough that a rider isn't left staring at a spinner.
 */
export const NO_LIVE_VEHICLE_POLLS = 6

// --- Types ---

export interface VehiclePosition {
  /** NB/SB/EB/WB, from the onboard API's trips table. */
  direction?: string | null
  heading: number
  label: string
  lat: number
  lon: number
  nextStopId: string
  nextStopName: string
  patternId: string
  /** Route badge colors, attached by the caller from the nearby-routes
   * lookup — the vehicle feed itself carries no route styling. */
  routeColor?: string | null
  routeId?: string
  /** The rider-facing route identity ("18", "METRO Orange Line"). */
  routeName?: string | null
  routeTextColor?: string | null
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
  nextStopId?: string | null
  /** GTFS ids of the matched run, when known — lets flows that trust a
   * confirmed match (onboard silent path) act without re-asking. */
  routeId?: string | null
  tripHeadsign?: string | null
  tripId?: string | null
  vehicleId: string | null
}

export interface NearbyVehicleOption {
  direction?: string | null
  distanceMeters: number
  heading: number
  label: string
  nextStopId: string
  nextStopName: string
  routeColor?: string | null
  routeId?: string
  routeName?: string | null
  routeTextColor?: string | null
  speed: number
  tripHeadsign?: string
  tripId?: string
  vehicleId: string
}

// --- Functions ---

/**
 * Does this feed record actually say where the vehicle is?
 *
 * Metro Transit publishes a second record for the same vehicleId covering the
 * bus's NEXT block trip, with `lat: 0, lon: 0` and no next stop — on 8/2 the
 * ghost for 1:8223 (trip 1:1191630, "Orange Burnsville") sat alongside the
 * live record (1:1201789, "Orange Downtown Minneapolis") and, being first in
 * the array, won every `.find()` by vehicleId. Null island is not a position:
 * a record without usable coordinates is useless to every consumer, so it
 * never enters the store.
 */
export function hasUsablePosition(
  vehicle: { lat?: number | null; lon?: number | null } | null | undefined
): boolean {
  return !!vehicle && !!vehicle.lat && !!vehicle.lon
}

// How stale a GTFS-RT vehicle position is assumed to be, worst case. Feeds are
// polled every 10-30s and carry their own reporting latency; a rider moving at
// speed v can legitimately be up to v * LAG ahead of "their" vehicle's last
// reported position.
const FEED_LAG_SECONDS = 45
// Never widen past this — beyond it "nearby" stops meaning anything.
const MAX_ADJUSTED_RADIUS_METERS = 2500

// Reject only clearly OPPOSITE vehicles: 120° absorbs GPS heading noise where
// 90° would clip merges and curves. On 7/29 the northbound Orange Line across
// I-35W (heading ~0° vs the rider's 179°) hijacked the match because heading
// was only a ±10m tiebreaker; direction alone should have ruled it out.
export const OPPOSING_HEADING_MIN_DEG = 120
// Headings are junk when stationary — the direction gate applies only while
// BOTH the rider and the vehicle are actually moving.
export const MIN_SPEED_FOR_HEADING_MPS = 3
// A challenger must beat the incumbent vehicle's distance by this margin to
// displace it. Small against the 845m+ speed-widened radius; decisive against
// the 7/29 flap, where the wrong bus won by 5m of stale feed distance.
export const INCUMBENT_SWITCH_MARGIN_M = 150

/**
 * Widen a proximity radius by how far the rider outruns the realtime feed. A
 * stationary rider keeps the tight base radius; on a moving bus (e.g. freeway
 * BRT at ~27 m/s) the radius grows so the lagging vehicle position still
 * matches. Speed comes from the GPS fix and may be null/NaN → base radius.
 */
export function speedAdjustedRadius(
  baseMeters: number,
  speedMps: number | null | undefined
): number {
  const v = typeof speedMps === 'number' && speedMps > 0 ? speedMps : 0
  return Math.min(baseMeters + v * FEED_LAG_SECONDS, MAX_ADJUSTED_RADIUS_METERS)
}

/**
 * A rider-facing vehicle label. Fallback paths use the GTFS vehicle id, which
 * is feed-scoped ("1:8148") — the "1:" means nothing to a rider, so drop it.
 */
export function displayVehicleLabel(label: string | null | undefined): string {
  return (label ?? '').replace(/^[^:\s]+:/, '')
}

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
      direction: v.direction,
      distanceMeters: calculateDistance(userLat, userLon, v.lat, v.lon),
      heading: v.heading,
      label: v.label,
      nextStopId: v.nextStopId,
      nextStopName: v.nextStopName,
      routeColor: v.routeColor,
      routeId: v.routeId,
      routeName: v.routeName,
      routeTextColor: v.routeTextColor,
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
 * 1. Filter vehicles within `proximityMeters` (default 80m; callers widen it
 *    via speedAdjustedRadius when the rider is moving — see feed-lag note)
 * 2. Drop clearly opposite-direction vehicles (both parties moving)
 * 3. Prefer vehicles on the expected route (patternId contains routeId)
 * 4. Use heading correlation as tiebreaker
 * 5. Keep the incumbent match unless a challenger clearly beats it
 * 6. Boost confidence if same vehicle matched consecutively (via previousMatch)
 */
export function matchUserToVehicle(
  userLat: number,
  userLon: number,
  userHeading: number | null,
  vehicles: VehiclePosition[],
  expectedRouteId: string | null,
  previousMatch: VehicleMatchResult | null,
  proximityMeters = 80,
  userSpeedMps: number | null = null
): VehicleMatchResult {
  const noMatch: VehicleMatchResult = {
    confidence: 'none',
    distanceMeters: null,
    label: null,
    lastSeen: Date.now(),
    vehicleId: null
  }

  if (!vehicles || vehicles.length === 0) return noMatch

  // Phase 1: Proximity filter
  let nearby = vehicles
    .map((v) => ({
      distance: calculateDistance(userLat, userLon, v.lat, v.lon),
      vehicle: v
    }))
    .filter((v) => v.distance <= proximityMeters)
    .sort((a, b) => a.distance - b.distance)

  if (nearby.length === 0) return noMatch

  // Phase 2: Direction gate — a vehicle heading clearly the OPPOSITE way
  // cannot be the rider's, however close the stale feed says it is (7/29:
  // rider southbound at 17.4 m/s, the northbound run across the freeway won
  // the match by 5m). Only judged while both sides are moving fast enough for
  // headings to mean anything; when the gate empties the list, no match beats
  // binding the rider to a bus going the other way.
  if (
    userHeading != null &&
    userSpeedMps != null &&
    userSpeedMps > MIN_SPEED_FOR_HEADING_MPS
  ) {
    nearby = nearby.filter(
      (c) =>
        !(
          c.vehicle.heading != null &&
          c.vehicle.speed != null &&
          c.vehicle.speed > MIN_SPEED_FOR_HEADING_MPS &&
          headingDifference(userHeading, c.vehicle.heading) >
            OPPOSING_HEADING_MIN_DEG
        )
    )
    if (nearby.length === 0) return noMatch
  }

  // Phase 3: Route filter — prefer vehicles on expected route
  let candidates = nearby
  if (expectedRouteId) {
    const onRoute = nearby.filter((v) =>
      v.vehicle.patternId?.includes(expectedRouteId)
    )
    if (onRoute.length > 0) {
      candidates = onRoute
    }
  }

  // Phase 4: Heading correlation — score each candidate
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

  // Phase 5: Incumbent stickiness — feed-position distances jitter by far
  // more than a few meters (the bus outruns its own record), so the vehicle
  // already matched keeps the match unless a challenger CLEARLY beats it. On
  // 7/29 the flap was 847m vs 852m; a 5m edge is noise, not a new bus.
  let best = scored[0]
  if (
    previousMatch?.vehicleId != null &&
    best.vehicle.vehicleId !== previousMatch.vehicleId
  ) {
    const incumbent = scored.find(
      (c) => c.vehicle.vehicleId === previousMatch.vehicleId
    )
    if (
      incumbent &&
      best.distance >= incumbent.distance - INCUMBENT_SWITCH_MARGIN_M
    ) {
      best = incumbent
    }
  }
  const bestVehicle = best.vehicle

  // Phase 6: Continuity bonus
  const isContinuation =
    previousMatch?.vehicleId != null &&
    previousMatch.vehicleId === bestVehicle.vehicleId

  // Phase 7: Confidence scoring
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
    nextStopId: bestVehicle.nextStopId ?? null,
    routeId: bestVehicle.routeId ?? null,
    tripHeadsign: bestVehicle.tripHeadsign ?? null,
    // The matched run's identity travels with the match: the boarded-earlier
    // trigger and the riding fact compare it against the PLANNED leg's trip
    // to detect that the rider caught a different bus on the same route.
    tripId: bestVehicle.tripId ?? null,
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
