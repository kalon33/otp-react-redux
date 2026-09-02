import { encode } from '@mapbox/polyline'

import '../../test-utils/mock-window-url'
import {
  captureNotificationLatches,
  checkUpcomingTurn,
  resetDelayAlerts,
  resetLegAnnouncements,
  resetTurnAnnouncements
} from '../../../lib/util/go-mode/notification-service'
import {
  clearGoModeSession,
  loadGoModeSession,
  saveGoModeSession
} from '../../../lib/util/go-mode/session-persistence'
import {
  endGoMode,
  handlePositionUpdate,
  resumeGoModeTrip
} from '../../../lib/actions/go-mode'
import { getInitialState } from '../../../lib/reducers/create-otp-reducer'
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

const initial = goModeReducer(undefined, { type: '@@INIT' } as any)

/**
 * The two residues 6.21 left behind, both found while fixing it.
 *
 * 6.21 taught a re-mount to carry the notifier's dedupe list and three of its
 * four object-keyed latches across a page load. What it did not reach:
 *
 *  - 6.30 `session.lastTransitionedLegIndex` is module state, so a resumed
 *    trip reads `previousLegIndex` as 0 and announces a TRANSITION_LEG onto
 *    the leg the rider is already riding. Not noise to be suppressed:
 *    `advanceToLeg` is the ONLY place `startVehicleTracking` runs for a
 *    mid-trip transit leg, and `startGoModeTracking` arms it for leg 0 alone —
 *    so the spurious transition was, accidentally, the thing keeping vehicle
 *    polling alive across a re-mount.
 *  - 6.31 the turn-announcement latch (`turnState`) is the fourth leg-keyed
 *    latch and was left out of `captureNotificationLatches` because the
 *    off-corridor work owned that file at the time.
 */

const ORIGIN: [number, number] = [44.9, -93.3]
const STOP: [number, number] = [44.91, -93.29]
const DEST: [number, number] = [44.96, -93.22]

const BOARD_STOP_ID = '1:56831'

/** Bike access into a bus leg — the shape a mid-ride re-mount lands in. */
const itineraryAt = (boardTimeMs: number): any => ({
  duration: 3000,
  endTime: boardTimeMs + 1_800_000,
  legs: [
    {
      distance: 1370,
      duration: 1200,
      endTime: boardTimeMs,
      from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Origin' },
      legGeometry: { points: encode([ORIGIN, STOP]) },
      mode: 'BICYCLE',
      startTime: boardTimeMs - 1_200_000,
      steps: [
        {
          absoluteDirection: 'NORTH',
          distance: 700,
          lat: ORIGIN[0],
          lon: ORIGIN[1],
          relativeDirection: 'RIGHT',
          streetName: 'Village Lane'
        },
        {
          absoluteDirection: 'EAST',
          distance: 670,
          lat: STOP[0],
          lon: STOP[1],
          relativeDirection: 'LEFT',
          streetName: 'Bryant Ave S'
        }
      ],
      to: {
        lat: STOP[0],
        lon: STOP[1],
        name: 'I-35W & 98th St Station',
        stopId: BOARD_STOP_ID
      },
      transitLeg: false
    },
    {
      distance: 7830,
      duration: 1800,
      endTime: boardTimeMs + 1_800_000,
      from: {
        lat: STOP[0],
        lon: STOP[1],
        name: 'I-35W & 98th St Station',
        stop: { gtfsId: BOARD_STOP_ID },
        stopId: BOARD_STOP_ID
      },
      legGeometry: { points: encode([STOP, DEST]) },
      mode: 'BUS',
      routeId: '1:904',
      routeShortName: 'METRO Orange Line',
      startTime: boardTimeMs,
      to: { lat: DEST[0], lon: DEST[1], name: 'Alight stop' },
      transitLeg: true
    }
  ],
  startTime: boardTimeMs - 1_200_000
})

const alongBusLeg = (fraction: number): [number, number] => [
  STOP[0] + (DEST[0] - STOP[0]) * fraction,
  STOP[1] + (DEST[1] - STOP[1]) * fraction
]

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
      speed: 12
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

// -------------------------------------------------------------------------
// 6.30 — the leg transition a re-mount invents
// -------------------------------------------------------------------------

