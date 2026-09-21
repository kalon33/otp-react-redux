import { encode } from '@mapbox/polyline'

import {
  endGoMode,
  handlePositionUpdate,
  startGoMode
} from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'
import type { RoundTripPlan } from '../../../lib/util/go-mode/round-trip'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(
    () => () => Promise.resolve({ error: false, itineraries: [] })
  ),
  fetchRerouteSnapshotPlan: jest.fn(() => () => Promise.resolve(null)),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
    modeSettings: [],
    numItineraries: 5
  }))
}))

const initial = goMode(undefined, { type: '@@INIT' })

/**
 * Rider ask, 2026-09-09 09:03:42 (in-app note + screenshot): *"We should finish
 * a trip on auto if within x distance for x time"*.
 *
 * That morning `SET_ARRIVED` fired at 08:57:48 — 87 m from the door,
 * overallProgress 99.52% — and then nothing but 30 s position polls until the
 * rider's own Done tap at 09:03:47. Five minutes fifty-nine of a finished trip
 * holding the screen, the wake lock and the reload warning.
 *
 * The distance half of the ask is the arrival latch itself, which is one-way;
 * this is the dwell half. Harness is arrival-quiesce-0828's: the real goMode
 * reducer behind a hand-rolled dispatch. Thunks are RUN here — the auto-end
 * dispatches `finishArrivedTrip`, and what it does is the whole point.
 *
 * REHEARSED AND FAILED, 2026-09-17 (`mu69yw00-bo98a0`, prod bundle
 * 2026.0917.1). `SET_ARRIVED` 21:41:31.043 on a one-way trip; two stale
 * `POSITION_RESPONSE`s at 21:41:41 and 21:42:12 with no `UPDATE_POSITION`
 * behind either; then THIRTEEN `POSITION_FETCHING` with no response at all
 * from 21:42:43 to 21:48:55, the last record of the session. No `STOP_GO_MODE`,
 * no `[go-mode] auto-end`: 7m24s open and counting. The 09-11 build put the
 * AUTO_END_AFTER_ARRIVAL_MS check in the arrived branch of
 * handlePositionUpdate, so it was evaluated ONLY when a fix arrived, and the
 * rider had gone indoors. The 09-09 sighting had 30 s polls answering, which
 * is the only reason it looked like it worked.
 *
 * So the case this file did not have, and now leads with: ZERO position fixes
 * after arrival. The dwell is driven by a wall-clock timer armed at
 * `SET_ARRIVED`; jest's fake timers are the clock, and every test below that
 * ends a trip ends it without delivering another fix.
 */

const MIN = 60000
const ORIGIN: [number, number] = [44.95, -93.29]
const DEST: [number, number] = [44.98, -93.27]

const walkItinerary = () => ({
  duration: 1800,
  endTime: 0,
  legs: [
    {
      distance: 3800,
      duration: 1800,
      endTime: 0,
      from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Origin' },
      legGeometry: { points: encode([ORIGIN, DEST]) },
      mode: 'WALK',
      startTime: 0,
      to: { lat: DEST[0], lon: DEST[1], name: 'Destination' },
      transitLeg: false
    }
  ],
  startTime: 0
})

const fixAt = (
  [lat, lon]: [number, number],
  timestamp: number
): GeolocationPosition =>
  ({
    coords: {
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: lat,
      longitude: lon,
      speed: 0
    },
    timestamp
  } as GeolocationPosition)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeStore = (goModeOverrides: any = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let goModeState: any = {
    ...initial,
    activeItinerary: walkItinerary(),
    isActive: true,
    tracking: { ...initial.tracking, lastPosition: fixAt(DEST, 0) },
    ...goModeOverrides
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    goModeState = goMode(goModeState, action)
    return action
  }
  const store = {
    dispatch,
    getGoMode: () => goModeState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: (thunk: any) => thunk(dispatch, getState),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screens: () =>
      actions
        .filter((a) => a.type === 'SET_MOBILE_SCREEN')
        .map((a) => a.payload),
    types: () => actions.map((a) => a.type)
  }
  openStores.push(store)
  return store
}

