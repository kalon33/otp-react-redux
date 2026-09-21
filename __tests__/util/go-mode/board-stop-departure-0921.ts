import {
  boardSourcesDisagree,
  publishedBoardSource,
  resolveBoardDeparture,
  stopLevelBoardDeparture,
  tripIdsMatch
} from '../../../lib/util/go-mode/board-departure'
import {
  liveStopArrival,
  mergeLiveTimePoint
} from '../../../lib/util/go-mode/alight-optimizer'

/**
 * Backlog 21.1. Session mub9m39o-9pmdbh, 2026-09-21, ride report §1.
 *
 * Every number below is lifted verbatim out of the day file
 * (~/otp-debug-logs/debug-2026-09-21.jsonl), from the three records stamped
 * 08:26:24 — one second, one stop (`1:56831`, I-35W & 98th St Station), one
 * trip (`1:1346052`, METRO Orange Line to downtown Minneapolis):
 *
 *   FIND_TRIP_RESPONSE   stopTimes[1:56831] = { realtimeState: 'UPDATED',
 *                        realtimeArrival: 30360, scheduledArrival: 30360,
 *                        scheduledDeparture: 30360, serviceDay: 1789966800 }
 *                        -> 1789997160000 = 08:26:00, i.e. the SCHEDULE,
 *                        published under an UPDATED flag.
 *
 *   FIND_STOP_TIMES_FOR_STOP_RESPONSE  stoptimesForPatterns[1:904:0:01]
 *                        entry for trip id 'VHJpcDoxOjEzNDYwNTI'
 *                        (base64 of 'Trip:1:1346052') =
 *                        { realtimeState: 'UPDATED', realtimeDeparture: 30687,
 *                          scheduledDeparture: 30360, departureDelay: 327,
 *                          serviceDay: 1789966800 }
 *                        -> 1789997487000 = 08:31:27, i.e. +5m27s.
 *
 *   SET_LIVE_LEG_TIMES   { boardEpoch: 1789997160000, boardRealtime: true,
 *                          boardProjected: false, boardIsFloor: false, ... }
 *                        — unchanged across 17 ticks, 08:20:55 to 08:26:45.
 *
 * The rider, looking at a bus that was plainly late: "This is clearly a
 * delayed bus! Always prio the real times!"
 */

/** Local midnight 2026-09-21 (America/Chicago), the service day both carry. */
const SERVICE_DAY = 1789966800
const TRIP_GTFS_ID = '1:1346052'
/** OTP2's relay global id for that trip, exactly as the stop query returned. */
const TRIP_GLOBAL_ID = 'VHJpcDoxOjEzNDYwNTI'
const BOARD_STOP_ID = '1:56831'
const BOARD_STOP_NAME = 'I-35W & 98th St Station'

/** 08:26:00 — what the trip query said, and what the tick published. */
const TRIP_EPOCH = 1789997160000
/** 08:31:27 — what the stop query said, and what the card showed. */
const STOP_EPOCH = 1789997487000
/** The instant all three records above are stamped. */
const NOW_MS = 1789997184000

/** The trip query's stop times, as the reducer stores them. */
const tripStopTimes = [
  {
    arrivalDelay: 0,
    realtimeArrival: 29880,
    realtimeState: 'SCHEDULED',
    scheduledArrival: 29880,
    scheduledDeparture: 29880,
    serviceDay: SERVICE_DAY,
    stop: {
      code: '56830',
      id: '1:56830',
      lat: 44.776176,
      lon: -93.278552,
      name: 'Burnsville Heart of the City Station'
    }
  },
  {
    arrivalDelay: 0,
    realtimeArrival: 30360,
    realtimeState: 'UPDATED',
    scheduledArrival: 30360,
    scheduledDeparture: 30360,
    serviceDay: SERVICE_DAY,
    stop: {
      code: '56831',
      id: BOARD_STOP_ID,
      lat: 44.825493,
      lon: -93.290872,
      name: BOARD_STOP_NAME
    }
  }
]

