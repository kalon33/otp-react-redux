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
import { findStopTimeIndex, liveStopArrival } from './alight-optimizer'
import { LIVE_REALTIME_STATES } from './departure-anchor'
import { tripIdsMatch } from './trip-id'
import { vehicleShortOfBoardStop } from './transit-trust'
import type { BoardVehicleEvidence } from './transit-trust'
import type {
  LiveTimePoint,
  TripAnchor,
  TripStopTime
} from './alight-optimizer'

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
 * The two spellings of one trip id — as given, relay-decoded, and decoded
 * minus the `Trip:` prefix — and the match across them. Both moved to
 * `./trip-id` on 2026-09-21 so `departure-anchor` can use them without an
 * import cycle (it is where `LIVE_REALTIME_STATES` above comes from); they are
 * re-exported here because this is where every current caller imports them
 * from. `VHJpcDoxOjEzNDYwNTI` -> `Trip:1:1346052` -> `1:1346052`.
 */
export { tripIdAliases, tripIdsMatch } from './trip-id'

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

/**
 * The trip query's board point, with its SCHEDULE never passed off as live.
 *
 * `liveStopArrival` calls any stop time under `UPDATED`/`ADDED`/`MODIFIED`
 * realtime. At the boarding stop that is not good enough: the trip query asks
 * for ARRIVAL fields only, and on the Orange Line OTP answers the boarding
 * stop with the timetable under an UPDATED flag while every stop after it
 * carries the real delay. Measured 2026-09-22 (backlog 26.1, session
 * `mucordp1-jqcrp2`, trip `1:1346857` at `1:56831`): from 08:09:46 to the end
 * of the recording the stop time read `realtimeState UPDATED, arrivalDelay 0,
 * realtimeArrival == scheduledArrival` (08:15:00) — the stop before it
 * SCHEDULED, the stop after it +496 s at 08:19:05 and climbing to +1 376 s —
 * while the stop query for the same trip at the same stop said 08:24:39. On
 * 09-21 (21.1, trip `1:1346052`) it was the same shape: 08:26:00 published
 * UPDATED with no delay, +5m27s at the stop.
 *
 * So a trip-query board time whose realtime value IS its scheduled value is
 * handed on as the schedule (`realtime: false`). Nothing is lost when it is
 * true: the stop poll's own live row still wins in `resolveBoardDeparture`,
 * and `mergeLiveTimePoint` keeps the previous value rather than walk a
 * displayed time backwards. What it stops is 08:22:09 on 09-22 — 08:15:00
 * published `boardRealtime: true` for 17 minutes after the stop poll went
 * stale. Board only: the ALIGHT side still reads `liveStopArrival` unchanged.
 */
export function tripQueryBoardPoint(
  stopTimes: TripStopTime[],
  stopGtfsId: string | null | undefined,
  stopName?: string | null,
  anchor?: TripAnchor | null
): LiveTimePoint | null {
  const point = liveStopArrival(stopTimes, stopGtfsId, stopName, anchor)
  if (!point?.realtime) return point
  const st = stopTimes[findStopTimeIndex(stopTimes, stopGtfsId, stopName)]
  if (
    st &&
    st.scheduledArrival != null &&
    st.realtimeArrival === st.scheduledArrival
  ) {
    return { ...point, realtime: false }
  }
  return point
}

/**
 * How far behind `now` a realtime board time may sit and still be read as
 * "this boarding is happening".
 *
 * A bus dwelling at the kerb legitimately carries a departure a few seconds
 * old, and the whole minute the feed publishes is itself up to 59 s coarse.
 * 90 s is MISSED_BUS_GRACE_REALTIME_MS — the same allowance the missed-bus
 * classifier already gives a realtime departure before it will call a bus
 * gone — so the two cannot disagree about when a realtime epoch has expired.
 */
export const REALTIME_BOARD_SPENT_AFTER_MS = 90000

/** What the board-time rules need to know about the rider and the bus. */
export interface BoardStopEvidence {
  /** `leg.from.stop.gtfsId` — the stop this boarding happens at. */
  boardStopId?: string | null
  /** The rider is at the boarding stop (RIDER_AT_BOARD_STOP_M). */
  riderAtBoardStop?: boolean
  /** The rider is verifiably aboard this leg's vehicle (the sticky fact). */
  riding: boolean
  /** The trip's own vehicle record, or null when there is none. */
  vehicle?: BoardVehicleEvidence | null
}