/**
 * Every store built in this file, so afterEach can end its trip. The dwell
 * timer lives on the module-level TripSession in actions/go-mode.ts, and a test
 * that leaves one armed would make the NEXT test's armAutoEndTimer a no-op —
 * exactly the cross-trip leak the fix is required not to have. Ending the trip
 * is the same teardown the rider's Stop runs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const openStores: any[] = []

const BASE = 1_788_600_000_000

const plan = (leaveByMs: number): RoundTripPlan => ({
  destination: { lat: DEST[0], lon: DEST[1], name: 'Destination' },
  leaveByMs,
  origin: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Origin' },
  plannedDepartMs: leaveByMs,
  refreshedAtMs: null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  returnItinerary: {
    endTime: leaveByMs + 30 * MIN,
    legs: [
      {
        endTime: leaveByMs + 30 * MIN,
        mode: 'BUS',
        route: { id: '1:21' },
        routeShortName: '21',
        startTime: leaveByMs,
        transitLeg: true
      }
    ],
    startTime: leaveByMs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any,
  stayMinutes: 120
})

/** Post-arrival ticks at the 30 s arrived cadence, rider standing still. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tickThrough = (store: any, fromMs: number, toMs: number) => {
  for (let t = fromMs; t <= toMs; t += 30000) {
    fakeNow = t
    store.run(handlePositionUpdate(fixAt(DEST, t)))
  }
}

const RealDate = Date
let fakeNow = BASE

describe('a one-way trip ends itself after the arrival dwell (13.5)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    fakeNow = BASE
    // The tick reads both clocks: the GPS funnel gates on the fix timestamp,
    // getCurrentTime() is `new Date()` outside simulation. Move them together.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = global as any
    g.Date = class extends RealDate {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(...args: any[]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        super(...((args.length ? args : [fakeNow]) as [any]))
      }

      static now(): number {
        return fakeNow
      }
    }
  })

  afterEach(() => {
    // Disarm whatever this test left running, through the real teardown.
    while (openStores.length) {
      const store = openStores.pop()
      try {
        if (store.getGoMode().isActive) store.run(endGoMode())
      } catch (e) {
        /* a store that never started a trip has nothing to end */
      }
    }
    jest.clearAllTimers()
    jest.useRealTimers()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = global as any
    g.Date = RealDate
  })

  it('ends the trip with ZERO position fixes after arrival (the 09-17 failure)', () => {
    // FAILS BEFORE (`f81ddba3`): the dwell was checked inside the arrived
    // branch of handlePositionUpdate. One fix latches the arrival and then the
    // phone goes quiet — rider indoors, `POSITION_FETCHING` unanswered — and
    // the check is never reached again. This test delivers exactly one fix,
    // the arriving one, and then nothing.
    const store = makeStore()
    fakeNow = BASE
    store.run(handlePositionUpdate(fixAt(DEST, BASE)))
    // The arrival itself happened, off a real tick, not a seeded field.
    expect(store.types()).toContain('SET_ARRIVED')
    expect(store.getGoMode().arrivedAt).toBe(BASE)
    expect(store.types()).not.toContain('STOP_GO_MODE')

    // ...and now NOT ONE more fix, for as long as the rider's phone was silent
    // on 09-17 (7m24s). Only the clock moves.
    fakeNow = BASE + 8 * MIN
    jest.advanceTimersByTime(8 * MIN)

    expect(store.types()).toContain('STOP_GO_MODE')
    // Exactly what handleArrivedDone does, through the same action.
    expect(store.screens()).toEqual([3])
    expect(store.getGoMode().isActive).toBe(false)
    expect(store.getGoMode().arrivedAt).toBe(null)
  })

  it('ends the trip and lands on the search form once the dwell is up', () => {
    const store = makeStore({ arrivedAt: BASE })
    // The tick arms the clock for a trip that was already arrived when this
    // page picked it up; after that the fixes are irrelevant.
    tickThrough(store, BASE + 30000, BASE + 30000)
    jest.advanceTimersByTime(3 * MIN)
    expect(store.types()).toContain('STOP_GO_MODE')
    expect(store.screens()).toEqual([3])
    expect(store.getGoMode().isActive).toBe(false)
    expect(store.getGoMode().arrivedAt).toBe(null)
  })

  it('leaves the trip alone before the threshold', () => {
    // 2m30s of the three minutes, with fixes still arriving. The rider is
    // still reading the arrival card, and it must not be snatched away.
    const store = makeStore({ arrivedAt: BASE })
    tickThrough(store, BASE + 30000, BASE + 150000)
    jest.advanceTimersByTime(150000 - 30000)
    expect(store.types()).not.toContain('STOP_GO_MODE')
    expect(store.screens()).toEqual([])
    expect(store.getGoMode().isActive).toBe(true)
    expect(store.getGoMode().arrivedAt).toBe(BASE)
  })

  it('never auto-ends a ROUND TRIP — its arrival is a pause', () => {
    // The countdown to the return departure is hours long and is the whole
    // reason the trip is still running; ending it would take the two return
    // alerts with it (endGoMode cancels them). runReturnCountdown owns this
    // case and no dwell timer is armed at all.
    const store = makeStore({
      arrivedAt: BASE,
      roundTrip: plan(BASE + 120 * MIN)
    })
    tickThrough(store, BASE + 30000, BASE + 30 * MIN)
    jest.advanceTimersByTime(30 * MIN)
    expect(store.types()).not.toContain('STOP_GO_MODE')
    expect(store.screens()).toEqual([])
    expect(store.getGoMode().isActive).toBe(true)
    // ...and the countdown it exists for still ran.
    expect(store.types()).toContain('SET_RETURN_COUNTDOWN')
  })

  it('ends once, not on every later tick', () => {
    const store = makeStore({ arrivedAt: BASE })
    tickThrough(store, BASE + 30000, BASE + 10 * MIN)
    jest.advanceTimersByTime(10 * MIN)
    expect(
      store.types().filter((t: string) => t === 'STOP_GO_MODE')
    ).toHaveLength(1)
  })

  it('ends on the first tick when the dwell is already spent (resumed trip)', () => {
    // session-persistence refuses to resume a trip that arrived more than
    // ARRIVED_RESUME_GRACE_MS (5 min) ago, so the window where this can happen
    // is 3-5 minutes — a reload right after the arrival card went up. The
    // timer is armed with a zero delay and fires on the next macrotask.
    const store = makeStore({ arrivedAt: BASE - 4 * MIN })
    tickThrough(store, BASE, BASE)
    jest.advanceTimersByTime(0)
    expect(store.types()).toContain('STOP_GO_MODE')
    expect(store.screens()).toEqual([3])
  })

  it("the rider's own Done tap disarms the timer — no second ending", () => {
    // handleArrivedDone is finishArrivedTrip, which ends through endGoMode,
    // which clears the dwell. Without that the trip would be ended twice: once
    // by the rider and once, minutes later, by a timer nobody stopped.
    const store = makeStore({ arrivedAt: BASE })
    tickThrough(store, BASE + 30000, BASE + 30000)
    store.run(endGoMode())
    expect(
      store.types().filter((t: string) => t === 'STOP_GO_MODE')
    ).toHaveLength(1)
    jest.advanceTimersByTime(10 * MIN)
    expect(
      store.types().filter((t: string) => t === 'STOP_GO_MODE')
    ).toHaveLength(1)
    expect(store.screens()).toEqual([])
  })

  it("a NEW trip is never ended by the previous arrival's timer", () => {
    // START_GO_MODE does not rebuild the trip session, so a timer armed on the
    // trip before this one is still out there. beginGoMode clears it; and the
    // callback re-reads the store before it ends anything, so even a stray one
    // finds `arrivedAt` null and declines.
    const store = makeStore({ arrivedAt: BASE })
    tickThrough(store, BASE + 30000, BASE + 30000)
    store.dispatch(
      startGoMode({
        itinerary: walkItinerary(),
        originalFrom: null,
        roundTrip: null
      })
    )
    expect(store.getGoMode().arrivedAt).toBe(null)
    jest.advanceTimersByTime(10 * MIN)
    expect(store.types()).not.toContain('STOP_GO_MODE')
    expect(store.getGoMode().isActive).toBe(true)
  })
})
