/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-function, sort-keys */
/**
 * T2/T3/T6 — Go Mode's synchronous per-tick and per-start costs, run over
 * recorded rides (replay fixtures, untracked; located via PERF_FIXTURES_DIR).
 *
 * Run: scripts/perf/bench.sh go-mode-tick.perf.ts (sets PERF_BENCH=1).
 *
 * PERF_FIXTURES_LIST picks the fixtures (comma-separated basenames).
 */
import FakeTimers from '@sinonjs/fake-timers'

import {
  beginGoMode,
  endGoMode,
  handlePositionUpdate,
  performVehicleMatching
} from '../../lib/actions/go-mode'
import {
  bench,
  itInput,
  loadJson,
  median,
  note,
  PERF_FIXTURES_DIR,
  report
} from '../test-utils/perf-utils'
import {
  findNearbyVehicles,
  matchUserToVehicle
} from '../../lib/util/go-mode/vehicle-matching'
import { saveGoModeSession } from '../../lib/util/go-mode/session-persistence'
import goModeReducer from '../../lib/reducers/go-mode'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalAny: any = global

// Benchmarks take minutes and need data that CI lacks: skipped unless PERF_BENCH=1
// (scripts/perf/bench.sh sets it). A plain `yarn unit` skips this file.
const RUN = process.env.PERF_BENCH === '1'
const describeBench = RUN ? describe : describe.skip

jest.mock('../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(
    () => () => Promise.resolve({ error: false, itineraries: [] })
  ),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

const NAMES = (
  process.env.PERF_FIXTURES_LIST ||
  'gold-1631-1019.json,orange-1655-1012.json,ride-1020-0907.json'
).split(',')

const initial = goModeReducer(undefined, { type: '@@INIT' })

const positionOf = (fix: any): GeolocationPosition =>
  ({
    coords: {
      accuracy: fix.accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: fix.heading,
      latitude: fix.lat,
      longitude: fix.lon,
      speed: fix.speed
    },
    timestamp: fix.tMs
  } as GeolocationPosition)

function vehiclesAt(fx: any, routeId: string, nowMs: number): any[] {
  let best: any = null
  for (const snap of fx.vehicleSnapshots) {
    const rid = snap.routeId ?? snap.payload?.routeId
    if (rid !== routeId) continue
    if (snap.tMs <= nowMs && (!best || snap.tMs > best.tMs)) best = snap
  }
  return (best ?? fx.vehicleSnapshots[0])?.payload?.vehicles ?? []
}

/** goMode slice + the bits of otp the thunks read; counts subscriber saves. */
function makeStore(fx: any, itinerary: any, routeIds: string[]) {
  let goModeState: any = {
    ...initial,
    activeItinerary: itinerary,
    isActive: true,
    tracking: { ...initial.tracking, lastPosition: null }
  }
  let nowMs = 0
  const actions: any[] = []
  let goModeChanges = 0
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      location: { currentPosition: { coords: null } },
      transitIndex: {
        routes: Object.fromEntries(
          routeIds.map((id) => [id, { vehicles: vehiclesAt(fx, id, nowMs) }])
        ),
        stops: {},
        trips: {}
      }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    const next = goModeReducer(goModeState, action)
    if (next !== goModeState) goModeChanges++
    goModeState = next
    return action
  }
  return {
    actions,
    changes: () => goModeChanges,
    dispatch,
    getGoMode: () => goModeState,
    getState,
    setNow: (ms: number) => {
      nowMs = ms
    }
  }
}

