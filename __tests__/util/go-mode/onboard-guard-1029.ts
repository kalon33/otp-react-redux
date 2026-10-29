/* globals afterEach, beforeEach, describe, expect, it, jest */
import { encode } from '@mapbox/polyline'

import {
  denyOnboardVehicle,
  loadOnboardScheduleAndOptimize,
  planFromOnboardBus,
  startGoMode,
  stopGoMode
} from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan, findTrip } from '../../../lib/actions/apiV2'
import { getDownstreamStops } from '../../../lib/util/go-mode/alight-optimizer'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findRoutesNearby: jest.fn(() => () => Promise.resolve({})),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

// The picker a denial reopens asks the sidecar first: unreachable here, so
// discovery takes its stop-radius fallback (findRoutesNearby, above).
jest.mock('../../../lib/util/go-mode/onboard-discovery', () => ({
  ...jest.requireActual('../../../lib/util/go-mode/onboard-discovery'),
  fetchOnboardContext: jest.fn(() => Promise.resolve(null))
}))

/**
 * Orange Line trip 1:1270445 as findTrip stores it — backlog 75.8's own run
 * (verify agent V7, sim stack, 2026-10-29 00:20:28), read back from the same
 * desktop OTP the probe ran against.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ORANGE_1270445: any = require('../../test-utils/mock-data/onboard-anchor-1270445.json')

/** Vehicle 1:8145 — and the rider aboard it — at 00:20:28. */
const RIDER_V7 = { lat: 44.9648819, lon: -93.2697067 }
const MARQUETTE_11TH = '1:53301' // idx 4: 880 m BEHIND the bus
const LAKE_ST = '1:17781' // idx 5: 1907 m ahead, the feed's own next stop
/** Somewhere south along the run, so stops on both sides are worth asking. */
const DEST = { lat: 44.88, lon: -93.29, name: 'Destination' }

const initial = goMode(undefined, { type: '@@INIT' })

/** A deferred the test resolves by hand: the "plans still settling" window. */
function deferred<T>() {
  let settle!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: settle }
}

/** An onward plan that starts after the bus reaches its stop. */
const onward = (minutesFromNow: number) => ({
  duration: 900,
  endTime: Date.now() + (minutesFromNow + 15) * 60000,
  legs: [
    {
      distance: 3970,
      from: { lat: 44.92, lon: -93.27, name: 'Alight stop' },
      mode: 'BICYCLE',
      to: { lat: DEST.lat, lon: DEST.lon, name: DEST.name },
      transitLeg: false
    }
  ],
  startTime: Date.now() + minutesFromNow * 60000,
  transfers: 0,
  walkDistance: 0
})

/** The real reducer behind a hand dispatcher, like onboard-settle-0831. */
function makeStore(goModeOverrides: any = {}) {
  let state: any = {
    ...initial,
    isActive: true,
    ...goModeOverrides
  }
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: {
        homeTimezone: 'America/Chicago',
        itinerary: { onboardAnchorWaitMs: 50, onboardSettleMs: 200 }
      },
      currentQuery: { to: DEST },
      goMode: state,
      transitIndex: {
        routes: {},
        trips: { [ORANGE_1270445.id]: ORANGE_1270445 }
      }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    state = goMode(state, action)
    return action
  }
  return {
    actions,
    dispatch,
    getGoMode: () => state,
    /** Action types dispatched after the one at `fromIndex`. */
    typesSince: (fromIndex: number) =>
      actions.slice(fromIndex).map((a) => a.type)
  }
}

/** The bus the remembered-riding path adopts: nextStopId null on purpose. */
const RIDING_VEHICLE = {
  label: 'Orange',
  nextStopId: null,
  routeId: '1:904',
  tripId: ORANGE_1270445.id,
  vehicleId: '1:8145'
}

const RIDING_FACT = {
  boardedAt: Date.now() - 5 * 60000,
  headsign: 'ORANGE Burnsville',
  legIndex: -1,
  offRouteSince: null,
  routeId: '1:904',
  routeShortName: 'Orange',
  tripId: ORANGE_1270445.id,
  vehicleId: '1:8145'
}

const FIX_V7 = {
  coords: {
    accuracy: 10,
    latitude: RIDER_V7.lat,
    longitude: RIDER_V7.lon
  },
  timestamp: Date.now()
}

/**
 * Backlog 75.9 — the onboard list's final SET_ONBOARD_RESULT was written
 * with no "is this still my run" check, unlike the late re-rank beside it.
 */
