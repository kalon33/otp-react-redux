/* globals describe, expect, it, jest */
import '../../test-utils/mock-window-url'

import { existsSync } from 'fs'
import path from 'path'

import { applyMiddleware, combineReducers, createStore } from 'redux'
import FakeTimers from '@sinonjs/fake-timers'
import thunk from 'redux-thunk'

import { replayTrip, stopReplay } from '../../../lib/actions/go-mode'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'

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

const FIXTURE_DIR = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)
const load = (name: string) => {
  const p = path.join(FIXTURE_DIR, `${name}.json`)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return existsSync(p) ? require(p) : null
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

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

async function replay(fx: any, speed: number) {
  const globalScope: any = global
  globalScope.fetch = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({}), ok: true, status: 200 })
  )
  const clock = FakeTimers.install({ now: 1790181000000 })
  const autoReplans: Array<{
    accepted: boolean
    at: string
    planLeftByRider: boolean
    reason: string
    refusedBecause: string | null
  }> = []
  const statuses: Array<{ at: string; status: string }> = []
  let lastSim = 0
  const recorder = () => (next: any) => (action: any) => {
    if (action?.type === 'AUTO_REPLAN') {
      autoReplans.push({
        accepted: action.payload.accepted,
        at: hhmmss(action.payload.tMs),
        planLeftByRider: action.payload.planLeftByRider,
        reason: action.payload.reason,
        refusedBecause: action.payload.refusedBecause
      })
    }
    return next(action)
  }
  const store = createStore(
    combineReducers({ otp: createOtpReducer(CONFIG as any) }),
    applyMiddleware(thunk, recorder)
  )
  store.subscribe(() => {
    const g = store.getState().otp.goMode
    if (!g || g.simulation?.status !== 'running') return
    if (g.progress?.currentTime) {
      const t = new Date(g.progress.currentTime).getTime()
      if (t !== lastSim) {
        lastSim = t
        const s = g.progress.status
        if (statuses[statuses.length - 1]?.status !== s) {
          statuses.push({ at: hhmmss(t), status: s })
        }
      }
    }
  })
  await store.dispatch(replayTrip(fx, { speedMultiplier: speed }) as any)
  for (let i = 0; i < 20000; i++) {
    await clock.tickAsync(1000)
    if (store.getState().otp.goMode.simulation.status !== 'running') break
  }
  store.dispatch(stopReplay() as any)
  clock.uninstall()
  jest.restoreAllMocks()
  return { autoReplans, statuses }
}

/** The phone's state at the last swap (17:31:08.569, the bike-only plan). */
const fromLastSwap = (fx: any) => {
  const swap = fx.itinerarySwaps[fx.itinerarySwaps.length - 1]
  return {
    ...fx,
    gpsTrack: fx.gpsTrack.filter((p: any) => p.tMs >= swap.tMs),
    itinerary: swap.itinerary,
    meta: { ...fx.meta, startMs: swap.tMs }
  }
}

/**
 * Backlog 35.2, replayed. 2026-09-28 17:35-17:39 (`muls77mv-9u3dsl`): on the
 * bike-only plan installed 17:31:08 the rider rode a parallel street, up to
 * 326 m off the plan, and three `quiet-replan-full` answers were refused
 * `arrives-later`. Replayed from the phone's state at that swap, the refusals
 * come back at 17:35:51, 17:36:22 and 17:36:47 (phone: 17:35:53, 17:36:32,
 * 17:36:49), deviated from 17:35:32 (phone 17:35:33).
 *
 * Those refusals were RIGHT, and they must stay: the rider closed on the
 * destination the whole streak (831 -> 734 -> ~680 m in a straight line) and
 * arrived 17:39:57 against the held 17:40:37, while the candidates arrived
 * 17:45:44-17:48:39 over 1 772-2 068 m of riding. With the deviation window
 * alone (the plan's first shape, `DEVIATED_PLAN_MIN_CLOSING_M` lifted) this
 * same replay waived the arrival test at 17:36:22 and 17:38:22 — only a
 * served-plan timing artifact (`origin-behind-rider`) kept those candidates
 * off the screen. The convergence test keeps the arrival test on.
 *
 * `orange-1600-0928.json` (the same afternoon, `mulprntn-d5ytkh`): its one
 * `quiet-replan-full`, 16:38:43, lands 4 s into a streak the rider closed
 * themselves; it stays refused.
 */
const ride = load('ride-0928-1651')
const onRoute = load('orange-1600-0928')

// Both fixtures are 10-15 MB and untracked (like missed-bus-at-stop-0921's),
// so each block skips when its fixture is absent.
const withRide = ride ? describe : describe.skip
const withOnRoute = onRoute ? describe : describe.skip

withRide('35.2: a rider converging off the line keeps the arrival test', () => {
  it('ride-0928-1651 from the 17:31:08 swap: all three refused arrives-later', async () => {
    const r = await replay(fromLastSwap(ride), 1)
    expect(r.statuses.find((s) => s.status === 'deviated')?.at).toBe('17:35:32')
    const full = r.autoReplans.filter((a) => a.reason === 'quiet-replan-full')
    expect(full).toHaveLength(3)
    for (const a of full) {
      expect(a).toMatchObject({
        accepted: false,
        planLeftByRider: false,
        refusedBecause: 'arrives-later'
      })
    }
  }, 600000)

  it('ride-0928-1651 whole ride: no re-plan waived the arrival test', async () => {
    const r = await replay(ride, 1)
    expect(r.autoReplans.length).toBeGreaterThan(0)
    expect(r.autoReplans.filter((a) => a.planLeftByRider)).toEqual([])
    expect(
      r.autoReplans.filter(
        (a) => a.reason === 'quiet-replan-full' && a.accepted
      )
    ).toEqual([])
  }, 600000)
})

withOnRoute('35.2 on orange-1600-0928', () => {
  it('the 16:38:43 attempt stays refused', async () => {
    const r = await replay(onRoute, 1)
    expect(r.autoReplans.filter((a) => a.planLeftByRider)).toEqual([])
    expect(
      r.autoReplans.find((a) => a.reason === 'quiet-replan-full')
    ).toMatchObject({
      accepted: false,
      at: '16:38:43',
      refusedBecause: 'arrives-later'
    })
  }, 600000)
})
