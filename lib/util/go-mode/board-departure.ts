/**
 * board-departure.ts — "the best known departure for (stop, trip)".
 *
 * Go Mode has TWO live sources for the same moment and they do not always
 * agree. The tick's board time has always come from the TRIP query
 * (`findTrip` -> `transitIndex.trips[tripId].stopTimes` -> `liveStopArrival`);
 * the boarding stop is also polled every ~20 s by `findStopTimesForStop`, and
 * that answer lands in `transitIndex.stops[stopGtfsId].stoptimesForPatterns`,
 * which is what the pacing card reads.
 *
 * MEASURED 2026-09-21, session mub9m39o-9pmdbh, 08:26:24 (backlog 21.1). One
 * instant, one stop (`1:56831`), one trip (`1:1346052`), both answers flagged
 * `realtimeState: UPDATED`:
 *
 *   FIND_TRIP_RESPONSE            serviceDay 1789966800, realtimeArrival 30360
 *                                 == scheduledArrival  -> 08:26:00
 *   FIND_STOP_TIMES_FOR_STOP_RESP serviceDay 1789966800, realtimeDeparture
 *                                 30687, scheduledDeparture 30360,
 *                                 departureDelay 327 -> 08:31:27
 *
 * The trip query published the SCHEDULE under an UPDATED flag; the stop query
 * had the +5m27s prediction. `SET_LIVE_LEG_TIMES` carried boardEpoch
 * 1789997160000 (08:26:00) with `boardRealtime: true` for 17 consecutive ticks
 * (08:20:55-08:26:45) while the card, reading the stop poll, said 08:31 — and
 * the rider, watching a bus that was plainly late, wrote "This is clearly a
 * delayed bus! Always prio the real times!".
 *
 * So: when the stop-level poll holds a LIVE departure for the same trip at
 * that stop, it wins. It is the later-published, stop-specific prediction, and
 * it is the number the rider is already looking at. Nothing here scores or
 * ranks anything — the alight optimizer's scoring is untouched — and the
 * resolved point is still handed to `mergeLiveTimePoint`, so the monotonic
 * display guarantees are unchanged.
 *
 * Why the two OTP queries disagree is NOT answered here. `resolveBoardDeparture`
 * reports the gap so the next ride can measure it (see
 * `BOARD_SOURCE_DISAGREEMENT_MS` and `recordBoardTimeDisagreement`).
 */
import { LIVE_REALTIME_STATES } from './departure-anchor'
import type { LiveTimePoint } from './alight-optimizer'

/** Where a published board epoch actually came from. */
export type BoardSource = 'stop' | 'trip'

/**
 * How far apart the two sources must be before the disagreement is worth a
 * line in the debug stream. Realtime jitter of a few seconds between two polls
 * is normal; 08-26-24's gap was 327 s.
 */
export const BOARD_SOURCE_DISAGREEMENT_MS = 60000

/**
 * How old a stop-times snapshot may be and still outrank the trip query.
 *
 * Not every boarding stop is re-polled. `startGoMode` fetches stop times once
 * for EVERY transit leg's boarding stop, and only the stop the rider is
 * currently walking/riding toward is re-fetched (`forceFetch: true`) on the
 * ~20 s tick. A second transit leg's snapshot can therefore be an hour old,
 * and an hour-old `realtimeDeparture` is not a better answer than a trip query
 * refreshed this second — it is the same kind of mistake in the other
 * direction. Nine poll intervals is generous for the live case and excludes
 * the trip-start snapshot of a leg still an hour away.
 */
export const STOP_SNAPSHOT_MAX_AGE_MS = 180000

/**
 * OTP2's stop query returns `trip.id` as the relay global id — base64 of
 * `Trip:<feed>:<id>`, unpadded (`VHJpcDoxOjEzNDYwNTI` -> `Trip:1:1346052`) —
 * while the leg, the riding fact and `findTrip` all use the gtfsId
 * (`1:1346052`). Without this the two sources can never be matched at all.
 *
 * Deliberately strict: a decode only counts when it yields printable ASCII
 * beginning `Trip:`. A bare numeric gtfsId is itself valid base64 and would
 * otherwise "decode" to bytes that could collide with something.
 */
function decodeTripGlobalId(raw: string): string | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return null
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  let decoded: string
  try {
    decoded =
      typeof atob === 'function'
        ? atob(padded)
        : // eslint-disable-next-line no-undef
          Buffer.from(padded, 'base64').toString('binary')
  } catch {
    return null
  }
  if (!/^Trip:[\x20-\x7e]+$/.test(decoded)) return null
  return decoded
}

/** Every spelling of one trip id: as given, decoded, and decoded-minus-prefix. */
export function tripIdAliases(raw: string | null | undefined): string[] {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return []
  const decoded = decodeTripGlobalId(s)
  return decoded ? [s, decoded, decoded.slice('Trip:'.length)] : [s]
}