/** state.otp.transitIndex.stops['1:56831'], as the reducer stores it. */
const stopData = {
  code: '56831',
  gtfsId: BOARD_STOP_ID,
  lat: 44.825493,
  locationType: 'STOP',
  lon: -93.290872,
  name: BOARD_STOP_NAME,
  stoptimesForPatterns: [
    {
      pattern: {
        desc: 'METRO Orange Line ORANGE Downtown Minneapolis',
        headsign: 'ORANGE Downtown Minneapolis',
        id: '1:904:0:01',
        route: { gtfsId: '1:904' }
      },
      stoptimes: [
        // A schedule-only row for another run, first in the list on purpose:
        // the match must be on the TRIP, not on position.
        {
          departureDelay: 0,
          headsign: 'ORANGE Downtown Minneapolis',
          realtimeDeparture: 84480,
          realtimeState: 'SCHEDULED',
          scheduledDeparture: 84480,
          serviceDay: SERVICE_DAY,
          trip: {
            blockId: '187068',
            id: 'VHJpcDoxOjEzNDY5NDg',
            pattern: { id: 'UGF0dGVybjoxOjkwNDowOjAx' },
            route: { gtfsId: '1:904' }
          }
        },
        // The run the rider actually ended up boarding, 21m21s late.
        {
          departureDelay: 1281,
          headsign: 'ORANGE Downtown Minneapolis',
          realtimeDeparture: 30381,
          realtimeState: 'UPDATED',
          scheduledDeparture: 29100,
          serviceDay: SERVICE_DAY,
          trip: {
            blockId: '187101',
            id: 'VHJpcDoxOjEzNDY0NzY',
            pattern: { id: 'UGF0dGVybjoxOjkwNDowOjAx' },
            route: { gtfsId: '1:904' }
          }
        },
        // The planned trip: 5m27s late, and OTP knows it — here.
        {
          departureDelay: 327,
          headsign: 'ORANGE Downtown Minneapolis',
          realtimeDeparture: 30687,
          realtimeState: 'UPDATED',
          scheduledDeparture: 30360,
          serviceDay: SERVICE_DAY,
          trip: {
            blockId: '187117',
            id: TRIP_GLOBAL_ID,
            pattern: { id: 'UGF0dGVybjoxOjkwNDowOjAx' },
            route: { gtfsId: '1:904' }
          }
        }
      ]
    }
  ]
}

