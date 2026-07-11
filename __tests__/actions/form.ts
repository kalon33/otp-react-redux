import '../test-utils/mock-window-url'
import {
  checkShouldReplanTrip,
  syncCurrentLocationOrigin
} from '../../lib/actions/form'

describe('actions > form', () => {
  describe('syncCurrentLocationOrigin', () => {
    const runThunk = (currentQuery: any, currentPosition: any) => {
      const dispatched: any[] = []
      const dispatch = (action: any) => dispatched.push(action)
      const getState = () => ({
        otp: { currentQuery, location: { currentPosition } }
      })
      syncCurrentLocationOrigin()(dispatch, getState)
      return dispatched
    }

    const gpsFix = { coords: { latitude: 44.9, longitude: -93.29 } }

    it('refreshes a Current Location origin to the latest GPS fix', () => {
      const from = {
        category: 'CURRENT_LOCATION',
        lat: 44.8,
        lon: -93.3,
        name: '(Current Location)'
      }
      const dispatched = runThunk({ from }, gpsFix)
      expect(dispatched).toHaveLength(1)
      const { location, locationType } = dispatched[0].payload
      expect(locationType).toBe('from')
      expect(location.lat).toBe(44.9)
      expect(location.lon).toBe(-93.29)
      // Label and category must survive the refresh.
      expect(location.name).toBe('(Current Location)')
      expect(location.category).toBe('CURRENT_LOCATION')
    })

    it('leaves a regular origin untouched', () => {
      const from = { lat: 44.8, lon: -93.3, name: 'Bloomington City Hall' }
      expect(runThunk({ from }, gpsFix)).toHaveLength(0)
    })

    it('does nothing without a GPS fix or when coords are unchanged', () => {
      const from = {
        category: 'CURRENT_LOCATION',
        lat: 44.9,
        lon: -93.29,
        name: '(Current Location)'
      }
      expect(runThunk({ from }, undefined)).toHaveLength(0)
      expect(runThunk({ from }, { error: true })).toHaveLength(0)
      expect(runThunk({ from }, gpsFix)).toHaveLength(0)
    })
  })

  describe('checkShouldReplanTrip', () => {
    it('should not replan trip on mobile (with default autoPlan settings) if both locations change from null', () => {
      const autoPlan = {
        default: 'ONE_LOCATION_CHANGED',
        mobile: 'BOTH_LOCATIONS_CHANGED'
      }
      const oldQuery = {
        from: null,
        to: null
      }
      const newQuery = {
        from: { name: 'From place' },
        to: { name: 'To place' }
      }
      expect(
        checkShouldReplanTrip(autoPlan, true, oldQuery, newQuery)
          .shouldReplanTrip
      ).toBe(null)
    })
  })
})
