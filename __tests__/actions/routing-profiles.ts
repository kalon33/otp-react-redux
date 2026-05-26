import { applyPreferencesFromText } from '../../lib/actions/routing-profiles'

const g = global as any

describe('applyPreferencesFromText', () => {
  const getState = () => ({ otp: { config: {} } })
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
    const prefs = await applyPreferencesFromText('avoid walking')(
      dispatch,
      getState
    )
    // walkReluctance clamped to its max (25); transferPenalty in range.
    expect(prefs).toEqual({ transferPenalty: 600, walkReluctance: 25 })
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
})
