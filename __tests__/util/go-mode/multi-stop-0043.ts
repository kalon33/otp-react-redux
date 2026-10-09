import { encode } from '@mapbox/polyline'

import {
  beginGoMode,
  continueMultiStop,
  endGoMode,
  handlePositionUpdate
} from '../../../lib/actions/go-mode'
import {
  buildMultiStopPlan,
  markStopLegs,
  MultiStopPlan
} from '../../../lib/util/multi-stop'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import goMode from '../../../lib/reducers/go-mode'

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

const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
const initial = goMode(undefined, { type: '@@INIT' })

/**
 * Backlog 43.1 — the rider, 2026-10-08: "Just want overall trip stats. Then go
 * mode does each leg at a time". Go Mode guides a multi-stop trip one segment
 * at a time: arriving at a STOP is a pause (no auto-end; the card offers the
 * next segment), and only the destination ends the trip on the 13.5 dwell.
 *
 * Harness is auto-end-arrival-0909's: the real goMode reducer behind a
 * hand-rolled dispatch, thunks run, jest's fake timers as the wall clock.
 */

const MIN = 60000
const ORIGIN: [number, number] = [44.95, -93.29]
const STOP: [number, number] = [44.96, -93.28]
const DEST: [number, number] = [44.98, -93.27]
const BASE = 1_791_600_000_000

const walk = (
  a: [number, number],
  b: [number, number],
  aName: string,
  bName: string,
  start: number
) => ({
  distance: 1500,
  duration: 900,
  endTime: start + 15 * MIN,
  from: { lat: a[0], lon: a[1], name: aName },
  legGeometry: { points: encode([a, b]) },
  mode: 'WALK',
  startTime: start,
  to: { lat: b[0], lon: b[1], name: bName },
  transitLeg: false
})

/** The whole trip as the planner returns it: origin → stop → destination. */
const wholeTrip = (start = BASE - 15 * MIN): any =>
  markStopLegs(
    {
      duration: 1800,
      endTime: start + 30 * MIN,
      legs: [
        walk(ORIGIN, STOP, 'Origin', 'Stop (44.96, -93.28)', start),
        walk(
          STOP,
          DEST,
          'Stop (44.96, -93.28)',
          'Destination',
          start + 15 * MIN
        )
      ],
      startTime: start
    } as any,
    [{ lat: STOP[0], lon: STOP[1], name: 'Perennial Cycle' }]
  )

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
const openStores: any[] = []

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeStore = (goModeOverrides: any = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let goModeState: any = { ...initial, ...goModeOverrides }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      location: { currentPosition: { coords: null } },
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
    getGoMode: () => goModeState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: (thunk: any) => thunk(dispatch, getState),
    screens: () =>
      actions
        .filter((a) => a.type === 'SET_MOBILE_SCREEN')
        .map((a) => a.payload),
    types: () => actions.map((a) => a.type)
  }
  openStores.push(store)
  return store
}

const RealDate = Date
let fakeNow = BASE

