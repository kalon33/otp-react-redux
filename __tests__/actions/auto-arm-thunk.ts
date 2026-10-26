/* globals afterEach, beforeEach, describe, expect, it, jest */
import '../test-utils/mock-window-url'
import { encode } from '@mapbox/polyline'
import coreUtils from '@opentripplanner/core-utils'
import FakeTimers from '@sinonjs/fake-timers'

import {
  ARM_EXPIRY_MS,
  AUTO_ARM_STORAGE_KEY
} from '../../lib/util/go-mode/auto-arm'
import { armGpsActive, stopArmGps } from '../../lib/util/go-mode/auto-arm-gps'
import {
  armRuntimeForTests,
  armTrip,
  cancelArm,
  handleArmFix,
  resumeAutoArm,
  setArmPreset
} from '../../lib/actions/auto-arm'
import {
  AUTO_PRESET_STORAGE_KEY,
  loadAutoPreset
} from '../../lib/util/go-mode/auto-switch'
import {
  beginGoMode,
  beginOnboardFlow,
  endGoMode
} from '../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../lib/actions/apiV2'
import { stopNativeGps } from '../../lib/util/go-mode/native-gps'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'

jest.mock('../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  fetchRerouteSnapshotPlan: jest.fn(() => () => Promise.resolve(null)),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve(null)),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve(null))
}))
jest.mock('../../lib/util/go-mode/native-notify', () => ({
  ...jest.requireActual('../../lib/util/go-mode/native-notify'),
  cancelPush: jest.fn(() => Promise.resolve()),
  sendPush: jest.fn(() => Promise.resolve())
}))
jest.mock('../../lib/util/debug-log', () => ({
  ...jest.requireActual('../../lib/util/debug-log'),
  isTripRecordingEnabled: jest.fn(() => false)
}))

const fetchPlan = fetchOnboardCandidatePlan as jest.Mock

/**
 * "Start when I leave" (backlog 65.2, cycle 36 B4): the thunks over the REAL
 * root reducer (so an arm action missing from create-otp-reducer's goMode
 * delegation list fails here), on a stand-in for the native GPS bridge whose
 * calls are logged in order — the hand-off is the risk: one native watcher
 * per page, its handlers fixed when it is armed.
 */

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0) // 07:00 Chicago
const MIN = 60000
const HOME: [number, number] = [44.95, -93.29]
const STOP: [number, number] = [44.9515, -93.29]
const DEST: [number, number] = [44.99, -93.25]
const north = (m: number): [number, number] => [HOME[0] + m / 111195, HOME[1]]

const place = (at: [number, number], name: string, stop?: string) => ({
  lat: at[0],
  lon: at[1],
  name,
  ...(stop ? { stop: { gtfsId: stop } } : {})
})

/** Walk to the stop, route `r` to near DEST, walk to the door. */
function plan(
  r: string,
  boardMin: number,
  arriveMin: number,
  from = HOME
): any {
  const board = NOW + boardMin * MIN
  const arrive = NOW + arriveMin * MIN
  const near: [number, number] = [DEST[0] - 0.002, DEST[1]]
  return {
    duration: (arrive - NOW) / 1000,
    endTime: arrive,
    legs: [
      {
        distance: 170,
        duration: (board - MIN - NOW) / 1000,
        endTime: board - MIN,
        from: place(from, 'Current location'),
        legGeometry: { points: encode([from, STOP]) },
        mode: 'WALK',
        startTime: NOW,
        to: place(STOP, `Stop ${r}`, `1:S${r}`),
        transitLeg: false
      },
      {
        distance: 6000,
        duration: (arrive - 2 * MIN - board) / 1000,
        endTime: arrive - 2 * MIN,
        from: place(STOP, `Stop ${r}`, `1:S${r}`),
        legGeometry: { points: encode([STOP, near]) },
        mode: 'BUS',
        route: { id: `1:${r}`, shortName: r },
        routeShortName: r,
        startTime: board,
        to: place(near, 'Near home', `1:E${r}`),
        transitLeg: true,
        trip: { gtfsId: `1:t${r}` }
      },
      {
        distance: 220,
        duration: 120,
        endTime: arrive,
        from: place(near, 'Near home'),
        legGeometry: { points: encode([near, DEST]) },
        mode: 'WALK',
        startTime: arrive - 2 * MIN,
        to: place(DEST, 'Work'),
        transitLeg: false
      }
    ],
    startTime: NOW
  }
}

