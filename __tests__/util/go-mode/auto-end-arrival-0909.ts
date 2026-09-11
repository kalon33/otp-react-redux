import { encode } from '@mapbox/polyline'

import { handlePositionUpdate } from '../../../lib/actions/go-mode'
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
  return {
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
}

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = global as any
    g.Date = RealDate
  })

  it('ends the trip and lands on the search form once the dwell is up', () => {
    // FAILS BEFORE: the arrived branch ran the round-trip countdown and
    // returned, so a one-way trip sat there until the rider tapped Done — six
    // minutes, on 2026-09-09.
    const store = makeStore({ arrivedAt: BASE })
    tickThrough(store, BASE + 30000, BASE + 3 * MIN)
    expect(store.types()).toContain('STOP_GO_MODE')
    // Exactly what handleArrivedDone does, through the same action.
    expect(store.screens()).toEqual([3])
    expect(store.getGoMode().isActive).toBe(false)
    expect(store.getGoMode().arrivedAt).toBe(null)
  })

  it('leaves the trip alone before the threshold', () => {
    // Five ticks — 2m30s of the three minutes. The rider is still reading the
    // arrival card, and it must not be snatched away.
    const store = makeStore({ arrivedAt: BASE })
    tickThrough(store, BASE + 30000, BASE + 150000)
    expect(store.types()).not.toContain('STOP_GO_MODE')
    expect(store.screens()).toEqual([])
    expect(store.getGoMode().isActive).toBe(true)
    expect(store.getGoMode().arrivedAt).toBe(BASE)
  })

  it('never auto-ends a ROUND TRIP — its arrival is a pause', () => {
    // The countdown to the return departure is hours long and is the whole
    // reason the trip is still running; ending it would take the two return
    // alerts with it (endGoMode cancels them).
    const store = makeStore({
      arrivedAt: BASE,
      roundTrip: plan(BASE + 120 * MIN)
    })
    tickThrough(store, BASE + 30000, BASE + 30 * MIN)
    expect(store.types()).not.toContain('STOP_GO_MODE')
    expect(store.screens()).toEqual([])
    expect(store.getGoMode().isActive).toBe(true)
    // ...and the countdown it exists for still ran.
    expect(store.types()).toContain('SET_RETURN_COUNTDOWN')
  })

  it('ends once, not on every later tick', () => {
    const store = makeStore({ arrivedAt: BASE })
    tickThrough(store, BASE + 30000, BASE + 10 * MIN)
    expect(
      store.types().filter((t: string) => t === 'STOP_GO_MODE')
    ).toHaveLength(1)
  })

  it('ends on the first tick when the dwell is already spent (resumed trip)', () => {
    // session-persistence refuses to resume a trip that arrived more than
    // ARRIVED_RESUME_GRACE_MS (5 min) ago, so the window where this can happen
    // is 3-5 minutes — a reload right after the arrival card went up.
    const store = makeStore({ arrivedAt: BASE - 4 * MIN })
    tickThrough(store, BASE, BASE)
    expect(store.types()).toContain('STOP_GO_MODE')
    expect(store.screens()).toEqual([3])
  })
})
