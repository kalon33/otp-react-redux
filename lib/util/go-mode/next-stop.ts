import {
  calculateCumulativeDistances,
  calculateDistance,
  decodeLegGeometry
} from './position-matching'
import { liveStopArrival } from './alight-optimizer'

/**
 * The next stop ahead of the rider on the transit leg they are aboard. Used as
 * the origin for mid-ride searches instead of a raw (mid-street) GPS point.
 */
export interface NextStopOnRide {
  /** Best-known epoch (ms) the bus reaches this stop (live when available). */
  arrivalEpoch: number
  lat: number
  lon: number
  name: string
  realtime: boolean
  stopId: string | null
}

interface OrderedStop {
  arrivalEpoch: number | null
  lat: number
  lon: number
  name: string
  stopId: string | null
}

/** Normalize an intermediatePlaces / intermediateStops entry or leg.to. */
function toOrderedStop(place: any): OrderedStop | null {
  if (place?.lat == null || place?.lon == null) return null
  return {
    arrivalEpoch:
      typeof place.arrivalTime === 'number' ? place.arrivalTime : null,
    lat: place.lat,
    lon: place.lon,
    name: place.name || 'Stop',
    stopId: place.stop?.gtfsId ?? place.stopId ?? null
  }
}

/**
 * The leg's stops in travel order: intermediates then the alight stop.
 * intermediatePlaces (planned + synthesized onboard itineraries) carries
 * arrival times and gtfsIds; intermediateStops (name/lat/lon only) is the
 * fallback shape some responses use.
 */
export function orderedStopsOnLeg(leg: any): OrderedStop[] {
  const places: any[] = leg?.intermediatePlaces || []
  const stops: any[] = leg?.intermediateStops || []
  let intermediates = (places.length ? places : stops)
    .map(toOrderedStop)
    .filter(Boolean) as OrderedStop[]
  // intermediatePlaces is preferred for its arrival times and gtfsIds, but
  // some responses carry coordinateless entries that toOrderedStop drops.
  // Only when entries were actually dropped: if intermediateStops retains
  // more stops, a full count beats richer metadata (a collapsed list reads
  // as "1 stop remaining" for the whole leg).
  if (places.length && intermediates.length < places.length) {
    const alt = stops.map(toOrderedStop).filter(Boolean) as OrderedStop[]
    if (alt.length > intermediates.length) intermediates = alt
  }
  const alight = toOrderedStop(leg?.to)
  return alight ? [...intermediates, alight] : intermediates
}

/**
 * The leg CLAIMS intermediate stops but the usable list collapsed to just the
 * alight stop (every entry lacked coordinates) — any count from it is a
 * permanent "1 stop remaining" and must not be trusted. A leg genuinely
 * without intermediates is NOT degenerate: 1 stop remaining is then correct.
 */
export function hasDegenerateStopList(leg: any): boolean {
  const claimed =
    (leg?.intermediatePlaces?.length || 0) +
    (leg?.intermediateStops?.length || 0)
  return claimed > 0 && orderedStopsOnLeg(leg).length <= 1
}

/**
 * Fraction (0..1) along the leg geometry at which each stop sits. Monotonic
 * scan: stops appear along the geometry in travel order, so each nearest-point
 * search resumes where the previous stop landed. Null when the geometry is
 * unusable (fewer than two points or zero length).
 */
