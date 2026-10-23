import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import FakeTimers from '@sinonjs/fake-timers'

import '../../test-utils/mock-window-url'
import {
  clearGoModeSession,
  loadGoModeSession,
  saveGoModeSession
} from '../../../lib/util/go-mode/session-persistence'
import { endGoMode, handlePositionUpdate } from '../../../lib/actions/go-mode'
import { getInitialState } from '../../../lib/reducers/create-otp-reducer'
import goMode from '../../../lib/reducers/go-mode'

/**
 * The 10-19 recordings are deliberately NOT committed; these blocks skip
 * when the fixtures are absent.
 */
const FIXTURE_DIR = join(__dirname, '../../../lib/util/go-mode/replay/fixtures')
const load = (name: string): any => {
  const p = join(FIXTURE_DIR, name)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}
const control = load('green-465-1657.json')
const fixture = load('gold-1631-1019.json')

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
 * "Running late" pushed to a rider who had left the bus, measured — 2026-10-19
 * (backlog 64.2), replayed from `replay/fixtures/gold-1631-1019.json` through
 * the real `handlePositionUpdate` and the real reducer.
 *
 * The rider got off the Gold Line and walked away. The off-route matcher slid
 * leg progress back (100 -> 97 -> 88), defeating `checkDelayAlert`'s only
 * "past this leg" guard (progress >= 99), and `delay` — wall clock minus the
 * leg's schedule — kept growing: "METRO Gold Line · N min late" at 16:42:19
 * and 16:43:40 local (21:42:19Z / 21:43:40Z). Both ticks read `deviated`. The
 * replay's minutes differ from the live ones (it starts the clock at the first
 * fix, not the live session's floored alight time); the push times do not.
 *
 * CONTROL: `green-465-1657.json`, where the rider IS on the bus the whole
 * time — the 465 "3 min late" push still goes out.
 */

const initial = goMode(undefined, { type: '@@INIT' })

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

/** Real reducer, every action recorded, nested thunks dropped. */
const makeStore = (overrides: any = {}) => {
  let state: any = { ...initial, ...overrides }
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: state,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return undefined
    actions.push(action)
    state = goMode(state, action)
    return action
  }
  return {
    actions: () => actions,
    run: (t: any) => t(dispatch, getState)
  }
}

/** Replay a whole fixture; returns the ADD_NOTIFICATION payloads and ticks. */
const replayAll = (fx: any) => {
  const track: any[] = [...fx.gpsTrack].sort((a, b) => a.tMs - b.tMs)
  window.localStorage.clear()
  clearGoModeSession()
  const clock = FakeTimers.install({ now: track[0].tMs, toFake: ['Date'] })
  try {
    const store = makeStore({
      activeItinerary: fx.itinerary,
      isActive: true,
      tracking: { ...initial.tracking, isTracking: true }
    })
    for (const g of track) {
      clock.setSystemTime(g.tMs)
      store.run(handlePositionUpdate(posOf(g)))
    }
    const actions = store.actions()
    return {
      delayPushes: actions
        .filter(
          (a: any) =>
            a.type === 'ADD_NOTIFICATION' && a.payload?.type === 'DELAY_ALERT'
        )
        .map((a: any) => ({
          at: new Date(a.payload.timestamp).toISOString(),
          message: a.payload.message
        })),
      statuses: actions
        .filter((a: any) => a.type === 'UPDATE_PROGRESS')
        .map((a: any) => a.payload.status)
    }
  } finally {
    clock.uninstall()
  }
}

;(fixture ? describe : describe.skip)(
  'no delay push while off route (64.2, 2026-10-19 Gold Line)',
  () => {
    let result: ReturnType<typeof replayAll>

    beforeAll(() => {
      result = replayAll(fixture)
    })

    it('pushes no "min late" at all — neither 16:42:19 nor 16:43:40', () => {
      const at = result.delayPushes.map((p) => p.at)
      expect(at).not.toContain('2026-10-19T21:42:19.000Z')
      expect(at).not.toContain('2026-10-19T21:43:40.000Z')
      expect(result.delayPushes).toEqual([])
    })

    it('the ride really was off route (the guard is what held the pushes back)', () => {
      expect(result.statuses).toContain('deviated')
    })
  }
)
;(control ? describe : describe.skip)(
  'CONTROL: a rider on the bus still hears it is late (green-465-1657)',
  () => {
    it('"465 · 3 min late" still pushes', () => {
      const { delayPushes } = replayAll(control)
      expect(delayPushes.map((p) => p.message)).toContain('465 · 3 min late')
    })
  }
)
