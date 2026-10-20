/* globals afterEach, describe, expect, it, jest */
import '../../test-utils/mock-window-url'

import {
  BEGIN_ONBOARD_FLOW,
  confirmOnboardAlightStop,
  stopVehicleTracking
} from '../../../lib/actions/go-mode'
import {
  confirmAndReplay,
  hhmmss,
  loadFixture
} from '../../test-utils/onboard-confirm-replay'
import { endReplay } from '../../../lib/util/go-mode/replay/replay-engine'
import { onboardConfirmRidingFact } from '../../../lib/util/go-mode/riding'
import goMode from '../../../lib/reducers/go-mode'
import type { RidingState } from '../../../lib/util/go-mode/types'

/** Same stub as detour-riding-hold-1012.ts: this replay runs the real tick. */
jest.mock('@opentripplanner/core-utils', () => {
  const actual = jest.requireActual('@opentripplanner/core-utils')
  const { parse } = jest.requireActual('graphql')
  const stub = parse('query Plan { plan { itineraries { duration } } }')
  const core = actual.default || actual
  const patched = {
    ...core,
    queryGen: {
      ...core.queryGen,
      generateOtp2Query: (params: unknown) =>
        core.queryGen.generateOtp2Query(params, stub)
    }
  }
  return { ...actual, __esModule: true, default: patched }
})

/**
 * BACKLOG 64.3 — an onboard Confirm that leaves Go Mode tracking a confirmed
 * bus with NO riding fact.
 *
 * 2026-10-20 08:32, session `mvgplnrw-yvtqga` ride 2 (report
 * `2026-10-20-yvtqga-ride2.md` §3), every value below from
 * ~/otp-debug-logs/debug-2026-10-20.jsonl:
 *
 *   08:19:32.420 SET_RIDING   8222 / 1:1366791, legIndex 0,
 *                             offRouteSince 08:19:32.418  (ride 1's 1st tick)
 *   08:19:49.796 STOP_GO_MODE (the fact is kept: keptAtMs)
 *   08:19:53.306 BEGIN_ONBOARD_FLOW → isActive true
 *   08:32:53.360 onboard-preview-confirm (2nd Ave S & 5th St)
 *   08:32:53.366 START_GO_MODE  — non-restart: the kept fact rides in,
 *                                 offRouteSince 08:19:32 and all
 *   08:32:53.387 CLEAR_RIDING   — 13 min "off route" > the 90 s clock
 *   08:32:53.457 CONFIRM_VEHICLE 8222 (deferred, after the tick)
 *   08:32:54.035 UPDATE_PROGRESS deviated, waitingAtBoardingStop: true
 *   08:33:07.149 STOP_GO_MODE   — nothing re-set the fact in 14 s
 *
 * The plan's mechanism (cycle 33) is confirmed by the record: the drop was
 * not `dropStaleRidingFact` (beginGoMode skips it while `isActive`), it was
 * `decideRiding`'s off-route clear on a carried 13-minute-old stamp.
 */

/* ─── 2026-10-20 08:32, ride 2 ─────────────────────────────────────────── */

const fx0832 = loadFixture('ride-1020-0832.json')

/** 08:32:53.360 — the rider's tap on Confirm. */
const CONFIRM_0832 = 1792503173360
const TRIP_0832 = '1:1366791'
const VEHICLE_0832 = '1:8222'

/** SET_RIDING 08:19:32.420, kept by STOP_GO_MODE 08:19:49.796. */
const KEPT_0832: RidingState = {
  boardedAt: 1792502355479,
  headsign: 'ORANGE Downtown Minneapolis',
  keptAtMs: 1792502389796,
  legIndex: 0,
  offRouteSince: 1792502372418,
  routeId: '1:904',
  routeShortName: null,
  tripId: TRIP_0832,
  vehicleId: VEHICLE_0832
}

