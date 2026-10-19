/* globals afterEach, beforeEach, describe, expect, it, jest */
import '../test-utils/mock-window-url'
import fs from 'fs'
import path from 'path'

import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import {
  acceptFasterRoute,
  backgroundRouteCheck,
  beginGoMode,
  captureRerouteSnapshot,
  endGoMode,
  keepCurrentRoute,
  viewFasterRoute
} from '../../lib/actions/go-mode'
import {
  buildFasterRouteNotice,
  fasterRouteCopy
} from '../../lib/util/go-mode/notification-service'
import { cancelPush, sendPush } from '../../lib/util/go-mode/native-notify'
import { FASTER_ROUTE_NOTICE_ID } from '../../lib/util/go-mode/faster-route-offer'
import { fetchRerouteSnapshotPlan } from '../../lib/actions/apiV2'
import { isTripRecordingEnabled } from '../../lib/util/debug-log'
import { legTripId } from '../../lib/util/go-mode/leg-merge'
import { remainingTransitLegs } from '../../lib/util/go-mode/faster-route'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'

jest.mock('../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(
    () => () => Promise.resolve({ error: false, itineraries: [] })
  ),
  fetchRerouteSnapshotPlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  }))
}))
jest.mock('../../lib/util/go-mode/native-notify', () => ({
  ...jest.requireActual('../../lib/util/go-mode/native-notify'),
  cancelPush: jest.fn(() => Promise.resolve()),
  sendPush: jest.fn(() => Promise.resolve())
}))
jest.mock('../../lib/util/debug-log', () => ({
  ...jest.requireActual('../../lib/util/debug-log'),
  isTripRecordingEnabled: jest.fn(() => false)
}))

const snapshotPlan = fetchRerouteSnapshotPlan as jest.Mock
const pushed = sendPush as jest.Mock
const cancelled = cancelPush as jest.Mock
const recording = isTripRecordingEnabled as jest.Mock

/**
 * Backlog 56.1, cycle 25 B2 — the background "faster route available" offer.
 *
 * The thunk under test is the background route interval's tick: one isolated
 * plan() from the rider's position, judged by B1's classifyFasterRoute, that
 * may put up ONE card ("6 min faster · 14") and, with the phone locked, ONE
 * push on a stable id. It must never change the trip on its own; Switch is the
 * only way it does. Every plain action goes through the REAL root reducer
 * (create-otp-reducer), so a goMode type missing from its delegation list
 * fails here even though the slice's own tests would pass.
 */

const NOW = Date.UTC(2026, 9, 18, 21, 0, 0) // 16:00 Chicago
const MIN = 60000
const P0: [number, number] = [44.95, -93.29] // the rider, off the bus
const STOP_A: [number, number] = [44.9515, -93.29] // ~170 m north
const STOP_B: [number, number] = [44.95, -93.2878] // ~95 m east
const DEST: [number, number] = [44.99, -93.25]

let rawSeq = 0
/**
 * One raw OTP2 itinerary: an access leg from the rider to `stop`, one bus
 * ride, and a short walk to the door. `accessMode`/`accessM` shape the access
 * leg (a long bike leg for the less-biking cases).
 */
function plan(opts: {
  accessM?: number
  accessMode?: 'BICYCLE' | 'WALK'
  arrive: number
  board: number
  route: string
  stop?: [number, number]
  trip: string
}): any {
  const stop = opts.stop || STOP_A
  const accessMode = opts.accessMode || 'WALK'
  const accessM = opts.accessM ?? 170
  const alightAt = opts.arrive - 2 * MIN
  const accessEnd = opts.board - MIN
  // An answer starts when it is asked for (the fake clock's now).
  const accessStart = Math.min(Date.now(), accessEnd - 2 * MIN)
  const legs = [
    {
      distance: accessM,
      duration: (accessEnd - accessStart) / 1000,
      endTime: accessEnd,
      from: { lat: P0[0], lon: P0[1], name: 'Current location' },
      legGeometry: { points: encode([P0, stop]) },
      mode: accessMode,
      startTime: accessStart,
      to: {
        lat: stop[0],
        lon: stop[1],
        name: `Stop ${opts.route}`,
        stop: { gtfsId: `1:S${opts.route}` }
      },
      transitLeg: false
    },
    {
      distance: 6000,
      duration: (alightAt - opts.board) / 1000,
      endTime: alightAt,
      from: {
        lat: stop[0],
        lon: stop[1],
        name: `Stop ${opts.route}`,
        stop: { gtfsId: `1:S${opts.route}` }
      },
      legGeometry: { points: encode([stop, [DEST[0] - 0.002, DEST[1]]]) },
      mode: 'BUS',
      route: { id: `1:${opts.route}`, shortName: opts.route },
      routeShortName: opts.route,
      startTime: opts.board,
      to: {
        lat: DEST[0] - 0.002,
        lon: DEST[1],
        name: 'Near home',
        stop: { gtfsId: `1:E${opts.route}` }
      },
      transitLeg: true,
      trip: { gtfsId: opts.trip }
    },
    {
      distance: 220,
      duration: 120,
      endTime: opts.arrive,
      from: { lat: DEST[0] - 0.002, lon: DEST[1], name: 'Near home' },
      legGeometry: { points: encode([[DEST[0] - 0.002, DEST[1]], DEST]) },
      mode: 'WALK',
      startTime: alightAt,
      to: { lat: DEST[0], lon: DEST[1], name: 'Home' },
      transitLeg: false
    }
  ]
  rawSeq++
  return {
    duration: (opts.arrive - accessStart) / 1000,
    endTime: opts.arrive,
    legs,
    startTime: accessStart
  }
}

