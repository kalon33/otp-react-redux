import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import { endGoMode, handlePositionUpdate } from '../../../lib/actions/go-mode'
import { TRANSIT_BOARD_EARLY_MS } from '../../../lib/util/go-mode/position-matching'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(() => () => Promise.resolve({})),
  fetchRerouteSnapshotPlan: jest.fn(() => () => Promise.resolve({})),
  findRoutesNearby: jest.fn(() => () => Promise.resolve({})),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({})),
  onboardGraphQLQuery: jest.fn(() => () => Promise.resolve({}))
}))

const initial = goMode(undefined, { type: '@@INIT' })

/**
 * 2026-08-27: the board-time gate that could only ever say no once.
 *
 * 3f5d5b95 gave shouldTransitionToNextLeg a reason to refuse — an access leg
 * and the transit leg after it share an endpoint, so a rider waiting at the
 * stop projects onto the bus leg while the bus is still hours out, and the app
 * must not step them onto it. The gate itself is right. Its call site was not:
 * it passed `goMode.routeMatch.legIndex`, the matcher's own last projection,
 * as "the leg the trip is on". updateRouteMatch has already stored the bus leg
 * by the time the gate refuses, so the NEXT tick reads that back, hits
 * `match.legIndex <= currentLegIndex`, and returns false ahead of the gate.
 * One refusal and the transition is dead for the whole trip.
 *
 * The cost is not cosmetic. advanceToLeg is the only place startVehicleTracking
 * is called for a mid-trip transit leg, so a rider who reached the platform
 * more than TRANSIT_BOARD_EARLY_MS early — the thing the app tells them to do —
 * rode the whole leg with no vehicle tracking, no vehicle match, and a riding
 * fact stamped with a null vehicleId. That is exactly what
 * verify-transit-trust's assertion c has reported every night since 2026-08-28:
 * `boarded 1:1173133/null`, the right trip and no bus. On the 7/29 Orange Line
 * replay the rider reached the platform at 17:19:43 for a 17:26 departure —
 * 77 s outside the five-minute window — and advanceToLeg never ran again.
 */

const START: [number, number] = [44.9, -93.27]
/** Where the bike leg ends and the bus leg begins: they share this point. */
const STOP: [number, number] = [44.918, -93.27]
const DEST: [number, number] = [44.918, -93.2]

/** ~39 m east of the stop, i.e. on the bus leg's shape and off the bike's. */
const ON_BUS_SHAPE: [number, number] = [44.918, -93.2695]

const BOARD_MS = 1_756_400_000_000

const trip = () => ({
  duration: 2400,
  endTime: BOARD_MS + 1_200_000,
  legs: [
    {
      distance: 2000,
      duration: 600,
      endTime: BOARD_MS,
      from: { lat: START[0], lon: START[1], name: 'Home' },
      legGeometry: { points: encode([START, STOP]) },
      mode: 'BICYCLE',
      startTime: BOARD_MS - 600_000,
      to: { lat: STOP[0], lon: STOP[1], name: 'I-35W & 46th St Station' },
      transitLeg: false
    },
    {
      distance: 5500,
      duration: 1200,
      endTime: BOARD_MS + 1_200_000,
      from: { lat: STOP[0], lon: STOP[1], name: 'I-35W & 46th St Station' },
      legGeometry: { points: encode([STOP, DEST]) },
      mode: 'BUS',
      route: { id: '1:901', shortName: 'Orange' },
      routeShortName: 'Orange',
      startTime: BOARD_MS,
      to: { lat: DEST[0], lon: DEST[1], name: 'I-35W & 98th St Station' },
      transitLeg: true,
      trip: { gtfsId: '1:1173133' }
    }
  ],
  startTime: BOARD_MS - 600_000
})

/** A walk-to-walk itinerary, to pin that non-transit legs are untouched. */
const walkTrip = () => ({
  duration: 1200,
  endTime: BOARD_MS + 600_000,
  legs: [
    {
      distance: 2000,
      duration: 600,
      endTime: BOARD_MS,
      from: { lat: START[0], lon: START[1], name: 'Home' },
      legGeometry: { points: encode([START, STOP]) },
      mode: 'WALK',
      startTime: BOARD_MS - 600_000,
      to: { lat: STOP[0], lon: STOP[1], name: 'Corner' },
      transitLeg: false
    },
    {
      distance: 5500,
      duration: 600,
      endTime: BOARD_MS + 600_000,
      from: { lat: STOP[0], lon: STOP[1], name: 'Corner' },
      legGeometry: { points: encode([STOP, DEST]) },
      mode: 'WALK',
      startTime: BOARD_MS,
      to: { lat: DEST[0], lon: DEST[1], name: 'Office' },
      transitLeg: false
    }
  ],
  startTime: BOARD_MS - 600_000
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
      speed: 0.2
    },
    timestamp
  } as GeolocationPosition)

