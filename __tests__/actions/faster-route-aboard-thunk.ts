/* globals afterEach, beforeEach, describe, expect, it, jest */
import '../test-utils/mock-window-url'
import fs from 'fs'
import path from 'path'

import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import {
  ABOARD_CHECK_INTERVAL_MS,
  aboardCheckWindow,
  FASTER_ROUTE_NOTICE_ID
} from '../../lib/util/go-mode/faster-route-offer'
import {
  aboardPlanDeadWhy,
  compareAlightOffer,
  routeSetOf
} from '../../lib/util/go-mode/faster-route'
import {
  aboardRouteCheck,
  acceptFasterRoute,
  endGoMode,
  keepCurrentRoute
} from '../../lib/actions/go-mode'
import {
  buildFasterRouteNotice,
  fasterRouteCopy
} from '../../lib/util/go-mode/notification-service'
import {
  convertPlanResponseItineraries,
  fetchOnboardCandidatePlan,
  findTrip
} from '../../lib/actions/apiV2'
import { legTripId } from '../../lib/util/go-mode/leg-merge'
import { sendPush } from '../../lib/util/go-mode/native-notify'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'

jest.mock('../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  fetchRerouteSnapshotPlan: jest.fn(
    () => () => Promise.resolve({ response: { data: { plan: null } } })
  ),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
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

const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
const mockedFindTrip = findTrip as jest.Mock
const pushed = sendPush as jest.Mock

/**
 * Backlog 56.1, cycle 25 B4 — the aboard get-off offer: "4 min faster · off at
 * 30th Ave". On the bus, every 360 s from two stops after boarding, the
 * onboard optimizer is asked READ-ONLY (no onboard UI, no reroute
 * bookkeeping), B1's compareAlightOffer judges it against "off at the planned
 * stop, onto the planned onward trip" in the same answer, and — unless that
 * connection is already lost — one card goes up. Never applied without a tap.
 * Every plain action goes through the REAL root reducer.
 */

const MIN = 60000
const NOW = Date.UTC(2026, 9, 18, 22, 0, 0) // 17:00 Chicago
const STOP_GAP_MS = 3 * MIN
/** Stop i sits 1.1 km north of stop i-1; the bus reaches stop 4 at NOW. */
const stopLat = (i: number) => 44.8 + i * 0.01
const LON = -93.27
const DEST: [number, number] = [44.89, -93.25]
const stopId = (i: number) => `1:S${i}`
const stopName = (i: number) => `Stop ${i}`
const stopAt = (i: number) => NOW + (i - 4) * STOP_GAP_MS
const RIDDEN = '1:T'
const ONWARD = '1:O'

/** The ridden trip's stop times: timetable only (no realtime), 3 min apart. */
const trip = {
  geometry: {
    points: encode(
      Array.from(
        { length: 10 },
        (_, i) => [stopLat(i), LON] as [number, number]
      )
    )
  },
  id: RIDDEN,
  route: { id: '1:539', shortName: '539' },
  stopTimes: Array.from({ length: 10 }, (_, i) => ({
    realtimeState: 'SCHEDULED',
    scheduledArrival: 61200 + (i - 4) * 180,
    scheduledDeparture: 61200 + (i - 4) * 180,
    serviceDay: Math.floor(Date.UTC(2026, 9, 18, 5) / 1000),
    stop: {
      id: stopId(i),
      lat: stopLat(i),
      lon: LON,
      name: stopName(i)
    }
  }))
}

const place = (lat: number, lon: number, name: string, id?: string) => ({
  lat,
  lon,
  name,
  ...(id ? { stop: { gtfsId: id } } : {})
})

/**
 * The plan the rider holds: on the 539 from stop 1 to stop 7 (09 min away),
 * walk 1 min, the 901 at +12, then 2 km of biking home at +30.
 */
function heldPlan(opts: { onwardBoard?: number } = {}): any {
  const board = opts.onwardBoard ?? NOW + 12 * MIN
  const legs = [
    {
      distance: 7000,
      duration: (stopAt(7) - stopAt(1)) / 1000,
      endTime: stopAt(7),
      from: place(stopLat(1), LON, stopName(1), stopId(1)),
      legGeometry: {
        points: encode([
          [stopLat(1), LON],
          [stopLat(7), LON]
        ])
      },
      mode: 'BUS',
      route: { id: '1:539', shortName: '539' },
      routeShortName: '539',
      startTime: stopAt(1),
      to: place(stopLat(7), LON, stopName(7), stopId(7)),
      transitLeg: true,
      trip: { gtfsId: RIDDEN }
    },
    {
      distance: 100,
      duration: 60,
      endTime: stopAt(7) + MIN,
      from: place(stopLat(7), LON, stopName(7), stopId(7)),
      legGeometry: {
        points: encode([
          [stopLat(7), LON],
          [stopLat(7), LON + 0.001]
        ])
      },
      mode: 'WALK',
      startTime: stopAt(7),
      to: place(stopLat(7), LON + 0.001, 'P7', '1:P7'),
      transitLeg: false
    },
    {
      distance: 6000,
      duration: (NOW + 22 * MIN - board) / 1000,
      endTime: NOW + 22 * MIN,
      from: place(stopLat(7), LON + 0.001, 'P7', '1:P7'),
      legGeometry: {
        points: encode([
          [stopLat(7), LON + 0.001],
          [DEST[0] - 0.02, DEST[1]]
        ])
      },
      mode: 'BUS',
      route: { id: '1:901', shortName: '901' },
      routeShortName: '901',
      startTime: board,
      to: place(DEST[0] - 0.02, DEST[1], 'Near home', '1:H'),
      transitLeg: true,
      trip: { gtfsId: ONWARD }
    },
    {
      distance: 2000,
      duration: 480,
      endTime: NOW + 30 * MIN,
      from: place(DEST[0] - 0.02, DEST[1], 'Near home', '1:H'),
      legGeometry: { points: encode([[DEST[0] - 0.02, DEST[1]], DEST]) },
      mode: 'BICYCLE',
      startTime: NOW + 22 * MIN,
      to: place(DEST[0], DEST[1], 'Home'),
      transitLeg: false
    }
  ]
  return {
    duration: (NOW + 30 * MIN - stopAt(1)) / 1000,
    endTime: NOW + 30 * MIN,
    legs,
    startTime: stopAt(1)
  }
}

