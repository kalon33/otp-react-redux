import {
  beginOnboardFlowAction,
  browseFromCurrentPosition,
  buildOnboardItinerary,
  replanFromAboard,
  stopGoMode,
  stopVehicleTracking
} from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan, findTrip } from '../../../lib/actions/apiV2'
import { mergeCandidateRoutes } from '../../../lib/util/go-mode/onboard-discovery-util'
import goMode from '../../../lib/reducers/go-mode'
import type { RidingState } from '../../../lib/util/go-mode/types'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  // beginGoMode pre-fetches stop times and starts vehicle tracking for a
  // transit first leg — no-op thunks keep the applied-splice tests off the
  // network.
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

const initial = goMode(undefined, { type: '@@INIT' })

const confirmedMatch = {
  confidence: 'confirmed' as const,
  distanceMeters: 120,
  label: 'Orange Burnsville',
  lastSeen: 1783882345000,
  routeId: '1:904',
  tripId: '1:1172697',
  vehicleId: '1:8141'
}

const withConfirmed = goMode(initial, {
  payload: confirmedMatch,
  type: 'CONFIRM_VEHICLE'
})

describe('onboard flow keeps what the app already knows', () => {
  it('BEGIN_ONBOARD_FLOW preserves a confirmed vehicle match', () => {
    const state = goMode(withConfirmed, beginOnboardFlowAction({}))
    expect(state.vehicleMatch.match).toEqual(
      expect.objectContaining({ confidence: 'confirmed', vehicleId: '1:8141' })
    )
    expect(state.onboard.status).toBe('discovering')
  })

  it('BEGIN_ONBOARD_FLOW still resets an unconfirmed match', () => {
    const low = goMode(initial, {
      payload: { ...confirmedMatch, confidence: 'low' },
      type: 'UPDATE_VEHICLE_MATCH'
    })
    const state = goMode(low, beginOnboardFlowAction({}))
    expect(state.vehicleMatch.match).toBeNull()
  })

  it('STOP_GO_MODE preserves a confirmed vehicle match', () => {
    // 7/12: exit at 13:56:08, re-enter at 13:56:12 — the app must not forget
    // the bus it verified four seconds earlier.
    const state = goMode(withConfirmed, stopGoMode())
    expect(state.vehicleMatch.match).toEqual(
      expect.objectContaining({ confidence: 'confirmed', vehicleId: '1:8141' })
    )
    expect(state.isActive).toBe(false)
  })

  it('STOP_GO_MODE drops an unconfirmed match with the rest of the state', () => {
    const low = goMode(initial, {
      payload: { ...confirmedMatch, confidence: 'low' },
      type: 'UPDATE_VEHICLE_MATCH'
    })
    expect(goMode(low, stopGoMode()).vehicleMatch.match).toBeNull()
  })
})

describe('mergeCandidateRoutes (position-based discovery)', () => {
  it('puts live-vehicle routes first, then shape routes, deduped, prefixed', () => {
    const vehicles = [
      {
        color: '#F68B1F',
        distanceMeters: 120,
        longName: 'METRO Orange Line',
        routeId: '904',
        textColor: '#000000'
      },
      { distanceMeters: 300, mode: 'BUS', routeId: '4', shortName: '4' },
      { distanceMeters: 500, routeId: '904' } // second Orange bus — dedupe
    ]
    const routes = [
      { distanceMeters: 17, routeId: '467', shortName: '467' },
      { distanceMeters: 17, routeId: '904' } // already known live — dedupe
    ]
    expect(mergeCandidateRoutes(vehicles, routes)).toEqual([
      {
        color: '#F68B1F',
        id: '1:904',
        longName: 'METRO Orange Line',
        mode: 'BUS',
        shortName: null,
        textColor: '#000000'
      },
      {
        color: null,
        id: '1:4',
        longName: null,
        mode: 'BUS',
        shortName: '4',
        textColor: null
      },
      {
        color: null,
        id: '1:467',
        longName: null,
        mode: 'BUS',
        shortName: '467',
        textColor: null
      }
    ])
  })

  it('works with either source missing', () => {
    expect(mergeCandidateRoutes(null, [{ routeId: '904' }])).toHaveLength(1)
    expect(mergeCandidateRoutes([{ routeId: '4' }], undefined)).toHaveLength(1)
    expect(mergeCandidateRoutes(null, null)).toEqual([])
  })

  it('skips entries without a routeId (vehicles heading to layover)', () => {
    expect(
      mergeCandidateRoutes([{ routeId: null }, { routeId: '904' }], [])
    ).toEqual([
      {
        color: null,
        id: '1:904',
        longName: null,
        mode: 'BUS',
        shortName: null,
        textColor: null
      }
    ])
  })
})

