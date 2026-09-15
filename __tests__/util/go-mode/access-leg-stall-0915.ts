import FakeTimers from '@sinonjs/fake-timers'

import {
  DESTINATION_GAIN_MIN_M,
  DESTINATION_REPLAN_MOTION_MIN_M,
  DESTINATION_STALL_REPLANS,
  destinationReachMeasure,
  destinationStalled,
  noteDestinationDistance,
  noteReplanAttempt
} from '../../../lib/util/go-mode/destination-progress'
import {
  endGoMode,
  handlePositionUpdate,
  quietReplanAccessLeg
} from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import { haversineDistance } from '../../../lib/util/go-mode/geometry'
import goMode from '../../../lib/reducers/go-mode'
import type { DestinationProgressState } from '../../../lib/util/go-mode/destination-progress'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  }))
}))

/**
 * 2026-09-15 ride 1, session mu2rh9og-fw6prf — DESTINATION_UNREACHABLE at
 * 09:38:58.093, "18352m from 2345 Old Shakopee Road West · not getting closer",
 * while the trip was going exactly to plan.
 *
 * The trip is bike → Orange Line → bike. The boarding stop (Marquette Ave &
 * 11th St) is NORTH-WEST of home; the destination is 18 km SOUTH of it. So the
 * first 4.4 km of the itinerary moves the rider AWAY from the destination by
 * construction, and the straight line the stall test was measuring rose the
 * whole way: 18,340 m at 09:35:19 to 18,653 m at 09:38:58. Three re-plans went
 * out across that stretch (09:35:48 / 09:37:10 / 09:38:48); each cleared both
 * of the 09-09 guards — the rider moved hundreds of metres between them, and
 * 2 of 2 recorded REROUTE_SNAPSHOTs came back with itineraries ending 0 m from
 * the door — so all three counted, and the third retired BICYCLE re-planning
 * for 3m43s. The rider arrived at 10:28:06.
 *
 * Over the identical stretch the distance to the BOARDING STOP fell 1,920 m →
 * 1,270 m on every fix. The counting was right; the yardstick was wrong.
 *
 * Every coordinate below is lifted from the ride's own recording
 * (lib/util/go-mode/replay/fixtures/orange-0915-0931.json), so this suite does
 * not need the fixture present — only the replay-level block at the bottom
 * does, and it skips itself when the file is absent.
 */

/** The itinerary Go Mode was holding, legs verbatim from the fixture. */
const LEGS: any[] = [
  {
    distance: 4395.98,
    from: { lat: 44.979982, lon: -93.2334489, name: '(Current Location)' },
    mode: 'BICYCLE',
    to: {
      lat: 44.972032,
      lon: -93.274496,
      name: 'Marquette Ave & 11th St - Stop Group C'
    },
    transitLeg: false
  },
  {
    distance: 19462.72,
    from: {
      lat: 44.972032,
      lon: -93.274496,
      name: 'Marquette Ave & 11th St - Stop Group C'
    },
    mode: 'BUS',
    to: { lat: 44.82517, lon: -93.290862, name: 'I-35W & 98th St Station' },
    transitLeg: true
  },
  {
    distance: 3970.17,
    from: { lat: 44.82517, lon: -93.290862, name: 'I-35W & 98th St Station' },
    mode: 'BICYCLE',
    to: {
      lat: 44.816546,
      lon: -93.30986,
      name: '2345 Old Shakopee Road West, Bloomington, MN'
    },
    transitLeg: false
  }
]

const DESTINATION: [number, number] = [44.816546, -93.30986]
const BOARDING_STOP: [number, number] = [44.972032, -93.274496]

/** The fix the app was holding at each wall-clock moment that matters. */
const FIXES: Array<[string, [number, number]]> = [
  ['09:31:08', [44.979738680664184, -93.236471677799]],
  ['09:35:19', [44.97608152915741, -93.25076615101302]],
  ['09:35:48', [44.97708594500739, -93.25247665629644]],
  ['09:35:59', [44.97739072147111, -93.25302306682003]],
  ['09:36:39', [44.97817998827247, -93.25515264298912]],
  ['09:37:10', [44.97927301787696, -93.25932884425504]],
  ['09:37:19', [44.979595750920524, -93.25992655989073]],
  ['09:37:58', [44.98057003515232, -93.26145312707561]],
  ['09:38:37', [44.98074444794317, -93.26288804219492]],
  ['09:38:48', [44.98108425424237, -93.26382295718581]],
  ['09:38:58', [44.98124893811123, -93.26495716410594]]
]

/** The three quiet re-plans, from the debug log. All three came back. */
const REPLANS = ['09:35:48', '09:37:10', '09:38:48']

