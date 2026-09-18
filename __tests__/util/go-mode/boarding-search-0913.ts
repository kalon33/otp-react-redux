import { boardingPromptBody } from '../../../lib/util/go-mode/boarding-confirmation'
import {
  confirmBoardingByRider,
  searchBoardingVehicles
} from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'

/**
 * "I'm on the bus" on an access leg (2026-09-13 Green Line ride, backlog 15.2).
 *
 * The rider boarded train 1:32141 at Dale St at 11:35:48 while Go Mode still
 * had them on leg 0, the bike leg. They tapped "I'm on the bus" twice —
 * 11:36:24 and 11:36:37 — and the sheet answered "No buses detected nearby"
 * both times, because `vehicleMatch.nearbyVehicles` is written only by
 * `performVehicleMatching`, which runs on the interval `startVehicleTracking`
 * arms when a TRANSIT leg becomes current. Zero UPDATE_NEARBY_VEHICLES in the
 * window. Meanwhile the tick's own access-leg poll was fetching route 1:902
 * every 20 s and every response carried 32141.
 *
 * Every position, speed and vehicle frame below is lifted from
 * ~/otp-debug-logs/debug-2026-09-13.jsonl, session mtzysbii-nqg66h.
 */

const initial = goMode(undefined, { type: '@@INIT' })

// The 32141 frame the app already held when the rider tapped: fetched in the
// 11:36:09 and 11:36:29 polls of route 1:902, itself stamped 11:34:56 — the
// Green Line feed was running 60-70 s behind the train all morning.
const TRAIN_32141 = {
  directionId: '1',
  heading: null,
  label: '32141',
  lat: 44.9557533,
  lon: -93.1282578,
  patternId: 'UGF0dGVybjoxOjkwMjoxOjAy',
  routeId: '1:902',
  seconds: 1789317296,
  speed: 0,
  tripHeadsign: 'Mpls-Target Field',
  tripId: '1:879781',
  vehicleId: '1:32141'
}

/** The rider's own fix at each tap (UPDATE_POSITION, same second). */
const TAP_1124 = { latitude: 44.95579, longitude: -93.13633, speed: 15.2158 }
const TAP_1137 = { latitude: 44.95575, longitude: -93.13777, speed: 3.9559 }

const itinerary = () => ({
  duration: 3000,
  endTime: 0,
  legs: [
    { mode: 'BICYCLE', transitLeg: false },
    {
      mode: 'TRAM',
      routeColor: '00A65A',
      routeId: '1:902',
      routeLongName: 'METRO Green Line',
      routeShortName: null,
      routeTextColor: 'FFFFFF',
      transitLeg: true,
      trip: { gtfsId: '1:879781' }
    },
    { mode: 'BICYCLE', transitLeg: false }
  ],
  startTime: 0
})

/** Routes the vehicle-positions fetch has (or will have) landed in the store. */
let mockFeedRoutes: Record<string, any> = {}
/** Every routeId getVehiclePositionsForRoute was asked for, in order. */
let mockPolledRoutes: string[] = []
/** Vehicles the poll itself lands, keyed by route — the refresh on the tap. */
let mockPollLands: Record<string, any[]> = {}

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getVehiclePositionsForRoute: jest.fn(
    (routeId: string) => () =>
      Promise.resolve().then(() => {
        mockPolledRoutes.push(routeId)
        if (mockPollLands[routeId]) {
          mockFeedRoutes[routeId] = { vehicles: mockPollLands[routeId] }
        }
      })
  )
}))

