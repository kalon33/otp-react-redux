import {
  boardingPromptBody,
  knownAboardVehicle
} from '../../../lib/util/go-mode/boarding-confirmation'
import {
  confirmVehicleSelection,
  denyOnboardVehicle,
  discoverNearbyVehicles,
  dismissOnboardPicker,
  retryBoardingSearch
} from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'

/**
 * The 2026-09-15 Orange Line ride, session mu346i5y-ng2uqc (backlog 17.4, 17.5).
 *
 * Every timestamp, id and coordinate below is lifted from
 * ~/otp-debug-logs/debug-2026-09-15.jsonl.
 *
 * What happened. The rider was aboard Orange Line trip 1:1346665, vehicle
 * 1:8140 — confirmed match 16 m away, on route, riding set since 15:36:27 —
 * and tapped their own reroute at 15:46:02 (`START_REROUTE {autoApply: false,
 * reason: "rider-reroute", keepRouteId: "1:902"}`). Production OTP was timing
 * out (17.8), so all five candidate plans failed and the optimizer settled
 * `setOnboardResult(null)` at 15:46:14, which the reducer turns into
 * `status: 'error'`. That put up AlightRecommendation's error card, whose
 * "Choose bus" is wired to `denyOnboardVehicle`. Eight seconds later the rider
 * tapped it:
 *
 *   15:46:22.706 CLEAR_RIDING
 *   15:46:22.707 CLEAR_VEHICLE_MATCH
 *   15:46:22.708 DISMISS_BOARDING_PROMPT
 *   15:46:22.709 SET_ONBOARD_STATUS "discovering"
 *   15:46:22.710 CLEAR_VEHICLE_MATCH
 *
 * Five actions in 4 ms — the exact signature of denyBoardingByRider() +
 * rediscoverOnboardVehicles(), and of nothing else in the file. (The position
 * tick's clear is a bare `clearRiding()` with no companions, and at that
 * moment it had a confirmed match 16 m away on an on-route fix, so
 * `decideRiding` could not have returned 'clear' anyway.)
 *
 * At 15:46:42 the rider typed "Why'd you lose my bus??". The picker came up at
 * 15:46:43 with vehicle 8140 in it, they tapped it at 15:46:49 — and nothing
 * happened at all: CONFIRM_VEHICLE hid the sheet and the onboard branch of
 * confirmVehicleSelection was gated on `!activeItinerary`, which was false
 * (19 UPDATE_PROGRESS ticks ran between 15:46:49 and 15:47:11). They sat on an
 * empty "Which bus are you on? Pick it below." for 36 s — the 15:47:25
 * screenshot — until the app relaunched itself.
 */

const initial = goMode(undefined, { type: '@@INIT' })

/** Vehicle 8140's confirmed match as UPDATE_VEHICLE_MATCH carried it at 15:45:58. */
const MATCH_8140 = {
  confidence: 'confirmed' as const,
  distanceMeters: 19,
  label: 'ORANGE Downtown Minneapolis',
  lastSeen: 1789505102000,
  nextStopId: '1:48084',
  routeId: '1:904',
  tripId: '1:1346665',
  vehicleId: '1:8140'
}

/** SET_RIDING's payload at 15:46:25. */
const RIDING_8140 = {
  boardedAt: 1789505185044,
  headsign: 'ORANGE Downtown Minneapolis',
  legIndex: 0,
  offRouteSince: null,
  routeId: '1:904',
  routeShortName: null,
  tripId: '1:1346665',
  vehicleId: '1:8140'
}

/** SET_ONBOARD_VEHICLE's payload at 15:46:02. */
const ONBOARD_8140 = {
  label: 'ORANGE Downtown Minneapolis',
  nextStopId: '1:48084',
  routeId: '1:904',
  tripId: '1:1346665',
  vehicleId: '1:8140'
}

/** The nearby frame the picker listed at 15:46:23 (distance 151.69 m). */
const NEARBY_8140 = {
  distanceMeters: 151.69489399947233,
  heading: 19,
  label: '8140',
  nextStopId: '1:48084',
  nextStopName: 'I-35W & 66th St Station',
  routeId: '1:904',
  speed: 2,
  tripHeadsign: 'ORANGE Downtown Minneapolis',
  tripId: '1:1346665',
  vehicleId: '1:8140'
}

/** The rider's fix at 15:46:22 (44.86543, -93.30193 in the report). */
const FIX = {
  coords: {
    accuracy: 4.03,
    heading: 23.7,
    latitude: 44.86543386304891,
    longitude: -93.30221523902479,
    speed: 1.88
  },
  timestamp: 1789505182000
}