/** CDT wall clock to epoch ms, the way the ride report quotes it. */
const at = (hhmmss: string): number =>
  Date.parse(`2026-09-15T${hhmmss}Z`) + 5 * 3600000

const pointAt = (hhmmss: string): [number, number] => {
  const hit = FIXES.find(([t]) => t === hhmmss)
  if (!hit) throw new Error(`no recorded fix at ${hhmmss}`)
  return hit[1]
}

const toDestination = (p: [number, number]) => haversineDistance(p, DESTINATION)
const toBoarding = (p: [number, number]) => haversineDistance(p, BOARDING_STOP)

describe('the access leg that leads away from the destination (2026-09-15)', () => {
  it('is a trip whose first 4.4 km can only increase the straight line', () => {
    // The boarding stop is north-west of the rider's door; the destination is
    // 18 km south of the boarding stop. Riding the plan means riding away.
    expect(toDestination(pointAt('09:35:19'))).toBeCloseTo(18340, -1)
    expect(toDestination(pointAt('09:38:58'))).toBeCloseTo(18653, -1)
    // ...while the thing the rider was actually riding towards came closer on
    // every single fix.
    const board = FIXES.slice(1).map(([, p]) => toBoarding(p))
    expect(board[0]).toBeCloseTo(1920, -1)
    expect(board[board.length - 1]).toBeCloseTo(1270, -1)
    for (let i = 1; i < board.length; i++) {
      expect(board[i]).toBeLessThan(board[i - 1])
    }
    // And the three re-plans each pass both of the 09-09 guards, which is why
    // 13.7's fix does not catch this one: real movement, real answers.
    for (let i = 1; i < REPLANS.length; i++) {
      expect(
        haversineDistance(pointAt(REPLANS[i - 1]), pointAt(REPLANS[i]))
      ).toBeGreaterThan(DESTINATION_REPLAN_MOTION_MIN_M)
    }
  })

  /**
   * Fold every recorded fix in, re-planning at the moments the app re-planned.
   * `measured` is the fix under test: with it, gain is judged along the
   * itinerary's remaining path; without it, against the straight line to the
   * destination, which is what shipped.
   */
  const replay = (measured: boolean): DestinationProgressState | null => {
    let state: DestinationProgressState | null = null
    for (const [t, p] of FIXES) {
      state = noteDestinationDistance(
        state,
        toDestination(p),
        measured ? destinationReachMeasure(LEGS, 0, p) : null
      )
      if (REPLANS.includes(t)) {
        state = noteReplanAttempt(state, 'BICYCLE', {
          point: p,
          returned: true
        })
      }
    }
    return state
  }

  it('reproduces the give-up when gain is measured to the destination', () => {
    const state = replay(false)
    expect(state?.replansSinceGain).toBe(DESTINATION_STALL_REPLANS)
    expect(destinationStalled(state, 'BICYCLE')).toBe(true)
    // 09:38:58.093, and 18,352 m is what the rider was told.
    expect(state?.bestDistanceM).toBeCloseTo(18340, -1)
  })

  it('does not retire the mode when gain is measured along the path', () => {
    const state = replay(true)
    expect(destinationStalled(state, 'BICYCLE')).toBe(false)
    // Each re-plan is cleared by real progress towards the boarding stop
    // before the next one goes out, so the count never reaches three.
    expect(state?.replansSinceGain).toBeLessThan(DESTINATION_STALL_REPLANS)
    // The path measure is the gap to the stop plus the bus and the ride home.
    expect(state?.bestDistanceM).toBeCloseTo(
      toBoarding(pointAt('09:38:58')) + 19462.72 + 3970.17,
      0
    )
    // ...and the rider is still quoted a distance to their own destination if
    // this ever fires, not the length of their itinerary.
    expect(state?.bestDestinationM).toBeCloseTo(18340, -1)
  })

  it('still retires a rider who cannot close on the boarding stop', () => {
    // The same itinerary and the same measure, for a rider circling ~1.88 km
    // from Marquette & 11th: real movement between re-plans (118-354 m), no
    // net gain on the thing they are supposed to be reaching. That is the
    // 08-28 failure relocated onto an access leg, and it must still fire.
    const CIRCLING: Array<[number, number]> = [
      [44.9892, -93.2745],
      [44.9892, -93.276],
      [44.9892, -93.273],
      [44.9892, -93.2775]
    ]
    const spread = CIRCLING.map(toBoarding)
    expect(Math.max(...spread) - Math.min(...spread)).toBeLessThan(
      DESTINATION_GAIN_MIN_M
    )
    let state: DestinationProgressState | null = null
    for (const p of CIRCLING) {
      state = noteDestinationDistance(
        state,
        toDestination(p),
        destinationReachMeasure(LEGS, 0, p)
      )
      state = noteReplanAttempt(state, 'BICYCLE', { point: p, returned: true })
    }
    expect(destinationStalled(state, 'BICYCLE')).toBe(true)
  })

  describe('what the measure is, and is not, measured against', () => {
    const rider = pointAt('09:35:19')

    it('is the gap to the boarding stop plus everything after it', () => {
      const m = destinationReachMeasure(LEGS, 0, rider)
      expect(m?.distanceM).toBeCloseTo(
        toBoarding(rider) + 19462.72 + 3970.17,
        6
      )
      expect(m?.key).toContain('44.972032')
    })

    it('is the straight line to the door once no boarding is ahead', () => {
      // The egress leg after the bus — and 08-28's bike-only trip, and
      // 09-09's rider on their last leg. Null here means the caller keeps
      // doing exactly what it did before, to the metre.
      expect(destinationReachMeasure(LEGS, 2, rider)).toBeNull()
      expect(destinationReachMeasure([LEGS[0]] as any, 0, rider)).toBeNull()
    })

    it('says nothing while the rider is aboard the bus', () => {
      expect(destinationReachMeasure(LEGS, 1, rider)).toBeNull()
    })

    it('refuses a tail it cannot add up', () => {
      // One missing leg length is a constant wrong by a whole leg, which would
      // move the baseline under the rider mid-trip.
      const holed = LEGS.map((l, i) =>
        i === 2 ? { ...l, distance: undefined } : l
      )
      expect(destinationReachMeasure(holed, 0, rider)).toBeNull()
      expect(destinationReachMeasure(LEGS, 0, null)).toBeNull()
      expect(destinationReachMeasure(undefined, 0, rider)).toBeNull()
    })

    it('re-bases on a new yardstick without handing back the count', () => {
      // A re-plan picks a different boarding stop: the old best is a number
      // about a different question, so it goes. The stall count stays, or any
      // itinerary churn would disarm the guard.
      const elsewhere = LEGS.map((l, i) =>
        i === 0
          ? { ...l, to: { ...l.to, lat: 44.95, lon: -93.29 } }
          : i === 1
          ? { ...l, from: { ...l.from, lat: 44.95, lon: -93.29 } }
          : l
      )
      let state = noteDestinationDistance(
        null,
        toDestination(rider),
        destinationReachMeasure(LEGS, 0, rider)
      )
      state = noteReplanAttempt(state, 'BICYCLE', {
        point: rider,
        returned: true
      })
      state = noteReplanAttempt(state, 'BICYCLE', {
        point: pointAt('09:38:58'),
        returned: true
      })
      const before = state?.replansSinceGain
      expect(before).toBe(2)
      const rebased = noteDestinationDistance(
        state,
        toDestination(rider),
        destinationReachMeasure(elsewhere, 0, rider)
      )
      expect(rebased?.replansSinceGain).toBe(before)
      expect(rebased?.bestDistanceM).not.toBe(state?.bestDistanceM)
      expect(rebased?.measureKey).not.toBe(state?.measureKey)
    })
  })

  describe('through the tick, on the itinerary the ride was holding', () => {
    const initial = goMode(undefined, { type: '@@INIT' })
    const mockedFetch = fetchOnboardCandidatePlan as jest.Mock

    const positionAt = (hhmmss: string): GeolocationPosition => {
      const [lat, lon] = pointAt(hhmmss)
      return {
        coords: {
          accuracy: 14.2,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          latitude: lat,
          longitude: lon,
          speed: 5.2
        },
        timestamp: at(hhmmss)
      } as GeolocationPosition
    }

    const itinerary = () => ({
      duration: 3600,
      endTime: at('10:28:06'),
      legs: LEGS.map((l) => ({
        ...l,
        duration: 600,
        endTime: at('09:50:00'),
        startTime: at('09:31:08')
      })),
      startTime: at('09:31:08')
    })

    const makeStore = () => {
      let runThunks = false
      let goModeState: any = {
        ...initial,
        activeItinerary: itinerary(),
        isActive: true,
        // The access leg: the rider is biking to Marquette & 11th.
        routeMatch: { legIndex: 0, progressAlongLeg: 0.3 },
        tracking: {
          ...initial.tracking,
          lastPosition: positionAt('09:31:08')
        }
      }
      const actions: any[] = []
      const getState = () => ({
        otp: {
          config: { homeTimezone: 'America/Chicago' },
          currentQuery: {},
          goMode: goModeState,
          transitIndex: { routes: {}, stops: {} }
        }
      })
      const dispatch: any = (action: any) => {
        if (typeof action === 'function') {
          return runThunks ? action(dispatch, getState) : undefined
        }
        actions.push(action)
        goModeState = goMode(goModeState, action)
        return action
      }
      return {
        actions,
        run: (thunk: any) => thunk(dispatch, getState),
        setRunThunks: (on: boolean) => {
          runThunks = on
        }
      }
    }

    let dateFaker: FakeTimers.InstalledClock | undefined
    let store: ReturnType<typeof makeStore> | undefined

    const tickAndReplan = async (hhmmss: string) => {
      dateFaker?.setSystemTime(at(hhmmss))
      store?.setRunThunks(false)
      store?.run(handlePositionUpdate(positionAt(hhmmss)))
      store?.setRunThunks(true)
      await store?.run(quietReplanAccessLeg())
    }

    const unreachableNotifications = () =>
      (store?.actions || []).filter(
        (a: any) =>
          a.type === 'ADD_NOTIFICATION' &&
          a.payload?.type === 'DESTINATION_UNREACHABLE'
      )

    beforeEach(() => {
      mockedFetch.mockReset()
      // Real, empty OTP answers: nothing here fabricates an itinerary, and the
      // ride's own scoped re-plans produced no swap either.
      mockedFetch.mockReturnValue(() =>
        Promise.resolve({ error: false, itineraries: [] })
      )
      dateFaker = FakeTimers.install({ now: at('09:31:08'), toFake: ['Date'] })
      store = makeStore()
    })
    afterEach(() => {
      store?.setRunThunks(false)
      store?.run(endGoMode())
      store = undefined
      dateFaker?.uninstall()
      dateFaker = undefined
    })

    it('never tells this rider that routing stops here', async () => {
      for (const t of FIXES.map(([t]) => t)) {
        await tickAndReplan(t)
      }
      expect(unreachableNotifications()).toHaveLength(0)
    })

    it('is still re-planning after the third attempt, as it was not', async () => {
      for (const t of REPLANS) await tickAndReplan(t)
      const before = mockedFetch.mock.calls.length
      expect(before).toBeGreaterThan(0)
      // 09:40:10 and after: on the day, nothing went out here for 3m43s.
      await tickAndReplan('09:38:58')
      dateFaker?.setSystemTime(at('09:42:41'))
      store?.setRunThunks(false)
      store?.run(handlePositionUpdate(positionAt('09:38:58')))
      store?.setRunThunks(true)
      await store?.run(quietReplanAccessLeg())
      expect(mockedFetch.mock.calls.length).toBeGreaterThan(before)
      expect(unreachableNotifications()).toHaveLength(0)
    })
  })
})

