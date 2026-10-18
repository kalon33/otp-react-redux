import { applyPreferencesFromText } from '../../lib/actions/routing-profiles'
import { FETCH_STATUS } from '../../lib/util/constants'

const g = global as any

describe('applyPreferencesFromText', () => {
  const getState = () => ({
    otp: {
      config: {},
      currentQuery: {},
      transitIndex: { routes: {}, routesFetchStatus: FETCH_STATUS.FETCHED }
    }
  })
  const mockFetch = (impl: any): void => {
    g.fetch = jest.fn().mockResolvedValue(impl)
  }

  afterEach(() => {
    g.fetch = undefined
  })

  it('clamps the returned preferences and dispatches them', async () => {
    mockFetch({
      json: async () => ({
        preferences: { transferPenalty: 600, walkReluctance: 999 }
      }),
      ok: true
    })
    const dispatch = jest.fn()
    const { preferences } = await applyPreferencesFromText('avoid walking')(
      dispatch,
      getState
    )
    // walkReluctance clamped to its max (25); transferPenalty in range.
    expect(preferences).toEqual({ transferPenalty: 600, walkReluctance: 25 })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('throws when the endpoint errors', async () => {
    mockFetch({ ok: false, status: 502 })
    await expect(
      applyPreferencesFromText('x')(jest.fn(), getState)
    ).rejects.toThrow()
  })

  it('throws when no usable levers are returned', async () => {
    mockFetch({ json: async () => ({ preferences: { bogus: 5 } }), ok: true })
    await expect(
      applyPreferencesFromText('x')(jest.fn(), getState)
    ).rejects.toThrow()
  })

  it('locks to a route the rider named, with no levers of its own', async () => {
    mockFetch({
      json: async () => ({ preferences: {}, routeQuery: '18' }),
      ok: true
    })
    const { result } = await runWith('only the 18')
    expect(result.locks).toEqual([{ id: '1:18', label: '18' }])
    expect(result.routeQueries).toEqual(['18'])
  })

  it('reports a named route that the graph does not have', async () => {
    mockFetch({
      json: async () => ({ preferences: {}, routeQuery: 'Purple Line' }),
      ok: true
    })
    const { patches, result } = await runWith('only the Purple Line')
    // Nothing matched, so nothing was locked — and the caller is told which
    // name failed rather than being handed a silently unconstrained search.
    expect(result.locks).toEqual([])
    expect(result.missing).toEqual(['Purple Line'])
    expect(patches.some((p) => 'routeLock' in p)).toBe(false)
  })
})

/**
 * The describe box over several routes (58.2, cycle 27 Q5/Q7), end to end
 * through the real thunks against a valid query, with the search counted
 * rather than run.
 */
jest.mock('../../lib/actions/api', () => ({
  ...jest.requireActual('../../lib/actions/api'),
  routingQuery: (searchId: string) => ({
    payload: searchId,
    type: 'TEST_ROUTING_QUERY'
  })
}))

const ROUTES = {
  '1:18': { longName: 'Nicollet Av', shortName: '18' },
  '1:21': { longName: 'Lake St', shortName: '21' },
  '1:904': { longName: 'METRO Orange Line', shortName: null }
}

async function runWith(text: string, currentQuery: any = {}) {
  const state = {
    otp: {
      config: {},
      currentQuery: {
        from: { lat: 44.8168, lon: -93.3102, name: 'Home' },
        to: { lat: 45.0, lon: -92.9489, name: 'Oakdale' },
        ...currentQuery
      },
      transitIndex: { routes: ROUTES, routesFetchStatus: FETCH_STATUS.FETCHED }
    }
  }
  const patches: any[] = []
  let searches = 0
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, () => state)
    if (action?.type === 'SET_QUERY_PARAM') patches.push(action.payload)
    if (action?.type === 'TEST_ROUTING_QUERY') searches += 1
    return action
  }
  const result = await dispatch(applyPreferencesFromText(text))
  return { patches, result, searches }
}

describe('applyPreferencesFromText over several routes', () => {
  const answer = (data: any) => {
    g.fetch = jest.fn().mockResolvedValue({ json: async () => data, ok: true })
  }
  afterEach(() => {
    g.fetch = undefined
  })

  it('"only the 18 and 21" holds the search to both, with ONE search', async () => {
    answer({ preferences: {}, routeQueries: ['18', '21'], routeQuery: '18' })
    const { patches, result, searches } = await runWith('only the 18 and 21')
    expect(searches).toBe(1)
    const locked = patches.filter((p) => p.routeLock)
    expect(locked).toHaveLength(1)
    expect(locked[0].routeLock.routes.map((r: any) => r.id)).toEqual([
      '1:18',
      '1:21'
    ])
    expect(result.locks.map((r: any) => r.label)).toEqual(['18', '21'])
  })

  it('levers and routes together still cost one search', async () => {
    answer({
      preferences: { transferPenalty: 600 },
      routeQueries: ['18', '21']
    })
    const { searches } = await runWith('fewer transfers, only 18 and 21')
    expect(searches).toBe(1)
  })

  it("an old sidecar's single route still locks one route", async () => {
    answer({ preferences: {}, routeQuery: '18' })
    const { patches, searches } = await runWith('only the 18')
    expect(searches).toBe(1)
    expect(
      patches.find((p) => p.routeLock).routeLock.routes.map((r: any) => r.id)
    ).toEqual(['1:18'])
  })

  it('holds to what exists and names what does not', async () => {
    answer({ preferences: {}, routeQueries: ['18', '99'] })
    const { patches, result } = await runWith('only the 18 and 99')
    expect(result.locks).toEqual([{ id: '1:18', label: '18' }])
    expect(result.missing).toEqual(['99'])
    expect(
      patches.find((p) => p.routeLock).routeLock.routes.map((r: any) => r.id)
    ).toEqual(['1:18'])
  })

  it('replaces the set already in place (Q7 = A)', async () => {
    answer({ preferences: {}, routeQueries: ['21'] })
    const { patches } = await runWith('only the 21', {
      routeLock: {
        routes: [
          { id: '1:18', label: '18' },
          { id: '1:904', label: 'METRO Orange Line' }
        ],
        scope: 'only'
      }
    })
    expect(
      patches.find((p) => p.routeLock).routeLock.routes.map((r: any) => r.id)
    ).toEqual(['1:21'])
  })

  it('levers alone search once, as before', async () => {
    answer({ preferences: { walkReluctance: 4 } })
    const { result, searches } = await runWith('walk less')
    expect(searches).toBe(1)
    expect(result.locks).toEqual([])
  })
})
