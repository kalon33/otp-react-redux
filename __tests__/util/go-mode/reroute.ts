import FakeTimers from '@sinonjs/fake-timers'

import {
  clearReroute,
  quietReplanAccessLeg,
  reRouteFromCurrentPosition,
  setRerouteResult,
  startGoMode,
  startReroute
} from '../../../lib/actions/go-mode'
import {
  collectRerouteCandidates,
  itinerarySignature
} from '../../../lib/util/go-mode/reroute-candidates'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import { pickSameRouteReroute } from '../../../lib/util/state'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  // beginGoMode pre-fetches stop times for transit boarding stops — a no-op
  // thunk keeps the applied-splice tests off the network.
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
    modeSettings: [],
    numItineraries: 5
  }))
}))

const initial = goMode(undefined, { type: '@@INIT' })

describe('go-mode re-route reducer', () => {
  it('starts with an idle reRoute state', () => {
    expect(initial.reRoute).toEqual({
      autoApply: false,
      candidate: null,
      candidates: [],
      keepRouteId: null,
      reason: null,
      searchId: null,
      startedAtMs: null,
      status: 'idle'
    })
  })

  it('START_REROUTE marks searching and records the searchId', () => {
    const state = goMode(initial, startReroute({ searchId: 'abc' }))
    expect(state.reRoute).toEqual({
      autoApply: false,
      candidate: null,
      candidates: [],
      keepRouteId: null,
      reason: null,
      searchId: 'abc',
      startedAtMs: null,
      status: 'searching'
    })
  })

  it('START_REROUTE records startedAtMs so a stuck search can be detected', () => {
    const state = goMode(
      initial,
      startReroute({ searchId: 'abc', startedAtMs: 123456 })
    )
    expect(state.reRoute.startedAtMs).toBe(123456)
  })

  it('START_REROUTE records autoApply, keepRouteId and reason for a missed-bus re-plan', () => {
    const state = goMode(
      initial,
      startReroute({
        autoApply: true,
        keepRouteId: '1:546',
        reason: 'missed-bus',
        searchId: 'abc'
      })
    )
    expect(state.reRoute.autoApply).toBe(true)
    expect(state.reRoute.keepRouteId).toBe('1:546')
    expect(state.reRoute.reason).toBe('missed-bus')
  })

  it('SET_REROUTE_RESULT clears autoApply — the auto-apply moment has passed', () => {
    const searching = goMode(
      initial,
      startReroute({ autoApply: true, reason: 'missed-bus', searchId: 'abc' })
    )
    const state = goMode(searching, setRerouteResult(null))
    expect(state.reRoute.autoApply).toBe(false)
    expect(state.reRoute.status).toBe('none')
  })

  it('SET_REROUTE_RESULT with an itinerary -> found + candidate', () => {
    const searching = goMode(initial, startReroute({ searchId: 'abc' }))
    const itin = { duration: 1200 } as any
    const state = goMode(searching, setRerouteResult(itin))
    expect(state.reRoute.status).toBe('found')
    expect(state.reRoute.candidate).toBe(itin)
    // searchId is preserved across the result.
    expect(state.reRoute.searchId).toBe('abc')
  })

  it('SET_REROUTE_RESULT with null -> none', () => {
    const searching = goMode(initial, startReroute({ searchId: 'abc' }))
    const state = goMode(searching, setRerouteResult(null))
    expect(state.reRoute.status).toBe('none')
    expect(state.reRoute.candidate).toBeNull()
  })

  it('CLEAR_REROUTE resets to idle', () => {
    const found = goMode(
      goMode(initial, startReroute({ searchId: 'abc' })),
      setRerouteResult({ duration: 1 } as any)
    )
    const state = goMode(found, clearReroute())
    expect(state.reRoute).toEqual({
      autoApply: false,
      candidate: null,
      candidates: [],
      keepRouteId: null,
      reason: null,
      searchId: null,
      startedAtMs: null,
      status: 'idle'
    })
  })

  it('START_GO_MODE clears any in-flight re-route', () => {
    const searching = goMode(initial, startReroute({ searchId: 'abc' }))
    const state = goMode(
      searching,
      startGoMode({ itinerary: { legs: [] } as any })
    )
    expect(state.reRoute.status).toBe('idle')
    expect(state.reRoute.searchId).toBeNull()
  })
})

