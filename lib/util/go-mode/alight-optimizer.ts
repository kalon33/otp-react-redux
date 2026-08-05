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

/**
 * Where a stop sits in this trip's own stop list: exact id first, then the
 * stop NAME. Shared stations exist under several GTFS feeds (e.g. Burnsville
 * Transit Station is both 1:xxxx and MVTA's 2:31929), and a plan leg may
 * reference the twin feed's id — an exact-id-only match then never finds it.
 * Returns -1 when neither resolves.
 *
 * liveStopArrival and buildOnboardItinerary's alight resolution share this.
 * They used to differ, which was a real defect: liveStopArrival would resolve
 * a twin-feed stop by name and hand back a valid arrival epoch for a stopId
 * the builder's id-only findIndex never matched — so the builder fell through
 * to `boardIdx + 1` and silently collapsed the whole ride to one stop pair.
 */
export function findStopTimeIndex(
  stopTimes: TripStopTime[],
  stopGtfsId: string | null | undefined,
  stopName?: string | null
): number {
  if (!stopGtfsId && !stopName) return -1
  const byId = stopGtfsId
    ? stopTimes.findIndex((s) => s.stop?.id === stopGtfsId)
    : -1
  if (byId >= 0) return byId
  return stopName ? stopTimes.findIndex((s) => s.stop?.name === stopName) : -1
}

/**
 * The absolute epoch (ms) a trip reaches a given stop, preferring OTP's live
 * (GPS-fed) realtimeArrival and falling back to the schedule. Returns null when
 * the stop isn't in this trip's stop times or has no usable time. Used to keep
 * the trip-overview transit rows current mid-ride.
 */
export function liveStopArrival(
  stopTimes: TripStopTime[],
  stopGtfsId: string | null | undefined,
  stopName?: string | null
): { epoch: number; realtime: boolean } | null {
  if (!stopGtfsId && !stopName) return null
  const idx = findStopTimeIndex(stopTimes, stopGtfsId, stopName)
  const st = idx >= 0 ? stopTimes[idx] : undefined
  // serviceDay <= 0 means the stop times carry no service-date context (OTP's
  // dateless trip.stoptimes returns -1) — an absolute epoch would be garbage.
  if (!st || st.serviceDay == null || st.serviceDay <= 0) return null
  if (hasLiveArrival(st)) {
    return {
      epoch:
        ((st.serviceDay as number) + (st.realtimeArrival as number)) * 1000,
      realtime: true
    }
  }
  if (st.scheduledArrival != null) {
    return {
      epoch: (st.serviceDay + st.scheduledArrival) * 1000,
      realtime: false
    }
  }
  return null
}

/**
 * Merge one board/alight time against its previous value so the display never
 * regresses. As a vehicle nears (or passes) a stop, OTP commonly stops
 * publishing a live prediction for it and liveStopArrival falls back to the
 * SCHEDULE — on 7/12 the alight time jumped backwards from a live 14:07:27 to
 * a scheduled 14:01:00 (already in the past) and froze there, styled live.
 * Rules: live data always wins (predictions may legitimately move earlier);
 * without live data the best-known epoch is kept, clamped to now (a bus can't
 * arrive in the past) and honestly flagged non-live.
 */
export function mergeLiveTimePoint(
  prev: { epoch: number; realtime: boolean } | null,
  next: { epoch: number; realtime: boolean } | null,
  nowMs: number
): { epoch: number; realtime: boolean } | null {
  if (next?.realtime) return next
  const kept = prev ?? next
  if (!kept) return null
  return { epoch: Math.max(kept.epoch, nowMs), realtime: false }
}

/**
 * mergeLiveTimePoint clamps at merge time, but merges only run once per
 * refresh poll (20 s apart) — between polls the clock keeps walking, so a
 * non-live epoch can sit up to a full poll interval in the past (seen
 * 2026-07-21: an end-of-service realtime dropout left the alight time 6 s
 * stale). Re-raise every non-live epoch that has fallen behind `nowMs`.
 * Returns the updated record, or null when nothing drifted so callers can
 * skip the dispatch.
 */
export function clampNonLiveLegTimes<
  T extends {
    alightEpoch: number | null
    alightRealtime?: boolean
    boardEpoch: number | null
    boardRealtime?: boolean
    realtime: boolean
  }
>(
  times: Record<number, T> | null | undefined,
  nowMs: number
): Record<number, T> | null {
  if (!times) return null
  let changed = false
  const out: Record<number, T> = {}
  for (const key of Object.keys(times)) {
    const idx = Number(key)
    const t = times[idx]
    let next = t
    if (
      !(t.alightRealtime ?? t.realtime) &&
      t.alightEpoch != null &&
      t.alightEpoch < nowMs
    ) {
      next = { ...next, alightEpoch: nowMs }
      changed = true
    }
    if (
      !(t.boardRealtime ?? t.realtime) &&
      t.boardEpoch != null &&
      t.boardEpoch < nowMs
    ) {
      next = { ...next, boardEpoch: nowMs }
      changed = true
    }
    out[idx] = next
  }
  return changed ? out : null
}

