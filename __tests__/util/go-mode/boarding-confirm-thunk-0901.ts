import {
  confirmBoardingByRider,
  denyBoardingByRider
} from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({}))
}))

const initial = goMode(undefined, { type: '@@INIT' })

/**
 * The trip-sheet buttons behind 6.10c, at the action level: what the rider's
 * tap actually writes.
 *
 * The point of routing the confirmation through `confirmVehicleSelection` —
 * the boarding prompt's own path — rather than minting a riding fact here is
 * that the fact then carries a real vehicle and trip id. Everything that keys
 * on `riding.tripId` (the alight optimizer, the access re-plan's aboard check,
 * the stop counter) is the reason.
 */

const itinerary = () => ({
  duration: 1800,
  endTime: 0,
  legs: [
    { mode: 'BICYCLE', transitLeg: false },
    { mode: 'BUS', routeShortName: '535', transitLeg: true }
  ],
  startTime: 0
})

const makeStore = (overrides: any = {}) => {
  let goModeState: any = {
    ...initial,
    activeItinerary: itinerary(),
    isActive: true,
    routeMatch: { legIndex: 1 },
    ...overrides
  }
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: {},
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    goModeState = goMode(goModeState, action)
    return action
  }
  return {
    getGoMode: () => goModeState,
    run: (thunk: any) => thunk(dispatch, getState),
    types: () => actions.map((a) => a.type)
  }
}

describe('the rider’s own say on boarding (2026-09-01)', () => {
  it('names the matched vehicle when the rider says they are aboard', () => {
    const store = makeStore({
      vehicleMatch: {
        ...initial.vehicleMatch,
        match: {
          confidence: 'medium',
          routeId: '1:904',
          tripId: '1:trip-orange',
          vehicleId: '1:8216'
        },
        nearbyVehicles: [
          {
            distanceMeters: 128,
            label: '8216',
            routeId: '1:904',
            tripId: '1:trip-orange',
            vehicleId: '1:8216'
          }
        ]
      }
    })
    store.run(confirmBoardingByRider())
    expect(store.types()).toEqual(['CONFIRM_VEHICLE', 'SET_RIDING'])
    // A real trip id, not a rider-shaped placeholder.
    expect(store.getGoMode().riding.tripId).toBe('1:trip-orange')
    expect(store.getGoMode().riding.vehicleId).toBe('1:8216')
    expect(store.getGoMode().vehicleMatch.match.confidence).toBe('confirmed')
  })

  it('opens the existing prompt when nothing is matched yet', () => {
    // Nothing honest to name — so the rider picks from the buses actually
    // nearby, in the sheet that already exists for exactly that.
    const store = makeStore()
    store.run(confirmBoardingByRider())
    expect(store.types()).toEqual(['SHOW_BOARDING_PROMPT'])
    expect(store.getGoMode().riding).toBeNull()
  })

  it('drops the riding fact and the match behind it on a denial', () => {
    const store = makeStore({
      riding: {
        boardedAt: 1_788_277_635_049,
        headsign: null,
        legIndex: 1,
        offRouteSince: null,
        routeId: '1:904',
        routeShortName: null,
        tripId: null,
        vehicleId: null
      },
      vehicleMatch: {
        ...initial.vehicleMatch,
        match: { confidence: 'none', vehicleId: null }
      }
    })
    store.run(denyBoardingByRider())
    expect(store.types()).toEqual([
      'CLEAR_RIDING',
      'CLEAR_VEHICLE_MATCH',
      'DISMISS_BOARDING_PROMPT'
    ])
    expect(store.getGoMode().riding).toBeNull()
    expect(store.getGoMode().vehicleMatch.match).toBeNull()
  })
})