/**
 * One onward itinerary from stop `i`: a short walk, one bus, then `bikeM` of
 * biking home. Starts when the bus reaches the stop.
 */
function onward(
  i: number,
  opts: {
    arrive: number
    bikeM?: number
    board: number
    boardStop?: string
    route: string
    trip: string
  }
): any {
  const start = stopAt(i)
  const bikeM = opts.bikeM ?? 2000
  const alight = opts.arrive - 8 * MIN
  const boardStop = opts.boardStop ?? `1:B${i}`
  return {
    duration: (opts.arrive - start) / 1000,
    endTime: opts.arrive,
    legs: [
      {
        distance: 100,
        duration: (opts.board - start) / 1000,
        endTime: opts.board,
        from: place(stopLat(i), LON, stopName(i)),
        legGeometry: {
          points: encode([
            [stopLat(i), LON],
            [stopLat(i), LON + 0.001]
          ])
        },
        mode: 'WALK',
        startTime: start,
        to: place(stopLat(i), LON + 0.001, boardStop, boardStop),
        transitLeg: false
      },
      {
        distance: 6000,
        duration: (alight - opts.board) / 1000,
        endTime: alight,
        from: place(stopLat(i), LON + 0.001, boardStop, boardStop),
        legGeometry: {
          points: encode([
            [stopLat(i), LON + 0.001],
            [DEST[0] - 0.02, DEST[1]]
          ])
        },
        mode: 'BUS',
        route: { id: `1:${opts.route}`, shortName: opts.route },
        routeShortName: opts.route,
        startTime: opts.board,
        to: place(DEST[0] - 0.02, DEST[1], 'Near home', '1:H'),
        transitLeg: true,
        trip: { gtfsId: opts.trip }
      },
      {
        distance: bikeM,
        duration: (opts.arrive - alight) / 1000,
        endTime: opts.arrive,
        from: place(DEST[0] - 0.02, DEST[1], 'Near home', '1:H'),
        legGeometry: { points: encode([[DEST[0] - 0.02, DEST[1]], DEST]) },
        mode: 'BICYCLE',
        startTime: alight,
        to: place(DEST[0], DEST[1], 'Home'),
        transitLeg: false
      }
    ],
    startTime: start
  }
}

/** The planned continuation from stop 7: the 901 at +12, home at +30. */
const plannedFrom7 = (extra: Partial<Parameters<typeof onward>[1]> = {}) =>
  onward(7, {
    arrive: NOW + 30 * MIN,
    board: NOW + 12 * MIN,
    boardStop: '1:P7',
    route: '901',
    trip: ONWARD,
    ...extra
  })
/** Off at stop 5 for the 14: home at +26, 4 min sooner. */
const fourteenFrom5 = () =>
  onward(5, {
    arrive: NOW + 26 * MIN,
    board: NOW + 5 * MIN,
    route: '14',
    trip: '1:t14'
  })
/** Off at stop 6 for the 23: home a minute later, 1.5 km less biking. */
const lessBikeFrom6 = () =>
  onward(6, {
    arrive: NOW + 31 * MIN,
    bikeM: 500,
    board: NOW + 8 * MIN,
    route: '23',
    trip: '1:t23'
  })

/** Answers by stop index; anything not named fails like a timeout. */
let answers: Record<number, any[]> = {}
let asked: string[] = []
const answerFor = (combo: any) => {
  const i = Array.from({ length: 10 }, (_, k) => k).find(
    (k) => combo.from.name === stopName(k)
  )
  asked.push(combo.from.name)
  const its = i != null ? answers[i] : null
  return Promise.resolve(
    its ? { error: false, itineraries: its } : { error: true, itineraries: [] }
  )
}

let visibility: DocumentVisibilityState = 'visible'
Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => visibility
})

const fixAt = (lat: number, lon: number, ts: number): any => ({
  coords: {
    accuracy: 8,
    altitude: null,
    altitudeAccuracy: null,
    heading: 0,
    latitude: lat,
    longitude: lon,
    speed: 10
  },
  timestamp: ts
})

/**
 * A vehicle id per test: the optimizer keeps the last run's per-stop answers
 * (module scope, keyed by trip + vehicle) to fill a later run's holes, which
 * is right on a ride and a leak between cases.
 */
let vehicleSeq = 0
const riding = (extra: any = {}) => ({
  boardedAt: stopAt(1),
  headsign: 'Mall of America',
  legIndex: 0,
  offRouteSince: null,
  routeId: '1:539',
  routeShortName: '539',
  tripId: RIDDEN,
  vehicleId: `v539-${vehicleSeq}`,
  ...extra
})