export function stopFractionsAlongLeg(
  stops: { lat: number; lon: number }[],
  polyline: [number, number][]
): number[] | null {
  if (polyline.length < 2) return null
  const cumulative = calculateCumulativeDistances(polyline)
  const total = cumulative[cumulative.length - 1]
  if (!(total > 0)) return null
  const fractions: number[] = []
  let searchFrom = 0
  for (const stop of stops) {
    let bestIdx = searchFrom
    let bestDist = Infinity
    for (let i = searchFrom; i < polyline.length; i++) {
      const d = calculateDistance(
        stop.lat,
        stop.lon,
        polyline[i][0],
        polyline[i][1]
      )
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    searchFrom = bestIdx
    fractions.push(cumulative[bestIdx] / total)
  }
  return fractions
}

// Epsilon on leg-progress comparisons so the stop the bus is currently AT
// (doors open) doesn't count as still ahead.
const AT_STOP_EPSILON = 0.005

/**
 * How many stops are still ahead of the rider on the leg (the alight stop
 * counts as 1), plus the name of the nearest one. Stops sit unevenly along a
 * leg — a freeway BRT runs stopless for miles, then downtown stops bunch at
 * the end — so the count comes from each stop's measured position on the
 * geometry; an even-spacing estimate reports "1 stop remaining" with a whole
 * downtown cluster still ahead. Null when the leg has no stops with
 * coordinates or no usable geometry.
 */
export function countStopsAhead(
  leg: any,
  progress: number
): { nextStopName: string; stopsRemaining: number } | null {
  // NaN/undefined progress fails every fraction comparison below and lands on
  // the last stop — reading as "1 stop remaining" off no position fact at all.
  if (!Number.isFinite(progress)) return null
  const ordered = orderedStopsOnLeg(leg)
  if (!ordered.length) return null
  const fractions = stopFractionsAlongLeg(ordered, decodeLegGeometry(leg))
  if (!fractions) return null
  const clamped = Math.max(0, Math.min(1, progress))
  const idx = fractions.findIndex((f) => f > clamped + AT_STOP_EPSILON)
  if (idx === -1) {
    // Progress is past the last stop's fraction, so the rider is AT or past
    // the alight stop and zero stops are still ahead. Pinning idx to the last
    // stop reported a permanent "1 stop remaining" instead — not a display
    // policy but wrong arithmetic, and the opposite of what AT_STOP_EPSILON's
    // own rule says (the stop you are AT doesn't count as still ahead).
    return {
      nextStopName: ordered[ordered.length - 1].name,
      stopsRemaining: 0
    }
  }
  return {
    nextStopName: ordered[idx].name,
    stopsRemaining: ordered.length - idx
  }
}

/**
 * Compute the next stop ahead on the transit leg the rider is aboard, or null
 * when the sticky riding state isn't anchored to a transit leg. Position along
 * the leg comes from the live route match (GPS projected onto the leg
 * geometry); each stop is projected onto the same geometry so "ahead" is
 * geometric, not schedule-guesswork. Arrival times prefer the boarded trip's
 * live (GTFS-RT) stop times — kept fresh mid-ride by refreshLiveLegTimes —
 * over the itinerary's as-of-planning snapshot.
 */
export function getNextStopOnRide(
  state: any,
  nowMs: number = Date.now()
): NextStopOnRide | null {
  const goMode = state.otp?.goMode
  const riding = goMode?.riding
  const itinerary = goMode?.activeItinerary
  if (!goMode?.isActive || !riding || riding.legIndex < 0 || !itinerary) {
    return null
  }
  const leg: any = itinerary.legs?.[riding.legIndex]
  if (!leg?.transitLeg) return null

  const ordered = orderedStopsOnLeg(leg)
  if (!ordered.length) return null

  // Fraction of the leg already covered. Trust the live route match when it is
  // anchored to this leg; otherwise fall back to time-based selection below.
  const routeMatch = goMode.routeMatch
  const progress =
    routeMatch && routeMatch.legIndex === riding.legIndex
      ? routeMatch.progressAlongLeg
      : null

  let next: OrderedStop | null = null
  if (progress != null) {
    const fractions = stopFractionsAlongLeg(ordered, decodeLegGeometry(leg))
    if (fractions) {
      const idx = fractions.findIndex((f) => f > progress + AT_STOP_EPSILON)
      if (idx !== -1) next = ordered[idx]
    }
  }

  // No geometry or no route match on this leg — pick the first stop the bus
  // hasn't reached yet by best-known arrival time.
  if (!next) {
    next =
      ordered.find((s) => s.arrivalEpoch != null && s.arrivalEpoch > nowMs) ??
      ordered[ordered.length - 1]
  }

  // Arrival: live stop time for the boarded trip first, then the itinerary's
  // planned arrival, then "now" (never in the past — searches depart later).
  const stopTimes =
    (riding.tripId &&
      state.otp?.transitIndex?.trips?.[riding.tripId]?.stopTimes) ||
    []
  const live = liveStopArrival(stopTimes, next.stopId)
  const arrivalEpoch = live?.epoch ?? next.arrivalEpoch ?? nowMs

  return {
    arrivalEpoch: Math.max(arrivalEpoch, nowMs),
    lat: next.lat,
    lon: next.lon,
    name: next.name,
    realtime: !!live?.realtime,
    stopId: next.stopId
  }
}

/**
 * A stop the rider has passed stays passed.
 *
 * countStopsAhead is stateless and re-decides "passed" from scratch every tick
 * out of a fraction along the leg, so any downward wobble in progress un-passes
 * a stop. On 2026-08-27 that happened twice by two different routes: a snapper
 * flip on the 465's self-overlapping downtown loop (1 -> 2 -> 1 stops), and
 * again on the Gold Line at 14:21:33 with the snapper perfectly stable —
 * progressAlongLeg 0.2158 and segment 71 identical across the flip — where the
 * count alone went 7 -> 8 -> 7. Fixing the snapper cannot fix the second one;
 * the counter needs its own latch.
 *
 * The latch is per leg AND per source: stopsSource switches between gps,
 * vehicle, vehicle-stop and schedule (see getTransitProgress), and those counts
 * are not measuring the same thing — a vehicle-derived count is not comparable
 * with a GPS-derived one, so a source change starts over rather than pinning
 * the new source to the old source's floor.
 */
export interface StopCountLatch {
  legIndex: number
  source: string
  stopsRemaining: number
}

export function latchStopsRemaining(
  prev: StopCountLatch | null,
  next: { legIndex: number; source: string; stopsRemaining: number }
): { next: StopCountLatch; stopsRemaining: number } {
  const comparable =
    prev != null &&
    prev.legIndex === next.legIndex &&
    prev.source === next.source
  // Never let the count grow back. It may only fall (stops being passed) or
  // hold.
  const stopsRemaining = comparable
    ? Math.min(prev.stopsRemaining, next.stopsRemaining)
    : next.stopsRemaining
  return {
    next: { legIndex: next.legIndex, source: next.source, stopsRemaining },
    stopsRemaining
  }
}
