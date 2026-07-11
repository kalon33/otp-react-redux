import {
  clearReroute,
  setRerouteResult,
  startGoMode,
  startReroute
} from '../../../lib/actions/go-mode'
import {
  getRerouteCandidate,
  getRerouteSearch,
  isRerouteSearchSettled,
  pickSameRouteReroute
} from '../../../lib/util/state'
import goMode from '../../../lib/reducers/go-mode'

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
      status: 'searching'
    })
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

describe('go-mode re-route selectors', () => {
  const buildState = (searchId: string | null, search: any) => ({
    otp: {
      goMode: { reRoute: { searchId } },
      searches: search ? { [searchId as string]: search } : {}
    }
  })

  it('getRerouteSearch returns null when no re-route is underway', () => {
    expect(getRerouteSearch(buildState(null, null) as any)).toBeNull()
  })

  it('getRerouteCandidate picks the shortest-duration itinerary, ignoring errors', () => {
    const state = buildState('s1', {
      pending: 0,
      response: [
        { plan: { itineraries: [{ duration: 1500 }, { duration: 1200 }] } },
        { error: { id: 404 } },
        { plan: { itineraries: [{ duration: 1800 }] } }
      ]
    })
    expect(getRerouteCandidate(state as any)).toEqual({ duration: 1200 })
  })

  it('getRerouteCandidate returns null before any itineraries arrive', () => {
    const state = buildState('s1', { pending: 2, response: [] })
    expect(getRerouteCandidate(state as any)).toBeNull()
  })

  it('isRerouteSearchSettled is false while pending, true at zero', () => {
    expect(
      isRerouteSearchSettled(buildState('s1', { pending: 2 }) as any)
    ).toBe(false)
    expect(
      isRerouteSearchSettled(buildState('s1', { pending: 0 }) as any)
    ).toBe(true)
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
