/* globals afterEach, describe, expect, it, jest */
import '../../test-utils/mock-window-url'

import fs from 'fs'
import path from 'path'

import { applyMiddleware, combineReducers, createStore } from 'redux'
import FakeTimers from '@sinonjs/fake-timers'
import thunk from 'redux-thunk'

import { getReplayClock } from '../../../lib/util/go-mode/replay/replay-engine'
import { replayTrip, stopReplay } from '../../../lib/actions/go-mode'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'

/** Same stub as detour-riding-hold-1012.ts: this replay runs the real tick. */
jest.mock('@opentripplanner/core-utils', () => {
  const actual = jest.requireActual('@opentripplanner/core-utils')
  const { parse } = jest.requireActual('graphql')
  const stub = parse('query Plan { plan { itineraries { duration } } }')
  const core = actual.default || actual
  const patched = {
    ...core,
    queryGen: {
      ...core.queryGen,
      generateOtp2Query: (params: unknown, homeTimezone?: string) =>
        core.queryGen.generateOtp2Query(params, homeTimezone, stub)
    }
  }
  return { ...actual, __esModule: true, default: patched }
})

/**
 * BACKLOG 75.32 (and 75.31 on the second ride) — a replay never polled the
 * boarding feeds.
 *
 * The tick's boarding-feed poll (`pollBoardingFeeds`: the live leg times, the
 * boarding route's vehicles while the rider is on the access leg, the boarding
 * stop's departures) and the departure anchor that re-targets the plan from
 * it were skipped whenever `isReplayActive()`, "which reproduces recorded data
 * rather than re-polling live feeds" — although every fixture records those
 * reads and the replay engine answers each of them by the sim clock. So no
 * replay could say "Bus coming", put the plan on the earlier bus, or see the
 * rider board it.
 *
 * ride-1019-0844-aboard-offer (session `mvfb1a71-x3jjwm`, from
 * ~/otp-debug-logs/debug-2026-10-19.jsonl): REAL 08:48:29 `PLAN_RETARGET
 * {source anchor, verdict applied, tripId 1:1180053}` (the 08:55:48 94 instead
 * of the plan's 09:14:51) with "Bus coming · 94", 08:54:25 `TRANSITION_LEG 1`,
 * 08:57:49 `SET_RIDING 1:1180053/1:3408`. REPLAY on main: the plan keeps the
 * 09:14:51 run, and in 17 sim-min there is no leg change, no riding fact, no
 * notification, and not one vehicle response for the 94.
 *
 * ride-1020-0907 (session `mvgr2jqp-b81j4g`, debug-2026-10-20.jsonl; the
 * fixture is 62 MB and not committed, so this half runs where it is present):
 * REAL 09:08:07 "Bus coming · 94 · 7 min", 09:08:14 and 09:08:48 scoped
 * re-plans accepted, 09:10:49 refused access-misses-board, 09:17:43 "Bus
 * here · 94", 09:19:38 `SET_RIDING 1:1186422/1:2015`. REPLAY on main: no
 * board push at all, the first two scoped re-plans refused origin-behind-rider
 * (84.9 / 85.6 m — the reroute snapshot's origin, 75.31), two 94 → 74 plans
 * installed, aboard only at 09:32:08 after a vehicle-less riding fact on a
 * later run.
 *
 * The replay's clock starts at `meta.startMs` while its first fix is 23 s
 * earlier on 1020-0907 (75.29), so its events land ~22 s after the ride's.
 * The tolerances below allow that and no more.
 */

const FIXTURES = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)
const load = (name: string): any => {
  const p = path.join(FIXTURES, name)
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
}

const CONFIG = {
  api: { host: 'http://mock-host.com', path: '/api', port: 80 },
  homeTimezone: 'America/Chicago',
  itinerary: {},
  modes: {
    initialState: { enabledModeButtons: ['transit', 'bicycle'] },
    modeButtons: [
      { key: 'transit', modes: [{ mode: 'TRANSIT' }] },
      { key: 'bicycle', modes: [{ mode: 'BICYCLE' }] }
    ],
    transitModes: []
  },
  persistence: { enabled: false }
}

interface Recorded {
  p: any
  t: number
  type: string
}

const KEEP = new Set([
  'ADD_NOTIFICATION',
  'AUTO_REPLAN',
  'PLAN_RETARGET',
  'REALTIME_VEHICLE_POSITIONS_RESPONSE',
  'SET_RIDING',
  'TRANSITION_LEG'
])

/** Replay through the real store and tick, at 1x, up to `untilMs` (sim). */
async function replay(fx: any, untilMs = Infinity) {
  const g: any = global
  g.fetch = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({}), ok: true, status: 200 })
  )
  jest.spyOn(console, 'info').mockImplementation(() => undefined)
  jest.spyOn(console, 'log').mockImplementation(() => undefined)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  // Wall time = the ride's own time at 1x, so a wall-clock read in the tick
  // (75.29) sees what it saw on the phone.
  const clock = FakeTimers.install({ now: fx.meta.startMs })
  const events: Recorded[] = []
  const recorder = () => (next: any) => (action: any) => {
    if (action && typeof action === 'object' && KEEP.has(action.type)) {
      events.push({ p: action.payload, t: getReplayClock(), type: action.type })
    }
    return next(action)
  }
  const store = createStore(
    combineReducers({ otp: createOtpReducer(CONFIG as any) }),
    applyMiddleware(thunk, recorder)
  )
  await store.dispatch(replayTrip(fx, { speedMultiplier: 1 }) as any)
  for (let i = 0; i < 20000; i++) {
    await clock.tickAsync(1000)
    if (store.getState().otp.goMode.simulation.status !== 'running') break
    if (getReplayClock() > untilMs) break
  }
  store.dispatch(stopReplay() as any)
  clock.uninstall()
  const of = (type: string) => events.filter((e) => e.type === type)
  return {
    notifications: of('ADD_NOTIFICATION'),
    replans: of('AUTO_REPLAN'),
    retargets: of('PLAN_RETARGET'),
    ridings: of('SET_RIDING'),
    transitions: of('TRANSITION_LEG'),
    vehicles: of('REALTIME_VEHICLE_POSITIONS_RESPONSE')
  }
}

