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
import { setDefaultTestTime } from '../../test-utils'
import AdvancedSettingsPanel from '../../../lib/components/form/advanced-settings-panel'

/**
 * Jest maps i18n/*.yml to an empty object, so an import would give us nothing.
 * Read and flatten the shipped English file instead — that way the copy the
 * assertions below check is literally the copy that goes to the phone.
 */
function flatten(node: any, prefix = '', out: Record<string, string> = {}) {
  Object.entries(node || {}).forEach(([key, value]) => {
    const id = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[id] = value
    else flatten(value, id, out)
  })
  return out
}
const messages = flatten(
  yaml.safeLoad(
    readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
  )
)

/**
 * The three rider-facing controls this panel gained (backlog 5.3, rider asks
 * #47 and #48) can't be checked on the dev server — :9967 serves the shared
 * checkout, not this worktree — so they are verified by mounting the real
 * connected component and reading what a rider would see.
 */
function renderPanel(currentQueryOverrides = {}, configOverrides = {}) {
  const state = getMockInitialState()
  // getMockInitialState leaves `router` as the connected-react-router reducer;
  // this panel's mapStateToProps reads location.search off it.
  state.router = { location: { search: '' } }
  state.otp.config = {
    ...state.otp.config,
    ...configOverrides,
    modes: {
      ...(state.otp.config.modes || {}),
      modeButtons: [],
      numItineraries: 40,
      ...((configOverrides as any).modes || {})
    }
  }
  state.otp.currentQuery = {
    ...state.otp.currentQuery,
    // getDefaultQuery seeds this from config in the real app; the shared mock
    // config has no modes block, so mirror what the deployment ships.
    numItineraries: 40,
    ...currentQueryOverrides
  }
  const { wrapper } = mockWithProvider(
    AdvancedSettingsPanel,
    { innerRef: React.createRef() },
    state,
    messages
  )
  return wrapper
}

describe('components > form > advanced settings panel', () => {
  beforeEach(setDefaultTestTime)

  describe('bike willingness slider (backlog 5.3)', () => {
    it('renders a slider that starts where the server already is', () => {
      const wrapper = renderPanel()
      const slider = wrapper.find('input#id-query-param-bikeWillingness')
      expect(slider).toHaveLength(1)
      // Right-hand end = bikeReluctance 0.5 = today's routing untouched.
      expect(slider.prop('value')).toBe(8)
      expect(slider.prop('min')).toBe(0.5)
      expect(slider.prop('max')).toBe(8)
    })

    it('shows the ceiling in miles for the default bike speed', () => {
      const text = renderPanel().text()
      expect(text).toContain('How far you')
      // 120 min at the server's 5 m/s.
      expect(text).toContain('120 minutes of biking')
      expect(text).toContain('about 22 mi')
      expect(text).toContain('11.2 mph')
    })

    it('recomputes the mileage from the rider’s own bikeSpeed lever', () => {
      // The ceiling is a duration, so the mile figure must move with the
      // speed lever rather than being printed as a constant.
      const text = renderPanel({
        routingPreferences: { bikeSpeed: 8 }
      }).text()
      expect(text).toContain('about 36 mi')
      expect(text).toContain('17.9 mph')
      expect(text).not.toContain('about 22 mi')
    })

    it('puts the slider where an applied reluctance lever says', () => {
      const wrapper = renderPanel({
        routingPreferences: { bikeReluctance: 6.5 }
      })
      expect(
        wrapper.find('input#id-query-param-bikeWillingness').prop('value')
      ).toBe(2)
    })
  })

  describe('itinerary count control (rider ask #47)', () => {
    it('offers the count steps and shows the one in effect', () => {
      const wrapper = renderPanel()
      const select = wrapper.find('select#id-query-param-numItineraries')
      expect(select).toHaveLength(1)
      expect(select.prop('value')).toBe('40')
      expect(select.find('option').map((o) => o.prop('value'))).toEqual([
        '10',
        '20',
        '40'
      ])
    })

    it('adds the value in effect when it is not one of the steps', () => {
      const wrapper = renderPanel({ numItineraries: 25 })
      const select = wrapper.find('select#id-query-param-numItineraries')
      expect(select.prop('value')).toBe('25')
      expect(select.find('option').map((o) => o.prop('value'))).toEqual([
        '10',
        '20',
        '25',
        '40'
      ])
    })
  })

  describe('walk + transit toggle (rider ask #48)', () => {
    it('renders unchecked by default', () => {
      const box = renderPanel().find(
        'input#id-query-param-hideWalkTransitOptions'
      )
      expect(box).toHaveLength(1)
      expect(box.prop('checked')).toBe(false)
      expect(renderPanel().text()).toContain('Hide walk + transit options')
    })

    it('reflects the toggle already being on', () => {
      const box = renderPanel({ hideWalkTransitOptions: true }).find(
        'input#id-query-param-hideWalkTransitOptions'
      )
      expect(box.prop('checked')).toBe(true)
    })
  })
})
