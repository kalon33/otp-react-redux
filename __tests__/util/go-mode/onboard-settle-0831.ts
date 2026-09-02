/* globals afterEach, beforeEach, describe, expect, it, jest */
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import {
  ONBOARD_CANDIDATE_SETTLE_MS,
  rankAlightOptions,
  settleCandidatePlans
} from '../../../lib/util/go-mode/alight-optimizer'
import { planFromOnboardBus } from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * 2026-08-31, session mthnk1al-x7m0iv. At 17:22:25 the rider asked "Search from
 * here" and START_ONBOARD_OPTIMIZE went out with five candidate stops. Two
 * candidate plans came back (stop 1:53543 at t=1788214948193, stop 1:52719 at
 * t=1788214952092). The other three never did — and because the optimizer
 * awaited `Promise.all` over all five, SET_ONBOARD_RESULT was never dispatched
 * at all. The panel stayed on 'optimizing' until the rider gave up and cleared
 * it 9m11s later at 17:31:36.
 *
 * The two plans that DID return were perfectly good answers. The rider was
 * shown neither of them.
 */
describe('onboard optimize settles on what came back (2026-08-31)', () => {
  const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
  const initial = goMode(undefined, { type: '@@INIT' })
  const TRIP_ID = '1:trip-0831'

  const stop = (id: string, lat: number, name: string, dep: number) => ({
    scheduledArrival: dep,
    scheduledDeparture: dep,
    serviceDay: 0,
    stop: { code: id, id, lat, lon: -93.28, name }
  })

  const trip = () => ({
    id: TRIP_ID,
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

  /**
   * An onward plan that gets the rider home by bike, starting after the bus
   * has reached the stop it is planned from (isReachableItinerary).
   */
  const onward = (minutesFromNow: number) => ({
    duration: 900,
    endTime: Date.now() + (minutesFromNow + 15) * 60000,
    legs: [
      {
        distance: 3970,
        from: { lat: 44.9, lon: -93.28, name: 'Alight stop' },
        mode: 'BICYCLE',
        to: { lat: 44.95, lon: -93.279, name: 'Home' },
        transitLeg: false
      }
    ],
    startTime: Date.now() + minutesFromNow * 60000,
    transfers: 0,
    walkDistance: 0
  })

  const makeStore = () => {
    let state: any = {
      ...initial,
      isActive: true,
      onboard: {
        ...initial.onboard,
        status: 'optimizing',
        trip: trip(),
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
          // A deadline a test can wait out. The shipped default is
          // ONBOARD_CANDIDATE_SETTLE_MS.
          itinerary: { onboardSettleMs: 60 }
        },
        currentQuery: { to: { lat: 44.95, lon: -93.279, name: 'Home' } },
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
    return { actions, dispatch, getOnboard: () => state.onboard }
  }

  beforeEach(() => mockedFetch.mockReset())
  afterEach(() => jest.clearAllTimers())

  it('ranks the plans that answered instead of waiting for the ones that never will', async () => {
    // FAILS BEFORE: `Promise.all` over these five never resolves, so the await
    // below never returns and the case times out — the 9m11s hang, in test
    // form. Three silent candidates, two good ones, exactly as recorded.
    let call = 0
    mockedFetch.mockImplementation(() => () => {
      call += 1
      if (call <= 3) return new Promise(() => undefined)
      return Promise.resolve({ error: false, itineraries: [onward(18)] })
    })

    const store = makeStore()
    await store.dispatch(planFromOnboardBus())

    expect(mockedFetch).toHaveBeenCalledTimes(5)
    const result = store.actions.find((a) => a.type === 'SET_ONBOARD_RESULT')
    expect(result).toBeTruthy()
    // Since 6.37 the payload also carries how much of the answer is in, so
    // the panel can say the list is partial. The options are under `options`.
    expect(result.payload.options.length).toBeGreaterThan(0)
    expect(store.getOnboard().status).toBe('ready')
  })

  it('settles as an error the rider can act on when nothing answers at all', async () => {
    // Not "nothing on the screen": the onboard card offers Choose bus / Cancel
    // on 'error', which is the whole difference from sitting on 'optimizing'.
    mockedFetch.mockImplementation(() => () => new Promise(() => undefined))
    const store = makeStore()
    await store.dispatch(planFromOnboardBus())

    expect(store.actions.map((a) => a.type)).toContain('SET_ONBOARD_RESULT')
    expect(store.getOnboard().status).toBe('error')
  })
})

describe('settleCandidatePlans', () => {
  it('returns what settled and substitutes the rest', async () => {
    const results = await settleCandidatePlans(
      [
        Promise.resolve('a'),
        new Promise<string>(() => undefined),
        Promise.resolve('c')
      ],
      30,
      (index) => `timed-out-${index}`
    )
    expect(results).toEqual(['a', 'timed-out-1', 'c'])
  })

  it('does not wait out the deadline when everything is already in', async () => {
    const started = Date.now()
    const results = await settleCandidatePlans(
      [Promise.resolve(1), Promise.resolve(2)],
      5000,
      () => 0
    )
    expect(results).toEqual([1, 2])
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('treats a rejected plan as a failed candidate, not a failed optimize', async () => {
    const results = await settleCandidatePlans(
      [Promise.reject(new Error('boom')), Promise.resolve('ok')],
      50,
      () => 'substituted'
    )
    expect(results).toEqual(['substituted', 'ok'])
  })

  it('backs the per-request deadline rather than racing it', () => {
    // 15 s sits past GO_MODE_FETCH_TIMEOUT_MS (12 s) on purpose: normally each
    // request kills itself and this never fires. It is the backstop for a
    // request that settles by no route at all.
    expect(ONBOARD_CANDIDATE_SETTLE_MS).toBe(15000)
  })

  it('errored results are skipped by the ranking, not ranked as empty', () => {
    const itin = {
      duration: 600,
      endTime: Date.now() + 900000,
      legs: [
        {
          distance: 3970,
          mode: 'BICYCLE',
          transitLeg: false
        }
      ],
      startTime: Date.now() + 180000,
      walkDistance: 0
    } as never
    const ranked = rankAlightOptions(
      [
        {
          busArrivalEpoch: Date.now() + 60000,
          error: true,
          itineraries: [],
          realtime: false,
          stopId: '1:s2',
          stopName: 'Timed out'
        },
        {
          busArrivalEpoch: Date.now() + 120000,
          itineraries: [itin],
          realtime: true,
          stopId: '1:s3',
          stopName: 'Answered'
        }
      ],
      { nowMs: Date.now() }
    )
    expect(ranked.map((o) => o.stopName)).toEqual(['Answered'])
  })
})