const near = (t: number, realMs: number, toleranceS: number) =>
  Math.abs(t - realMs) <= toleranceS * 1000

afterEach(() => {
  jest.restoreAllMocks()
})

jest.setTimeout(600000)

/** 2026-10-19 HH:MM:SS CDT as epoch ms. */
const at19 = (hms: string) => Date.parse(`2026-10-19T${hms}-05:00`)
const fx1019 = load('ride-1019-0844-aboard-offer.json')

;(fx1019 ? describe : describe.skip)(
  'ride-1019-0844-aboard-offer, replayed: the anchor puts the plan on the earlier 94 (75.32)',
  () => {
    let run: Awaited<ReturnType<typeof replay>>
    it('replays the whole track', async () => {
      run = await replay(fx1019)
    })

    it('polls the 94 while the rider bikes to the stop', () => {
      const beforeBoard = run.vehicles.filter(
        (e) => e.p?.routeId === '1:94' && e.t < at19('08:54:25')
      )
      expect(beforeBoard.length).toBeGreaterThan(0)
    })

    it('re-targets the plan onto 1:1180053 when the ride did (08:48:29)', () => {
      const applied = run.retargets.filter(
        (e) => e.p?.source === 'anchor' && e.p?.verdict === 'applied'
      )
      expect(applied.length).toBeGreaterThan(0)
      expect(applied[0].p.tripId).toBe('1:1180053')
      expect(near(applied[0].t, at19('08:48:29'), 30)).toBe(true)
    })

    it('says "Bus coming" when the ride did (08:48:29)', () => {
      const coming = run.notifications.filter(
        (e) => e.p?.type === 'BOARD_BUS_APPROACHING'
      )
      expect(coming.length).toBeGreaterThan(0)
      expect(near(coming[0].t, at19('08:48:29'), 30)).toBe(true)
    })

    it('steps onto the bus leg (08:54:25) and is aboard 1:1180053 / 1:3408 (08:57:49)', () => {
      const leg1 = run.transitions.find((e) => e.p?.legIndex === 1)
      expect(leg1).toBeDefined()
      expect(near(leg1!.t, at19('08:54:25'), 30)).toBe(true)
      const aboard = run.ridings.find(
        (e) => e.p?.tripId === '1:1180053' && e.p?.vehicleId === '1:3408'
      )
      expect(aboard).toBeDefined()
      expect(near(aboard!.t, at19('08:57:49'), 30)).toBe(true)
    })
  }
)

/** 2026-10-20 HH:MM:SS CDT as epoch ms. */
const at20 = (hms: string) => Date.parse(`2026-10-20T${hms}-05:00`)
const fx1020 = load('ride-1020-0907.json')

;(fx1020 ? describe : describe.skip)(
  "ride-1020-0907, replayed to the rider's 09:24:26 tap: the ride's re-plan verdicts and board pushes (75.31, 75.32)",
  () => {
    let run: Awaited<ReturnType<typeof replay>>
    it('replays to 09:24', async () => {
      // After 09:24:26 the real ride follows a rider tap the replay does not
      // make (75.30).
      run = await replay(fx1020, at20('09:24:00'))
    })

    it('answers the scoped re-plans as the ride did: accepted, accepted, then access-misses-board', () => {
      const scoped = run.replans.filter(
        (e) => e.p?.reason === 'quiet-replan-scoped'
      )
      expect(scoped.length).toBeGreaterThanOrEqual(3)
      expect(near(scoped[0].t, at20('09:08:14'), 45)).toBe(true)
      expect(
        scoped.slice(0, 3).map((e) => e.p.refusedBecause ?? 'accepted')
      ).toEqual(['accepted', 'accepted', 'access-misses-board'])
      expect(
        scoped.filter((e) => e.p.refusedBecause === 'origin-behind-rider')
      ).toEqual([])
      // ...so no full re-plan installs a plan the ride never had (94 → 74).
      expect(
        run.replans.filter(
          (e) => e.p?.reason === 'quiet-replan-full' && e.p?.accepted
        )
      ).toEqual([])
    })

    it('says "Bus coming" (09:08:07) and "Bus here" (09:17:43) when the ride did', () => {
      const coming = run.notifications.find(
        (e) => e.p?.type === 'BOARD_BUS_APPROACHING'
      )
      const here = run.notifications.find(
        (e) => e.p?.type === 'BOARD_BUS_ARRIVING'
      )
      expect(coming).toBeDefined()
      expect(near(coming!.t, at20('09:08:07'), 45)).toBe(true)
      expect(here).toBeDefined()
      expect(near(here!.t, at20('09:17:43'), 45)).toBe(true)
    })

    it('is aboard 1:1186422 / 1:2015 when the ride was (09:19:38)', () => {
      const aboard = run.ridings.find(
        (e) => e.p?.tripId === '1:1186422' && e.p?.vehicleId === '1:2015'
      )
      expect(aboard).toBeDefined()
      expect(near(aboard!.t, at20('09:19:38'), 45)).toBe(true)
      // No vehicle-less riding fact on a later run of the 94 first.
      expect(run.ridings.filter((e) => e.p && !e.p.vehicleId)).toEqual([])
    })
  }
)
