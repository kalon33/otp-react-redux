/* globals afterEach, describe, expect, it, jest */
import '../../test-utils/mock-window-url'

import fs from 'fs'
import path from 'path'

import { applyMiddleware, combineReducers, createStore } from 'redux'
import FakeTimers from '@sinonjs/fake-timers'
import thunk from 'redux-thunk'

import {
  goModeNowMs,
  replayTrip,
  stopReplay
} from '../../../lib/actions/go-mode'
import {
  replaySwapVerdict,
  transitPlanKey
} from '../../../lib/util/go-mode/replay/replay-swaps'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'

/** Same stub as replay-clock-7529.ts: these replays run the real tick. */
jest.mock('@opentripplanner/core-utils', () => {
  const actual = jest.requireActual('@opentripplanner/core-utils')
  const { parse } = jest.requireActual('graphql')
  const stub = parse('query Plan { plan { itineraries { duration } } }')
  const core = actual.default || actual
  const patched = {
    ...core,
    queryGen: {
      ...core.queryGen,
      generateOtp2Query: (params: unknown) =>
        core.queryGen.generateOtp2Query(params, stub)
    }
  }
  return { ...actual, __esModule: true, default: patched }
})

/**
 * BACKLOG 75.30 — a replay makes the rider's own plan changes again, at their
 * recorded time, and leaves the app's to the app.
 *
 * `replayTrip` installed `fixture.itinerary` once and played the track; the
 * fixture's `itinerarySwaps` were never read. 2026-10-26 `mvpik996-01erej`:
 * at 12:17:00.050 the rider replaced the D Line plan with an Orange Line plan
 * from the planner (START_GO_MODE `newTrip: true`); the ride boarded the
 * Orange Line (TRANSITION_LEG 1 12:34:07, SET_RIDING 1:1274584 / 1:8149
 * 12:34:39). The replay stayed on the D Line plan: leg 0 to the end of the
 * track, "Routing stops here · 8502m" 12:37:11, "Leave in 2 min · METRO D
 * Line" 12:52:50 and "METRO D Line missed" 12:59:07.
 *
 * Who made each swap is the fixture builder's record (build-fixture.js
 * `swapCause`, `--annotate-swaps`). The causes below are what it reads from
 * the day files; a fixture on disk that already carries them must agree.
 */
const FIXTURES = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)
const load = (name: string): any => {
  const file = path.join(FIXTURES, `${name}.json`)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

interface Cause {
  /** The swap's START_GO_MODE, local wall time with ms. */
  at: string
  by: 'app' | 'rider' | 'unknown'
  cause: string | null
  newTrip?: true
}

/** `build-fixture.js --annotate-swaps` on each fixture, 2026-10-29. */
const RECORDED: Record<string, Cause[]> = {
  // debug-2026-10-26.jsonl
  '1026-1214': [
    { at: '12:14:00.947', by: 'app', cause: 'plan-retarget' },
    { at: '12:17:00.050', by: 'rider', cause: 'start-trip', newTrip: true },
    { at: '12:27:09.217', by: 'app', cause: 'quiet-replan-scoped' }
  ],
  // debug-2026-10-19.jsonl
  'gold-1631-1019': [
    { at: '16:33:39.950', by: 'rider', cause: 'onboard-preview-confirm' },
    { at: '16:35:17.027', by: 'rider', cause: 'onboard-preview-confirm' }
  ],
  // debug-2026-10-20.jsonl
  'ride-1020-0907': [
    { at: '09:08:14.200', by: 'app', cause: 'quiet-replan-scoped' },
    { at: '09:08:48.238', by: 'app', cause: 'quiet-replan-scoped' },
    { at: '09:24:26.813', by: 'rider', cause: 'faster-route-aboard' },
    { at: '09:25:16.460', by: 'rider', cause: 'onboard-preview-confirm' }
  ]
}

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/Chicago' })
const hhmmssms = (ms: number) =>
  `${hhmmss(ms)}.${String(ms % 1000).padStart(3, '0')}`

/** A copy of `fixture` carrying the recorded causes. */
function withCauses(fixture: any, name: string): any {
  const fx = JSON.parse(JSON.stringify(fixture))
  const causes = RECORDED[name]
  expect(fx.itinerarySwaps.map((s: any) => hhmmssms(s.tMs))).toEqual(
    causes.map((c) => c.at)
  )
  fx.itinerarySwaps.forEach((s: any, i: number) => {
    const { at, ...cause } = causes[i]
    if (s.by != null) {
      // Annotated on disk: it must say what the day file says.
      expect({ by: s.by, cause: s.cause, newTrip: s.newTrip }).toEqual({
        newTrip: undefined,
        ...cause
      })
    }
    delete s.newTrip
    Object.assign(s, cause)
  })
  return fx
}

/** A copy with no record of who made the swaps — a fixture cut before 75.30. */
function withoutCauses(fixture: any): any {
  const fx = JSON.parse(JSON.stringify(fixture))
  for (const s of fx.itinerarySwaps) {
    delete s.by
    delete s.cause
    delete s.newTrip
  }
  return fx
}

/** 2026-10-29 08:00 CDT: a replay runs long after its ride (75.29). */
const WALL = Date.parse('2026-10-29T08:00:00-05:00')

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
  /** Go Mode's clock when the action was dispatched. */
  t: number
  type: string
}