describe('a mid-trip re-mount and the leg it thinks the rider just changed to', () => {
  const NOW = Date.UTC(2026, 7, 31, 23, 20, 0)
  const BOARD_TIME = NOW - 300_000
  const savedPermissions = (navigator as any).permissions

  beforeEach(() => {
    window.localStorage.clear()
    clearGoModeSession()
    setTestTime(NOW)
    // Refused, so the resume stops short of a real GPS poll; everything under
    // test is decided before that point.
    ;(navigator as any).permissions = {
      query: () => Promise.resolve({ state: 'denied' })
    }
    // The trip session is module state and nothing else resets it.
    makeStore({ isActive: true }).run(endGoMode())
  })

  afterEach(() => {
    makeStore({ isActive: true }).run(endGoMode())
    restoreDateNowBehavior()
    ;(navigator as any).permissions = savedPermissions
  })

  /** Ride onto the bus, lose the page, and come back the way main.js does. */
  const rideThenRemount = (transitionedLegIndex: number | null) => {
    const itinerary = itineraryAt(BOARD_TIME)
    saveGoModeSession(
      { ...initial, activeItinerary: itinerary, isActive: true } as any,
      null,
      transitionedLegIndex
    )
    // A page load: create-otp-reducer is what turns the saved trip back into
    // a running one, and it is where the latch re-keying happens.
    const restored = (getInitialState({} as any) as any).goMode
    return makeStore({
      ...restored,
      tracking: { ...initial.tracking, isTracking: true }
    })
  }

  it('saves the transition guard with the trip', () => {
    const itinerary = itineraryAt(BOARD_TIME)
    saveGoModeSession(
      { ...initial, activeItinerary: itinerary, isActive: true } as any,
      null,
      1
    )
    expect(loadGoModeSession()?.lastTransitionedLegIndex).toBe(1)
  })

  it('does not erase a saved guard when a later save has none to offer', () => {
    const itinerary = itineraryAt(BOARD_TIME)
    const live: any = { ...initial, activeItinerary: itinerary, isActive: true }
    saveGoModeSession(live, null, 1)
    loadGoModeSession()
    saveGoModeSession(live)
    expect(loadGoModeSession()?.lastTransitionedLegIndex).toBe(1)
  })

  // FAILS AGAINST UNFIXED SOURCE: the resume left the guard null, so the first
  // tick on the bus leg dispatched TRANSITION_LEG for the leg the rider had
  // been sitting on for five minutes.
  it('does not announce a leg change that never happened', async () => {
    const store = rideThenRemount(1)
    await store.run(resumeGoModeTrip())

    const afterResume = store.types().length
    await store.run(handlePositionUpdate(fixAt(alongBusLeg(0.05), NOW)))

    expect(store.types().slice(afterResume)).not.toContain('TRANSITION_LEG')
  })

  // CONTROL: the same tick on a session that carries no guard (one saved
  // before the field existed) still transitions, so the case above is not
  // passing because the transition was impossible.
  it('CONTROL: a session with no saved guard still transitions', async () => {
    const store = rideThenRemount(null)
    await store.run(resumeGoModeTrip())

    const afterResume = store.types().length
    await store.run(handlePositionUpdate(fixAt(alongBusLeg(0.05), NOW)))

    expect(store.types().slice(afterResume)).toContain('TRANSITION_LEG')
  })

  // FAILS AGAINST UNFIXED SOURCE: startGoModeTracking arms vehicle polling for
  // leg 0 only, and leg 0 here is a bicycle — so before this fix the ONLY
  // thing that re-armed it was the spurious transition, i.e. suppressing that
  // dispatch on its own would have left the rider's bus untracked.
  it('re-arms vehicle tracking for the leg the rider is actually on', async () => {
    const store = rideThenRemount(1)
    await store.run(resumeGoModeTrip())
    expect(store.types()).toContain('SET_TRANSIT_LEG_ENTERED')
  })

  it('does not re-arm vehicle polling on a trip that has already arrived', async () => {
    const itinerary = itineraryAt(BOARD_TIME)
    saveGoModeSession(
      {
        ...initial,
        activeItinerary: itinerary,
        arrivedAt: NOW - 30_000,
        isActive: true
      } as any,
      null,
      1
    )
    const restored = (getInitialState({} as any) as any).goMode
    const store = makeStore({
      ...restored,
      tracking: { ...initial.tracking, isTracking: true }
    })
    await store.run(resumeGoModeTrip())
    expect(store.types()).not.toContain('SET_TRANSIT_LEG_ENTERED')
  })
})