describe('Go Mode runs a multi-stop trip one segment at a time (43.1)', () => {
  let plan: MultiStopPlan

  beforeEach(() => {
    jest.useFakeTimers()
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
    mockedFetch.mockClear()
    plan = buildMultiStopPlan(wholeTrip()) as MultiStopPlan
  })

  afterEach(() => {
    while (openStores.length) {
      const store = openStores.pop()
      try {
        if (store.getGoMode().isActive) store.run(endGoMode())
      } catch (e) {
        /* nothing to end */
      }
    }
    jest.clearAllTimers()
    jest.useRealTimers()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = global as any
    g.Date = RealDate
  })

  it('the plan is two segments, split at the stop', () => {
    expect(plan.segments).toHaveLength(2)
    expect(plan.stopNames).toEqual(['Perennial Cycle', 'Destination'])
    expect(plan.segments[0].legs[0].to.name).toBe('Perennial Cycle')
  })

  it('arriving at the STOP is a pause: no auto-end, however long the errand', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = makeStore({
      activeItinerary: plan.segments[0],
      isActive: true,
      multiStop: plan,
      tracking: { ...initial.tracking, lastPosition: fixAt(STOP, BASE) }
    })
    store.run(handlePositionUpdate(fixAt(STOP, BASE)))
    expect(store.types()).toContain('SET_ARRIVED')

    // Forty minutes in the shop, phone silent.
    fakeNow = BASE + 40 * MIN
    jest.advanceTimersByTime(40 * MIN)
    expect(store.types()).not.toContain('STOP_GO_MODE')
    expect(store.getGoMode().isActive).toBe(true)
    expect(store.getGoMode().multiStop.index).toBe(0)
    // ...and the record says why, at a level the debug sink carries.
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).startsWith('[go-mode] multi-stop: arrived at stop 1 of 1')
      )
    ).toBe(true)
    warn.mockRestore()
  })

  it('"Continue" starts the next segment, and only that segment', async () => {
    const store = makeStore({
      activeItinerary: plan.segments[0],
      arrivedAt: BASE,
      isActive: true,
      multiStop: plan
    })
    fakeNow = BASE + 20 * MIN
    await store.run(continueMultiStop())

    // One fresh plan from the stop, departing now, to the destination.
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    const asked = mockedFetch.mock.calls[0][0]
    expect([asked.from.lat, asked.from.lon]).toEqual(STOP)
    expect([asked.to.lat, asked.to.lon]).toEqual(DEST)

    // The finished segment ended, the next one began.
    const types = store.types()
    expect(types.indexOf('STOP_GO_MODE')).toBeLessThan(
      types.lastIndexOf('START_GO_MODE')
    )
    const gm = store.getGoMode()
    expect(gm.isActive).toBe(true)
    expect(gm.arrivedAt).toBe(null)
    expect(gm.multiStop.index).toBe(1)
    // No fresh answer: the stored segment stands, so the button always works.
    expect(gm.activeItinerary.legs).toHaveLength(1)
    expect(gm.activeItinerary.legs[0].from.name).toBe('Perennial Cycle')
    expect(gm.activeItinerary.legs[0].to.name).toBe('Destination')
  })

  it('keeps the rider’s route when the fresh plan still has it', async () => {
    const fresh = {
      ...plan.segments[1],
      legs: [
        {
          ...plan.segments[1].legs[0],
          from: { lat: STOP[0], lon: STOP[1], name: 'Origin (44.96, -93.28)' },
          startTime: BASE + 20 * MIN
        }
      ],
      startTime: BASE + 20 * MIN
    }
    mockedFetch.mockReturnValueOnce(() =>
      Promise.resolve({ error: false, itineraries: [fresh] })
    )
    const store = makeStore({
      activeItinerary: plan.segments[0],
      arrivedAt: BASE,
      isActive: true,
      multiStop: plan
    })
    fakeNow = BASE + 20 * MIN
    await store.run(continueMultiStop())
    const gm = store.getGoMode()
    expect(gm.activeItinerary.startTime).toBe(BASE + 20 * MIN)
    // The stop keeps the rider's own name, not OTP's coordinate label.
    expect(gm.activeItinerary.legs[0].from.name).toBe('Perennial Cycle')
  })

  it('asks a walk segment as a walk, and never swaps it for a bus', async () => {
    const bus = {
      ...plan.segments[1],
      legs: [
        {
          ...plan.segments[1].legs[0],
          mode: 'BUS',
          route: { id: '1:6' },
          startTime: BASE + 25 * MIN,
          transitLeg: true
        }
      ],
      startTime: BASE + 25 * MIN
    }
    mockedFetch.mockReturnValueOnce(() =>
      Promise.resolve({ error: false, itineraries: [bus] })
    )
    const store = makeStore({
      activeItinerary: plan.segments[0],
      arrivedAt: BASE,
      isActive: true,
      multiStop: plan
    })
    fakeNow = BASE + 20 * MIN
    await store.run(continueMultiStop())
    expect(mockedFetch.mock.calls[0][0].modes).toEqual([{ mode: 'WALK' }])
    const gm = store.getGoMode()
    expect(gm.multiStop.index).toBe(1)
    // The rider's own walk, not the bus the planner offered.
    expect(gm.activeItinerary.legs[0].mode).toBe('WALK')
  })

  it('a re-plan inside a segment keeps the plan (sticky, like a round trip)', async () => {
    const store = makeStore({
      activeItinerary: plan.segments[0],
      isActive: true,
      multiStop: plan
    })
    await store.run(beginGoMode(plan.segments[0] as any))
    expect(store.getGoMode().multiStop).toBe(plan)
    // ...and an explicit null (a different trip from the planner) clears it.
    await store.run(beginGoMode(plan.segments[0] as any, { multiStop: null }))
    expect(store.getGoMode().multiStop).toBe(null)
  })

  it('the LAST segment ends at the destination on the usual dwell', async () => {
    const last = { ...plan, index: 1 }
    const store = makeStore({
      activeItinerary: plan.segments[1],
      isActive: true,
      multiStop: last,
      tracking: { ...initial.tracking, lastPosition: fixAt(DEST, BASE) }
    })
    store.run(handlePositionUpdate(fixAt(DEST, BASE)))
    expect(store.types()).toContain('SET_ARRIVED')
    fakeNow = BASE + 8 * MIN
    jest.advanceTimersByTime(8 * MIN)
    expect(store.types()).toContain('STOP_GO_MODE')
    expect(store.getGoMode().isActive).toBe(false)
    // Landed on the search form, as any finished trip does.
    expect(store.screens()).toEqual([3])
  })

  it('"Continue" on the last segment does nothing', async () => {
    const store = makeStore({
      activeItinerary: plan.segments[1],
      arrivedAt: BASE,
      isActive: true,
      multiStop: { ...plan, index: 1 }
    })
    await store.run(continueMultiStop())
    expect(mockedFetch).not.toHaveBeenCalled()
    expect(store.types()).not.toContain('STOP_GO_MODE')
  })
})

