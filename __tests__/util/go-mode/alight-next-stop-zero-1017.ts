/* globals describe, expect, it, jest, beforeAll, afterAll */
import FakeTimers from '@sinonjs/fake-timers'

import {
  ALIGHT_NEXT_STOP_ZERO_MIN_DELAY_S,
  tripQueryAlightPoint
} from '../../../lib/util/go-mode/board-departure'
import { liveStopArrival } from '../../../lib/util/go-mode/alight-optimizer'
import { refreshLiveLegTimes } from '../../../lib/actions/go-mode'
import fixture from '../../test-utils/mock-data/alight-next-stop-zero-1017.json'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * Backlog 57.1 — the arrival walked back to the timetable the moment the
 * rider's stop became the bus's NEXT stop.
 *
 * Ride `mvcx52b7-anqred`, 2026-10-17, DEV `2026.1016.2`. METRO Orange Line
 * trip `1:1368267`, alighting at I-35W & 66th St Station `1:52719`. The
 * fixture beside this test carries the two recorded FIND_TRIP_RESPONSE
 * payloads' `stopTimes` verbatim (`~/otp-debug-logs/debug-2026-10-17.jsonl`,
 * records `mvcx52b7-anqred-8zl` and `mvcx52b7-anqred.mvczonca-4menml-q`):
 *
 *   17:49:22  46th St (next) UPDATED  0 · 66th St UPDATED +242 · Knox +247
 *   17:49:53  46th St SCHEDULED       · 66th St UPDATED  0   · Knox +260
 *
 * SET_LIVE_LEG_TIMES leg 0 alightEpoch, recorded: 17:49:22 -> 17:54:02
 * (1792277642000), 17:49:53 -> 17:50:00 (1792277400000, alightRealtime true)
 * — four minutes early, and in the past before the bus reached the stop.
 * The 17:49:53 poll was the first after a cold relaunch, so there was no
 * previous alight time for `mergeLiveTimePoint` to hold; it would have passed
 * the value anyway, because it is flagged realtime.
 */

const f: any = fixture
const TRIP = '1:1368267'
const ALIGHT = '1:52719'
const ALIGHT_NAME = 'I-35W & 66th St Station'
const BOARD = '1:17781'
const LAST = '1:56830'

const snap = (label: string): any =>
  f.snapshots.find((s: any) => s.label === label)
const S_0922 = snap('17:49:22')
const S_0953 = snap('17:49:53')

/** 17:50:00 — the timetable, what was published at 17:49:53. */
const E_1750_00 = 1792277400000
/** 17:54:02 — the live value published at 17:49:22. */
const E_1754_02 = 1792277642000
/** 17:54:20 — 66th St's schedule (64200) + Knox's +260 s at 17:49:53. */
const E_1754_20 = 1792277660000

const clone = (stopTimes: any[]) => JSON.parse(JSON.stringify(stopTimes))

