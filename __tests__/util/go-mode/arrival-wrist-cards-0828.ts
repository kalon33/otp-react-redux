import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import {
  cancelPush,
  sendPush,
  TURN_CARD_NOTIFICATION_ID
} from '../../../lib/util/go-mode/native-notify'
import { endGoMode, handlePositionUpdate } from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/util/go-mode/native-notify', () => ({
  ...jest.requireActual('../../../lib/util/go-mode/native-notify'),
  cancelPush: jest.fn(() => Promise.resolve()),
  ensureNativeNotifyPermission: jest.fn(() => Promise.resolve(true)),
  hasNativeNotify: jest.fn(() => true),
  sendPush: jest.fn(() => Promise.resolve())
}))

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(() => () => Promise.resolve({})),
  fetchRerouteSnapshotPlan: jest.fn(() => () => Promise.resolve({})),
  findRoutesNearby: jest.fn(() => () => Promise.resolve({})),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({})),
  onboardGraphQLQuery: jest.fn(() => () => Promise.resolve({}))
}))

const initial = goMode(undefined, { type: '@@INIT' })
const mockCancel = cancelPush as jest.Mock
const mockSend = sendPush as jest.Mock

/**
 * 2026-08-28: the turn card that outlived the trip.
 *
 * The sticky turn and pacing cards are written at the bottom of
 * handlePositionUpdate, below the arrival quiesce's `else if (hasArrived)
 * return`. So the tick that latches arrival is the last one that ever reaches
 * them, and whatever card was posted last has no path to being cleared —
 * nothing but endGoMode cancels it, which a rider who backgrounds or kills the
 * app never reaches. On the 8/28 ride the watch still read "Turn left on
 * George Perry Floyd Jr Place" 88 minutes after the trip was over.
 *
 * It became reachable when 73ef2b9a taught arrival to fire on distance as well
 * as on a progress scalar — correctly; that is why trips end at all now. But
 * ARRIVAL_RADIUS_M is 75 m, so arrival can latch with the last turn of the leg
 * still ahead of the rider, instead of on the final tick where the cue list had
 * run dry and the card cleared itself on the way past. That is precisely the
 * before/after in the nightly log: verify-turn-by-turn reported one cancel on
 * 8/27 and zero on every night since.
 *
 * The pacing card (notification id 2) sits in the same block and leaked the
 * same way; it is cleared alongside. Only the turn card is asserted here — the
 * pacing card posts only on a leg that feeds a transit boarding, and an
 * itinerary that has one would test the pacing cadence rather than this.
 *
 * Same defect class as the deviation storm fixed in 74ebaf49 — a notification
 * with no path to being cleared.
 */

const START: [number, number] = [44.9, -93.27]
const DEST: [number, number] = [44.918, -93.27]
/** ~60 m short of the destination: inside ARRIVAL_RADIUS_M, past 90%. */
const NEARLY_THERE: [number, number] = [44.917461, -93.27]
/** Early on the leg, with both turns still ahead. */
const EARLY: [number, number] = [44.9018, -93.27]

const T0 = 1_756_500_000_000

/**
 * One bike leg with a turn near its end. The final turn sits BEYOND the
 * arrival radius, so the tick that latches arrival still has a cue in hand —
 * the shape of the 8/28 ride, where the last cue was 8 m from the end of a
 * 2633 m leg.
 */
const bikeTrip = () => ({
  duration: 600,
  endTime: T0 + 600_000,
  legs: [
    {
      distance: 2000,
      duration: 600,
      endTime: T0 + 600_000,
      from: { lat: START[0], lon: START[1], name: 'Home' },
      legGeometry: { points: encode([START, DEST]) },
      mode: 'BICYCLE',
      startTime: T0,
      steps: [
        {
          distance: 400,
          lat: 44.9036,
          lon: -93.27,
          relativeDirection: 'RIGHT',
          streetName: 'East 42nd Street'
        },
        {
          distance: 1600,
          lat: 44.9178,
          lon: -93.27,
          relativeDirection: 'LEFT',
          streetName: 'George Perry Floyd Jr Place'
        }
      ],
      to: { lat: DEST[0], lon: DEST[1], name: 'Destination' },
      transitLeg: false
    }
  ],
  startTime: T0
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
      speed: 4
    },
    timestamp
  } as GeolocationPosition)

