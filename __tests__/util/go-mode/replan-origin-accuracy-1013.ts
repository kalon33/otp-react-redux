import fs from 'fs'
import path from 'path'

import FakeTimers from '@sinonjs/fake-timers'

import {
  beginGoMode,
  endGoMode,
  handlePositionUpdate,
  REPLAN_ORIGIN_WAIT
} from '../../../lib/actions/go-mode'
import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import { FIX_ACCURACY_MAX_M } from '../../../lib/util/go-mode/transit-trust'
import { PROJECTION_MAX_M } from '../../../lib/util/go-mode/replan-origin'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  }))
}))

/**
 * 2026-10-13 09:31, ride `mv6ret6s-h5he2i` — backlog 51.3.
 *
 * The rider started Go Mode standing ~14 m from I-35W & 46th St Station, on a
 * plan whose 09:16 Orange Line was 925 s gone. Go Mode's own watcher then
 * delivered two fixes at accuracy 1,414 m (44.90833,-93.27659 — 1,247 m
 * south), and the missed-bus re-plan went out from the first of them at
 * 09:31:25 and installed a 2,060 m bike loop back to the same station. The
 * planner's own 14 m fix from 09:31:02 (44.91979,-93.27483) was in
 * `otp.location.currentPosition` the whole time; the next usable Go Mode fix
 * came at 09:31:48 (90 m).
 *
 * Replayed through `beginGoMode` + `handlePositionUpdate` on
 * lib/util/go-mode/replay/fixtures/h5he2i-0931-replan-origin.json, a window cut
 * from h5he2i-0931-two-early-buses.json: every fix from START_GO_MODE
 * 09:31:25.863 to 09:33:40. These tests assert on the REQUEST the app sends
 * (`fetchOnboardCandidatePlan`'s payload), not on what OTP answers; the stub
 * answers with the plan OTP really returned at 09:31:28.
 *
 * Measured on main `16bbde89d` with this same harness: one request, at
 * 09:31:25.888, from 44.90833,-93.27659 (the 1,414 m fix), applied at once —
 * the day's defect, reproduced. With or without the planner fix seeded.
 */
const FIXTURE = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/h5he2i-0931-replan-origin.json'
)
const fixture: any = fs.existsSync(FIXTURE)
  ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  : null
const withFixture = fixture ? describe : describe.skip

const initial = goMode(undefined, { type: '@@INIT' })
const mockedFetch = fetchOnboardCandidatePlan as jest.Mock

/** CDT wall clock on 2026-10-13 to epoch ms. */
const at = (hhmmss: string): number =>
  Date.parse(`2026-10-13T${hhmmss}Z`) + 5 * 3600000
const clock = (ms: number) =>
  new Date(ms - 5 * 3600000).toISOString().slice(11, 23)
const clone = (x: any) => JSON.parse(JSON.stringify(x))

/** I-35W & 46th St Station, the plan's board stop (leg 1 `from`). */
const STATION: [number, number] = [44.919417, -93.274754]
/** The planner's POSITION_RESPONSE at 09:31:02, accuracy 14 m. */
const PLANNER_FIX = {
  coords: {
    accuracy: 14,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    latitude: 44.91979,
    longitude: -93.27483,
    speed: null
  },
  timestamp: at('09:31:02')
}

type Request = { atMs: number; from: any; time: string }