/** Whether two trip ids name the same run, across the two id spellings. */
export function tripIdsMatch(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const aliasesA = tripIdAliases(a)
  if (!aliasesA.length) return false
  return tripIdAliases(b).some((alias) => aliasesA.indexOf(alias) >= 0)
}

/**
 * The live departure the stop-level poll holds for this trip at this stop, or
 * null when it holds none.
 *
 * Only a LIVE entry is returned. The stop poll's schedule rows say nothing the
 * trip query does not already say, and preferring them would swap one static
 * timetable for another while claiming a source change.
 *
 * `stopData` is `state.otp.transitIndex.stops[stopGtfsId]` exactly as the
 * reducer stores the `FIND_STOP_TIMES_FOR_STOP_RESPONSE` payload.
 */
export function stopLevelBoardDeparture(
  stopData: any,
  tripId: string | null | undefined,
  nowMs?: number,
  maxAgeMs: number = STOP_SNAPSHOT_MAX_AGE_MS
): LiveTimePoint | null {
  if (!stopData || !tripId) return null
  // A payload with no stamp predates fetchedAtMs (a persisted session, an
  // older replay fixture): accept it rather than make the fix inert there.
  if (
    nowMs != null &&
    stopData.fetchedAtMs != null &&
    nowMs - stopData.fetchedAtMs > maxAgeMs
  ) {
    return null
  }
  const groups = stopData.stoptimesForPatterns
  if (!Array.isArray(groups)) return null
  for (const group of groups) {
    const stoptimes = group?.stoptimes
    if (!Array.isArray(stoptimes)) continue
    for (const st of stoptimes) {
      if (!st) continue
      // gtfsId first for any deployment that returns it; id is what OTP2 sends.
      if (!tripIdsMatch(st.trip?.gtfsId ?? st.trip?.id, tripId)) continue
      // serviceDay <= 0 means no service-date context — the epoch would be
      // garbage (same guard liveStopArrival applies).
      if (st.serviceDay == null || st.serviceDay <= 0) continue
      if (!LIVE_REALTIME_STATES.has(st.realtimeState)) continue
      if (st.realtimeDeparture == null) continue
      return {
        epoch: (st.serviceDay + st.realtimeDeparture) * 1000,
        projected: false,
        realtime: true
      }
    }
  }
  return null
}

export interface BoardDepartureResolution {
  /** stop epoch - trip epoch, or null when only one source had a value. */
  disagreementMs: number | null
  /** The point to hand to mergeLiveTimePoint. */
  point: LiveTimePoint | null
  source: BoardSource
  /** The stop-level live value, for the record. Null when there was none. */
  stopEpoch: number | null
  /** The trip-level value, for the record. */
  tripEpoch: number | null
}

/**
 * Pick the board departure to publish for one leg.
 *
 * The rule is the rider's: a real time beats a timetable, and between two
 * "realtime" answers the stop-specific one wins, because that is the one the
 * prediction is actually about (and the one already on their screen).
 *
 * The result is a POINT, not a merged value — the caller still runs it through
 * `mergeLiveTimePoint`, which is what keeps a realtime dropout from walking a
 * displayed time backwards.
 */
export function resolveBoardDeparture(input: {
  /** Tick clock. Omitted, the snapshot's age is not checked. */
  nowMs?: number
  stopData?: any
  tripId?: string | null
  /** What liveStopArrival made of the trip query. */
  tripPoint: LiveTimePoint | null
}): BoardDepartureResolution {
  const { nowMs, stopData, tripId, tripPoint } = input
  const stopPoint = stopLevelBoardDeparture(stopData, tripId, nowMs)
  const tripEpoch = tripPoint?.epoch ?? null
  if (!stopPoint) {
    return {
      disagreementMs: null,
      point: tripPoint,
      source: 'trip',
      stopEpoch: null,
      tripEpoch
    }
  }
  return {
    disagreementMs: tripEpoch == null ? null : stopPoint.epoch - tripEpoch,
    point: stopPoint,
    source: 'stop',
    stopEpoch: stopPoint.epoch,
    tripEpoch
  }
}

/** Whether a resolution is worth a line in the debug stream. */
export function boardSourcesDisagree(
  resolution: BoardDepartureResolution,
  thresholdMs: number = BOARD_SOURCE_DISAGREEMENT_MS
): boolean {
  return (
    resolution.disagreementMs != null &&
    Math.abs(resolution.disagreementMs) > thresholdMs
  )
}

/**
 * The provenance of the epoch actually published, after the merge.
 *
 * `mergeLiveTimePoint` may return the resolved point, or carry the previous
 * value forward (clamped). Saying "stop" for a value the merge did not take
 * from the stop poll would be a lie, so match on the epoch and otherwise carry
 * the previous record's source.
 */
export function publishedBoardSource(
  merged: LiveTimePoint | null,
  resolution: BoardDepartureResolution,
  prevSource: BoardSource | undefined
): BoardSource | undefined {
  if (!merged) return undefined
  if (resolution.point && merged.epoch === resolution.point.epoch) {
    return resolution.source
  }
  return prevSource
}