async function replay(
  fx: any,
  { speed, untilSimMs }: { speed: number; untilSimMs?: number }
): Promise<Recorded[]> {
  const globalScope: any = global
  globalScope.fetch = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({}), ok: true, status: 200 })
  )
  const clock = FakeTimers.install({ now: WALL })
  const events: Recorded[] = []
  const recorder = () => (next: any) => (action: any) => {
    if (action && typeof action === 'object' && action.type) {
      events.push({ p: action.payload, t: goModeNowMs(), type: action.type })
    }
    return next(action)
  }
  const store = createStore(
    combineReducers({ otp: createOtpReducer(CONFIG as any) }),
    applyMiddleware(thunk, recorder)
  )
  try {
    await store.dispatch(replayTrip(fx, { speedMultiplier: speed }) as any)
    for (let i = 0; i < 20000; i++) {
      await clock.tickAsync(1000)
      if (store.getState().otp.goMode.simulation.status !== 'running') break
      if (untilSimMs != null && goModeNowMs() >= untilSimMs) break
    }
  } finally {
    store.dispatch(stopReplay() as any)
    clock.uninstall()
  }
  return events
}

const of = (events: Recorded[], type: string) =>
  events.filter((e) => e.type === type)
const swapLog = (events: Recorded[]) =>
  events
    .filter((e) => e.type.startsWith('REPLAY_SWAP_'))
    .map(
      (e) =>
        `${hhmmssms(e.t)} ${e.type.replace('REPLAY_SWAP_', '')} ${
          e.p.by ?? '-'
        } ${e.p.cause ?? '-'}${e.p.why ? ` (${e.p.why})` : ''}`
    )
const tripIds = (itinerary: any) =>
  (itinerary?.legs || [])
    .filter((l: any) => l.transitLeg)
    .map((l: any) => l.trip?.gtfsId)
const pushes = (events: Recorded[]) =>
  of(events, 'ADD_NOTIFICATION').map(
    (e) => `${hhmmss(e.t)} ${e.p.type}: ${e.p.title} | ${e.p.message}`
  )

/**
 * The replay installs only what the replayed app decided or the rider did:
 * every START_GO_MODE after the trip's own comes in the same sim instant as a
 * re-applied rider swap or the app's own accepted re-plan / applied
 * re-target — never a recorded app swap fed in from the fixture.
 */
function expectEveryInstallExplained(events: Recorded[]) {
  const starts = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === 'START_GO_MODE')
  const unexplained = starts.slice(1).filter(({ e, i }) => {
    const prevStart = starts.filter((s) => s.i < i).pop()?.i ?? -1
    return !events
      .slice(prevStart + 1, i)
      .some(
        (c) =>
          c.t === e.t &&
          (c.type === 'REPLAY_SWAP_APPLIED' ||
            (c.type === 'AUTO_REPLAN' && c.p?.accepted) ||
            (c.type === 'PLAN_RETARGET' && c.p?.verdict === 'applied'))
      )
  })
  expect(unexplained.map(({ e }) => hhmmssms(e.t))).toEqual([])
}

afterEach(() => {
  jest.restoreAllMocks()
})

jest.setTimeout(900000)

