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
  const intermediates: any[] =
    (leg?.intermediatePlaces?.length
      ? leg.intermediatePlaces
      : leg?.intermediateStops) || []
  return [...intermediates, leg?.to]
    .map(toOrderedStop)
    .filter(Boolean) as OrderedStop[]
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
  const ordered = orderedStopsOnLeg(leg)
  if (!ordered.length) return null
  const fractions = stopFractionsAlongLeg(ordered, decodeLegGeometry(leg))
  if (!fractions) return null
  const clamped = Math.max(0, Math.min(1, progress))
  let idx = fractions.findIndex((f) => f > clamped + AT_STOP_EPSILON)
  if (idx === -1) idx = ordered.length - 1
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