const makeStore = (
  overrides: any = {},
  fix: { latitude: number; longitude: number; speed: number } | null = TAP_1124
) => {
  let goModeState: any = {
    ...initial,
    activeItinerary: itinerary(),
    isActive: true,
    // Leg 0: the bike leg the rider never rode, which is the whole bug.
    routeMatch: { legIndex: 0 },
    tracking: fix
      ? {
          ...initial.tracking,
          lastPosition: {
            coords: { accuracy: 4.5, heading: 271, ...fix },
            timestamp: 1789317384000
          }
        }
      : initial.tracking,
    ...overrides
  }
  const actions: any[] = []
  /** goMode state as it stood the moment each action was reduced. */
  const snapshots: Record<string, any> = {}
  const getState = () => ({
    otp: {
      config: {},
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: mockFeedRoutes, stops: {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    goModeState = goMode(goModeState, action)
    snapshots[action.type] = goModeState
    return action
  }
  return {
    at: (type: string) => snapshots[type],
    getGoMode: () => goModeState,
    run: (thunk: any) => thunk(dispatch, getState),
    types: () => actions.map((a) => a.type)
  }
}

beforeEach(() => {
  mockFeedRoutes = {}
  mockPolledRoutes = []
  mockPollLands = {}
})

describe('the tap searches the route the rider chose (2026-09-13)', () => {
  it('lists the train from the feed the app was already polling', async () => {
    // What the store held at 11:36:24: the access-leg poll's 1:902 response.
    mockFeedRoutes = { '1:902': { vehicles: [TRAIN_32141] } }
    const store = makeStore()

    await store.run(confirmBoardingByRider())

    expect(mockPolledRoutes).toEqual(['1:902'])
    const nearby = store.getGoMode().vehicleMatch.nearbyVehicles
    expect(nearby.map((v: any) => v.vehicleId)).toEqual(['1:32141'])
    // 635 m behind the rider: the frame is a minute stale and they are doing
    // 15 m/s away from it. speedAdjustedRadius(750, 15.2) = 1435 m.
    expect(Math.round(nearby[0].distanceMeters)).toBeGreaterThan(600)
    expect(Math.round(nearby[0].distanceMeters)).toBeLessThan(700)
    // The rider reads a route name, not a fleet number: feed records carry
    // neither, so the leg they picked supplies it.
    expect(nearby[0].routeName).toBe('METRO Green Line')
    expect(nearby[0].tripId).toBe('1:879781')
  })

  it('still lists it at the platform dwell, where the matcher radius would not', async () => {
    // 11:36:37, the second tap: the rider has stopped at Victoria St (3.96 m/s
    // and falling) and the frame is the same stale one, 749 m back. The
    // matcher's own base (200 m) gives 378 m and drops it; the picker's 750
    // gives 928 m and keeps it.
    mockFeedRoutes = { '1:902': { vehicles: [TRAIN_32141] } }
    const store = makeStore({}, TAP_1137)

    await store.run(confirmBoardingByRider())

    const nearby = store.getGoMode().vehicleMatch.nearbyVehicles
    expect(nearby.map((v: any) => v.vehicleId)).toEqual(['1:32141'])
    expect(Math.round(nearby[0].distanceMeters)).toBeGreaterThan(700)
    expect(Math.round(nearby[0].distanceMeters)).toBeLessThan(800)
  })

  it('re-polls the route on the tap rather than trusting a 20 s old store', async () => {
    // The tap can land just before the next access-leg poll; the store was
    // empty and the refresh is what puts the train in the list.
    mockPollLands = { '1:902': [TRAIN_32141] }
    const store = makeStore()

    await store.run(confirmBoardingByRider())

    expect(mockPolledRoutes).toEqual(['1:902'])
    expect(
      store.getGoMode().vehicleMatch.nearbyVehicles.map((v: any) => v.vehicleId)
    ).toEqual(['1:32141'])
  })

  it('keeps the rider to their own route and never widens the search', async () => {
    // A bus of another route sitting on top of the rider is not an answer to
    // "am I on MY bus" — only the itinerary's next transit route is polled or
    // compared (feedback_no_forced_route_changes).
    mockFeedRoutes = {
      '1:902': { vehicles: [TRAIN_32141] },
      '1:921': {
        vehicles: [
          {
            label: '9101',
            lat: 44.95579,
            lon: -93.13634,
            routeId: '1:921',
            seconds: 1789317384,
            tripId: '1:other',
            vehicleId: '1:9101'
          }
        ]
      }
    }
    const store = makeStore()

    await store.run(confirmBoardingByRider())

    expect(mockPolledRoutes).toEqual(['1:902'])
    expect(
      store.getGoMode().vehicleMatch.nearbyVehicles.map((v: any) => v.vehicleId)
    ).toEqual(['1:32141'])
  })

  it('searches from one leg on after an early alight', async () => {
    // 8.11: the matcher still sits on the transit leg the rider stepped off,
    // so the boarding to search for is the NEXT one.
    const legs = [
      { mode: 'BUS', routeId: '1:921', transitLeg: true },
      { mode: 'WALK', transitLeg: false },
      { mode: 'TRAM', routeId: '1:902', transitLeg: true }
    ]
    const store = makeStore({
      activeItinerary: { duration: 0, endTime: 0, legs, startTime: 0 },
      earlyAlight: { legIndex: 0 },
      routeMatch: { legIndex: 0 }
    })

    await store.run(searchBoardingVehicles())

    expect(mockPolledRoutes).toEqual(['1:902'])
  })
})

describe('the sheet says it is looking, not that there is nothing', () => {
  it('opens in the searching state and settles once a poll is compared', async () => {
    mockFeedRoutes = { '1:902': { vehicles: [TRAIN_32141] } }
    const store = makeStore()

    const pending = store.run(confirmBoardingByRider())

    // Synchronously with the tap: the sheet is up and it is looking.
    expect(store.getGoMode().boardingPrompt.shown).toBe(true)
    expect(store.getGoMode().boardingPrompt.searching).toBe(true)
    expect(store.at('SHOW_BOARDING_PROMPT').boardingPrompt.searching).toBe(true)

    await pending

    expect(store.getGoMode().boardingPrompt.searching).toBe(false)
    expect(store.types()).toEqual([
      'SET_BOARDING_SEARCHING',
      // The verdict this run owns: the last search's failure, cleared before
      // this one can be blamed for it (17.5).
      'SET_BOARDING_SEARCH_FAILED',
      'SHOW_BOARDING_PROMPT',
      'UPDATE_NEARBY_VEHICLES',
      'SET_BOARDING_SEARCHING'
    ])
  })

  it('stops looking when the feed fetch fails, rather than spinning for ever', async () => {
    const apiV2 = jest.requireMock('../../../lib/actions/apiV2')
    apiV2.getVehiclePositionsForRoute.mockImplementationOnce(
      () => () => Promise.reject(new Error('Load failed'))
    )
    const store = makeStore()

    await store.run(confirmBoardingByRider())

    expect(store.getGoMode().boardingPrompt.searching).toBe(false)
    // Nothing was compared, so nothing was asserted about what is nearby.
    expect(store.types()).not.toContain('UPDATE_NEARBY_VEHICLES')
    // And the sheet can now say WHY it has nothing, instead of reporting an
    // empty street (17.5).
    expect(store.getGoMode().boardingPrompt.searchFailed).toBe(true)
  })

  it('asserts nothing about nearby buses with no position fix', async () => {
    mockFeedRoutes = { '1:902': { vehicles: [TRAIN_32141] } }
    const store = makeStore({}, null)

    await store.run(confirmBoardingByRider())

    expect(store.getGoMode().vehicleMatch.nearbyVehicles).toEqual([])
    expect(store.types()).not.toContain('UPDATE_NEARBY_VEHICLES')
    expect(store.getGoMode().boardingPrompt.searching).toBe(false)
  })

  it('shows the looking body until a poll has been compared', () => {
    // "No buses detected nearby" is a finding. Before a comparison the sheet
    // has no finding to report — and the manual route picker waits too.
    expect(
      boardingPromptBody({
        nearbyRouteCount: 3,
        nearbyVehicleCount: 0,
        searching: true
      })
    ).toBe('searching')
    expect(
      boardingPromptBody({
        nearbyRouteCount: 0,
        nearbyVehicleCount: 0,
        searching: true
      })
    ).toBe('searching')
    // Compared, and it really did find nothing.
    expect(
      boardingPromptBody({
        nearbyRouteCount: 0,
        nearbyVehicleCount: 0,
        searching: false
      })
    ).toBe('none')
    expect(
      boardingPromptBody({
        nearbyRouteCount: 2,
        nearbyVehicleCount: 0,
        searching: false
      })
    ).toBe('routes')
    // A vehicle outranks both, searching or not.
    expect(
      boardingPromptBody({
        nearbyRouteCount: 2,
        nearbyVehicleCount: 1,
        searching: true
      })
    ).toBe('vehicles')
  })
})