describe('75.9: a get-off list that settles after the rider moved on', () => {
  const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
  const mockedFindTrip = findTrip as jest.Mock

  /** Every candidate plan waits on one hand-resolved promise. */
  const holdPlans = () => {
    const gate = deferred<void>()
    mockedFetch.mockImplementation(
      () => () =>
        gate.promise.then(() => ({ error: false, itineraries: [onward(10)] }))
    )
    return gate
  }

  /** The optimize is in flight once START_ONBOARD_OPTIMIZE has gone out. */
  const optimizeStarted = async (store: ReturnType<typeof makeStore>) => {
    for (let i = 0; i < 50; i++) {
      if (store.actions.some((a) => a.type === 'START_ONBOARD_OPTIMIZE')) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('the optimize never started')
  }

  beforeEach(() => {
    mockedFetch.mockReset()
    mockedFindTrip.mockReset()
    mockedFindTrip.mockImplementation(() => () => Promise.resolve({}))
  })

  it('"Not this one" while the list is loading: the denied bus\'s list does not come back', async () => {
    const store = makeStore({
      onboard: {
        ...initial.onboard,
        status: 'fetching-schedule',
        trip: ORANGE_1270445,
        vehicle: { ...RIDING_VEHICLE, nextStopId: LAKE_ST }
      },
      riding: RIDING_FACT
    })
    const gate = holdPlans()
    const run = store.dispatch(planFromOnboardBus())
    await optimizeStarted(store)
    expect(store.getGoMode().onboard.status).toBe('optimizing')

    // AlightRecommendation shows "Not this one" beside the assumed bus while
    // the status is 'optimizing' (15.3).
    store.dispatch(denyOnboardVehicle())
    const atDeny = store.actions.length
    expect(store.getGoMode().onboard.status).toBe('discovering')

    gate.resolve()
    await run

    // FAILS BEFORE: SET_ONBOARD_RESULT lands after the deny and puts the
    // rejected bus's get-off list ('ready') back over the picker.
    expect(store.typesSince(atDeny)).not.toContain('SET_ONBOARD_RESULT')
    const onboard = store.getGoMode().onboard
    expect(onboard.status).toBe('discovering')
    expect(onboard.alightOptions).toEqual([])
    expect(onboard.vehicle).toBeNull()

    store.dispatch(stopGoMode()) // lets discovery's retry timer stand down
  })

  it('Back while the list is loading: Go Mode stays stopped with no onboard status', async () => {
    const store = makeStore({
      onboard: {
        ...initial.onboard,
        status: 'fetching-schedule',
        trip: ORANGE_1270445,
        vehicle: { ...RIDING_VEHICLE, nextStopId: LAKE_ST }
      },
      riding: RIDING_FACT
    })
    const gate = holdPlans()
    const run = store.dispatch(planFromOnboardBus())
    await optimizeStarted(store)

    // GoModeScreen's back → handleOnboardExit → endGoMode → STOP_GO_MODE.
    store.dispatch(stopGoMode())
    const atStop = store.actions.length
    gate.resolve()
    await run

    // FAILS BEFORE: 'ready' on a stopped Go Mode — the next Start Trip
    // opens on "On the bus" and this list.
    expect(store.typesSince(atStop)).not.toContain('SET_ONBOARD_RESULT')
    expect(store.getGoMode().isActive).toBe(false)
    expect(store.getGoMode().onboard.status).toBe('idle')
  })

  it('Back during the trip lookup: nothing is written after the Stop', async () => {
    const store = makeStore({
      onboard: {
        ...initial.onboard,
        status: 'fetching-schedule',
        vehicle: RIDING_VEHICLE
      },
      riding: RIDING_FACT,
      tracking: { ...initial.tracking, lastPosition: FIX_V7 }
    })
    const lookup = deferred<any>()
    mockedFindTrip.mockImplementation(() => () => lookup.promise)
    mockedFetch.mockImplementation(
      () => () => Promise.resolve({ error: false, itineraries: [onward(10)] })
    )
    const run = store.dispatch(
      loadOnboardScheduleAndOptimize(ORANGE_1270445.id)
    )
    store.dispatch(stopGoMode())
    const atStop = store.actions.length
    lookup.resolve({})
    await run

    // FAILS BEFORE: SET_ONBOARD_TRIP lands on the stopped slice and the flow
    // runs on to setOnboardResult(null) — status 'error', the error card the
    // next Start Trip opens on.
    expect(store.typesSince(atStop)).toEqual([])
    expect(store.getGoMode().onboard.status).toBe('idle')
    expect(store.getGoMode().onboard.trip).toBeNull()
  })

  it('"Not this one" during the trip lookup: the denied bus is not optimized over the picker', async () => {
    const store = makeStore({
      onboard: {
        ...initial.onboard,
        status: 'fetching-schedule',
        vehicle: RIDING_VEHICLE
      },
      riding: RIDING_FACT,
      tracking: { ...initial.tracking, lastPosition: FIX_V7 }
    })
    const lookup = deferred<any>()
    mockedFindTrip.mockImplementation(() => () => lookup.promise)
    mockedFetch.mockImplementation(
      () => () => Promise.resolve({ error: false, itineraries: [onward(10)] })
    )
    const run = store.dispatch(
      loadOnboardScheduleAndOptimize(ORANGE_1270445.id)
    )
    store.dispatch(denyOnboardVehicle())
    const atDeny = store.actions.length
    lookup.resolve({})
    await run

    // FAILS BEFORE: START_ONBOARD_OPTIMIZE then SET_ONBOARD_RESULT — the
    // picker the rider asked for is replaced by the rejected bus's list.
    const after = store.typesSince(atDeny)
    expect(after).not.toContain('START_ONBOARD_OPTIMIZE')
    expect(after).not.toContain('SET_ONBOARD_RESULT')
    expect(after).not.toContain('SET_ONBOARD_TRIP')
    expect(store.getGoMode().onboard.status).not.toBe('optimizing')
    expect(store.getGoMode().onboard.status).not.toBe('ready')

    store.dispatch(stopGoMode())
  })

  it('a list still on screen is written exactly as before', async () => {
    const store = makeStore({
      onboard: {
        ...initial.onboard,
        status: 'fetching-schedule',
        trip: ORANGE_1270445,
        vehicle: { ...RIDING_VEHICLE, nextStopId: LAKE_ST }
      },
      riding: RIDING_FACT
    })
    mockedFetch.mockImplementation(
      () => () => Promise.resolve({ error: false, itineraries: [onward(10)] })
    )
    await store.dispatch(planFromOnboardBus())
    expect(store.actions.map((a) => a.type)).toContain('SET_ONBOARD_RESULT')
    expect(store.getGoMode().onboard.status).toBe('ready')
    expect(store.getGoMode().onboard.alightOptions.length).toBeGreaterThan(0)
  })
})

describe('75.9: START_GO_MODE starts a trip with no onboard panel', () => {
  const staleOnboard = {
    ...initial.onboard,
    alightOptions: [{ stopId: LAKE_ST } as any],
    bestAlightStop: { stopId: LAKE_ST } as any,
    status: 'ready' as const,
    trip: ORANGE_1270445
  }
  const itinerary: any = { legs: [], startTime: Date.now() }

  it('a Start Trip after a stopped onboard flow opens on the trip, not "On the bus"', () => {
    // What the late result used to leave behind after Back (above).
    const stopped = { ...initial, isActive: false, onboard: staleOnboard }
    const next = goMode(stopped as any, startGoMode({ itinerary }))
    // FAILS BEFORE: START_GO_MODE spread ...state and never named onboard,
    // so GoModeScreen's `onboard.status !== 'idle'` rendered the old list.
    expect(next.onboard).toEqual(initial.onboard)
  })

  it('a new trip started over a live one resets it too', () => {
    const live = { ...initial, isActive: true, onboard: staleOnboard }
    const next = goMode(live as any, startGoMode({ itinerary, newTrip: true }))
    expect(next.onboard).toEqual(initial.onboard)
  })

  it('a swap within the trip keeps the aboard list the rider is looking at', () => {
    // replanFromAboard's explicit path puts the onboard UI over a live trip;
    // a quiet re-plan swapping the itinerary underneath must not close it.
    const live = { ...initial, isActive: true, onboard: staleOnboard }
    const next = goMode(live as any, startGoMode({ itinerary }))
    expect(next.onboard).toBe(staleOnboard)
  })
})

/**
 * Backlog 75.8 — the onboard anchor with no nextStopId (the remembered-
 * vehicle path nulls it on purpose) was the stop NEAREST the rider, which is
 * the one the bus has just passed whenever it is beyond the midpoint.
 */
describe('75.8: the onboard anchor is the next stop AHEAD, never the one just passed', () => {
  const NOW = Date.now()

  describe('the recorded run (Orange 1:1270445, 2026-10-29 00:20:28)', () => {
    it('anchors at I-35W & Lake St, not Marquette & 11th 880 m behind', () => {
      const down = getDownstreamStops(
        ORANGE_1270445,
        { nextStopId: null },
        RIDER_V7,
        DEST,
        NOW
      )
      // FAILS BEFORE: down[0] is 1:53301, the stop the bus passed at 00:18.
      expect(down[0].stop.id).toBe(LAKE_ST)
      expect(down.map((d) => d.stop.id)).not.toContain(MARQUETTE_11TH)
    })

    it('without the trip shape, by stop order alone', () => {
      const shapeless = { ...ORANGE_1270445, geometry: undefined }
      const down = getDownstreamStops(
        shapeless,
        { nextStopId: null },
        RIDER_V7,
        DEST,
        NOW
      )
      expect(down[0].stop.id).toBe(LAKE_ST)
    })

    it('the optimize asks no stop behind the bus', async () => {
      const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
      mockedFetch.mockReset()
      mockedFetch.mockImplementation(
        () => () => Promise.resolve({ error: false, itineraries: [onward(10)] })
      )
      const store = makeStore({
        onboard: {
          ...initial.onboard,
          status: 'fetching-schedule',
          trip: ORANGE_1270445,
          vehicle: RIDING_VEHICLE
        },
        riding: RIDING_FACT,
        tracking: { ...initial.tracking, lastPosition: FIX_V7 }
      })
      await store.dispatch(planFromOnboardBus())
      const started = store.actions.find(
        (a) => a.type === 'START_ONBOARD_OPTIMIZE'
      )
      const asked = started.payload.candidates.map((c: any) => c.stopId)
      // FAILS BEFORE: the first candidate — "the very next stop as an
      // early-exit option" — is Marquette & 11th.
      expect(asked[0]).toBe(LAKE_ST)
      expect(asked).not.toContain(MARQUETTE_11TH)
    })
  })

  describe('a straight run, stops 500 m apart heading north', () => {
    // Stop k at k * 500 m north of the origin; the trip runs 1 → 8.
    const LAT0 = 44.9
    const LON = -93.27
    const M_PER_DEG = 111_320
    const latAt = (m: number) => LAT0 + m / M_PER_DEG
    const stops = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({
      scheduledArrival: 3600 + k * 60,
      scheduledDeparture: 3600 + k * 60,
      serviceDay: 0,
      stop: { id: `s${k}`, lat: latAt(k * 500), lon: LON, name: `Stop ${k}` }
    }))
    const shape: [number, number][] = [
      [latAt(400), LON],
      [latAt(4100), LON]
    ]
    const withShape = {
      geometry: { length: 2, points: encode(shape) },
      id: 't',
      stopTimes: stops
    }
    const withoutShape = { id: 't', stopTimes: stops }
    const north = { lat: latAt(6000), lon: LON }
    const at = (m: number) => ({ lat: latAt(m), lon: LON })
    const anchor = (trip: any, metres: number) =>
      getDownstreamStops(trip, null, at(metres), north, NOW)[0]?.stop.id

    it.each([
      ['with the trip shape', withShape],
      ['without it', withoutShape]
    ])(
      'between stop 5 and stop 6, nearer 5: the anchor is stop 6 (%s)',
      (_label, trip) => {
        // 200 m past stop 5 (2500 m), 300 m short of stop 6 (3000 m).
        // FAILS BEFORE: 's5', the nearer stop, which the bus has left.
        expect(anchor(trip, 2700)).toBe('s6')
      }
    )

    it.each([
      ['with the trip shape', withShape],
      ['without it', withoutShape]
    ])(
      'still short of the nearest stop, or dwelling at it: that stop (%s)',
      (_label, trip) => {
        expect(anchor(trip, 2300)).toBe('s5') // 200 m before stop 5
        expect(anchor(trip, 2510)).toBe('s5') // 10 m past: at the stop
      }
    )

    it('past the last stop: the last stop (nothing after it to move to)', () => {
      expect(anchor(withShape, 4050)).toBe('s8')
      expect(anchor(withoutShape, 4050)).toBe('s8')
    })

    it('a reported nextStopId still wins over the fix', () => {
      expect(
        getDownstreamStops(
          withShape,
          { nextStopId: 's5' },
          at(2700),
          north,
          NOW
        )[0].stop.id
      ).toBe('s5')
    })
  })
})
