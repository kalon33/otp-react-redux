import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import {
  endGoMode,
  handlePositionUpdate,
  quietReplanAccessLeg
} from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  }))
}))

const initial = goMode(undefined, { type: '@@INIT' })
const mockedFetch = fetchOnboardCandidatePlan as jest.Mock

/**
 * 2026-08-28 afternoon: the destination was inside the State Fairgrounds, where
 * the street graph stops at the fence. Distance to it never dropped below 454 m
 * across 32 minutes of repeated re-planning into the venue interior.
 *
 * `distanceToDestination` was recomputed on every tick and read by exactly one
 * thing — the arrival latch — so nothing in the app could notice that
 * re-planning had stopped helping. It now persists on the trip session, and
 * three re-plans with no net reduction retire that mode for the trip.
 */

// A bike-only trip: the rider circles at a fixed distance from a destination
// the graph will not take them to.
const START: [number, number] = [44.98, -93.18]
const DEST: [number, number] = [44.98, -93.17]

const trip = () => ({
  duration: 900,
  endTime: 0,
  legs: [
    {
      distance: 800,
      duration: 900,
      endTime: 0,
      from: { lat: START[0], lon: START[1], name: 'Snelling & Como' },
      legGeometry: { points: encode([START, DEST]) },
      mode: 'BICYCLE',
      startTime: 0,
      to: { lat: DEST[0], lon: DEST[1], name: 'State Fairgrounds' },
      transitLeg: false
    }
  ],
  startTime: 0
})

const fixAt = (lon: number, timestamp: number): GeolocationPosition =>
  ({
    coords: {
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: START[0],
      longitude: lon,
      speed: 5.5
    },
    timestamp
  } as GeolocationPosition)

const makeStore = () => {
  let runThunks = false
  let goModeState: any = {
    ...initial,
    activeItinerary: trip(),
    isActive: true,
    routeMatch: { legIndex: 0, progressAlongLeg: 0 },
    tracking: { ...initial.tracking, lastPosition: fixAt(-93.18, 0) }
  }
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
    if (typeof action === 'function') {
      return runThunks ? action(dispatch, getState) : undefined
    }
    actions.push(action)
    goModeState = goMode(goModeState, action)
    return action
  }
  return {
    actions,
    getGoMode: () => goModeState,
    run: (thunk: any) => thunk(dispatch, getState),
    setRunThunks: (on: boolean) => {
      runThunks = on
    }
  }
}

describe('re-planning that never converges (2026-08-28)', () => {
  let clock = 1_756_500_000_000
  let dateFaker: FakeTimers.InstalledClock | undefined
  let store: ReturnType<typeof makeStore> | undefined

  beforeEach(() => {
    mockedFetch.mockReset()
    // Real, empty OTP answers — the project rule is that nothing here may
    // fabricate an itinerary, and the stall is about distance, not about the
    // plans coming back bad.
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [] })
    )
    clock += 1_800_000
    dateFaker = FakeTimers.install({ now: clock, toFake: ['Date'] })
    store = makeStore()
  })
  afterEach(() => {
    store?.setRunThunks(false)
    store?.run(endGoMode())
    store = undefined
    dateFaker?.uninstall()
    dateFaker = undefined
  })

  /** One tick at `lon`, then a re-plan, `atMs` on the clock. */
  const tickAndReplan = async (lon: number, atMs: number) => {
    dateFaker?.setSystemTime(atMs)
    store?.setRunThunks(false)
    store?.run(handlePositionUpdate(fixAt(lon, atMs)))
    store?.setRunThunks(true)
    await store?.run(quietReplanAccessLeg())
  }

  // The rider wanders inside a ~450 m shell around a destination the graph does
  // not reach. Cooldown-clear spacing, so only the stall can stop a re-plan.
  const CIRCLING = [-93.1743, -93.1744, -93.1742, -93.1745, -93.1743]

  it('re-plans while there is any reason to think it is helping', async () => {
    await tickAndReplan(CIRCLING[0], clock + 60_000)
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    await tickAndReplan(CIRCLING[1], clock + 180_000)
    expect(mockedFetch).toHaveBeenCalledTimes(2)
  })

  it('stops re-planning the same mode once three attempts got nowhere', async () => {
    for (let i = 0; i < 3; i++) {
      await tickAndReplan(CIRCLING[i], clock + 60_000 + i * 120_000)
    }
    expect(mockedFetch).toHaveBeenCalledTimes(3)
    const before = mockedFetch.mock.calls.length
    // Unfixed, this is the fourth of thirty-two minutes' worth of real plan()
    // calls into a venue interior.
    await tickAndReplan(CIRCLING[3], clock + 60_000 + 3 * 120_000)
    await tickAndReplan(CIRCLING[4], clock + 60_000 + 4 * 120_000)
    expect(mockedFetch.mock.calls).toHaveLength(before)
  })

  it('tells the rider once, through the notification path it already has', async () => {
    for (let i = 0; i < 4; i++) {
      await tickAndReplan(CIRCLING[i], clock + 60_000 + i * 120_000)
    }
    const raised = (store?.actions || []).filter(
      (a: any) =>
        a.type === 'ADD_NOTIFICATION' &&
        a.payload?.type === 'DESTINATION_UNREACHABLE'
    )
    expect(raised).toHaveLength(1)
    expect(raised[0].payload.message).toContain('State Fairgrounds')
    // ...and not again on the next stalled tick.
    await tickAndReplan(CIRCLING[4], clock + 60_000 + 4 * 120_000)
    expect(
      (store?.actions || []).filter(
        (a: any) =>
          a.type === 'ADD_NOTIFICATION' &&
          a.payload?.type === 'DESTINATION_UNREACHABLE'
      )
    ).toHaveLength(1)
  })

  it('hands the machinery back when the rider starts closing again', async () => {
    for (let i = 0; i < 3; i++) {
      await tickAndReplan(CIRCLING[i], clock + 60_000 + i * 120_000)
    }
    expect(mockedFetch).toHaveBeenCalledTimes(3)
    // A gate opens, a path appears: 200 m of real progress toward the
    // destination. Re-planning is working again, so it is allowed again.
    await tickAndReplan(-93.172, clock + 60_000 + 3 * 120_000)
    expect(mockedFetch).toHaveBeenCalledTimes(4)
  })
})
