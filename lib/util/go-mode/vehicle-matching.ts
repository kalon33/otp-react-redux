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
  /** GTFS direction_id of the vehicle's current trip (0/1). Unlike `heading`
   * this is meaningful at a standstill, which is exactly when a rider waiting
   * at a stop needs the wrong-direction run excluded. */
  directionId?: number | string | null
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
  /** Carried through from the matched VehiclePosition so a later refresh can
   * notice the vehicle rolling onto a trip going the other way. */
  directionId?: number | string | null
  distanceMeters: number | null
  label: string | null
  lastSeen: number // epoch ms
  nextStopId?: string | null
  /** GTFS ids of the matched run, when known — lets flows that trust a
   * confirmed match (onboard silent path) act without re-asking. */
  routeId?: string | null
  /**
   * The matched record's GTFS-RT `current_status` — `STOPPED_AT`,
   * `IN_TRANSIT_TO`, `INCOMING_AT`. Carried through because `nextStopId`
   * alone cannot tell a bus approaching the rider's stop from one standing at
   * it with its doors open: Metro Transit keeps naming the CURRENT stop as
   * `nextStopId` for the whole dwell (6.38). It is on `VehiclePosition`
   * already; nothing downstream could see it until now.
   */
  stopStatus?: string | null
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
 * Top speed a transit vehicle is assumed capable of. Orange Line runs on
 * I-35W touch 28-29 m/s in this feed; 30 is the ceiling used to bound how far
 * a vehicle can have travelled since its last frame.
 */
export const MAX_TRANSIT_SPEED_MPS = 30

/**
 * Feed frames older than this are not projected at all. Beyond a couple of
 * minutes a constant-heading extrapolation is fiction — the bus has had time to
 * turn, terminate, or finish its trip — and the honest answer is the frame
 * where it lies plus the old rider-speed allowance.
 */
export const MAX_CORRECTABLE_FRAME_AGE_SECONDS = 120

/**
 * Lateral allowance, as a fraction of the corridor's length, for the frame's
 * heading being wrong. Measured on the 2026-09-15 recording, `heading` sits a
 * median 2° off the actual bearing between consecutive frames while the
 * vehicle moves (p90 30°, the tail being turns). 0.2 — about 11.5° — is where
 * the tracked share on that ride stops improving: 0.10 gives 92.8 %, 0.15
 * 93.4 %, 0.20 and 0.25 both 93.9 %. Taking the knee rather than the widest
 * value keeps a long corridor from smearing into a disc, which is the one
 * thing this shape exists to avoid.
 */
const CORRIDOR_LATERAL_SLACK = 0.2

export interface AgedVehiclePosition {
  /** Seconds of feed age actually applied; 0 when the frame was not aged. */
  ageSeconds: number
  /** End of the corridor the vehicle may have travelled along; = lat/lon when
   * the frame could not be aged. */
  corridorLat: number
  corridorLon: number
  /** Length of that corridor in metres; 0 when the frame could not be aged. */
  corridorMeters: number
  /** Best estimate of where the vehicle is NOW. */
  lat: number
  lon: number
  /** Metres the best-estimate point was moved along the frame's heading. */
  projectedMeters: number
}

/** Destination point `meters` along `bearingDeg` from (lat, lon). */
function destinationPoint(
  lat: number,
  lon: number,
  bearingDeg: number,
  meters: number
): { lat: number; lon: number } {
  const R = 6371000
  const angular = meters / R
  const bearing = (bearingDeg * Math.PI) / 180
  const lat1 = (lat * Math.PI) / 180
  const lon1 = (lon * Math.PI) / 180
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing)
  )
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2)
    )
  return {
    lat: (lat2 * 180) / Math.PI,
    lon: (((lon2 * 180) / Math.PI + 540) % 360) - 180
  }
}

