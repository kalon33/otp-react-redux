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

function renderChips(currentQueryOverrides = {}) {
  const state: any = getMockInitialState()
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

  it('still shows the lever chips beside them', () => {
    const text = renderChips({
      hideWalkTransitOptions: true,
      routingPreferences: { bikeReluctance: 6 }
    }).text()
    expect(text).toContain('avoiding biking')
    expect(text).toContain('No walk + transit')
  })
})