/** The live itinerary: leg 0 IS the boarded Orange Line trip. */
const itinerary = () => ({
  duration: 2439.981,
  endTime: 1789507713000,
  legs: [
    {
      mode: 'BUS',
      routeId: '1:904',
      routeLongName: 'METRO Orange Line',
      to: { lat: 44.977502, lon: -93.267844, name: '2nd Ave S & 5th St' },
      transitLeg: true,
      trip: { gtfsId: '1:1346665' }
    },
    {
      mode: 'WALK',
      to: { lat: 44.97207, lon: -93.208231, name: 'Safelite AutoGlass' },
      transitLeg: false
    }
  ],
  startTime: 1789504587000
})

/** Whether the onboard-discovery sidecar answers, and what the OTP poll does. */
let mockContextRoutes: any = null
let mockPollResult: any = null
let mockPolled: string[] = []

jest.mock('../../../lib/util/go-mode/onboard-discovery', () => ({
  ...jest.requireActual('../../../lib/util/go-mode/onboard-discovery'),
  fetchOnboardContext: jest.fn(() =>
    Promise.resolve(
      mockContextRoutes
        ? { routes: mockContextRoutes, vehicleDetails: {} }
        : null
    )
  )
}))

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  findRoutesNearby: jest.fn(() => () => Promise.resolve({})),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getVehiclePositionsForRoute: jest.fn(
    (routeId: string) => () =>
      Promise.resolve().then(() => {
        mockPolled.push(routeId)
        return mockPollResult
      })
  )
}))

const makeStore = (overrides: any = {}) => {
  let goModeState: any = {
    ...initial,
    activeItinerary: itinerary(),
    isActive: true,
    riding: RIDING_8140,
    routeMatch: { legIndex: 0 },
    tracking: { ...initial.tracking, lastPosition: FIX },
    vehicleMatch: { ...initial.vehicleMatch, match: MATCH_8140 },
    ...overrides
  }
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: {},
      currentQuery: { to: { lat: 44.97207, lon: -93.208231 } },
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {}, trips: {} }
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

const onboard = (status: string, extra: any = {}) => ({
  onboard: {
    ...initial.onboard,
    status,
    vehicle: ONBOARD_8140,
    ...extra
  }
})

beforeEach(() => {
  mockContextRoutes = null
  mockPollResult = undefined
  mockPolled = []
})

describe("17.4 the rider's own re-search must not clear the riding fact", () => {
  it('keeps riding and the confirmed match when the search FAILED', async () => {
    // FAILS BEFORE: CLEAR_RIDING + CLEAR_VEHICLE_MATCH, exactly as at
    // 15:46:22.706 — on a bus the rider had never contradicted.
    const store = makeStore(onboard('error'))

    await store.run(denyOnboardVehicle())

    expect(store.types()).not.toContain('CLEAR_RIDING')
    expect(store.types()).not.toContain('CLEAR_VEHICLE_MATCH')
    expect(store.getGoMode().riding).toEqual(RIDING_8140)
    expect(store.getGoMode().vehicleMatch.match).toEqual(MATCH_8140)
    // It is still a re-search: the picker reopens.
    expect(store.types()).toContain('SET_ONBOARD_STATUS')
    expect(store.getGoMode().onboard.status).not.toBe('error')
  })

  it('sets no denial hold, so the board gate is not held off either', async () => {
    const store = makeStore(onboard('error'))

    await store.run(denyOnboardVehicle())

    // denyBoardingByRider stamps session.riderDeniedBoardingAtMs, whose only
    // rider-visible effect is suppressing an evidence-free re-establishment.
    // Its proxy here: the deny path's own actions never ran.
    expect(store.types()).not.toContain('DISMISS_BOARDING_PROMPT')
  })

  it('still denies from the assumed-vehicle badge (15.3 / 6.10c intact)', async () => {
    // "Not this one" beside "Finding the best stop to get off…" is the rider
    // contradicting the app, and that must keep dropping the riding fact.
    const store = makeStore(onboard('optimizing'))

    await store.run(denyOnboardVehicle())

    expect(store.types()).toContain('CLEAR_RIDING')
    expect(store.getGoMode().riding).toBeNull()
  })

  it('still denies from "Change bus" under the ranked options', async () => {
    const store = makeStore(onboard('ready'))

    await store.run(denyOnboardVehicle())

    expect(store.types()).toContain('CLEAR_RIDING')
    expect(store.getGoMode().riding).toBeNull()
  })

  it('drops the rejected vehicle so the picker cannot re-offer it', async () => {
    // 15.3 from the other side: the flow's adopted vehicle used to survive a
    // rediscover, and the picker's new fallback row reads it — so a rider who
    // has just said "Not this one" would be handed that same bus back.
    const store = makeStore(onboard('optimizing'))

    await store.run(denyOnboardVehicle())

    expect(store.getGoMode().onboard.vehicle).toBeNull()
    expect(
      knownAboardVehicle({
        match: store.getGoMode().vehicleMatch.match,
        onboardVehicle: store.getGoMode().onboard.vehicle,
        riding: store.getGoMode().riding
      })
    ).toBeNull()
  })

  it('keeps it through a re-search the rider asked for', async () => {
    const store = makeStore(onboard('error'))

    await store.run(denyOnboardVehicle())

    expect(store.getGoMode().onboard.vehicle).toEqual(ONBOARD_8140)
  })

  it('retryBoardingSearch never denies inside the onboard flow', async () => {
    const store = makeStore(onboard('awaiting-selection'))

    await store.run(retryBoardingSearch())

    expect(store.types()).not.toContain('CLEAR_RIDING')
    expect(store.getGoMode().riding).toEqual(RIDING_8140)
  })
})