withFixture(
  'util > go-mode > re-plan origin accuracy (51.3, 2026-10-13)',
  () => {
    let fake: FakeTimers.InstalledClock | undefined

    beforeEach(() => {
      mockedFetch.mockReset()
      fake = FakeTimers.install({
        now: fixture.meta.startMs,
        toFake: ['Date']
      })
    })
    afterEach(() => {
      fake?.uninstall()
      fake = undefined
    })

    const fixes = () =>
      [...fixture.gpsTrack].sort((a: any, b: any) => a.tMs - b.tMs)

    const toPosition = (p: any): GeolocationPosition =>
      ({
        coords: {
          accuracy: p.accuracy,
          altitude: null,
          altitudeAccuracy: null,
          heading: p.heading ?? null,
          latitude: p.lat,
          longitude: p.lon,
          speed: p.speed ?? null
        },
        timestamp: p.tMs
      } as GeolocationPosition)

    const replay = async (options: { plannerFix: any }) => {
      const requests: Request[] = []
      mockedFetch.mockImplementation((payload: any) => () => {
        requests.push({
          atMs: Date.now(),
          from: payload.from,
          time: payload.time
        })
        return Promise.resolve({
          error: false,
          itineraries: [clone(fixture.itinerarySwaps[0].itinerary)]
        })
      })
      let goModeState: any = { ...initial }
      const actions: any[] = []
      const getState = () => ({
        otp: {
          config: { homeTimezone: 'America/Chicago' },
          currentQuery: {},
          goMode: goModeState,
          location: { currentPosition: options.plannerFix },
          transitIndex: { routes: {}, stops: {} }
        }
      })
      const dispatch: any = (action: any) => {
        if (typeof action === 'function') {
          // Network side-thunks this harness does not serve (vehicle and trip
          // polls) fail on their own; they must not stop the tick.
          try {
            const r = action(dispatch, getState)
            if (r && typeof r.catch === 'function') r.catch(() => undefined)
            return r
          } catch (e) {
            return undefined
          }
        }
        actions.push({ ...action, atMs: Date.now() })
        goModeState = goMode(goModeState, action)
        return action
      }
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
      const err = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      const warn = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined)
      try {
        await beginGoMode(clone(fixture.itinerary))(dispatch, getState)
        for (const p of fixes()) {
          fake?.setSystemTime(p.tMs)
          await dispatch(handlePositionUpdate(toPosition(p)))
          await Promise.resolve()
        }
        endGoMode()(dispatch, getState)
      } finally {
        log.mockRestore()
        err.mockRestore()
        warn.mockRestore()
      }
      const missedBusReroutes = actions.filter(
        (a) => a.type === 'START_REROUTE' && a.payload?.reason === 'missed-bus'
      )
      return { actions, missedBusReroutes, requests }
    }

    /**
     * Metres from a request origin to the nearest usable fix the app held when
     * it asked: within FIX_ACCURACY_MAX_M, taken at or before the request and
     * no more than a minute before it. (The rider later rides the bus south past
     * the 1,414 m point, so "near some good fix of the window" would not do.)
     */
    const gapToHeldFix = (r: Request, extra: any[] = []) => {
      const held = [...fixes().map((p: any) => toPosition(p)), ...extra].filter(
        (f: any) =>
          f.coords.accuracy <= FIX_ACCURACY_MAX_M &&
          f.timestamp <= r.atMs &&
          r.atMs - f.timestamp <= 60_000
      )
      return Math.min(
        Infinity,
        ...held.map((f: any) =>
          calculateDistance(
            r.from.lat,
            r.from.lon,
            f.coords.latitude,
            f.coords.longitude
          )
        )
      )
    }

    it('is the window the row was written from', () => {
      expect(fixture.meta.session).toBe('mv6ret6s-h5he2i')
      const [f0, f1] = fixes()
      expect(f0.accuracy).toBe(1414)
      expect(f1.accuracy).toBe(1414)
      expect(
        Math.round(calculateDistance(f0.lat, f0.lon, ...STATION))
      ).toBeGreaterThan(1200)
      // The first fix within the accuracy bound: 09:31:48.761, 90 m.
      const firstGood = fixes().find(
        (p: any) => p.accuracy <= FIX_ACCURACY_MAX_M
      )
      expect(clock(firstGood.tMs)).toBe('09:31:48.761')
      expect(Math.round(firstGood.accuracy)).toBe(90)
      // The plan's bus left at 09:16:00; the day's re-plan answer is the 2 km
      // bike loop back to the same station.
      expect(clock(fixture.itinerary.legs[1].startTime)).toBe('09:16:00.000')
      expect(
        Math.round(fixture.itinerarySwaps[0].itinerary.legs[0].distance)
      ).toBe(2061)
    })

    it('without the planner fix: waits for the 09:31:48 fix, never asks from 1,414 m', async () => {
      const { actions, missedBusReroutes, requests } = await replay({
        plannerFix: null
      })
      // The rider is still told the bus is gone at once.
      const firstMissed = actions.find(
        (a) => a.type === 'ADD_NOTIFICATION' && a.payload?.type === 'MISSED_BUS'
      )
      expect(clock(firstMissed.atMs)).toBe('09:31:25.888')

      // No plan request from a fix worse than FIX_ACCURACY_MAX_M — every origin
      // is a usable fix (or that fix projected along its heading).
      expect(requests.length).toBeGreaterThan(0)
      for (const r of requests) {
        expect(gapToHeldFix(r)).toBeLessThanOrEqual(PROJECTION_MAX_M + 1)
      }

      // The first missed-bus re-plan goes out at the first usable fix, from it,
      // at I-35W & 46th St.
      expect(clock(missedBusReroutes[0].atMs)).toBe('09:31:48.761')
      const first = requests[0]
      expect(first.atMs).toBeGreaterThanOrEqual(at('09:31:48'))
      expect(first.from.lat).toBeCloseTo(44.919466, 5)
      expect(first.from.lon).toBeCloseTo(-93.274495, 5)
      expect(
        calculateDistance(first.from.lat, first.from.lon, ...STATION)
      ).toBeLessThan(100)

      // One record when the wait began, one when the 90 m fix ended it.
      const waits = actions
        .filter(
          (a) =>
            a.type === REPLAN_ORIGIN_WAIT && a.payload.reason === 'missed-bus'
        )
        .map((a) => [clock(a.atMs), a.payload.phase, a.payload.fixAccuracyM])
      expect(waits).toEqual([
        ['09:31:25.888', 'wait', 1414],
        ['09:31:48.761', 'resume', 90]
      ])
    })

    it('with the planner fix seeded: asks at 09:31:25 from the 14 m fix', async () => {
      const { missedBusReroutes, requests } = await replay({
        plannerFix: PLANNER_FIX
      })
      expect(clock(missedBusReroutes[0].atMs)).toBe('09:31:25.888')
      const first = requests[0]
      expect(clock(first.atMs)).toBe('09:31:25.888')
      expect(first.from.lat).toBeCloseTo(44.91979, 5)
      expect(first.from.lon).toBeCloseTo(-93.27483, 5)
      for (const r of requests) {
        expect(gapToHeldFix(r, [PLANNER_FIX])).toBeLessThanOrEqual(
          PROJECTION_MAX_M + 1
        )
      }
    })
  }
)