const ride1214 = load('1026-1214')
;(ride1214 ? describe : describe.skip)(
  '75.30 — 1026-1214: the rider’s planner Start at 12:17:00 is made again',
  () => {
    it('rides the Orange Line plan the rider chose, as the ride did', async () => {
      const events = await replay(withCauses(ride1214, '1026-1214'), {
        speed: 12
      })

      // At its own instant, with the plan the rider tapped: the Orange Line
      // (1:1274584) and the 546 (1:1136166) instead of the D Line plan.
      const swapped = of(events, 'START_GO_MODE').find(
        (e) => hhmmssms(e.t) === '12:17:00.050'
      )
      expect(tripIds(swapped?.p.itinerary)).toEqual(['1:1274584', '1:1136166'])
      expect(swapped?.p.newTrip).toBe(true)

      // The ride from there: onto the Orange Line leg at 12:34:07 and riding
      // 1:1274584 on vehicle 1:8149 at 12:34:39. The replay's fixes say so
      // at 12:34:10 and 12:34:39.
      const toOrange = of(events, 'TRANSITION_LEG').find(
        (e) => (typeof e.p === 'object' ? e.p.legIndex : e.p) === 1
      ) as Recorded
      expect(toOrange).toBeDefined()
      expect(
        Math.abs(toOrange.t - Date.parse('2026-10-26T12:34:07-05:00'))
      ).toBeLessThanOrEqual(10000)
      const riding = of(events, 'SET_RIDING').find(
        (e) => e.p?.tripId === '1:1274584'
      ) as Recorded
      expect(riding).toBeDefined()
      expect(riding.p.vehicleId).toBe('1:8149')
      expect(
        Math.abs(riding.t - Date.parse('2026-10-26T12:34:39-05:00'))
      ).toBeLessThanOrEqual(5000)

      // None of the abandoned plan's pushes: no "Routing stops here" at
      // 12:37:12, no D Line "Leave" at 12:52:51, no D Line miss at 12:59:08.
      const said = pushes(events)
      expect(said.filter((p) => p.includes('DESTINATION_UNREACHABLE'))).toEqual(
        []
      )
      expect(said.filter((p) => p.includes('D Line'))).toEqual([])
      expect(said.filter((p) => p.includes('MISSED_BUS'))).toEqual([])

      // The rider's swap is the one made again; the app's two are left to
      // the app, and everything installed is explained.
      expect(swapLog(events)).toEqual([
        '12:14:00.947 SKIPPED app plan-retarget (app-made)',
        '12:17:00.050 APPLIED rider start-trip',
        '12:27:09.217 SKIPPED app quiet-replan-scoped (app-made)'
      ])
      expectEveryInstallExplained(events)
    })

    it('leaves a swap nobody recorded the cause of to the app, as before', async () => {
      const startMs = ride1214.meta.startMs
      const events = await replay(withoutCauses(ride1214), {
        speed: 12,
        untilSimMs: startMs + 4 * 60 * 1000
      })
      expect(swapLog(events)).toEqual([
        '12:14:00.947 SKIPPED - - (cause-not-recorded)',
        '12:17:00.050 SKIPPED - - (cause-not-recorded)'
      ])
      expect(of(events, 'START_GO_MODE')).toHaveLength(1)
    })
  }
)

const gold = load('gold-1631-1019')
;(gold ? describe : describe.skip)(
  '75.30 — gold-1631-1019: two onboard Confirms, both the rider’s',
  () => {
    it('makes both again at their own instants, and the ride follows', async () => {
      const events = await replay(withCauses(gold, 'gold-1631-1019'), {
        speed: 12
      })
      const installs = of(events, 'START_GO_MODE').map(
        (e) => `${hhmmssms(e.t)} ${tripIds(e.p.itinerary).join(' ')}`
      )
      expect(installs).toEqual([
        '16:31:37.274 1:1343603 1:1186627 1:1268816',
        '16:33:39.950 1:1343603 1:895986 2:t6B2-b156-sl1C-v64',
        '16:35:17.027 1:1343603 1:1347063'
      ])
      expect(swapLog(events)).toEqual([
        '16:33:39.950 APPLIED rider onboard-preview-confirm',
        '16:35:17.027 APPLIED rider onboard-preview-confirm'
      ])
      expectEveryInstallExplained(events)
      // The ride's own next moments, now on the plan it was on: "253m from
      // the route" at 16:35:50.108 (debug-2026-10-19.jsonl) — and no
      // "METRO Gold Line missed", which the replay pushed at 16:37:43 while
      // it still held the plan the rider had replaced.
      const offRoute = of(events, 'ADD_NOTIFICATION').find(
        (e) => e.p.type === 'ROUTE_DEVIATION'
      ) as Recorded
      expect(offRoute?.p.message).toBe('253m from the route')
      expect(
        Math.abs(offRoute.t - Date.parse('2026-10-19T16:35:50.108-05:00'))
      ).toBeLessThanOrEqual(2000)
      expect(pushes(events).filter((p) => p.includes('MISSED_BUS'))).toEqual([])
    })
  }
)