/**
 * Shortest distance from a point to the segment AB, in metres. Equirectangular
 * about A — these segments are at most a couple of kilometres, where the error
 * is centimetres.
 */
function distanceToSegment(
  lat: number,
  lon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): number {
  const mPerDegLat = 110540
  const mPerDegLon = 111320 * Math.cos((aLat * Math.PI) / 180)
  const px = (lon - aLon) * mPerDegLon
  const py = (lat - aLat) * mPerDegLat
  const bx = (bLon - aLon) * mPerDegLon
  const by = (bLat - aLat) * mPerDegLat
  const lenSq = bx * bx + by * by
  if (lenSq === 0) return Math.sqrt(px * px + py * py)
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / lenSq))
  const dx = px - t * bx
  const dy = py - t * by
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Age-correct a GTFS-RT frame.
 *
 * A frame states where the vehicle WAS, at `vehicle.seconds` — never where it
 * is now. On I-35W a 61 s-old frame describes a point 1.3 km behind a bus doing
 * 22 m/s, and measuring the rider's fresh fix against that stale point drops
 * the correct vehicle out of every proximity gate below. Measured on the
 * 2026-09-15 Orange Line ride (session mu2rh9og-fw6prf, bus 8220 on trip
 * 1:1348203): across the 28-minute leg the match fell to `none` 27 times and
 * read high/confirmed on only 55.8 % of 1,643 ticks, against a mean frame age
 * of 46 s.
 *
 * The frame carries what is needed to correct itself, and both fields were
 * checked against that recording rather than assumed: `speed` is metres per
 * second (median observed-displacement / reported-speed ratio 1.04 over 64
 * moving frame pairs for 8220), and `heading` is trustworthy while the vehicle
 * moves (median 2° from the actual bearing between consecutive frames).
 *
 * Two things come back, because they answer different questions:
 *
 *  - **lat/lon** — the best estimate of where the bus is now, `speed × age`
 *    along `heading`. This is what a rider is shown and what candidates are
 *    ranked by.
 *  - **the corridor** — frame point → `MAX_TRANSIT_SPEED_MPS × age` along
 *    `heading`. A frame's speed says nothing about the 45 s that followed it:
 *    the largest residuals on that ride were frames stamped at 1-6 m/s for a
 *    bus pulling out of a station that then reached 25 m/s, and frames stamped
 *    at freeway speed for a bus that then braked into one. Everywhere the bus
 *    could now be lies on this segment, so proximity is judged against the
 *    SEGMENT rather than against a disc inflated to the same radius. That
 *    distinction is the whole point: it is permissive along the direction of
 *    travel, where the uncertainty actually is, and stays tight sideways and
 *    backwards, where a disc would happily match a bus a kilometre off route.
 *
 * A frame stamped below MIN_SPEED_FOR_HEADING_MPS gets no corridor beyond its
 * own small projection — its heading is junk (it wanders 100°+ at a standstill),
 * and extrapolating a kilometre along a junk bearing is worse than not trying.
 */
