import { existsSync, readFileSync } from 'fs'
import path from 'path'

import FakeTimers from '@sinonjs/fake-timers'

import '../../test-utils/mock-window-url'
import {
  clearGoModeSession,
  loadGoModeSession,
  saveGoModeSession
} from '../../../lib/util/go-mode/session-persistence'
import {
  endGoMode,
  handlePositionUpdate,
  resumeGoModeTrip
} from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchRerouteSnapshotPlan: jest.fn(() => () => Promise.resolve(null)),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve(null))
}))

/**
 * "Arrived" 72 m from the door on a bike finish — 2026-10-19 17:49:06 local
 * (22:49:06Z), session `mvf7ugoa`, replayed from
 * `replay/fixtures/green-465-1657.json` through the real
 * `handlePositionUpdate` and the real reducer (backlog 12.17).
 *
 * The trip ends on a 3.9 km BICYCLE leg from I-35W & 98th St to 2345 Old
 * Shakopee Rd W. Measured on the unfixed tick (base of this branch): the last
 * fix of the recording, 22:49:06, is 72.4 m from the door at 8.7 m/s, overall
 * progress 99.93 %, the final leg's own 99.42 % — under the 99.5 % shortcut —
 * so it was the DISTANCE branch (72.4 m <= ARRIVAL_RADIUS_M 75, overall >= 90)
 * that latched `SET_ARRIVED` and the TRIP_COMPLETE push, with the rider five
 * seconds short of the door.
 *
 * Rider's answers, 2026-10-20: Q3 "On a bike or walking last leg, wait until
 * within 40 m" and Q4 "Also count it once I've been within 75 m for a minute."
 * 22:49:06 is the recording's last fix (the app dropped to 30 s tracking on
 * arrival and the fixture was cut there), so the minute is the only way this
 * ride arrives now — and it must arrive with NO further fix, on the wall
 * clock, at 22:50:06.
 */

// 25.5: green-465-1657.json (13.7 MB) is one of the untracked replay fixtures
// (866 MB in all; never committed). Importing it bare killed this suite at
// collection on any clean clone. Without it the describe below is replaced by
// ONE skipped test whose name says why, plus a console warning, so the skip is
// visible in --verbose and CI logs instead of silent.
const FIXTURE_FILE = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/green-465-1657.json'
)
const hasFixture = existsSync(FIXTURE_FILE)
const fixture: any = hasFixture
  ? JSON.parse(readFileSync(FIXTURE_FILE, 'utf8'))
  : null
const describeRide: typeof describe = hasFixture
  ? describe
  : (((label: string) => {
      const reason =
        'SKIPPED (25.5): untracked replay fixture green-465-1657.json is not present — ' +
        'copy it into lib/util/go-mode/replay/fixtures/ from a checkout that has it'
      // eslint-disable-next-line no-console
      console.warn(`[${label}] ${reason}`)
      // eslint-disable-next-line jest/valid-title
      describe(label, () => {
        // eslint-disable-next-line jest/no-disabled-tests, jest/valid-title
        it.skip(reason, () => undefined)
      })
    }) as unknown as typeof describe)

// 75.37 (J12): single tests here take 10-18 s of CPU (a whole recorded ride
// through the real tick). They pass today only because the ticks are
// synchronous, which jest's default 5 s timeout cannot interrupt — say so.
jest.setTimeout(120000)

const initial = goMode(undefined, { type: '@@INIT' })

const ARRIVAL_TICK_MS = Date.parse('2026-10-19T22:49:06Z')
const FIRST_INSIDE_75_MS = ARRIVAL_TICK_MS
const DWELL_MS = 60_000

const posOf = (g: any) =>
  ({
    coords: {
      accuracy: g.accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: g.heading,
      latitude: g.lat,
      longitude: g.lon,
      speed: g.speed
    },
    timestamp: g.tMs
  } as GeolocationPosition)

