/* globals afterEach, beforeEach, describe, expect, it, jest */
import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import { chooseGoModeExploreMode } from '../../../lib/actions/go-mode-explore'
import { endGoMode, quietReplanAccessLeg } from '../../../lib/actions/go-mode'
import { fetchBikeExplore } from '../../../lib/util/bike-explore'
import { fetchOnboardCandidatePlan, findTrip } from '../../../lib/actions/apiV2'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))
jest.mock('../../../lib/util/bike-explore', () => ({
  ...jest.requireActual('../../../lib/util/bike-explore'),
  fetchBikeExplore: jest.fn()
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fx = require('../../test-utils/mock-data/bike-explore-gomode-46th.json')

const initial = goMode(undefined, { type: '@@INIT' })
const mockedOtp = fetchOnboardCandidatePlan as jest.Mock
const mockedEngine = fetchBikeExplore as jest.Mock
const mockedFindTrip = findTrip as jest.Mock
const clone = (x: any) => JSON.parse(JSON.stringify(x))

/**
 * BACKLOG 76.3 — Go Mode keeps a Calm / Wander ride when it re-plans the bike
 * leg. The rider is at Lynnhurst (44.9145, -93.299) on a Calm ride to I-35W &
 * 46th St Station for an Orange Line 25 min out; they have left the ride, so
 * the tick dispatches quietReplanAccessLeg. The engine's answers are the REAL
 * ones (bike-explore-gomode-46th.json, the live engine, same origin, same
 * stop, depart_s 1500).
 */
const NOW = 1_795_000_000_000
const RIDER: [number, number] = [44.9145, -93.299]
const STATION: [number, number] = [44.919409, -93.274746]
const ALIGHT: [number, number] = [44.9766, -93.2738]
const BUS_AT = NOW + 1_500_000
const ARRIVE = BUS_AT + 900_000

const stationPlace = {
  lat: STATION[0],
  lon: STATION[1],
  name: 'I-35W & 46th St Station',
  stopId: '1:56041'
}

const busLeg = () => ({
  distance: 7000,
  duration: 900,
  endTime: ARRIVE,
  from: stationPlace,
  legGeometry: { points: encode([STATION, ALIGHT]) },
  mode: 'BUS',
  route: { gtfsId: '1:904', id: '1:904' },
  routeId: '1:904',
  routeShortName: 'Orange',
  startTime: BUS_AT,
  to: { lat: ALIGHT[0], lon: ALIGHT[1], name: 'Downtown', stopId: '1:d' },
  transitLeg: true,
  tripId: '1:orange-1'
})

/** The held trip: a bike leg (Calm when `exploreRide` is given) → the bus. */
const heldTrip = (exploreRide?: any) => {
  const startTime = BUS_AT - 900_000
  return {
    duration: (ARRIVE - startTime) / 1000,
    endTime: ARRIVE,
    legs: [
      {
        distance: 2500,
        duration: 549,
        endTime: startTime + 549_000,
        ...(exploreRide ? { exploreRide } : {}),
        from: { lat: 44.912, lon: -93.305, name: 'Home' },
        legGeometry: { points: encode([[44.912, -93.305], STATION]) },
        mode: 'BICYCLE',
        startTime,
        steps: [],
        to: stationPlace,
        transitLeg: false
      },
      busLeg()
    ],
    startTime
  }
}

/** OTP's scoped answer: the fastest bike ride, 9 min. */
const otpAccess = () => ({
  duration: 540,
  endTime: NOW + 540_000,
  legs: [
    {
      distance: 2560,
      duration: 540,
      endTime: NOW + 540_000,
      from: { lat: RIDER[0], lon: RIDER[1], name: 'Current location' },
      legGeometry: { points: encode([RIDER, STATION]) },
      mode: 'BICYCLE',
      startTime: NOW,
      steps: [],
      to: { lat: STATION[0], lon: STATION[1], name: 'I-35W & 46th St' },
      transitLeg: false
    }
  ],
  startTime: NOW
})

const otpAnswers = () => () =>
  Promise.resolve({ error: false, itineraries: [otpAccess()] })

const makeStore = (activeItinerary: any, overrides: any = {}) => {
  let goModeState: any = {
    ...initial,
    activeItinerary,
    isActive: true,
    routeMatch: { legIndex: 0, progressAlongLeg: 0.2 },
    tracking: {
      ...initial.tracking,
      lastPosition: {
        coords: {
          accuracy: 8,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          latitude: RIDER[0],
          longitude: RIDER[1],
          speed: null
        },
        timestamp: NOW
      }
    },
    ...overrides
  }
  const actions: any[] = []
  const getState = () => ({
    otp: {
      bikeExplore: { mode: 'direct', searches: {} },
      config: { homeTimezone: 'America/Chicago', itinerary: {} },
      currentQuery: { routingPreferences: { bikeSpeed: 5 } },
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
    actions,
    activeItinerary: () => goModeState.activeItinerary,
    dispatch,
    goMode: () => goModeState,
    of: (type: string) => actions.filter((a) => a.type === type)
  }
}

const calmRide = { mode: 'calm', preference: 1, stopId: '1:56041' }

describe('76.3: Go Mode re-plans a Calm / Wander ride with the engine first', () => {
  let clock: FakeTimers.InstalledClock | undefined
  let store: ReturnType<typeof makeStore> | undefined

  beforeEach(() => {
    mockedOtp.mockReset()
    mockedEngine.mockReset()
    mockedFindTrip.mockReset()
    mockedFindTrip.mockImplementation(() => () => Promise.resolve(null))
    mockedOtp.mockImplementation(otpAnswers)
    clock = FakeTimers.install({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    store?.dispatch(endGoMode())
    store = undefined
    clock?.uninstall()
    clock = undefined
  })

  const replan = async (s: ReturnType<typeof makeStore>, options?: any) =>
    s.dispatch(quietReplanAccessLeg(options))

  it('Calm: installs the engine’s ride, keeps the bus, never asks OTP', async () => {
    mockedEngine.mockResolvedValue(clone(fx.calm))
    store = makeStore(heldTrip(calmRide), { exploreMode: 'calm' })
    const heldBus = store.activeItinerary().legs[1]
    await replan(store)

    expect(mockedEngine).toHaveBeenCalledTimes(1)
    const [url, body] = mockedEngine.mock.calls[0]
    expect(url).toBe('/api/bike/access')
    expect(body).toEqual({
      candidates: [
        {
          depart_s: 1500,
          id: '1:56041',
          lat: STATION[0],
          lon: STATION[1],
          name: 'I-35W & 46th St Station'
        }
      ],
      lat: RIDER[0],
      lon: RIDER[1],
      mode: 'calm',
      speed: 5
    })
    expect(mockedOtp).not.toHaveBeenCalled()

    const installed = store.activeItinerary()
    expect(installed.legs[0].exploreRide).toMatchObject({
      mode: 'calm',
      preference: 1
    })
    // It starts where and when the projected origin is: now plus the scoped
    // latency estimate (200 ms before any sample), as OTP's question does.
    const start = installed.legs[0].startTime
    expect(start - NOW).toBeGreaterThanOrEqual(0)
    expect(start - NOW).toBeLessThan(1000)
    expect(installed.legs[0].endTime - start).toBe(549_000)
    expect(installed.legs[0].steps).toHaveLength(18)
    expect(installed.legs[1]).toBe(heldBus)
    expect(store.goMode().exploreMode).toBe('calm')

    expect(store.of('AUTO_REPLAN').map((a) => a.payload)).toEqual([
      expect.objectContaining({
        accepted: true,
        reason: 'quiet-replan-explore'
      })
    ])
    expect(store.of('GO_MODE_EXPLORE_REPLAN')[0].payload).toMatchObject({
      departS: 1500,
      durationS: 549,
      mode: 'calm',
      outcome: 'applied',
      riderAsked: false,
      shortOnTime: false,
      speed: 5
    })
  })

  it('Wander: installs the 18-minute ride via the creek', async () => {
    mockedEngine.mockResolvedValue(clone(fx.wander))
    store = makeStore(heldTrip({ ...calmRide, mode: 'wander' }), {
      exploreMode: 'wander'
    })
    await replan(store)
    expect(mockedEngine.mock.calls[0][1].mode).toBe('wander')
    expect(mockedOtp).not.toHaveBeenCalled()
    const leg = store.activeItinerary().legs[0]
    expect(leg.exploreRide).toMatchObject({
      mode: 'wander',
      via: 'Minnehaha Creek Park'
    })
    expect(leg.endTime - leg.startTime).toBe(1_080_000)
    expect(leg.distance).toBeCloseTo(5171.3, 0)
  })

  it('keeps asking the engine after OTP had to answer once (the trip’s mode, not the leg’s)', async () => {
    mockedEngine.mockResolvedValue(clone(fx.calm))
    // An OTP leg (no exploreRide) on a trip that is Calm.
    store = makeStore(heldTrip(), { exploreMode: 'calm' })
    await replan(store)
    expect(mockedEngine).toHaveBeenCalledTimes(1)
    expect(store.activeItinerary().legs[0].exploreRide.mode).toBe('calm')
  })

  /** What OTP is asked, in order — to hold the fallback to today's path. */
  const otpQuestions = () =>
    mockedOtp.mock.calls.map(([combo, opts]) => ({
      arriveBy: combo.arriveBy,
      date: combo.date,
      from: combo.from,
      modes: combo.modes,
      reason: opts?.reason,
      routingPreferences: combo.routingPreferences,
      time: combo.time,
      to: combo.to
    }))

  const directBaseline = async () => {
    const s = makeStore(heldTrip(), { exploreMode: 'direct' })
    await replan(s)
    const asked = otpQuestions()
    const installed = s.activeItinerary()
    s.dispatch(endGoMode())
    mockedOtp.mockClear()
    return { asked, installed }
  }

  it('Direct: the engine is never called, nothing new is dispatched', async () => {
    store = makeStore(heldTrip(), { exploreMode: 'direct' })
    await replan(store)
    expect(mockedEngine).not.toHaveBeenCalled()
    expect(store.of('GO_MODE_EXPLORE_REPLAN')).toHaveLength(0)
    expect(store.of('AUTO_REPLAN').map((a) => a.payload.reason)).toEqual([
      'quiet-replan-scoped'
    ])
    expect(otpQuestions().map((q) => q.reason)).toEqual(['quiet-replan-scoped'])
    expect(store.activeItinerary().legs[0].exploreRide).toBeUndefined()
  })

  it('Direct with an engine leg in hand (the rider switched to Direct): still never the engine', async () => {
    store = makeStore(heldTrip(calmRide), { exploreMode: 'direct' })
    await replan(store)
    expect(mockedEngine).not.toHaveBeenCalled()
    expect(store.activeItinerary().legs[0].exploreRide).toBeUndefined()
  })

  const fallsThrough = async (engineAnswer: any, outcome: string) => {
    const baseline = await directBaseline()
    mockedEngine.mockResolvedValue(engineAnswer)
    store = makeStore(heldTrip(calmRide), { exploreMode: 'calm' })
    await replan(store)
    expect(mockedEngine).toHaveBeenCalledTimes(1)
    // The OTP path, exactly as today: the same questions, in the same order.
    expect(otpQuestions()).toEqual(baseline.asked)
    expect(store.activeItinerary().legs[0].exploreRide).toBeUndefined()
    expect(store.activeItinerary().legs[0].endTime).toBe(
      baseline.installed.legs[0].endTime
    )
    expect(store.of('GO_MODE_EXPLORE_REPLAN')[0].payload.outcome).toBe(outcome)
    // The trip is still Calm: the next re-plan asks the engine again.
    expect(store.goMode().exploreMode).toBe('calm')
  }

  it('engine unreachable (null) → OTP, unchanged', async () => {
    await fallsThrough(null, 'no-answer')
  })

  it('infeasible (even the fastest ride misses the bus with the margin) → OTP, unchanged', async () => {
    const infeasible = clone(fx.calm)
    infeasible.candidates[0].feasible = false
    infeasible.candidates[0].reason =
      'cannot reach the stop in time with the margin'
    await fallsThrough(infeasible, 'infeasible')
  })

  it('refused by the acceptance gate → OTP, unchanged', async () => {
    // A "feasible" ride that in fact ends 10 min after the bus: the gate's
    // access-misses-board refuses it, exactly as it would refuse OTP's.
    const late = clone(fx.calm)
    late.candidates[0].leg.duration = 2100
    late.candidates[0].duration_s = 2100
    await fallsThrough(late, 'refused')
    const verdicts = store!.of('AUTO_REPLAN').map((a) => a.payload)
    expect(verdicts[0]).toMatchObject({
      accepted: false,
      reason: 'quiet-replan-explore',
      refusedBecause: 'access-misses-board'
    })
    expect(verdicts[1]).toMatchObject({
      accepted: true,
      reason: 'quiet-replan-scoped'
    })
    expect(store!.of('GO_MODE_EXPLORE_REPLAN')[0].payload.refusedBecause).toBe(
      'access-misses-board'
    )
  })

  it('a ride the bus cut short is marked on the leg', async () => {
    // Bus 11 min out: Calm's full ride does not fit; the engine blends.
    const short = clone(fx.calm)
    short.candidates[0].preference = 0.3
    const busSoon = NOW + 660_000
    const trip = heldTrip(calmRide)
    trip.legs[1].startTime = busSoon
    mockedEngine.mockResolvedValue(short)
    store = makeStore(trip, { exploreMode: 'calm' })
    await replan(store)
    expect(mockedEngine.mock.calls[0][1].candidates[0].depart_s).toBe(660)
    expect(store.activeItinerary().legs[0].exploreShortfall).toBe('partial')
    expect(store.of('GO_MODE_EXPLORE_REPLAN')[0].payload.shortOnTime).toBe(true)
  })

  it('aboard a known trip: no engine, no OTP — the aboard guard still wins', async () => {
    mockedEngine.mockResolvedValue(clone(fx.calm))
    store = makeStore(heldTrip(calmRide), {
      exploreMode: 'calm',
      riding: { legIndex: 1, routeId: '1:904', tripId: '1:orange-1' }
    })
    await replan(store)
    expect(mockedEngine).not.toHaveBeenCalled()
    expect(mockedOtp).not.toHaveBeenCalled()
    await store.dispatch(chooseGoModeExploreMode('wander'))
    expect(mockedEngine).not.toHaveBeenCalled()
    expect(mockedOtp).not.toHaveBeenCalled()
  })

  describe('the in-ride switch', () => {
    const progress = { currentLegIndex: 0 }

    it('Direct → Calm: sets the trip and the stored mode, re-plans exactly once', async () => {
      mockedEngine.mockResolvedValue(clone(fx.calm))
      store = makeStore(heldTrip(), { exploreMode: 'direct', progress })
      await store.dispatch(chooseGoModeExploreMode('calm'))
      expect(store.of('SET_BIKE_EXPLORE_MODE').map((a) => a.payload)).toEqual([
        'calm'
      ])
      expect(store.goMode().exploreMode).toBe('calm')
      expect(mockedEngine).toHaveBeenCalledTimes(1)
      expect(mockedOtp).not.toHaveBeenCalled()
      expect(store.of('START_GO_MODE')).toHaveLength(1)
      expect(store.activeItinerary().legs[0].exploreRide.mode).toBe('calm')
      expect(store.of('GO_MODE_EXPLORE_REPLAN')[0].payload.riderAsked).toBe(
        true
      )
    })

    it('is not held by the deviation cooldown; the app’s own next re-plan still is', async () => {
      mockedEngine.mockImplementation((url: string, body: any) =>
        Promise.resolve(clone(body.mode === 'wander' ? fx.wander : fx.calm))
      )
      store = makeStore(heldTrip(calmRide), { exploreMode: 'calm', progress })
      await replan(store) // a deviation re-plan at NOW
      expect(mockedEngine).toHaveBeenCalledTimes(1)
      await store.dispatch(chooseGoModeExploreMode('wander'))
      expect(mockedEngine).toHaveBeenCalledTimes(2)
      expect(store.activeItinerary().legs[0].exploreRide.mode).toBe('wander')
      await replan(store) // the tick, inside the cooldown: held
      expect(mockedEngine).toHaveBeenCalledTimes(2)
      expect(mockedOtp).not.toHaveBeenCalled()
    })

    it('Calm → Direct: OTP’s scoped re-plan, the engine not asked', async () => {
      store = makeStore(heldTrip(calmRide), { exploreMode: 'calm', progress })
      await store.dispatch(chooseGoModeExploreMode('direct'))
      expect(mockedEngine).not.toHaveBeenCalled()
      expect(otpQuestions().map((q) => q.reason)).toEqual([
        'quiet-replan-scoped'
      ])
      expect(store.activeItinerary().legs[0].exploreRide).toBeUndefined()
      expect(store.goMode().exploreMode).toBe('direct')
    })

    it('the mode already in force: stored, no re-plan', async () => {
      store = makeStore(heldTrip(calmRide), { exploreMode: 'calm', progress })
      await store.dispatch(chooseGoModeExploreMode('calm'))
      expect(store.of('SET_BIKE_EXPLORE_MODE')).toHaveLength(1)
      expect(mockedEngine).not.toHaveBeenCalled()
      expect(mockedOtp).not.toHaveBeenCalled()
    })

    it('on the bus leg: the trip’s mode changes, nothing is re-planned', async () => {
      store = makeStore(heldTrip(calmRide), {
        exploreMode: 'calm',
        progress: { currentLegIndex: 1 },
        routeMatch: { legIndex: 1, progressAlongLeg: 0.1 }
      })
      await store.dispatch(chooseGoModeExploreMode('wander'))
      expect(store.goMode().exploreMode).toBe('wander')
      expect(mockedEngine).not.toHaveBeenCalled()
      expect(mockedOtp).not.toHaveBeenCalled()
    })
  })
})