/**
 * Is this "realtime" board time SPENT — a feed prediction already in the past
 * that nothing on the ground supports, and therefore not a wait basis?
 *
 * MEASURED 2026-09-15, session `mu346i5y-ng2uqc` (backlog 17.18). Leg 0's
 * board epoch took ~40 distinct values in 13 minutes, and one class arrived
 * with `boardRealtime: true` while sitting minutes in the past: 15:26:00 at
 * 15:36:33, 15:31:00 at 15:43:28, 15:33:00 at 15:44:06 — the feed's own
 * prediction for a from-stop the bus had already passed, one per itinerary
 * swap. `getEffectiveBoardTimeMs` trusts `boardRealtime` first, so these reach
 * every surface that quotes a wait.
 *
 * Two things were re-measured on 2026-09-22 before this was written, and both
 * corrected the row:
 *
 *  - all three of those values landed with the riding fact STANDING (SET_RIDING
 *    15:36:27, held to 15:46:22 and re-set 15:46:25), so they never reached the
 *    wait math: aboard, there is no boarding left to quote. The class that DID
 *    reach it is a fourth value the row never named — leg 1's 15:35:00,
 *    dispatched four times between 15:35:15 and 15:36:17, 15-78 s in the past,
 *    with the bus still 70 s from the kerb.
 *  - on that ride 21.1 already answers all four: the stop-level poll held
 *    `1:1346556` at I-35W & 98th St as `UPDATED, realtimeDeparture 15:40:38`
 *    (scheduled 15:35:00, delay 338 s) at the very instant the trip query
 *    published 15:35:00 under an UPDATED flag. `resolveBoardDeparture` takes
 *    the stop's answer and the past value never appears.
 *
 * So this is the LAST RESORT, for the case 21.1 cannot cover: no live stop-level
 * entry for this trip, or a stop snapshot older than STOP_SNAPSHOT_MAX_AGE_MS —
 * which is every transit leg the tick is not currently re-polling (see that
 * constant). There the trip query's past "realtime" epoch is all there is.
 *
 * The rule, and what each arm is for:
 *
 *  - the epoch must be more than {@link REALTIME_BOARD_SPENT_AFTER_MS} old;
 *  - the rider must have no riding fact — aboard, the board time is about
 *    something already done and no surface quotes it anyway;
 *  - and the bus's OWN record must place it short of the stop. That is the
 *    contradiction: the feed says this run left, and the same feed's vehicle
 *    says it has not got there. Absent or stale vehicle data answers FALSE —
 *    the epoch is left alone. "The vehicle is not yet at the stop" is a claim
 *    that needs evidence, and a missing record is not a "no" (the same policy
 *    `vehiclePassedStopOnTrip` and `isVehicleRecordFresh` already state).
 *
 * A spent point is demoted, never deleted: the caller hands it on with
 * `realtime: false, isFloor: true`, which is 17.6's existing vocabulary for
 * "a bound, not a prediction". Every wait-quoting surface already refuses one —
 * `legBoard`/`buildLiveItinerary` keep the plan's own startTime, TransitProgress
 * drops the "Waiting at X · time" clock, `liveBoardEpochFor` returns null so no
 * push quotes minutes from it, and `getEffectiveBoardTimeMs` falls to the
 * override or the plan. Nothing new has to learn about this rule.
 */
export function realtimeBoardIsSpent(
  point: LiveTimePoint | null | undefined,
  nowMs: number,
  evidence: BoardStopEvidence,
  spentAfterMs: number = REALTIME_BOARD_SPENT_AFTER_MS
): boolean {
  if (!point?.realtime) return false
  if (!Number.isFinite(point.epoch)) return false
  if (point.epoch >= nowMs - spentAfterMs) return false
  if (evidence.riding) return false
  return vehicleShortOfBoardStop(
    evidence.vehicle,
    evidence.boardStopId,
    evidence.riderAtBoardStop
  )
}

/**
 * The same point, demoted to a bound. Separate from the test so a caller that
 * only wants the verdict (a rule, a report) never has to build the value.
 */
export function demoteSpentBoardPoint(point: LiveTimePoint): LiveTimePoint {
  return { ...point, isFloor: true, projected: false, realtime: false }
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
