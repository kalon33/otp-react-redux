import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import React from 'react'
import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { MobileScreens } from '../../../lib/actions/ui-constants'
import { setDefaultTestTime } from '../../test-utils'
import LocationField from '../../../lib/components/form/connected-location-field'

/**
 * Jest maps i18n/*.yml to an empty object, so an import would give us nothing.
 * Read and flatten the shipped English file instead — that way the assertions
 * below check the copy that actually goes to the phone.
 */
function flatten(node: any, prefix = '', out: Record<string, string> = {}) {
  Object.entries(node || {}).forEach(([key, value]) => {
    const id = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[id] = value
    else flatten(value, id, out)
  })
  return out
}
const messages = {
  ...flatten(
    yaml.safeLoad(
      readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
    )
  ),
  // The option list's own headings and the "Use current location" label live in
  // the library's message file, which jest maps to an empty object; load it too
  // so the assertions (and the screenshot harness) read real copy.
  ...flatten(
    yaml.safeLoad(
      readFileSync(
        path.join(
          __dirname,
          '../../../node_modules/@opentripplanner/location-field/i18n/en-US.yml'
        ),
        'utf8'
      )
    )
  )
}

/**
 * Rider asks of 2026-09-02 (backlog 3.9 and 3.10). The picker the rider uses is
 * the full-screen mobile one, which renders the option list statically, so
 * these mount it the same way `mobile/location-search` does (`isStatic`) and
 * read the list a rider would see.
 *
 * The state below mirrors the shipped iOS config: `persistence.enabled` (so
 * saved places and recents are offered) and a live GPS fix.
 */
function renderField(
  { locationType = 'to', ...props }: Record<string, any> = {},
  mutateState: (state: any) => void = () => undefined
) {
  const state = getMockInitialState()
  state.otp.config = {
    ...state.otp.config,
    persistence: { enabled: true, strategy: 'localStorage' }
  }
  state.otp.location = {
    ...state.otp.location,
    currentPosition: {
      coords: { latitude: 44.98, longitude: -93.27 },
      error: null,
      fetching: false
    },
    // A non-empty nearby list keeps the field from firing its stopsByRadius
    // query on first keystroke, and gives the ordering assertions a third
    // category to sit behind Current Location.
    nearbyStops: ['1:100'],
    sessionSearches: [
      { lat: 44.95, lon: -93.1, name: 'Recent search one' },
      { lat: 44.96, lon: -93.11, name: 'Recent search two' }
    ]
  }
  state.user = {
    ...state.user,
    localUser: {
      ...state.user.localUser,
      recentPlaces: [],
      savedLocations: [
        {
          icon: 'place',
          lat: 44.9,
          lon: -93.2,
          name: 'Home place',
          type: 'custom'
        }
      ]
    }
  }
  state.otp.transitIndex = {
    ...(state.otp.transitIndex || {}),
    stops: {
      '1:100': {
        code: '17952',
        dist: 120,
        id: '1:100',
        lat: 44.977,
        lon: -93.272,
        name: 'Nicollet Ave & 5th St',
        routes: [{ shortName: '18' }]
      }
    }
  }
  mutateState(state)
  return mockWithProvider(
    LocationField,
    { isStatic: true, locationType, ...props },
    state,
    messages
  )
}

/** The ids of the selectable options, in the order they are rendered. */
function optionIds(wrapper: any): string[] {
  return wrapper
    .find('li[role="option"]')
    .map((li: any) => li.prop('id'))
    .filter(Boolean)
}

