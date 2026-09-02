import { encode } from '@mapbox/polyline'

import '../../test-utils/mock-window-url'
import {
  clearGoModeSession,
  loadGoModeSession,
  resumedDebugSessionId,
  saveGoModeSession
} from '../../../lib/util/go-mode/session-persistence'
import { createEntryIdMinter } from '../../../lib/util/debug-log-entry'
import { findStopTimesForStop } from '../../../lib/actions/apiV2'
import {
  handlePositionUpdate,
  resumeGoModeTrip,
  startGoModeTracking
} from '../../../lib/actions/go-mode'
import { restoreDateNowBehavior, setTestTime } from '../../test-utils'
import goModeReducer from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchRerouteSnapshotPlan: jest.fn(() => () => Promise.resolve(null)),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve(null))
}))

const initial = goModeReducer(undefined, { type: '@@INIT' })

/**
 * WHAT HAPPENS AFTER THE TRIP IS OVER — the 2026-09-01 rides, and what the
 * 08-31 fix did not reach.
 *
 * `cb453726` made a finished trip come back finished: `goMode.arrivedAt` is now
 * saved and restored, so the tick's own quiesce, the reroute guard and the
 * notification pass are all armed on the first fix after a re-mount. Measured
 * against the 09-01 recording (`mtin0l9c-yieexg`), that holds: ride 1's 49
 * minutes between `SET_ARRIVED` 13:59:37Z and the rider closing the trip at
 * 14:48:47Z carry 109 positions at a clean 30 s spacing, not the 1 Hz the
 * backlog row assumed. Row 4.10's "665 records" counts the whole post-arrival
 * stream, and 256 of it is a browser current-location poll that has nothing to
 * do with Go Mode.
 *
 * What IS still wrong is everything that does not live inside the tick:
 *
 *  - The 15-second live-vehicle poll (`session.vehiclePositionIntervalId`).
 *    Nothing stops it at arrival — the quiesce governs only what
 *    `handlePositionUpdate` does. It escapes notice on the 09-01 rides because
 *    both END on an access leg and `advanceToLeg` had already torn it down; the
 *    08-31 mount, which resumed a finished trip whose leg 0 was the bus, logged
 *    392 `REALTIME_VEHICLE_POSITIONS_RESPONSE` across 104 minutes — one per
 *    16 s, the interval exactly — from a parked phone.
 *
 *  - The funnel's own baseline. `session.lastArrivedFixMs` lives on the trip
 *    session, a module-level object rebuilt on every page load, while
 *    `arrivedAt` lives in the store and survives one. Reading a null baseline
 *    as "let this fix through" gives every re-mount a free full tick — twice in
 *    41 s on 2026-08-31.
 *
 *  - And the resume path itself, which armed the whole live-trip machine over a
 *    finished trip: leg 0's tracking interval, the boarding stop-time prefetch,
 *    vehicle polling, reroute-snapshot capture.
 */

const ORIGIN: [number, number] = [44.95, -93.29]
const DEST: [number, number] = [44.98, -93.27]

const walkItinerary = (endTime: number) => ({
  duration: 1800,
  endTime,
  legs: [
    {
      distance: 3800,
      duration: 1800,
      endTime,
      from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Origin' },
      legGeometry: { points: encode([ORIGIN, DEST]) },
      mode: 'WALK',
      startTime: endTime - 1800000,
      to: { lat: DEST[0], lon: DEST[1], name: 'Destination' },
      transitLeg: false
    }
  ],
  startTime: endTime - 1800000
})

