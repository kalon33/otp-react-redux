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
import ActiveRoutingPreferences from '../../../lib/components/form/active-routing-preferences'

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

function renderChips(currentQueryOverrides = {}, routeSets?: any[]) {
  const state: any = getMockInitialState()
  if (routeSets) state.user.localUser.routeSets = routeSets
  state.otp.config = {
    ...state.otp.config,
    modes: { modeButtons: [], numItineraries: 40 }
  }
  state.otp.currentQuery = {
    ...state.otp.currentQuery,
    numItineraries: 40,
    ...currentQueryOverrides
  }
  const { wrapper } = mockWithProvider(
    ActiveRoutingPreferences,
    {},
    state,
    messages
  )
  return wrapper
}

describe('components > form > active routing preferences', () => {
  it('renders nothing when nothing is customized', () => {
    expect(renderChips().find('.active-routing-preferences')).toHaveLength(0)
  })

  it('says nothing about a count the rider never moved', () => {
    // 40 is what the config ships, so it is not a preference.
    expect(renderChips({ numItineraries: 40 }).text()).not.toContain('options')
  })

  it('shows a chip for a count the rider chose', () => {
    expect(renderChips({ numItineraries: 10 }).text()).toContain('10 options')
  })

  it('shows a chip while walk + transit options are hidden', () => {
    expect(renderChips({ hideWalkTransitOptions: true }).text()).toContain(
      'No walk + transit'
    )
  })

  it('shows one chip per named route (rider ask #46)', () => {
    // A single chip reading "Only 18, 21, METRO Orange Line" stops being
    // glanceable at two routes, and this row exists to be glanced at.
    const chips = renderChips({
      routeLock: {
        routes: [
          { id: '1:18', label: '18' },
          { id: '1:904', label: 'METRO Orange Line' }
        ],
        scope: 'only'
      }
    }).find('.active-routing-preferences span')
    const texts = chips.map((c) => c.text())
    expect(texts).toContain('Only 18')
    expect(texts).toContain('Only METRO Orange Line')
  })

  it('renders a lock saved by the previous bundle instead of white-screening', () => {
    // The 09-02 bundle changed RouteLock from `{ id, label }` to
    // `{ routes[], scope }`. `currentQuery` is serialised into the URL hash, and
    // the phone reopens on the URL the OLD bundle left, so the first render
    // after an OTA update is handed the old shape. `routeLock?.routes.map(...)`
    // stops its optional chain at `routeLock` — the old lock threw
    // "undefined is not an object" here, and a throw in this render unmounts
    // the whole app.
    const text = renderChips({
      routeLock: { id: '1:904', label: 'METRO Orange Line' }
    }).text()
    expect(text).toContain('Only METRO Orange Line')
  })

  it('says "start on" rather than "only" for a starting route (#45)', () => {
    const text = renderChips({
      routeLock: {
        routes: [{ id: '1:18', label: '18' }],
        scope: 'starting'
      }
    }).text()
    expect(text).toContain('Start on 18')
    expect(text).not.toContain('Only 18')
  })

  it('shows a chip while transfers are ruled out (4.9)', () => {
    expect(renderChips({ noTransfers: true }).text()).toContain('No transfers')
  })

  it('names the stop the trip must serve (4.9)', () => {
    expect(
      renderChips({
        viaStop: { ids: ['1:56796'], name: 'Lake & Chicago Station' }
      }).text()
    ).toContain('Via Lake & Chicago Station')
  })

  it('still shows the lever chips beside them', () => {
    const text = renderChips({
      hideWalkTransitOptions: true,
      routingPreferences: { bikeReluctance: 6 }
    }).text()
    expect(text).toContain('avoiding biking')
    expect(text).toContain('No walk + transit')
  })

  describe('a lock that is a saved set (58.2)', () => {
    const COMMUTE = {
      id: 'set-commute',
      name: 'Commute',
      routes: [
        { id: '1:18', label: '18' },
        { id: '1:21', label: '21' },
        { id: '1:904', label: 'Orange' }
      ],
      savedAt: 1,
      scope: 'only'
    }
    const lock = (scope: string, ids = ['1:21', '1:18', '1:904']) => ({
      routeLock: {
        routes: ids.map((id) => ({
          id,
          label: { '1:18': '18', '1:21': '21', '1:904': 'Orange' }[id]
        })),
        scope
      }
    })

    it('reads as the set: one chip, "Only: Commute (…)"', () => {
      const wrapper = renderChips(lock('only'), [COMMUTE])
      const chip = wrapper.find('.route-set-saved-summary').hostNodes()
      expect(chip.text()).toBe('Only: Commute (21, 18, Orange)')
      expect(wrapper.text()).not.toContain('Only 18')
    })

    it('"Start on: …" for a starting set', () => {
      const wrapper = renderChips(lock('starting'), [
        { ...COMMUTE, scope: 'starting' }
      ])
      expect(wrapper.find('.route-set-saved-summary').hostNodes().text()).toBe(
        'Start on: Commute (21, 18, Orange)'
      )
    })

    it('a different scope or set of routes keeps the per-route chips', () => {
      expect(
        renderChips(lock('starting'), [COMMUTE]).find(
          '.route-set-saved-summary'
        )
      ).toHaveLength(0)
      const partial = renderChips(lock('only', ['1:18', '1:21']), [COMMUTE])
      expect(partial.find('.route-set-saved-summary')).toHaveLength(0)
      expect(partial.text()).toContain('Only 18')
    })
  })
})