// -------------------------------------------------------------------------
// 6.31 — the turn latch
// -------------------------------------------------------------------------

describe('the turn-announcement latch across a re-mount', () => {
  const NOW = Date.UTC(2026, 7, 31, 23, 20, 0)
  const BOARD_TIME = NOW + 600_000

  const turnProgress = (now: number, over: any = {}) => ({
    currentLegIndex: 0,
    currentLegProgress: 30,
    currentTime: new Date(now),
    delay: 0,
    distanceToDestination: 5000,
    distanceToNextTurn: 40,
    estimatedArrival: new Date(now + 900_000),
    nextTurnCue: {
      index: 0,
      instruction: 'Turn right on Village Lane',
      significant: true
    },
    overallProgress: 20,
    riderSpeedMps: 2,
    status: 'in_progress',
    ...over
  })

  /** What a page load actually destroys: every leg-keyed latch there is. */
  const remount = () => {
    resetLegAnnouncements()
    resetDelayAlerts()
    resetTurnAnnouncements()
    return (getInitialState({} as any) as any).goMode
  }

  beforeEach(() => {
    window.localStorage.clear()
    clearGoModeSession()
    resetLegAnnouncements()
    resetDelayAlerts()
    resetTurnAnnouncements()
    setTestTime(NOW)
  })

  afterEach(restoreDateNowBehavior)

  const rideThenRemount = () => {
    const itinerary = itineraryAt(BOARD_TIME)
    const cue = checkUpcomingTurn(
      turnProgress(NOW) as any,
      itinerary.legs[0] as any,
      []
    )
    expect(cue?.title).toBe('Turn right on Village Lane')

    let live: any = { ...initial, activeItinerary: itinerary, isActive: true }
    live = goModeReducer(live, { payload: cue, type: 'ADD_NOTIFICATION' })
    saveGoModeSession(live)

    // Six minutes on — past `wasRecentlySent`'s 30 s window, so nothing here
    // is being suppressed by a clock.
    setTestTime(NOW + 360_000)
    return remount()
  }

  it('saves the announced cues as leg indexes', () => {
    const itinerary = itineraryAt(BOARD_TIME)
    checkUpcomingTurn(turnProgress(NOW) as any, itinerary.legs[0] as any, [])

    saveGoModeSession({
      ...initial,
      activeItinerary: itinerary,
      isActive: true
    } as any)

    expect(
      loadGoModeSession()?.notificationLatches?.announcedTurnCuesByLeg
    ).toEqual({ 0: ['0_prepare'] })
  })

  // FAILS AGAINST UNFIXED SOURCE: `turnState` is a WeakMap on the leg object,
  // the restored legs are new objects, and the rate limiter has long expired —
  // so the same turn was announced a second time on the first tick back.
  it('does not re-announce the turn the rider was already told about', () => {
    const restored = rideThenRemount()
    expect(
      checkUpcomingTurn(
        turnProgress(NOW + 360_000) as any,
        restored.activeItinerary.legs[0],
        restored.notifications.sentNotifications
      )
    ).toBeNull()
  })

  it('still announces a turn the rider had not reached when the page went', () => {
    const restored = rideThenRemount()
    expect(
      checkUpcomingTurn(
        turnProgress(NOW + 360_000, {
          nextTurnCue: {
            index: 1,
            instruction: 'Turn left on Bryant Ave S',
            significant: true
          }
        }) as any,
        restored.activeItinerary.legs[0],
        restored.notifications.sentNotifications
      )?.title
    ).toBe('Turn left on Bryant Ave S')
  })

  it('re-arms cleanly for a leg that was never announced on', () => {
    const restored = rideThenRemount()
    expect(
      captureNotificationLatches(restored.activeItinerary.legs)
        .announcedTurnCuesByLeg
    ).toEqual({ 0: ['0_prepare'] })
  })
})