/** A trip whose first leg is the bus — the shape that arms vehicle polling. */
const busItinerary = (endTime: number) => ({
  duration: 1800,
  endTime,
  legs: [
    {
      distance: 8000,
      duration: 1800,
      endTime,
      from: {
        lat: ORIGIN[0],
        lon: ORIGIN[1],
        name: 'Board stop',
        stop: { gtfsId: '1:56884' }
      },
      legGeometry: { points: encode([ORIGIN, DEST]) },
      mode: 'BUS',
      routeId: '1:904',
      startTime: endTime - 1800000,
      to: { lat: DEST[0], lon: DEST[1], name: 'Alight stop' },
      transitLeg: true
    }
  ],
  startTime: endTime - 1800000
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

/** Real reducer, thunks executed, every action recorded. */
const makeStore = (goModeOverrides: any = {}) => {
  let goModeState: any = { ...initial, ...goModeOverrides }
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    goModeState = goModeReducer(goModeState, action)
    return action
  }
  return {
    actions: () => actions,
    getGoMode: () => goModeState,
    run: (thunk: any) => thunk(dispatch, getState),
    types: () => actions.map((a) => a.type)
  }
}

const NOW = Date.UTC(2026, 8, 1, 13, 59, 37)
const ARRIVED_AT = NOW - 20_000

const arrivedStore = () =>
  makeStore({
    activeItinerary: walkItinerary(NOW - 60_000),
    arrivedAt: ARRIVED_AT,
    isActive: true,
    tracking: { ...initial.tracking, isTracking: true }
  })

/**
 * ORDER MATTERS IN THIS BLOCK. `session.lastArrivedFixMs` is module state and
 * nothing exported resets it, so the FIRST case here runs against a virgin trip
 * session — which is exactly the state a page load leaves behind, and exactly
 * the case under test. The later cases then build on the baseline it sets.
 */
describe('the post-arrival funnel across a re-mount (2026-09-01)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    clearGoModeSession()
    setTestTime(NOW)
  })

  afterEach(restoreDateNowBehavior)

  it('drops the first fix after a re-mount — arrival is the baseline, not "anything goes"', () => {
    // A page load 5 s after the rider arrived. The store remembers the arrival;
    // the trip session was rebuilt and remembers nothing. Reading that null as
    // Infinity waved this fix through and ran a full tick on a finished trip.
    const store = arrivedStore()
    store.run(handlePositionUpdate(fixAt(DEST, ARRIVED_AT + 5_000)))
    expect(store.types()).not.toContain('UPDATE_POSITION')
    expect(store.types()).not.toContain('UPDATE_PROGRESS')
  })

  it('CONTROL: lets a fix through once the interval has genuinely elapsed', () => {
    const store = arrivedStore()
    store.run(handlePositionUpdate(fixAt(DEST, ARRIVED_AT + 40_000)))
    expect(store.types()).toContain('UPDATE_POSITION')
  })

  it('CONTROL: holds the next one, so the cadence is the taper and not the GPS stream', () => {
    const store = arrivedStore()
    store.run(handlePositionUpdate(fixAt(DEST, ARRIVED_AT + 45_000)))
    expect(store.types()).not.toContain('UPDATE_POSITION')
  })
})

/**
 * The resume path. `main.js` used to call startGoModeTracking directly on a
 * restored trip, which does not ask whether the trip is over — so a finished
 * one came back with leg 0's tracking interval, the boarding stop-time prefetch
 * and live vehicle polling all armed. Both 2026-08-31 mounts dispatched
 * `UPDATE_TRACKING_INTERVAL {interval: 10000}` and `SET_TRANSIT_LEG_ENTERED`
 * for a trip that had arrived.
 */
describe('resuming a trip that is already over (2026-08-31 / 2026-09-01)', () => {
  const savedPermissions = (navigator as any).permissions

  beforeEach(() => {
    window.localStorage.clear()
    clearGoModeSession()
    setTestTime(NOW)
    // Refused, so the resume stops short of starting a real GPS poll. The
    // decisions under test are all taken before that point.
    ;(navigator as any).permissions = {
      query: () => Promise.resolve({ state: 'denied' })
    }
  })

  afterEach(() => {
    restoreDateNowBehavior()
    ;(navigator as any).permissions = savedPermissions
  })

  const resumedBusStore = (arrivedAt: number | null) =>
    makeStore({
      activeItinerary: busItinerary(NOW - 60_000),
      arrivedAt,
      isActive: true,
      tracking: { ...initial.tracking, isTracking: true }
    })

  it('resumes at the post-arrival cadence, not the first leg’s', async () => {
    const store = resumedBusStore(ARRIVED_AT)
    await store.run(startGoModeTracking(busItinerary(NOW - 60_000) as any))
    const intervals = store
      .actions()
      .filter((a) => a.type === 'UPDATE_TRACKING_INTERVAL')
      .map((a) => a.payload.interval)
    expect(intervals).toEqual([30000])
  })

  it('does not re-arm live vehicle polling for a bus nobody is waiting for', async () => {
    const store = resumedBusStore(ARRIVED_AT)
    await store.run(startGoModeTracking(busItinerary(NOW - 60_000) as any))
    expect(store.types()).not.toContain('SET_TRANSIT_LEG_ENTERED')
  })

  it('does not re-fetch the boarding stop times either', async () => {
    const stopTimes = findStopTimesForStop as unknown as jest.Mock
    stopTimes.mockClear()
    const store = resumedBusStore(ARRIVED_AT)
    await store.run(startGoModeTracking(busItinerary(NOW - 60_000) as any))
    expect(stopTimes).not.toHaveBeenCalled()
  })

  it('CONTROL: a trip still under way resumes fully armed', async () => {
    const stopTimes = findStopTimesForStop as unknown as jest.Mock
    stopTimes.mockClear()
    const store = resumedBusStore(null)
    await store.run(startGoModeTracking(busItinerary(NOW + 600_000) as any))
    expect(store.types()).toContain('SET_TRANSIT_LEG_ENTERED')
    expect(stopTimes).toHaveBeenCalled()
    const intervals = store
      .actions()
      .filter((a) => a.type === 'UPDATE_TRACKING_INTERVAL')
      .map((a) => a.payload.interval)
    expect(intervals).not.toContain(30000)
  })
})