/**
 * Minimal store. Thunks dispatched BY the tick are run (that is how
 * advanceToLeg gets to emit TRANSITION_LEG); thunks those in turn dispatch —
 * startVehicleTracking, startPositionTracking — are recorded and dropped, so no
 * poller or geolocation watcher is armed inside a unit test.
 */
const makeStore = (itinerary: any) => {
  let goModeState: any = {
    ...initial,
    activeItinerary: itinerary,
    isActive: true,
    tracking: { ...initial.tracking, lastPosition: fixAt(START, 0) }
  }
  const actions: any[] = []
  let depth = 0
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') {
      if (depth > 0) return undefined
      depth++
      try {
        return action(dispatch, getState)
      } catch (e) {
        return undefined
      } finally {
        depth--
      }
    }
    actions.push(action)
    goModeState = goMode(goModeState, action)
    return action
  }
  return {
    getGoMode: () => goModeState,
    run: (thunk: any) => thunk(dispatch, getState),
    transitions: () =>
      actions
        .filter((a) => a.type === 'TRANSITION_LEG')
        .map((a) => a.payload.legIndex)
  }
}

describe('the board-time gate that could only refuse once (2026-08-27)', () => {
  let store: ReturnType<typeof makeStore> | undefined
  let clock: FakeTimers.InstalledClock | undefined

  const tickAt = (at: number, where: [number, number] = ON_BUS_SHAPE) => {
    clock?.setSystemTime(at)
    store?.run(handlePositionUpdate(fixAt(where, at)))
  }

  beforeEach(() => {
    clock = FakeTimers.install({ now: BOARD_MS, toFake: ['Date'] })
  })
  afterEach(() => {
    store?.run(endGoMode())
    store = undefined
    clock?.uninstall()
    clock = undefined
  })

  it('still refuses to board a bus that is not due yet', () => {
    store = makeStore(trip())
    tickAt(BOARD_MS - TRANSIT_BOARD_EARLY_MS - 180_000)
    expect(store.transitions()).toEqual([])
    // ...and the stored match stays on the leg the trip has actually reached.
    //
    // It used to read 1 here: the matcher nominated the bus leg, the gate
    // refused it, and the nomination was stored anyway — a second, ungated
    // answer to "which leg is this trip on" that the next tick read back as
    // "already there". 3f5d5b95 worked around that by giving the gate
    // `session.lastTransitionedLegIndex` instead, which is what the case
    // below proves still holds; backlog 6.3 removes the second answer. On
    // 2026-09-01 ride 2 the two disagreed for 4m36s, and the progress
    // producer, the deviation detector and the riding decision spent all of
    // it measuring a cyclist against a bus polyline.
    expect(store.getGoMode().routeMatch?.legIndex).toBe(0)
  })

  /**
   * The regression. Fails against the unfixed call site with `[]` — the trip
   * never advances onto the bus, on this tick or any later one, because the
   * earlier refusal left the matcher's projection standing in for the trip's
   * own leg.
   */
  it('boards once the bus is due, after refusing while it was not', () => {
    store = makeStore(trip())
    tickAt(BOARD_MS - TRANSIT_BOARD_EARLY_MS - 180_000)
    expect(store.transitions()).toEqual([])

    tickAt(BOARD_MS - 120_000)
    expect(store.transitions()).toEqual([1])
  })

  it('advances exactly once, not on every tick after the gate opens', () => {
    store = makeStore(trip())
    tickAt(BOARD_MS - TRANSIT_BOARD_EARLY_MS - 180_000)
    tickAt(BOARD_MS - 120_000)
    tickAt(BOARD_MS - 60_000)
    tickAt(BOARD_MS + 30_000)
    expect(store.transitions()).toEqual([1])
  })

  /**
   * A rider whose whole wait happens outside the window is the case the gate
   * was written for; the point is that it now reopens rather than latching.
   */
  it('a walk-to-walk transition is unaffected — it never had a gate', () => {
    store = makeStore(walkTrip())
    tickAt(BOARD_MS - 3_600_000)
    expect(store.transitions()).toEqual([1])
  })
})
