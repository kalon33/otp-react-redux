import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { act } from 'react-dom/test-utils'
import { Briefcase } from '@styled-icons/fa-solid/Briefcase'
import { Clock } from '@styled-icons/fa-regular/Clock'
import { Home } from '@styled-icons/fa-solid/Home'
import { MapMarker } from '@styled-icons/fa-solid/MapMarker'
import { readFileSync } from 'fs'
import path from 'path'

import { IntlProvider } from 'react-intl'
import { mount } from 'enzyme'
import LocationFieldBase from '@opentripplanner/location-field'
import React from 'react'
import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import LocationField from '../../../lib/components/form/connected-location-field'

/**
 * Backlog 60.2 (cycle 31). Saved places and recent places are stored apart
 * (`otp.home`/`otp.work`/`otp.savedPlaces` vs `otp.recent`) but the search
 * dropdown merged them under one "My Places" header, every row with the same
 * pin. The patched `@opentripplanner/location-field` takes them as two lists
 * and renders "Recent" above "Saved places" (Home, Work, custom), each only
 * when it has entries; recents carry a clock; a "Recently searched" entry that
 * is already a recent is dropped; arrow keys walk the rows in the order shown.
 */

jest.mock('@opentripplanner/geocoder', () => ({
  __esModule: true,
  default: () => ({
    autocomplete: () => new Promise(() => undefined)
  })
}))

/** Same flattening as location-field-timeout.tsx: jest maps i18n/*.yml to {}. */
function flatten(node: any, prefix = '', out: Record<string, string> = {}) {
  Object.entries(node || {}).forEach(([key, value]) => {
    const id = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[id] = value
    else flatten(value, id, out)
  })
  return out
}
function loadYaml(relative: string) {
  return flatten(
    yaml.safeLoad(readFileSync(path.join(__dirname, relative), 'utf8'))
  )
}
const messages = {
  ...loadYaml(
    '../../../node_modules/@opentripplanner/location-field/i18n/en-US.yml'
  ),
  ...loadYaml('../../../i18n/en-US.yml')
}
const frMessages = loadYaml('../../../i18n/fr.yml')

const HOME = {
  address: '123 Home St, Minneapolis, MN',
  icon: 'home',
  lat: 44.9483,
  lon: -93.29,
  name: '123 Home St, Minneapolis, MN',
  type: 'home'
}
const WORK = {
  address: '500 Nicollet Mall, Minneapolis, MN',
  // State holds Work with the 'briefcase' icon (convertToPlace).
  icon: 'briefcase',
  lat: 44.9765,
  lon: -93.2718,
  name: '500 Nicollet Mall, Minneapolis, MN',
  type: 'work'
}
const GYM = {
  address: '456 Barbell Ave, Minneapolis, MN',
  icon: 'map-marker',
  id: 'place-gym',
  lat: 44.977,
  lon: -93.265,
  name: 'Gym',
  type: 'custom'
}
const MOM = {
  address: '789 E Lake St, Minneapolis, MN',
  icon: 'map-marker',
  id: 'place-mom',
  lat: 44.9485,
  lon: -93.257,
  name: "Mom's house",
  type: 'custom'
}
const recent = (n: number, name: string, lat: number, lon: number) => ({
  address: name,
  icon: 'clock-o',
  id: `recent-${n}`,
  lat,
  lon,
  name,
  timestamp: 1760000000000 - n * 3600e3,
  type: 'recent'
})
const RECENTS = [
  recent(1, 'Target Field, Minneapolis, MN', 44.9817, -93.2776),
  recent(2, 'Mall of America, Bloomington, MN', 44.8549, -93.2422),
  recent(3, 'Union Depot, Saint Paul, MN', 44.948, -93.0866)
]
// Searched this session AND already a recent (same spot, label as the
// geocoder gives it) — must not show a second time.
const SEARCHED_TARGET = {
  lat: 44.98171,
  lon: -93.27761,
  main: 'Target Field',
  name: 'Target Field, Minneapolis, MN',
  secondary: 'Minneapolis, MN'
}
// Searched this session but never planned to: not a recent, so it stays.
const SEARCHED_ZOO = {
  lat: 44.9819,
  lon: -93.1527,
  main: 'Como Zoo',
  name: 'Como Zoo, Saint Paul, MN',
  secondary: 'Saint Paul, MN'
}

function renderField({
  recentPlaces = RECENTS,
  savedLocations = [HOME, WORK, GYM, MOM],
  sessionSearches = [SEARCHED_TARGET, SEARCHED_ZOO]
}: {
  recentPlaces?: any[]
  savedLocations?: any[]
  sessionSearches?: any[]
} = {}) {
  const state = getMockInitialState()
  state.otp.config = {
    ...state.otp.config,
    persistence: { enabled: true, strategy: 'localStorage' }
  }
  state.otp.location = {
    ...state.otp.location,
    sessionSearches
  }
  state.user.localUser = {
    ...state.user.localUser,
    recentPlaces,
    savedLocations
  }
  return mockWithProvider(
    LocationField,
    { isStatic: true, locationType: 'to' },
    state,
    messages
  ).wrapper
}

/** Headers and options in document order: 'H:<text>' or the option id. */
function menuOrder(wrapper: any): string[] {
  const root = wrapper.getDOMNode().parentNode as HTMLElement
  const list = root.querySelector('[role="listbox"]') as HTMLElement
  return Array.from(list.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="option"]'))
    .map((el: any) =>
      /^H\d$/.test(el.tagName) ? `H:${el.textContent.trim()}` : el.id
    )
    .filter(Boolean)
}