/** Real reducer, every action recorded with the clock it was dispatched at. */
const makeStore = (overrides: any = {}) => {
  let state: any = { ...initial, ...overrides }
  const actions: { a: any; t: number }[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: state,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  const dispatch: any = (action: any) => {
    // Nested thunks (position-tracking restarts, polls) are dropped: this
    // harness drives fixes from the recording, not from a live GPS stream.
    if (typeof action === 'function') return undefined
    actions.push({ a: action, t: Date.now() })
    state = goMode(state, action)
    return action
  }
  return {
    actions: () => actions,
    getGoMode: () => state,
    run: (t: any) => t(dispatch, getState)
  }
}

const track: any[] = fixture
  ? [...fixture.gpsTrack].sort((a, b) => a.tMs - b.tMs)
  : []

const of = (store: ReturnType<typeof makeStore>, type: string) =>
  store.actions().filter(({ a }) => a.type === type)

describeRide(
  'arrival radius on a bike finish (12.17, 2026-10-19 17:49 ride)',
  () => {
    let clock: FakeTimers.InstalledClock
    let store: ReturnType<typeof makeStore>

    /** Replay the recording up to and including `untilMs`. */
    const replayUntil = (untilMs: number) => {
      for (const g of track) {
        if (g.tMs > untilMs) break
        clock.setSystemTime(g.tMs)
        store.run(handlePositionUpdate(posOf(g)))
      }
    }

    beforeEach(() => {
      window.localStorage.clear()
      clearGoModeSession()
      clock = FakeTimers.install({
        now: track[0].tMs,
        toFake: ['Date', 'setTimeout', 'clearTimeout']
      })
      store = makeStore({
        activeItinerary: (fixture as any).itinerary,
        isActive: true,
        tracking: { ...initial.tracking, isTracking: true }
      })
    })

    afterEach(() => {
      try {
        if (store.getGoMode().isActive) store.run(endGoMode())
      } catch (e) {
        /* nothing to end */
      }
      clock.uninstall()
    })

    it('does not call it arrived at 17:49:06, 72 m out on the bike', () => {
      replayUntil(track[track.length - 1].tMs)
      expect(track[track.length - 1].tMs).toBe(ARRIVAL_TICK_MS)
      expect(of(store, 'SET_ARRIVED')).toEqual([])
      expect(store.getGoMode().arrivedAt).toBeNull()
      const last = of(store, 'UPDATE_PROGRESS').pop()!.a.payload
      expect(last.finalLegMode).toBe('BICYCLE')
      expect(last.distanceToDestination).toBeCloseTo(72.4, 1)
      expect(last.status).not.toBe('completed')
      const pushes = of(store, 'ADD_NOTIFICATION').filter(
        ({ a }) => a.payload?.type === 'TRIP_COMPLETE'
      )
      expect(pushes).toEqual([])
    })

    it('starts the minute on the first fix inside 75 m (78.2 m at 17:49:05 is outside)', () => {
      replayUntil(ARRIVAL_TICK_MS)
      const near = of(store, 'SET_NEAR_DESTINATION')
      expect(near).toHaveLength(1)
      expect(near[0].a.payload.sinceMs).toBe(FIRST_INSIDE_75_MS)
      expect(store.getGoMode().nearDestination?.sinceMs).toBe(
        FIRST_INSIDE_75_MS
      )
    })

    it('arrives at 17:50:06 on the wall clock, with no further fix', () => {
      replayUntil(ARRIVAL_TICK_MS)
      const fixesBefore = of(store, 'UPDATE_POSITION').length
      clock.tick(DWELL_MS - 1000)
      expect(store.getGoMode().arrivedAt).toBeNull()
      clock.tick(1000)

      const arrived = of(store, 'SET_ARRIVED')
      expect(arrived).toHaveLength(1)
      expect(arrived[0].a.payload).toBe(ARRIVAL_TICK_MS + DWELL_MS)
      expect(new Date(arrived[0].a.payload).toISOString()).toBe(
        '2026-10-19T22:50:06.000Z'
      )
      // No fix was delivered to do it.
      expect(of(store, 'UPDATE_POSITION')).toHaveLength(fixesBefore)
      // The same arrival a distance latch makes: progress reads completed, the
      // "Arrived" push goes out once, tracking drops to the arrived cadence, the
      // dwell is cleared.
      const types = store
        .actions()
        .filter(({ t }) => t >= ARRIVAL_TICK_MS + DWELL_MS)
        .map(({ a }) => a.type)
      expect(types).toEqual(
        expect.arrayContaining([
          'UPDATE_PROGRESS',
          'SET_ARRIVED',
          'UPDATE_TRACKING_INTERVAL',
          'ADD_NOTIFICATION'
        ])
      )
      expect(types.indexOf('UPDATE_PROGRESS')).toBeLessThan(
        types.indexOf('SET_ARRIVED')
      )
      expect(store.getGoMode().progress.status).toBe('completed')
      const pushes = of(store, 'ADD_NOTIFICATION').filter(
        ({ a }) => a.payload?.type === 'TRIP_COMPLETE'
      )
      expect(pushes).toHaveLength(1)
      expect(pushes[0].a.payload.message).toBe('Arrived')
      expect(
        of(store, 'UPDATE_TRACKING_INTERVAL').pop()!.a.payload.interval
      ).toBe(30000)
      expect(store.getGoMode().nearDestination).toBeNull()
    })

    it('a fix back beyond 75 m inside the minute disarms it', () => {
      replayUntil(ARRIVAL_TICK_MS)
      // The 17:49:05 fix (78.2 m out), re-delivered 20 s later.
      const outside = track[track.length - 2]
      clock.setSystemTime(ARRIVAL_TICK_MS + 20_000)
      store.run(
        handlePositionUpdate(
          posOf({ ...outside, tMs: ARRIVAL_TICK_MS + 20_000 })
        )
      )
      expect(store.getGoMode().nearDestination).toBeNull()
      clock.tick(5 * DWELL_MS)
      expect(of(store, 'SET_ARRIVED')).toEqual([])
      expect(store.getGoMode().arrivedAt).toBeNull()
    })

    it('a Stop inside the minute leaves no arrival behind it', () => {
      replayUntil(ARRIVAL_TICK_MS)
      clock.tick(30_000)
      store.run(endGoMode())
      expect(store.getGoMode().isActive).toBe(false)
      expect(store.getGoMode().nearDestination).toBeNull()
      clock.tick(5 * DWELL_MS)
      expect(of(store, 'SET_ARRIVED')).toEqual([])
    })

    it('a new itinerary with another destination cannot inherit the minute', () => {
      replayUntil(ARRIVAL_TICK_MS)
      const itin: any = (fixture as any).itinerary
      const legs = itin.legs.slice()
      const last = legs[legs.length - 1]
      legs[legs.length - 1] = {
        ...last,
        to: { ...last.to, lat: last.to.lat + 0.01, name: 'Somewhere else' }
      }
      // A swap in place (what a re-plan does to the store): the dwell still
      // names the OLD door.
      store.run((dispatch: any) =>
        dispatch({
          payload: { itinerary: { ...itin, legs } },
          type: 'START_GO_MODE'
        })
      )
      expect(store.getGoMode().nearDestination?.sinceMs).toBe(
        FIRST_INSIDE_75_MS
      )
      clock.tick(5 * DWELL_MS)
      expect(of(store, 'SET_ARRIVED')).toEqual([])
    })

    it('a relaunch inside the minute keeps the minute it had (persisted like arrivedAt)', async () => {
      replayUntil(ARRIVAL_TICK_MS)
      saveGoModeSession(store.getGoMode())
      const saved = loadGoModeSession() as any
      expect(saved.nearDestination?.sinceMs).toBe(FIRST_INSIDE_75_MS)

      // The page goes away 40 s into the minute: its timer with it.
      clock.tick(40_000)
      store.run(endGoMode())
      // ...and comes back, the way create-otp-reducer restores a session.
      store = makeStore({
        activeItinerary: saved.activeItinerary,
        arrivedAt: saved.arrivedAt ?? null,
        isActive: true,
        nearDestination: saved.nearDestination ?? null,
        tracking: { ...initial.tracking, isTracking: true }
      })
      await store.run(resumeGoModeTrip())
      // 20 s left of the minute, not a fresh 60.
      clock.tick(19_000)
      expect(store.getGoMode().arrivedAt).toBeNull()
      clock.tick(1_000)
      expect(store.getGoMode().arrivedAt).toBe(ARRIVAL_TICK_MS + DWELL_MS)
    })
  }
)
