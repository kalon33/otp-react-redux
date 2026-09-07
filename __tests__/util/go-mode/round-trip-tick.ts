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
 * The tick carve-out.
 *
 * Every post-arrival tick used to return at `} else if (hasArrived) { return }`
 * — the 2026-08-28 quiesce, which is load-bearing and stays. A ROUND TRIP is
 * the one thing with work left after arrival, so that branch now runs the
 * return countdown and nothing else. What this proves is the "and nothing
 * else": the countdown advances and each stage alerts exactly once, while the
 * quiesce keeps holding off everything it held off before.
 *
 * The harness is the one from arrival-quiesce-0828.ts: the real goMode reducer
 * behind a hand-rolled dispatch, nested thunks recorded rather than run.
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
    tracking: { ...initial.tracking, lastPosition: fixAt(ORIGIN, 0) },
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
    // Nested thunks are recorded, not run: refreshReturnPlan is one of them and
    // it is not what is under test here.
    if (typeof action === 'function') return undefined
    actions.push(action)
    goModeState = goMode(goModeState, action)
    return action
  }
  return {
    dispatch,
    getGoMode: () => goModeState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    notifications: () =>
      actions
        .filter((a) => a.type === 'ADD_NOTIFICATION')
        .map((a) => a.payload),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: (thunk: any) => thunk(dispatch, getState),
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

/**
 * Drive post-arrival ticks from `fromMs` to `toMs` at the 30 s idle cadence the
 * arrival taper sets. The rider is standing still at the destination, which is
 * the whole point: nothing about their position changes for hours.
 *
 * Both clocks move together, because the tick reads both: the post-arrival GPS
 * funnel gates on the FIX's own timestamp (so a replay tapers where the live
 * ride did), while the countdown reads `getCurrentTime()`, which outside
 * simulation is `new Date()` — and the test-utils' `setTestTime` spies on
 * `Date.now`, which a `new Date()` never calls. So the constructor itself is
 * what has to move here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tickThrough = (store: any, fromMs: number, toMs: number) => {
  for (let t = fromMs; t <= toMs; t += 30000) {
    fakeNow = t
    store.run(handlePositionUpdate(fixAt(DEST, t)))
  }
}

const RealDate = Date
let fakeNow = BASE

describe('the post-arrival tick on a round trip', () => {
  beforeEach(() => {
    fakeNow = BASE
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

  it('advances the countdown stage instead of returning at the quiesce', () => {
    const leaveByMs = BASE + 40 * MIN
    const store = makeStore({ arrivedAt: BASE, roundTrip: plan(leaveByMs) })
    tickThrough(store, BASE + 60000, BASE + 60000)
    expect(store.types()).toContain('SET_RETURN_COUNTDOWN')
    expect(store.getGoMode().returnCountdown).toEqual({
      leaveByMs,
      stage: 'far'
    })
  })

  it('raises exactly one LEAVE_FOR_RETURN per stage across 40 min of ticks', () => {
    const leaveByMs = BASE + 30 * MIN
    const store = makeStore({ arrivedAt: BASE, roundTrip: plan(leaveByMs) })
    // 80 ticks: 30 min down to the departure and 10 min past it.
    tickThrough(store, BASE + 60000, leaveByMs + 10 * MIN)

    const alerts = store
      .notifications()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((n: any) => n.type === 'LEAVE_FOR_RETURN')
    expect(alerts).toHaveLength(2)
    // Ids 4 and 5 — see round-trip.ts for why the two alerts do not share one.
    expect(alerts[0].pushId).toBe(4)
    expect(alerts[0].title).toBe('↩ Leave in 10 min')
    expect(alerts[1].pushId).toBe(5)
    expect(alerts[1].title).toBe('↩ Leave now')
    // Numbers-only copy: no clock time anywhere in either.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    alerts.forEach((a: any) => expect(a.title).not.toMatch(/:\d\d/))
    expect(store.getGoMode().returnCountdown.stage).toBe('now')
  })

  it('writes SET_RETURN_COUNTDOWN only when the stage actually moves', () => {
    const leaveByMs = BASE + 30 * MIN
    const store = makeStore({ arrivedAt: BASE, roundTrip: plan(leaveByMs) })
    tickThrough(store, BASE + 60000, leaveByMs + 10 * MIN)
    // far -> soon -> now. Eighty ticks, three writes; an unconditional dispatch
    // would be eighty store writes, eighty persistence writes and eighty
    // re-renders for a rider sitting in a cafe.
    expect(
      store.types().filter((t: string) => t === 'SET_RETURN_COUNTDOWN')
    ).toHaveLength(3)
  })

  it('keeps the 2026-08-28 quiesce: nothing else runs after arrival', () => {
    const leaveByMs = BASE + 30 * MIN
    const store = makeStore({ arrivedAt: BASE, roundTrip: plan(leaveByMs) })
    tickThrough(store, BASE + 60000, leaveByMs)
    const types = new Set(store.types())
    // The position/route/progress trio keeps the map honest and is above the
    // quiesce; everything the quiesce holds off must still be held off.
    ;[
      'UPDATE_VEHICLE_MATCH',
      'UPDATE_NEARBY_VEHICLES',
      'SET_LIVE_LEG_TIMES',
      'TRANSITION_LEG',
      'START_REROUTE',
      'SET_RIDING'
    ].forEach((t) => expect(types.has(t)).toBe(false))
  })

  it('does nothing at all on a ONE-WAY trip — the quiesce returns as before', () => {
    const store = makeStore({ arrivedAt: BASE })
    tickThrough(store, BASE + 60000, BASE + 30 * MIN)
    expect(store.types()).not.toContain('SET_RETURN_COUNTDOWN')
    expect(
      store
        .notifications()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((n: any) => n.type === 'LEAVE_FOR_RETURN')
    ).toHaveLength(0)
  })

  it('says nothing when the rider comes back long after the return has gone', () => {
    // A resume 40 min past the departure: the first evaluation lands in
    // 'missed', and round-trip.ts's first-evaluation rule refuses to buzz for a
    // bus that left before the evaluator ever ran.
    const leaveByMs = BASE - 40 * MIN
    const store = makeStore({ arrivedAt: BASE, roundTrip: plan(leaveByMs) })
    tickThrough(store, BASE + 60000, BASE + 5 * MIN)
    expect(store.getGoMode().returnCountdown.stage).toBe('missed')
    expect(
      store
        .notifications()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((n: any) => n.type === 'LEAVE_FOR_RETURN')
    ).toHaveLength(0)
  })
})