/**
 * Minimal store. Nested thunks are recorded and dropped: the wrist cards are
 * pushed directly by the tick, not through dispatch, so nothing here needs to
 * run a poller to observe them.
 */
const makeStore = () => {
  let goModeState: any = {
    ...initial,
    activeItinerary: bikeTrip(),
    isActive: true,
    tracking: { ...initial.tracking, lastPosition: fixAt(START, T0) }
  }
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return undefined
    goModeState = goMode(goModeState, action)
    return action
  }
  return {
    getGoMode: () => goModeState,
    run: (thunk: any) => thunk(dispatch, getState)
  }
}

/** Pushes and cancels aimed at the sticky turn card (notification id 1). */
const turnCardWrites = () =>
  mockSend.mock.calls.filter((c) => c[0]?.id === TURN_CARD_NOTIFICATION_ID)
const turnCardCancels = () =>
  mockCancel.mock.calls.filter((c) => c[0] === TURN_CARD_NOTIFICATION_ID)

describe('the wrist cards outliving the trip (2026-08-28)', () => {
  let store: ReturnType<typeof makeStore> | undefined
  let clock: FakeTimers.InstalledClock | undefined

  const tickAt = (where: [number, number], at: number) => {
    clock?.setSystemTime(at)
    store?.run(handlePositionUpdate(fixAt(where, at)))
  }

  beforeEach(() => {
    mockSend.mockClear()
    mockCancel.mockClear()
    clock = FakeTimers.install({ now: T0, toFake: ['Date'] })
    store = makeStore()
  })
  afterEach(() => {
    store?.run(endGoMode())
    store = undefined
    clock?.uninstall()
    clock = undefined
  })

  it('puts a turn on the wrist while the rider is still riding', () => {
    tickAt(EARLY, T0 + 60_000)
    expect(store!.getGoMode().arrivedAt).toBeNull()
    expect(turnCardWrites()).toHaveLength(1)
    expect(turnCardCancels()).toHaveLength(0)
  })

  /**
   * The regression. Against the unfixed tick this is 0 cancels — the card
   * showing "Turn right on East 42nd Street" stays on the watch, and no later
   * tick can take it down because they all return at the quiesce.
   */
  it('takes the turn card back off the wrist when the trip ends', () => {
    tickAt(EARLY, T0 + 60_000)
    expect(turnCardWrites()).toHaveLength(1)

    tickAt(NEARLY_THERE, T0 + 400_000)
    expect(store!.getGoMode().arrivedAt).not.toBeNull()
    expect(turnCardCancels()).toHaveLength(1)
  })

  /**
   * Clearing is not enough on its own: the arrival tick still has a cue in
   * hand, so an evaluate-then-clear would cancel the card and immediately post
   * the NEXT turn onto a wrist nothing will visit again.
   */
  it('does not post a fresh turn on the way out', () => {
    tickAt(EARLY, T0 + 60_000)
    const before = turnCardWrites().length

    tickAt(NEARLY_THERE, T0 + 400_000)
    expect(turnCardWrites()).toHaveLength(before)
  })

  it('leaves the wrist alone on every tick after arrival', () => {
    tickAt(EARLY, T0 + 60_000)
    tickAt(NEARLY_THERE, T0 + 400_000)
    mockSend.mockClear()
    mockCancel.mockClear()

    for (let i = 1; i <= 5; i++) {
      tickAt(NEARLY_THERE, T0 + 400_000 + i * 60_000)
    }
    expect(turnCardWrites()).toHaveLength(0)
    expect(turnCardCancels()).toHaveLength(0)
  })
})
