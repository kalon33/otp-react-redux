import {
  clearReroute,
  setRerouteResult,
  startGoMode,
  startReroute
} from '../../../lib/actions/go-mode'
import {
  getRerouteCandidate,
  getRerouteSearch,
  isRerouteSearchSettled
} from '../../../lib/util/state'
import goMode from '../../../lib/reducers/go-mode'

const initial = goMode(undefined, { type: '@@INIT' })

describe('go-mode re-route reducer', () => {
  it('starts with an idle reRoute state', () => {
    expect(initial.reRoute).toEqual({
      autoApply: false,
      candidate: null,
      candidates: [],
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
      reason: null,
      searchId: 'abc',
      status: 'searching'
    })
  })

  it('START_REROUTE records autoApply and reason for a missed-bus re-plan', () => {
    const state = goMode(
      initial,
      startReroute({ autoApply: true, reason: 'missed-bus', searchId: 'abc' })
    )
    expect(state.reRoute.autoApply).toBe(true)
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