describe('collectRerouteCandidates', () => {
  it('de-duplicates by leg signature, sorts by duration and caps the list', () => {
    const itin = (duration: number, routeId = 'r1', to = 'B') =>
      ({
        duration,
        legs: [{ from: { name: 'A' }, mode: 'BUS', routeId, to: { name: to } }]
      } as any)
    const dupA = itin(1500)
    const dupB = itin(1200) // same signature as dupA, shorter — first in input wins dedupe
    const result = collectRerouteCandidates(
      [dupA, dupB, itin(900, 'r2'), itin(1800, 'r3'), itin(600, 'r4')],
      3
    )
    // dupB dropped (same signature as dupA); rest sorted by duration, capped.
    expect(result.map((i: any) => i.duration)).toEqual([600, 900, 1500])
  })

  it('returns [] for empty or missing input', () => {
    expect(collectRerouteCandidates([])).toEqual([])
    expect(collectRerouteCandidates(null)).toEqual([])
    expect(collectRerouteCandidates(undefined)).toEqual([])
  })
})

describe('itinerarySignature', () => {
  const T = 1785364020000 // on a minute boundary, so jitter stays in-bucket
  const orange = (over: any = {}) =>
    ({
      legs: [
        {
          from: { name: 'I-35W & Lake St Station' },
          mode: 'BUS',
          routeId: '1:904',
          startTime: T,
          to: { name: 'I-35W & 46th St Station' },
          transitLeg: true,
          trip: { gtfsId: '1:1201789' },
          ...over
        }
      ]
    } as any)

  it('calls two itineraries the same through live-time jitter', () => {
    // The 8/2 loop applied the same trip nine times; each splice carried
    // second-level realtime jitter that a hash of live times would treat as a
    // new trip. Minute buckets are what make "materially the same" hold.
    expect(itinerarySignature(orange())).toBe(
      itinerarySignature(orange({ startTime: T + 20000 }))
    )
  })

  it('still separates two departures of the same route', () => {
    expect(itinerarySignature(orange())).not.toBe(
      itinerarySignature(
        orange({ startTime: T + 600000, trip: { gtfsId: '1:1201790' } })
      )
    )
  })

  it('separates a genuinely different plan', () => {
    expect(itinerarySignature(orange())).not.toBe(
      itinerarySignature(orange({ routeId: '1:18', to: { name: 'Nicollet' } }))
    )
  })

  it('reads the route id in both leg shapes', () => {
    // A synthesized onboard leg carries route as an object; a planner leg
    // carries the flattened id. Comparing across those two provenances is
    // exactly what the auto-apply guard does.
    expect(
      itinerarySignature(orange({ route: { id: '1:904' }, routeId: undefined }))
    ).toBe(itinerarySignature(orange()))
  })

  it('is empty for nothing at all', () => {
    expect(itinerarySignature(null)).toBe('')
    expect(itinerarySignature(undefined)).toBe('')
  })
})

