/* eslint-disable @typescript-eslint/no-explicit-any */
import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import { createStore } from 'redux'
import { mount } from 'enzyme'
import { Provider } from 'react-redux'
import React from 'react'
import yaml from 'js-yaml'

import { ComponentContext } from '../../../lib/util/contexts'
import { formQueryMatchesSearch } from '../../../lib/util/search-query-match'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { MobileScreens } from '../../../lib/actions/ui-constants'
import BatchSearchScreen from '../../../lib/components/mobile/batch-search-screen'
import MobileMain from '../../../lib/components/mobile/main'

// The map is not what this is about, and maplibre does not run in jsdom.
jest.mock('../../../lib/components/map/default-map', () => () => null)
// The header's app menu reads the debug-log switch, which jest maps away.
jest.mock('../../../lib/components/mobile/navigation-bar', () => () => null)
jest.mock('../../../lib/components/go-mode/GoModeScreen', () => () => null)

function flatten(node: any, prefix = '', out: Record<string, string> = {}) {
  Object.entries(node || {}).forEach(([key, value]) => {
    const id = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[id] = value
    else flatten(value, id, out)
  })
  return out
}
const messages = flatten(
  yaml.load(
    readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
  )
)

/**
 * Backlog 70.1 — Edit keeps the search, and the form offers the way back to
 * its results while the form still asks for it (rider 2026-10-20 16:04:18:
 * "make a way back unless the user confirms an alternative operation").
 */
const SEARCH_ID = 'lj157viok'
function plannedQuery(): any {
  return {
    date: '2026-10-20',
    departArrive: 'NOW',
    from: {
      category: 'CURRENT_LOCATION',
      lat: 44.95316,
      lon: -92.957,
      name: '(Current Location)'
    },
    intermediatePlaces: [],
    mode: 'WALK,TRANSIT,BICYCLE',
    routingPreferences: { bicycle: { reluctance: 0.5 } },
    time: '16:02',
    to: { lat: 44.9358, lon: -93.2259, name: '3322 Columbus' }
  }
}

function renderForm(formOverrides: any = {}, withSearch = true) {
  const state: any = getMockInitialState()
  state.otp.config = {
    ...state.otp.config,
    modes: { modeButtons: [], numItineraries: 40 }
  }
  state.otp.currentQuery = {
    ...state.otp.currentQuery,
    ...plannedQuery(),
    ...formOverrides
  }
  if (withSearch) {
    state.otp.activeSearchId = SEARCH_ID
    state.otp.searches = {
      [SEARCH_ID]: { pending: 1, query: plannedQuery(), response: [] }
    }
  }
  state.otp.ui.mobileScreen = MobileScreens.SEARCH_FORM
  state.router = { location: { pathname: '/', search: '' } }
  const { store, wrapper } = mockWithProvider(
    BatchSearchScreen,
    {},
    state,
    messages
  )
  return { store, wrapper }
}

const button = (wrapper: any) => wrapper.find('button.back-to-results')

describe('components > mobile > Back to results (70.1)', () => {
  it('shows "Back to results" while the form is unchanged', () => {
    const { wrapper } = renderForm()
    expect(button(wrapper)).toHaveLength(1)
    expect(button(wrapper).text()).toBe('Back to results')
  })

  it('takes the rider back to the results screen', () => {
    const { store, wrapper } = renderForm()
    button(wrapper).simulate('click')
    expect(store.getActions()).toContainEqual({
      payload: MobileScreens.RESULTS_SUMMARY,
      type: 'SET_MOBILE_SCREEN'
    })
  })

  it('hides it once the mode changes', () => {
    expect(button(renderForm({ mode: 'WALK,TRANSIT' }).wrapper)).toHaveLength(0)
  })

  it('hides it once a routing preference changes', () => {
    const { wrapper } = renderForm({
      routingPreferences: { bicycle: { reluctance: 0.9 } }
    })
    expect(button(wrapper)).toHaveLength(0)
  })

  it('still shows it when a leave-now clock has moved on', () => {
    // updateQueryTimeIfLeavingNow moves the form's time every time the form
    // changes; the rider asked for nothing new.
    expect(button(renderForm({ time: '16:09' }).wrapper)).toHaveLength(1)
  })

  it('hides it with no search to go back to', () => {
    expect(button(renderForm({}, false).wrapper)).toHaveLength(0)
  })
})

