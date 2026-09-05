import type { Itinerary } from '@opentripplanner/types'

import {
  demoteTokenTransitHops,
  demoteTokenTransitHopsBy,
  transitRouteSignature
} from '../itinerary'

import { calculateDistance } from './position-matching'
import { getLegRouteId } from './departure-anchor'
import { legTripId } from './leg-merge'

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
 * Where a BUILT onboard itinerary actually puts the rider back on the pavement:
 * the end of its leg on the boarded trip.
 *
 * An alight option's `stopId`/`stopName` are the PLANNING ANCHOR — the stop its
 * onward plan was fetched from — and that is not always where the ride ends.
 * OTP's onward plan legitimately opens with the boarded trip CONTINUING (the
 * `otherThanPreferredRoutesPenalty` bias at the fetch makes it common), and
 * `mergeAdjacentSameTripLegs` then folds that leg into the synthesized bus leg,
 * correctly, into one continuous ride running on to ITS alight stop. The anchor
 * is then a stop the rider rides straight past.
 *
 * Returns null when the itinerary carries no leg on that trip, and when the
 * boarded trip id is unknown — callers keep the anchor in both cases.
 */
export function builtAlightStop(
  itinerary: Itinerary | null | undefined,
  boardedTripId: string | null | undefined
): { stopId: string; stopName: string } | null {
  if (!boardedTripId) return null
  const leg: any = (itinerary?.legs || []).find(
    (l: any) => l.transitLeg && legTripId(l) === boardedTripId
  )
  const to = leg?.to
  const stopId = to?.stop?.gtfsId || to?.stop?.id || to?.stopId
  if (!stopId || !to?.name) return null
  return { stopId, stopName: to.name }
}

/**
 * The absolute epoch (ms) a trip reaches a given stop, preferring OTP's live
 * (GPS-fed) realtimeArrival and falling back to the schedule. Returns null when
 * the stop isn't in this trip's stop times or has no usable time. Used to keep
 * the trip-overview transit rows current mid-ride.
 */
/**
 * Where the bus actually is right now, for projecting the rest of its run.
 *
 * Supplied ONLY for the trip the rider is verifiably aboard. For a leg they
 * have not boarded yet, "now" says nothing about where that bus is, and the
 * absolute timetable is the honest answer.
 */
export interface TripAnchor {
  nextStopId?: string | null
  nowMs: number
  userPos: LatLon | null
}

export function liveStopArrival(
  stopTimes: TripStopTime[],
  stopGtfsId: string | null | undefined,
  stopName?: string | null,
  anchor?: TripAnchor | null
): { epoch: number; projected?: boolean; realtime: boolean } | null {
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
  if (st.scheduledArrival == null) return null

  // No realtime for this stop. The absolute timetable epoch is the WRONG answer
  // for a bus already running late: it is a moment that has passed, so
  // mergeLiveTimePoint clamps it to nowMs and it then tracks the clock instead
  // of predicting anything. getDownstreamStops has always projected instead —
  // now + the scheduled running time still ahead — and this is the same basis,
  // so the trip sheet and the alight optimizer stop disagreeing about one stop.
  //
  // Only forwards. A stop BEHIND the anchor is history: the bus really did pass
  // it in the past, and projecting would invent a future for something already
  // done.
  if (anchor) {
    const anchorIdx = findAnchorIndex(
      stopTimes,
      anchor.nextStopId,
      anchor.userPos
    )
    const anchorDeparture = stopTimes[anchorIdx]?.scheduledDeparture
    if (anchorDeparture != null && idx >= anchorIdx) {
      return {
        epoch: anchor.nowMs + (st.scheduledArrival - anchorDeparture) * 1000,
        projected: true,
        realtime: false
      }
    }
  }

  return {
    epoch: (st.serviceDay + st.scheduledArrival) * 1000,
    realtime: false
  }
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
  prev: { epoch: number; projected?: boolean; realtime: boolean } | null,
  next: { epoch: number; projected?: boolean; realtime: boolean } | null,
  nowMs: number
): { epoch: number; projected?: boolean; realtime: boolean } | null {
  if (next?.realtime) return next
  // A fresh projection is anchored to where the bus is NOW, so it supersedes a
  // stale one rather than being held back by "never walk backwards" — that rule
  // exists to stop a schedule fallback dragging a live time into the past, not
  // to freeze an estimate that is being recomputed every poll.
  if (next?.projected) return next
  const kept = prev ?? next
  if (!kept) return null
  return {
    epoch: Math.max(kept.epoch, nowMs),
    projected: kept.projected,
    realtime: false
  }
}