describe('reRouteFromCurrentPosition (isolated pipeline)', () => {
  const mockedFetch = fetchOnboardCandidatePlan as jest.Mock

  // Minimal store: real goMode reducer behind a hand-rolled dispatch, so the
  // thunk sees its own startReroute take effect (searchId/status) exactly as
  // in the app — and we can inject staleness between request and response.
  const makeStore = (goModeOverrides: any = {}) => {
    let goModeState: any = {
      ...initial,
      activeItinerary: {
        legs: [
          {
            mode: 'WALK',
            to: { lat: 44.98, lon: -93.27, name: 'Destination' }
          }
        ]
      },
      isActive: true,
      tracking: {
        ...initial.tracking,
        lastPosition: { coords: { latitude: 44.95, longitude: -93.29 } }
      },
      ...goModeOverrides
    }
    const actions: any[] = []
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: {},
        goMode: goModeState
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
      setGoMode: (next: any) => {
        goModeState = next
      }
    }
  }

  beforeEach(() => mockedFetch.mockReset())

  it('never touches the shared search pipeline and resolves in the thunk', async () => {
    const itineraries = [
      {
        duration: 900,
        legs: [
          { from: { name: 'A' }, mode: 'BUS', routeId: 'r1', to: { name: 'B' } }
        ]
      }
    ]
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries })
    )
    const store = makeStore()
    await store.dispatch(reRouteFromCurrentPosition())

    const types = store.actions.map((a) => a.type)
    // The whole point of isolation: nothing from the planner pipeline fires.
    expect(types).not.toContain('SET_QUERY_PARAM')
    expect(types).not.toContain('ROUTING_REQUEST')
    expect(types).toContain('START_REROUTE')
    expect(store.getGoMode().reRoute.status).toBe('found')
    expect(store.getGoMode().reRoute.candidates).toEqual(itineraries)
  })

  it('resolves to "none" on an error or empty plan', async () => {
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: true, itineraries: [] })
    )
    const store = makeStore()
    await store.dispatch(reRouteFromCurrentPosition())
    expect(store.getGoMode().reRoute.status).toBe('none')
  })

  it('drops a stale response when a newer reroute superseded it', async () => {
    mockedFetch.mockReturnValue(
      () =>
        new Promise((resolve) => {
          // A newer reroute repoints the token while this one is in flight.
          store.setGoMode({
            ...store.getGoMode(),
            reRoute: { ...store.getGoMode().reRoute, searchId: 'newer' }
          })
          resolve({
            error: false,
            itineraries: [{ duration: 900, legs: [] }]
          })
        })
    )
    const store = makeStore()
    await store.dispatch(reRouteFromCurrentPosition())
    // The stale result must not resolve the newer search's card.
    expect(store.getGoMode().reRoute.status).toBe('searching')
    expect(store.getGoMode().reRoute.searchId).toBe('newer')
  })

  it('bails without fetching when position or itinerary is missing', async () => {
    const store = makeStore({ tracking: { lastPosition: null } })
    await store.dispatch(reRouteFromCurrentPosition())
    expect(mockedFetch).not.toHaveBeenCalled()
    expect(store.getGoMode().reRoute.status).toBe('none')
  })

  // The 7/13 failure: a plan fetch killed by a WebView suspension never
  // settled, so reRoute.status sat at 'searching' for two hours and silently
  // blocked every missed-bus auto-update. The thunk must ALWAYS resolve.
  it('times out a plan fetch that never settles instead of staying "searching"', async () => {
    jest.useFakeTimers()
    try {
      // a Promise that never settles — the suspension-killed fetch
      mockedFetch.mockReturnValue(() => new Promise(() => undefined))
      const store = makeStore()
      const pending = store.dispatch(reRouteFromCurrentPosition())
      expect(store.getGoMode().reRoute.status).toBe('searching')
      jest.advanceTimersByTime(46000)
      await pending
      expect(store.getGoMode().reRoute.status).toBe('none')
    } finally {
      jest.useRealTimers()
    }
  })

  it('resolves to "none" when the plan fetch rejects', async () => {
    mockedFetch.mockReturnValue(() => Promise.reject(new Error('network')))
    const store = makeStore()
    await store.dispatch(reRouteFromCurrentPosition())
    expect(store.getGoMode().reRoute.status).toBe('none')
  })

  it('records a wall-clock startedAtMs on the in-flight search', async () => {
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [] })
    )
    const store = makeStore()
    const before = Date.now()
    await store.dispatch(reRouteFromCurrentPosition())
    const started = store.actions.find(
      (a) => a.type === 'START_REROUTE'
    )?.payload
    expect(started.startedAtMs).toBeGreaterThanOrEqual(before)
  })
})

