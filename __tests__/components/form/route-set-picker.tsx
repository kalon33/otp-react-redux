import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import { act } from 'react-dom/test-utils'
import { IntlProvider } from 'react-intl'
import { mount } from 'enzyme'
import React from 'react'
import yaml from 'js-yaml'

import { FETCH_STATUS } from '../../../lib/util/constants'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { setDefaultTestTime } from '../../test-utils'
import AdvancedSettingsPanel from '../../../lib/components/form/advanced-settings-panel'
import RouteSetPicker from '../../../lib/components/form/route-set-picker'

// Count searches instead of running them (see __tests__/actions/route-lock).
jest.mock('../../../lib/actions/api', () => ({
  ...jest.requireActual('../../../lib/actions/api'),
  routingQuery: (searchId: string) => ({
    payload: searchId,
    type: 'TEST_ROUTING_QUERY'
  })
}))

/** The shipped English copy, flattened (jest maps the yml to {}). */
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

const ROUTES = {
  '1:18': { longName: null, shortName: '18', sortOrder: 18 },
  '1:21': { longName: null, shortName: '21', sortOrder: 21 },
  '1:5': { longName: null, shortName: '5', sortOrder: 5 },
  '1:904': { longName: 'METRO Orange Line', shortName: null, sortOrder: 4 },
  '1:905': { longName: 'METRO Gold Line', shortName: null, sortOrder: 6 },
  '1:94': { longName: null, shortName: '94', sortOrder: 94 },
  // A vehicle-positions stub, not a route.
  '1:999': { vehicles: [] }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function mountPicker(props: any = {}) {
  const onApply = jest.fn()
  const wrapper = mount(
    <IntlProvider locale="en-US" messages={messages}>
      <RouteSetPicker
        lastResultRouteIds={[]}
        onApply={onApply}
        routes={ROUTES}
        {...props}
      />
    </IntlProvider>
  )
  return { onApply, wrapper }
}

const open = (wrapper: any) => {
  wrapper.find('button.route-set-open').simulate('click')
  return wrapper
}

const rowLabels = (wrapper: any, section: string) =>
  wrapper
    .find(`${section} label.route-set-row`)
    .map((row: any) => row.find('span').first().text())

describe('components > form > route set picker (58.2)', () => {
  beforeEach(setDefaultTestTime)

  it('says how many routes are picked, and opens nothing until tapped', () => {
    const { wrapper } = mountPicker({
      lock: {
        routes: [
          { id: '1:18', label: '18' },
          { id: '1:21', label: '21' }
        ],
        scope: 'only'
      }
    })
    expect(wrapper.find('button.route-set-open').text()).toBe(
      'Choose routes (2 picked)'
    )
    expect(wrapper.find('.route-set-sheet')).toHaveLength(0)
  })

  it('reads a pre-09-02 single-route lock without throwing', () => {
    const { wrapper } = mountPicker({ lock: { id: '1:18', label: '18' } })
    expect(wrapper.find('button.route-set-open').text()).toBe(
      'Choose routes (1 picked)'
    )
    open(wrapper)
    expect(
      wrapper.find('input[type="checkbox"][value="1:18"]').prop('checked')
    ).toBe(true)
  })

  it('lists every real route, in route-viewer order', () => {
    const wrapper = open(mountPicker().wrapper)
    expect(rowLabels(wrapper, '.route-set-all')).toEqual([
      'METRO Orange Line',
      '5',
      'METRO Gold Line',
      '18',
      '21',
      '94'
    ])
    expect(wrapper.find('.route-set-last-results')).toHaveLength(0)
  })

  it('puts the last results on top and leaves them out of the rest (Q1)', () => {
    const wrapper = open(
      mountPicker({ lastResultRouteIds: ['1:904', '1:94', '9:gone'] }).wrapper
    )
    expect(wrapper.find('.route-set-last-results').text()).toContain(
      'In your last results'
    )
    // Best trip's routes first; an id no longer in the index is skipped.
    expect(rowLabels(wrapper, '.route-set-last-results')).toEqual([
      'METRO Orange Line',
      '94'
    ])
    expect(rowLabels(wrapper, '.route-set-all')).toEqual([
      '5',
      'METRO Gold Line',
      '18',
      '21'
    ])
  })

  it('filters both groups as the rider types', () => {
    const wrapper = open(mountPicker({ lastResultRouteIds: ['1:904'] }).wrapper)
    wrapper
      .find('input.route-set-filter')
      .simulate('change', { target: { value: 'gold' } })
    expect(wrapper.find('.route-set-last-results')).toHaveLength(0)
    expect(rowLabels(wrapper, '.route-set-all')).toEqual(['METRO Gold Line'])

    wrapper
      .find('input.route-set-filter')
      .simulate('change', { target: { value: '21' } })
    expect(rowLabels(wrapper, '.route-set-all')).toEqual(['21'])

    wrapper
      .find('input.route-set-filter')
      .simulate('change', { target: { value: 'zzz' } })
    expect(wrapper.text()).toContain('No route matches “zzz”')
  })

  it('keeps ticks while the filter changes, and hands Done the whole set', async () => {
    const { onApply, wrapper } = mountPicker()
    open(wrapper)
    wrapper
      .find('input[type="checkbox"][value="1:18"]')
      .simulate('change', { target: { checked: true } })
    wrapper
      .find('input.route-set-filter')
      .simulate('change', { target: { value: 'orange' } })
    wrapper
      .find('input[type="checkbox"][value="1:904"]')
      .simulate('change', { target: { checked: true } })
    wrapper
      .find('input.route-set-filter')
      .simulate('change', { target: { value: '' } })
    expect(wrapper.find('p.route-set-count').text()).toBe('2 picked')
    expect(onApply).not.toHaveBeenCalled()

    await act(async () => {
      wrapper.find('button.route-set-done').simulate('click')
      await flush()
    })
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith(['1:18', '1:904'], 'only', 'sheet')
  })

  it('closes on × without applying anything', () => {
    const { onApply, wrapper } = mountPicker()
    open(wrapper)
    wrapper
      .find('input[type="checkbox"][value="1:18"]')
      .simulate('change', { target: { checked: true } })
    wrapper
      .find('.route-set-sheet button[aria-label]')
      .first()
      .simulate('click')
    expect(wrapper.find('.route-set-sheet')).toHaveLength(0)
    expect(onApply).not.toHaveBeenCalled()
  })

  it('hands Done the scope picked in the sheet', async () => {
    const { onApply, wrapper } = mountPicker()
    open(wrapper)
    wrapper
      .find('input[type="checkbox"][value="1:21"]')
      .simulate('change', { target: { checked: true } })
    wrapper
      .find('select#id-query-param-routeSetScope')
      .simulate('change', { target: { value: 'starting' } })
    await act(async () => {
      wrapper.find('button.route-set-done').simulate('click')
      await flush()
    })
    expect(onApply).toHaveBeenCalledWith(['1:21'], 'starting', 'sheet')
  })
})

describe('the sheet inside Settings: three ticks + Done = ONE search (Q2)', () => {
  beforeEach(setDefaultTestTime)

  it('dispatches nothing on a tick, then writes the set once and searches once', async () => {
    const state = getMockInitialState()
    state.router = { location: { search: '' } }
    state.otp.config = {
      ...state.otp.config,
      modes: { ...(state.otp.config.modes || {}), modeButtons: [] }
    }
    state.otp.currentQuery = {
      ...state.otp.currentQuery,
      from: { lat: 44.8168, lon: -93.3102, name: 'Home' },
      numItineraries: 40,
      to: { lat: 45.0, lon: -92.9489, name: 'Oakdale' }
    }
    state.otp.transitIndex = {
      ...(state.otp.transitIndex || {}),
      routes: ROUTES,
      routesFetchStatus: FETCH_STATUS.FETCHED
    }
    const handlePlanTrip = jest.fn()
    const closeAdvancedSettings = jest.fn()
    const { store, wrapper } = mockWithProvider(
      AdvancedSettingsPanel,
      { closeAdvancedSettings, handlePlanTrip, innerRef: React.createRef() },
      state,
      messages
    )
    const writes = () =>
      store
        .getActions()
        .filter((a: any) => a.type === 'SET_QUERY_PARAM' && a.payload.routeLock)
    const searches = () =>
      store.getActions().filter((a: any) => a.type === 'TEST_ROUTING_QUERY')

    wrapper.find('button.route-set-open').simulate('click')
    ;['1:18', '1:904', '1:94'].forEach((id) =>
      wrapper
        .find(`input[type="checkbox"][value="${id}"]`)
        .simulate('change', { target: { checked: true } })
    )
    expect(writes()).toHaveLength(0)
    expect(searches()).toHaveLength(0)
    expect(handlePlanTrip).not.toHaveBeenCalled()

    await act(async () => {
      wrapper.find('button.route-set-done').simulate('click')
      await flush()
    })
    expect(writes()).toHaveLength(1)
    expect(writes()[0].payload.routeLock.routes.map((r: any) => r.id)).toEqual([
      '1:18',
      '1:904',
      '1:94'
    ])
    // The write itself searched nothing; closing Settings ran the one search.
    expect(searches()).toHaveLength(0)
    expect(handlePlanTrip).toHaveBeenCalledTimes(1)
    expect(closeAdvancedSettings).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Saved sets (58.2, cycle 27 Q3 = B)
// ---------------------------------------------------------------------------

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
const OLD = {
  id: 'set-old',
  name: 'Old run',
  routes: [
    { id: '1:5', label: '5' },
    { id: '1:99', label: '99' }
  ],
  savedAt: 1,
  scope: 'starting'
}

describe('the sheet: saved-set chips and "Save this set…"', () => {
  beforeEach(setDefaultTestTime)

  it('shows no saved row or save button until there is something to show', () => {
    const wrapper = open(mountPicker({ onSaveSet: jest.fn() }).wrapper)
    expect(wrapper.find('.route-set-saved')).toHaveLength(0)
    expect(wrapper.find('button.route-set-save-open')).toHaveLength(0)
  })

  it('one tap on a saved chip hands Done its routes and scope, source saved', async () => {
    const { onApply, wrapper } = mountPicker({ savedSets: [COMMUTE, OLD] })
    open(wrapper)
    const chips = wrapper.find('button.route-set-saved-chip')
    expect(chips.map((c: any) => c.text())).toEqual([
      'Commute · 3',
      'Old run · 2'
    ])
    // The 99 is not in the graph any more: named back, left out.
    expect(wrapper.find('.route-set-missing').hostNodes().text()).toBe(
      'Route 99 in Old run isn’t running'
    )
    await act(async () => {
      chips.at(1).simulate('click')
      await flush()
    })
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith(['1:5'], 'starting', 'saved')
  })

  it('a set none of whose routes runs cannot be tapped', () => {
    const gone = { ...OLD, routes: [{ id: '1:99', label: '99' }] }
    const wrapper = open(mountPicker({ savedSets: [gone] }).wrapper)
    expect(wrapper.find('button.route-set-saved-chip').prop('disabled')).toBe(
      true
    )
    expect(wrapper.find('.route-set-missing').hostNodes().text()).toBe(
      'None of the routes in Old run is running.'
    )
  })

  it('saves the ticked set under a name, and asks before replacing one', () => {
    const onSaveSet = jest
      .fn()
      .mockReturnValueOnce({ error: 'exists', existing: COMMUTE, ok: false })
      .mockReturnValueOnce({
        ok: true,
        replaced: true,
        set: COMMUTE,
        sets: [COMMUTE]
      })
    const { onApply, wrapper } = mountPicker({ onSaveSet })
    open(wrapper)
    ;['1:18', '1:21'].forEach((id) =>
      wrapper
        .find(`input[type="checkbox"][value="${id}"]`)
        .simulate('change', { target: { checked: true } })
    )
    wrapper.find('button.route-set-save-open').simulate('click')
    expect(wrapper.find('button.route-set-save').prop('disabled')).toBe(true)
    wrapper
      .find('input.route-set-name')
      .simulate('change', { target: { value: 'commute' } })
    wrapper.find('form.route-set-save-form').simulate('submit')
    expect(onSaveSet).toHaveBeenLastCalledWith(
      'commute',
      ['1:18', '1:21'],
      'only',
      false
    )
    expect(wrapper.find('.route-set-replace').hostNodes().text()).toContain(
      'Replace Commute?'
    )
    wrapper.find('button.route-set-replace-yes').simulate('click')
    expect(onSaveSet).toHaveBeenLastCalledWith(
      'commute',
      ['1:18', '1:21'],
      'only',
      true
    )
    expect(wrapper.find('.route-set-save-note').hostNodes().text()).toBe(
      'Saved as Commute.'
    )
    // Saving is not choosing: nothing was applied and the sheet stays open.
    expect(onApply).not.toHaveBeenCalled()
    expect(wrapper.find('.route-set-sheet').hostNodes()).toHaveLength(1)
  })

  it('says so when 20 sets are already saved', () => {
    const onSaveSet = jest.fn(() => ({ error: 'full', ok: false }))
    const { wrapper } = mountPicker({ onSaveSet })
    open(wrapper)
    wrapper
      .find('input[type="checkbox"][value="1:18"]')
      .simulate('change', { target: { checked: true } })
    wrapper.find('button.route-set-save-open').simulate('click')
    wrapper
      .find('input.route-set-name')
      .simulate('change', { target: { value: 'One more' } })
    wrapper.find('form.route-set-save-form').simulate('submit')
    expect(wrapper.text()).toContain(
      'You have 20 saved sets — delete one in Settings first.'
    )
  })
})

function panelState(routeSets: any[], currentQuery: any = {}) {
  const state = getMockInitialState()
  state.router = { location: { search: '' } }
  state.otp.config = {
    ...state.otp.config,
    modes: { ...(state.otp.config.modes || {}), modeButtons: [] }
  }
  state.otp.currentQuery = {
    ...state.otp.currentQuery,
    from: { lat: 44.8168, lon: -93.3102, name: 'Home' },
    numItineraries: 40,
    to: { lat: 45.0, lon: -92.9489, name: 'Oakdale' },
    ...currentQuery
  }
  state.otp.transitIndex = {
    ...(state.otp.transitIndex || {}),
    routes: ROUTES,
    routesFetchStatus: FETCH_STATUS.FETCHED
  }
  state.user.localUser.routeSets = routeSets
  return state
}

function mountPanel(routeSets: any[], currentQuery?: any) {
  const handlePlanTrip = jest.fn()
  const closeAdvancedSettings = jest.fn()
  const { store, wrapper } = mockWithProvider(
    AdvancedSettingsPanel,
    { closeAdvancedSettings, handlePlanTrip, innerRef: React.createRef() },
    panelState(routeSets, currentQuery),
    messages
  )
  const writes = () =>
    store
      .getActions()
      .filter(
        (a: any) => a.type === 'SET_QUERY_PARAM' && 'routeLock' in a.payload
      )
  const searches = () =>
    store.getActions().filter((a: any) => a.type === 'TEST_ROUTING_QUERY')
  const of = (type: string) =>
    store.getActions().filter((a: any) => a.type === type)
  return {
    closeAdvancedSettings,
    handlePlanTrip,
    of,
    searches,
    store,
    wrapper,
    writes
  }
}

describe('saved sets inside Settings', () => {
  beforeEach(setDefaultTestTime)

  it('a saved chip in the sheet = one write, Settings closes, ONE search', async () => {
    const { closeAdvancedSettings, handlePlanTrip, searches, wrapper, writes } =
      mountPanel([COMMUTE])
    wrapper.find('button.route-set-open').simulate('click')
    await act(async () => {
      wrapper.find('button.route-set-saved-chip').simulate('click')
      await flush()
    })
    expect(writes()).toHaveLength(1)
    expect(writes()[0].payload.routeLock.routes.map((r: any) => r.id)).toEqual([
      '1:18',
      '1:21',
      '1:904'
    ])
    expect(searches()).toHaveLength(0)
    expect(handlePlanTrip).toHaveBeenCalledTimes(1)
    expect(closeAdvancedSettings).toHaveBeenCalledTimes(1)
  })

  it('lists each set with its routes; Use writes without a search, closing Settings runs it', async () => {
    const { handlePlanTrip, searches, wrapper, writes } = mountPanel([
      COMMUTE,
      OLD
    ])
    const items = wrapper.find('li.route-set-item')
    expect(items).toHaveLength(2)
    expect(items.at(0).find('.route-set-item-name').hostNodes().text()).toBe(
      'Commute'
    )
    expect(items.at(0).find('.route-set-item-routes').hostNodes().text()).toBe(
      '18, 21, Orange'
    )
    expect(items.at(1).find('.route-set-missing').hostNodes().text()).toBe(
      'Route 99 in Old run isn’t running'
    )
    await act(async () => {
      items.at(0).find('button.route-set-use').simulate('click')
      await flush()
    })
    expect(writes()).toHaveLength(1)
    expect(searches()).toHaveLength(0)
    expect(handlePlanTrip).not.toHaveBeenCalled()

    wrapper.find('button#close-advanced-settings-button').simulate('click')
    expect(handlePlanTrip).toHaveBeenCalledTimes(1)
    expect(searches()).toHaveLength(0)
  })

  it('marks the set in use when the lock is that set (any order)', () => {
    const { wrapper } = mountPanel([COMMUTE], {
      routeLock: {
        routes: [
          { id: '1:904', label: 'METRO Orange Line' },
          { id: '1:21', label: '21' },
          { id: '1:18', label: '18' }
        ],
        scope: 'only'
      }
    })
    const use = wrapper.find('button.route-set-use')
    expect(use.text()).toBe('In use')
    expect(use.prop('disabled')).toBe(true)
  })

  it('renames inline', () => {
    const { of, wrapper } = mountPanel([COMMUTE])
    wrapper.find('button.route-set-rename').simulate('click')
    wrapper
      .find('input.route-set-rename-input')
      .simulate('change', { target: { value: 'Work run' } })
    wrapper.find('li.route-set-item form').simulate('submit')
    expect(of('RENAME_ROUTE_SET')).toHaveLength(1)
    expect(of('RENAME_ROUTE_SET')[0].payload).toMatchObject({
      id: 'set-commute',
      name: 'Work run'
    })
  })

  it('deletes only on the second tap', () => {
    const { of, wrapper } = mountPanel([COMMUTE])
    wrapper.find('button.route-set-delete').simulate('click')
    expect(of('DELETE_ROUTE_SET')).toHaveLength(0)
    expect(wrapper.find('button.route-set-delete').text()).toBe(
      'Tap again to delete'
    )
    wrapper.find('button.route-set-delete').simulate('click')
    expect(of('DELETE_ROUTE_SET')).toEqual([
      { payload: { id: 'set-commute' }, type: 'DELETE_ROUTE_SET' }
    ])
  })
})