/**
 * How coarse the between-polls clamp is allowed to be.
 *
 * The clamp runs on the 1 Hz position tick, and until 2026-09-04 it raised a
 * stale epoch to `nowMs` exactly — a new value every single second, and a
 * SET_LIVE_LEG_TIMES dispatch behind each one. Measured on the kerb ride
 * (session mtn4ui3s-xfjx8m): 11:17:30 → 11:22:42, boardEpoch equal to the
 * current second on all 312 consecutive ticks, against a poll path that emits
 * one every ~20 s. Nothing displays seconds: the trip sheet, the pacing card
 * and the alight banner all round to the minute. Raising to the minute FLOOR
 * therefore changes no displayed value and re-arms the clamp at most once a
 * minute per leg.
 */
export const LIVE_TIME_CLAMP_GRANULARITY_MS = 60000

/**
 * mergeLiveTimePoint clamps at merge time, but merges only run once per
 * refresh poll (20 s apart) — between polls the clock keeps walking, so a
 * non-live epoch can sit up to a full poll interval in the past (seen
 * 2026-07-21: an end-of-service realtime dropout left the alight time 6 s
 * stale). Re-raise every non-live epoch that has fallen behind the current
 * minute. Returns the updated record, or null when nothing actually moved so
 * callers can skip the dispatch.
 *
 * Two rate rules, both from the 2026-09-04 ride:
 *
 *  - the floor is LIVE_TIME_CLAMP_GRANULARITY_MS, not `nowMs`, so a value
 *    that is already inside the displayed minute is left alone;
 *  - a BOARD epoch is bridged across the poll gap ONCE. A departure is a
 *    one-way fact: the bus leaves when it leaves, and a boarding still being
 *    projected forward on the hundredth tick is not late data, it is a run
 *    that has gone. Marking the record (`boardClamped`) stops the walk;
 *    the next refresh poll rebuilds the entry from scratch and the flag goes
 *    with it, so genuinely fresh data is never held back. What happens to a
 *    departed run is then classifyMissedBus's story to tell, and it can tell
 *    it, now that getEffectiveBoardTimeMs reads the per-field boardRealtime
 *    flag instead of the leg-level OR that made this clamped value look like
 *    a live prediction.
 */
export function clampNonLiveLegTimes<
  T extends {
    alightEpoch: number | null
    alightRealtime?: boolean
    boardClamped?: boolean
    boardEpoch: number | null
    boardRealtime?: boolean
    realtime: boolean
  }
