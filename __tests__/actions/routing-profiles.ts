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
    const routes = { '1:18': { longName: 'Nicollet Av', shortName: '18' } }
    const dispatch = jest.fn((action) =>
      typeof action === 'function'
        ? action(dispatch, () => ({
            otp: {
              config: {},
              currentQuery: {},
              transitIndex: { routes, routesFetchStatus: FETCH_STATUS.FETCHED }
            }
          }))
        : action
    )
    const result = await applyPreferencesFromText('only the 18')(
      dispatch,
      () => ({
        otp: {
          config: {},
          currentQuery: {},
          transitIndex: { routes, routesFetchStatus: FETCH_STATUS.FETCHED }
        }
      })
    )
    expect(result.lock).toEqual({ id: '1:18', label: '18' })
    expect(result.routeQuery).toBe('18')
  })

  it('reports a named route that the graph does not have', async () => {
    mockFetch({
      json: async () => ({ preferences: {}, routeQuery: 'Purple Line' }),
      ok: true
    })
    const dispatch = jest.fn((action) =>
      typeof action === 'function' ? action(dispatch, getState) : action
    )
    const result = await applyPreferencesFromText('only the Purple Line')(
      dispatch,
      getState
    )
    // Nothing matched, so nothing was locked — and the caller is told which
    // name failed rather than being handed a silently unconstrained search.
    expect(result.lock).toBeNull()
    expect(result.routeQuery).toBe('Purple Line')
  })
})
