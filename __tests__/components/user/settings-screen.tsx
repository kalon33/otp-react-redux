import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'

import React from 'react'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { setDefaultTestTime } from '../../test-utils'
import SettingsScreen from '../../../lib/components/user/settings-screen'

/**
 * The settings screen's levers write through `setRoutingPreferences`, which
 * dispatches `setQueryParam` — and `setQueryParam` runs `routingQuery` the
 * moment it is handed a search id. Swap the real one for a plain action so a
 * test can count searches without a server; everything else in actions/api is
 * the real module, because `setUrlSearch` is part of what is under test.
 */
// AppFrame pulls in DesktopNav -> AppMenu, whose constructor calls into the
// debug-log module; under jest that module resolves to a stub without these
// functions, and the mount throws before any of this screen renders. Same stub
// as __tests__/components/go-mode/turn-cue-controls.tsx.
jest.mock('../../../lib/util/debug-log', () => ({
  getBuildInfo: () => 'test',
  getDeviceId: () => null,
  isDebugLogEnabled: () => false,
  logDebugAction: () => undefined,
  setDebugLogEnabled: () => undefined
}))

jest.mock('../../../lib/actions/api', () => {
  const actual = jest.requireActual('../../../lib/actions/api')
  return {
    ...actual,
    __esModule: true,
    routingQuery: (searchId: string) => ({
      payload: { searchId },
      type: 'ROUTING_REQUEST'
    })
  }
})

/** A query with both ends set, so `queryIsValid` is true and a replan can fire. */
const VALID_QUERY = {
  from: { lat: 44.9, lon: -93.26, name: 'Origin' },
  to: { lat: 44.95, lon: -93.29, name: 'Destination' }
}

function renderScreen(routingPreferences = {}) {
  const state: any = getMockInitialState()
  state.router = { location: { pathname: '/settings', search: '' } }
  state.otp.currentQuery = {
    ...state.otp.currentQuery,
    ...VALID_QUERY,
    routingPreferences
  }
  return mockWithProvider(SettingsScreen, {}, state)
}

/** Actions of one type, in dispatch order. */
const ofType = (store: any, type: string) =>
  store.getActions().filter((a: any) => a.type === type)

function drag(wrapper: any, name: string, value: number) {
  wrapper
    .find(`input#id-query-param-${name}`)
    .simulate('change', { target: { value: String(value) } })
}

describe('components > user > settings screen (backlog 9.1)', () => {
  beforeEach(() => {
    setDefaultTestTime()
    window.localStorage.clear()
  })

  it('renders all three routing levers', () => {
    const { wrapper } = renderScreen()
    expect(wrapper.find('input#id-query-param-bikeWillingness')).toHaveLength(1)
    expect(wrapper.find('input#id-query-param-bikeSpeed')).toHaveLength(1)
    expect(wrapper.find('input#id-query-param-walkSpeed')).toHaveLength(1)
  })

  it('buys no search while the rider is dragging, and persists every notch', () => {
    const { store, wrapper } = renderScreen()
    // Five notches of a drag, as the range input delivers them.
    ;[5.25, 5.5, 5.75, 6, 6.25].forEach((v) => drag(wrapper, 'bikeSpeed', v))

    expect(ofType(store, 'ROUTING_REQUEST')).toHaveLength(0)
    const writes = ofType(store, 'SET_QUERY_PARAM')
    expect(writes).toHaveLength(5)
    expect(
      writes.map((a: any) => a.payload.routingPreferences.bikeSpeed)
    ).toEqual([5.25, 5.5, 5.75, 6, 6.25])
    // Persisted immediately, so the setting survives a reload even if the
    // rider never triggers the replan.
    expect(
      JSON.parse(window.localStorage.getItem('otp.routingProfile') as string)
        .routingPreferences.bikeSpeed
    ).toBe(6.25)
  })

  it('replans exactly once, on leaving the screen', () => {
    const { store, wrapper } = renderScreen()
    ;[5.25, 5.5, 5.75].forEach((v) => drag(wrapper, 'bikeSpeed', v))
    expect(ofType(store, 'ROUTING_REQUEST')).toHaveLength(0)

    wrapper.unmount()

    const searches = ofType(store, 'ROUTING_REQUEST')
    expect(searches).toHaveLength(1)
    const last = ofType(store, 'SET_QUERY_PARAM').pop()
    expect(last.payload.routingPreferences.bikeSpeed).toBe(5.75)
  })

  it('replans nothing when the rider only looked', () => {
    const { store, wrapper } = renderScreen()
    wrapper.unmount()
    expect(ofType(store, 'ROUTING_REQUEST')).toHaveLength(0)
    expect(ofType(store, 'SET_QUERY_PARAM')).toHaveLength(0)
  })

  it('replans nothing when a drag ends where it started', () => {
    const { store, wrapper } = renderScreen({ bikeSpeed: 5.5 })
    drag(wrapper, 'bikeSpeed', 6)
    drag(wrapper, 'bikeSpeed', 5.5)
    wrapper.unmount()
    expect(ofType(store, 'ROUTING_REQUEST')).toHaveLength(0)
  })

  it('defers the walking-speed lever the same way', () => {
    const { store, wrapper } = renderScreen()
    ;[1.4, 1.5, 1.6].forEach((v) => drag(wrapper, 'walkSpeed', v))
    expect(ofType(store, 'ROUTING_REQUEST')).toHaveLength(0)
    wrapper.unmount()
    expect(ofType(store, 'ROUTING_REQUEST')).toHaveLength(1)
    expect(
      ofType(store, 'SET_QUERY_PARAM').pop().payload.routingPreferences
        .walkSpeed
    ).toBe(1.6)
  })

  it('defers the bike-willingness lever the same way', () => {
    const { store, wrapper } = renderScreen()
    ;[6, 5, 4].forEach((v) => drag(wrapper, 'bikeWillingness', v))
    expect(ofType(store, 'ROUTING_REQUEST')).toHaveLength(0)
    wrapper.unmount()
    expect(ofType(store, 'ROUTING_REQUEST')).toHaveLength(1)
    expect(
      ofType(store, 'SET_QUERY_PARAM').pop().payload.routingPreferences
        .bikeReluctance
    ).toBeGreaterThan(0.5)
  })

  it('stores the lever but buys no search when the query is not plannable', () => {
    const state: any = getMockInitialState()
    state.router = { location: { pathname: '/settings', search: '' } }
    state.otp.currentQuery = {
      ...state.otp.currentQuery,
      routingPreferences: {}
    }
    const { store, wrapper } = mockWithProvider(SettingsScreen, {}, state)
    drag(wrapper, 'bikeSpeed', 6)
    wrapper.unmount()
    expect(ofType(store, 'ROUTING_REQUEST')).toHaveLength(0)
    expect(ofType(store, 'SET_QUERY_PARAM')).toHaveLength(2)
  })

  it('the turn-by-turn checkbox is untouched by the deferral', () => {
    const { store, wrapper } = renderScreen()
    wrapper
      .find('input#id-query-param-turnByTurn')
      .simulate('change', { target: { checked: true } })
    expect(ofType(store, 'SET_TURN_CUE_DEFAULT')).toHaveLength(1)
    wrapper.unmount()
    expect(ofType(store, 'ROUTING_REQUEST')).toHaveLength(0)
  })
})
