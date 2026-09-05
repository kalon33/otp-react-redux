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
import RoundTripSettings from '../../../lib/components/form/round-trip-settings'

/**
 * Jest maps i18n/*.yml to an empty object, so an import would give us nothing.
 * Read and flatten the shipped English file instead — the copy asserted below
 * is then literally the copy that goes to the phone.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

function render(roundTrip: boolean, stayMinutes = 60) {
  const state = getMockInitialState()
  state.otp.currentQuery = {
    ...state.otp.currentQuery,
    roundTrip,
    stayMinutes
  }
  return mockWithProvider(RoundTripSettings, {}, state, messages)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buttons = (wrapper: any) =>
  wrapper.findWhere((n: any) => n.type() === 'button')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toggle = (wrapper: any) =>
  buttons(wrapper).findWhere((n: any) => n.text() === 'Round trip')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chips = (wrapper: any) =>
  buttons(wrapper).filterWhere((n: any) => n.text() !== 'Round trip')

describe('components > form > round-trip settings', () => {
  it('is one quiet line when off — the stay row is collapsed', () => {
    const { wrapper } = render(false)
    expect(toggle(wrapper).at(0).prop('aria-pressed')).toBe(false)
    expect(wrapper.find('AnimateHeight').prop('height')).toBe(0)
    expect(wrapper.text()).not.toContain('staying')
  })

  it('opens the stay chips when on, marking the chosen one', () => {
    const { wrapper } = render(true, 90)
    expect(toggle(wrapper).at(0).prop('aria-pressed')).toBe(true)
    expect(wrapper.find('AnimateHeight').prop('height')).toBe('auto')
    // The six offered stays, formatted through react-intl.
    expect(chips(wrapper).map((n: any) => n.text())).toEqual([
      '30 min',
      '1 h',
      '1 h 30 min',
      '2 h',
      '3 h',
      '4 h'
    ])
    const pressed = chips(wrapper).filterWhere(
      (n: any) => n.prop('aria-pressed') === true
    )
    expect(pressed).toHaveLength(1)
    expect(pressed.at(0).text()).toBe('1 h 30 min')
    expect(wrapper.text()).toContain('staying 1 h 30 min')
  })

  it('the toggle sets currentQuery.roundTrip without starting a search', () => {
    const { store, wrapper } = render(false)
    toggle(wrapper).at(0).simulate('click')
    const setQueryParam = store
      .getActions()
      .find((a: any) => a.type === 'SET_QUERY_PARAM')
    expect(setQueryParam.payload).toEqual({ roundTrip: true, stayMinutes: 60 })
    expect(store.getActions().map((a: any) => a.type)).not.toContain(
      'ROUTING_REQUEST'
    )
  })

  it('a chip sets the stay', () => {
    const { store, wrapper } = render(true, 60)
    // "3 h" — the fifth chip.
    chips(wrapper).at(4).simulate('click')
    const setQueryParam = store
      .getActions()
      .find((a: any) => a.type === 'SET_QUERY_PARAM')
    expect(setQueryParam.payload.stayMinutes).toBe(180)
  })

  it('the custom box takes any usable number of minutes', () => {
    const { store, wrapper } = render(true, 60)
    const input = wrapper.find('input[type="number"]')
    input.simulate('change', { target: { value: '45' } })
    expect(
      store.getActions().find((a: any) => a.type === 'SET_QUERY_PARAM').payload
        .stayMinutes
    ).toBe(45)
  })

  it('ignores a half-typed custom value rather than planning for it', () => {
    const { store, wrapper } = render(true, 60)
    // "1" on the way to "120": below the 5-minute floor, so nothing is set.
    wrapper
      .find('input[type="number"]')
      .simulate('change', { target: { value: '1' } })
    expect(
      store.getActions().filter((a: any) => a.type === 'SET_QUERY_PARAM')
    ).toHaveLength(0)
  })
})