>(
  times: Record<number, T> | null | undefined,
  nowMs: number
): Record<number, T> | null {
  if (!times) return null
  const floorMs =
    Math.floor(nowMs / LIVE_TIME_CLAMP_GRANULARITY_MS) *
    LIVE_TIME_CLAMP_GRANULARITY_MS
  let changed = false
  const out: Record<number, T> = {}
  for (const key of Object.keys(times)) {
    const idx = Number(key)
    const t = times[idx]
    let next = t
    if (
      !(t.alightRealtime ?? t.realtime) &&
      t.alightEpoch != null &&
      t.alightEpoch < floorMs
    ) {
      next = { ...next, alightEpoch: floorMs }
    }
    let boardRaised = false
    if (
      !(t.boardRealtime ?? t.realtime) &&
      !t.boardClamped &&
      t.boardEpoch != null &&
      t.boardEpoch < floorMs
    ) {
      next = { ...next, boardClamped: true, boardEpoch: floorMs }
      boardRaised = true
    }
    // Raising the board time past a still-past alight time inverts the leg —
    // the rider would be shown arriving before they got on. Scoped to the
    // raise we just made: everywhere else board and alight are deliberately
    // independent, and a merely-late live pair is honest data, not an
    // inversion.
    //
    // WHICH end gives way depends on which one is evidence. A schedule-only
    // alight is bookkeeping and moves with the board (8/2). A REALTIME alight
    // is the feed's own statement about when this trip reaches the stop, and
    // on 2026-09-01 moving it was trip-ending: the Orange Line's alight sat in
    // the past at 13:50:00Z, flagged live and re-written by every 20 s poll,
    // while the schedule-only board was raised to `now` on every 1 Hz tick and
    // dragged the alight up with it. The trip's live end therefore became
    // `now` once a second, so `timeRemaining` printed exactly 400.0 s — the
    // trailing legs' duration — on every tick while `distanceToDestination`
    // fell 1745 -> 1648 m, and `estimatedArrival` slid with the wall clock and
    // could never arrive. Once per poll the real figure got through, and the
    // rider saw 2.7 min / 13:51:41 and then 6.7 min / 13:55:38 one second
    // apart. So when the alight is live, the BOARD gives way instead: a rider
    // whose bus has already reached the alight stop boarded no later than
    // that, and the leg stays the right way round either way.
    if (
      boardRaised &&
      next.alightEpoch != null &&
      next.boardEpoch != null &&
      next.alightEpoch < next.boardEpoch
    ) {
      next =
        next.alightRealtime ?? next.realtime
          ? { ...next, boardEpoch: next.alightEpoch }
          : { ...next, alightEpoch: next.boardEpoch }
    }
    // Changed means the times MOVED, not that a raise was attempted. The
    // inversion branch above routinely hands a raised board straight back to
    // where it started (2026-09-04 11:22:29 → 11:22:38: ten consecutive
    // dispatches of a byte-identical record, because the board was capped
    // back onto a live alight that had not moved). Compare the answer, not
    // the intent.
    if (
      next !== t &&
      (next.alightEpoch !== t.alightEpoch || next.boardEpoch !== t.boardEpoch)
    ) {
      changed = true
      out[idx] = next
    } else {
      out[idx] = t
    }
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

/**
 * How long the optimizer waits for ALL candidate plans before ranking whatever
 * came back.
 *
 * The per-request deadline in actions/api (GO_MODE_FETCH_TIMEOUT_MS, 12 s) is
 * the first line: it makes each candidate settle. This is the second, and it
 * exists because the first one is a promise about one fetch and this is a
 * promise to the rider about the whole answer. Before 2026-09-02 there was
 * neither: `Promise.all` over five candidate plans resolved only when the last
 * one did, and on 2026-08-31 three of the five never did — the rider watched an
 * empty panel for 9m11s (17:22:25 to CLEAR_ONBOARD at 17:31:36) and no state
 * anywhere said the search had failed.
 *
 * 15 s, comfortably past the per-request deadline so a straggler is normally
 * killed by its own timeout and this never fires. It is the backstop for the
 * failure the 08-31 log actually shows: a request that settles by no route at
 * all.
 */
export const ONBOARD_CANDIDATE_SETTLE_MS = 15000

/**
 * Why a candidate was substituted rather than answered.
 *
 * `'rejected'` is final — that request is over and nothing will arrive later.
 * `'timeout'` is not: the request is still in flight, and it is the only case
 * where a straggler can still land (see `onLate`). The optimizer counts them
 * apart so the rider is only told "still checking" about candidates that
 * really might still answer.
 */
export type UnsettledReason = 'rejected' | 'timeout'

/**
 * Wait for candidate plans, but not forever: whatever has settled by the
 * deadline is returned, and anything still outstanding is replaced by
 * `onTimeout(index, reason)` — for the optimizer, a result marked `error`,
 * which rankAlightOptions already skips.
 *
 * Two of five plans are a worse answer than five of five and a far better one
 * than no answer, which is what waiting for all five bought on 08-31.
 *
 * `onLate` closes the other half of that trade: a plan that lands AFTER the
 * deadline is otherwise thrown away, and the answer the rider is looking at
 * stays permanently short. This stays a pure utility — it has no store and no
 * idea what a re-rank would mean — so it only reports the late value and lets
 * the caller decide whether it is still safe to use.
 */
export async function settleCandidatePlans<T>(
  plans: Array<Promise<T>>,
  timeoutMs: number,
  onTimeout: (index: number, reason: UnsettledReason) => T,
  onLate?: (index: number, value: T) => void
): Promise<T[]> {
  if (!plans.length) return []
  const settled: Array<{ done: boolean; value?: T }> = plans.map(() => ({
    done: false
  }))
  // Indices the caller was handed a substitute for. Filled synchronously
  // below, before this function returns, so a plan whose `.then` runs in a
  // later microtask can never be reported both ways.
  const substituted = new Set<number>()
  let handedOff = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let timer: any = null
  const tracked = plans.map((plan, index) =>
    plan.then(
      (value) => {
        settled[index] = { done: true, value }
        // Landed after the answer was already handed to the caller.
        if (handedOff && substituted.has(index) && onLate) onLate(index, value)
      },
      () => {
        // A rejected plan is a failed candidate, not a failed optimize. The
        // fetch layer resolves rather than rejects, so this is belt and braces.
        settled[index] = { done: true, value: onTimeout(index, 'rejected') }
      }
    )
  )
  const deadline =
    timeoutMs > 0
      ? new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        })
      : null
  await (deadline
    ? Promise.race([Promise.all(tracked), deadline])
    : Promise.all(tracked))
  if (timer) clearTimeout(timer)
  const results = settled.map((entry, index) => {
    if (entry.done) return entry.value as T
    substituted.add(index)
    return onTimeout(index, 'timeout')
  })
  handedOff = true
  return results
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
/**
 * How far past the alight an onward plan may still end. Generous on purpose —
 * a long suburban wait is a real answer — but short of a service-day rollover,
 * which is the thing that was being offered.
 */
const MAX_ONWARD_HORIZON_MS = 6 * 60 * 60 * 1000

function isReachableItinerary(
  itin: Itinerary,
  busArrivalEpoch: number,
  nowMs: number | null
): boolean {
  const start = Number(itin.startTime)
  if (!Number.isFinite(start)) return true
  if (start + REACHABLE_TOLERANCE_MS < busArrivalEpoch) return false
  if (nowMs != null && start + REACHABLE_TOLERANCE_MS < nowMs) return false
  // ...and not so far out that it is really tomorrow's trip. Only the lower
  // bound existed, so an onward connection on the NEXT service day was a legal,
  // rankable option: its overnight gap landed in the itinerary span and
  // timeRemaining reported 34 hours for a ride ending in fifteen minutes. A
  // rider getting off a bus is choosing what to do next, not next morning.
  const end = Number(itin.endTime)
  if (Number.isFinite(end) && end - busArrivalEpoch > MAX_ONWARD_HORIZON_MS) {
    return false
  }
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
export function journeySignature(stopId: string, itinerary: Itinerary): string {
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
    tokenHopMaxMeters,
    tokenHopToleranceMs,
    walkOnlyMax = 1200
  }: {
    keepRouteId?: string | null
    limit?: number
    nowMs?: number | null
    tokenHopMaxMeters?: number
    tokenHopToleranceMs?: number
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

  // An onward plan that ends with a token bus hop does not get to sit above the
  // same journey without it (4.2). Applied BEFORE the dedupe and the cap, so a
  // hop-free sibling that the arrival sort had pushed past `limit` gets its
  // place back rather than being cut and then not found. Reorders only —
  // keepRouteId's held slot below still works off the full deduped list, so the
  // rider's own route can never be demoted out of the answer.
  const ordered = demoteTokenTransitHopsBy(
    scored,
    (option) => option.itinerary,
    { maxHopMeters: tokenHopMaxMeters, toleranceMs: tokenHopToleranceMs }
  )

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
  for (const option of ordered) {
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

/**
 * One row of the onboard "where do you want to get off?" list.
 *
 * `option` is what the row renders and what a tap starts; `variants` is every
 * option that folded into it, `option` first.
 */
export interface OnboardOptionGroup<T> {
  option: T
  variants: T[]
}

/** The itinerary an onboard option DISPLAYS: current-bus leg included. */
function displayItineraryOf(option: {
  displayItinerary?: Itinerary
  itinerary: Itinerary
}): Itinerary {
  return option.displayItinerary || option.itinerary
}

/**
 * Fold the ranked alight options into display rows, the way the planner's
 * results list folds its itineraries.
 *
 * The rider, 2026-08-27: *"on the already on the bus search they aren't
 * stacked, just a list of the same routes."* They were right — five ranked
 * options off one bus are routinely the SAME route chain reached from five
 * different alight stops, and `mergeByRouteSignature` (which fixed exactly
 * this on the planner path, `0d37eed2`) is applied in
 * narrative-itineraries.js and nowhere else. So this is the same idiom on the
 * onboard path: group by `transitRouteSignature` of the displayed itinerary,
 * keep the best-ranked member as the row, and hang the rest off it for the
 * drill-down (the alight stop each one uses is a real choice — it can be a
 * mile of closing bike either way — so nothing is dropped).
 *
 * An itinerary with no transit after the bus has an empty signature; those are
 * NOT grouped together, for the same reason `itinerariesAreEqual` refuses to —
 * "bike from 98th St" and "bike from Nicollet" share nothing but the absence
 * of a route.
 *
 * Rows are then reordered by `demoteTokenTransitHops`, which the planner list
 * applies to its own merged rows: a 602 m hop that ends in a 1743 m bike does
 * not get to sit above the same journey without it. Reorder only; nothing is
 * removed.
 */
export function groupAlightOptionsByRoute<
  T extends { displayItinerary?: Itinerary; itinerary: Itinerary }
>(
  options: T[] | null | undefined,
  {
    maxHopMeters,
    toleranceMs
  }: { maxHopMeters?: number; toleranceMs?: number } = {}
): Array<OnboardOptionGroup<T>> {
  const groups: Array<OnboardOptionGroup<T>> = []
  const bySignature = new Map<string, OnboardOptionGroup<T>>()

  ;(options || []).forEach((option) => {
    if (!option) return
    const signature = transitRouteSignature(displayItineraryOf(option))
    const existing = signature ? bySignature.get(signature) : undefined
    if (existing) {
      existing.variants.push(option)
      return
    }
    const group: OnboardOptionGroup<T> = { option, variants: [option] }
    if (signature) bySignature.set(signature, group)
    groups.push(group)
  })

  if (groups.length < 2) return groups

  // demoteTokenTransitHops is a stable partition over itineraries, so tag each
  // row's displayed itinerary with its position, reorder, and read the rows
  // back out. The tag is a shallow copy: nothing the caller holds is mutated.
  const tagged = groups.map((group, index) =>
    Object.assign({}, displayItineraryOf(group.option), {
      __groupIndex: index
    })
  )
  return demoteTokenTransitHops(tagged, { maxHopMeters, toleranceMs }).map(
    (itin) => groups[itin.__groupIndex]
  )
}
