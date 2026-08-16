import type { Itinerary } from '@opentripplanner/types'

import { calculateDistance } from './position-matching'
import { getLegRouteId } from './departure-anchor'

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
    let boardRaised = false
    if (
      !(t.boardRealtime ?? t.realtime) &&
      t.boardEpoch != null &&
      t.boardEpoch < nowMs
    ) {
      next = { ...next, boardEpoch: nowMs }
      boardRaised = true
      changed = true
    }
    // Raising the board time past a still-past alight time inverts the leg —
    // the rider would be shown arriving before they got on. Carry the alight
    // with it. Scoped to the raise we just made: everywhere else board and
    // alight are deliberately independent, and a merely-late live pair is
    // honest data, not an inversion. (8/2: this shape drove the
    // once-per-second SET_LIVE_LEG_TIMES churn through the whole ride.)
    if (
      boardRaised &&
      next.alightEpoch != null &&
      next.boardEpoch != null &&
      next.alightEpoch < next.boardEpoch
    ) {
      next = { ...next, alightEpoch: next.boardEpoch }
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
 *
 * A live arrival is discarded when it is INVERTED — behind the clock, or behind
 * a stop the bus has not reached yet. 2026-08-09: on trip 1:1085482 stop
 * 1:53313 came back UPDATED with arrivalDelay 0 (19:20:00) while the three
 * stops AFTER it carried 664/617/605 s of delay, so the feed claimed the bus
 * would reach it 9m13.9s before the moment we read it. That epoch is what
 * fetchCandidatePlan sends as the onward plan's departure time, so OTP planned
 * from the past and offered a route 22 that had already gone.
 *
 * Strictly an inversion guard, NOT a floor — the same rule as the bus-leg guard
 * in buildOnboardItinerary. A live arrival merely EARLIER than schedule is a bus
 * running ahead, which is exactly what realtime exists to tell us.
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
  // The last arrival we accepted, so a stop cannot be reached before the stop
  // before it. Seeded to nowMs: nothing ahead of the bus is already behind us.
  let prevEpoch = nowMs
  for (let i = anchorIdx; i < stopTimes.length; i++) {
    const st = stopTimes[i]
    if (!st.stop || st.stop.lat == null || st.stop.lon == null) continue
    const scheduleEpoch =
      nowMs + (st.scheduledDeparture - anchorDeparture) * 1000
    const live = hasLiveArrival(st)
    const liveEpoch = live
      ? ((st.serviceDay as number) + (st.realtimeArrival as number)) * 1000
      : null
    // Inversion, not earliness: a live arrival is kept unless it lands before
    // the last stop we accepted (prevEpoch starts at nowMs, so this also
    // rejects anything already behind the clock). An arrival merely earlier
    // than SCHEDULE is a bus running ahead and passes straight through.
    //
    // The schedule fallback is floored to prevEpoch as well, so once a live
    // neighbour reveals accrued delay the schedule-only stops after it inherit
    // it instead of being re-anchored to an undelayed now.
    const useLive = liveEpoch != null && liveEpoch >= prevEpoch
    const busArrivalEpoch = useLive
      ? liveEpoch
      : Math.max(scheduleEpoch, prevEpoch)
    prevEpoch = busArrivalEpoch
    downstream.push({
      busArrivalEpoch,
      distanceToDest: calculateDistance(
        st.stop.lat,
        st.stop.lon,
        dest.lat,
        dest.lon
      ),
      realtime: useLive,
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
 * How far before the rider is off the bus an onward plan may depart and still
 * count as catchable. The same 60 s call as DEPARTURE_OVERDUE_GRACE_MS in
 * departure-anchor.ts, deliberately a separate constant — that one means "a
 * departure you are a minute late for is still worth walking to", this one
 * means "a plan that left a minute ago is still catchable".
 */
const REACHABLE_TOLERANCE_MS = 60000

/**
 * Can the rider actually make this onward plan? They are on the bus until
 * busArrivalEpoch, so a plan that departed before then is a plan for someone
 * else.
 *
 * 2026-08-09: a poisoned realtime arrival anchored the query 9 minutes in the
 * past, and OTP honestly returned buses departing from that past moment — two
 * route 22s leaving at 19:20:01. Note which clause catches that: the `nowMs`
 * one. The busArrivalEpoch clause is inert there, because OTP did respect the
 * (lying) depart-after time it was given. Both are kept; they guard different
 * failures.
 *
 * getDownstreamStops now keeps the anchor honest, so this is the backstop for
 * the next feed anomaly of a shape we have not seen.
 *
 * Fails OPEN on a non-finite startTime. OTP always sets one, so its absence
 * means synthetic data — and a backstop that silently deletes every option on
 * an unexpected shape is worse than the bug it guards. (Not the same posture as
 * isUsableItinerary, which fails closed on a missing walkDistance; there the
 * missing field IS the thing being judged.)
 */
function isReachableItinerary(
  itin: Itinerary,
  busArrivalEpoch: number,
  nowMs: number | null
): boolean {
  const start = Number(itin.startTime)
  if (!Number.isFinite(start)) return true
  if (start + REACHABLE_TOLERANCE_MS < busArrivalEpoch) return false
  if (nowMs != null && start + REACHABLE_TOLERANCE_MS < nowMs) return false
  return true
}

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
 * The route an onward plan puts the rider on — its first transit leg. That is
 * the leg the rider chose when they planned the trip, and the one an alight
 * option can silently replace.
 */
export function onwardRouteOfItinerary(itinerary: Itinerary): string | null {
  const leg = (itinerary.legs || []).find((l) => l.transitLeg)
  return leg ? getLegRouteId(leg) : null
}

/**
 * Order two scored options: earlier total arrival wins, but ties (within
 * TIE_MS) break on the rider's own route first, then fewer transfers, then less
 * walking, then earlier arrival — biasing toward staying on the current bus to
 * a convenient stop rather than getting off early to shave a few seconds.
 * Returns <0 when `a` is better.
 *
 * The keepRouteId clause is deliberately INSIDE the tie window: the rider's
 * chosen route wins when the difference is noise, and a genuinely faster
 * alternative still ranks above it and stays visible. Never dropping it is
 * rankAlightOptions' job, not this comparator's.
 */
function compareAlightOptions(
  a: AlightOption & { arrival: number },
  b: AlightOption & { arrival: number },
  keepRouteId: string | null = null
): number {
  if (Math.abs(a.arrival - b.arrival) <= TIE_MS) {
    if (keepRouteId) {
      const dK =
        Number(onwardRouteOfItinerary(b.itinerary) === keepRouteId) -
        Number(onwardRouteOfItinerary(a.itinerary) === keepRouteId)
      if (dK !== 0) return dK
    }
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
 *
 * `keepRouteId` is the route the rider already chose for the leg after this
 * bus. It never filters — it wins ties, and it holds the last slot so the cap
 * cannot cut it. Losing the chosen route to a display limit is the same failure
 * applyAutoReroute fixed by searching collectRerouteCandidates(all, 50) instead
 * of the five it shows.
 */
export function rankAlightOptions(
  results: AlightCandidateResult[],
  {
    keepRouteId = null,
    limit = 5,
    nowMs = null,
    walkOnlyMax = 1200
  }: {
    keepRouteId?: string | null
    limit?: number
    nowMs?: number | null
    walkOnlyMax?: number
  } = {}
): AlightOption[] {
  const scored: Array<AlightOption & { arrival: number }> = []
  results.forEach((r) => {
    if (!r || r.error) return
    ;(r.itineraries || []).forEach((itin) => {
      if (!isUsableItinerary(itin, walkOnlyMax)) return
      if (!isReachableItinerary(itin, r.busArrivalEpoch, nowMs)) return
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

  scored.sort((a, b) => compareAlightOptions(a, b, keepRouteId))

  const strip = (option: AlightOption & { arrival: number }): AlightOption => ({
    busArrivalEpoch: option.busArrivalEpoch,
    itinerary: option.itinerary,
    realtime: option.realtime,
    stopId: option.stopId,
    stopName: option.stopName
  })

  const seen = new Set<string>()
  const ranked: AlightOption[] = []
  const deduped: Array<AlightOption & { arrival: number }> = []
  for (const option of scored) {
    const sig = journeySignature(option.stopId, option.itinerary)
    if (seen.has(sig)) continue
    seen.add(sig)
    deduped.push(option)
    if (ranked.length < limit) ranked.push(strip(option))
  }

  // The chosen route holds a slot. It is already ranked ahead of anything it
  // ties with; if it is genuinely slower than `limit` alternatives it lands in
  // the last one rather than vanishing. Replacing the last entry keeps the list
  // exactly as long as the caller asked for.
  if (keepRouteId && ranked.length >= limit) {
    const alreadyKept = ranked.some(
      (o) => onwardRouteOfItinerary(o.itinerary) === keepRouteId
    )
    const chosen = deduped.find(
      (o) => onwardRouteOfItinerary(o.itinerary) === keepRouteId
    )
    if (!alreadyKept && chosen) ranked[ranked.length - 1] = strip(chosen)
  }
  return ranked
}

/**
 * The single best stop to get off — the top of the ranked list. Retained for
 * callers that only want one option.
 */
export function pickBestAlightOption(
  results: AlightCandidateResult[],
  {
    nowMs = null,
    walkOnlyMax = 1200
  }: { nowMs?: number | null; walkOnlyMax?: number } = {}
): AlightOption | null {
  return rankAlightOptions(results, { nowMs, walkOnlyMax })[0] ?? null
}

/**
 * From ranked alight options, the best one that keeps the rider on the route
 * they already chose. Returns null when nothing onward runs that route — the
 * caller must then ASK rather than apply, because an automatic update that
 * picks a different route is the one thing the rider has ruled out.
 *
 * The AlightOption twin of pickSameRouteReroute (lib/util/state.js): same
 * contract, but it returns the option rather than the itinerary, because the
 * alight stop it carries is half the answer. The options arrive already sorted,
 * so "best" is simply the first match.
 */
export function pickSameRouteAlight(
  options: AlightOption[] | null | undefined,
  routeId: string | null | undefined
): AlightOption | null {
  if (!routeId) return null
  return (
    (options || []).find(
      (o) => onwardRouteOfItinerary(o.itinerary) === routeId
    ) ?? null
  )
}