const ride0907 = load('ride-1020-0907')
;(ride0907 ? describe : describe.skip)(
  '75.30 — ride-1020-0907: the app’s re-plans are never fed in',
  () => {
    it('leaves the app’s quiet re-plans to the replayed app and makes the rider’s Switch', async () => {
      const events = await replay(withCauses(ride0907, 'ride-1020-0907'), {
        speed: 12
      })
      // The rider's Switch is the plan they rode: the 94 (1:1186422) on
      // vehicle 1:2015, then the Gold Line (1:1262609).
      const switched = of(events, 'START_GO_MODE').find(
        (e) => hhmmssms(e.t) === '09:24:26.813'
      )
      expect(tripIds(switched?.p.itinerary)).toEqual(['1:1186422', '1:1262609'])
      expect(
        of(events, 'SET_RIDING').some(
          (e) => e.p?.tripId === '1:1186422' && e.p?.vehicleId === '1:2015'
        )
      ).toBe(true)
      // The ride's 09:08:14 re-plan was the APP's: the replayed app asks its
      // own question at that moment and its own answer stands. Nothing is
      // installed at the ride's instants.
      const own = of(events, 'AUTO_REPLAN').find(
        (e) => hhmmss(e.t) === '09:08:14'
      )
      expect(own?.p.reason).toBe('quiet-replan-scoped')
      expect(
        of(events, 'START_GO_MODE').filter((e) =>
          ['09:08:14.200', '09:08:48.238'].includes(hhmmssms(e.t))
        )
      ).toEqual([])
      expect(swapLog(events)).toEqual([
        '09:08:14.200 SKIPPED app quiet-replan-scoped (app-made)',
        '09:08:48.238 SKIPPED app quiet-replan-scoped (app-made)',
        '09:24:26.813 APPLIED rider faster-route-aboard',
        // The Confirm 50 s later installed the same two runs: the replay is
        // already on them, so there is nothing to make again.
        '09:25:16.460 SKIPPED rider onboard-preview-confirm (already-installed)'
      ])
      expectEveryInstallExplained(events)
    })
  }
)

describe('75.30 replaySwapVerdict', () => {
  const leg = (tripId: string | null, stopId: string, startTime: number) => ({
    from: { stop: { gtfsId: stopId } },
    mode: 'BUS',
    routeId: '1:904',
    startTime,
    transitLeg: true,
    trip: tripId ? { gtfsId: tripId } : undefined
  })
  const bike = { mode: 'BICYCLE', startTime: 0, transitLeg: false }
  const plan = (...legs: any[]) => ({ legs } as any)

  it('applies only the rider’s, onto a running trip, when the plan differs', () => {
    const active = plan(bike, leg('1:A', '1:1', 0))
    const swap = (by?: any) => ({
      by,
      itinerary: plan(bike, leg('1:B', '1:1', 0)),
      tMs: 1
    })
    const goMode = { activeItinerary: active, isActive: true }
    expect(replaySwapVerdict(swap('rider'), goMode)).toEqual({ apply: true })
    expect(replaySwapVerdict(swap('app'), goMode)).toEqual({
      apply: false,
      why: 'app-made'
    })
    expect(replaySwapVerdict(swap('unknown'), goMode)).toEqual({
      apply: false,
      why: 'cause-unknown'
    })
    expect(replaySwapVerdict(swap(), goMode)).toEqual({
      apply: false,
      why: 'cause-not-recorded'
    })
    expect(
      replaySwapVerdict(swap('rider'), {
        activeItinerary: null,
        isActive: false
      })
    ).toEqual({ apply: false, why: 'no-trip' })
  })

  it('counts the same runs as the same plan, whatever the access legs say', () => {
    const at = Date.parse('2026-10-26T12:30:00-05:00')
    // Same trip ids, different access leg: already installed.
    expect(
      replaySwapVerdict(
        { by: 'rider', itinerary: plan(leg('1:A', '1:1', at)), tMs: 1 },
        { activeItinerary: plan(bike, leg('1:A', '1:1', at)), isActive: true }
      )
    ).toEqual({ apply: false, why: 'already-installed' })
    // No trip ids: the same stop and departure minute is the same run...
    expect(
      transitPlanKey(plan(leg(null, '1:1', at))) ===
        transitPlanKey(plan(bike, leg(null, '1:1', at + 20000)))
    ).toBe(true)
    // ...and the next departure is not.
    expect(
      replaySwapVerdict(
        { by: 'rider', itinerary: plan(leg(null, '1:1', at + 600000)), tMs: 1 },
        { activeItinerary: plan(leg(null, '1:1', at)), isActive: true }
      )
    ).toEqual({ apply: true })
  })
})
