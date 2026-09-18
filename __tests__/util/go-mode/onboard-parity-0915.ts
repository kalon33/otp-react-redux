/* globals afterEach, beforeEach, describe, expect, it, jest */
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import { getRoutingProfile } from '../../../lib/util/routing-profiles'
import {
  onboardCandidateRoutingPreferences,
  planFromOnboardBus
} from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    noTransfers: true,
    // The CONFIG count, which is what getBasePlanParts returns
    // (util/api.ts getDefaultNumItineraries).
    numItineraries: 5,
    viaStop: { ids: ['1:56796'] }
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * Backlog 17.2 and 17.3 — the two 2026-09-15 afternoon rides (sessions
 * mu346i5y-ng2uqc 15:34 and mu35fwv5-8lyyq1 15:56, dev bundle 2026.0915.1).
 *
 * 17.2, rider 15:58:21: *"I'm already on the bus should just do same flow for
 * search from here. They are returning different results. No reason for
 * that."* and 15:48:32: *"Please show me all alternatives when I'm 'searching
 * from here' also. Same sub menu as main search"*. All ten
 * ONBOARD_CANDIDATE_SNAPSHOTs of ride B carried a `stay-seated` profile the
 * rider never chose and dropped the rider's own option count and hard
 * constraints, then the five options that survived could not stack a single
 * drill-down while the main search's own list stacked eleven variants under one
 * row (ITINERARY_VARIANT_ROWS 15:48:53, variantCounts [11,0,0,0]).
 *
 * 17.3: SET_ONBOARD_RESULT 15:54:19 carried `answeredCandidates: 2,
 * pendingCandidates: 0` over five candidate stops. The three missing plans had
 * each resolved `{error: true}` from their own 12 s request deadline, so they
 * were neither answered nor pending and nothing on screen said the answer was
 * two stops wide.
 */