/**
 * Choose which service-date instance of a trip the rider is actually on.
 * A trip id names a run on EVERY day it operates; findTrip fetches both
 * today's and yesterday's instances (an after-midnight ride belongs to
 * yesterday's service day). Preference: an instance with live (GPS-fed)
 * realtime beats schedule-only; ties break on whose scheduled time window
 * is closest to `nowMs`. Instances without service-date context
 * (serviceDay <= 0) are unusable and dropped.
 */
export function pickTripServiceInstance(
  instances: Array<TripStopTime[] | null | undefined>,
  nowMs: number
): TripStopTime[] {
  const usable = instances
    .map((sts) => sts || [])
    .filter(
      (sts) => sts.length > 0 && sts.every((st) => (st.serviceDay ?? 0) > 0)
    )
  if (usable.length <= 1) return usable[0] || []

  const score = (sts: TripStopTime[]) => {
    const live = sts.some((st) => hasLiveArrival(st))
    const firstSt = sts[0]
    const lastSt = sts[sts.length - 1]
    const first =
      ((firstSt.serviceDay as number) +
        (firstSt.scheduledDeparture ?? firstSt.scheduledArrival ?? 0)) *
      1000
    const last =
      ((lastSt.serviceDay as number) +
        (lastSt.scheduledArrival ?? lastSt.scheduledDeparture ?? 0)) *
      1000
    const dist = nowMs < first ? first - nowMs : nowMs > last ? nowMs - last : 0
    return { dist, live }
  }
  return usable
    .map((sts) => ({ s: score(sts), sts }))
    .sort((a, b) =>
      a.s.live !== b.s.live ? (a.s.live ? -1 : 1) : a.s.dist - b.s.dist
    )[0].sts
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
 * Order two scored options: earlier total arrival wins, but ties (within
 * TIE_MS) break on fewer transfers, then less walking, then earlier arrival —
 * biasing toward staying on the current bus to a convenient stop rather than
 * getting off early to shave a few seconds. Returns <0 when `a` is better.
 */
function compareAlightOptions(
  a: AlightOption & { arrival: number },
  b: AlightOption & { arrival: number }
): number {
  if (Math.abs(a.arrival - b.arrival) <= TIE_MS) {
    const dT = (a.itinerary.transfers ?? 0) - (b.itinerary.transfers ?? 0)
    if (dT !== 0) return dT
    const dW = (a.itinerary.walkDistance ?? 0) - (b.itinerary.walkDistance ?? 0)
    if (dW !== 0) return dW
  }
  return a.arrival - b.arrival
}

/** A lightweight signature of an onward journey (mode + route + endpoints per
 * leg), used to drop duplicate options the multi-stop search surfaces more than
 * once. Mirrors collectRerouteCandidates' dedup idiom in
 * lib/util/go-mode/reroute-candidates.ts. */
function journeySignature(stopId: string, itinerary: Itinerary): string {
  const legs = (itinerary.legs || [])
    .map(
      (l: any) =>
        `${l.mode}:${l.routeId || l.route?.id || ''}:${l.from?.name || ''}>${
          l.to?.name || ''
        }`
    )
    .join('|')
  return `${stopId}#${legs}`
}

/**
 * Across the candidate alight stops whose onward plans came back, return the
 * best overall onward options ranked by the metrics that matter — earliest
 * total arrival (bus arrival at the stop + remaining-journey duration), then
 * fewer transfers, then less walking. Every usable itinerary from every stop is
 * a candidate (the rider doesn't care which stop, just the best journeys);
 * near-identical journeys are deduped and the list is capped at `limit`.
 */
export function rankAlightOptions(
  results: AlightCandidateResult[],
  {
    limit = 5,
    walkOnlyMax = 1200
  }: { limit?: number; walkOnlyMax?: number } = {}
): AlightOption[] {
  const scored: Array<AlightOption & { arrival: number }> = []
  results.forEach((r) => {
    if (!r || r.error) return
    ;(r.itineraries || []).forEach((itin) => {
      if (!isUsableItinerary(itin, walkOnlyMax)) return
      scored.push({
        arrival: scoreAlightOption(r.busArrivalEpoch, itin),
        busArrivalEpoch: r.busArrivalEpoch,
        itinerary: itin,
        realtime: r.realtime,
        stopId: r.stopId,
        stopName: r.stopName
      })
    })
  })

  scored.sort(compareAlightOptions)

  const seen = new Set<string>()
  const ranked: AlightOption[] = []
  for (const option of scored) {
    const sig = journeySignature(option.stopId, option.itinerary)
    if (seen.has(sig)) continue
    seen.add(sig)
    ranked.push({
      busArrivalEpoch: option.busArrivalEpoch,
      itinerary: option.itinerary,
      realtime: option.realtime,
      stopId: option.stopId,
      stopName: option.stopName
    })
    if (ranked.length >= limit) break
  }
  return ranked
}

/**
 * The single best stop to get off — the top of the ranked list. Retained for
 * callers that only want one option.
 */
export function pickBestAlightOption(
  results: AlightCandidateResult[],
  { walkOnlyMax = 1200 }: { walkOnlyMax?: number } = {}
): AlightOption | null {
  return rankAlightOptions(results, { walkOnlyMax })[0] ?? null
}
