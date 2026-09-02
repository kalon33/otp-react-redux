/* globals afterEach, beforeEach, describe, expect, it, jest */
import { clearOnboard, planFromOnboardBus } from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import { settleCandidatePlans } from '../../../lib/util/go-mode/alight-optimizer'
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
 * 6.37. Since 2026-09-02 the onboard optimizer ranks whatever answered by its
 * deadline instead of hanging on the slowest candidate (4.1) — the right
 * trade, and the reason the 08-31 rider saw nothing for 9m11s. What it left
 * behind is that a two-of-five answer and a five-of-five answer look
 * identical on screen, and a plan that lands a second after the deadline is
 * thrown away.
 *
 * Both halves here: the counts the panel needs to say "still checking", and a
 * late fold-in that is allowed ONLY while the rider is still looking at the
 * same list for the same bus. Re-dispatching SET_ONBOARD_RESULT puts
 * onboard.status back to 'ready', and a non-idle onboard status renders the
 * onboard chooser OVER the live trip screen — so an unguarded re-rank would
 * yank a rider who had already tapped an option back into the chooser
 * mid-ride.
 */
describe('onboard partial answers (6.37, 2026-09-02)', () => {
  const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
  const initial = goMode(undefined, { type: '@@INIT' })
  const TRIP_ID = '1:trip-0902'

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
    return {
      actions,
      dispatch,
      getOnboard: () => state.onboard,
      results: () => actions.filter((a) => a.type === 'SET_ONBOARD_RESULT')
    }
  }

  /** Lets a test hold one candidate plan open past the settle deadline. */
  const deferred = () => {
    let settle: (value: any) => void = () => undefined
    const promise = new Promise((resolve) => {
      settle = resolve
    })
    return { promise, resolve: (value: any) => settle(value) }
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

  beforeEach(() => mockedFetch.mockReset())
  afterEach(() => jest.clearAllTimers())

  it('says how much of the answer is still outstanding', async () => {
    // FAILS BEFORE: SET_ONBOARD_RESULT carried a bare array of options and the
    // onboard slice had no counts at all, so two-of-five and five-of-five were
    // indistinguishable — there was nothing for the panel to render.
    let call = 0
    mockedFetch.mockImplementation(() => () => {
      call += 1
      if (call <= 3) return new Promise(() => undefined)
      return Promise.resolve({ error: false, itineraries: [onward(18)] })
    })

    const store = makeStore()
    await store.dispatch(planFromOnboardBus())

    expect(store.getOnboard().status).toBe('ready')
    expect(store.getOnboard().candidates).toHaveLength(5)
    expect(store.getOnboard().answeredCandidates).toBe(2)
    expect(store.getOnboard().pendingCandidates).toBe(3)
  })

  it('reports nothing outstanding when every candidate answered', async () => {
    mockedFetch.mockImplementation(
      () => () => Promise.resolve({ error: false, itineraries: [onward(18)] })
    )
    const store = makeStore()
    await store.dispatch(planFromOnboardBus())

    expect(store.getOnboard().pendingCandidates).toBe(0)
    expect(store.getOnboard().answeredCandidates).toBe(
      store.getOnboard().candidates.length
    )
  })

  it('does not count a REJECTED candidate as still being checked', async () => {
    // A rejected request is over. Saying "still checking" about it would be a
    // promise the app cannot keep.
    let call = 0
    mockedFetch.mockImplementation(() => () => {
      call += 1
      if (call <= 2) return Promise.reject(new Error('boom'))
      return Promise.resolve({ error: false, itineraries: [onward(18)] })
    })
    const store = makeStore()
    await store.dispatch(planFromOnboardBus())

    expect(store.getOnboard().pendingCandidates).toBe(0)
    expect(store.getOnboard().answeredCandidates).toBe(3)
  })

  it('folds in a straggler that lands after the deadline', async () => {
    // FAILS BEFORE: the late plan was discarded — settleCandidatePlans had no
    // way to report it and the optimizer had already returned. Exactly one
    // SET_ONBOARD_RESULT was ever dispatched.
    const late = deferred()
    let call = 0
    mockedFetch.mockImplementation(() => () => {
      call += 1
      if (call === 1) return late.promise
      if (call === 2) {
        return Promise.resolve({ error: false, itineraries: [onward(25)] })
      }
      return new Promise(() => undefined)
    })

    const store = makeStore()
    await store.dispatch(planFromOnboardBus())
    expect(store.results()).toHaveLength(1)
    // candidate 0 is the straggler, 1 answered, 2-4 never do.
    expect(store.getOnboard().pendingCandidates).toBe(4)
    const optionsBefore = store.getOnboard().alightOptions.length

    late.resolve({ error: false, itineraries: [onward(12)] })
    await flush()

    expect(store.results()).toHaveLength(2)
    expect(store.getOnboard().status).toBe('ready')
    expect(store.getOnboard().pendingCandidates).toBe(3)
    expect(store.getOnboard().alightOptions.length).toBeGreaterThan(
      optionsBefore
    )
  })

  it('discards a straggler once the rider has acted on the list', async () => {
    // confirmOnboardAlightStop clears onboard before starting the trip, so the
    // status guard is what stops a late re-rank throwing the rider back into
    // the chooser over their now-live trip.
    const late = deferred()
    let call = 0
    mockedFetch.mockImplementation(() => () => {
      call += 1
      if (call === 1) return late.promise
      if (call === 2) {
        return Promise.resolve({ error: false, itineraries: [onward(25)] })
      }
      return new Promise(() => undefined)
    })

    const store = makeStore()
    await store.dispatch(planFromOnboardBus())
    expect(store.results()).toHaveLength(1)

    store.dispatch(clearOnboard())
    expect(store.getOnboard().status).toBe('idle')

    late.resolve({ error: false, itineraries: [onward(12)] })
    await flush()

    expect(store.results()).toHaveLength(1)
    expect(store.getOnboard().status).toBe('idle')
  })

  it('discards a straggler belonging to a superseded optimize run', async () => {
    // "Change bus" starts a fresh run. Its candidate list is a new array, and
    // that identity is the token: the old run's straggler must not rewrite the
    // new run's answer.
    const late = deferred()
    let call = 0
    mockedFetch.mockImplementation(() => () => {
      call += 1
      if (call === 1) return late.promise
      if (call === 2) {
        return Promise.resolve({ error: false, itineraries: [onward(25)] })
      }
      return new Promise(() => undefined)
    })

    const store = makeStore()
    await store.dispatch(planFromOnboardBus())
    const firstResult = store.results()[0]

    // A second run replaces onboard.candidates, then settles ready again.
    store.dispatch({
      payload: {
        candidates: [
          {
            busArrivalEpoch: Date.now() + 300000,
            realtime: false,
            stopId: '1:s5',
            stopName: '38th St Station'
          }
        ]
      },
      type: 'START_ONBOARD_OPTIMIZE'
    })
    store.dispatch({
      payload: {
        answeredCandidates: 1,
        options: firstResult.payload.options,
        pendingCandidates: 0
      },
      type: 'SET_ONBOARD_RESULT'
    })
    expect(store.getOnboard().status).toBe('ready')
    const resultsBefore = store.results().length

    late.resolve({ error: false, itineraries: [onward(12)] })
    await flush()

    expect(store.results()).toHaveLength(resultsBefore)
    expect(store.getOnboard().candidates).toHaveLength(1)
  })
})