describe('replanFromAboard (mid-ride aboard-aware replan)', () => {
  const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
  const mockedFindTrip = findTrip as jest.Mock

  const TRIP_ID = '1:trip-aboard'
  // Four stops marching north; the rider sits at S2, destination near S3.
  const stop = (id: string, lat: number, name: string, dep: number) => ({
    scheduledArrival: dep,
    scheduledDeparture: dep,
    serviceDay: 0,
    stop: { code: id, id, lat, lon: -93.28, name }
  })
  const makeTripFixture = () => ({
    id: TRIP_ID,
    route: {
      id: '1:904',
      longName: 'METRO Orange Line',
      mode: 'BUS',
      shortName: 'Orange'
    },
    stopTimes: [
      stop('1:s1', 44.86, 'Knox & 76th St', 100),
      stop('1:s2', 44.9, 'Mid Stop', 400),
      stop('1:s3', 44.95, 'Near Destination', 700),
      stop('1:s4', 44.99, 'Past Destination', 1000)
    ],
    tripHeadsign: 'Downtown'
  })

  const ridingAboard: RidingState = {
    boardedAt: 1000,
    headsign: 'Downtown',
    legIndex: 0,
    offRouteSince: null,
    routeId: '1:904',
    routeShortName: 'Orange',
    tripId: TRIP_ID,
    vehicleId: 'v-1'
  }

  // The live trip whose destination the replan must keep. The bus leg carries
  // the boarded trip; the walk leg ends at the REAL destination.
  const makeItinerary = () => ({
    duration: 1800,
    endTime: 2000000,
    legs: [
      {
        from: { lat: 44.86, lon: -93.28, name: 'Knox & 76th St' },
        mode: 'BUS',
        routeId: '1:904',
        to: { lat: 44.95, lon: -93.28, name: 'Near Destination' },
        transitLeg: true,
        trip: { gtfsId: TRIP_ID },
        tripId: TRIP_ID
      },
      {
        mode: 'WALK',
        to: { lat: 44.951, lon: -93.279, name: 'Real Destination' },
        transitLeg: false
      }
    ],
    startTime: 200000,
    transfers: 0
  })

  const onwardItin = () => ({
    duration: 300,
    endTime: Date.now() + 900000,
    legs: [
      {
        from: { name: 'Near Destination' },
        mode: 'WALK',
        to: { name: 'Real Destination' },
        transitLeg: false
      }
    ],
    startTime: Date.now() + 600000,
    walkDistance: 200
  })

  const makeStore = ({
    goModeOverrides = {},
    queryTo = { lat: 10, lon: 20, name: 'Browse destination' },
    trips = {} as any
  } = {}) => {
    let goModeState: any = {
      ...initial,
      activeItinerary: makeItinerary(),
      isActive: true,
      riding: ridingAboard,
      tracking: {
        ...initial.tracking,
        lastPosition: { coords: { latitude: 44.9, longitude: -93.28 } }
      },
      ...goModeOverrides
    }
    const actions: any[] = []
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: { to: queryTo },
        goMode: goModeState,
        transitIndex: { routes: {}, trips }
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      actions.push(action)
      goModeState = goMode(goModeState, action)
      return action
    }
    return { actions, dispatch, getGoMode: () => goModeState }
  }

  beforeEach(() => {
    mockedFetch.mockReset()
    mockedFindTrip.mockReset()
    mockedFindTrip.mockReturnValue(() => Promise.resolve({}))
  })
  afterEach(() => {
    // beginGoMode starts the 15s vehicle-position poll for a transit first
    // leg — clear it so jest can exit.
    stopVehicleTracking()(() => undefined)
  })

  it('gates on the verified riding.tripId — no fact, no aboard replan', async () => {
    const noFact = makeStore({ goModeOverrides: { riding: null } })
    await noFact.dispatch(replanFromAboard({ autoApply: true }))
    const routeOnly = makeStore({
      goModeOverrides: { riding: { ...ridingAboard, tripId: null } }
    })
    await routeOnly.dispatch(replanFromAboard({ autoApply: true }))

    expect(noFact.actions).toEqual([])
    expect(routeOnly.actions).toEqual([])
    expect(mockedFindTrip).not.toHaveBeenCalled()
  })

  it('plans to the ACTIVE ITINERARY destination, not currentQuery.to', async () => {
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [onwardItin()] })
    )
    const store = makeStore({
      queryTo: { lat: 10, lon: 20, name: 'Browse destination' },
      trips: { [TRIP_ID]: makeTripFixture() }
    })
    await store.dispatch(replanFromAboard({ autoApply: true }))

    expect(mockedFetch).toHaveBeenCalled()
    // Every candidate onward plan targets the trip's real destination — a
    // mid-trip browse may have rewritten the query to somewhere else.
    mockedFetch.mock.calls.forEach(([payload]) => {
      expect(payload.to).toEqual({
        lat: 44.951,
        lon: -93.279,
        name: 'Real Destination'
      })
    })
  })

  it('autoApply splices the BOARDED bus in as leg 0 and re-confirms the vehicle', async () => {
    const trip = makeTripFixture()
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [onwardItin()] })
    )
    const store = makeStore({ trips: { [TRIP_ID]: trip } })
    await store.dispatch(
      replanFromAboard({ autoApply: true, reason: 'boarded-earlier' })
    )

    const applied = store.actions.find((a) => a.type === 'START_GO_MODE')
      ?.payload?.itinerary
    expect(applied).toBeTruthy()
    // The invariant: an aboard replan can never take the rider off their
    // line — the first leg IS the physically-boarded trip.
    expect(applied.legs[0].transitLeg).toBe(true)
    expect(applied.legs[0].tripId).toBe(TRIP_ID)
    // ...boarding at one of THAT trip's own stops.
    expect(trip.stopTimes.map((st: any) => st.stop.id)).toContain(
      applied.legs[0].from.stop.id
    )
    // Live-times anchor contract (refreshLiveLegTimes): the synthesized leg
    // must carry the ridden trip's id in BOTH shapes the anchor accepts
    // (leg.trip.gtfsId and leg.tripId) plus board/alight stop gtfsIds and
    // names for liveStopArrival's id-then-name lookup — verify-boarded-earlier
    // caught the spliced trip's overview times never re-anchoring.
    expect(applied.legs[0].trip).toEqual(
      expect.objectContaining({ gtfsId: TRIP_ID })
    )
    expect(applied.legs[0].from.stop.gtfsId).toBeTruthy()
    expect(applied.legs[0].from.name).toBeTruthy()
    expect(applied.legs[0].to.stop.gtfsId).toBeTruthy()
    expect(applied.legs[0].to.name).toBeTruthy()
    // START_GO_MODE settles the reroute bookkeeping back to idle.
    expect(store.getGoMode().reRoute.status).toBe('idle')
    // Confirmation in applyAutoReroute's style; no onboard-UI churn on the
    // automatic path (a non-idle onboard.status would replace the live trip
    // screen with the onboard panel).
    expect(
      store
        .getGoMode()
        .notifications.recentNotifications.map((n: any) => n.type)
    ).toContain('TRIP_UPDATED')
    const types = store.actions.map((a) => a.type)
    expect(types).not.toContain('BEGIN_ONBOARD_FLOW')
    expect(types).not.toContain('SET_ONBOARD_VEHICLE')
    expect(types).not.toContain('START_ONBOARD_OPTIMIZE')
    expect(store.getGoMode().onboard.status).toBe('idle')

    // The deferred re-lock lands on the next tick: same bus, confirmed.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const confirm = store.actions
      .filter((a) => a.type === 'CONFIRM_VEHICLE')
      .pop()
    expect(confirm?.payload).toEqual(
      expect.objectContaining({
        confidence: 'confirmed',
        tripId: TRIP_ID,
        vehicleId: 'v-1'
      })
    )
  })

  it('autoApply splices straight to the planned stop when the schedule serves it — no optimizer', async () => {
    // The primary auto path: the boarded trip's schedule reaches the active
    // plan's alight stop, so the splice alights exactly there and keeps the
    // plan's own onward legs — no candidate plans fetched at all.
    const trip = makeTripFixture()
    const serviceDay = Math.floor(Date.now() / 1000) - 3600
    trip.stopTimes = trip.stopTimes.map((st: any) => ({ ...st, serviceDay }))
    const itinerary = makeItinerary()
    ;(itinerary.legs[0].to as any).stop = { gtfsId: '1:s3', id: '1:s3' }
    const store = makeStore({
      goModeOverrides: { activeItinerary: itinerary },
      trips: { [TRIP_ID]: trip }
    })
    await store.dispatch(replanFromAboard({ autoApply: true }))

    const applied = store.actions.find((a) => a.type === 'START_GO_MODE')
      ?.payload?.itinerary
    expect(applied).toBeTruthy()
    expect(applied.legs[0].to.stop.id).toBe('1:s3')
    // The plan's own onward legs ride along unchanged.
    expect(applied.legs[1].mode).toBe('WALK')
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('flattens the synthesized leg like every planner leg', async () => {
    // GoModeMap reads leg.routeColor and itinerary-summary reads it too —
    // neither looks inside leg.route — so the hand-built leg drew the Orange
    // Line in default blue on 8/2.
    const trip = makeTripFixture()
    ;(trip.route as any).color = 'F68B1F'
    ;(trip.route as any).textColor = 'FFFFFF'
    ;(trip.route as any).type = 3
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [onwardItin()] })
    )
    const store = makeStore({ trips: { [TRIP_ID]: trip } })
    await store.dispatch(replanFromAboard({ autoApply: true }))

    const bus = store.actions.find((a) => a.type === 'START_GO_MODE')?.payload
      ?.itinerary?.legs[0]
    expect(bus.routeColor).toBe('F68B1F')
    expect(bus.routeTextColor).toBe('FFFFFF')
    expect(bus.routeId).toBe('1:904')
    // The converter collapses route to a shortName STRING; apiV2 restores the
    // object for transit legs, and so must this — skipping it makes the leg
    // diverge from planner-sourced legs in a way only the map shows.
    expect(typeof bus.route).toBe('object')
    expect(bus.route.color).toBe('F68B1F')
    // A synthesized leg is always first: nothing to interline with.
    expect(bus.interlineWithPreviousLeg).toBe(false)
  })

  it('never synthesizes a bus leg that arrives before it departs', async () => {
    // busLegStart is Date.now() while busArrivalEpoch can be a realtime
    // prediction already behind the clock. On 8/2 that produced legs whose
    // endTime preceded their startTime by up to 268s, and a "Trip updated —
    // arriving 9:23 PM" push sent at 9:24. An arrival that has already passed
    // is not evidence the rider has arrived.
    const trip = makeTripFixture()
    // Realtime arrivals ten minutes in the past for every stop.
    const pastDay = Math.floor(Date.now() / 1000) - 600
    trip.stopTimes = trip.stopTimes.map((st: any) => ({
      ...st,
      realtimeArrival: 0,
      realtimeState: 'UPDATED',
      serviceDay: pastDay
    }))
    const itinerary = makeItinerary()
    ;(itinerary.legs[0].to as any).stop = { gtfsId: '1:s3', id: '1:s3' }
    const store = makeStore({
      goModeOverrides: { activeItinerary: itinerary },
      trips: { [TRIP_ID]: trip }
    })
    await store.dispatch(replanFromAboard({ autoApply: true }))

    const applied = store.actions.find((a) => a.type === 'START_GO_MODE')
      ?.payload?.itinerary
    expect(applied).toBeTruthy()
    const bus = applied.legs[0]
    expect(bus.endTime).toBeGreaterThan(bus.startTime)
    expect(bus.duration).toBeGreaterThan(0)
    // ...and the container never claims to end before the bus leg does.
    expect(applied.endTime).toBeGreaterThanOrEqual(bus.endTime)
    expect(applied.duration).toBeGreaterThan(0)
    // The substitute is the remaining SCHEDULED running time (s2 -> s3 = 300s).
    expect(bus.endTime - bus.startTime).toBe(300000)
  })

  it('never starts a trip whose legs run backwards, not just leg 0 (8/9)', async () => {
    // The 8/2 guard fixed the SYNTHESIZED leg and the container. On 8/9 the
    // grafted onward legs kept the times they were planned with, so leg 1
    // started 680,170 ms before leg 0 ended and the trip sheet read 7:29 PM
    // above 7:18 PM. Assert the whole itinerary, end to end through the real
    // thunk chain.
    const trip = makeTripFixture()
    const pastDay = Math.floor(Date.now() / 1000) - 600
    trip.stopTimes = trip.stopTimes.map((st: any) => ({
      ...st,
      realtimeArrival: 0,
      realtimeState: 'UPDATED',
      serviceDay: pastDay
    }))
    const itinerary = makeItinerary()
    ;(itinerary.legs[0].to as any).stop = { gtfsId: '1:s3', id: '1:s3' }
    const store = makeStore({
      goModeOverrides: { activeItinerary: itinerary },
      trips: { [TRIP_ID]: trip }
    })
    await store.dispatch(replanFromAboard({ autoApply: true }))

    const applied = store.actions.find((a) => a.type === 'START_GO_MODE')
      ?.payload?.itinerary
    expect(applied).toBeTruthy()
    expect(applied.legs.length).toBeGreaterThan(1)
    // Only legs the fixture gives real times to — the onward stub carries none.
    const timed = applied.legs.filter(
      (l: any) =>
        Number.isFinite(Number(l.startTime)) &&
        Number.isFinite(Number(l.endTime))
    )
    expect(timed.length).toBeGreaterThan(0)
    expect(timed.filter((l: any) => l.endTime < l.startTime)).toEqual([])
    const gaps = timed
      .slice(1)
      .map((l: any, i: number) => l.startTime - timed[i].endTime)
    expect(gaps.filter((g: number) => g < 0)).toEqual([])
    expect(applied.endTime).toBeGreaterThanOrEqual(
      timed[timed.length - 1].endTime
    )
  })

  it('leaves a bus running AHEAD of schedule alone', () => {
    // The guard is for inversions only. A realtime arrival that is merely
    // earlier than the schedule is a bus running ahead — exactly the truth
    // realtime exists to tell, and substituting the schedule there would make
    // the app quietly pessimistic on every early bus.
    const trip = makeTripFixture()
    const now = Date.now()
    const ahead = now + 60000 // 60s out; the schedule says 300s
    const built: any = buildOnboardItinerary(
      trip,
      { nextStopId: '1:s2' },
      {
        busArrivalEpoch: ahead,
        itinerary: onwardItin() as any,
        stopId: '1:s3'
      },
      null
    )
    expect(built.legs[0].endTime).toBe(ahead)
  })

  it('does not swap or notify when the splice is the trip the rider is already on', async () => {
    // The 8/2 loop: nine auto-applied itineraries, all byte-identical, each
    // with its own high-priority "Trip updated" push quoting an arrival time
    // already in the past. The TRIP_UPDATED id embeds Date.now(), so the
    // reducer's id dedupe can never catch these — suppression has to happen
    // before the swap.
    const trip = makeTripFixture()
    const serviceDay = Math.floor(Date.now() / 1000) - 3600
    trip.stopTimes = trip.stopTimes.map((st: any) => ({ ...st, serviceDay }))
    const itinerary = makeItinerary()
    ;(itinerary.legs[0].to as any).stop = { gtfsId: '1:s3', id: '1:s3' }
    const store = makeStore({
      goModeOverrides: { activeItinerary: itinerary },
      trips: { [TRIP_ID]: trip }
    })
    // First pass: the splice differs from the plan (the plan boards at Knox &
    // 76th; the splice boards where the bus is now), so it applies.
    await store.dispatch(replanFromAboard({ autoApply: true }))
    expect(
      store.actions.find((a) => a.type === 'START_GO_MODE')?.payload?.itinerary
    ).toBeTruthy()

    // Second pass against the itinerary the first one produced: nothing to
    // change, so no swap and no buzz.
    const before = store.actions.length
    await store.dispatch(replanFromAboard({ autoApply: true }))
    const after = store.actions.slice(before).map((a) => a.type)
    expect(after).not.toContain('START_GO_MODE')
    expect(after).not.toContain('ADD_NOTIFICATION')
    // Settled as 'none' — retryable, so a genuine change later still lands.
    expect(store.getGoMode().reRoute.status).toBe('none')
  })

  it('autoApply keeps the planned alight stop even when a transfer ranks faster', async () => {
    // The rider's active itinerary alights at s3. Give the optimizer a (mock)
    // much-faster onward plan from s4, so its top-ranked candidate is a
    // hop-off-and-transfer — which an AUTOMATIC update must never choose when
    // the boarded trip serves the planned stop (rider's rule: auto-updates
    // don't invent route changes; verify-boarded-earlier hit a 3-minute-hop
    // splice when schedule-anchored epochs skewed the ranking).
    const trip = makeTripFixture()
    mockedFetch.mockImplementation(
      (combo: any) => () =>
        Promise.resolve({
          error: false,
          itineraries: [
            // Near-instant, walk-free onward plan from the later stop: it
            // wins rankAlightOptions' arrival scoring (busArrivalEpoch +
            // duration) and its transfers/walk tie-breaks over staying
            // aboard to the planned stop.
            combo.from.name === 'Past Destination'
              ? { ...onwardItin(), duration: 1, walkDistance: 0 }
              : onwardItin()
          ]
        })
    )
    const itinerary = makeItinerary()
    ;(itinerary.legs[0].to as any).stop = { gtfsId: '1:s3', id: '1:s3' }
    const store = makeStore({
      goModeOverrides: { activeItinerary: itinerary },
      trips: { [TRIP_ID]: trip }
    })
    await store.dispatch(replanFromAboard({ autoApply: true }))

    const applied = store.actions.find((a) => a.type === 'START_GO_MODE')
      ?.payload?.itinerary
    expect(applied).toBeTruthy()
    expect(applied.legs[0].to.stop.id).toBe('1:s3')
  })

  it('autoApply re-asserts riding + live times when the fact cleared mid-flight', async () => {
    // The replan's async work (schedule fetch, alight optimization) takes
    // seconds; a rider whose fixes ran off the OLD itinerary's bus leg
    // meanwhile hits the off-route clear, so the fact reanchorRiding would
    // carry over is gone by the time the splice lands — and with no further
    // GPS ticks nothing re-forms it or refreshes live leg times
    // (verify-boarded-earlier: "riding trip undefined", alight n/a).
    const trip = makeTripFixture()
    // A real service day so liveStopArrival can build absolute epochs.
    const serviceDay = Math.floor(Date.now() / 1000) - 3600
    trip.stopTimes = trip.stopTimes.map((st: any) => ({ ...st, serviceDay }))
    const store = makeStore({ trips: { [TRIP_ID]: trip } })
    mockedFetch.mockReturnValue(() => {
      // The off-route clear lands while the replan is in flight.
      store.dispatch({ type: 'CLEAR_RIDING' })
      return Promise.resolve({ error: false, itineraries: [onwardItin()] })
    })
    await store.dispatch(
      replanFromAboard({ autoApply: true, reason: 'boarded-earlier' })
    )

    // The riding fact is re-asserted, anchored to the spliced bus leg.
    expect(store.getGoMode().riding).toEqual(
      expect.objectContaining({
        legIndex: 0,
        offRouteSince: null,
        tripId: TRIP_ID,
        vehicleId: 'v-1'
      })
    )
    // And the live-times refresh ran against the spliced itinerary — the
    // ridden trip's leg got an anchored entry without waiting for a GPS tick.
    const types = store.actions.map((a) => a.type)
    expect(types.indexOf('SET_LIVE_LEG_TIMES')).toBeGreaterThan(
      types.indexOf('START_GO_MODE')
    )
    const live = store.actions
      .filter((a) => a.type === 'SET_LIVE_LEG_TIMES')
      .pop()
    expect(live?.payload?.[0]?.alightEpoch).not.toBeNull()
    expect(live?.payload?.[0]?.boardEpoch).not.toBeNull()
  })

  it('explicit path populates the onboard UI without touching the live trip', async () => {
    const trip = makeTripFixture()
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [onwardItin()] })
    )
    const store = makeStore({ trips: { [TRIP_ID]: trip } })
    const itineraryBefore = store.getGoMode().activeItinerary
    await store.dispatch(
      replanFromAboard({ autoApply: false, reason: 'rider-reroute' })
    )

    const types = store.actions.map((a) => a.type)
    // NEVER BEGIN_ONBOARD_FLOW mid-trip: its reducer clears activeItinerary.
    expect(types).not.toContain('BEGIN_ONBOARD_FLOW')
    expect(types).not.toContain('START_GO_MODE')
    expect(store.getGoMode().activeItinerary).toBe(itineraryBefore)
    // The existing alight-stop UI takes over from here
    // (confirmOnboardAlightStop works verbatim on this state).
    expect(store.getGoMode().onboard.status).toBe('ready')
    expect(store.getGoMode().onboard.vehicle).toEqual(
      expect.objectContaining({ tripId: TRIP_ID, vehicleId: 'v-1' })
    )
    expect(store.getGoMode().onboard.trip).toBe(trip)
    expect(store.getGoMode().onboard.alightOptions.length).toBeGreaterThan(0)
    // reRoute was single-flight bookkeeping only — cleared, not 'found'.
    expect(store.getGoMode().reRoute.status).toBe('idle')
  })

  it('TripSheet reroutes route through the aboard flow while riding (no planner search)', async () => {
    const trip = makeTripFixture()
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [onwardItin()] })
    )
    const store = makeStore({ trips: { [TRIP_ID]: trip } })
    store.dispatch(browseFromCurrentPosition())
    // browse hands off to the async aboard thunk without awaiting it — let
    // its (already-resolved) promise chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const types = store.actions.map((a) => a.type)
    // Verifiably aboard: no currentQuery rewrite, no backgrounding into the
    // planner — the onboard alight UI answers "other ways from here".
    expect(types).not.toContain('SET_QUERY_PARAM')
    expect(types).not.toContain('SET_GO_MODE_BACKGROUNDED')
    expect(store.getGoMode().onboard.status).toBe('ready')
  })

  it('settles reRoute to "none" (retryable) when the trip schedule fetch fails', async () => {
    // findTrip resolves but the store never gains the trip (fetch failed).
    const store = makeStore({ trips: {} })
    await store.dispatch(replanFromAboard({ autoApply: true }))

    expect(store.getGoMode().reRoute.status).toBe('none')
    // Mid-trip failure must not put the onboard flow into 'error' (that
    // renders the onboard error screen over the live trip).
    expect(store.getGoMode().onboard.status).toBe('idle')
    expect(
      store.actions.find((a) => a.type === 'START_GO_MODE')
    ).toBeUndefined()
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  // --- Backlog item 4 (8/9): an automatic update keeps the rider's route ---

  /** The 8/9 shape: bus, bike, the rider's chosen D Line, bike. */
  const makeItineraryWithOnwardBus = () => ({
    duration: 1800,
    endTime: 2000000,
    legs: [
      {
        from: { lat: 44.86, lon: -93.28, name: 'Knox & 76th St' },
        mode: 'BUS',
        routeId: '1:904',
        to: { lat: 44.95, lon: -93.28, name: 'Near Destination' },
        transitLeg: true,
        trip: { gtfsId: TRIP_ID },
        tripId: TRIP_ID
      },
      { mode: 'BICYCLE', to: { name: 'D Line stop' }, transitLeg: false },
      {
        mode: 'BUS',
        routeId: '1:924',
        to: { name: 'Lyndale & 36th' },
        transitLeg: true
      },
      {
        mode: 'BICYCLE',
        to: { lat: 44.951, lon: -93.279, name: 'Real Destination' },
        transitLeg: false
      }
    ],
    startTime: 200000,
    transfers: 1
  })

  /** An onward plan that puts the rider on `routeId` after they get off. */
  const onwardOnRoute = (routeId: string, durationS: number) => ({
    duration: durationS,
    endTime: Date.now() + 600000 + durationS * 1000,
    legs: [
      {
        from: { name: 'Near Destination' },
        mode: 'WALK',
        to: { name: 'Transfer stop' },
        transitLeg: false
      },
      {
        from: { name: 'Transfer stop' },
        mode: 'BUS',
        routeId,
        to: { name: 'Real Destination' },
        transitLeg: true
      }
    ],
    startTime: Date.now() + 600000,
    transfers: 0,
    walkDistance: 200
  })

  it('an auto-applied splice keeps the rider on the route they chose (8/9)', async () => {
    // Route 5 is four minutes faster. On 8/9 that ranking is exactly what
    // handed the rider a different line; automatic means same route.
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({
        error: false,
        itineraries: [onwardOnRoute('1:5', 1329), onwardOnRoute('1:924', 1583)]
      })
    )
    const store = makeStore({
      goModeOverrides: { activeItinerary: makeItineraryWithOnwardBus() },
      trips: { [TRIP_ID]: makeTripFixture() }
    })
    await store.dispatch(replanFromAboard({ autoApply: true }))

    const started = store.actions.find((a) => a.type === 'START_GO_MODE')
    expect(started).toBeDefined()
    const routes = (started.payload.itinerary.legs || [])
      .filter((l: any) => l.transitLeg)
      .map((l: any) => l.routeId || l.route?.id)
    // The boarded bus, then the rider's own D Line — never route 5.
    expect(routes).toEqual(['1:904', '1:924'])
  })

  it('does not auto-apply at all when nothing onward runs their route (8/9)', async () => {
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({
        error: false,
        itineraries: [onwardOnRoute('1:5', 900)]
      })
    )
    const store = makeStore({
      goModeOverrides: { activeItinerary: makeItineraryWithOnwardBus() },
      trips: { [TRIP_ID]: makeTripFixture() }
    })
    await store.dispatch(replanFromAboard({ autoApply: true }))

    // Settled and retryable, trip untouched — a faster route the rider did
    // not pick is not an automatic update, it is a forced route change.
    expect(
      store.actions.find((a) => a.type === 'START_GO_MODE')
    ).toBeUndefined()
    expect(store.getGoMode().reRoute.status).toBe('none')
  })

  it('keeps the route to preserve on the leg AFTER the bus, not the bus (8/9)', async () => {
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({
        error: false,
        itineraries: [onwardOnRoute('1:924', 900)]
      })
    )
    const store = makeStore({
      goModeOverrides: { activeItinerary: makeItineraryWithOnwardBus() },
      trips: { [TRIP_ID]: makeTripFixture() }
    })
    await store.dispatch(replanFromAboard({ autoApply: true }))

    // riding.routeId (1:904) used to be written here: a constraint the rider
    // is already satisfying, which is to say no constraint at all.
    expect(
      store.actions.find((a) => a.type === 'START_REROUTE')?.payload.keepRouteId
    ).toBe('1:924')
  })

  it('leaves a bus-then-walk trip on the old behaviour — no route to keep', async () => {
    // The unchanged fixture itinerary ends on foot: nothing downstream to
    // preserve, so the fastest plan still wins and still applies.
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [onwardItin()] })
    )
    const store = makeStore({ trips: { [TRIP_ID]: makeTripFixture() } })
    await store.dispatch(replanFromAboard({ autoApply: true }))

    expect(store.getGoMode().reRoute.keepRouteId).toBeNull()
    expect(store.actions.find((a) => a.type === 'START_GO_MODE')).toBeDefined()
  })
})
