/* globals afterEach, beforeEach, describe, expect, it, jest */
import '../test-utils/mock-window-url'
import { encode } from '@mapbox/polyline'
import coreUtils from '@opentripplanner/core-utils'
import FakeTimers from '@sinonjs/fake-timers'

import {
  AUTO_OFF,
  AUTO_PRESET_STORAGE_KEY,
  AUTO_SWITCH_NOTICE_ID
} from '../../lib/util/go-mode/auto-switch'
import {
  backgroundRouteCheck,
  beginGoMode,
  dismissAutoUndo,
  endGoMode,
  setAutoPreset,
  turnAutoOff,
  turnAutoOn,
  undoAutoSwitch
} from '../../lib/actions/go-mode'
import {
  clearGoModeSession,
  saveGoModeSession
} from '../../lib/util/go-mode/session-persistence'
import { FASTER_ROUTE_NOTICE_ID } from '../../lib/util/go-mode/faster-route-offer'
import { fetchRerouteSnapshotPlan } from '../../lib/actions/apiV2'
import { isTripRecordingEnabled } from '../../lib/util/debug-log'
import { legTripId } from '../../lib/util/go-mode/leg-merge'
import { sendPush } from '../../lib/util/go-mode/native-notify'
import createOtpReducer, {
  getInitialState
} from '../../lib/reducers/create-otp-reducer'

jest.mock('../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(
    () => () => Promise.resolve({ error: false, itineraries: [] })
  ),
  fetchRerouteSnapshotPlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  }))
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

const snapshotPlan = fetchRerouteSnapshotPlan as jest.Mock
const pushed = sendPush as jest.Mock
const recording = isTripRecordingEnabled as jest.Mock

/**
 * Backlog 65.2, cycle 36 B2 — Auto mode: the 90 s off-bus check switching the
 * trip by the rider's preset instead of only offering the card.
 *
 * Every plain action goes through the REAL root reducer (create-otp-reducer),
 * so an Auto action type missing from its goMode delegation list fails here
 * (the action-delegation trap) even though the slice would pass on its own.
 */

const NOW = Date.UTC(2026, 9, 25, 21, 0, 0) // 16:00 Chicago
const MIN = 60000
const P0: [number, number] = [44.95, -93.29] // the rider, off the bus
const STOP_A: [number, number] = [44.9515, -93.29] // ~170 m north
const STOP_B: [number, number] = [44.95, -93.2878] // ~95 m east
const DEST: [number, number] = [44.99, -93.25]

const place = (at: [number, number], name: string, stop?: string) => ({
  lat: at[0],
  lon: at[1],
  name,
  ...(stop ? { stop: { gtfsId: stop } } : {})
})

/**
 * One raw OTP2 itinerary: a walk from the rider to the stop, then each bus in
 * `buses` (the first boarding at `board`, the last arriving 2 min before
 * `arrive`), then a short walk to the door.
 */
function plan(opts: {
  arrive: number
  board: number
  buses: { route: string; trip: string }[]
  stop?: [number, number]
}): any {
  const stop = opts.stop || STOP_A
  const accessEnd = opts.board - MIN
  const accessStart = Math.min(Date.now(), accessEnd - 2 * MIN)
  const alightAt = opts.arrive - 2 * MIN
  const span = (alightAt - opts.board) / opts.buses.length
  const near: [number, number] = [DEST[0] - 0.002, DEST[1]]
  const legs: any[] = [
    {
      distance: 170,
      duration: (accessEnd - accessStart) / 1000,
      endTime: accessEnd,
      from: place(P0, 'Current location'),
      legGeometry: { points: encode([P0, stop]) },
      mode: 'WALK',
      startTime: accessStart,
      to: place(
        stop,
        `Stop ${opts.buses[0].route}`,
        `1:S${opts.buses[0].route}`
      ),
      transitLeg: false
    }
  ]
  opts.buses.forEach((b, i) => {
    const start = opts.board + i * span
    const from: [number, number] =
      i === 0 ? stop : [stop[0] + 0.01 * i, stop[1]]
    const to: [number, number] =
      i === opts.buses.length - 1 ? near : [stop[0] + 0.01 * (i + 1), stop[1]]
    legs.push({
      distance: 6000,
      duration: (span - (i < opts.buses.length - 1 ? MIN : 0)) / 1000,
      endTime: start + span - (i < opts.buses.length - 1 ? MIN : 0),
      from: place(from, `Stop ${b.route}`, `1:S${b.route}${i}`),
      legGeometry: { points: encode([from, to]) },
      mode: 'BUS',
      route: { id: `1:${b.route}`, shortName: b.route },
      routeShortName: b.route,
      startTime: start,
      to: place(
        to,
        i === opts.buses.length - 1 ? 'Near home' : 'Transfer',
        `1:E${b.route}${i}`
      ),
      transitLeg: true,
      trip: { gtfsId: b.trip }
    })
  })
  legs.push({
    distance: 220,
    duration: 120,
    endTime: opts.arrive,
    from: place(near, 'Near home'),
    legGeometry: { points: encode([near, DEST]) },
    mode: 'WALK',
    startTime: alightAt,
    to: place(DEST, 'Home'),
    transitLeg: false
  })
  return {
    duration: (opts.arrive - accessStart) / 1000,
    endTime: opts.arrive,
    legs,
    startTime: accessStart
  }
}