/** SET_ONBOARD_VEHICLE 08:19:53.308 (re-adopted, so no next stop). */
const ONBOARD_VEHICLE_0832 = {
  label: 'METRO Orange Line',
  nextStopId: null,
  routeId: '1:904',
  tripId: TRIP_0832,
  vehicleId: VEHICLE_0832
}

/**
 * The confirmed option. The fixture opens at START_GO_MODE and its list was
 * built at 08:20:02, outside the window, so the option is rebuilt from the
 * started plan: off at 2nd Ave S & 5th St, then the plan's legs after it.
 */
const option0832 = (fx: any) => {
  const legs = fx.itinerary.legs
  return {
    __itinerary: fx.itinerary,
    busArrivalEpoch: legs[0].endTime,
    itinerary: { ...fx.itinerary, legs: legs.slice(1) },
    stopId: '1:53314',
    stopName: '2nd Ave S & 5th St - Stop Group F'
  }
}

afterEach(() => {
  endReplay()
})

jest.setTimeout(300000)
;(fx0832 ? describe : describe.skip)(
  '64.3 — the 2026-10-20 08:32 Confirm, replayed',
  () => {
    const setup = () => ({
      confirmAtMs: CONFIRM_0832,
      kept: KEPT_0832,
      option: option0832(fx0832),
      vehicle: ONBOARD_VEHICLE_0832
    })

    it('as shipped: the carried fact is cleared on the first tick', async () => {
      const r = await confirmAndReplay(fx0832, setup(), {
        commit: 'as-shipped',
        windowMs: 14000
      })
      // The ride's own sequence: START_GO_MODE, then CLEAR_RIDING within the
      // same second (21 ms on the phone), and nothing re-sets it.
      expect(r.starts).toHaveLength(1)
      expect(r.clears).toHaveLength(1)
      expect(r.clears[0] - CONFIRM_0832).toBeLessThan(1000)
      expect(r.sets).toEqual([])
      expect(r.riding).toBeNull()
      expect(r.deviated.length).toBeGreaterThan(0)
    })

    it('after: Confirm writes a fresh fact for 8222 and it survives', async () => {
      const r = await confirmAndReplay(fx0832, setup(), {
        commit: 'confirm',
        windowMs: 14000
      })
      // Leg 0 is the same Orange Line leg the phone started.
      const leg0: any = r.itinerary.legs[0]
      expect(leg0.trip.gtfsId).toBe(TRIP_0832)
      expect(leg0.from.name).toBe('I-35W & Lake St Station')
      expect(leg0.to.name).toBe('2nd Ave S & 5th St - Stop Group F')
      // The fact is written BEFORE START_GO_MODE, and is the fresh one.
      const firstSet = r.events.findIndex((e) => e.type === 'SET_RIDING')
      const start = r.events.findIndex((e) => e.type === 'START_GO_MODE')
      expect(firstSet).toBeGreaterThanOrEqual(0)
      expect(firstSet).toBeLessThan(start)
      expect(r.events[firstSet].p).toMatchObject({
        keptAtMs: null,
        legIndex: 0,
        offRouteSince: null,
        tripId: TRIP_0832,
        vehicleId: VEHICLE_0832
      })
      // START_GO_MODE anchored it on leg 0, no longer kept.
      expect(r.riding0).toMatchObject({
        keptAtMs: null,
        legIndex: 0,
        tripId: TRIP_0832,
        vehicleId: VEHICLE_0832
      })
      // The seed tick (the 08:32:52.999 fix re-run against the new plan)
      // still starts the off-route clock — the rider is 1.3 km short of
      // Lake St, the leg's first stop: 22.1's approaching-the-anchor shape.
      // What changed is that the clock starts NOW, not 13 minutes ago.
      expect(r.riding0?.offRouteSince).toBe(CONFIRM_0832)
      // Same trip, same boarding: the 08:19:15 board time is kept.
      expect(hhmmss(r.riding0?.boardedAt)).toBe('08:19:15')
      // The 14 s the rider stayed — every recorded fix ticked through — no
      // CLEAR_RIDING, and the fact still names
      // 8222 on leg 0 at the end of it.
      expect(r.statuses.length).toBeGreaterThanOrEqual(12)
      expect(r.statuses[r.statuses.length - 1].t).toBeGreaterThan(
        CONFIRM_0832 + 10000
      )
      expect(r.clears).toEqual([])
      expect(r.riding).toMatchObject({
        legIndex: 0,
        tripId: TRIP_0832,
        vehicleId: VEHICLE_0832
      })
    })
  }
)