export function ageCorrectVehicle(
  vehicle: {
    heading?: number | null
    lat: number
    lon: number
    seconds?: number | null
    speed?: number | null
  },
  nowMs: number
): AgedVehiclePosition {
  const { lat, lon } = vehicle
  const uncorrected: AgedVehiclePosition = {
    ageSeconds: 0,
    corridorLat: lat,
    corridorLon: lon,
    corridorMeters: 0,
    lat,
    lon,
    projectedMeters: 0
  }
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    return uncorrected
  }
  const { heading, seconds, speed } = vehicle
  if (
    typeof seconds !== 'number' ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return uncorrected
  }
  const ageSeconds = nowMs / 1000 - seconds
  if (!(ageSeconds > 0) || ageSeconds > MAX_CORRECTABLE_FRAME_AGE_SECONDS) {
    return uncorrected
  }
  // No bearing to project ALONG. Inventing one would be worse than leaving the
  // frame alone and letting the rider-speed fallback carry it.
  if (typeof heading !== 'number' || !Number.isFinite(heading)) {
    return uncorrected
  }

  // The corridor is granted on the strength of the HEADING, not the speed. A
  // frame stamped at 0-1 m/s is a bus dwelling at a stop, and 40 s later it is
  // most likely gone — that is the 2026-09-09 sighting exactly (rider standing
  // at a station, the poll still carrying a 22 s-old frame 90-100 m back up the
  // busway, match dropped). Tying the corridor to the frame's own speed denies
  // it precisely there. Measured on the 2026-09-15 recording the heading is
  // steady through those dwells (208-212° across the whole station approach);
  // it is at a true standstill that it turns to noise, and there this feed
  // publishes `heading: null`, which is handled above.
  const usableSpeed =
    typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : 0
  const projectedMeters = ageSeconds * usableSpeed
  const best = destinationPoint(lat, lon, heading, projectedMeters)
  const corridorMeters = ageSeconds * MAX_TRANSIT_SPEED_MPS
  const end = destinationPoint(lat, lon, heading, corridorMeters)

  return {
    ageSeconds,
    corridorLat: end.lat,
    corridorLon: end.lon,
    corridorMeters,
    lat: best.lat,
    lon: best.lon,
    projectedMeters
  }
}

/**
 * How far the rider is from this vehicle, how far away it is allowed to be,
 * and whether it is in range — the single place any of that is decided.
 *
 * `baseMeters` is the BASE radius, not a pre-widened one: whether the feed lag
 * is paid for by moving the vehicle or by widening the gate is settled here,
 * per frame, because only here is it known whether the frame could be aged. A
 * frame that could be corrected is judged against its corridor and keeps the
 * tight base radius (plus a lateral allowance for heading error); one that
 * could not falls back to `speedAdjustedRadius`, which makes the RIDER's speed
 * pay for the feed's age — the old behaviour, and the reason a rider standing
 * at a station (speed 0, radius collapsed to the base) lost a bus whose frame
 * was 90 m back up the busway on 2026-09-09.
 *
 * The radius is never tighter than the pre-correction one: moving the point
 * sharpens the measurement, and taking width away at the same time would trade
 * one class of missed match for another.
 */