const position = (
  at: [number, number],
  ts: number,
  extra: { accuracy?: number; speed?: number | null } = {}
): any => ({
  coords: {
    accuracy: extra.accuracy ?? 8,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    latitude: at[0],
    longitude: at[1],
    speed: extra.speed === undefined ? 0 : extra.speed
  },
  timestamp: ts
})

/** The Capacitor background-geolocation bridge, every call logged in order. */
function installBridge(log: string[]) {
  const callbacks: Record<string, (loc: any, err?: any) => void> = {}
  let n = 0
  const addWatcher = jest.fn(async (_opts: any, cb: any) => {
    const id = `w${++n}`
    callbacks[id] = cb
    log.push(`addWatcher ${id}`)
    return id
  })
  const removeWatcher = jest.fn(async ({ id }: { id: string }) => {
    log.push(`removeWatcher ${id}`)
    delete callbacks[id]
  })
  ;(window as any).Capacitor = {
    isNativePlatform: () => true,
    Plugins: { BackgroundGeolocation: { addWatcher, removeWatcher } }
  }
  /** A fix from the watcher `id` (default: the newest). */
  const emit = (at: [number, number], ts: number, speed = 0, id?: string) => {
    const key = id ?? `w${n}`
    callbacks[key]?.({
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      bearing: null,
      latitude: at[0],
      longitude: at[1],
      simulated: false,
      speed,
      time: ts
    })
  }
  return { addWatcher, callbacks, emit, removeWatcher }
}