/**
 * The same arithmetic over every fix the recorder kept, rather than the eleven
 * quoted above. The fixture is untracked (18 MB), so this skips when absent.
 */
let fixture: any = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  fixture = require('../../../lib/util/go-mode/replay/fixtures/orange-0915-0931.json')
} catch (e) {
  fixture = null
}
const withFixture = fixture ? describe : describe.skip

withFixture('over the whole recorded access leg (2026-09-15)', () => {
  it('closes on the boarding stop on the ride the recorder kept', () => {
    expect(fixture.meta.session).toBe('mu2rh9og-fw6prf')
    const legs = fixture.itinerary.legs
    expect(legs.map((l: any) => l.mode)).toEqual(['BICYCLE', 'BUS', 'BICYCLE'])
    const track = [...fixture.gpsTrack]
      .sort((a: any, b: any) => a.tMs - b.tMs)
      .filter((p: any) => p.tMs >= at('09:35:19') && p.tMs <= at('09:38:58'))
    expect(track.length).toBeGreaterThan(10)

    let measured: DestinationProgressState | null = null
    let straight: DestinationProgressState | null = null
    const replanTimes = REPLANS.map(at)
    let issued = 0
    for (const p of track) {
      const here: [number, number] = [p.lat, p.lon]
      const d = toDestination(here)
      measured = noteDestinationDistance(
        measured,
        d,
        destinationReachMeasure(legs, 0, here)
      )
      straight = noteDestinationDistance(straight, d)
      while (issued < replanTimes.length && replanTimes[issued] <= p.tMs) {
        issued++
        measured = noteReplanAttempt(measured, 'BICYCLE', {
          point: here,
          returned: true
        })
        straight = noteReplanAttempt(straight, 'BICYCLE', {
          point: here,
          returned: true
        })
      }
    }
    expect(issued).toBe(REPLANS.length)
    // What shipped, and what does not.
    expect(destinationStalled(straight, 'BICYCLE')).toBe(true)
    expect(destinationStalled(measured, 'BICYCLE')).toBe(false)
  })
})