/**
 * A resumed ride had no beginning anyone could find. build-fixture.js brackets
 * a ride from START_GO_MODE to trip end, and the resume path dispatched neither
 * — so the 104-minute 2026-08-31 session, the one that mattered most, could not
 * be replayed at all.
 */
describe('a resumed ride announces itself (2026-08-31)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    clearGoModeSession()
    setTestTime(NOW)
    ;(navigator as any).permissions = {
      query: () => Promise.resolve({ state: 'denied' })
    }
  })

  afterEach(restoreDateNowBehavior)

  it('emits RESUME_GO_MODE carrying the itinerary, so the ride has a start', async () => {
    const itinerary = walkItinerary(NOW + 600_000)
    const store = makeStore({
      activeItinerary: itinerary,
      isActive: true,
      tracking: { ...initial.tracking, isTracking: true }
    })
    await store.run(resumeGoModeTrip())
    const resume = store.actions().find((a) => a.type === 'RESUME_GO_MODE')
    expect(resume).toBeDefined()
    expect(resume.payload.resumed).toBe(true)
    // The itinerary is the payload's whole point: without it the fixture
    // builder has a bracket and no trip to put in it.
    expect(resume.payload.itinerary.startTime).toBe(itinerary.startTime)
  })

  it('says whether the trip it picked up had already arrived', async () => {
    const store = makeStore({
      activeItinerary: walkItinerary(NOW - 60_000),
      arrivedAt: ARRIVED_AT,
      isActive: true,
      tracking: { ...initial.tracking, isTracking: true }
    })
    await store.run(resumeGoModeTrip())
    const resume = store.actions().find((a) => a.type === 'RESUME_GO_MODE')
    expect(resume.payload.arrivedAt).toBe(ARRIVED_AT)
  })

  it('says nothing when there is no trip to resume', async () => {
    const store = makeStore({})
    await store.run(resumeGoModeTrip())
    expect(store.types()).not.toContain('RESUME_GO_MODE')
  })
})

/**
 * One ride, two session ids. The debug session id is minted per app start, and
 * ride-watch keys its per-trip state and its two-page-per-ride budget on it, so
 * a ride the app re-mounts inside arrives as two rides — `mthw7svy-s4msqc` then
 * `mthw8o2w-i8z1i6`, 41 s apart, the same trip. It is carried with the trip
 * rather than kept globally, so it is reused exactly when a ride is resumed.
 */
describe('the session id survives a re-mount (2026-08-31)', () => {
  const NOW_31 = Date.UTC(2026, 7, 31, 23, 52, 55)

  beforeEach(() => {
    window.localStorage.clear()
    clearGoModeSession()
    setTestTime(NOW_31)
  })

  afterEach(restoreDateNowBehavior)

  it('saves the id the ride is being recorded under', () => {
    saveGoModeSession(
      {
        ...initial,
        activeItinerary: walkItinerary(NOW_31 + 600_000),
        isActive: true
      } as any,
      'mthw7svy-s4msqc'
    )
    expect(loadGoModeSession()?.debugSessionId).toBe('mthw7svy-s4msqc')
  })

  it('hands it back to the load that resumes the ride', () => {
    saveGoModeSession(
      {
        ...initial,
        activeItinerary: walkItinerary(NOW_31 + 600_000),
        isActive: true
      } as any,
      'mthw7svy-s4msqc'
    )
    // The re-mount: a fresh load reads the trip back out of storage.
    expect(loadGoModeSession()).not.toBeNull()
    expect(resumedDebugSessionId()).toBe('mthw7svy-s4msqc')
  })

  it('offers nothing when no ride was restored', () => {
    clearGoModeSession()
    expect(resumedDebugSessionId()).toBeNull()
  })

  it('a save with no id in hand does not erase the one already stored', () => {
    saveGoModeSession(
      {
        ...initial,
        activeItinerary: walkItinerary(NOW_31 + 600_000),
        isActive: true
      } as any,
      'mthw7svy-s4msqc'
    )
    loadGoModeSession()
    saveGoModeSession({
      ...initial,
      activeItinerary: walkItinerary(NOW_31 + 600_000),
      isActive: true
    } as any)
    expect(loadGoModeSession()?.debugSessionId).toBe('mthw7svy-s4msqc')
  })

  it('two loads sharing a session id still mint distinct entry ids', () => {
    // Without this the sink, which dedupes on the entry id, would drop every
    // record of the second load as a re-send of the first's.
    const first = createEntryIdMinter('mthw7svy-s4msqc')
    const second = createEntryIdMinter('mthw7svy-s4msqc', 'mthw8o2w-i8z1i6')
    expect(first()).toBe('mthw7svy-s4msqc-0')
    expect(second()).toBe('mthw7svy-s4msqc.mthw8o2w-i8z1i6-0')
    expect(first()).not.toBe(second())
    // ...and each load's own sequence stays dense, so a gap still reads as loss.
    expect(second()).toBe('mthw7svy-s4msqc.mthw8o2w-i8z1i6-2')
  })
})