export function measureVehicle(
  userLat: number,
  userLon: number,
  vehicle: VehiclePosition,
  baseMeters: number,
  userSpeedMps: number | null | undefined,
  nowMs: number
): { aged: AgedVehiclePosition; distance: number; inRange: boolean } {
  const aged = ageCorrectVehicle(vehicle, nowMs)
  // What the rider is told, and what candidates are ranked by.
  const distance = calculateDistance(userLat, userLon, aged.lat, aged.lon)
  const fallbackRadius = speedAdjustedRadius(baseMeters, userSpeedMps)
  if (aged.corridorMeters <= 0) {
    return { aged, distance, inRange: distance <= fallbackRadius }
  }
  // An explicitly unbounded base means "rank them all, reject none"
  // (confirmOnboardRoute passes Infinity to pick the nearest vehicle on a route
  // the rider just named), so never turn that ranking call into a filter.
  if (!Number.isFinite(baseMeters)) return { aged, distance, inRange: true }
  const corridorDistance = distanceToSegment(
    userLat,
    userLon,
    vehicle.lat,
    vehicle.lon,
    aged.corridorLat,
    aged.corridorLon
  )
  const radius = Math.min(
    Math.max(
      baseMeters + aged.corridorMeters * CORRIDOR_LATERAL_SLACK,
      fallbackRadius
    ),
    MAX_ADJUSTED_RADIUS_METERS
  )
  return { aged, distance, inRange: corridorDistance <= radius }
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
 *
 * `maxDistanceMeters` is the BASE radius: every frame is age-corrected first
 * and pays for its own feed lag (see measureVehicle), so callers pass the base
 * rather than pre-widening it by rider speed.
 */
export function findNearbyVehicles(
  userLat: number,
  userLon: number,
  vehicles: VehiclePosition[],
  maxDistanceMeters = 200,
  {
    nowMs = Date.now(),
    userSpeedMps = null
  }: { nowMs?: number; userSpeedMps?: number | null } = {}
): NearbyVehicleOption[] {
  return vehicles
    .map((v) => ({
      measured: measureVehicle(
        userLat,
        userLon,
        v,
        maxDistanceMeters,
        userSpeedMps,
        nowMs
      ),
      vehicle: v
    }))
    .filter((m) => m.measured.inRange)
    .map(({ measured, vehicle: v }) => ({
      direction: v.direction,
      distanceMeters: measured.distance,
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
 * 1. Age-correct each frame to `nowMs` and filter on `proximityMeters` (the
 *    BASE radius, default 80m — measureVehicle settles per frame whether the
 *    feed lag is paid by moving the vehicle or by widening the gate)
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
  userSpeedMps: number | null = null,
  /** GTFS direction_id of the leg the rider is trying to ride, when known. */
  expectedDirectionId: number | string | null = null,
  { nowMs = Date.now() }: { nowMs?: number } = {}
): VehicleMatchResult {
  const noMatch: VehicleMatchResult = {
    confidence: 'none',
    distanceMeters: null,
    label: null,
    lastSeen: Date.now(),
    vehicleId: null
  }

  if (!vehicles || vehicles.length === 0) return noMatch

  // Phase 1: Proximity filter, against each frame AGE-CORRECTED to now. The
  // distance carried forward from here — into the incumbent margin, the
  // confidence ladder and the rider-facing `distanceMeters` — is the corrected
  // one, because that is the honest answer to "how far away is that bus".
  let nearby = vehicles
    .map((v) => {
      const measured = measureVehicle(
        userLat,
        userLon,
        v,
        proximityMeters,
        userSpeedMps,
        nowMs
      )
      return {
        distance: measured.distance,
        inRange: measured.inRange,
        vehicle: v
      }
    })
    .filter((v) => v.inRange)
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

  // Phase 2b: Direction gate that works at a standstill.
  //
  // The heading gate above is inert below MIN_SPEED_FOR_HEADING_MPS, which is
  // precisely the situation a rider waiting at a stop is in. On 2026-08-27 a
  // rider standing still (0.0-0.3 m/s) was bound to the INBOUND run of their
  // route 117 m away, and because classifyMissedBus opens with `if (riding)
  // return null`, that one wrong fact disabled missed-bus detection for the
  // entire ten-minute wait — the rider asked "will I be alerted when my bus is
  // coming?" and the answer was no.
  //
  // GTFS direction_id is a fact about the trip, not about motion, so it holds
  // when nothing is moving. Only applied when BOTH sides declare one: the field
  // was dropped by the API mapper until 2026-08-27, so older records and any
  // feed that omits it simply fall through to the behaviour above.
  if (expectedDirectionId != null) {
    const opposing = nearby.filter(
      (c) =>
        c.vehicle.directionId != null &&
        String(c.vehicle.directionId) !== String(expectedDirectionId)
    )
    if (opposing.length) {
      const sameWay = nearby.filter((c) => !opposing.includes(c))
      // Only drop the wrong-direction candidates when something is left; an
      // empty list would fall through to `noMatch`, which is right, but say so
      // by keeping the same shape as the gate above.
      nearby = sameWay
      if (nearby.length === 0) return noMatch
    }
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
    directionId: bestVehicle.directionId ?? null,
    distanceMeters: Math.round(best.distance),
    label: bestVehicle.label,
    lastSeen: Date.now(),
    nextStopId: bestVehicle.nextStopId ?? null,
    routeId: bestVehicle.routeId ?? null,
    stopStatus: bestVehicle.stopStatus ?? null,
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
