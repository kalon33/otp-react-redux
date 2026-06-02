import type { Itinerary } from '@opentripplanner/types'

import { calculateDistance } from './position-matching'

// --- Types ---

export interface TripStop {
  code?: string
  id: string // gtfsId
  lat: number
  lon: number
  name: string
}

export interface TripStopTime {
  scheduledDeparture: number // GTFS seconds-after-midnight
  stop: TripStop
}

/** Shape of a findTrip() response (lib/actions/apiV2.js findTrip). */
export interface TripSchedule {
  geometry?: { length: number; points: string }
  id: string
  route?: any
  stopTimes: TripStopTime[]
  tripHeadsign?: string
}

export interface DownstreamStop {
  /** Absolute epoch (ms) the bus is expected to reach this stop. */
  busArrivalEpoch: number
  /** Straight-line meters from this stop to the rider's destination. */
  distanceToDest: number
  scheduledDeparture: number
  stop: TripStop
  /** Index of this stop within trip.stopTimes. */
  stopIndexInTrip: number
}

interface LatLon {
  lat: number
  lon: number
}

/**
 * Find the index of the stop the bus is currently heading to (its anchor):
 * 1. Prefer the vehicle's reported nextStopId.
 * 2. Otherwise the stop nearest the rider's GPS position.
 * 3. Otherwise the first stop.
 */
function findAnchorIndex(
  stopTimes: TripStopTime[],
  nextStopId: string | null | undefined,
  userPos: LatLon | null
): number {
  if (nextStopId) {
    const idx = stopTimes.findIndex((st) => st.stop?.id === nextStopId)
    if (idx >= 0) return idx
  }
  if (userPos) {
    let bestIdx = 0
    let bestDist = Infinity
    stopTimes.forEach((st, i) => {
      const d = calculateDistance(
        userPos.lat,
        userPos.lon,
        st.stop.lat,
        st.stop.lon
      )
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    })
    return bestIdx
  }
  return 0
}

/**
 * Compute the stops still ahead of the rider on the current trip, each tagged
 * with the absolute time the bus is expected to reach it and its distance to
 * the destination. Times are anchored to `nowMs` at the bus's next stop, so the
 * estimate self-corrects for any delay already accrued (rather than relying on
 * absolute GTFS service-day times that may have drifted).
 */
export function getDownstreamStops(
  trip: TripSchedule | null,
  vehicle: { nextStopId?: string | null } | null,
  userPos: LatLon | null,
  dest: LatLon,
  nowMs: number
): DownstreamStop[] {
  const stopTimes = trip?.stopTimes || []
  if (stopTimes.length === 0) return []

  const anchorIdx = findAnchorIndex(stopTimes, vehicle?.nextStopId, userPos)
  const anchorDeparture = stopTimes[anchorIdx].scheduledDeparture

  const downstream: DownstreamStop[] = []
  for (let i = anchorIdx; i < stopTimes.length; i++) {
    const st = stopTimes[i]
    if (!st.stop || st.stop.lat == null || st.stop.lon == null) continue
    downstream.push({
      busArrivalEpoch: nowMs + (st.scheduledDeparture - anchorDeparture) * 1000,
      distanceToDest: calculateDistance(
        st.stop.lat,
        st.stop.lon,
        dest.lat,
        dest.lon
      ),
      scheduledDeparture: st.scheduledDeparture,
      stop: st.stop,
      stopIndexInTrip: i
    })
  }
  return downstream
}

/**
 * Pick a bounded set of candidate alight stops to actually plan from. The bus
 * passes closest to the destination at one stop; the best alight point is
 * usually at or just before/after that stop, so we keep a window around it
 * (plus the very next stop as an early-exit option) and never ride far past it.
 */
export function selectCandidateStops(
  downstream: DownstreamStop[],
  maxCandidates = 5
): DownstreamStop[] {
  if (downstream.length === 0) return []

  // Stop where the bus is physically closest to the destination.
  let closestPos = 0
  downstream.forEach((d, i) => {
    if (d.distanceToDest < downstream[closestPos].distanceToDest) closestPos = i
  })

  // Don't bother riding more than two stops past the closest approach.
  const upper = Math.min(downstream.length, closestPos + 3)
  const pool = downstream.slice(0, upper)

  if (pool.length <= maxCandidates) return pool

  // Even sample across the pool, then force-include the first stop (earliest
  // exit) and the closest-approach stop so neither is lost to sampling.
  const picked = new Map<number, DownstreamStop>()
  const step = (pool.length - 1) / (maxCandidates - 1)
  for (let k = 0; k < maxCandidates; k++) {
    const idx = Math.round(k * step)
    picked.set(idx, pool[idx])
  }
  picked.set(0, pool[0])
  picked.set(closestPos, pool[closestPos])

  return Array.from(picked.values()).sort(
    (a, b) => a.stopIndexInTrip - b.stopIndexInTrip
  )
}

/**
 * Total time to arrive at the destination via this alight stop: the bus reaches
 * the stop at busArrivalEpoch, then the onward plan takes itinerary.duration.
 * Lower is better. Returns the arrival epoch (ms).
 */
export function scoreAlightOption(
  busArrivalEpoch: number,
  itinerary: Itinerary
): number {
  return busArrivalEpoch + (itinerary.duration || 0) * 1000
}