/* ─── 2026-10-19 16:57, the Green Line start (sighting 1) ───────────────── */

const fx1657 = loadFixture('green-465-1657.json')

/** 16:57:35.253 — onboard-preview-confirm, Stadium Village. */
const CONFIRM_1657 = 1792447055253
const TRIP_1657 = '1:895986'
const VEHICLE_1657 = '1:32245'

/** SET_RIDING 16:44:36.292 — the onboard discovery's fact, as logged. */
const DISCOVERY_1657: RidingState = {
  boardedAt: 1792446276292,
  headsign: 'Mpls-Target Field',
  keptAtMs: 1792447013143,
  legIndex: -1,
  offRouteSince: null,
  routeId: '1:902',
  routeShortName: null,
  tripId: TRIP_1657,
  vehicleId: VEHICLE_1657
}

;(fx1657 ? describe : describe.skip)(
  '64.3 — the 2026-10-19 16:57 Green Line start, replayed',
  () => {
    it('anchors the fact on leg 0 after the 16:57:35 START', async () => {
      const onboardResult = fx1657.onboard.result.payload
      const option = onboardResult.options.find(
        (o: any) => o.stopId === '1:56041'
      )
      expect(option?.stopName).toBe('Stadium Village Station')
      const r = await confirmAndReplay(
        fx1657,
        {
          confirmAtMs: CONFIRM_1657,
          kept: DISCOVERY_1657,
          option,
          options: onboardResult.options,
          vehicle: {
            label: 'Mpls-Target Field',
            nextStopId: null,
            routeId: '1:902',
            tripId: TRIP_1657,
            vehicleId: VEHICLE_1657
          }
        },
        { commit: 'confirm', windowMs: 60000 }
      )
      const leg0: any = r.itinerary.legs[0]
      expect(leg0.trip.gtfsId).toBe(TRIP_1657)
      expect(leg0.to.name).toBe('Stadium Village Station')
      expect(r.riding0).toMatchObject({
        legIndex: 0,
        offRouteSince: null,
        tripId: TRIP_1657,
        vehicleId: VEHICLE_1657
      })
      // The discovery's board time, not the Confirm's.
      expect(hhmmss(r.riding0?.boardedAt)).toBe('16:44:36')
      // The fresh fact went in before START_GO_MODE.
      const firstSet = r.events.findIndex((e) => e.type === 'SET_RIDING')
      expect(firstSet).toBeGreaterThanOrEqual(0)
      expect(firstSet).toBeLessThan(
        r.events.findIndex((e) => e.type === 'START_GO_MODE')
      )
      // …and a minute of the real track later, still leg 0, never cleared.
      expect(r.statuses.length).toBeGreaterThanOrEqual(50)
      expect(r.clears).toEqual([])
      expect(r.riding?.legIndex).toBe(0)
      expect(r.riding?.tripId).toBe(TRIP_1657)
    })

    it('as shipped it was leg 0 too — the 16:57 "-1" is a recording gap', async () => {
      // START_GO_MODE's reanchorRiding re-indexes the carried fact inside the
      // reducer and emits no SET_RIDING, so the debug log kept showing the
      // 16:44:36 payload (-1) while the store held leg 0. Sighting 1 was not
      // a second defect.
      const onboardResult = fx1657.onboard.result.payload
      const option = onboardResult.options.find(
        (o: any) => o.stopId === '1:56041'
      )
      const r = await confirmAndReplay(
        fx1657,
        {
          confirmAtMs: CONFIRM_1657,
          kept: DISCOVERY_1657,
          option: { ...option, __itinerary: fx1657.itinerary },
          options: onboardResult.options,
          vehicle: {
            label: 'Mpls-Target Field',
            nextStopId: null,
            routeId: '1:902',
            tripId: TRIP_1657,
            vehicleId: VEHICLE_1657
          }
        },
        { commit: 'as-shipped', windowMs: 60000 }
      )
      expect(r.sets).toEqual([])
      expect(r.riding0?.legIndex).toBe(0)
      expect(r.riding0?.tripId).toBe(TRIP_1657)
    })
  }
)