function arrowDown(wrapper: any) {
  act(() => {
    wrapper
      .find('input[role="combobox"]')
      .simulate('keydown', { key: 'ArrowDown' })
  })
  wrapper.update()
}

function arrowThrough(wrapper: any, n: number): string[] {
  // The first press opens the menu (the library's handleTextInputClick).
  arrowDown(wrapper)
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    arrowDown(wrapper)
    ids.push(
      wrapper
        .find('input[role="combobox"]')
        .getDOMNode()
        .getAttribute('aria-activedescendant')
    )
  }
  return ids
}

function headers(order: string[]) {
  return order.filter((x) => x.startsWith('H:'))
}

describe('components > form > location field saved/recent sections (backlog 60.2)', () => {
  it('has the copy in English and French', () => {
    expect(messages['otpUi.LocationField.savedPlaces']).toBe('Saved places')
    expect(messages['otpUi.LocationField.recentPlaces']).toBe('Recent')
    expect(frMessages['otpUi.LocationField.savedPlaces']).toBe(
      'Lieux enregistrés'
    )
    expect(frMessages['otpUi.LocationField.recentPlaces']).toBe('Récents')
  })

  it('shows "Recent" above "Saved places" (Home, Work, custom), no "My Places"', () => {
    const order = menuOrder(renderField())
    expect(headers(order)).toEqual([
      'H:Recent',
      'H:Saved places',
      'H:Recently Searched'
    ])
    const rec = order.indexOf('H:Recent')
    const saved = order.indexOf('H:Saved places')
    expect(order.slice(rec + 1, saved)).toEqual([
      'user-recent-Target-Field,-Minneapolis,-MN',
      'user-recent-Mall-of-America,-Bloomington,-MN',
      'user-recent-Union-Depot,-Saint-Paul,-MN'
    ])
    expect(order.slice(saved + 1, saved + 5)).toEqual([
      'user-saved-Home-(123-Home-St,-Minneapolis,-MN)',
      'user-saved-Work-(500-Nicollet-Mall,-Minneapolis,-MN)',
      'user-saved-Gym',
      "user-saved-Mom's-house"
    ])
    expect(order).not.toContain('H:My Places')
  })

  it('drops a "Recently searched" entry that is already a recent, keeps the rest', () => {
    const wrapper = renderField()
    // Session rows have no label-based id (the library falls back to the
    // index), so read their text.
    const searched = wrapper
      .find('Option')
      .filterWhere((n: any) => /^recent-\d+$/.test(n.prop('id') || ''))
      .map((n: any) => n.prop('title'))
    expect(searched).toEqual(['Como Zoo'])
    const targetRows = wrapper
      .find('Option')
      .filterWhere((n: any) => /Target Field/.test(n.text()))
    expect(targetRows).toHaveLength(1)
    expect(targetRows.prop('id')).toBe(
      'user-recent-Target-Field,-Minneapolis,-MN'
    )
  })

  it('hides the "Recently Searched" header when every entry is a recent', () => {
    const order = menuOrder(renderField({ sessionSearches: [SEARCHED_TARGET] }))
    expect(headers(order)).toEqual(['H:Recent', 'H:Saved places'])
  })

  it('hides an empty section and its header', () => {
    const noRecents = menuOrder(
      renderField({ recentPlaces: [], sessionSearches: [] })
    )
    expect(headers(noRecents)).toEqual(['H:Saved places'])

    const noSaved = menuOrder(
      renderField({ savedLocations: [], sessionSearches: [] })
    )
    expect(headers(noSaved)).toEqual(['H:Recent'])

    const neither = menuOrder(
      renderField({ recentPlaces: [], savedLocations: [], sessionSearches: [] })
    )
    expect(headers(neither)).toEqual([])
  })

  it('walks the rows with the arrow keys in the order shown', () => {
    const wrapper = renderField()
    const shown = menuOrder(wrapper).filter((x) => !x.startsWith('H:'))
    expect(arrowThrough(wrapper, shown.length)).toEqual(shown)
  })

  it('gives Home a house, Work a briefcase, custom a pin and recents a clock', () => {
    const wrapper = renderField({ sessionSearches: [] })
    const iconIn = (id: string) => {
      const option = wrapper
        .find('Option')
        .filterWhere((n: any) => n.prop('id') === id)
      const types = [Home, Briefcase, MapMarker, Clock]
      return types.find((t) => option.find(t).length > 0)
    }
    expect(iconIn('user-saved-Home-(123-Home-St,-Minneapolis,-MN)')).toBe(Home)
    expect(iconIn('user-saved-Work-(500-Nicollet-Mall,-Minneapolis,-MN)')).toBe(
      Briefcase
    )
    expect(iconIn('user-saved-Gym')).toBe(MapMarker)
    expect(iconIn('user-recent-Target-Field,-Minneapolis,-MN')).toBe(Clock)
  })

  it('keeps the single "My Places" list for callers that pass only the merged prop', () => {
    const wrapper = mount(
      <IntlProvider defaultLocale="en-US" locale="en-US" messages={messages}>
        <LocationFieldBase
          geocoderConfig={{}}
          getCurrentPosition={() => undefined}
          isStatic
          locationType="to"
          onLocationSelected={() => undefined}
          showUserSettings
          userLocationsAndRecentPlaces={[HOME, RECENTS[0]] as any}
        />
      </IntlProvider>
    )
    const order = menuOrder(wrapper)
    expect(headers(order)).toEqual(['H:My Places'])
    expect(order.filter((x) => x.startsWith('user-saved-'))).toHaveLength(2)
  })
})