// The rider's plan: the A bus, boarding at 16:08, home at 16:40.
const held = (extra: Partial<Parameters<typeof plan>[0]> = {}) =>
  plan({
    arrive: NOW + 40 * MIN,
    board: NOW + 8 * MIN,
    route: 'A',
    trip: '1:tA',
    ...extra
  })
// The same trip as an answer times it — the baseline.
const own = (extra: Partial<Parameters<typeof plan>[0]> = {}) => held(extra)
// Route 14, 6 min sooner, from a stop the rider can reach.
const fourteen = (arriveMin = 34) =>
  plan({
    arrive: NOW + arriveMin * MIN,
    board: NOW + 6 * MIN,
    route: '14',
    stop: STOP_B,
    trip: '1:t14'
  })
const otherRoute = (route: string, arriveMin: number) =>
  plan({
    arrive: NOW + arriveMin * MIN,
    board: NOW + 6 * MIN,
    route,
    stop: STOP_B,
    trip: `1:t${route}`
  })

const answer = (...itineraries: any[]) => ({
  data: { plan: { itineraries } }
})

const fix = (at: [number, number], ts = NOW - 10 * MIN): any => ({
  coords: {
    accuracy: 8,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    latitude: at[0],
    longitude: at[1],
    speed: 0
  },
  // Old enough that beginGoMode does not re-run it through the tick.
  timestamp: ts
})

let visibility: DocumentVisibilityState = 'visible'
Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => visibility
})

/** A Go Mode store over the REAL root reducer. */
function makeStore(goModePatch: any = {}, itinerary: any = held()) {
  const reducer = createOtpReducer({ homeTimezone: 'America/Chicago' } as any)
  let otp: any = reducer(undefined, { type: '@@INIT' })
  otp = {
    ...otp,
    config: { ...otp.config, homeTimezone: 'America/Chicago' },
    currentQuery: { ...otp.currentQuery, routingPreferences: {} },
    goMode: {
      ...otp.goMode,
      activeItinerary: itinerary,
      isActive: true,
      progress: null,
      tracking: { ...otp.goMode.tracking, lastPosition: fix(P0) },
      ...goModePatch
    }
  }
  const actions: any[] = []
  const getState = () => ({ otp, router: { location: { pathname: '/' } } })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    otp = reducer(otp, action)
    return action
  }
  return {
    actions,
    goMode: () => otp.goMode,
    of: (type: string) => actions.filter((a) => a.type === type),
    patch: (p: any) => {
      otp = { ...otp, goMode: { ...otp.goMode, ...p } }
    },
    run: (thunk: any) => thunk(dispatch, getState)
  }
}

const respondWith = (...itineraries: any[]) =>
  snapshotPlan.mockImplementation(
    (combo: any) => () =>
      Promise.resolve({
        query: 'q',
        response: answer(...itineraries),
        variables: { bikeReluctance: combo?.routingPreferences?.bikeReluctance }
      })
  )

const lowBikeCalls = () =>
  snapshotPlan.mock.calls.filter(
    ([combo]) => combo?.routingPreferences?.bikeReluctance === 1
  ).length

