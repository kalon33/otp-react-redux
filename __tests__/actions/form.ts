import '../test-utils/mock-window-url'
import coreUtils from '@opentripplanner/core-utils'

import {
  allDeparturesPassed,
  checkShouldReplanTrip,
  formChanged,
  syncCurrentLocationOrigin
} from '../../lib/actions/form'
import { MobileScreens } from '../../lib/actions/ui-constants'

describe('actions > form', () => {
  describe('allDeparturesPassed', () => {
    const NOW = 1783788000000

    it('is stale only when every displayed departure is in the past', () => {
      expect(
        allDeparturesPassed(
          [{ startTime: NOW - 60000 }, { startTime: NOW - 1000 }],
          NOW
        )
      ).toBe(true)
      expect(
        allDeparturesPassed(
          [{ startTime: NOW - 60000 }, { startTime: NOW + 300000 }],
          NOW
        )
      ).toBe(false)
    })

    it('is never stale with no results', () => {
      expect(allDeparturesPassed([], NOW)).toBe(false)
    })
  })

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

  /**
   * 6.54. A live Go Mode trip owns the mobile screen.
   *
   * Emulator session mtlutz2c-mfb2nx (2026-09-03 18:24:39Z): the app was
   * killed and relaunched mid-trip, RESUME_GO_MODE restored the trip on the
   * Go Mode screen (10), then the first GPS fix made responsive-webapp
   * auto-populate the empty `currentQuery.from` — and formChanged answered
   * that with CLEAR_ACTIVE_SEARCH + SET_MOBILE_SCREEN 3 (SEARCH_FORM). The
   * rider was left on a bare search form with `go.on` still true and
   * `goMode.ui.backgrounded` still false, so the ReturnToTripBanner never
   * rendered and there was no way back to the running trip.
   */
  describe('formChanged during a live trip', () => {
    const runFormChanged = (goMode: any, mobileScreen: number) => {
      const dispatched: any[] = []
      const getState = () => ({
        otp: {
          config: { autoPlan: {} },
          currentQuery: { departArrive: 'DEPART' },
          goMode,
          location: { currentPosition: {} },
          ui: { mobileScreen }
        }
      })
      const dispatch = (action: any): any => {
        if (typeof action === 'function') return action(dispatch, getState)
        dispatched.push(action)
        return action
      }
      const oldQuery = { from: null, to: { lat: 44.97, lon: -93.26 } }
      const newQuery = {
        from: {
          category: 'CURRENT_LOCATION',
          lat: 44.8834983,
          lon: -93.2954,
          name: '(Current Location)'
        },
        to: { lat: 44.97, lon: -93.26 }
      }
      formChanged(oldQuery, newQuery)(dispatch, getState)
      return dispatched.map((a) => a.type)
    }

    let isMobileSpy: jest.SpyInstance
    beforeEach(() => {
      isMobileSpy = jest
        .spyOn(coreUtils.ui, 'isMobile')
        .mockReturnValue(true) as unknown as jest.SpyInstance
    })
    afterEach(() => isMobileSpy.mockRestore())

    it('does not send a watched live trip to the search form', () => {
      // FAILS BEFORE: dispatched SET_MOBILE_SCREEN (SEARCH_FORM) and dropped
      // the rider off the Go Mode screen.
      const types = runFormChanged(
        { activeItinerary: { legs: [] }, isActive: true, ui: {} },
        MobileScreens.GO_MODE
      )
      expect(types).toContain('CLEAR_ACTIVE_SEARCH')
      expect(types).not.toContain('SET_MOBILE_SCREEN')
    })

    it('still shows the form when the rider has stepped out to the planner', () => {
      const types = runFormChanged(
        {
          activeItinerary: { legs: [] },
          isActive: true,
          ui: { backgrounded: true }
        },
        MobileScreens.RESULTS_SUMMARY
      )
      expect(types).toContain('SET_MOBILE_SCREEN')
    })

    it('still shows the form when no trip is running', () => {
      const types = runFormChanged(
        { isActive: false, ui: {} },
        MobileScreens.RESULTS_SUMMARY
      )
      expect(types).toContain('SET_MOBILE_SCREEN')
    })
  })
  /**
   * 45.1. The Search tap on the phone moves a "(Current Location)" origin to
   * the newest fix (syncCurrentLocationOrigin) and THEN plans, so the search
   * is planned for exactly the query formChanged is about to look at. Under
   * the mobile BOTH_LOCATIONS_CHANGED rule a from-only change used to clear
   * that search and send the rider back to the form (27 hits, 09-04 to 10-12).
   */
  describe('formChanged after the Search tap (45.1)', () => {
    const to = { lat: 44.97, lon: -93.26, name: 'Dest' }
    const oldFrom = {
      category: 'CURRENT_LOCATION',
      lat: 44.94258,
      lon: -93.2641,
      name: '(Current Location)'
    }
    const newFrom = { ...oldFrom, lat: 44.9418, lon: -93.26388 }

    const run = (
      oldQuery: any,
      newQuery: any,
      searchQuery: any | null,
      autoPlan: any = {}
    ) => {
      const dispatched: any[] = []
      const getState = () => ({
        otp: {
          activeSearchId: searchQuery ? 'abc' : null,
          config: { autoPlan },
          currentQuery: { departArrive: 'DEPART' },
          goMode: { isActive: false, ui: {} },
          location: { currentPosition: {} },
          searches: searchQuery ? { abc: { query: searchQuery } } : {},
          ui: { mobileScreen: MobileScreens.RESULTS_SUMMARY }
        }
      })
      const dispatch = (action: any): any => {
        if (typeof action === 'function') return action(dispatch, getState)
        dispatched.push(action)
        return action
      }
      formChanged(oldQuery, newQuery)(dispatch, getState)
      return dispatched.map((a) => a.type)
    }

    let isMobileSpy: jest.SpyInstance
    beforeEach(() => {
      isMobileSpy = jest
        .spyOn(coreUtils.ui, 'isMobile')
        .mockReturnValue(true) as unknown as jest.SpyInstance
    })
    afterEach(() => isMobileSpy.mockRestore())

    it('keeps a search planned for the refreshed Current Location origin', () => {
      const types = run(
        { from: oldFrom, to },
        { from: newFrom, to },
        {
          from: newFrom,
          to
        }
      )
      expect(types).not.toContain('CLEAR_ACTIVE_SEARCH')
      expect(types).not.toContain('SET_MOBILE_SCREEN')
    })

    it('still clears when the rider edits the origin to something else', () => {
      const other = { lat: 44.9, lon: -93.2, name: 'Elsewhere' }
      const types = run(
        { from: oldFrom, to },
        { from: other, to },
        {
          from: oldFrom,
          to
        }
      )
      expect(types).toContain('CLEAR_ACTIVE_SEARCH')
      expect(types).toContain('SET_MOBILE_SCREEN')
    })

    it('still clears when no search was planned for the new query', () => {
      const types = run({ from: oldFrom, to }, { from: newFrom, to }, null)
      expect(types).toContain('CLEAR_ACTIVE_SEARCH')
    })

    it('still clears a search planned for a different destination', () => {
      const types = run(
        { from: oldFrom, to },
        { from: newFrom, to },
        {
          from: oldFrom,
          to: { lat: 1, lon: 2 }
        }
      )
      expect(types).toContain('CLEAR_ACTIVE_SEARCH')
    })

    it('still auto-plans a swap (both locations changed) without clearing', () => {
      const types = run(
        { from: oldFrom, to },
        { from: to, to: oldFrom },
        { from: oldFrom, to },
        { mobile: 'BOTH_LOCATIONS_CHANGED' }
      )
      expect(types).not.toContain('CLEAR_ACTIVE_SEARCH')
    })
  })
})