describeBench('T2/T3/T6 Go Mode synchronous costs over recorded rides', () => {
  jest.setTimeout(900000)
  let clock: FakeTimers.InstalledClock | undefined
  let logSpy: jest.SpyInstance
  beforeAll(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    globalAny.fetch = () => new Promise(() => {})
  })
  afterEach(() => {
    clock?.uninstall()
    clock = undefined
  })

  NAMES.forEach((name) =>
    itInput(it, `${PERF_FIXTURES_DIR}/${name}`, name, async () => {
      const fx = loadJson(`${PERF_FIXTURES_DIR}/${name}`)
      const itinerary = fx.itinerary
      const routeIds: string[] = fx.meta?.routeIds || []
      const itinChars = JSON.stringify(itinerary).length
      const snapSizes = fx.vehicleSnapshots.map(
        (s: any) => s.payload?.vehicles?.length || 0
      )
      note(
        `\n=== ${name}: legs=${
          itinerary.legs.length
        } itineraryChars=${itinChars} gpsFixes=${
          fx.gpsTrack.length
        } vehicleSnapshots=${
          fx.vehicleSnapshots.length
        } vehicles/snapshot median=${median(snapSizes)} max=${Math.max(
          ...snapSizes
        )}`
      )

      // --- T6: the main.js:148 store subscriber, saveGoModeSession ----------
      const started = goModeReducer(initial, {
        payload: {
          itinerary,
          multiStop: null,
          originalFrom: null,
          roundTrip: null
        },
        type: 'START_GO_MODE'
      })
      bench('  saveGoModeSession (stripCycles + storeItem), one call', (i) =>
        saveGoModeSession(
          { ...started, vehicleMatch: { match: { i } } } as any,
          'sid',
          null
        )
      )
      const saved = window.localStorage.getItem('otp.goModeSession') || ''
      let savedLen = saved.length
      if (!savedLen) {
        for (let k = 0; k < window.localStorage.length; k++) {
          const key = window.localStorage.key(k) as string
          if (/goMode/i.test(key))
            savedLen = (window.localStorage.getItem(key) || '').length
        }
      }
      note(`    -> persisted session ${savedLen} chars per write`)

      // --- T2: vehicle matching against a real snapshot --------------------
      const routeId =
        routeIds.find((id) => vehiclesAt(fx, id, Infinity).length) ||
        routeIds[0]
      const busy = fx.vehicleSnapshots.reduce(
        (a: any, s: any) =>
          (s.payload?.vehicles?.length || 0) >
          (a.payload?.vehicles?.length || 0)
            ? s
            : a,
        fx.vehicleSnapshots[0]
      )
      const vehicles = busy.payload.vehicles
      const g = fx.gpsTrack[Math.floor(fx.gpsTrack.length / 2)]
      bench(`  matchUserToVehicle (${vehicles.length} vehicles), x100`, () => {
        for (let k = 0; k < 100; k++) {
          matchUserToVehicle(
            g.lat,
            g.lon,
            g.heading,
            vehicles,
            routeId,
            null,
            80,
            g.speed,
            null,
            {
              ridingVehicleId: null
            } as any
          )
        }
      })
      bench(`  findNearbyVehicles (${vehicles.length} vehicles), x100`, () => {
        for (let k = 0; k < 100; k++)
          findNearbyVehicles(g.lat, g.lon, vehicles, 200, {
            userSpeedMps: g.speed
          })
      })

      // --- T6/T2: the real tick over the recorded track --------------------
      clock = FakeTimers.install({ now: fx.gpsTrack[0].tMs, toFake: ['Date'] })
      const store = makeStore(fx, itinerary, routeIds)
      const { performance } = jest.requireActual('perf_hooks')
      const perTick: number[] = []
      const perMatch: number[] = []
      const actionsPerTick: number[] = []
      const changesPerTick: number[] = []
      const track = fx.gpsTrack.slice(0, Math.min(fx.gpsTrack.length, 1500))
      let lastMatchAt = -Infinity
      for (const fix of track) {
        clock.setSystemTime(fix.tMs)
        store.setNow(fix.tMs)
        const a0 = store.actions.length
        const c0 = store.changes()
        const t0 = performance.now()
        store.dispatch(handlePositionUpdate(positionOf(fix)))
        perTick.push(performance.now() - t0)
        actionsPerTick.push(store.actions.length - a0)
        changesPerTick.push(store.changes() - c0)
        if (fix.tMs - lastMatchAt >= 15000) {
          lastMatchAt = fix.tMs
          const m0 = performance.now()
          for (const id of routeIds) store.dispatch(performVehicleMatching(id))
          perMatch.push(performance.now() - m0)
        }
      }
      // Which action is the LAST record of a tick (what a late next tick
      // would show as "the record before the gap")?
      const lastOfTick: Record<string, number> = {}
      {
        let idx = 0
        const seqs: string[] = []
        actionsPerTick.forEach((n, ti) => {
          const types = store.actions
            .slice(idx, idx + n)
            .map((a: any) => a.type)
          idx += n
          const last = types[types.length - 1] || '(none)'
          lastOfTick[last] = (lastOfTick[last] || 0) + 1
          if (ti % 300 === 150) seqs.push(types.join('>'))
        })
        note(
          `    -> last action of each tick: ${JSON.stringify(
            lastOfTick
          )}; sample ticks: ${seqs.join(' | ')}`
        )
      }
      const sorted = [...perTick].sort((x, y) => x - y)
      const p = (q: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
      report(
        `  handlePositionUpdate tick (${perTick.length} fixes) p50`,
        p(0.5)
      )
      report('  handlePositionUpdate tick p90', p(0.9))
      report('  handlePositionUpdate tick max', sorted[sorted.length - 1])
      report(
        `  performVehicleMatching (all ${routeIds.length} routes, ${perMatch.length} polls)`,
        median(perMatch)
      )
      note(
        `    -> actions per tick median ${median(
          actionsPerTick
        )}, goMode-slice changes per tick median ${median(
          changesPerTick
        )} (each one runs saveGoModeSession in the app), types: ${JSON.stringify(
          Object.entries(
            store.actions.reduce(
              (acc: any, a: any) => (
                (acc[a.type] = (acc[a.type] || 0) + 1), acc
              ),
              {}
            )
          )
            .sort((x: any, y: any) => y[1] - x[1])
            .slice(0, 12)
        )}`
      )

      // --- T3: beginGoMode end to end (mocked network) ---------------------
      store.dispatch(endGoMode())
      const fresh = makeStore(fx, null, routeIds)
      clock.setSystemTime(fx.gpsTrack[0].tMs)
      const b0 = performance.now()
      const pr = fresh.dispatch(
        beginGoMode(JSON.parse(JSON.stringify(itinerary)))
      )
      const syncMs = performance.now() - b0
      await pr
      const totalMs = performance.now() - b0
      report('  beginGoMode synchronous prefix (to first await)', syncMs)
      report('  beginGoMode total incl. resolved mocks', totalMs)
      note(`    -> actions: ${fresh.actions.map((a: any) => a.type).join(',')}`)
      fresh.dispatch(endGoMode())
      logSpy.mockClear()
    })
  )
})