describe('quietReplanAccessLeg (leg-scoped with full-trip fallback)', () => {
  const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
  const T = 1785400000000
  // The thunk throttles on a module-level wall clock (60s between replans) —
  // march a mocked Date forward so every test gets a fresh window. Direct
  // @sinonjs/fake-timers (Date only, real setTimeout): jest.setSystemTime is
  // unusable here — duplicated @jest/fake-timers copies fail its instanceof
  // guard.
  let clock = T
  let dateFaker: FakeTimers.InstalledClock | undefined

  const advanceClock = (ms: number) => {
    clock += ms
    dateFaker?.setSystemTime(clock)
  }

  // A bike → bus → walk trip (the 7/29 shape). Fresh objects per store so the
  // suffix-identity assertions are per-test.
  const makeTrip = () => {
    const bikeLeg = {
      distance: 2000,
      endTime: T + 600000,
      mode: 'BICYCLE',
      startTime: T,
      transitLeg: false
    } as any
    const busLeg = {
      distance: 8000,
      endTime: T + 1560000,
      from: {
        lat: 44.86,
        lon: -93.3,
        name: 'Knox & 76th St',
        stop: { gtfsId: '1:12345' }
      },
      mode: 'BUS',
      routeId: '1:904',
      startTime: T + 660000,
      transitLeg: true
    } as any
    const walkLeg = {
      distance: 300,
      endTime: T + 1800000,
      mode: 'WALK',
      startTime: T + 1560000,
      to: { lat: 44.98, lon: -93.27, name: 'Destination' },
      transitLeg: false
    } as any
    return {
      busLeg,
      itinerary: {
        duration: 1800,
        endTime: T + 1800000,
        legs: [bikeLeg, busLeg, walkLeg],
        startTime: T,
        transfers: 0
      },
      walkLeg
    }
  }

  const makeStore = (trip: ReturnType<typeof makeTrip>) => {
    let goModeState: any = {
      ...initial,
      activeItinerary: trip.itinerary,
      isActive: true,
      routeMatch: { legIndex: 0 },
      tracking: {
        ...initial.tracking,
        lastPosition: { coords: { latitude: 44.85, longitude: -93.31 } }
      }
    }
    const actions: any[] = []
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: {},
        goMode: goModeState
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      actions.push(action)
      goModeState = goMode(goModeState, action)
      return action
    }
    return { actions, dispatch, getGoMode: () => goModeState }
  }

  beforeEach(() => {
    mockedFetch.mockReset()
    dateFaker = FakeTimers.install({ now: clock, toFake: ['Date'] })
    advanceClock(600000)
  })
  afterEach(() => {
    dateFaker?.uninstall()
    dateFaker = undefined
  })

  it('scopes the query to the access chain: GPS → boarding stop, bike mode only', async () => {
    const trip = makeTrip()
    const newBike = {
      distance: 2400,
      endTime: T + 700000,
      mode: 'BICYCLE',
      startTime: T + 160000,
      transitLeg: false
    }
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({
        error: false,
        itineraries: [
          {
            duration: 540,
            endTime: T + 700000,
            legs: [newBike],
            startTime: T + 160000
          }
        ]
      })
    )
    const store = makeStore(trip)
    await store.dispatch(quietReplanAccessLeg())

    expect(mockedFetch).toHaveBeenCalledTimes(1)
    const payload = mockedFetch.mock.calls[0][0]
    // To the BOARDING STOP, not the destination — the bus legs are not up for
    // re-planning ("only reroute the bike leg, don't switch my bus routes").
    expect(payload.to).toEqual({
      lat: 44.86,
      lon: -93.3,
      name: 'Knox & 76th St'
    })
    expect(payload.modes).toEqual([{ mode: 'BICYCLE' }])
    expect(payload.numItineraries).toBe(3)
  })

  it('applies the splice: suffix legs are the ORIGINAL objects', async () => {
    const trip = makeTrip()
    const newBike = {
      distance: 2400,
      endTime: T + 700000,
      mode: 'BICYCLE',
      startTime: T + 160000,
      transitLeg: false
    }
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({
        error: false,
        itineraries: [
          {
            duration: 540,
            endTime: T + 700000,
            legs: [newBike],
            startTime: T + 160000
          }
        ]
      })
    )
    const store = makeStore(trip)
    await store.dispatch(quietReplanAccessLeg())

    const applied = store.actions.find((a) => a.type === 'START_GO_MODE')
      ?.payload?.itinerary
    expect(applied).toBeTruthy()
    expect(applied.legs).toHaveLength(3)
    expect(applied.legs[0]).toBe(newBike)
    // Identity, not equality: same objects ⇒ same times/stops/routes — a
    // later bus can never be invented by an access replan.
    expect(applied.legs[1]).toBe(trip.busLeg)
    expect(applied.legs[2]).toBe(trip.walkLeg)
    expect(applied.endTime).toBe(T + 1800000)
  })

  it('falls back to the full-trip replan when the scoped plan is empty', async () => {
    const trip = makeTrip()
    const sameRoute = {
      duration: 1700,
      legs: [
        { mode: 'BICYCLE', transitLeg: false },
        {
          mode: 'BUS',
          routeId: '1:904',
          startTime: T + 900000,
          transitLeg: true
        }
      ]
    }
    const otherRoute = {
      duration: 1400,
      legs: [
        { mode: 'BICYCLE', transitLeg: false },
        {
          mode: 'BUS',
          routeId: '1:18',
          startTime: T + 800000,
          transitLeg: true
        }
      ]
    }
    mockedFetch
      .mockReturnValueOnce(() =>
        Promise.resolve({ error: false, itineraries: [] })
      )
      .mockReturnValueOnce(() =>
        Promise.resolve({ error: false, itineraries: [otherRoute, sameRoute] })
      )
    const store = makeStore(trip)
    await store.dispatch(quietReplanAccessLeg())

    expect(mockedFetch).toHaveBeenCalledTimes(2)
    const fallbackPayload = mockedFetch.mock.calls[1][0]
    // The fallback is today's full-trip replan: destination, full mode set.
    expect(fallbackPayload.to).toEqual({
      lat: 44.98,
      lon: -93.27,
      name: 'Destination'
    })
    expect(fallbackPayload.modes).toEqual([
      { mode: 'TRANSIT' },
      { mode: 'WALK' }
    ])
    // Only a picker-approved (same next route) result may apply.
    const applied = store.actions.find((a) => a.type === 'START_GO_MODE')
      ?.payload?.itinerary
    expect(applied).toBe(sameRoute)
  })

  it('leaves the trip alone when the fallback boards a different route', async () => {
    const trip = makeTrip()
    const otherRoute = {
      duration: 1400,
      legs: [
        { mode: 'BICYCLE', transitLeg: false },
        {
          mode: 'BUS',
          routeId: '1:18',
          startTime: T + 800000,
          transitLeg: true
        }
      ]
    }
    mockedFetch
      .mockReturnValueOnce(() =>
        Promise.resolve({ error: false, itineraries: [] })
      )
      .mockReturnValueOnce(() =>
        Promise.resolve({ error: false, itineraries: [otherRoute] })
      )
    const store = makeStore(trip)
    await store.dispatch(quietReplanAccessLeg())

    expect(
      store.actions.find((a) => a.type === 'START_GO_MODE')
    ).toBeUndefined()
  })

  it('miss streak settles silently — no dead non-autoApply reroute fetch (A4)', async () => {
    const trip = makeTrip()
    // Every fetch (scoped + fallback, twice over) comes back empty: the old
    // escalation dispatched reRouteFromCurrentPosition() on the second miss,
    // whose Switch/Keep card nothing has rendered since eb74a9d8 — it must
    // stay gone.
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [] })
    )
    const store = makeStore(trip)
    await store.dispatch(quietReplanAccessLeg())
    advanceClock(61000)
    await store.dispatch(quietReplanAccessLeg())

    expect(mockedFetch).toHaveBeenCalledTimes(4)
    const types = store.actions.map((a) => a.type)
    expect(types).not.toContain('START_REROUTE')
    expect(store.getGoMode().reRoute.status).toBe('idle')
  })
})