describe('settleCandidatePlans late reporting', () => {
  it('reports a plan that lands after the deadline, once', async () => {
    // FAILS BEFORE: settleCandidatePlans took three arguments and dropped a
    // late resolution on the floor.
    const late: { resolve: (v: string) => void } = { resolve: () => undefined }
    const promise = new Promise<string>((resolve) => {
      late.resolve = resolve
    })
    const seen: Array<[number, string]> = []
    const results = await settleCandidatePlans(
      [Promise.resolve('a'), promise],
      20,
      (index) => `timed-out-${index}`,
      (index, value) => seen.push([index, value])
    )
    expect(results).toEqual(['a', 'timed-out-1'])
    expect(seen).toEqual([])

    late.resolve('b')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(seen).toEqual([[1, 'b']])
  })

  it('never reports a plan that made the deadline as late', async () => {
    const seen: number[] = []
    const results = await settleCandidatePlans(
      [Promise.resolve('a'), Promise.resolve('b')],
      5000,
      (index) => `timed-out-${index}`,
      (index) => seen.push(index)
    )
    expect(results).toEqual(['a', 'b'])
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(seen).toEqual([])
  })

  it('tells a timeout apart from a rejection', async () => {
    // Only a timeout can still land; a rejection is final. The optimizer needs
    // the difference to count what is genuinely still in flight.
    const reasons: string[] = []
    await settleCandidatePlans(
      [Promise.reject(new Error('boom')), new Promise<string>(() => undefined)],
      20,
      (index, reason) => {
        reasons[index] = reason
        return 'substituted'
      }
    )
    expect(reasons).toEqual(['rejected', 'timeout'])
  })
})
