import '../test-utils/mock-window-url'
import { shouldRememberPlace } from '../../lib/actions/apiV2'

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