/* ─── The fact itself, without a fixture ──────────────────────────────── */

describe('64.3 — onboardConfirmRidingFact', () => {
  const NOW = 1792503173360
  const legs: any[] = [
    { mode: 'WALK', transitLeg: false },
    { mode: 'BUS', transitLeg: true, trip: { gtfsId: '1:T' } }
  ]
  const trip = {
    id: '1:T',
    route: { id: '1:904' },
    tripHeadsign: 'ORANGE Downtown Minneapolis'
  }
  const vehicle = { routeId: '1:904', tripId: '1:T', vehicleId: '1:8222' }
  const STALE: RidingState = {
    boardedAt: NOW - 17 * 60_000,
    headsign: 'old',
    keptAtMs: NOW - 13 * 60_000,
    legIndex: 3,
    offRouteSince: NOW - 13 * 60_000,
    routeId: '1:904',
    routeShortName: null,
    tripId: '1:T',
    vehicleId: '1:8222'
  }

  it('drops a 13-minute-old off-route stamp and the keep mark', () => {
    const fact = onboardConfirmRidingFact({
      legs,
      nowMs: NOW,
      prior: STALE,
      trip,
      vehicle
    })
    expect(fact).toEqual({
      boardedAt: STALE.boardedAt,
      headsign: 'ORANGE Downtown Minneapolis',
      keptAtMs: null,
      legIndex: 1,
      offRouteSince: null,
      routeId: '1:904',
      routeShortName: null,
      tripId: '1:T',
      vehicleId: '1:8222'
    })
  })

  it('a different trip is a new boarding: board time is now', () => {
    const fact = onboardConfirmRidingFact({
      legs,
      nowMs: NOW,
      prior: { ...STALE, tripId: '1:OTHER', vehicleId: '1:9999' },
      trip,
      vehicle
    })
    expect(fact?.boardedAt).toBe(NOW)
    expect(fact?.vehicleId).toBe('1:8222')
    expect(fact?.offRouteSince).toBeNull()
  })

  it('no prior fact at all: written from the trip and vehicle', () => {
    const fact = onboardConfirmRidingFact({
      legs,
      nowMs: NOW,
      prior: null,
      trip,
      vehicle
    })
    expect(fact).toMatchObject({ boardedAt: NOW, legIndex: 1, tripId: '1:T' })
  })

  it('a picked route with no live bus keeps the synthetic id', () => {
    const fact = onboardConfirmRidingFact({
      legs,
      nowMs: NOW,
      prior: null,
      trip,
      vehicle: { routeId: '1:904', tripId: '1:T', vehicleId: 'route:1:904' }
    })
    expect(fact?.vehicleId).toBe('route:1:904')
  })

  it('a trip it cannot name writes nothing', () => {
    expect(
      onboardConfirmRidingFact({
        legs,
        nowMs: NOW,
        prior: STALE,
        trip: null,
        vehicle: { routeId: '1:904', vehicleId: '1:8222' }
      })
    ).toBeNull()
  })

  it('an itinerary without the trip leaves it un-anchored (-1)', () => {
    const fact = onboardConfirmRidingFact({
      legs: [{ mode: 'BICYCLE', transitLeg: false } as any],
      nowMs: NOW,
      prior: null,
      trip,
      vehicle
    })
    expect(fact?.legIndex).toBe(-1)
  })
})

