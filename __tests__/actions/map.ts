import '../test-utils/mock-window-url'
import { setLocationToCurrent } from '../../lib/actions/map'

describe('actions > map > setLocationToCurrent', () => {
  const intl = { formatMessage: () => '(Current Location)' }

  it('sets a stable "(Current Location)" origin and never reverse-geocodes it', () => {
    const dispatched: any[] = []
    const dispatch = (action: any) => {
      // A thunk here would be the reverse-geocoding setLocation call — the
      // exact behavior that used to overwrite the label with a street address.
      if (typeof action === 'function') {
        throw new Error('unexpected thunk dispatched (reverse geocode?)')
      }
      dispatched.push(action)
    }
    const getState = () => ({
      otp: {
        goMode: { isActive: false },
        location: {
          currentPosition: {
            coords: { latitude: 44.816775, longitude: -93.31033 }
          }
        }
      }
    })
    setLocationToCurrent({ locationType: 'from' }, intl)(dispatch, getState)

    expect(dispatched).toHaveLength(1)
    const { location, locationType } = dispatched[0].payload
    expect(locationType).toBe('from')
    expect(location).toEqual({
      category: 'CURRENT_LOCATION',
      lat: 44.816775,
      lon: -93.31033,
      name: '(Current Location)'
    })
  })

  it('does nothing without a usable GPS fix', () => {
    const dispatched: any[] = []
    const getState = () => ({
      otp: {
        goMode: { isActive: false },
        location: { currentPosition: { error: 'denied' } }
      }
    })
    setLocationToCurrent({ locationType: 'from' }, intl)(
      (a: any) => dispatched.push(a),
      getState
    )
    expect(dispatched).toHaveLength(0)
  })
})