describe('a trip paused at a stop survives the errand across a reload (43.1)', () => {
  // Imported here so the module's own `sessionStartedAt` is fresh per file.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const persistence = require('../../../lib/util/go-mode/session-persistence')
  const RealDateNow = Date.now

  afterEach(() => {
    Date.now = RealDateNow
    persistence.clearGoModeSession()
  })

  const saveAt = (multiStop: MultiStopPlan | null, arrivedAt: number) => {
    persistence.clearGoModeSession()
    Date.now = () => arrivedAt
    persistence.saveGoModeSession({
      ...initial,
      activeItinerary: wholeTrip(arrivedAt - 15 * MIN),
      arrivedAt,
      isActive: true,
      multiStop
    })
  }

  it('resumes to the "Continue" card an hour into the stop', () => {
    const plan = buildMultiStopPlan(wholeTrip()) as MultiStopPlan
    saveAt(plan, BASE)
    Date.now = () => BASE + 60 * MIN
    const session = persistence.loadGoModeSession()
    expect(session?.multiStop?.index).toBe(0)
    expect(session?.arrivedAt).toBe(BASE)
  })

  it('gives up after four hours at the stop', () => {
    const plan = buildMultiStopPlan(wholeTrip()) as MultiStopPlan
    saveAt(plan, BASE)
    Date.now = () => BASE + 4 * 60 * MIN + 1
    expect(persistence.loadGoModeSession()).toBeNull()
  })

  it('an ordinary arrival still expires after five minutes', () => {
    saveAt(null, BASE)
    Date.now = () => BASE + 10 * MIN
    expect(persistence.loadGoModeSession()).toBeNull()
  })

  it('the destination of a multi-stop trip expires like any arrival', () => {
    const plan = buildMultiStopPlan(wholeTrip()) as MultiStopPlan
    saveAt({ ...plan, index: 1 }, BASE)
    Date.now = () => BASE + 10 * MIN
    expect(persistence.loadGoModeSession()).toBeNull()
  })
})
