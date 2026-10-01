import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import {
  beginGoMode,
  endGoMode,
  handlePositionUpdate
} from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import {
  originGapMeters,
  START_ORIGIN_MAX_M,
  startOriginIsStale
} from '../../../lib/util/go-mode/replan-acceptance'
import goMode from '../../../lib/reducers/go-mode'

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

const initial = goMode(undefined, { type: '@@INIT' })
const mockedFetch = fetchOnboardCandidatePlan as jest.Mock

/**
 * 2026-09-08 10:40:15, session `mtssjvee-mtc2dx` — backlog 12.13.
 *
 * The rider rode the 10:25 Orange Line to I-35W & Lake St Station with Go Mode
 * OFF. Standing on the platform at 44.94830238, -93.27424203 (that fix 113.5 m
 * accurate; the next, a second later, 14 m) they tapped itinerary 13 out of the
 * search they had run at 10:25 down at 66th St, and `START_GO_MODE` installed
 * it whole:
 *
 *   legs[0].from  44.8833656, -93.2953209   — 7,409 m BEHIND them
 *   startTime     10:25:00                  — fifteen minutes old
 *   endTime       11:01:00
 *   one BICYCLE leg, 9,199 m
 *
 * It produced exactly one progress tick — `currentLegProgress 100 /
 * overallProgress 100 / distanceToDestination 1022.55 m / status deviated` —
 * every number of it honest, because the rider really was 7.4 km along a 9.2 km
 * route they had never ridden. `AUTO_REPLAN_ORIGIN_MAX_M` (75 m) guards the
 * four AUTO-apply sites and the start path had nothing: the four auto-applied
 * starts of that day measured 37 / 55 / 42 / 0 m against it, so the gate works
 * exactly where it exists.
 *
 * The fix recovers rather than interrogates — the rider's two standing rules
 * (never confirm what the app already knows; an automatic update keeps their
 * chosen route) leave no room for a dialog. So: re-plan from the fix, to the
 * same destination, with the tapped plan's own first transit route pinned.
 */

// The 09-08 numbers, to 7 dp as recorded.
const RIDER: [number, number] = [44.94830238402128, -93.27424202784626]
const STALE_ORIGIN: [number, number] = [44.8833656, -93.2953209]
const DEST: [number, number] = [44.94245, -93.26422] // 3322 Columbus Avenue
const NOW = 1_788_882_015_056 // 10:40:15.056 CDT, the START_GO_MODE itself

/** The itinerary the rider actually tapped: one 9,199 m bike leg from 66th St. */
const tappedPlan = () => ({
  duration: 2160,
  endTime: NOW - 915_056 + 2_160_000, // 11:01:00
  legs: [
    {
      distance: 9199,
      duration: 2160,
      endTime: NOW - 915_056 + 2_160_000,
      from: {
        lat: STALE_ORIGIN[0],
        lon: STALE_ORIGIN[1],
        name: '(Current Location)'
      },
      legGeometry: { points: encode([STALE_ORIGIN, DEST]) },
      mode: 'BICYCLE',
      startTime: NOW - 915_056, // 10:25:00
      to: { lat: DEST[0], lon: DEST[1], name: '3322 Columbus Avenue' },
      transitLeg: false
    }
  ],
  startTime: NOW - 915_056
})

/** A plan that starts where the rider is, as any fresh one does. */
const freshPlan = (startsAt: [number, number] = RIDER) => ({
  duration: 1500,
  endTime: NOW + 1_500_000,
  legs: [
    {
      distance: 2100,
      duration: 1500,
      endTime: NOW + 1_500_000,
      from: { lat: startsAt[0], lon: startsAt[1], name: 'Current location' },
      legGeometry: { points: encode([startsAt, DEST]) },
      mode: 'BICYCLE',
      startTime: NOW,
      to: { lat: DEST[0], lon: DEST[1], name: '3322 Columbus Avenue' },
      transitLeg: false
    }
  ],
  startTime: NOW
})