/** A Go Mode store over the REAL root reducer, aboard at stop `at`. */
function makeStore(
  goModePatch: any = {},
  itinerary: any = heldPlan(),
  opts: { at?: number; tripHeld?: boolean } = {}
) {
  const reducer = createOtpReducer({ homeTimezone: 'America/Chicago' } as any)
  let otp: any = reducer(undefined, { type: '@@INIT' })
  const at = opts.at ?? 4
  otp = {
    ...otp,
    config: { ...otp.config, homeTimezone: 'America/Chicago' },
    currentQuery: { ...otp.currentQuery, routingPreferences: {} },
    goMode: {
      ...otp.goMode,
      activeItinerary: itinerary,
      isActive: true,
      progress: null,
      riding: riding(),
      tracking: {
        ...otp.goMode.tracking,
        lastPosition: fixAt(stopLat(at), LON, NOW - 10 * MIN)
      },
      ...goModePatch
    },
    transitIndex: {
      ...(otp.transitIndex || {}),
      trips: opts.tripHeld ? { [RIDDEN]: trip } : {}
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
  mockedFindTrip.mockImplementation(({ tripId }: any) => () => {
    const t = tripId === RIDDEN ? trip : null
    if (t) {
      otp = {
        ...otp,
        transitIndex: {
          ...otp.transitIndex,
          trips: { ...(otp.transitIndex?.trips || {}), [tripId]: t }
        }
      }
    }
    return Promise.resolve(t)
  })
  return {
    actions,
    goMode: () => otp.goMode,
    moveTo: (i: number) => {
      otp = {
        ...otp,
        goMode: {
          ...otp.goMode,
          tracking: {
            ...otp.goMode.tracking,
            lastPosition: fixAt(stopLat(i), LON, Date.now())
          }
        }
      }
    },
    of: (type: string) => actions.filter((a) => a.type === type),
    patch: (p: any) => {
      otp = { ...otp, goMode: { ...otp.goMode, ...p } }
    },
    run: (thunk: any) => thunk(dispatch, getState)
  }
}

const UI_TYPES = [
  'START_ONBOARD_OPTIMIZE',
  'SET_ONBOARD_RESULT',
  'SET_ONBOARD_STATUS',
  'BEGIN_ONBOARD_FLOW',
  'START_REROUTE',
  'SET_REROUTE_RESULT',
  'CLEAR_REROUTE'
]

describe('aboard faster-route offer (56.1, cycle 25 B4)', () => {
  let clock: FakeTimers.InstalledClock
  let store: ReturnType<typeof makeStore> | undefined

  beforeEach(() => {
    mockedFetch.mockReset()
    mockedFetch.mockImplementation((combo: any) => () => answerFor(combo))
    mockedFindTrip.mockReset()
    pushed.mockClear()
    answers = {}
    asked = []
    vehicleSeq++
    visibility = 'visible'
    clock = FakeTimers.install({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    store?.run(endGoMode())
    store = undefined
    clock.uninstall()
  })

  it('offers "4 min faster · off at Stop 5", read-only: no onboard UI, no reroute, no swap', async () => {
    answers = { 5: [fourteenFrom5()], 7: [plannedFrom7()] }
    store = makeStore()
    const before = store.goMode()
    await store.run(aboardRouteCheck())

    const offer = store.goMode().fasterRoute
    expect(offer).not.toBeNull()
    expect(offer.kind).toBe('aboard')
    expect(offer.aboard).toMatchObject({ kind: 'faster', stopId: stopId(5) })
    expect(fasterRouteCopy(offer)).toEqual({
      detail: 'off at Stop 5',
      title: '4 min faster'
    })
    // Never applied, never the onboard UI, never reroute bookkeeping.
    expect(store.goMode().activeItinerary).toBe(before.activeItinerary)
    expect(store.goMode().onboard).toBe(before.onboard)
    expect(store.goMode().reRoute).toBe(before.reRoute)
    expect(store.goMode().riding).toBe(before.riding)
    expect(store.of('START_GO_MODE')).toHaveLength(0)
    expect(store.of('AUTO_REPLAN')).toHaveLength(0)
    expect(store.actions.filter((a) => UI_TYPES.includes(a.type))).toEqual([])
    expect(store.of('FASTER_ROUTE_OFFER')[0].payload).toMatchObject({
      aboardKind: 'faster',
      kind: 'aboard',
      outcome: 'offered',
      push: 'none',
      route: '14',
      savingMin: 4,
      stop: 'Stop 5'
    })
    // Cost: one trip read, one onward plan per candidate stop (the sampled
    // five plus the planned stop and the three before it).
    expect(mockedFindTrip).toHaveBeenCalledTimes(1)
    expect(asked.length).toBeGreaterThanOrEqual(4)
    expect(asked.length).toBeLessThanOrEqual(9)
    expect(asked).toEqual(expect.arrayContaining([4, 5, 6, 7].map(stopName)))
    expect(pushed).not.toHaveBeenCalled()
  })

  it('says "1.5 km less biking · off at Stop 6 · +1 min" for the same arrival with less biking', async () => {
    answers = { 6: [lessBikeFrom6()], 7: [plannedFrom7()] }
    store = makeStore()
    await store.run(aboardRouteCheck())
    const offer = store.goMode().fasterRoute
    expect(offer.aboard.kind).toBe('lessBike')
    expect(fasterRouteCopy(offer)).toEqual({
      detail: 'off at Stop 6 · +1 min',
      title: '1.5 km less biking'
    })
  })

  it('adds "+N km bike" when the faster way bikes 0.5 km more', async () => {
    answers = {
      5: [
        onward(5, {
          arrive: NOW + 25 * MIN,
          bikeM: 3800,
          board: NOW + 5 * MIN,
          route: '14',
          trip: '1:t14'
        })
      ],
      7: [plannedFrom7()]
    }
    store = makeStore()
    await store.run(aboardRouteCheck())
    expect(fasterRouteCopy(store.goMode().fasterRoute)).toEqual({
      detail: 'off at Stop 5 · +1.8 km bike',
      title: '5 min faster'
    })
  })

  it("Switch splices the ride onto the same bus — off at Stop 5 for the 14 — as the rider's choice", async () => {
    answers = { 5: [fourteenFrom5()], 7: [plannedFrom7()] }
    store = makeStore()
    await store.run(aboardRouteCheck())
    await store.run(acceptFasterRoute())
    // reconfirmBoardedVehicle re-locks the bus on the next macrotask.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const active = store.goMode().activeItinerary
    const transit = active.legs.filter((l: any) => l.transitLeg)
    expect(legTripId(transit[0])).toBe(RIDDEN)
    expect(transit[0].to.stop.gtfsId).toBe(stopId(5))
    expect(legTripId(transit[1])).toBe('1:t14')
    expect(store.goMode().riding?.tripId).toBe(RIDDEN)
    expect(store.goMode().fasterRoute).toBeNull()
    expect(store.of('AUTO_REPLAN').map((a) => a.payload)).toEqual([
      expect.objectContaining({
        accepted: true,
        autoApply: false,
        reason: 'faster-route-aboard'
      })
    ])
    expect(store.of('CONFIRM_VEHICLE').length).toBeGreaterThan(0)
    expect(
      store.of('FASTER_ROUTE_OFFER').map((a) => a.payload.outcome)
    ).toEqual(['offered', 'switched'])
  })

  it('Keep mine latches: the same stop is not offered again at the next check', async () => {
    answers = { 5: [fourteenFrom5()], 7: [plannedFrom7()] }
    store = makeStore()
    await store.run(aboardRouteCheck())
    store.run(keepCurrentRoute())
    expect(store.goMode().fasterRoute).toBeNull()
    clock.tick(ABOARD_CHECK_INTERVAL_MS)
    store.moveTo(4)
    await store.run(aboardRouteCheck())
    expect(store.goMode().fasterRoute).toBeNull()
    expect(
      store.of('FASTER_ROUTE_OFFER').map((a) => a.payload.outcome)
    ).toEqual(['offered', 'kept'])
  })

  describe('paced plans (56.1, 2026-10-19: the planned stop timed out in the burst)', () => {
    it('asks the planned stop first and alone, then the rest, and still offers', async () => {
      answers = { 5: [fourteenFrom5()], 7: [plannedFrom7()] }
      let inFlight = 0
      let peak = 0
      let firstAlone = false
      mockedFetch.mockImplementation((combo: any) => () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        if (asked.length === 0) firstAlone = inFlight === 1
        return new Promise((resolve) =>
          setTimeout(() => {
            inFlight--
            resolve(answerFor(combo))
          }, 5)
        )
      })
      store = makeStore()
      await store.run(aboardRouteCheck())
      expect(asked[0]).toBe(stopName(7))
      expect(firstAlone).toBe(true)
      expect(asked.length).toBeGreaterThan(2)
      expect(peak).toBeLessThanOrEqual(2)
      expect(store.goMode().fasterRoute?.aboard?.stopId).toBe(stopId(5))
      const [rec] = store.of('ABOARD_CHECK_VERDICT')
      expect(rec.payload).toMatchObject({
        plannedAnswered: true,
        plannedStopId: stopId(7),
        why: 'offer'
      })
    })

    it('when the planned stop fails, nothing else is asked and the verdict says no-baseline', async () => {
      answers = { 5: [fourteenFrom5()] }
      store = makeStore()
      await store.run(aboardRouteCheck())
      expect(asked).toEqual([stopName(7)])
      expect(store.goMode().fasterRoute).toBeNull()
      const [rec] = store.of('ABOARD_CHECK_VERDICT')
      expect(rec.payload).toMatchObject({
        answered: 0,
        plannedAnswered: false,
        why: 'no-baseline'
      })
    })
  })

  describe('plan-dead: no offer against a connection already lost', () => {
    it('the bus reaches the planned stop too late for the planned onward bus', async () => {
      // The 901 now leaves at +8.5: the bus is at stop 7 at +9, then a 1-min
      // walk. The recorded answer from stop 7 still (wrongly) carries it.
      const held = heldPlan({ onwardBoard: NOW + 8.5 * MIN })
      answers = {
        5: [fourteenFrom5()],
        7: [plannedFrom7({ board: NOW + 12 * MIN })]
      }
      store = makeStore({}, held)
      await store.run(aboardRouteCheck())
      expect(store.goMode().fasterRoute).toBeNull()
      // ...and it IS the plan-dead check doing it: the comparator alone offers.
      const results = [5, 7].map((i) => ({
        busArrivalEpoch: stopAt(i),
        itineraries: answers[i],
        realtime: false,
        stopId: stopId(i),
        stopName: stopName(i)
      }))
      expect(
        compareAlightOffer({
          nowMs: NOW,
          plannedOnwardTripId: ONWARD,
          plannedStopId: stopId(7),
          results
        }).why
      ).toBe('offer')
      expect(
        aboardPlanDeadWhy({
          heldTail: held.legs.slice(1),
          nowMs: NOW,
          plannedStopArrivalMs: stopAt(7),
          plannedStopId: stopId(7),
          results
        })
      ).toBe('connection-lost')
    })

    it('the answer catches the onward bus only further down the line', async () => {
      answers = {
        5: [fourteenFrom5()],
        7: [plannedFrom7({ board: NOW + 15 * MIN, boardStop: '1:P8' })]
      }
      store = makeStore()
      await store.run(aboardRouteCheck())
      expect(store.goMode().fasterRoute).toBeNull()
    })

    it('missed-bus recovery is running: nothing is even asked', async () => {
      answers = { 5: [fourteenFrom5()], 7: [plannedFrom7()] }
      store = makeStore({
        reRoute: {
          ...makeStore().goMode().reRoute,
          reason: 'missed-bus',
          status: 'none'
        }
      })
      await store.run(aboardRouteCheck())
      expect(store.goMode().fasterRoute).toBeNull()
      expect(mockedFindTrip).not.toHaveBeenCalled()
      expect(asked).toEqual([])
    })

    it('a street-only onward has no connection to lose', () => {
      expect(
        aboardPlanDeadWhy({
          heldTail: heldPlan().legs.slice(3),
          nowMs: NOW,
          plannedStopArrivalMs: NOW + 60 * MIN,
          plannedStopId: stopId(7),
          results: []
        })
      ).toBeNull()
    })
  })

  describe('cadence and the stop window', () => {
    it('asks every 360 s, not every 90 s tick', async () => {
      answers = { 5: [fourteenFrom5()], 7: [plannedFrom7()] }
      store = makeStore()
      await store.run(aboardRouteCheck())
      expect(mockedFindTrip).toHaveBeenCalledTimes(1)
      for (let k = 0; k < 3; k++) {
        clock.tick(90000)
        await store.run(aboardRouteCheck())
      }
      expect(mockedFindTrip).toHaveBeenCalledTimes(1)
      clock.tick(90000) // 360 s
      await store.run(aboardRouteCheck())
      expect(mockedFindTrip).toHaveBeenCalledTimes(2)
    })

    it('not until two stops after boarding — and that wait does not spend the slot', async () => {
      answers = { 5: [fourteenFrom5()], 7: [plannedFrom7()] }
      // Boarded at stop 1, the bus at stop 2: one stop in.
      store = makeStore({}, heldPlan(), { at: 2, tripHeld: true })
      await store.run(aboardRouteCheck())
      expect(mockedFindTrip).not.toHaveBeenCalled()
      expect(asked).toEqual([])
      store.moveTo(4)
      await store.run(aboardRouteCheck())
      expect(mockedFindTrip).toHaveBeenCalledTimes(1)
      expect(store.goMode().fasterRoute).not.toBeNull()
    })

    it('stops two stops from the planned stop', async () => {
      answers = { 7: [plannedFrom7()] }
      store = makeStore({}, heldPlan(), { at: 6, tripHeld: true })
      await store.run(aboardRouteCheck())
      expect(asked).toEqual([])
      expect(mockedFindTrip).not.toHaveBeenCalled()
    })

    it('the window rule itself', () => {
      const base = {
        anchorIdx: 4,
        boardIdx: 1,
        nowMs: NOW,
        plannedArrivalMs: NOW + 9 * MIN,
        plannedIdx: 7
      }
      expect(aboardCheckWindow(base)).toBeNull()
      expect(aboardCheckWindow({ ...base, anchorIdx: 3 })).toBeNull()
      expect(aboardCheckWindow({ ...base, anchorIdx: 2 })).toBe('just-boarded')
      // A four-stop leg (board 6, planned 10) gets its check at stop 8.
      expect(
        aboardCheckWindow({
          ...base,
          anchorIdx: 8,
          boardIdx: 6,
          plannedIdx: 10
        })
      ).toBeNull()
      expect(aboardCheckWindow({ ...base, anchorIdx: 6 })).toBe(
        'near-planned-stop'
      )
      expect(
        aboardCheckWindow({ ...base, plannedArrivalMs: NOW + 3.9 * MIN })
      ).toBe('near-planned-stop')
      expect(aboardCheckWindow({ ...base, plannedIdx: 3 })).toBe(
        'planned-stop-not-ahead'
      )
      // Boarding stop not on the trip read: 4 min aboard stands in.
      expect(
        aboardCheckWindow({ ...base, boardedAtMs: NOW - 3 * MIN, boardIdx: -1 })
      ).toBe('just-boarded')
      expect(
        aboardCheckWindow({ ...base, boardedAtMs: NOW - 5 * MIN, boardIdx: -1 })
      ).toBeNull()
    })

    it('never off the bus, and not on a bus the plan does not ride', async () => {
      answers = { 5: [fourteenFrom5()], 7: [plannedFrom7()] }
      store = makeStore({ riding: null })
      await store.run(aboardRouteCheck())
      store.patch({ riding: riding({ tripId: '1:another-run' }) })
      await store.run(aboardRouteCheck())
      expect(mockedFindTrip).not.toHaveBeenCalled()
      expect(asked).toEqual([])
    })

    it('silent with the onboard flow open, during a reroute, and in the minute after a swap', async () => {
      answers = { 5: [fourteenFrom5()], 7: [plannedFrom7()] }
      store = makeStore()
      const onboard = store.goMode().onboard
      const reRoute = store.goMode().reRoute
      store.patch({ onboard: { ...onboard, status: 'ready' } })
      await store.run(aboardRouteCheck())
      store.patch({ onboard, reRoute: { ...reRoute, status: 'searching' } })
      await store.run(aboardRouteCheck())
      expect(asked).toEqual([])
    })
  })

  describe('the card and the push', () => {
    it('push only with the phone not showing the app: "Faster route" / "4 min faster · off at Stop 5"', async () => {
      visibility = 'hidden'
      answers = { 5: [fourteenFrom5()], 7: [plannedFrom7()] }
      store = makeStore()
      await store.run(aboardRouteCheck())
      expect(pushed).toHaveBeenCalledTimes(1)
      expect(pushed.mock.calls[0][0]).toEqual({
        id: FASTER_ROUTE_NOTICE_ID,
        message: '4 min faster · off at Stop 5',
        priority: 1,
        title: 'Faster route'
      })
      expect(buildFasterRouteNotice(store.goMode().fasterRoute).title).toBe(
        'Faster route'
      )
    })

    it('lapses when a later check no longer sees it', async () => {
      // The 901 at +20, so the connection still stands six minutes on with the
      // bus held at stop 4 (the fix has not moved).
      const late = { board: NOW + 20 * MIN }
      answers = { 5: [fourteenFrom5()], 7: [plannedFrom7(late)] }
      store = makeStore({}, heldPlan({ onwardBoard: NOW + 20 * MIN }))
      await store.run(aboardRouteCheck())
      expect(store.goMode().fasterRoute).not.toBeNull()
      clock.tick(ABOARD_CHECK_INTERVAL_MS)
      answers = { 7: [plannedFrom7(late)] }
      await store.run(aboardRouteCheck())
      expect(store.goMode().fasterRoute).toBeNull()
      expect(store.of('FASTER_ROUTE_OFFER')[1].payload).toMatchObject({
        outcome: 'expired',
        why: 'not-seen'
      })
    })

    it('an offer up goes when the rider is no longer on that bus', async () => {
      answers = { 5: [fourteenFrom5()], 7: [plannedFrom7()] }
      store = makeStore()
      await store.run(aboardRouteCheck())
      store.patch({ riding: null })
      await store.run(aboardRouteCheck())
      expect(store.goMode().fasterRoute).toBeNull()
      expect(store.of('FASTER_ROUTE_OFFER')[1].payload.why).toBe('not-aboard')
    })

    it('a stop the bus reaches within two minutes is not offered (no time to ring)', async () => {
      // Off at stop 4 (the bus is there now) for a much faster bus.
      answers = {
        4: [
          onward(4, {
            arrive: NOW + 20 * MIN,
            board: NOW + 2 * MIN,
            route: '14',
            trip: '1:t14'
          })
        ],
        7: [plannedFrom7()]
      }
      store = makeStore()
      await store.run(aboardRouteCheck())
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
const loadFixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf8'))

function heldAt(fx: any, t: number): any {
  let h = fx.itinerary
  const swaps = [...(fx.itinerarySwaps || [])].sort(
    (a: any, b: any) => a.tMs - b.tMs
  )
  for (const s of swaps) if (s.tMs <= t) h = s.itinerary
  return h
}

/** The fixture's onboard optimizer answers, batched by run (≤ 30 s apart). */
function batchesOf(fx: any): any[][] {
  const ocp = [...(fx.onboardCandidatePlans || [])].sort(
    (a: any, b: any) => a.tMs - b.tMs
  )
  const out: any[][] = []
  for (const rec of ocp) {
    const last = out[out.length - 1]
    if (last && rec.tMs - last[last.length - 1].tMs <= 30000) last.push(rec)
    else out.push([rec])
  }
  return out
}

/** B1's aboard leg: the transit leg alighting at a candidate stop, else by time. */
function aboardLegAt(held: any, t: number, stopIds: Set<string>): number {
  const legs = held?.legs || []
  let i = legs.findIndex(
    (l: any) => l.transitLeg && stopIds.has(l.to?.stop?.gtfsId)
  )
  if (i < 0) {
    i = legs.findIndex(
      (l: any) => l.transitLeg && l.startTime <= t && l.endTime > t
    )
  }
  return i
}

const convert = (response: any): any[] => {
  try {
    return convertPlanResponseItineraries(
      JSON.parse(JSON.stringify(response)),
      {
        combo: {},
        config: { transitOperators: [] },
        query: {},
        strictModes: false,
        validModeCombinations: undefined
      } as any
    )
  } catch {
    return response?.data?.plan?.itineraries || []
  }
}

function tripAt(fx: any, tripId: string, t: number): any {
  const snaps = (fx.tripSnapshots || []).filter(
    (s: any) => (s.tripId ?? s.payload?.id) === tripId
  )
  if (!snaps.length) return null
  const before = snaps.filter((s: any) => s.tMs <= t)
  return (before.length ? before[before.length - 1] : snaps[0]).payload
}

function gpsAt(fx: any, t: number): any {
  const track = fx.gpsTrack || []
  let f = track[0]
  for (const p of track) {
    if (p.tMs <= t) f = p
    else break
  }
  return f
}

/**
 * Drive the REAL aboard check over a recorded ride, at each recorded onboard
 * optimizer run: the store holds the plan, the fix, the riding fact (the
 * aboard leg's trip) and the trip read of that moment; the candidate plans are
 * served from the recording by origin (an origin the phone never asked
 * resolves as a failed plan). `cadence` keeps the 360 s rule across batches;
 * without it each batch is judged on its own (the comparator's view).
 */
async function replayAboard(
  name: string,
  opts: { cadence: boolean }
): Promise<{
  actions: any[]
  asked: number
  batches: number
  checks: number
  dead: number
  offers: any[]
}> {
  const fx = loadFixture(name)
  const batches = batchesOf(fx)
  const actions: any[] = []
  const out = {
    actions,
    asked: 0,
    batches: batches.length,
    checks: 0,
    dead: 0,
    offers: [] as any[]
  }
  if (!batches.length) return out
  const fclock = FakeTimers.install({
    now: batches[0][0].tMs,
    toFake: ['Date']
  })
  const reducer = createOtpReducer({ homeTimezone: 'America/Chicago' } as any)
  let otp: any = reducer(undefined, { type: '@@INIT' })
  otp = {
    ...otp,
    config: { ...otp.config, homeTimezone: 'America/Chicago' },
    currentQuery: { ...otp.currentQuery, routingPreferences: {} },
    goMode: { ...otp.goMode, isActive: true }
  }
  const getState = () => ({ otp, router: { location: { pathname: '/' } } })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    otp = reducer(otp, action)
    return action
  }
  try {
    for (const batch of batches) {
      const t = batch[0].tMs
      fclock.setSystemTime(t)
      const held = heldAt(fx, t)
      const i = aboardLegAt(held, t, new Set(batch.map((r: any) => r.stopId)))
      if (i < 0) continue
      const leg = held.legs[i]
      const tripId = legTripId(leg)
      const tr = tripId ? tripAt(fx, tripId, t) : null
      if (!tr) continue
      const f = gpsAt(fx, t)
      if (!opts.cadence) {
        // Each batch judged alone: a fresh trip session (latch and cadence).
        dispatch(endGoMode())
      }
      otp = {
        ...otp,
        goMode: {
          ...otp.goMode,
          activeItinerary: held,
          isActive: true,
          riding: {
            boardedAt: Number(leg.startTime),
            headsign: leg.headsign ?? null,
            legIndex: i,
            offRouteSince: null,
            routeId: leg.route?.id ?? leg.routeId ?? null,
            routeShortName: leg.routeShortName ?? null,
            tripId,
            vehicleId: null
          },
          tracking: {
            ...otp.goMode.tracking,
            lastPosition: {
              coords: {
                accuracy: f?.accuracy ?? 10,
                heading: f?.heading ?? null,
                latitude: f?.lat,
                longitude: f?.lon,
                speed: f?.speed ?? null
              },
              timestamp: t
            }
          }
        },
        transitIndex: {
          ...(otp.transitIndex || {}),
          trips: { [tripId as string]: tr }
        }
      }
      mockedFindTrip.mockImplementation(() => () => Promise.resolve(tr))
      let n = 0
      mockedFetch.mockImplementation((combo: any) => () => {
        n++
        const rec = batch.find(
          (r: any) =>
            r.request?.from?.lat === combo.from.lat &&
            r.request?.from?.lon === combo.from.lon
        )
        return Promise.resolve(
          rec
            ? { error: false, itineraries: convert(rec.response) }
            : { error: true, itineraries: [] }
        )
      })
      const before = actions.length
      await dispatch(aboardRouteCheck())
      if (n) out.checks++
      out.asked += n
      const offered = actions
        .slice(before)
        .filter(
          (a) =>
            a.type === 'FASTER_ROUTE_OFFER' && a.payload.outcome === 'offered'
        )
      out.offers.push(...offered.map((a) => a.payload))
    }
    return out
  } finally {
    dispatch(endGoMode())
    fclock.uninstall()
  }
}

const NAMED = [
  'orange-alight-rank-0915-1534',
  'ride-1015-2130',
  'ride-1015-1747',
  'gold-74-1105',
  'blue-bike-534-2127'
]

describe('replays of recorded rides (fixtures present on rwtpc4)', () => {
  beforeEach(() => {
    mockedFetch.mockReset()
    mockedFindTrip.mockReset()
    pushed.mockClear()
    visibility = 'visible'
  })

  // Absent fixtures (not committed) leave these as no-ops, the house convention.
  const present = NAMED.filter(hasFixture)
  it('never touches onboard.status or reRoute, never applies an offer', async () => {
    for (const name of present) {
      const batches = batchesOf(loadFixture(name))
      const r = await replayAboard(name, { cadence: false })
      expect(r.actions.filter((a) => UI_TYPES.includes(a.type))).toEqual([])
      expect(
        r.actions.filter(
          (a) => a.type === 'START_GO_MODE' || a.type === 'AUTO_REPLAN'
        )
      ).toEqual([])
      // eslint-disable-next-line no-console
      console.log(
        `[aboard replay] ${name}: ${batches.length} optimizer runs, ` +
          `${r.checks} checks asked ${r.asked} plans, ${r.offers.length} offer(s) ` +
          r.offers
            .map(
              (o) =>
                `${o.aboardKind} ${o.savingMin}min/${o.bikeSavedKm}km off at ${o.stop} → ${o.route}`
            )
            .join('; ')
      )
    }
  }, 600000)

  it('2026-10-17 16:39 Orange Line: no aboard offer', async () => {
    if (!hasFixture('orange-1639-1017')) return
    const fx = loadFixture('orange-1639-1017')
    expect(batchesOf(fx)).toHaveLength(0)
    const r = await replayAboard('orange-1639-1017', { cadence: true })
    expect(r.offers).toEqual([])
  })
})

/**
 * Measurement (FR_MEASURE=1 only), every fixture:
 *
 * 1. The comparator over every recorded onboard optimizer run (B1's table):
 *    how many runs compareAlightOffer offers on, and how many of those the
 *    plan-dead check removes, with the reason.
 * 2. The real thunk over the same runs: offers per ride with the 360 s cadence
 *    and the latch.
 * 3. Requests per ride: the real thunk driven every 90 s across each aboard
 *    leg of the held plan (fixes from the ride's own track), counting trip
 *    reads and candidate plans actually sent.
 */
;(process.env.FR_MEASURE ? describe : describe.skip)(
  'FR_MEASURE aboard',
  () => {
    it('prints the comparator, the plan-dead removals, offers and requests per ride', async () => {
      const files = fs
        .readdirSync(FIXTURES_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort()
      const rows: string[] = []
      const tot = {
        batches: 0,
        checks: 0,
        dead: {} as Record<string, number>,
        deadOfFaster: 0,
        deadOfLess: 0,
        faster: 0,
        findTrips: 0,
        less: 0,
        offersThunk: 0,
        plans: 0,
        rides: 0,
        ridesAboard: 0
      }
      for (const file of files) {
        const name = file.replace(/\.json$/, '')
        const fx = loadFixture(name)
        if (!fx.itinerary) continue
        tot.rides++
        // 1. comparator
        for (const batch of batchesOf(fx)) {
          tot.batches++
          const t = batch[0].tMs
          const held = heldAt(fx, t)
          const i = aboardLegAt(
            held,
            t,
            new Set(batch.map((r: any) => r.stopId))
          )
          if (i < 0) continue
          const legs = held.legs || []
          const plannedStopId = legs[i].to?.stop?.gtfsId
          const onwardLeg = legs.slice(i + 1).find((l: any) => l.transitLeg)
          const results = batch.map((r: any) => ({
            busArrivalEpoch: r.request?.busArrivalEpoch,
            itineraries: r.response?.data?.plan?.itineraries || [],
            realtime: true,
            stopId: r.stopId,
            stopName: r.request?.from?.name || r.stopId
          }))
          const v = compareAlightOffer({
            nowMs: t,
            plannedOnwardTripId: onwardLeg ? legTripId(onwardLeg) : null,
            plannedStopId,
            results
          })
          if (!v.kind) continue
          if (v.kind === 'faster') tot.faster++
          else tot.less++
          const planned = results.find((r: any) => r.stopId === plannedStopId)
          const dead = aboardPlanDeadWhy({
            heldTail: legs.slice(i + 1),
            nowMs: t,
            plannedStopArrivalMs: planned?.busArrivalEpoch ?? null,
            plannedStopId,
            results
          })
          const hhmm = new Date(t).toLocaleTimeString('en-GB', {
            timeZone: 'America/Chicago'
          })
          rows.push(
            `  ${name.padEnd(36)} ${hhmm} ${v.kind} saving=${(
              v.savingMs / MIN
            ).toFixed(1)}m bike-${v.bikeSavedM}m off at ${
              v.candidate?.stopName
            } [${routeSetOf(v.candidate?.itinerary) || 'bike'}] → ${
              dead ? 'DEAD ' + dead : 'stands'
            }`
          )
          if (dead) {
            tot.dead[dead] = (tot.dead[dead] || 0) + 1
            if (v.kind === 'faster') tot.deadOfFaster++
            else tot.deadOfLess++
          }
        }
        // 2. thunk with cadence + latch
        const r = await replayAboard(name, { cadence: true })
        tot.offersThunk += r.offers.length
        if (r.offers.length) {
          rows.push(
            `  THUNK ${name}: ${r.offers.length} offer(s) ` +
              r.offers
                .map(
                  (o) =>
                    `${o.aboardKind} ${o.savingMin}m/${o.bikeSavedKm}km off at ${o.stop}`
                )
                .join('; ')
          )
        }
        // 3. requests per ride
        const req = await requestsPerRide(fx)
        if (req.aboardMs > 0) {
          tot.ridesAboard++
          tot.checks += req.checks
          tot.findTrips += req.findTrips
          tot.plans += req.plans
          rows.push(
            `  REQ ${name.padEnd(36)} aboard ${(req.aboardMs / MIN).toFixed(
              0
            )} min: checks=${req.checks} findTrip=${req.findTrips} plans=${
              req.plans
            }`
          )
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        rows.join('\n') +
          `\nCOMPARATOR batches=${tot.batches} faster=${tot.faster} lessBike=${tot.less}` +
          ` plan-dead removes faster=${tot.deadOfFaster} lessBike=${
            tot.deadOfLess
          } ${JSON.stringify(tot.dead)}` +
          `\nTHUNK offers (cadence+latch)=${tot.offersThunk} over ${tot.rides} rides` +
          `\nREQUESTS rides aboard=${tot.ridesAboard} checks=${tot.checks} findTrip=${tot.findTrips} plans=${tot.plans}`
      )
    }, 1800000)
  }
)

/**
 * The real thunk, ticked every 90 s across each aboard leg of the plan the
 * rider held, with the trip read and fix of that moment; every candidate plan
 * fails fast (only the count matters).
 */
async function requestsPerRide(fx: any): Promise<{
  aboardMs: number
  checks: number
  findTrips: number
  plans: number
}> {
  const out = { aboardMs: 0, checks: 0, findTrips: 0, plans: 0 }
  const track = [...(fx.gpsTrack || [])].sort((a: any, b: any) => a.tMs - b.tMs)
  if (!track.length) return out
  const t0 = track[0].tMs
  const t1 = track[track.length - 1].tMs
  const fclock = FakeTimers.install({ now: t0, toFake: ['Date'] })
  const reducer = createOtpReducer({ homeTimezone: 'America/Chicago' } as any)
  let otp: any = reducer(undefined, { type: '@@INIT' })
  otp = {
    ...otp,
    config: { ...otp.config, homeTimezone: 'America/Chicago' },
    currentQuery: { ...otp.currentQuery, routingPreferences: {} },
    goMode: { ...otp.goMode, isActive: true }
  }
  const getState = () => ({ otp, router: { location: { pathname: '/' } } })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    otp = reducer(otp, action)
    return action
  }
  mockedFetch.mockImplementation(() => () => {
    out.plans++
    return Promise.resolve({ error: true, itineraries: [] })
  })
  let lastSig: any = null
  try {
    for (let t = t0; t <= t1; t += 90000) {
      fclock.setSystemTime(t)
      const held = heldAt(fx, t)
      const legs = held?.legs || []
      const i = legs.findIndex(
        (l: any) => l.transitLeg && l.startTime <= t && l.endTime > t
      )
      if (i < 0) continue
      out.aboardMs += 90000
      const leg = legs[i]
      const tripId = legTripId(leg)
      const tr = tripId ? tripAt(fx, tripId, t) : null
      const f = gpsAt(fx, t)
      if (held !== lastSig) {
        // A swap: the check's quiet minute starts over in the app; here the
        // session simply carries on (the count is an upper bound).
        lastSig = held
      }
      otp = {
        ...otp,
        goMode: {
          ...otp.goMode,
          activeItinerary: held,
          riding: {
            boardedAt: Number(leg.startTime),
            headsign: null,
            legIndex: i,
            offRouteSince: null,
            routeId: leg.route?.id ?? null,
            routeShortName: leg.routeShortName ?? null,
            tripId,
            vehicleId: null
          },
          tracking: {
            ...otp.goMode.tracking,
            lastPosition: {
              coords: {
                accuracy: f?.accuracy ?? 10,
                heading: f?.heading ?? null,
                latitude: f?.lat,
                longitude: f?.lon,
                speed: f?.speed ?? null
              },
              timestamp: t
            }
          }
        },
        transitIndex: {
          ...(otp.transitIndex || {}),
          trips: tr && tripId ? { [tripId]: tr } : {}
        }
      }
      mockedFindTrip.mockImplementation(() => () => {
        out.findTrips++
        return Promise.resolve(tr)
      })
      const before = out.findTrips
      await dispatch(aboardRouteCheck())
      if (out.findTrips > before) out.checks++
    }
    return out
  } finally {
    dispatch(endGoMode())
    fclock.uninstall()
  }
}
