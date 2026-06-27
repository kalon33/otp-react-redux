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
  arrivalDelay?: number
  realtimeArrival?: number // GTFS seconds-after-midnight (live, GPS-fed)
  realtimeState?: string
  scheduledArrival?: number
  scheduledDeparture: number // GTFS seconds-after-midnight
  serviceDay?: number // epoch seconds at the service day's start
  stop: TripStop
}

/**
 * OTP realtimeState values where the time reflects live (GPS-derived) vehicle
 * data rather than the static schedule.
 */
export const LIVE_REALTIME_STATES = new Set(['UPDATED', 'ADDED', 'MODIFIED'])

/** Whether a trip stop time carries a usable live arrival prediction. */
export function hasLiveArrival(st: TripStopTime): boolean {
  return (
    !!st.realtimeState &&
    LIVE_REALTIME_STATES.has(st.realtimeState) &&
    st.realtimeArrival != null &&
    st.serviceDay != null
  )
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
  /** True when busArrivalEpoch came from live (GPS-fed) realtime data. */
  realtime: boolean
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
 * the destination.
 *
 * Per stop we prefer OTP's live realtimeArrival (which the agency derives from
 * the vehicle's GPS via GTFS-RT) — that is the actual GPS-based arrival
 * prediction. When a stop has no realtime data we fall back to the schedule,
 * anchored to `nowMs` at the bus's next stop so the estimate still self-corrects
 * for delay already accrued (rather than relying on absolute GTFS service-day
 * times that may have drifted).
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
    const live = hasLiveArrival(st)
    const busArrivalEpoch = live
      ? ((st.serviceDay as number) + (st.realtimeArrival as number)) * 1000
      : nowMs + (st.scheduledDeparture - anchorDeparture) * 1000
    downstream.push({
      busArrivalEpoch,
      distanceToDest: calculateDistance(
        st.stop.lat,
        st.stop.lon,
        dest.lat,
        dest.lon
      ),
      realtime: live,
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

/** Result of planning the onward trip from one candidate alight stop. */
export interface AlightCandidateResult {
  busArrivalEpoch: number
  error?: boolean
  itineraries: Itinerary[]
  realtime: boolean
  stopId: string
  stopName: string
}

/** The chosen best stop to get off, with its remaining-journey itinerary. */
export interface AlightOption {
  busArrivalEpoch: number
  itinerary: Itinerary
  realtime: boolean
  stopId: string
  stopName: string
}

/** Within this window two alight stops count as tied (see pickBestAlightOption). */
const TIE_MS = 180000

/**
 * Whether an onward itinerary is worth offering. A plan with a transit leg
 * always is. A walk-only plan is kept only when the walk is short — OTP returns
 * a walk-the-whole-way itinerary as a fallback even from a far stop, which we
 * don't want to recommend; but a short final walk (alight stop ~at the
 * destination) is legitimate.
 */
function isUsableItinerary(itin: Itinerary, walkOnlyMax: number): boolean {
  const hasTransit = (itin.legs || []).some((leg) => leg.transitLeg)
  if (hasTransit) return true
  return (itin.walkDistance ?? Infinity) <= walkOnlyMax
}

/**
 * Across the candidate alight stops whose onward plans came back, pick the stop
 * whose total arrival time (bus arrival at the stop + remaining-journey
 * duration) is earliest. Ties (within TIE_MS) break on fewer transfers, then
 * less walking, then earlier arrival — biasing toward staying on the current bus
 * to a convenient stop rather than getting off early to shave a few seconds.
 * Returns null when no candidate produced a usable itinerary.
 */
export function pickBestAlightOption(
  results: AlightCandidateResult[],
  { walkOnlyMax = 1200 }: { walkOnlyMax?: number } = {}
): AlightOption | null {
  // Reduce each candidate to its quickest usable onward itinerary, scored by
  // total arrival time.
  const scored: Array<AlightOption & { arrival: number }> = []
  results.forEach((r) => {
    if (!r || r.error) return
    const usable = (r.itineraries || []).filter((itin) =>
      isUsableItinerary(itin, walkOnlyMax)
    )
    if (usable.length === 0) return

    const bestForStop = usable.reduce((b, itin) =>
      itin.duration < b.duration ? itin : b
    )
    scored.push({
      arrival: scoreAlightOption(r.busArrivalEpoch, bestForStop),
      busArrivalEpoch: r.busArrivalEpoch,
      itinerary: bestForStop,
      realtime: r.realtime,
      stopId: r.stopId,
      stopName: r.stopName
    })
  })

  let best: (AlightOption & { arrival: number }) | null = null
  for (const option of scored) {
    if (!best) {
      best = option
      continue
    }
    let better
    if (Math.abs(option.arrival - best.arrival) <= TIE_MS) {
      const dT =
        (option.itinerary.transfers ?? 0) - (best.itinerary.transfers ?? 0)
      const dW =
        (option.itinerary.walkDistance ?? 0) -
        (best.itinerary.walkDistance ?? 0)
      better =
        dT < 0 ||
        (dT === 0 && dW < 0) ||
        (dT === 0 && dW === 0 && option.arrival < best.arrival)
    } else {
      better = option.arrival < best.arrival
    }
    if (better) best = option
  }

  if (!best) return null
  return {
    busArrivalEpoch: best.busArrivalEpoch,
    itinerary: best.itinerary,
    realtime: best.realtime,
    stopId: best.stopId,
    stopName: best.stopName
  }
}
