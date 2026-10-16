import FakeTimers from '@sinonjs/fake-timers'

import {
  beginGoMode,
  beginOnboardFlow,
  endGoMode,
  plannedAlightOnTrip,
  stopVehicleTracking
} from '../../../lib/actions/go-mode'
import {
  RIDING_KEPT_MAX_MS,
  ridingFactIsCurrent,
  ridingFactStaleReason,
  tripLastStopMs
} from '../../../lib/util/go-mode/riding'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(
    () => () => Promise.resolve({ error: false, itineraries: [] })
  ),
  findRoutesNearby: jest.fn(() => () => Promise.resolve({})),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

jest.mock('../../../lib/util/go-mode/onboard-discovery', () => ({
  ...jest.requireActual('../../../lib/util/go-mode/onboard-discovery'),
  fetchOnboardContext: jest.fn(() => Promise.resolve(null))
}))

/**
 * 2026-10-15, session mva4fpf5-hhg1cf (backlog 54.1, 15.3 second sighting).
 *
 * 18:14:17 the rider boarded Blue Line vehicle 1:31286 on trip 1:892049
 * (northbound, Mall of America 18:10 -> Target Field 18:51 — the trip record's
 * own stop times, serviceDay 1792040400 + 65400 s / 67860 s, from
 * replay/fixtures/ride-1015-1747.json). Go Mode was stopped at 18:34:50 and
 * STOP_GO_MODE kept the fact, by design (7/12).
 *
 * 21:21:07 START_GO_MODE on a plan whose tram leg is trip 1:983182 immediately
 * dispatched CONFIRM_VEHICLE 1:31286 / 1:892049 — the 3-hour-old fact — and
 * that forced TRANSITION_LEG 1 five seconds later. 21:26:13 "I'm on the bus"
 * silently re-adopted it again, and the get-off list offered northbound
 * stations behind a southbound rider.
 */

const SERVICE_DAY = 1792040400 // 2026-10-15 00:00 America/Chicago
const at = (h: number, m: number, s = 0) =>
  (SERVICE_DAY + h * 3600 + m * 60 + s) * 1000

const BOARDED = at(18, 14, 17)
const STOPPED = at(18, 34, 50)
const RESTART = at(21, 21, 7)

const initial = goMode(undefined, { type: '@@INIT' })

const RIDING_31286 = {
  boardedAt: BOARDED,
  headsign: 'Mpls-Target Field',
  legIndex: 1,
  offRouteSince: null,
  routeId: '1:901',
  routeShortName: null,
  tripId: '1:892049',
  vehicleId: '1:31286'
}

const MATCH_31286 = {
  confidence: 'confirmed' as const,
  distanceMeters: 12,
  label: 'METRO Blue Line',
  lastSeen: at(18, 34, 40),
  routeId: '1:901',
  tripId: '1:892049',
  vehicleId: '1:31286'
}

/** Trip 1:892049's first and last calls, as the trip record carried them. */
const TRIP_892049 = {
  id: '1:892049',
  route: { id: '1:901', longName: 'METRO Blue Line', mode: 'TRAM' },
  stopTimes: [
    {
      realtimeArrival: 65400,
      scheduledArrival: 65400,
      scheduledDeparture: 65400,
      serviceDay: SERVICE_DAY,
      stop: {
        id: '1:51405',
        lat: 44.854277,
        lon: -93.238877,
        name: 'Mall of America Station'
      }
    },
    {
      realtimeArrival: 67860,
      scheduledArrival: 67860,
      scheduledDeparture: 67860,
      serviceDay: SERVICE_DAY,
      stop: {
        id: '1:56339',
        lat: 44.983543,
        lon: -93.278703,
        name: 'Target Field Station Platform 2'
      }
    }
  ]
}

/** The 21:21 plan: walk to the platform, then a DIFFERENT Blue Line train. */
const plan2121 = () => ({
  duration: 1800,
  endTime: RESTART + 1800000,
  legs: [
    {
      from: { lat: 44.8806, lon: -93.2051, name: 'Origin' },
      mode: 'WALK',
      to: { lat: 44.8807, lon: -93.2048, name: 'Terminal 1-Lindbergh Station' },
      transitLeg: false
    },
    {
      from: {
        lat: 44.8807,
        lon: -93.2048,
        name: 'Terminal 1-Lindbergh Station'
      },
      mode: 'TRAM',
      routeId: '1:901',
      to: { lat: 44.8547, lon: -93.2389, name: 'Mall of America Station' },
      transitLeg: true,
      trip: { gtfsId: '1:983182' },
      tripId: '1:983182'
    }
  ],
  startTime: RESTART,
  transfers: 0
})

const stopAt = (nowMs: number) => ({
  payload: { nowMs },
  type: 'STOP_GO_MODE'
})
const startAt = (nowMs: number, itinerary: any) => ({
  payload: { itinerary, nowMs },
  type: 'START_GO_MODE'
})