describe('pickSameRouteReroute', () => {
  const T = 1783788000000
  const itin = (routeId, startOffsetMs, mode = 'BUS') => ({
    legs: [
      { mode: 'WALK', startTime: T + startOffsetMs - 60000 },
      {
        mode,
        routeId,
        startTime: T + startOffsetMs,
        transitLeg: true
      }
    ]
  })
  const bikeOnly = { legs: [{ mode: 'BICYCLE', startTime: T }] }

  it('keeps the rider on their route: next departure, never the bike-only "winner"', () => {
    const picked = pickSameRouteReroute(
      [
        bikeOnly,
        itin('1:18', 120000),
        itin('1:546', 3000000),
        itin('1:546', 600000)
      ],
      '1:546'
    )
    // The 546 in 10 minutes — not the bike itinerary, not the other route,
    // not the later 546.
    expect(picked.legs[1].routeId).toBe('1:546')
    expect(picked.legs[1].startTime).toBe(T + 600000)
  })

  it('reads OTP2-style route objects too', () => {
    const otp2 = {
      legs: [
        {
          mode: 'BUS',
          route: { gtfsId: '1:546' },
          startTime: T + 300000,
          transitLeg: true
        }
      ]
    }
    expect(pickSameRouteReroute([bikeOnly, otp2], '1:546')).toBe(otp2)
  })

  it('returns null when nothing boards the route (rider decides via the card)', () => {
    expect(
      pickSameRouteReroute([bikeOnly, itin('1:18', 120000)], '1:546')
    ).toBeNull()
    expect(pickSameRouteReroute([itin('1:546', 60000)], null)).toBeNull()
    expect(pickSameRouteReroute([], '1:546')).toBeNull()
  })
})