describe('board departure: the stop-level realtime wins (21.1)', () => {
  it('matches the relay global id against the leg gtfsId', () => {
    expect(tripIdsMatch(TRIP_GLOBAL_ID, TRIP_GTFS_ID)).toBe(true)
    expect(tripIdsMatch(TRIP_GTFS_ID, TRIP_GLOBAL_ID)).toBe(true)
    // A different run of the same route is not the same bus.
    expect(tripIdsMatch('VHJpcDoxOjEzNDY0NzY', TRIP_GTFS_ID)).toBe(false)
  })

  it('BEFORE: the trip query alone yields the scheduled 08:26:00', () => {
    const tripPoint = liveStopArrival(
      tripStopTimes,
      BOARD_STOP_ID,
      BOARD_STOP_NAME,
      null
    )
    // ...which is exactly the boardEpoch SET_LIVE_LEG_TIMES carried for 17
    // ticks, flagged live, while the bus was 5m27s down.
    expect(tripPoint).toEqual({ epoch: TRIP_EPOCH, realtime: true })
    expect(tripPoint?.epoch).toBe((SERVICE_DAY + 30360) * 1000)
  })

  it('finds the stop-level live departure for the same trip', () => {
    expect(stopLevelBoardDeparture(stopData, TRIP_GTFS_ID)).toEqual({
      epoch: STOP_EPOCH,
      projected: false,
      realtime: true
    })
  })

  it('AFTER: the published board time is 08:31:27, still realtime', () => {
    const tripPoint = liveStopArrival(
      tripStopTimes,
      BOARD_STOP_ID,
      BOARD_STOP_NAME,
      null
    )
    const resolution = resolveBoardDeparture({
      stopData,
      tripId: TRIP_GTFS_ID,
      tripPoint
    })
    expect(resolution.source).toBe('stop')
    expect(resolution.tripEpoch).toBe(TRIP_EPOCH)
    expect(resolution.stopEpoch).toBe(STOP_EPOCH)
    // 30687 - 30360 = 327 s, the departureDelay the stop query published.
    expect(resolution.disagreementMs).toBe(327000)

    // The merge is unchanged — the resolved point goes through it as before.
    const prev = {
      epoch: TRIP_EPOCH,
      isFloor: false,
      realtime: true
    }
    const board = mergeLiveTimePoint(prev, resolution.point, NOW_MS)
    expect(board).toEqual({
      epoch: STOP_EPOCH,
      projected: false,
      realtime: true
    })
    expect(board?.isFloor).toBeFalsy()
    expect(publishedBoardSource(board, resolution, 'trip' as const)).toBe(
      'stop'
    )
  })

  it('records the disagreement: 327 s is over the 60 s threshold', () => {
    const resolution = resolveBoardDeparture({
      stopData,
      tripId: TRIP_GTFS_ID,
      tripPoint: liveStopArrival(
        tripStopTimes,
        BOARD_STOP_ID,
        BOARD_STOP_NAME,
        null
      )
    })
    expect(boardSourcesDisagree(resolution)).toBe(true)
  })

  it('leaves the trip-level value alone when the sources agree', () => {
    const agreeing = {
      ...stopData,
      stoptimesForPatterns: [
        {
          ...stopData.stoptimesForPatterns[0],
          stoptimes: [
            {
              ...stopData.stoptimesForPatterns[0].stoptimes[2],
              departureDelay: 0,
              realtimeDeparture: 30360
            }
          ]
        }
      ]
    }
    const resolution = resolveBoardDeparture({
      stopData: agreeing,
      tripId: TRIP_GTFS_ID,
      tripPoint: liveStopArrival(
        tripStopTimes,
        BOARD_STOP_ID,
        BOARD_STOP_NAME,
        null
      )
    })
    expect(resolution.point?.epoch).toBe(TRIP_EPOCH)
    expect(resolution.disagreementMs).toBe(0)
    expect(boardSourcesDisagree(resolution)).toBe(false)
  })

  it('ignores the stop poll when it has no live row for this trip', () => {
    const scheduleOnly = {
      ...stopData,
      stoptimesForPatterns: [
        {
          ...stopData.stoptimesForPatterns[0],
          stoptimes: [
            {
              ...stopData.stoptimesForPatterns[0].stoptimes[2],
              realtimeState: 'SCHEDULED'
            }
          ]
        }
      ]
    }
    const tripPoint = liveStopArrival(
      tripStopTimes,
      BOARD_STOP_ID,
      BOARD_STOP_NAME,
      null
    )
    const resolution = resolveBoardDeparture({
      stopData: scheduleOnly,
      tripId: TRIP_GTFS_ID,
      tripPoint
    })
    expect(resolution.source).toBe('trip')
    expect(resolution.point).toBe(tripPoint)
    expect(resolution.disagreementMs).toBeNull()
    // No stop data at all behaves the same way.
    expect(
      resolveBoardDeparture({ stopData: null, tripId: TRIP_GTFS_ID, tripPoint })
        .point
    ).toBe(tripPoint)
  })

  it('will not prefer a stale snapshot over a fresh trip poll', () => {
    const tripPoint = liveStopArrival(
      tripStopTimes,
      BOARD_STOP_ID,
      BOARD_STOP_NAME,
      null
    )
    // A trip-start prefetch for a LATER leg's boarding stop is never
    // re-polled: on this ride the first one landed at 08:13:21, 3m3s before
    // the tick under test. Fresh enough at 20 s; not at an hour.
    const fresh = { ...stopData, fetchedAtMs: NOW_MS - 20000 }
    const stale = { ...stopData, fetchedAtMs: NOW_MS - 3600000 }
    expect(
      resolveBoardDeparture({
        nowMs: NOW_MS,
        stopData: fresh,
        tripId: TRIP_GTFS_ID,
        tripPoint
      }).point?.epoch
    ).toBe(STOP_EPOCH)
    const staleResolution = resolveBoardDeparture({
      nowMs: NOW_MS,
      stopData: stale,
      tripId: TRIP_GTFS_ID,
      tripPoint
    })
    expect(staleResolution.source).toBe('trip')
    expect(staleResolution.point?.epoch).toBe(TRIP_EPOCH)
    // An unstamped payload (persisted session, older fixture) still counts.
    expect(
      resolveBoardDeparture({
        nowMs: NOW_MS,
        stopData,
        tripId: TRIP_GTFS_ID,
        tripPoint
      }).point?.epoch
    ).toBe(STOP_EPOCH)
  })

  it('never walks a displayed time backwards on a realtime dropout', () => {
    // The stop poll goes quiet after publishing 08:31:27. The merge must keep
    // the later value and stop calling it live — the guarantee the 7/12 alight
    // regression bought, unchanged by this row.
    const prev = { epoch: STOP_EPOCH, isFloor: false, realtime: true }
    const resolution = resolveBoardDeparture({
      stopData: null,
      tripId: TRIP_GTFS_ID,
      // The trip query's stale schedule, no longer flagged live.
      tripPoint: { epoch: TRIP_EPOCH, realtime: false }
    })
    const board = mergeLiveTimePoint(prev, resolution.point, NOW_MS)
    expect(board?.epoch).toBe(STOP_EPOCH)
    expect(board?.realtime).toBe(false)
    expect(board?.isFloor).toBe(false)
    // Provenance is carried, not invented: the merge did not take the
    // resolved point, so the previous record's source stands.
    expect(publishedBoardSource(board, resolution, 'stop' as const)).toBe(
      'stop'
    )
  })
})