const ridingThenStopped = (stoppedAt: number) =>
  goMode(
    {
      ...initial,
      isActive: true,
      riding: RIDING_31286,
      vehicleMatch: { ...initial.vehicleMatch, match: MATCH_31286 }
    },
    stopAt(stoppedAt)
  )

describe('a riding fact kept across Stop (54.1 / 15.3, 2026-10-15)', () => {
  describe('the reducer', () => {
    it('STOP_GO_MODE stamps when it kept the fact, and still keeps it (7/12)', () => {
      const s = ridingThenStopped(STOPPED)
      expect(s.riding).toEqual({ ...RIDING_31286, keptAtMs: STOPPED })
      expect(s.vehicleMatch.match).toEqual(MATCH_31286)
    })

    it('a second Stop does not refresh the stamp', () => {
      const s = goMode(
        { ...ridingThenStopped(STOPPED), isActive: true },
        stopAt(STOPPED + 60_000)
      )
      expect(s.riding?.keptAtMs).toBe(STOPPED)
    })

    it('21:21:07 restart, 2 h 46 min after the Stop: the fact and its match are dropped', () => {
      // FAILS BEFORE: riding came back anchored on the tram leg (route-only
      // fallback onto trip 1:983182) with MATCH_31286 still confirmed.
      const s = goMode(ridingThenStopped(STOPPED), startAt(RESTART, plan2121()))
      expect(s.riding).toBeNull()
      expect(s.vehicleMatch.match).toBeNull()
    })

    it('a restart under 10 min keeps the fact and its match (7/12 behaviour)', () => {
      const plan = plan2121()
      ;(plan.legs[1] as any).trip = { gtfsId: '1:892049' }
      ;(plan.legs[1] as any).tripId = '1:892049'
      const s = goMode(
        ridingThenStopped(STOPPED),
        startAt(STOPPED + 3 * 60_000, plan)
      )
      expect(s.riding).toEqual(
        expect.objectContaining({
          keptAtMs: null,
          legIndex: 1,
          tripId: '1:892049',
          vehicleId: '1:31286'
        })
      )
      expect(s.vehicleMatch.match).toEqual(MATCH_31286)
    })

    it('a restart does not anchor the fact onto ANOTHER trip of the same line', () => {
      const s = goMode(
        ridingThenStopped(STOPPED),
        startAt(STOPPED + 60_000, plan2121())
      )
      expect(s.riding?.tripId).toBe('1:892049')
      // FAILS BEFORE: 1 — the tram leg of trip 1:983182, by route alone.
      expect(s.riding?.legIndex).toBe(-1)
    })

    it('a mid-trip swap still carries the fact whatever its stamp', () => {
      const s = goMode(
        {
          ...initial,
          isActive: true,
          riding: { ...RIDING_31286, keptAtMs: STOPPED },
          vehicleMatch: { ...initial.vehicleMatch, match: MATCH_31286 }
        },
        startAt(RESTART, plan2121())
      )
      expect(s.riding).toEqual(
        expect.objectContaining({ keptAtMs: null, legIndex: 1 })
      )
    })
  })

  describe('ridingFactIsCurrent', () => {
    it('reads the trip record: 892049 ended at 18:51, so at 21:21 it is over', () => {
      expect(tripLastStopMs(TRIP_892049)).toBe(at(18, 51))
      expect(
        ridingFactStaleReason({
          nowMs: RESTART,
          riding: RIDING_31286,
          trip: TRIP_892049
        })
      ).toBe('trip-ended')
      // ...and was current while it ran.
      expect(
        ridingFactIsCurrent({
          nowMs: at(18, 40),
          riding: RIDING_31286,
          trip: TRIP_892049
        })
      ).toBe(true)
    })

    it('the feed naming another trip for the same vehicle drops it', () => {
      const vehicles: any[] = [
        {
          lat: 44.88,
          lon: -93.2,
          seconds: at(18, 40) / 1000 - 5,
          tripId: '1:892070',
          vehicleId: '1:31286'
        }
      ]
      expect(
        ridingFactStaleReason({
          nowMs: at(18, 40),
          riding: RIDING_31286,
          vehicles
        })
      ).toBe('vehicle-on-other-trip')
      // A record of unknown age is not evidence either way (a route cache is
      // never evicted), and neither is one older than the stale cutoff.
      expect(
        ridingFactStaleReason({
          nowMs: at(18, 40),
          riding: RIDING_31286,
          vehicles: [{ ...vehicles[0], seconds: undefined }]
        })
      ).toBeNull()
      expect(
        ridingFactStaleReason({
          nowMs: at(18, 40),
          riding: RIDING_31286,
          vehicles: [{ ...vehicles[0], seconds: at(18, 30) / 1000 }]
        })
      ).toBeNull()
    })

    it('kept longer than ten minutes drops it; unknowns never do', () => {
      const kept = { ...RIDING_31286, keptAtMs: STOPPED }
      expect(
        ridingFactIsCurrent({
          nowMs: STOPPED + RIDING_KEPT_MAX_MS,
          riding: kept
        })
      ).toBe(true)
      expect(
        ridingFactStaleReason({
          nowMs: STOPPED + RIDING_KEPT_MAX_MS + 1,
          riding: kept
        })
      ).toBe('kept-too-long')
      expect(
        ridingFactIsCurrent({ nowMs: RESTART, riding: RIDING_31286 })
      ).toBe(true)
    })
  })

  describe('the actions', () => {
    let clock: FakeTimers.InstalledClock | undefined

    const makeStore = (goModeState0: any, transitIndex: any = {}) => {
      let goModeState: any = goModeState0
      const actions: any[] = []
      const getState = () => ({
        otp: {
          config: { homeTimezone: 'America/Chicago' },
          currentQuery: { to: { lat: 44.8547, lon: -93.2389 } },
          goMode: goModeState,
          location: { currentPosition: { coords: null } },
          searches: {},
          transitIndex: { routes: {}, stops: {}, trips: {}, ...transitIndex }
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
        dispatch,
        getGoMode: () => goModeState,
        types: () => actions.map((a) => a.type)
      }
    }

    afterEach(() => {
      stopVehicleTracking()(() => undefined)
      clock?.uninstall()
      clock = undefined
    })

    it('beginGoMode at 21:21:07 no longer re-confirms vehicle 1:31286', async () => {
      clock = FakeTimers.install({ now: RESTART, toFake: ['Date'] })
      // Stamp-less, to show the trip-end check working on its own: the
      // action asks the cached trip record before START_GO_MODE.
      const s0 = {
        ...ridingThenStopped(STOPPED),
        riding: RIDING_31286
      }
      const store = makeStore(s0, { trips: { '1:892049': TRIP_892049 } })
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
      await store.dispatch(beginGoMode(plan2121() as any))
      const lines = log.mock.calls.map((c) => String(c[0]))
      log.mockRestore()
      store.dispatch(endGoMode())
      const confirms = store.actions.filter(
        (a) =>
          a.type === 'CONFIRM_VEHICLE' && a.payload?.vehicleId === '1:31286'
      )
      // FAILS BEFORE: one CONFIRM_VEHICLE 1:31286 / 1:892049, as on the ride.
      expect(confirms).toHaveLength(0)
      expect(lines).toContain(
        '[go-mode] dropped kept riding fact 1:31286 / 1:892049: trip-ended'
      )
    })

    it('"I\'m on the bus" at 21:26:13 does not silently re-adopt the stale train', () => {
      clock = FakeTimers.install({ now: at(21, 26, 13), toFake: ['Date'] })
      const store = makeStore(ridingThenStopped(STOPPED))
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
      store.dispatch(beginOnboardFlow())
      log.mockRestore()
      // FAILS BEFORE: CONFIRM_VEHICLE + SET_ONBOARD_VEHICLE for 1:31286.
      expect(store.getGoMode().riding).toBeNull()
      expect(store.getGoMode().onboard.vehicle).toBeNull()
      expect(
        store.actions.filter(
          (a) =>
            a.type === 'CONFIRM_VEHICLE' && a.payload?.vehicleId === '1:31286'
        )
      ).toHaveLength(0)
      expect(store.getGoMode().onboard.status).toBe('discovering')
      store.dispatch(endGoMode())
    })

    it('...but a back-out-and-reopen within minutes still re-adopts it (7/12)', () => {
      clock = FakeTimers.install({ now: STOPPED + 60_000, toFake: ['Date'] })
      const store = makeStore(ridingThenStopped(STOPPED))
      store.dispatch(beginOnboardFlow())
      expect(store.getGoMode().onboard.vehicle).toEqual(
        expect.objectContaining({ tripId: '1:892049', vehicleId: '1:31286' })
      )
      expect(store.getGoMode().onboard.status).toBe('fetching-schedule')
      store.dispatch(endGoMode())
    })
  })
})

/**
 * The rider's answer to cycle 23 Q4 (2026-10-16): "If it's the train in your
 * plan: go straight to directions for your plan's stop, with a 'Pick another
 * stop' button. A different train: show the list."
 */
describe("confirmed aboard the plan's own train (54.1, Q4 = A)", () => {
  const NOW = at(18, 20)
  let clock: FakeTimers.InstalledClock | undefined

  /** The 18:14 trip with a middle stop — the plan gets off at Lake St. */
  const trip = () => ({
    ...TRIP_892049,
    stopTimes: [
      TRIP_892049.stopTimes[0],
      {
        realtimeArrival: 66900,
        scheduledArrival: 66900,
        scheduledDeparture: 66900,
        serviceDay: SERVICE_DAY,
        stop: {
          id: '1:51424',
          lat: 44.9483,
          lon: -93.2393,
          name: 'Lake St/Midtown Station'
        }
      },
      TRIP_892049.stopTimes[1]
    ]
  })

  /** The rider's plan: the Blue Line to Lake St, then a walk. */
  const planned = (tripId: string, routeId = '1:901') => ({
    duration: 2400,
    endTime: at(18, 40),
    legs: [
      {
        from: { lat: 44.8547, lon: -93.2389, name: 'Mall of America Station' },
        mode: 'TRAM',
        routeId,
        to: {
          lat: 44.9483,
          lon: -93.2393,
          name: 'Lake St/Midtown Station',
          stop: { gtfsId: '1:51424' }
        },
        transitLeg: true,
        trip: { gtfsId: tripId },
        tripId
      },
      {
        from: { lat: 44.9483, lon: -93.2393, name: 'Lake St/Midtown Station' },
        mode: 'WALK',
        to: { lat: 44.95, lon: -93.235, name: 'Destination' },
        transitLeg: false
      }
    ],
    startTime: at(18, 10),
    transfers: 0
  })

  afterEach(() => {
    stopVehicleTracking()(() => undefined)
    clock?.uninstall()
    clock = undefined
  })

  it("plannedAlightOnTrip: the plan's trip, else its line, never another line", () => {
    expect(
      plannedAlightOnTrip(planned('1:892049') as any, trip(), NOW)
    ).toEqual({
      arrivalEpoch: at(18, 35),
      legIndex: 0,
      stopId: '1:51424',
      stopName: 'Lake St/Midtown Station'
    })
    // The next run of the planned line is "the train in your plan".
    expect(
      plannedAlightOnTrip(planned('1:892070') as any, trip(), NOW)?.legIndex
    ).toBe(0)
    // A different line: no answer, so the list.
    expect(
      plannedAlightOnTrip(planned('1:1', '1:902') as any, trip(), NOW)
    ).toBeNull()
    // The plan's stop already behind the train: the list.
    expect(
      plannedAlightOnTrip(planned('1:892049') as any, trip(), at(18, 36))
    ).toBeNull()
  })

  const runOnboard = async (plan: any) => {
    clock = FakeTimers.install({ now: NOW, toFake: ['Date'] })
    let goModeState: any = {
      ...initial,
      activeItinerary: plan,
      isActive: true,
      riding: { ...RIDING_31286, legIndex: 0 },
      tracking: {
        ...initial.tracking,
        lastPosition: {
          coords: { accuracy: 5, latitude: 44.88, longitude: -93.2 },
          timestamp: NOW
        }
      },
      vehicleMatch: { ...initial.vehicleMatch, match: MATCH_31286 }
    }
    const actions: any[] = []
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: { to: { lat: 44.95, lon: -93.235 } },
        goMode: goModeState,
        location: { currentPosition: { coords: null } },
        transitIndex: { routes: {}, stops: {}, trips: { '1:892049': trip() } }
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      actions.push(action)
      goModeState = goMode(goModeState, action)
      return action
    }
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    dispatch(beginOnboardFlow())
    // loadOnboardScheduleAndOptimize awaits findTrip, then goes on.
    for (let i = 0; i < 20; i++) await Promise.resolve()
    log.mockRestore()
    return { actions, dispatch, getGoMode: () => goModeState }
  }

  it('the plan\'s train: straight to guidance for the plan\'s stop, with "Pick another stop" armed', async () => {
    const store = await runOnboard(planned('1:892049'))
    const types = store.actions.map((a) => a.type)
    const gm = store.getGoMode()
    // No get-off list.
    expect(types).not.toContain('START_ONBOARD_OPTIMIZE')
    expect(gm.onboard.status).toBe('idle')
    // Guidance on the spliced plan: the ridden train to Lake St, then the
    // plan's own walk.
    const legs = gm.activeItinerary.legs
    expect(legs[0].tripId).toBe('1:892049')
    expect(legs[0].to.name).toBe('Lake St/Midtown Station')
    expect(legs[legs.length - 1].to.name).toBe('Destination')
    expect(gm.riding?.legIndex).toBe(0)
    expect(gm.planStopOffer).toEqual({ tripId: '1:892049' })
    store.dispatch(endGoMode())
  })

  it('a different train: the list, as before', async () => {
    const store = await runOnboard(planned('1:1', '1:902'))
    const types = store.actions.map((a) => a.type)
    expect(types).toContain('START_ONBOARD_OPTIMIZE')
    expect(types).not.toContain('START_GO_MODE')
    expect(store.getGoMode().planStopOffer).toBeNull()
    store.dispatch(endGoMode())
  })
})