/** Route `r` on trip `1:t<r>`, boarding `boardMin` and home `arriveMin` after NOW. */
const bus = (r: string, arriveMin: number, boardMin = 12, stop = STOP_B) =>
  plan({
    arrive: NOW + arriveMin * MIN,
    board: NOW + boardMin * MIN,
    buses: [{ route: r, trip: `1:t${r}` }],
    stop
  })
// The rider's plan: the A bus, boarding at 16:08, home at 16:40.
const held = () => bus('A', 40, 8, STOP_A)

const answer = (...itineraries: any[]) => ({
  data: { plan: { itineraries } }
})
/** Answer every check with these itineraries, built when it asks (an
 * answer starts at its own now, as OTP's do). */
const respond = (build: () => any[]) =>
  snapshotPlan.mockImplementation(
    () => () =>
      Promise.resolve({
        query: 'q',
        response: answer(...build()),
        variables: {}
      })
  )

const fix = (at: [number, number], ts = NOW - 10 * MIN): any => ({
  coords: {
    accuracy: 8,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    latitude: at[0],
    longitude: at[1],
    speed: 0
  },
  timestamp: ts
})

let visibility: DocumentVisibilityState = 'visible'
Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => visibility
})

/** A Go Mode store over the REAL root reducer. */
function makeStore(goModePatch: any = {}, itinerary: any = held()) {
  const reducer = createOtpReducer({ homeTimezone: 'America/Chicago' } as any)
  let otp: any = reducer(undefined, { type: '@@INIT' })
  otp = {
    ...otp,
    config: { ...otp.config, homeTimezone: 'America/Chicago' },
    currentQuery: { ...otp.currentQuery, routingPreferences: {} },
    goMode: {
      ...otp.goMode,
      activeItinerary: itinerary,
      isActive: true,
      progress: null,
      tracking: { ...otp.goMode.tracking, lastPosition: fix(P0) },
      ...goModePatch
    }
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
    auto: () => otp.goMode.auto,
    goMode: () => otp.goMode,
    of: (type: string) => actions.filter((a) => a.type === type),
    patch: (p: any) => {
      otp = { ...otp, goMode: { ...otp.goMode, ...p } }
    },
    run: (thunk: any) => thunk(dispatch, getState)
  }
}

const autoOn = (preset = 'fastest') => ({
  auto: { ...AUTO_OFF, on: true, preset }
})
const firstTrip = (store: ReturnType<typeof makeStore>) =>
  legTripId(store.goMode().activeItinerary.legs.find((l: any) => l.transitLeg))
const switchRecords = (store: ReturnType<typeof makeStore>) =>
  store.of('AUTO_SWITCH').map((a) => a.payload)

