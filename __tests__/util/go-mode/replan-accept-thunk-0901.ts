import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import { endGoMode, quietReplanAccessLeg } from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
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
 * 2026-09-01, ride 3 (backlog 6.12 and the real half of 6.2).
 *
 * The rider's closing bike leg took three automatic `START_GO_MODE` itinerary
 * replacements in 83 seconds — 213 s, then 244 s, then 371 s of remaining trip,
 * getting LONGER while they closed on home, none of them asked for. All three
 * came out of `quietReplanAccessLeg`'s full-trip fallback, whose picker
 * (`pickAccessReplanCandidate`) sorts the candidates by duration and hands back
 * the fastest — a ranking among the alternatives that never once looked at the
 * plan the rider already had.
 *
 * The middle swap is also where "the route match is not rebuilt on a swap"
 * really comes from: its plan was anchored to a fix taken 13 s before it was
 * applied, so its first leg started 91 m behind a rider doing 7.7 m/s, and the
 * projection spent the next 30 s pinned to the start of a polyline they were
 * never on.
 */

// Due-north bike leg: the rider's own direction of travel on that ride.
const ORIGIN: [number, number] = [44.8132, -93.3055]
const DEST: [number, number] = [44.8165, -93.3098]
const NOW = 1_788_278_889_000

const currentPlan = () => ({
  duration: 300,
  endTime: NOW + 300_000,
  legs: [
    {
      distance: 560,
      duration: 300,
      endTime: NOW + 300_000,
      from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Current location' },
      legGeometry: { points: encode([ORIGIN, DEST]) },
      mode: 'BICYCLE',
      startTime: NOW,
      to: { lat: DEST[0], lon: DEST[1], name: 'Home' },
      transitLeg: false
    }
  ],
  startTime: NOW
})

/** A candidate all-bike plan: `endsAt` ms, starting `startsAt`. */
const candidate = (endTime: number, startsAt: [number, number]) => ({
  duration: (endTime - NOW) / 1000,
  endTime,
  legs: [
    {
      distance: 560,
      duration: (endTime - NOW) / 1000,
      endTime,
      from: { lat: startsAt[0], lon: startsAt[1], name: 'Current location' },
      legGeometry: { points: encode([startsAt, DEST]) },
      mode: 'BICYCLE',
      startTime: NOW,
      to: { lat: DEST[0], lon: DEST[1], name: 'Home' },
      transitLeg: false
    }
  ],
  startTime: NOW
})

const fix = (at: [number, number]): GeolocationPosition =>
  ({
    coords: {
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: at[0],
      longitude: at[1],
      speed: 7.7
    },
    timestamp: NOW
  } as GeolocationPosition)

/** Same minimal store the other action-level Go Mode cases use. */
const makeStore = (riderAt: [number, number], riding: any = null) => {
  let goModeState: any = {
    ...initial,
    activeItinerary: currentPlan(),
    isActive: true,
    riding,
    routeMatch: { legIndex: 0, progressAlongLeg: 0.4 },
    tracking: { ...initial.tracking, lastPosition: fix(riderAt) }
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
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    goModeState = goMode(goModeState, action)
    return action
  }
  return {
    activeItinerary: () => goModeState.activeItinerary,
    run: (thunk: any) => thunk(dispatch, getState),
    types: () => actions.map((a) => a.type)
  }
}

describe('a quiet replan is not allowed to make the trip worse (2026-09-01)', () => {
  let clock: FakeTimers.InstalledClock | undefined
  let store: ReturnType<typeof makeStore> | undefined

  beforeEach(() => {
    mockedFetch.mockReset()
    clock = FakeTimers.install({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    // The re-plan cooldown is TripSession state, so every case is its own trip.
    store?.run(endGoMode())
    store = undefined
    clock?.uninstall()
    clock = undefined
  })

  const replanWith = async (
    plan: any,
    riderAt: [number, number] = ORIGIN,
    riding: any = null
  ): Promise<ReturnType<typeof makeStore>> => {
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [plan] })
    )
    store = makeStore(riderAt, riding)
    await store.run(quietReplanAccessLeg())
    return store
  }

  it('applies a replacement that arrives sooner (the 16:08:09 swap)', async () => {
    const better = candidate(NOW + 213_000, ORIGIN)
    const s = await replanWith(better)
    expect(s.types()).toContain('START_GO_MODE')
    expect(s.activeItinerary().endTime).toBe(NOW + 213_000)
  })

  it('refuses one that arrives LATER than the plan in hand (the 16:09:32 swap)', async () => {
    // 371 s of remaining trip offered against the 300 s the rider already had.
    // Unfixed, pickAccessReplanCandidate returns it — it is the only candidate,
    // so it is also the fastest — and beginGoMode swaps it in unasked.
    const worse = candidate(NOW + 371_000, ORIGIN)
    const s = await replanWith(worse)
    expect(s.types()).not.toContain('START_GO_MODE')
    expect(s.activeItinerary().endTime).toBe(NOW + 300_000)
  })

  it('refuses one whose first leg starts behind the rider (the 16:09:02 swap)', async () => {
    // Faster on paper, but planned from a fix the rider is already 91 m past:
    // 0.00082 degrees of latitude is ~91 m, the measured gap on that swap.
    const stale = candidate(NOW + 200_000, ORIGIN)
    const s = await replanWith(stale, [ORIGIN[0] + 0.00082, ORIGIN[1]])
    expect(s.types()).not.toContain('START_GO_MODE')
    expect(s.activeItinerary().endTime).toBe(NOW + 300_000)
  })

  it('does not re-plan at all while the rider is verifiably on a bus (3.6)', async () => {
    // The matcher advances routeMatch.legIndex on geometry alone and has led
    // the real boarding by four minutes, so a rider still sitting on the bus
    // can look like a rider drifting off the bike leg after it. Answering that
    // with an all-BICYCLE plan takes them off the bus they are sitting on.
    const bikeAway = candidate(NOW + 200_000, ORIGIN)
    const s = await replanWith(bikeAway, ORIGIN, {
      boardedAt: NOW - 300_000,
      legIndex: 0,
      routeId: '1:904',
      tripId: '1:trip-orange'
    })
    expect(s.types()).not.toContain('START_GO_MODE')
    // Not merely refused at the end — never fetched at all.
    expect(mockedFetch).not.toHaveBeenCalled()
  })
})