describe('57.1 tripQueryAlightPoint — the recorded feed', () => {
  it('the fixture is the recorded shape', () => {
    const at = (s: any, id: string) =>
      s.stopTimes.find((st: any) => st.stop.id === id)
    expect(S_0922.tripId).toBe(TRIP)
    expect(S_0953.tripId).toBe(TRIP)
    expect(at(S_0953, ALIGHT)).toMatchObject({
      arrivalDelay: 0,
      realtimeArrival: 64200,
      realtimeState: 'UPDATED',
      scheduledArrival: 64200
    })
    expect(at(S_0953, '1:56832').arrivalDelay).toBe(260)
    // The old reading: the timetable, styled live.
    expect(liveStopArrival(S_0953.stopTimes, ALIGHT, ALIGHT_NAME)).toEqual({
      epoch: E_1750_00,
      realtime: true
    })
  })

  it('17:49:53: reads Knox’s +260 s — 17:54:20, not 17:50:00', () => {
    const p = tripQueryAlightPoint(S_0953.stopTimes, ALIGHT, ALIGHT_NAME)
    expect(p).toEqual({ epoch: E_1754_20, projected: false, realtime: true })
    // 18 s off the last good value, against 242 s for the timetable.
    expect(Math.abs((p as any).epoch - E_1754_02)).toBe(18000)
  })

  it('17:49:22: the stop already carries its own delay — unchanged 17:54:02', () => {
    const p = tripQueryAlightPoint(S_0922.stopTimes, ALIGHT, ALIGHT_NAME)
    expect(p).toEqual(liveStopArrival(S_0922.stopTimes, ALIGHT, ALIGHT_NAME))
    expect(p).toEqual({ epoch: E_1754_02, realtime: true })
  })

  it('resolves by name too (twin-feed id)', () => {
    const p = tripQueryAlightPoint(S_0953.stopTimes, '9:none', ALIGHT_NAME)
    expect(p?.epoch).toBe(E_1754_20)
  })

  it('an on-time bus (every later stop ~0) passes through as the timetable', () => {
    const st = clone(S_0953.stopTimes)
    for (const s of st) {
      if (s.realtimeState === 'UPDATED') {
        // Within the jitter band, still "on time".
        s.arrivalDelay = s.stop.id === ALIGHT ? 0 : 30
        s.realtimeArrival = s.scheduledArrival + s.arrivalDelay
      }
    }
    expect(30).toBeLessThan(ALIGHT_NEXT_STOP_ZERO_MIN_DELAY_S)
    expect(tripQueryAlightPoint(st, ALIGHT, ALIGHT_NAME)).toEqual({
      epoch: E_1750_00,
      realtime: true
    })
  })

  it('the nearest later LIVE stop decides — a SCHEDULED one in between is skipped', () => {
    const st = clone(S_0953.stopTimes)
    const knox = st.find((s: any) => s.stop.id === '1:56832')
    knox.realtimeState = 'SCHEDULED'
    knox.arrivalDelay = 0
    knox.realtimeArrival = knox.scheduledArrival
    // Next live stop is American Blvd, +261 s.
    expect(tripQueryAlightPoint(st, ALIGHT, ALIGHT_NAME)?.epoch).toBe(
      E_1750_00 + 261000
    )
  })

  it('an early bus is read the same way (|delay|)', () => {
    const st = clone(S_0953.stopTimes)
    const knox = st.find((s: any) => s.stop.id === '1:56832')
    knox.arrivalDelay = -90
    knox.realtimeArrival = knox.scheduledArrival - 90
    expect(tripQueryAlightPoint(st, ALIGHT, ALIGHT_NAME)?.epoch).toBe(
      E_1750_00 - 90000
    )
  })

  it('the last stop of the trip has no later stop — unchanged', () => {
    const st = clone(S_0953.stopTimes)
    const last = st[st.length - 1]
    expect(last.stop.id).toBe(LAST)
    // The last stop as the next stop, reading the timetable.
    last.arrivalDelay = 0
    last.realtimeArrival = last.scheduledArrival
    expect(tripQueryAlightPoint(st, LAST, null)).toEqual(
      liveStopArrival(st, LAST, null)
    )
    expect(tripQueryAlightPoint(st, LAST, null)).toEqual({
      epoch: (last.serviceDay + last.scheduledArrival) * 1000,
      realtime: true
    })
    // ...and the recorded last stop (+500 s) passes through as recorded.
    expect(tripQueryAlightPoint(S_0953.stopTimes, LAST, null)).toEqual(
      liveStopArrival(S_0953.stopTimes, LAST, null)
    )
  })

  it('a SCHEDULED alight stop is liveStopArrival’s business, untouched', () => {
    const st = clone(S_0953.stopTimes)
    const a = st.find((s: any) => s.stop.id === ALIGHT)
    a.realtimeState = 'SCHEDULED'
    expect(tripQueryAlightPoint(st, ALIGHT, ALIGHT_NAME)).toEqual(
      liveStopArrival(st, ALIGHT, ALIGHT_NAME)
    )
  })
})

describe('57.1 refreshLiveLegTimes — cold boot at 17:49:53', () => {
  let clock: any
  beforeAll(() => {
    clock = FakeTimers.install({ now: S_0953.tMs, toFake: ['Date'] })
  })
  afterAll(() => clock.uninstall())

  const run = async (stopTimes: any[], liveLegTimes: any = {}) => {
    const leg: any = {
      from: {
        lat: 44.9483,
        lon: -93.2737,
        name: 'I-35W & Lake St Station',
        stop: { gtfsId: BOARD }
      },
      mode: 'BUS',
      to: {
        lat: 44.8853,
        lon: -93.2858,
        name: ALIGHT_NAME,
        stop: { gtfsId: ALIGHT }
      },
      transitLeg: true,
      trip: { gtfsId: TRIP }
    }
    const goMode = {
      activeItinerary: { legs: [leg] },
      isActive: true,
      // Nothing carried over a relaunch: liveLegTimes is not persisted.
      liveLegTimes,
      riding: { legIndex: 0, tripId: TRIP },
      routeMatch: { legIndex: 0 },
      tracking: {
        lastPosition: { coords: { latitude: 44.914, longitude: -93.2749 } }
      },
      vehicleMatch: { match: { nextStopId: ALIGHT } }
    }
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        goMode,
        transitIndex: { stops: {}, trips: { [TRIP]: { id: TRIP, stopTimes } } }
      }
    })
    const published: any[] = []
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      if (action.type === 'SET_LIVE_LEG_TIMES') published.push(action.payload)
      return action
    }
    await dispatch(refreshLiveLegTimes())
    return published
  }

  it('publishes 17:54:20 live, not 17:50:00', async () => {
    const published = await run(S_0953.stopTimes)
    expect(published).toHaveLength(1)
    expect(published[0][0].alightEpoch).toBe(E_1754_20)
    expect(published[0][0].alightEpoch).not.toBe(E_1750_00)
    expect(published[0][0].alightRealtime).toBe(true)
    expect(published[0][0].alightIsFloor).toBe(false)
  })

  it('17:49:22’s poll, warm, still publishes 17:54:02', async () => {
    const published = await run(S_0922.stopTimes)
    expect(published[0][0].alightEpoch).toBe(E_1754_02)
  })
})