describe('Auto mode switching (65.2, cycle 36 B2)', () => {
  let clock: FakeTimers.InstalledClock
  let store: ReturnType<typeof makeStore> | undefined

  /** The 90 s check, `n` intervals into the trip. */
  const checkAt = async (n: number) => {
    clock.setSystemTime(NOW + n * 90000)
    await store!.run(backgroundRouteCheck())
  }

  beforeEach(() => {
    snapshotPlan.mockReset()
    pushed.mockClear()
    recording.mockReturnValue(false)
    visibility = 'visible'
    clock = FakeTimers.install({ now: NOW, toFake: ['Date'] })
    try {
      coreUtils.storage.removeItem(AUTO_PRESET_STORAGE_KEY)
    } catch {
      // ignore
    }
  })
  afterEach(() => {
    store?.run(endGoMode())
    store = undefined
    clearGoModeSession()
    clock.uninstall()
  })

  it('Auto off: the same two answers only offer the card, as today', async () => {
    visibility = 'hidden'
    respond(() => [held(), bus('14', 34)])
    store = makeStore()
    await checkAt(0)
    await checkAt(1)
    expect(firstTrip(store)).toBe('1:tA')
    expect(store.goMode().fasterRoute?.routeSet).toBe('1:14')
    expect(store.of('START_GO_MODE')).toHaveLength(0)
    expect(store.of('AUTO_REPLAN')).toHaveLength(0)
    expect(
      store.actions.filter((a) => /AUTO_(SWITCH|MODE|UNDO)/.test(a.type))
    ).toEqual([])
    // ...and the card's one push goes out exactly as before.
    expect(pushed).toHaveBeenCalledTimes(1)
    expect(pushed.mock.calls[0][0]).toMatchObject({
      id: FASTER_ROUTE_NOTICE_ID,
      message: '6 min faster · 14'
    })
    expect(store.auto()).toEqual(AUTO_OFF)
  })

  it('Fastest: switches on the SECOND agreeing answer, recorded as the app’s', async () => {
    respond(() => [held(), bus('14', 34)])
    store = makeStore(autoOn())
    await checkAt(0)
    // One answer is not enough (B1: 12 → 5 switches, no reversal).
    expect(firstTrip(store)).toBe('1:tA')
    expect(store.goMode().fasterRoute?.routeSet).toBe('1:14')
    expect(switchRecords(store)).toEqual([
      expect.objectContaining({
        outcome: 'held',
        toRouteSet: '1:14',
        why: 'confirming'
      })
    ])

    await checkAt(1)
    expect(firstTrip(store)).toBe('1:t14')
    expect(store.of('AUTO_REPLAN').map((a) => a.payload)).toEqual([
      expect.objectContaining({
        accepted: true,
        autoApply: true,
        reason: 'auto-switch'
      })
    ])
    expect(switchRecords(store)[1]).toMatchObject({
      fromRouteSet: '1:A',
      outcome: 'switched',
      preset: 'fastest',
      push: 'none',
      route: '14',
      savingMin: 6,
      switches: 1,
      toRouteSet: '1:14'
    })
    const auto = store.auto()
    expect(auto).toMatchObject({
      leftRouteSets: ['1:A'],
      on: true,
      switches: 1
    })
    // Undo until the old bus would leave (16:08) or 5 min, whichever first.
    expect(auto.undo).toMatchObject({
      expiresAtMs: NOW + 90000 + 5 * MIN,
      fromRouteSet: '1:A',
      headline: 'faster',
      toRouteSet: '1:14'
    })
    expect(legTripId(auto.undo.fromItinerary.legs[1])).toBe('1:tA')
    // The offer card went with the plan it was about; on screen, no push.
    expect(store.goMode().fasterRoute).toBeNull()
    expect(pushed).not.toHaveBeenCalled()
  })

  it('answers that disagree do not switch; the next agreeing pair does', async () => {
    store = makeStore(autoOn())
    respond(() => [held(), bus('14', 34)])
    await checkAt(0)
    respond(() => [held(), bus('21', 33)])
    await checkAt(1)
    expect(firstTrip(store)).toBe('1:tA')
    respond(() => [held(), bus('21', 33)])
    await checkAt(2)
    expect(firstTrip(store)).toBe('1:t21')
  })

  it('one push, only while the app is hidden, numbers only — and no card push before it', async () => {
    visibility = 'hidden'
    respond(() => [held(), bus('14', 34)])
    store = makeStore(autoOn())
    await checkAt(0)
    expect(pushed).not.toHaveBeenCalled()
    await checkAt(1)
    expect(pushed).toHaveBeenCalledTimes(1)
    expect(pushed.mock.calls[0][0]).toEqual({
      id: AUTO_SWITCH_NOTICE_ID,
      message: '6 min faster · 14',
      priority: 1,
      title: 'Switched'
    })
    expect(switchRecords(store)[1].push).toBe('sent')
  })

  it('Undo puts the old plan back, keeps Auto on, and never switches to the undone route', async () => {
    respond(() => [held(), bus('14', 34)])
    store = makeStore(autoOn())
    await checkAt(0)
    await checkAt(1)
    expect(firstTrip(store)).toBe('1:t14')
    await store.run(undoAutoSwitch())
    expect(firstTrip(store)).toBe('1:tA')
    expect(store.auto()).toMatchObject({
      leftRouteSets: ['1:A', '1:14'],
      on: true,
      switches: 1,
      undo: null
    })
    expect(switchRecords(store).slice(-1)[0]).toMatchObject({
      outcome: 'undone',
      toRouteSet: '1:14',
      why: 'rider'
    })
    expect(store.of('AUTO_REPLAN').slice(-1)[0].payload).toMatchObject({
      autoApply: false,
      reason: 'auto-switch-undo'
    })
    // The 14 again, twice: held, never switched to.
    respond(() => [held(), bus('14', 34)])
    await checkAt(3)
    await checkAt(4)
    expect(firstTrip(store)).toBe('1:tA')
    expect(switchRecords(store).slice(-1)[0]).toMatchObject({
      outcome: 'held',
      why: 'switch-back'
    })
  })

  it('Undo lapses: after 5 min it changes nothing', async () => {
    respond(() => [held(), bus('14', 34)])
    store = makeStore(autoOn())
    await checkAt(0)
    await checkAt(1)
    clock.setSystemTime(NOW + 90000 + 5 * MIN + 1000)
    await store.run(undoAutoSwitch())
    expect(firstTrip(store)).toBe('1:t14')
    expect(store.auto().undo).toBeNull()
    expect(switchRecords(store).map((r) => r.outcome)).not.toContain('undone')
  })

  it('OK takes the Undo card down; the switch stands', async () => {
    respond(() => [held(), bus('14', 34)])
    store = makeStore(autoOn())
    await checkAt(0)
    await checkAt(1)
    store.run(dismissAutoUndo())
    expect(store.auto().undo).toBeNull()
    expect(firstTrip(store)).toBe('1:t14')
  })

  it('never switches back to a route set the trip has left', async () => {
    store = makeStore(autoOn())
    respond(() => [held(), bus('14', 34)])
    await checkAt(0)
    await checkAt(1)
    expect(firstTrip(store)).toBe('1:t14')
    // The A again, now 4 min ahead of the 14: twice, and still not taken.
    respond(() => [bus('14', 34), bus('A', 30, 12, STOP_A)])
    await checkAt(2)
    await checkAt(3)
    expect(firstTrip(store)).toBe('1:t14')
    expect(switchRecords(store).slice(-1)[0]).toMatchObject({
      outcome: 'held',
      toRouteSet: '1:A',
      why: 'switch-back'
    })
  })

  it('caps at 3 switches in a trip', async () => {
    store = makeStore(autoOn())
    const steps: [string, number][] = [
      ['14', 34],
      ['21', 30],
      ['5', 26],
      ['9', 22]
    ]
    let current = () => held()
    let n = 0
    for (const [r, arrive] of steps) {
      const prev = current
      respond(() => [prev(), bus(r, arrive)])
      await checkAt(n++)
      await checkAt(n++)
      current = () => bus(r, arrive)
    }
    expect(firstTrip(store)).toBe('1:t5')
    expect(store.auto().switches).toBe(3)
    expect(store.of('AUTO_REPLAN')).toHaveLength(3)
    expect(switchRecords(store).slice(-1)[0]).toMatchObject({
      outcome: 'held',
      toRouteSet: '1:9',
      why: 'cap'
    })
  })

  it('refuses a no-tap switch against an own-next-trip bar (the card stays a tap)', async () => {
    // The rider's plan is A then C; the answer has their A with another tail
    // (own-next-trip), and the 14 well ahead of it.
    const twoBus = plan({
      arrive: NOW + 40 * MIN,
      board: NOW + 8 * MIN,
      buses: [
        { route: 'A', trip: '1:tA' },
        { route: 'C', trip: '1:tC' }
      ],
      stop: STOP_A
    })
    const aOtherTail = () =>
      plan({
        arrive: NOW + 41 * MIN,
        board: NOW + 8 * MIN,
        buses: [{ route: 'A', trip: '1:tA' }],
        stop: STOP_A
      })
    respond(() => [aOtherTail(), bus('14', 30)])
    store = makeStore(autoOn(), twoBus)
    await checkAt(0)
    await checkAt(1)
    await checkAt(2)
    expect(legTripId(store.goMode().activeItinerary.legs[1])).toBe('1:tA')
    expect(store.of('AUTO_REPLAN')).toHaveLength(0)
    expect(switchRecords(store).map((r) => r.why)).toEqual([
      'weak-bar',
      'weak-bar',
      'weak-bar'
    ])
    // Today's card still offers it for a tap.
    expect(store.goMode().fasterRoute?.routeSet).toBe('1:14')
  })

  it('Stay on my route: no different-route switch, no Auto record — the card as today', async () => {
    respond(() => [held(), bus('14', 34)])
    store = makeStore(autoOn('stayOnRoute'))
    await checkAt(0)
    await checkAt(1)
    await checkAt(2)
    expect(firstTrip(store)).toBe('1:tA')
    expect(store.of('AUTO_REPLAN')).toHaveLength(0)
    expect(store.of('AUTO_SWITCH')).toHaveLength(0)
    expect(store.goMode().fasterRoute?.routeSet).toBe('1:14')
  })

  it('Stay on my route does not take an earlier run of the own route either (catch-the-run does)', async () => {
    // An earlier catchable run of the A in the same answer: the bar, not a
    // candidate — moving onto it is the retarget's job (23.3), unchanged.
    respond(() => [held(), bus('A', 33, 6, STOP_A)])
    for (const preset of ['stayOnRoute', 'fastest']) {
      store?.run(endGoMode())
      store = makeStore(autoOn(preset))
      await checkAt(0)
      await checkAt(1)
      expect(firstTrip(store)).toBe('1:tA')
      expect(legTripId(store.goMode().activeItinerary.legs[1])).toBe('1:tA')
      expect(store.goMode().activeItinerary.endTime).toBe(NOW + 40 * MIN)
      expect(store.of('AUTO_REPLAN')).toHaveLength(0)
    }
  })

  describe('per trip (rider Q2 = A)', () => {
    it('is off at every new trip: Start Trip over a live trip, Go Mode restarted, the onboard flow', async () => {
      store = makeStore(autoOn())
      // A swap within the trip keeps it.
      await store.run(beginGoMode(bus('14', 34)))
      expect(store.auto().on).toBe(true)
      // Start Trip on another route while one is running: a new trip.
      await store.run(beginGoMode(bus('21', 33), { newTrip: true }))
      expect(store.auto()).toEqual(AUTO_OFF)

      store.run(turnAutoOn())
      expect(store.auto().on).toBe(true)
      store.run(endGoMode())
      expect(store.auto()).toEqual(AUTO_OFF)
      await store.run(beginGoMode(held()))
      expect(store.auto()).toEqual(AUTO_OFF)

      store.run(turnAutoOn())
      store.run((dispatch: any) =>
        dispatch({ payload: {}, type: 'BEGIN_ONBOARD_FLOW' })
      )
      expect(store.auto()).toEqual(AUTO_OFF)
    })

    it('survives a reload within the trip — counts and left routes too, not the Undo', async () => {
      respond(() => [held(), bus('14', 34)])
      store = makeStore(autoOn('fastest'))
      await checkAt(0)
      await checkAt(1)
      saveGoModeSession(store.goMode())
      const restored = getInitialState({
        homeTimezone: 'America/Chicago'
      } as any)
      expect(restored.goMode.isActive).toBe(true)
      expect(restored.goMode.auto).toEqual({
        leftRouteSets: ['1:A'],
        on: true,
        preset: 'fastest',
        switches: 1,
        undo: null
      })
    })

    it('a reload of a finished trip comes back with Auto off', () => {
      store = makeStore({ ...autoOn('leastBike'), arrivedAt: NOW - MIN })
      saveGoModeSession(store.goMode())
      const restored = getInitialState({
        homeTimezone: 'America/Chicago'
      } as any)
      expect(restored.goMode.isActive).toBe(true)
      expect(restored.goMode.auto).toEqual(AUTO_OFF)
    })

    it('one tap on uses the preset last picked on this device (Fastest on first use)', async () => {
      store = makeStore()
      store.run(turnAutoOn())
      expect(store.auto()).toMatchObject({ on: true, preset: 'fastest' })
      store.run(setAutoPreset('simplest'))
      expect(store.auto()).toMatchObject({ on: true, preset: 'simplest' })
      expect(coreUtils.storage.getItem(AUTO_PRESET_STORAGE_KEY)).toBe(
        'simplest'
      )
      store.run(turnAutoOff())
      expect(store.auto()).toMatchObject({ on: false, preset: 'simplest' })

      // The next trip starts off, and its one tap on is Simplest.
      store.run(endGoMode())
      store = makeStore()
      expect(store.auto().on).toBe(false)
      store.run(turnAutoOn())
      expect(store.auto()).toMatchObject({ on: true, preset: 'simplest' })
      expect(store.of('SET_AUTO_MODE')[0].payload).toMatchObject({
        on: true,
        preset: 'simplest',
        source: 'chip'
      })
    })

    it('Undo does not turn Auto off', async () => {
      respond(() => [held(), bus('14', 34)])
      store = makeStore(autoOn())
      await checkAt(0)
      await checkAt(1)
      await store.run(undoAutoSwitch())
      expect(store.auto().on).toBe(true)
    })
  })
})