describe('17.5 a failing vehicle search says so instead of showing an empty list', () => {
  it('records the failure when the feed poll times out', async () => {
    mockContextRoutes = [{ id: '1:904', longName: 'METRO Orange Line' }]
    // What createQueryAction resolves with on a 20 s timeout: it dispatches the
    // error action and RESOLVES, so the await is indistinguishable from success.
    mockPollResult = {
      error: true,
      payload: new Error('Request timed out after 20000 ms'),
      type: 'REALTIME_VEHICLE_POSITIONS_ERROR'
    }
    const store = makeStore(onboard('discovering'))

    await store.run(discoverNearbyVehicles())

    expect(mockPolled).toEqual(['1:904'])
    expect(store.getGoMode().boardingPrompt.searchFailed).toBe(true)
  })

  it('does not cry outage when the feed simply has nothing on it', async () => {
    mockContextRoutes = [{ id: '1:904', longName: 'METRO Orange Line' }]
    mockPollResult = {
      payload: {},
      type: 'REALTIME_VEHICLE_POSITIONS_RESPONSE'
    }
    const store = makeStore(onboard('discovering'))

    await store.run(discoverNearbyVehicles())

    expect(store.getGoMode().boardingPrompt.searchFailed).toBe(false)
  })

  it('shows the failure body rather than "No buses detected nearby"', () => {
    // FAILS BEFORE: 'none', which the sheet renders as a statement about the
    // street ("No buses detected nearby") for a request that never returned.
    expect(
      boardingPromptBody({
        nearbyRouteCount: 0,
        nearbyVehicleCount: 0,
        searchFailed: true,
        searching: false
      })
    ).toBe('failed')
  })

  it('ranks anything real above the apology', () => {
    // A vehicle the app did get, or a route list to pick from, is worth more
    // to the rider than a failure notice about the rest of the search.
    expect(
      boardingPromptBody({
        nearbyRouteCount: 0,
        nearbyVehicleCount: 1,
        searchFailed: true,
        searching: false
      })
    ).toBe('vehicles')
    expect(
      boardingPromptBody({
        nearbyRouteCount: 2,
        nearbyVehicleCount: 0,
        searchFailed: true,
        searching: false
      })
    ).toBe('routes')
    expect(
      boardingPromptBody({
        nearbyRouteCount: 0,
        nearbyVehicleCount: 0,
        searchFailed: true,
        searching: true
      })
    ).toBe('searching')
  })
})

describe('17.5 the already-confirmed vehicle is offered as a row', () => {
  it('names the vehicle Go Mode is holding', () => {
    expect(
      knownAboardVehicle({
        match: MATCH_8140,
        onboardVehicle: null,
        riding: RIDING_8140
      })
    ).toEqual({
      label: 'ORANGE Downtown Minneapolis',
      nextStopId: '1:48084',
      routeId: '1:904',
      tripId: '1:1346665',
      vehicleId: '1:8140'
    })
  })

  it('prefers the vehicle THIS flow adopted', () => {
    expect(
      knownAboardVehicle({
        match: { ...MATCH_8140, tripId: '1:999999', vehicleId: '1:8224' },
        onboardVehicle: ONBOARD_8140
      })?.vehicleId
    ).toBe('1:8140')
  })

  it('offers nothing once the rider has got off that trip', () => {
    // The 8/9 trap: a confirmed match outlives STOP_GO_MODE by design but not
    // an alight (matchProvesAboard).
    expect(
      knownAboardVehicle({
        alightedFrom: { tripId: '1:1346665', vehicleId: '1:8140' },
        match: MATCH_8140
      })
    ).toBeNull()
  })

  it('offers nothing for a synthetic route:<id> vehicle or a tripless fact', () => {
    expect(
      knownAboardVehicle({
        riding: { ...RIDING_8140, vehicleId: 'route:1:904' }
      })
    ).toBeNull()
    expect(
      knownAboardVehicle({ riding: { ...RIDING_8140, tripId: null } })
    ).toBeNull()
  })

  it('confirms it from state when the feed holds no record for it', async () => {
    // The row's whole point: at 15:47:25 neither nearbyVehicles nor
    // transitIndex.routes had 8140 — every read was timing out — so the
    // feed-only lookup would confirm a bus with a null tripId, which the
    // onboard branch can only turn into 'error'.
    const store = makeStore(onboard('awaiting-selection'))

    await store.run(confirmVehicleSelection('1:8140'))

    const confirmed = store
      .types()
      .filter((t: string) => t === 'CONFIRM_VEHICLE')
    expect(confirmed).toHaveLength(1)
    expect(store.getGoMode().vehicleMatch.match.tripId).toBe('1:1346665')
    // FAILS BEFORE: with no feed record `selected.tripId` was undefined, so
    // the flow went straight to 'error' and never asked for a plan at all.
    // (findTrip is mocked to land nothing here, so the panel then settles to
    // 'error' honestly — that is the schedule fetch failing, not the tap.)
    expect(store.types()).toContain('START_REROUTE')
  })
})