/** A planner store over the REAL root reducer, no trip running. */
function makeStore() {
  const reducer = createOtpReducer({ homeTimezone: 'America/Chicago' } as any)
  let otp: any = reducer(undefined, { type: '@@INIT' })
  otp = {
    ...otp,
    config: { ...otp.config, homeTimezone: 'America/Chicago' },
    currentQuery: { ...otp.currentQuery, routingPreferences: {} }
  }
  const actions: any[] = []
  const getState = () => ({ otp, router: { location: { pathname: '/' } } })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    otp = reducer(otp, action)
    return action
  }
  return {
    actions,
    goMode: () => otp.goMode,
    of: (type: string) => actions.filter((a) => a.type === type),
    run: (thunk: any) => thunk(dispatch, getState)
  }
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('Start when I leave (65.2, cycle 36 B4)', () => {
  let clock: FakeTimers.InstalledClock
  let log: string[]
  let bridge: ReturnType<typeof installBridge>
  let store: ReturnType<typeof makeStore>

  beforeEach(() => {
    clock = FakeTimers.install({
      now: NOW,
      toFake: [
        'Date',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval'
      ]
    })
    coreUtils.storage.removeItem(AUTO_ARM_STORAGE_KEY)
    coreUtils.storage.removeItem(AUTO_PRESET_STORAGE_KEY)
    log = []
    bridge = installBridge(log)
    store = makeStore()
    fetchPlan.mockReset()
    fetchPlan.mockImplementation((combo: any) => () => {
      log.push(`plan from ${combo.from.lat.toFixed(5)}`)
      return Promise.resolve({
        error: false,
        itineraries: [
          plan('B', 9, 42, [combo.from.lat, combo.from.lon]),
          plan('A', 8, 40, [combo.from.lat, combo.from.lon])
        ]
      })
    })
  })

  afterEach(async () => {
    if (store.goMode().isActive) store.run(endGoMode())
    await stopArmGps()
    await stopNativeGps()
    await flush()
    delete (window as any).Capacitor
    clock.uninstall()
  })

  /** Arm, settle the arm point at HOME, then leave north. */
  const armAndLeave = async (preset: any = 'fastest') => {
    store.run(armTrip(plan('A', 8, 40), preset))
    await flush()
    bridge.emit(HOME, NOW + 1000)
    await flush()
    clock.tick(60000)
    bridge.emit(north(90), NOW + 61000)
    await flush()
    bridge.emit(north(100), NOW + 62000)
    await flush(40)
  }

  it('arms on its own watcher and remembers the preset', async () => {
    store.run(armTrip(plan('A', 8, 40), 'leastBike'))
    await flush()
    expect(store.goMode().isActive).toBe(false)
    expect(store.goMode().arm).toMatchObject({
      expiresAtMs: NOW + ARM_EXPIRY_MS,
      preset: 'leastBike',
      status: 'armed',
      to: { lat: DEST[0], lon: DEST[1] }
    })
    expect(loadAutoPreset()).toBe('leastBike')
    expect(log).toEqual(['addWatcher w1'])
    expect(armGpsActive()).toBe(true)
    // the first good fix becomes the arm point and starts nothing
    bridge.emit(HOME, NOW + 1000)
    await flush()
    expect(store.goMode().arm.point).toMatchObject({ lat: HOME[0] })
    expect(store.of('AUTO_ARM_TRIGGER')).toHaveLength(0)
    expect(coreUtils.storage.getItem(AUTO_ARM_STORAGE_KEY, null)).toMatchObject(
      {
        point: { lat: HOME[0] }
      }
    )
  })

  it('leaving: the arm watcher stops FIRST, then a fresh plan from here, then the trip in Auto', async () => {
    await armAndLeave('fastest')
    const trigger = store.of('AUTO_ARM_TRIGGER')
    expect(trigger).toHaveLength(1)
    expect(trigger[0].payload).toMatchObject({ preset: 'fastest', why: 'left' })
    // The order is the hand-off: arm watcher removed, then the plan, then Go
    // Mode's own watcher armed.
    expect(log).toEqual([
      'addWatcher w1',
      'removeWatcher w1',
      `plan from ${north(100)[0].toFixed(5)}`,
      'addWatcher w2'
    ])
    const gm = store.goMode()
    expect(gm.isActive).toBe(true)
    expect(gm.arm).toBeNull()
    expect(gm.auto).toMatchObject({ on: true, preset: 'fastest' })
    // The armed route's next run (nothing in the answer beats it)
    expect(gm.activeItinerary.legs[1].route.id).toBe('1:A')
    expect(store.of('START_GO_MODE')).toHaveLength(1)
    expect(store.of('START_GO_MODE')[0].payload.newTrip).toBe(true)
    expect(store.of('CLEAR_AUTO_ARM')[0].payload).toMatchObject({
      pick: 'same-route',
      why: 'started'
    })
    expect(coreUtils.storage.getItem(AUTO_ARM_STORAGE_KEY, null)).toBeNull()
    // Go Mode's watcher is the one feeding the trip now.
    bridge.emit(north(110), NOW + 63000)
    await flush()
    expect(gm.tracking).toBeDefined()
    expect(store.goMode().tracking.lastPosition?.coords.latitude).toBeCloseTo(
      north(110)[0],
      6
    )
    // ...and the arm's old callback is gone with its watcher.
    expect(bridge.callbacks.w1).toBeUndefined()
  })

  it('the arm card’s preset reaches the trip; a change while armed is remembered', async () => {
    store.run(armTrip(plan('A', 8, 40), 'leastBike'))
    await flush()
    store.run(setArmPreset('simplest'))
    expect(store.goMode().arm.preset).toBe('simplest')
    expect(loadAutoPreset()).toBe('simplest')
    bridge.emit(HOME, NOW + 1000)
    await flush()
    bridge.emit(north(90), NOW + 20000)
    await flush()
    bridge.emit(north(100), NOW + 21000)
    await flush(40)
    expect(store.goMode().auto).toMatchObject({ on: true, preset: 'simplest' })
  })

  it('the preset may take a better route than the armed one at the start', async () => {
    fetchPlan.mockImplementation(
      () => () =>
        Promise.resolve({
          error: false,
          itineraries: [plan('A', 8, 40), plan('B', 7, 33)]
        })
    )
    await armAndLeave('fastest')
    expect(store.goMode().activeItinerary.legs[1].route.id).toBe('1:B')
    expect(store.of('CLEAR_AUTO_ARM')[0].payload.pick).toBe('preset')
    // ...and Stay on my route keeps the armed route
  })

  it('Stay on my route keeps the armed route at the start', async () => {
    fetchPlan.mockImplementation(
      () => () =>
        Promise.resolve({
          error: false,
          itineraries: [plan('B', 7, 33), plan('A', 8, 40)]
        })
    )
    await armAndLeave('stayOnRoute')
    expect(store.goMode().activeItinerary.legs[1].route.id).toBe('1:A')
    expect(store.goMode().auto.preset).toBe('stayOnRoute')
  })

  it('no answer: the armed plan starts', async () => {
    fetchPlan.mockImplementation(
      () => () => Promise.resolve({ error: true, itineraries: [] })
    )
    await armAndLeave('fastest')
    expect(store.goMode().isActive).toBe(true)
    expect(store.of('CLEAR_AUTO_ARM')[0].payload).toMatchObject({
      pick: 'none',
      planError: true
    })
    expect(store.goMode().activeItinerary.legs[1].route.id).toBe('1:A')
  })

  it('no double start: fixes during the start start nothing more', async () => {
    let release: (v: any) => void = () => undefined
    fetchPlan.mockImplementation(
      () => () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    store.run(armTrip(plan('A', 8, 40), 'fastest'))
    await flush()
    bridge.emit(HOME, NOW + 1000)
    await flush()
    bridge.emit(north(90), NOW + 2000)
    await flush()
    bridge.emit(north(100), NOW + 3000)
    await flush()
    // the arm watcher is gone; a straggler through the store changes nothing
    await store.run(handleArmFix(position(north(120), NOW + 4000)))
    await store.run(handleArmFix(position(north(130), NOW + 5000)))
    expect(store.goMode().arm.status).toBe('starting')
    release({ error: false, itineraries: [plan('A', 8, 40)] })
    await flush(40)
    expect(fetchPlan).toHaveBeenCalledTimes(1)
    expect(store.of('AUTO_ARM_TRIGGER')).toHaveLength(1)
    expect(store.of('START_GO_MODE')).toHaveLength(1)
  })

  it('moving 30 s inside the radius starts it too', async () => {
    store.run(armTrip(plan('A', 8, 40), 'fastest'))
    await flush()
    bridge.emit(HOME, NOW)
    await flush()
    for (let s = 1; s <= 31; s++) {
      bridge.emit(north(s % 2 ? 20 : 5), NOW + s * 1000, 1.8)
      await flush()
    }
    await flush(40)
    expect(store.of('AUTO_ARM_TRIGGER')[0]?.payload.why).toBe('moving')
    expect(store.goMode().isActive).toBe(true)
  })

  it('cancel: no trip, watcher removed, remembered preset unchanged', async () => {
    coreUtils.storage.storeItem(AUTO_PRESET_STORAGE_KEY, 'simplest')
    store.run(armTrip(plan('A', 8, 40), 'simplest'))
    await flush()
    await store.run(cancelArm())
    expect(store.goMode().arm).toBeNull()
    expect(store.goMode().isActive).toBe(false)
    expect(log).toEqual(['addWatcher w1', 'removeWatcher w1'])
    expect(loadAutoPreset()).toBe('simplest')
    expect(coreUtils.storage.getItem(AUTO_ARM_STORAGE_KEY, null)).toBeNull()
    expect(store.of('CLEAR_AUTO_ARM')[0].payload.why).toBe('rider')
    expect(armGpsActive()).toBe(false)
  })

  it('a manual Start Trip while armed cancels the arm, and its watcher goes before Go Mode’s', async () => {
    store.run(armTrip(plan('A', 8, 40), 'leastBike'))
    await flush()
    bridge.emit(HOME, NOW + 1000)
    await flush()
    await store.run(beginGoMode(plan('A', 8, 40), { newTrip: true }))
    await flush()
    expect(store.of('CLEAR_AUTO_ARM')[0].payload.why).toBe('manual-start')
    expect(store.goMode().arm).toBeNull()
    // A Start Trip is an ordinary trip start: Auto off (Q2 = A)
    expect(store.goMode().auto.on).toBe(false)
    expect(log).toEqual(['addWatcher w1', 'removeWatcher w1', 'addWatcher w2'])
    expect(fetchPlan).not.toHaveBeenCalled()
    expect(coreUtils.storage.getItem(AUTO_ARM_STORAGE_KEY, null)).toBeNull()
  })

  it('a manual Start Trip during the armed start’s plan fetch wins', async () => {
    let release: (v: any) => void = () => undefined
    fetchPlan.mockImplementation(
      () => () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    store.run(armTrip(plan('A', 8, 40), 'fastest'))
    await flush()
    bridge.emit(HOME, NOW + 1000)
    await flush()
    bridge.emit(north(90), NOW + 2000)
    await flush()
    bridge.emit(north(100), NOW + 3000)
    await flush()
    await store.run(beginGoMode(plan('B', 9, 42), { newTrip: true }))
    release({ error: false, itineraries: [plan('A', 8, 40)] })
    await flush(40)
    expect(store.of('START_GO_MODE')).toHaveLength(1)
    expect(store.goMode().activeItinerary.legs[1].route.id).toBe('1:B')
    expect(store.goMode().auto.on).toBe(false)
  })

  it('"I\'m already on the bus" cancels the arm and Go Mode re-arms the native watcher', async () => {
    store.run(armTrip(plan('A', 8, 40), 'fastest'))
    await flush()
    store.run(beginOnboardFlow())
    await flush()
    expect(store.goMode().arm).toBeNull()
    expect(store.of('CLEAR_AUTO_ARM')[0].payload.why).toBe('onboard')
    // released and re-added with Go Mode's handlers (restartNativeGps)
    expect(log).toEqual(['addWatcher w1', 'removeWatcher w1', 'addWatcher w2'])
    bridge.emit(north(5), NOW + 2000)
    await flush()
    expect(store.goMode().tracking.lastPosition?.coords.latitude).toBeCloseTo(
      north(5)[0],
      6
    )
  })

  it('expiry: two hours and nobody left — the arm lapses, nothing starts', async () => {
    store.run(armTrip(plan('A', 8, 40), 'fastest'))
    await flush()
    bridge.emit(HOME, NOW + 1000)
    await flush()
    clock.tick(ARM_EXPIRY_MS - 1000)
    await flush()
    expect(store.goMode().arm).not.toBeNull()
    clock.tick(1000)
    await flush()
    expect(store.goMode().arm).toBeNull()
    expect(store.of('CLEAR_AUTO_ARM')[0].payload).toMatchObject({
      armedForMin: 120,
      why: 'expired'
    })
    expect(log).toEqual(['addWatcher w1', 'removeWatcher w1'])
    expect(store.goMode().isActive).toBe(false)
    expect(coreUtils.storage.getItem(AUTO_ARM_STORAGE_KEY, null)).toBeNull()
  })

  it('a reload while armed: the arm comes back with its point and still starts', async () => {
    store.run(armTrip(plan('A', 8, 40), 'leastBike'))
    await flush()
    bridge.emit(HOME, NOW + 1000)
    await flush()
    // the page goes away (its watcher with it)
    await stopArmGps()
    await stopNativeGps()
    log.length = 0
    const reloaded = makeStore()
    expect(reloaded.goMode().arm).toMatchObject({
      point: { lat: HOME[0] },
      preset: 'leastBike',
      status: 'armed'
    })
    store = reloaded
    store.run(resumeAutoArm())
    await flush()
    expect(armRuntimeForTests().armId).toBe(store.goMode().arm.id)
    bridge.emit(north(200), NOW + 90000)
    await flush()
    bridge.emit(north(210), NOW + 91000)
    await flush(40)
    expect(store.goMode().isActive).toBe(true)
    expect(store.goMode().auto).toMatchObject({ on: true, preset: 'leastBike' })
  })
})