describe('util > formQueryMatchesSearch', () => {
  it('treats leave-now and depart-at as the same request, not arrive-by', () => {
    const stored = { ...plannedQuery(), departArrive: 'DEPART' }
    // Leave now at the stored search's own minute is that search...
    expect(formQueryMatchesSearch(plannedQuery(), stored)).toBe(true)
    // ...a leave-now form whose clock moved on is not a fixed 16:02 search.
    expect(
      formQueryMatchesSearch({ ...plannedQuery(), time: '16:09' }, stored)
    ).toBe(false)
    expect(formQueryMatchesSearch(stored, stored)).toBe(true)
    expect(
      formQueryMatchesSearch({ ...stored, departArrive: 'ARRIVE' }, stored)
    ).toBe(false)
  })

  it('a set time must match exactly', () => {
    const stored = { ...plannedQuery(), departArrive: 'DEPART' }
    expect(formQueryMatchesSearch({ ...stored, time: '16:03' }, stored)).toBe(
      false
    )
  })

  it('places compare by point and label, not extra fields', () => {
    const stored = plannedQuery()
    const form = { ...plannedQuery(), to: { ...stored.to, id: 'recent-1' } }
    expect(formQueryMatchesSearch(form, stored)).toBe(true)
    const moved = { ...form, to: { ...stored.to, lat: stored.to.lat + 0.001 } }
    expect(formQueryMatchesSearch(moved, stored)).toBe(false)
  })

  it('a stop added on the form is a different search', () => {
    const form = {
      ...plannedQuery(),
      intermediatePlaces: [{ lat: 44.95, lon: -93.1, name: 'Stop' }]
    }
    expect(formQueryMatchesSearch(form, plannedQuery())).toBe(false)
  })
})

/**
 * The screen switch (components/mobile/main.js). It opened the results only
 * on a null -> set change of the active search, which Edit's clear used to
 * guarantee; with the search kept, a search planned from the form replaces
 * one, and must still open its results.
 */
describe('components > mobile > main: which screen a new search opens', () => {
  const MobileResultsScreen = function MobileResultsScreen() {
    return <div className="results" />
  }
  const MobileSearchScreen = function MobileSearchScreen() {
    return <div className="form" />
  }

  function mountMain(otp: any) {
    const state: any = {
      otp,
      router: { location: { pathname: '/', search: '' } },
      user: {}
    }
    const store = createStore((s: any = state, action: any) => {
      if (action.type === 'SET_MOBILE_SCREEN') {
        return {
          ...s,
          otp: { ...s.otp, ui: { ...s.otp.ui, mobileScreen: action.payload } }
        }
      }
      if (action.type === 'TEST_SET')
        return { ...s, otp: { ...s.otp, ...action.otp } }
      return s
    })
    const context = { MobileResultsScreen, MobileSearchScreen }
    mount(
      <Provider store={store}>
        <ComponentContext.Provider value={context}>
          <MobileMain />
        </ComponentContext.Provider>
      </Provider>
    )
    return store
  }

  const base = (screen: number): any => {
    const otp: any = getMockInitialState().otp
    otp.activeSearchId = 'old'
    otp.searches = { old: { pending: 0, query: plannedQuery(), response: [] } }
    otp.ui.mobileScreen = screen
    otp.location = { currentPosition: {} }
    return otp
  }
  const replaceSearch = {
    otp: {
      activeSearchId: 'new',
      searches: {
        new: { pending: 3, query: plannedQuery(), response: [] },
        old: { pending: 0, query: plannedQuery(), response: [] }
      }
    },
    type: 'TEST_SET'
  }

  it('a search that replaces the kept one opens its results from the form', () => {
    const store = mountMain(base(MobileScreens.SEARCH_FORM))
    store.dispatch(replaceSearch)
    expect(store.getState().otp.ui.mobileScreen).toBe(
      MobileScreens.RESULTS_SUMMARY
    )
  })

  it('stays on the form while the kept search only finishes loading', () => {
    const store = mountMain(base(MobileScreens.SEARCH_FORM))
    store.dispatch({
      otp: {
        searches: { old: { pending: 0, query: plannedQuery(), response: [{}] } }
      },
      type: 'TEST_SET'
    })
    expect(store.getState().otp.ui.mobileScreen).toBe(MobileScreens.SEARCH_FORM)
  })

  it('does not pull the rider off another screen (Go Mode) when the id changes', () => {
    const store = mountMain(base(MobileScreens.GO_MODE))
    store.dispatch(replaceSearch)
    expect(store.getState().otp.ui.mobileScreen).toBe(MobileScreens.GO_MODE)
  })
})