/* ─── Through the reducer: START_GO_MODE out of the onboard flow ──────── */

describe('64.3 — Confirm through the real reducer', () => {
  const NOW = 1792503173360
  const TRIP = {
    id: '1:T',
    route: { id: '1:904', mode: 'BUS', shortName: 'Orange' },
    stopTimes: [
      {
        scheduledArrival: 100,
        scheduledDeparture: 100,
        serviceDay: 0,
        stop: { code: 'a', id: '1:a', lat: 44.9, lon: -93.28, name: 'A' }
      },
      {
        scheduledArrival: 700,
        scheduledDeparture: 700,
        serviceDay: 0,
        stop: { code: 'b', id: '1:b', lat: 44.95, lon: -93.27, name: 'B' }
      }
    ],
    tripHeadsign: 'ORANGE Downtown Minneapolis'
  }
  const OPTION = {
    busArrivalEpoch: NOW + 10 * 60_000,
    itinerary: {
      endTime: NOW + 30 * 60_000,
      legs: [
        {
          endTime: NOW + 30 * 60_000,
          from: { lat: 44.95, lon: -93.27, name: 'B', stopId: '1:b' },
          mode: 'BICYCLE',
          startTime: NOW + 10 * 60_000,
          to: { lat: 44.97, lon: -93.21, name: 'Home' },
          transitLeg: false
        }
      ],
      startTime: NOW + 10 * 60_000
    },
    stopId: '1:b',
    stopName: 'B'
  }

  const makeStore = (riding: RidingState | null) => {
    const initial = goMode(undefined, { type: '@@INIT' })
    let state: any = goMode(
      {
        ...initial,
        riding
      },
      { payload: { keepRouteId: null }, type: BEGIN_ONBOARD_FLOW }
    )
    state = {
      ...state,
      onboard: {
        ...state.onboard,
        alightOptions: [OPTION],
        bestAlightStop: OPTION,
        status: 'ready',
        trip: TRIP,
        vehicle: { routeId: '1:904', tripId: '1:T', vehicleId: '1:8222' }
      },
      tracking: {
        ...state.tracking,
        lastPosition: { coords: { latitude: 44.9, longitude: -93.28 } }
      }
    }
    const actions: any[] = []
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: { to: { lat: 44.97, lon: -93.21, name: 'Home' } },
        goMode: state,
        transitIndex: { routes: {}, trips: { '1:T': TRIP } }
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      actions.push(action)
      state = goMode(state, action)
      return action
    }
    return { actions, dispatch, getGoMode: () => state }
  }

  afterEach(() => {
    stopVehicleTracking()(() => undefined)
  })

  it('a kept fact 13 min off route starts the trip with a clean clock', () => {
    const store = makeStore({
      boardedAt: NOW - 17 * 60_000,
      headsign: 'ORANGE Downtown Minneapolis',
      keptAtMs: NOW - 13 * 60_000,
      legIndex: 0,
      offRouteSince: NOW - 13 * 60_000,
      routeId: '1:904',
      routeShortName: null,
      tripId: '1:T',
      vehicleId: '1:8222'
    })
    store.dispatch(confirmOnboardAlightStop(OPTION))
    const types = store.actions.map((a) => a.type)
    expect(types.indexOf('SET_RIDING')).toBeLessThan(
      types.indexOf('START_GO_MODE')
    )
    const riding = store.getGoMode().riding
    expect(riding).toMatchObject({
      boardedAt: NOW - 17 * 60_000,
      keptAtMs: null,
      legIndex: 0,
      offRouteSince: null,
      tripId: '1:T',
      vehicleId: '1:8222'
    })
  })

  it('with no fact at all, Confirm still leaves one on the bus leg', () => {
    const store = makeStore(null)
    store.dispatch(confirmOnboardAlightStop(OPTION))
    expect(store.getGoMode().riding).toMatchObject({
      legIndex: 0,
      offRouteSince: null,
      tripId: '1:T',
      vehicleId: '1:8222'
    })
  })
})