describe('17.5 closing the picker is not a dead end', () => {
  it('returns to the live trip instead of an empty panel', async () => {
    // FAILS BEFORE: "Not yet" (and the overlay tap) dispatched
    // DISMISS_BOARDING_PROMPT alone, so onboard.status stayed
    // 'awaiting-selection' and GoModeScreen kept the onboard panel up with
    // the picker's prompt and nothing under it.
    const store = makeStore(onboard('awaiting-selection'))

    await store.run(dismissOnboardPicker())

    expect(store.types()).toContain('CLEAR_ONBOARD')
    expect(store.getGoMode().onboard.status).toBe('idle')
    // The trip underneath is untouched — that is the point of going back to it.
    expect(store.getGoMode().activeItinerary).not.toBeNull()
    expect(store.getGoMode().riding).toEqual(RIDING_8140)
  })

  it('leaves the pre-trip flow alone, where there is no trip to go back to', async () => {
    const store = makeStore({
      ...onboard('awaiting-selection'),
      activeItinerary: null
    })

    await store.run(dismissOnboardPicker())

    expect(store.types()).not.toContain('CLEAR_ONBOARD')
    expect(store.getGoMode().onboard.status).toBe('awaiting-selection')
  })
})

describe('17.5 a mid-ride tap on a bus actually does something', () => {
  it('advances the flow instead of leaving the picker prompt over an empty body', async () => {
    // FAILS BEFORE: the onboard branch was gated on `!activeItinerary`, so
    // mid-ride the tap dispatched CONFIRM_VEHICLE (which hides the sheet) and
    // nothing else. Status stayed 'awaiting-selection' — 15:46:49 to 15:47:11.
    const store = makeStore({
      ...onboard('awaiting-selection'),
      vehicleMatch: {
        ...initial.vehicleMatch,
        match: MATCH_8140,
        nearbyVehicles: [NEARBY_8140]
      }
    })

    await store.run(confirmVehicleSelection('1:8140'))

    expect(store.getGoMode().onboard.status).not.toBe('awaiting-selection')
    expect(store.getGoMode().onboard.vehicle?.tripId).toBe('1:1346665')
    // Mid-ride the continuation is replanFromAboard — the onward plan has to
    // come from the active itinerary's destination, not currentQuery.to.
    expect(store.types()).toContain('START_REROUTE')
  })

  it('settles the panel when the schedule fetch fails, rather than spinning', async () => {
    // replanFromAboard's bail used to settle reRoute only, which is invisible
    // on a panel driven entirely by onboard.status. findTrip is mocked to land
    // nothing, so the trip lookup comes back empty.
    const store = makeStore({
      ...onboard('awaiting-selection'),
      vehicleMatch: {
        ...initial.vehicleMatch,
        match: MATCH_8140,
        nearbyVehicles: [NEARBY_8140]
      }
    })

    await store.run(confirmVehicleSelection('1:8140'))

    expect(store.getGoMode().onboard.status).toBe('error')
  })

  it('keeps the pre-trip path on loadOnboardScheduleAndOptimize', async () => {
    // No itinerary yet ("I'm on the bus" from the home screen): the flow owns
    // the whole trip, and currentQuery.to IS the rider's destination.
    const store = makeStore({
      ...onboard('awaiting-selection'),
      activeItinerary: null,
      vehicleMatch: {
        ...initial.vehicleMatch,
        match: MATCH_8140,
        nearbyVehicles: [NEARBY_8140]
      }
    })

    await store.run(confirmVehicleSelection('1:8140'))

    expect(store.types()).not.toContain('START_REROUTE')
    expect(store.getGoMode().onboard.vehicle?.tripId).toBe('1:1346665')
  })
})