/** A transit plan whose first leg is the bus — the onboard-flow shape. */
const aboardPlan = () => ({
  duration: 1800,
  endTime: NOW + 1_800_000,
  legs: [
    {
      distance: 7000,
      duration: 900,
      endTime: NOW + 900_000,
      // The stop they boarded at, kilometres behind them BY DESIGN.
      from: {
        lat: STALE_ORIGIN[0],
        lon: STALE_ORIGIN[1],
        name: '66th St Station'
      },
      mode: 'BUS',
      route: { gtfsId: '1:904' },
      routeShortName: 'METRO Orange Line',
      startTime: NOW - 900_000,
      to: { lat: RIDER[0], lon: RIDER[1], name: 'I-35W & Lake St Station' },
      transitLeg: true
    }
  ],
  startTime: NOW - 900_000
})

const fix = (
  at: [number, number],
  accuracy = 113.49501400000001
): GeolocationPosition =>
  ({
    coords: {
      accuracy,
      altitude: 268.6633631154348,
      altitudeAccuracy: 8.658145853270105,
      heading: null,
      latitude: at[0],
      longitude: at[1],
      speed: null
    },
    timestamp: NOW
  } as GeolocationPosition)

describe('util > go-mode > a plan the rider taps must start where they are', () => {
  describe('the measurement (2026-09-08, 7,409 m)', () => {
    it('measures the recorded gap', () => {
      const gap = originGapMeters(tappedPlan(), RIDER)
      // The daemon and the client agree on 7.4 km; allow a metre of haversine
      // disagreement rather than pinning a spurious precision.
      expect(gap).toBeGreaterThan(7400)
      expect(gap).toBeLessThan(7420)
    })

    it('has no answer for a plan that begins on a transit leg', () => {
      // A plan starting at a stop starts where it MEANS to start. Null, never
      // zero: a missing measurement must not read as "starts underfoot".
      expect(originGapMeters(aboardPlan(), RIDER)).toBeNull()
    })

    it('has no answer without a fix', () => {
      expect(originGapMeters(tappedPlan(), null)).toBeNull()
    })
  })

  describe('the predicate', () => {
    it('calls the 09-08 tap stale, at its own 113.5 m fix', () => {
      expect(
        startOriginIsStale({
          accuracyM: 113.49501400000001,
          itinerary: tappedPlan(),
          position: RIDER
        })
      ).toBe(true)
    })

    it('leaves the four auto-applied starts of that day alone', () => {
      // 37 / 55 / 42 / 0 m — every one of them inside AUTO_REPLAN_ORIGIN_MAX_M,
      // and this threshold must not have anything to say about them.
      for (const metres of [0, 37, 42, 55]) {
        const degrees = metres / 111_320
        expect(
          startOriginIsStale({
            itinerary: {
              ...freshPlan([RIDER[0] + degrees, RIDER[1]])
            } as any,
            position: RIDER
          })
        ).toBe(false)
      }
    })

    it('leaves a sub-100 m onboard-flow origin alone (4.7 objection)', () => {
      const degrees = 99 / 111_320
      expect(
        startOriginIsStale({
          itinerary: freshPlan([RIDER[0] + degrees, RIDER[1]]) as any,
          position: RIDER
        })
      ).toBe(false)
    })

    it('says nothing about the bus the rider is sitting on', () => {
      // Two independent reasons, and the test asserts both: leg 0 is transit
      // (so there is no measurement), and `riding` is the automatic gate's own
      // escape.
      expect(
        startOriginIsStale({ itinerary: aboardPlan(), position: RIDER })
      ).toBe(false)
      expect(
        startOriginIsStale({
          itinerary: tappedPlan(),
          position: RIDER,
          riding: true
        })
      ).toBe(false)
    })

    it('will not call a plan stale on a fix that cannot locate the rider', () => {
      // A gap of 600 m measured by a fix accurate to 400 m is not evidence:
      // 2 x 400 > 600. The same 600 m on an ordinary fix IS.
      const degrees = 600 / 111_320
      const itinerary = freshPlan([RIDER[0] + degrees, RIDER[1]]) as any
      expect(
        startOriginIsStale({ accuracyM: 400, itinerary, position: RIDER })
      ).toBe(false)
      expect(
        startOriginIsStale({ accuracyM: 14, itinerary, position: RIDER })
      ).toBe(true)
    })

    it('keeps the threshold clear of the automatic gate', () => {
      // Not an arbitrary pairing: the start check tolerates a plan the rider
      // chose minutes ago, the automatic one only a fetch's own latency.
      expect(START_ORIGIN_MAX_M).toBeGreaterThan(100)
    })
  })

  describe('the recovery, through beginGoMode', () => {
    let clock: FakeTimers.InstalledClock | undefined
    let store: ReturnType<typeof makeStore> | undefined

    /** The same minimal store the other action-level Go Mode cases use. */
    const makeStore = (riderAt: [number, number] | null) => {
      let goModeState: any = { ...initial }
      const actions: any[] = []
      const getState = () => ({
        otp: {
          config: { homeTimezone: 'America/Chicago' },
          currentQuery: {},
          goMode: goModeState,
          location: { currentPosition: { coords: null } },
          transitIndex: { routes: {}, stops: {} }
        }
      })
      const dispatch: any = (action: any) => {
        if (typeof action === 'function') return action(dispatch, getState)
        actions.push(action)
        goModeState = goMode(goModeState, action)
        return action
      }
      // The fix has to be in the store BEFORE beginGoMode runs, which is what
      // the 09-08 sequence looked like: a 10:39:58 poll answer, then the tap.
      if (riderAt) {
        goModeState = {
          ...goModeState,
          tracking: { ...initial.tracking, lastPosition: fix(riderAt) }
        }
      }
      return {
        activeItinerary: () => goModeState.activeItinerary,
        /** START_REROUTE actions raised by the stale-origin recovery itself. */
        recoveries: () =>
          actions.filter(
            (a) =>
              a.type === 'START_REROUTE' &&
              a.payload?.reason === 'stale-plan-origin'
          ),
        reRoute: () => goModeState.reRoute,
        run: (thunk: any) => thunk(dispatch, getState),
        types: () => actions.map((a) => a.type)
      }
    }

    beforeEach(() => {
      mockedFetch.mockReset()
      // No candidate unless a case provides one: the default is a fetch that
      // answers nothing, which must leave the rider's own trip standing.
      mockedFetch.mockReturnValue(() =>
        Promise.resolve({ error: false, itineraries: [] })
      )
      clock = FakeTimers.install({ now: NOW, toFake: ['Date'] })
    })
    afterEach(() => {
      // The per-plan latch is TripSession state, so every case is its own trip.
      store?.run(endGoMode())
      store = undefined
      clock?.uninstall()
      clock = undefined
    })

    it('re-plans from the rider when the tapped plan starts 7.4 km back', async () => {
      store = makeStore(RIDER)
      await store.run(beginGoMode(tappedPlan() as any))
      // The tap is honoured — it is the rider's, and it is never refused.
      expect(store.types()).toContain('START_GO_MODE')
      // ...and a re-plan from where they actually are goes straight out.
      expect(store.types()).toContain('START_REROUTE')
      expect(mockedFetch).toHaveBeenCalledTimes(1)
      const payload = mockedFetch.mock.calls[0][0]
      expect(payload.from.lat).toBeCloseTo(RIDER[0], 5)
      expect(payload.from.lon).toBeCloseTo(RIDER[1], 5)
      // Same destination. The rider changed nothing about where they are going.
      expect(payload.to.lat).toBeCloseTo(DEST[0], 5)
      expect(payload.to.lon).toBeCloseTo(DEST[1], 5)
    })

    it('never asks the rider anything', async () => {
      const confirmSpy = jest
        .spyOn(window, 'confirm')
        .mockImplementation(() => true)
      store = makeStore(RIDER)
      await store.run(beginGoMode(tappedPlan() as any))
      expect(confirmSpy).not.toHaveBeenCalled()
      confirmSpy.mockRestore()
    })

    it('applies a replacement planned from the rider', async () => {
      // A fresh plan arrives LATER than the 11:01 the stale one advertised, and
      // must still be applied: a plan whose origin is 7.4 km behind the rider
      // has no arrival to defend (`currentPlanIsDead`).
      mockedFetch.mockReturnValue(() =>
        Promise.resolve({ error: false, itineraries: [freshPlan()] })
      )
      store = makeStore(RIDER)
      await store.run(beginGoMode(tappedPlan() as any))
      expect(store.activeItinerary().legs[0].from.lat).toBeCloseTo(RIDER[0], 5)
      expect(store.activeItinerary().legs[0].distance).toBe(2100)
    })

    it('leaves the rider on their own plan when nothing better answers', async () => {
      store = makeStore(RIDER)
      await store.run(beginGoMode(tappedPlan() as any))
      // No candidate came back, so no route and no mode was substituted — the
      // rider keeps the trip they asked for.
      expect(store.activeItinerary().legs[0].distance).toBe(9199)
    })

    it('does not re-plan a plan that starts where the rider is', async () => {
      store = makeStore(RIDER)
      await store.run(beginGoMode(freshPlan() as any))
      expect(store.types()).toContain('START_GO_MODE')
      expect(store.types()).not.toContain('START_REROUTE')
      expect(mockedFetch).not.toHaveBeenCalled()
    })

    it('does not re-plan the bus the rider is sitting on', async () => {
      store = makeStore(RIDER)
      await store.run(beginGoMode(aboardPlan() as any))
      expect(store.types()).not.toContain('START_REROUTE')
      expect(mockedFetch).not.toHaveBeenCalled()
    })

    it('waits for a fix rather than answering without one', async () => {
      // A brand-new trip can reach beginGoMode before any fix exists (on 09-08
      // the first landed 69 ms after START_GO_MODE). Nothing is fetched, and
      // the arming is NOT spent, so the question is still open — the first
      // position tick is what answers it.
      store = makeStore(null)
      await store.run(beginGoMode(tappedPlan() as any))
      expect(store.types()).not.toContain('START_REROUTE')
      expect(mockedFetch).not.toHaveBeenCalled()

      store.run(handlePositionUpdate(fix(RIDER)))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(mockedFetch).toHaveBeenCalledTimes(1)
      expect(mockedFetch.mock.calls[0][0].from.lat).toBeCloseTo(RIDER[0], 5)
    })

    it('leaves a rider who simply walked their own access leg alone', async () => {
      // The false-positive class the question has to be scoped away from, and
      // the one that caught this fix in the suite (ambiguous-missed-bus-0903,
      // where the rider stands at the stop 99 % along a leg that began 1,575 m
      // back). The plan was installed where the rider then WAS; they have since
      // travelled its length, which is what riding a bike leg looks like. Their
      // distance from its origin is now enormous and means nothing, and a tick
      // must not re-plan a trip that is going perfectly well.
      store = makeStore(STALE_ORIGIN)
      await store.run(beginGoMode(freshPlan(STALE_ORIGIN) as any))
      expect(mockedFetch).not.toHaveBeenCalled()
      store.run(handlePositionUpdate(fix(RIDER, 14)))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(mockedFetch).not.toHaveBeenCalled()
    })

    it('asks once per installation, not once per tick', async () => {
      store = makeStore(RIDER)
      await store.run(beginGoMode(tappedPlan() as any))
      expect(store.recoveries()).toHaveLength(1)
      // beginGoMode answered it, so the ticks that follow have nothing to ask
      // — however long the stale plan stays installed. Counted on the recovery
      // itself rather than on the fetch: a rider 1,007 m off the route they
      // were handed is also a deviation, and the quiet access replan answering
      // that is the app working, not this path firing twice.
      for (const _ of [1, 2, 3]) {
        store.run(handlePositionUpdate(fix(RIDER)))
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(store.recoveries()).toHaveLength(1)
    })
  })
})