describe('components > form > location picker', () => {
  beforeEach(setDefaultTestTime)

  describe('Current Location comes first (backlog 3.10)', () => {
    it('leads the list with Current Location on an empty query', () => {
      const ids = optionIds(renderField().wrapper)
      // Upstream builds the current-location option LAST, after the recents
      // and the saved places; the rider wants it first every time.
      expect(ids[0]).toBe('current-position')
      expect(ids.indexOf('current-position')).toBeLessThan(
        ids.findIndex((id) => id.startsWith('recent-'))
      )
      expect(ids.indexOf('current-position')).toBeLessThan(ids.indexOf('1:100'))
      expect(ids.indexOf('current-position')).toBeLessThan(
        ids.findIndex((id) => id.startsWith('user-saved-'))
      )
    })

    it('keeps the rest of the list in the order the library built it', () => {
      const ids = optionIds(renderField().wrapper)
      const rest = ids.filter(
        (id) => id !== 'current-position' && id !== 'choose-on-map'
      )
      // Recents before saved places, and each group internally in order.
      expect(rest).toEqual([
        '1:100',
        'recent-0',
        'recent-1',
        'user-saved-Home-place'
      ])
    })

    it('still leads with Current Location once the rider has typed', () => {
      const { wrapper } = renderField()
      wrapper
        .find('input[role="combobox"]')
        .simulate('change', { target: { value: 'Nicollet' } })
      wrapper.update()
      expect(optionIds(wrapper)[0]).toBe('current-position')
    })

    it('registers Current Location as the first arrow-key option', () => {
      const { wrapper } = renderField()
      const input = wrapper.find('input[role="combobox"]')
      // The first ArrowDown only opens the menu (the static list is rendered
      // but `menuVisible` starts false); the click does that up front.
      input.simulate('click')
      input.simulate('keyDown', { key: 'ArrowDown' })
      wrapper.update()
      // aria-activedescendant is driven by the same lookup the Enter key uses,
      // so this is the check that display order and keyboard order agree.
      expect(
        wrapper.find('input[role="combobox"]').prop('aria-activedescendant')
      ).toBe('current-position')
    })
  })

  describe('"Choose on map" option (backlog 3.9)', () => {
    it('offers it directly under Current Location, for either end', () => {
      const ends = ['from', 'to']
      ends.forEach((locationType) => {
        const ids = optionIds(renderField({ locationType }).wrapper)
        expect(ids[0]).toBe('current-position')
        expect(ids[1]).toBe('choose-on-map')
      })
    })

    it('labels it in the rider’s own words', () => {
      const { wrapper } = renderField()
      expect(wrapper.find('li#choose-on-map').text()).toContain('Choose on map')
      // ...directly under the current-location row, which reads as it always has.
      expect(wrapper.find('li#current-position').text()).toContain(
        'Use Current Location'
      )
    })

    it('puts the map into pick mode for this field when tapped', () => {
      const { store, wrapper } = renderField({ locationType: 'from' })
      wrapper.find('li#choose-on-map').simulate('click')
      expect(store.getActions()).toContainEqual({
        payload: { locationType: 'from' },
        type: 'SET_MAP_PICK_MODE'
      })
    })

    it('leaves the full-screen mobile picker so the map is visible', () => {
      const { store, wrapper } = renderField(
        { locationType: 'to' },
        (state) => {
          state.otp.ui.mobileScreen = MobileScreens.SET_TO_LOCATION
        }
      )
      wrapper.find('li#choose-on-map').simulate('click')
      expect(store.getActions()).toContainEqual({
        payload: MobileScreens.SEARCH_FORM,
        type: 'SET_MOBILE_SCREEN'
      })
    })

    it('does not change the screen when the field is inline', () => {
      const { store, wrapper } = renderField(
        { locationType: 'to' },
        (state) => {
          state.otp.ui.mobileScreen = MobileScreens.SEARCH_FORM
        }
      )
      wrapper.find('li#choose-on-map').simulate('click')
      expect(
        store.getActions().filter((a: any) => a.type === 'SET_MOBILE_SCREEN')
      ).toHaveLength(0)
    })

    it('does not touch what the field auto-fills', () => {
      const { store, wrapper } = renderField({ locationType: 'from' })
      wrapper.find('li#choose-on-map').simulate('click')
      // Picking the map option must not set a location by itself — that only
      // happens when the rider confirms the point.
      expect(
        store.getActions().filter((a: any) => a.type === 'SET_LOCATION')
      ).toHaveLength(0)
    })
  })
})