describe('faster-route offer (56.1, cycle 25 B2)', () => {
  let clock: FakeTimers.InstalledClock
  let store: ReturnType<typeof makeStore> | undefined

  beforeEach(() => {
    snapshotPlan.mockReset()
    pushed.mockClear()
    cancelled.mockClear()
    recording.mockReturnValue(false)
    visibility = 'visible'
    clock = FakeTimers.install({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    // Interval, latch and timers are TripSession state: every case its own trip.
    store?.run(endGoMode())
    store = undefined
    clock.uninstall()
  })

  it('offers "6 min faster · 14" and never changes the route on its own', async () => {
    respondWith(own(), fourteen())
    store = makeStore()
    const before = store.goMode().activeItinerary
    await store.run(backgroundRouteCheck())

    const offer = store.goMode().fasterRoute
    expect(offer).not.toBeNull()
    expect(offer.kind).toBe('faster')
    expect(Math.round(offer.savingMs / MIN)).toBe(6)
    expect(fasterRouteCopy(offer)).toEqual({
      detail: '14',
      title: '6 min faster'
    })
    // Offered, not applied.
    expect(store.goMode().activeItinerary).toBe(before)
    expect(store.of('START_GO_MODE')).toHaveLength(0)
    expect(store.of('AUTO_REPLAN')).toHaveLength(0)
    expect(store.of('FASTER_ROUTE_OFFER')[0].payload).toMatchObject({
      kind: 'faster',
      outcome: 'offered',
      push: 'none',
      route: '14',
      savingMin: 6
    })
    // On screen: the card, no push.
    expect(pushed).not.toHaveBeenCalled()
  })

  it('does not record a REROUTE_SNAPSHOT for a check while recording is off', async () => {
    respondWith(own(), fourteen())
    store = makeStore()
    await store.run(backgroundRouteCheck())
    expect(snapshotPlan).toHaveBeenCalledTimes(1)
    expect(store.of('REROUTE_SNAPSHOT')).toHaveLength(0)
  })

  it('records the SAME answer as a REROUTE_SNAPSHOT when recording — one request, not two', async () => {
    recording.mockReturnValue(true)
    respondWith(own(), fourteen())
    store = makeStore()
    await store.run(backgroundRouteCheck())
    expect(snapshotPlan).toHaveBeenCalledTimes(1)
    const snaps = store.of('REROUTE_SNAPSHOT')
    expect(snaps).toHaveLength(1)
    expect(snaps[0].payload).toMatchObject({
      fasterRouteCheck: true,
      reason: 'periodic'
    })
    expect(store.goMode().fasterRoute?.routeSet).toBe('1:14')
  })

  it("Switch swaps to the offered route, recorded as the rider's (autoApply false)", async () => {
    respondWith(own(), fourteen())
    store = makeStore()
    await store.run(backgroundRouteCheck())
    await store.run(acceptFasterRoute())

    const active = store.goMode().activeItinerary
    expect(active.legs.find((l: any) => l.transitLeg)?.trip?.gtfsId).toBe(
      '1:t14'
    )
    expect(store.goMode().fasterRoute).toBeNull()
    expect(store.of('AUTO_REPLAN').map((a) => a.payload)).toEqual([
      expect.objectContaining({
        accepted: true,
        autoApply: false,
        reason: 'faster-route'
      })
    ])
    expect(
      store.of('FASTER_ROUTE_OFFER').map((a) => a.payload.outcome)
    ).toEqual(['offered', 'switched'])
    expect(store.of('GO_MODE_CONTROL_TAP')[0].payload.control).toBe(
      'faster-route-switch'
    )
  })

  it('stays quiet for the minute after a swap (its own Switch included)', async () => {
    respondWith(own(), fourteen())
    store = makeStore()
    await store.run(backgroundRouteCheck())
    await store.run(acceptFasterRoute())
    snapshotPlan.mockClear()
    clock.tick(30000)
    await store.run(backgroundRouteCheck())
    expect(snapshotPlan).not.toHaveBeenCalled()
    clock.tick(31000)
    await store.run(backgroundRouteCheck())
    expect(snapshotPlan).toHaveBeenCalledTimes(1)
  })

  it('Keep mine takes the card down and latches: the same route is not raised again', async () => {
    respondWith(own(), fourteen())
    store = makeStore()
    await store.run(backgroundRouteCheck())
    store.run(keepCurrentRoute())
    expect(store.goMode().fasterRoute).toBeNull()
    expect(store.goMode().activeItinerary.legs[1].trip.gtfsId).toBe('1:tA')

    clock.tick(90000)
    respondWith(own(), fourteen())
    await store.run(backgroundRouteCheck())
    expect(store.goMode().fasterRoute).toBeNull()
    // ...nor a different route that is only 1 min better than the one kept.
    clock.tick(90000)
    respondWith(own(), otherRoute('21', 33))
    await store.run(backgroundRouteCheck())
    expect(store.goMode().fasterRoute).toBeNull()
    expect(
      store.of('FASTER_ROUTE_OFFER').map((a) => a.payload.outcome)
    ).toEqual(['offered', 'kept'])
  })

  it('updates the card in place while later checks still see the route', async () => {
    respondWith(own(), fourteen(34))
    store = makeStore()
    await store.run(backgroundRouteCheck())
    const first = store.goMode().fasterRoute
    clock.tick(90000)
    respondWith(own(), fourteen(33))
    await store.run(backgroundRouteCheck())
    const second = store.goMode().fasterRoute
    expect(second.offerId).toBe(first.offerId)
    expect(Math.round(second.savingMs / MIN)).toBe(7)
    expect(store.of('FASTER_ROUTE_OFFER')).toHaveLength(1)
  })

  it('lapses when a later check no longer sees it, and when its bus has gone', async () => {
    respondWith(own(), fourteen())
    store = makeStore()
    await store.run(backgroundRouteCheck())
    clock.tick(90000)
    respondWith(own())
    await store.run(backgroundRouteCheck())
    expect(store.goMode().fasterRoute).toBeNull()
    expect(store.of('FASTER_ROUTE_OFFER')[1].payload).toMatchObject({
      outcome: 'expired',
      why: 'not-seen'
    })

    // A fresh trip: the 14 boards at +6 min; at +7 min the card is gone
    // before the tick asks anything.
    store.run(endGoMode())
    store = makeStore()
    respondWith(own(), fourteen())
    await store.run(backgroundRouteCheck())
    expect(store.goMode().fasterRoute).not.toBeNull()
    clock.tick(7 * MIN)
    snapshotPlan.mockImplementation(() => () => new Promise(() => undefined))
    store.run(backgroundRouteCheck())
    expect(store.goMode().fasterRoute).toBeNull()
    expect(store.of('FASTER_ROUTE_OFFER').slice(-1)[0].payload).toMatchObject({
      outcome: 'expired',
      why: 'board-time'
    })
  })

  describe('the push', () => {
    it('goes only when the phone is not showing the app, on ONE stable id, at most twice', async () => {
      visibility = 'hidden'
      respondWith(own(), fourteen(34))
      store = makeStore()
      await store.run(backgroundRouteCheck())
      expect(pushed).toHaveBeenCalledTimes(1)
      expect(pushed.mock.calls[0][0]).toEqual({
        id: FASTER_ROUTE_NOTICE_ID,
        message: '6 min faster · 14',
        priority: 1,
        title: 'Faster route'
      })
      // The card is up too — it is there when the rider looks.
      expect(store.goMode().fasterRoute?.routeSet).toBe('1:14')

      // A route that beats the held offer by 3+ min breaks the latch: a new
      // offer, its push REPLACING the first on the same id.
      clock.tick(90000)
      respondWith(own(), fourteen(34), otherRoute('21', 30))
      await store.run(backgroundRouteCheck())
      expect(pushed).toHaveBeenCalledTimes(2)
      expect(pushed.mock.calls[1][0]).toMatchObject({
        id: FASTER_ROUTE_NOTICE_ID,
        message: '10 min faster · 21'
      })
      expect(store.goMode().fasterRoute?.routeSet).toBe('1:21')
      const offered = store
        .of('FASTER_ROUTE_OFFER')
        .filter((a) => a.payload.outcome === 'offered')
      expect(offered.map((a) => a.payload.push)).toEqual(['sent', 'replaced'])

      // A third offer may still go up, but no third push.
      clock.tick(90000)
      respondWith(own(), otherRoute('5', 26))
      await store.run(backgroundRouteCheck())
      expect(store.goMode().fasterRoute?.routeSet).toBe('1:5')
      expect(pushed).toHaveBeenCalledTimes(2)
    })

    it('stays silent with the app on screen', async () => {
      respondWith(own(), fourteen())
      store = makeStore()
      await store.run(backgroundRouteCheck())
      expect(store.goMode().fasterRoute).not.toBeNull()
      expect(pushed).not.toHaveBeenCalled()
    })

    it('is taken back when the rider answers the card', async () => {
      visibility = 'hidden'
      respondWith(own(), fourteen())
      store = makeStore()
      await store.run(backgroundRouteCheck())
      store.run(keepCurrentRoute())
      expect(cancelled).toHaveBeenCalledWith(FASTER_ROUTE_NOTICE_ID)
    })

    it('says "less biking" in numbers, with "+1 min" only when later', () => {
      expect(
        buildFasterRouteNotice({
          addedBikeM: 0,
          bikeSavedM: 1400,
          kind: 'lessBike',
          laterMs: 60000,
          routeLabel: '14',
          savingMs: -60000
        })
      ).toMatchObject({
        message: '1.4 km less biking · 14 · +1 min',
        title: 'Less biking'
      })
      expect(
        fasterRouteCopy({
          addedBikeM: 1800,
          bikeSavedM: 0,
          kind: 'faster',
          laterMs: 0,
          routeLabel: '14',
          savingMs: 6 * MIN
        }).detail
      ).toBe('14 · +1.8 km bike')
      expect(
        fasterRouteCopy({
          addedBikeM: 300,
          bikeSavedM: 0,
          kind: 'faster',
          laterMs: 0,
          routeLabel: '',
          savingMs: 6 * MIN
        })
      ).toEqual({ detail: 'bike', title: '6 min faster' })
    })
  })

  describe('silent when it should be', () => {
    const quiet = async (patch: any) => {
      respondWith(own(), fourteen())
      store = makeStore(patch)
      await store.run(backgroundRouteCheck())
      expect(snapshotPlan).not.toHaveBeenCalled()
      expect(store.goMode().fasterRoute).toBeNull()
    }

    it('behind the planner', () =>
      quiet({
        ui: { activeLeg: null, backgrounded: true, mapFollowUser: true }
      }))
    it('aboard', () =>
      quiet({ riding: { legIndex: 1, routeId: '1:A', tripId: '1:tA' } }))
    it('after arrival', () => quiet({ arrivedAt: NOW - MIN }))
    it('with the onboard flow open', () =>
      quiet({ onboard: { status: 'discovering' } }))
    it('during a reroute search', () =>
      quiet({ reRoute: { candidates: [], status: 'searching' } }))

    it('within a minute of a new plan', async () => {
      respondWith(own(), fourteen())
      store = makeStore()
      await store.run(beginGoMode(held()))
      snapshotPlan.mockClear()
      await store.run(backgroundRouteCheck())
      expect(snapshotPlan).not.toHaveBeenCalled()
    })

    it('never raises the card for an answer that lands after a swap', async () => {
      let release: (v: any) => void = () => undefined
      snapshotPlan.mockImplementation(
        () => () =>
          new Promise((resolve) => {
            release = resolve
          })
      )
      store = makeStore()
      const pending = store.run(backgroundRouteCheck())
      store.patch({ activeItinerary: otherRoute('9', 39) })
      release({
        query: 'q',
        response: answer(own(), fourteen()),
        variables: {}
      })
      await pending
      expect(store.goMode().fasterRoute).toBeNull()
    })

    it("a view shows the offer beside the rider's own route, and leaves the card up", async () => {
      respondWith(own(), fourteen())
      // A fresh fix: the planner's "from here" needs one.
      store = makeStore({
        tracking: {
          ...makeStore().goMode().tracking,
          lastPosition: fix(P0, NOW)
        }
      })
      await store.run(backgroundRouteCheck())
      expect(store.run(viewFasterRoute())).toBe(true)
      expect(store.goMode().ui.backgrounded).toBe(true)
      expect(store.goMode().fasterRoute).not.toBeNull()
      const response = store.of('ROUTING_RESPONSE')[0].payload.response
      expect(
        response.plan.itineraries.map(
          (i: any) => i.legs.find((l: any) => l.transitLeg).trip.gtfsId
        )
      ).toEqual(['1:t14', '1:tA'])
    })
  })

  describe('the less-biking search', () => {
    const bikePlan = (accessM: number) =>
      plan({
        accessM,
        accessMode: 'BICYCLE',
        arrive: NOW + 40 * MIN,
        board: NOW + 8 * MIN,
        route: 'A',
        trip: '1:tA'
      })

    it('runs once per leg with a kilometre of biking left', async () => {
      respondWith(bikePlan(2500))
      store = makeStore({}, bikePlan(2500))
      await store.run(backgroundRouteCheck())
      clock.tick(90000)
      await store.run(backgroundRouteCheck())
      clock.tick(90000)
      await store.run(backgroundRouteCheck())
      expect(snapshotPlan).toHaveBeenCalledTimes(4)
      expect(lowBikeCalls()).toBe(1)
    })

    it('does not run with under a kilometre of biking left', async () => {
      respondWith(bikePlan(800))
      store = makeStore({}, bikePlan(800))
      await store.run(backgroundRouteCheck())
      expect(lowBikeCalls()).toBe(0)
    })

    it('offers what only the less-biking search found', async () => {
      // A feeder bus to the same arrival, 2 km less biking: absent from the
      // ordinary answer, present at bike reluctance 1.
      const feeder = plan({
        accessM: 400,
        accessMode: 'BICYCLE',
        arrive: NOW + 41 * MIN,
        board: NOW + 6 * MIN,
        route: '14',
        stop: STOP_B,
        trip: '1:t14'
      })
      snapshotPlan.mockImplementation(
        (combo: any) => () =>
          Promise.resolve({
            query: 'q',
            response:
              combo?.routingPreferences?.bikeReluctance === 1
                ? answer(bikePlan(2500), feeder)
                : answer(bikePlan(2500)),
            variables: {}
          })
      )
      store = makeStore({}, bikePlan(2500))
      await store.run(backgroundRouteCheck())
      const offer = store.goMode().fasterRoute
      expect(offer).toMatchObject({ kind: 'lessBike', source: 'low-bike' })
      expect(fasterRouteCopy(offer)).toEqual({
        detail: '14 · +1 min',
        title: '2.1 km less biking'
      })
    })
  })

  describe('56.2 — the aboard recorder settles on a HIGH match too', () => {
    const aboard = (confidence: string) => ({
      riding: { legIndex: 1, routeId: '1:A', tripId: '1:tA' },
      routeMatch: { isOnRoute: true, legIndex: 1 },
      vehicleMatch: {
        consecutiveFrames: 3,
        consecutiveMatches: 3,
        emptyPolls: 0,
        match: { confidence, tripId: '1:tA', vehicleId: 'v1' },
        nearbyVehicles: [],
        trackedRouteId: '1:A'
      }
    })
    const ticksAt = async (
      s: ReturnType<typeof makeStore>,
      seconds: number[]
    ) => {
      let last = 0
      for (const t of seconds) {
        clock.tick((t - last) * 1000)
        last = t
        await s.run(backgroundRouteCheck())
      }
    }

    it('high: 360 s between recordings aboard (was 90 s on 2026-10-17)', async () => {
      recording.mockReturnValue(true)
      respondWith(own())
      store = makeStore(aboard('high'))
      await ticksAt(store, [0, 90, 180, 270, 360, 450])
      expect(store.of('REROUTE_SNAPSHOT').length).toBe(2)
      // Aboard, the off-the-bus check never runs: every request was the recorder's.
      expect(snapshotPlan).toHaveBeenCalledTimes(2)
    })

    it('confirmed: still 360 s', async () => {
      recording.mockReturnValue(true)
      respondWith(own())
      store = makeStore(aboard('confirmed'))
      await ticksAt(store, [0, 90, 180, 270, 360])
      expect(store.of('REROUTE_SNAPSHOT').length).toBe(2)
    })

    it('a weaker match keeps the full 90 s record', async () => {
      recording.mockReturnValue(true)
      respondWith(own())
      store = makeStore(aboard('medium'))
      await ticksAt(store, [0, 90, 180])
      expect(store.of('REROUTE_SNAPSHOT').length).toBe(3)
    })

    it('aboard with recording off sends nothing at all', async () => {
      respondWith(own())
      store = makeStore(aboard('high'))
      await ticksAt(store, [0, 90, 180])
      expect(snapshotPlan).not.toHaveBeenCalled()
    })

    it('the manual capture still records', async () => {
      respondWith(own())
      store = makeStore()
      await store.run(captureRerouteSnapshot())
      expect(store.of('REROUTE_SNAPSHOT')).toHaveLength(1)
      expect(store.goMode().fasterRoute).toBeNull()
    })
  })

  describe('the root reducer carries the card', () => {
    it('SET / CLEAR reach goMode; a clear for another offer does not take this one; START clears it', () => {
      store = makeStore()
      const offer = { kind: 'faster', offerId: 'fr-x', routeSet: '1:14' }
      store.run((d: any) =>
        d({ payload: offer, type: 'SET_FASTER_ROUTE_OFFER' })
      )
      expect(store.goMode().fasterRoute).toEqual(offer)
      store.run((d: any) =>
        d({ payload: { offerId: 'fr-y' }, type: 'CLEAR_FASTER_ROUTE_OFFER' })
      )
      expect(store.goMode().fasterRoute).toEqual(offer)
      store.run((d: any) =>
        d({ payload: { offerId: 'fr-x' }, type: 'CLEAR_FASTER_ROUTE_OFFER' })
      )
      expect(store.goMode().fasterRoute).toBeNull()
      store.run((d: any) =>
        d({ payload: offer, type: 'SET_FASTER_ROUTE_OFFER' })
      )
      store.run((d: any) =>
        d({ payload: { itinerary: held() }, type: 'START_GO_MODE' })
      )
      expect(store.goMode().fasterRoute).toBeNull()
    })
  })
})

/* ------------------------------------------------------------------------ */
/* Replays of recorded rides                                                 */
/* ------------------------------------------------------------------------ */

const FIXTURES_DIR = path.join(
  __dirname,
  '../../lib/util/go-mode/replay/fixtures'
)
const hasFixture = (name: string) =>
  fs.existsSync(path.join(FIXTURES_DIR, `${name}.json`))

function heldAt(fx: any, t: number): any {
  let h = fx.itinerary
  const swaps = [...(fx.itinerarySwaps || [])].sort(
    (a: any, b: any) => a.tMs - b.tMs
  )
  for (const s of swaps) if (s.tMs <= t) h = s.itinerary
  return h
}

/**
 * Drive the real check over a recorded ride: at each recorded background
 * answer, the store holds the plan the rider was on, the fix the request was
 * planned from, and the riding fact by time; the check is handed that very
 * answer. Returns the offers raised.
 */
async function replayOffers(name: string): Promise<any[]> {
  const fx = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf8')
  )
  const snaps = [...(fx.rerouteSnapshots || [])].sort(
    (a: any, b: any) => a.tMs - b.tMs
  )
  const track = [...(fx.gpsTrack || [])].sort((a: any, b: any) => a.tMs - b.tMs)
  const clock = FakeTimers.install({
    now: snaps[0]?.tMs || NOW,
    toFake: ['Date']
  })
  let s: ReturnType<typeof makeStore> | null = null
  let sig: any = null
  try {
    for (const snap of snaps) {
      const t = snap.tMs
      clock.setSystemTime(t)
      const h = heldAt(fx, t)
      const remaining = remainingTransitLegs(h, t)
      const aboard = !!remaining.length && Number(remaining[0].startTime) <= t
      const from = snap.request?.from
      const f =
        track.find((p: any) => p.lat === from?.lat && p.lon === from?.lon) ||
        track.filter((p: any) => p.tMs <= t).slice(-1)[0]
      const position = {
        coords: {
          accuracy: f?.accuracy ?? 10,
          heading: f?.heading ?? null,
          latitude: from?.lat ?? f?.lat,
          longitude: from?.lon ?? f?.lon,
          speed: f?.speed ?? null
        },
        timestamp: t
      }
      const patch = {
        activeItinerary: h,
        // A swap clears the card (START_GO_MODE).
        ...(sig !== h ? { fasterRoute: null } : {}),
        riding: aboard
          ? { legIndex: -1, tripId: legTripId(remaining[0]) }
          : null,
        tracking: { ...(s?.goMode().tracking || {}), lastPosition: position }
      }
      if (!s) s = makeStore(patch, h)
      else s.patch(patch)
      sig = h
      // The recorded answer; the less-biking query was never recorded, so it
      // answers nothing here.
      snapshotPlan.mockImplementation(
        (combo: any) => () =>
          Promise.resolve({
            query: 'q',
            response:
              combo?.routingPreferences?.bikeReluctance === 1
                ? answer()
                : snap.response,
            variables: {}
          })
      )
      await s.run(backgroundRouteCheck())
    }
    return s
      ? s
          .of('FASTER_ROUTE_OFFER')
          .filter((a) => a.payload.outcome === 'offered')
          .map((a) => a.payload)
      : []
  } finally {
    s?.run(endGoMode())
    clock.uninstall()
  }
}

describe('replays of recorded rides (fixtures present on rwtpc4)', () => {
  beforeEach(() => {
    snapshotPlan.mockReset()
    recording.mockReturnValue(false)
    visibility = 'visible'
  })

  // Absent fixtures (not committed) leave these as no-ops, the house convention.
  it('2026-10-17 16:39 Orange Line: no card (the rider was on the best route)', async () => {
    if (!hasFixture('orange-1639-1017')) return
    expect(await replayOffers('orange-1639-1017')).toEqual([])
  }, 120000)

  const offering = ['ride-0930-1648', 'orange-1008-1601'].filter(hasFixture)
  it('a ride with a real better route does put one up', async () => {
    if (!offering.length) return
    let total = 0
    for (const name of offering) {
      const offers = await replayOffers(name)
      // eslint-disable-next-line no-console
      console.log(
        `[faster-route replay] ${name}: ${offers.length} offer(s) ` +
          offers
            .map(
              (o) => `${o.kind} ${o.savingMin}min/${o.bikeSavedKm}km ${o.route}`
            )
            .join('; ')
      )
      total += offers.length
    }
    expect(total).toBeGreaterThan(0)
  }, 300000)
})

/**
 * Measurement (FR_MEASURE=1 only): every fixture's recorded answers through the
 * real check — offers per ride against B1's latch-only count — and the
 * background requests a ride now sends against what the recorder sent.
 * "After" is estimated on a 90 s tick from the first fix to the last answer:
 * off the bus with transit left and not in a swap's quiet minute = one
 * request, plus the less-biking query once per plan-and-leg with ≥ 1 km of
 * biking left; aboard = nothing (recording off) or one per 360 s (recording
 * on, match high). "Before" is the recorder's own count in the fixture (it
 * ran only while recording).
 */
;(process.env.FR_MEASURE ? describe : describe.skip)('FR_MEASURE', () => {
  it('prints offers and request counts per ride', async () => {
    const files = fs
      .readdirSync(FIXTURES_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
    const rows: string[] = []
    let offersTotal = 0
    let ridesWithOffers = 0
    const req = { afterOff: 0, afterRec: 0, before: 0 }
    for (const file of files) {
      const name = file.replace(/\.json$/, '')
      const fx = JSON.parse(
        fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8')
      )
      const snaps = fx.rerouteSnapshots || []
      if (!snaps.length || !fx.itinerary) continue
      snapshotPlan.mockReset()
      const offers = await replayOffers(name)
      offersTotal += offers.length
      if (offers.length) ridesWithOffers++
      // Request estimate.
      const track = [...(fx.gpsTrack || [])].sort(
        (a: any, b: any) => a.tMs - b.tMs
      )
      const t0 = track[0]?.tMs ?? snaps[0].tMs
      const t1 = Math.max(...snaps.map((x: any) => x.tMs))
      const swaps = (fx.itinerarySwaps || []).map((x: any) => x.tMs)
      let off = 0
      let aboardRec = 0
      let lastAboardRec = -Infinity
      const lowKeys = new Set<string>()
      for (let t = t0 + 90000; t <= t1; t += 90000) {
        const h = heldAt(fx, t)
        const remaining = remainingTransitLegs(h, t)
        if (!remaining.length) continue
        const aboard = Number(remaining[0].startTime) <= t
        if (aboard) {
          if (t - lastAboardRec >= 360000) {
            aboardRec++
            lastAboardRec = t
          }
          continue
        }
        if (swaps.some((sw: number) => t >= sw && t - sw < 60000)) continue
        off++
        const legs = h.legs || []
        const li = legs.findIndex((l: any) => Number(l.endTime) > t)
        const bikeLeft = legs
          .slice(Math.max(0, li))
          .reduce(
            (m: number, l: any) =>
              m + (l.mode === 'BICYCLE' ? Number(l.distance) || 0 : 0),
            0
          )
        const key = `${legs.map((l: any) => l.startTime).join(',')}#${li}`
        if (bikeLeft >= 1000 && !lowKeys.has(key)) lowKeys.add(key)
      }
      const afterOff = off + lowKeys.size
      const afterRec = afterOff + aboardRec
      req.afterOff += afterOff
      req.afterRec += afterRec
      req.before += snaps.length
      rows.push(
        `${name.padEnd(40)} offers=${offers.length} ` +
          offers
            .map(
              (o) =>
                `[${o.kind} ${o.savingMin}m ${o.bikeSavedKm}km ${o.route} ${o.source}]`
            )
            .join('') +
          `  requests before(rec)=${snaps.length} after(off)=${afterOff} (low-bike ${lowKeys.size}) after(rec)=${afterRec}`
      )
    }
    // eslint-disable-next-line no-console
    console.log(
      rows.join('\n') +
        `\nTOTAL offers=${offersTotal} on ${ridesWithOffers} rides; requests before(rec)=${req.before} after(off)=${req.afterOff} after(rec)=${req.afterRec}`
    )
  }, 900000)
})
