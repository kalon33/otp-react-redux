import '../test-utils/mock-window-url'
import {
  formatRecentSearch,
  shouldRememberPlace
} from '../../lib/actions/apiV2'

describe('actions > apiV2 > shouldRememberPlace', () => {
  it('remembers a plain geocoded place', () => {
    expect(
      shouldRememberPlace({ lat: 44.8, lon: -93.3, name: 'City Hall' })
    ).toBe(true)
  })

  it('skips the live-GPS origin', () => {
    expect(
      shouldRememberPlace({
        category: 'CURRENT_LOCATION',
        lat: 44.8,
        lon: -93.3,
        name: '(Current Location)'
      })
    ).toBe(false)
  })

  it('skips an untagged "Current location" origin by name', () => {
    // Synthetic reroute origins should carry category CURRENT_LOCATION, but a
    // bare name must never slip into recents either (7/12 ride: saved 24x).
    expect(
      shouldRememberPlace({ lat: 44.8, lon: -93.3, name: 'Current location' })
    ).toBe(false)
    expect(
      shouldRememberPlace({ lat: 44.8, lon: -93.3, name: '(Current Location)' })
    ).toBe(false)
  })

  it('still remembers a place whose name merely contains those words', () => {
    expect(
      shouldRememberPlace({
        lat: 44.8,
        lon: -93.3,
        name: 'Current Location Coffee Co'
      })
    ).toBe(true)
  })

  it('skips already-saved place types', () => {
    for (const type of ['home', 'work', 'suggested', 'stop']) {
      expect(shouldRememberPlace({ name: 'x', type })).toBe(false)
    }
  })

  it('skips a missing endpoint', () => {
    expect(shouldRememberPlace(null)).toBe(false)
    expect(shouldRememberPlace(undefined)).toBe(false)
  })
})

/**
 * REMEMBER_SEARCH is the only durable record of what a search asked for, and
 * for 347 records between 2026-08-25 and 09-01 the `mode` field in it read
 * "WALK,TRANSIT" while every request that produced it went out as transit+bike.
 * It is the OTP1 query param's untouched default, and nothing in this app ever
 * writes or sends it — but it reads like ground truth, and a session spent a
 * diagnosis on it (backlog 6.15/6.18).
 */
describe('actions > apiV2 > formatRecentSearch', () => {
  const state = {
    otp: {
      currentQuery: {
        date: '2026-09-02',
        departArrive: 'NOW',
        from: { lat: 44.95, lon: -93.29, name: 'Origin' },
        mode: 'WALK,TRANSIT',
        numItineraries: 5,
        time: '08:00',
        to: { lat: 44.98, lon: -93.27, name: 'Destination' }
      }
    }
  }
  const modes = [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }]

  it('does not record the legacy mode string', () => {
    const { query } = formatRecentSearch(state, { modeButtons: null }, modes)
    expect(query.mode).toBeUndefined()
  })

  it('records the modes the request actually went out with', () => {
    const { query } = formatRecentSearch(state, { modeButtons: null }, modes)
    expect(query.modes).toEqual(modes)
  })

  it('keeps the places, and the raw mode-button param beside them', () => {
    const { query } = formatRecentSearch(
      state,
      { modeButtons: 'transit_bike_bicycle' },
      modes
    )
    expect(query.from.name).toBe('Origin')
    expect(query.to.name).toBe('Destination')
    expect(query.queryParamData.modeButtons).toBe('transit_bike_bicycle')
  })
})