describe('onboard picker parity and partial answers (17.2, 17.3)', () => {
  const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
  const initial = goMode(undefined, { type: '@@INIT' })

  const stop = (id: string, lat: number, name: string, dep: number) => ({
    scheduledArrival: dep,
    scheduledDeparture: dep,
    serviceDay: 0,
    stop: { code: id, id, lat, lon: -93.28, name }
  })

  const trip = (id: string) => ({
    id,
    route: { id: '1:904', longName: 'METRO Orange Line', shortName: 'Orange' },
    stopTimes: [
      stop('1:s1', 44.86, 'I-35W & 98th St', 100),
      stop('1:s2', 44.88, 'Knox & American', 300),
      stop('1:s3', 44.9, 'Lake St Station', 500),
      stop('1:s4', 44.92, '46th St Station', 700),
      stop('1:s5', 44.94, '38th St Station', 900),
      stop('1:s6', 44.96, 'Downtown', 1100)
    ],
    tripHeadsign: 'Downtown'
  })

  /** A distinct, reachable onward plan: one bike leg from `name`. */
  const onward = (minutesFromNow: number, name: string) => ({
    duration: 900,
    endTime: Date.now() + (minutesFromNow + 15) * 60000,
    legs: [
      {
        distance: 3970,
        from: { lat: 44.9, lon: -93.28, name },
        mode: 'BICYCLE',
        to: { lat: 44.95, lon: -93.279, name: 'Home' },
        transitLeg: false
      }
    ],
    startTime: Date.now() + minutesFromNow * 60000,
    transfers: 0,
    walkDistance: 0
  })

  const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

  const makeStore = ({
    numItineraries,
    routingPreferences,
    tripId = '1:trip-0915'
  }: {
    numItineraries?: number
    routingPreferences?: any
    tripId?: string
  } = {}) => {
    let state: any = {
      ...initial,
      isActive: true,
      onboard: {
        ...initial.onboard,
        status: 'optimizing',
        trip: trip(tripId),
        vehicle: { nextStopId: '1:s1', routeId: '1:904', vehicleId: 'v-1' }
      },
      tracking: {
        ...initial.tracking,
        lastPosition: { coords: { latitude: 44.86, longitude: -93.28 } }
      }
    }
    const actions: any[] = []
    const getState = () => ({
      otp: {
        config: {
          homeTimezone: 'America/Chicago',
          itinerary: { onboardSettleMs: 60 }
        },
        currentQuery: {
          numItineraries,
          routingPreferences,
          to: { lat: 44.95, lon: -93.279, name: 'Home' }
        },
        goMode: state,
        transitIndex: { routes: {}, trips: {} }
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
      combos: () => mockedFetch.mock.calls.map((call) => call[0]),
      dispatch,
      getOnboard: () => state.onboard,
      results: () => actions.filter((a) => a.type === 'SET_ONBOARD_RESULT')
    }
  }

  beforeEach(() => mockedFetch.mockReset())
  afterEach(() => jest.clearAllTimers())

  describe('17.2 — one question for both entry points', () => {
    it('does not substitute the stay-seated profile at the fetch', async () => {
      // FAILS BEFORE: every combo carried {transferPenalty: 600,
      // waitReluctance: 4} — util/routing-profiles.ts:194 — which a plain
      // search never sends, and which is priced inside OTP's own search, so
      // the alternatives were never in the response to begin with.
      mockedFetch.mockImplementation(
        () => () =>
          Promise.resolve({ error: false, itineraries: [onward(18, 'a')] })
      )
      const store = makeStore()
      await store.dispatch(planFromOnboardBus())

      expect(store.combos().length).toBe(5)
      store.combos().forEach((combo: any) => {
        expect(combo.routingPreferences?.transferPenalty).toBeUndefined()
        expect(combo.routingPreferences?.waitReluctance).toBeUndefined()
      })
    })

    it('sends the rider’s own preferences verbatim when they have some', async () => {
      mockedFetch.mockImplementation(
        () => () =>
          Promise.resolve({ error: false, itineraries: [onward(18, 'a')] })
      )
      const store = makeStore({ routingPreferences: { walkReluctance: 8 } })
      await store.dispatch(planFromOnboardBus())

      store.combos().forEach((combo: any) => {
        expect(combo.routingPreferences.walkReluctance).toBe(8)
        expect(combo.routingPreferences.transferPenalty).toBeUndefined()
      })
    })

    it('keeps the boarded-route bias, which the planner also sends while riding', async () => {
      // The half of the 2026-07-13 MVTA-460 protection that is about routes.
      // routingQuery sends this same 900 whenever goMode.riding holds a route
      // (apiV2.js:1752-1765), so it is parity, not divergence.
      mockedFetch.mockImplementation(
        () => () =>
          Promise.resolve({ error: false, itineraries: [onward(18, 'a')] })
      )
      const store = makeStore()
      await store.dispatch(planFromOnboardBus())

      store.combos().forEach((combo: any) => {
        expect(combo.preferred).toEqual({
          otherThanPreferredRoutesPenalty: 900,
          routes: '1:904'
        })
      })
    })

    it('carries the rider’s hard constraints and their own option count', async () => {
      // FAILS BEFORE: the ctx destructured three fields of getBasePlanParts and
      // dropped noTransfers and viaStop on the floor, so "no transfers" applied
      // to the search from here and not to the search from the bus; and the
      // count was the config default even when the rider had set their own.
      mockedFetch.mockImplementation(
        () => () =>
          Promise.resolve({ error: false, itineraries: [onward(18, 'a')] })
      )
      const store = makeStore({ numItineraries: 40 })
      await store.dispatch(planFromOnboardBus())

      store.combos().forEach((combo: any) => {
        expect(combo.noTransfers).toBe(true)
        expect(combo.viaStop).toEqual({ ids: ['1:56796'] })
        expect(combo.numItineraries).toBe(40)
      })
    })

    it('keeps the alternatives it already paid for instead of five rows', async () => {
      // FAILS BEFORE: rankAlightOptions' default limit of 5 cut the pooled set
      // to five options, so groupAlightOptionsByRoute — which needs two members
      // of a route chain to make a drill-down — had nothing to stack and the
      // "N options" submenu 16.6 shipped could never appear here.
      let call = 0
      mockedFetch.mockImplementation(() => () => {
        call += 1
        return Promise.resolve({
          error: false,
          itineraries: [
            onward(18, `bike-a-${call}`),
            onward(22, `bike-b-${call}`),
            onward(26, `bike-c-${call}`)
          ]
        })
      })
      const store = makeStore()
      await store.dispatch(planFromOnboardBus())

      expect(store.getOnboard().alightOptions.length).toBeGreaterThan(5)
    })

    it('leaves the automatic path’s fetch bias alone', () => {
      // The 07-13 note is about the RECOMMENDATION, and the automatic aboard
      // re-plan is the path that applies one without the rider seeing a list.
      const state = { otp: { currentQuery: {} } }
      expect(
        onboardCandidateRoutingPreferences(state, { riderFacing: false })
      ).toEqual(getRoutingProfile('stay-seated')?.prefs)
      expect(
        onboardCandidateRoutingPreferences(state, { riderFacing: true })
      ).toBeUndefined()
      // An explicit override still wins on either path.
      expect(
        onboardCandidateRoutingPreferences(state, {
          prefsOverride: { walkReluctance: 3 },
          riderFacing: false
        })
      ).toEqual({ walkReluctance: 3 })
    })
  })

  describe('17.3 — a partial answer says so', () => {
    it('counts the failures apart from the stragglers', async () => {
      // FAILS BEFORE: answeredCandidates 2, pendingCandidates 0, and no third
      // number anywhere — exactly the 15:54:19 payload.
      const bad = new Set(['Knox & American', '38th St Station', 'Downtown'])
      mockedFetch.mockImplementation(
        (combo: any) => () =>
          Promise.resolve(
            bad.has(combo.from.name)
              ? { error: true, itineraries: [] }
              : { error: false, itineraries: [onward(18, combo.from.name)] }
          )
      )
      const store = makeStore({ tripId: '1:trip-counts' })
      await store.dispatch(planFromOnboardBus())
      await flush()

      const onboard = store.getOnboard()
      expect(onboard.totalCandidates).toBe(5)
      expect(onboard.answeredCandidates).toBe(2)
      expect(onboard.failedCandidates).toBe(3)
      // Reported once the retries are in, rather than left standing as a
      // promise to keep checking that nothing will keep.
      expect(onboard.pendingCandidates).toBe(0)
    })

    it('re-asks the failures and folds the answers in', async () => {
      // The 17.8 outage was intermittent — good responses at 15:48:34,
      // 15:48:53, 15:49:09 — so asking again is the cheapest thing that fills
      // a hole.
      const seen = new Map<string, number>()
      mockedFetch.mockImplementation((combo: any) => () => {
        const name = String(combo.from.name)
        const nth = (seen.get(name) || 0) + 1
        seen.set(name, nth)
        const failFirst =
          name === 'Knox & American' || name === '38th St Station'
        return Promise.resolve(
          failFirst && nth === 1
            ? { error: true, itineraries: [] }
            : { error: false, itineraries: [onward(18, name)] }
        )
      })
      const store = makeStore({ tripId: '1:trip-retry' })
      await store.dispatch(planFromOnboardBus())
      await flush()

      expect(store.getOnboard().answeredCandidates).toBe(5)
      expect(store.getOnboard().failedCandidates).toBe(0)
      expect(store.getOnboard().pendingCandidates).toBe(0)
      expect(mockedFetch).toHaveBeenCalledTimes(7)
    })

    it('fills this run’s holes from the previous run rather than leaving them', async () => {
      // Ride B's own sequence: run 1 at 15:54, run 2 re-entered from inside the
      // live trip at 15:57 with the same bus and the same candidate stops. A
      // hole is not neutral — rankAlightOptions skips an errored result, so a
      // failed stop silently drops out of the list.
      mockedFetch.mockImplementation(
        (combo: any) => () =>
          Promise.resolve({
            error: false,
            itineraries: [onward(18, combo.from.name)]
          })
      )
      const first = makeStore({ tripId: '1:trip-carry' })
      await first.dispatch(planFromOnboardBus())
      await flush()
      const complete = first.getOnboard().alightOptions.length
      expect(complete).toBe(5)

      const bad = new Set(['Knox & American', '38th St Station'])
      mockedFetch.mockImplementation(
        (combo: any) => () =>
          Promise.resolve(
            bad.has(combo.from.name)
              ? { error: true, itineraries: [] }
              : { error: false, itineraries: [onward(18, combo.from.name)] }
          )
      )
      const second = makeStore({ tripId: '1:trip-carry' })
      await second.dispatch(planFromOnboardBus())
      await flush()

      // Same five stops answered, two of them from the previous run — and the
      // failing retry must not overwrite what was carried forward.
      expect(second.getOnboard().answeredCandidates).toBe(5)
      expect(second.getOnboard().alightOptions.length).toBe(complete)
      expect(second.getOnboard().pendingCandidates).toBe(0)
    })

    it('does not rebuild a whole answer out of the previous run', async () => {
      // A run where NOTHING answered is a failure, not a partial answer: the
      // rider is owed the error card (Choose bus / Cancel) that the 2026-08-31
      // settle exists to show, not a list of minutes-old plans that looks
      // exactly like a fresh one.
      mockedFetch.mockImplementation(
        (combo: any) => () =>
          Promise.resolve({
            error: false,
            itineraries: [onward(18, combo.from.name)]
          })
      )
      const first = makeStore({ tripId: '1:trip-allfail' })
      await first.dispatch(planFromOnboardBus())
      await flush()

      mockedFetch.mockImplementation(
        () => () => Promise.resolve({ error: true, itineraries: [] })
      )
      const second = makeStore({ tripId: '1:trip-allfail' })
      await second.dispatch(planFromOnboardBus())
      await flush()

      expect(second.getOnboard().alightOptions).toHaveLength(0)
      expect(second.getOnboard().status).toBe('error')
    })
  })
})
