import {
  clearReroute,
  reRouteFromCurrentPosition,
  setRerouteResult,
  startGoMode,
  startReroute
} from '../../../lib/actions/go-mode'
import { collectRerouteCandidates } from '../../../lib/util/go-mode/reroute-candidates'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import { pickSameRouteReroute } from '../../../lib/util/state'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
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
