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
import ConnectedMapPointPicker, {
  MapPointPicker
} from '../../../lib/components/map/map-point-picker'

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

const CENTRE = { lat: 44.9778, lon: -93.265 }

/**
 * The confirm bar the rider gets after choosing "Choose on map" in the location
 * picker (rider ask, backlog 3.9). The presentational half is mounted directly
 * so the assertions do not need a live MapLibre instance.
 */
function renderPicker(props: Record<string, any> = {}) {
  return mockWithProvider(
    MapPointPicker,
    {
      center: CENTRE,
      locationType: 'to',
      onCancel: () => undefined,
      onConfirm: () => undefined,
      ...props
    },
    getMockInitialState(),
    messages
  )
}

describe('components > map > map point picker', () => {
  beforeEach(setDefaultTestTime)

  it('names the end being set, in the rider’s words', () => {
    expect(renderPicker({ locationType: 'to' }).wrapper.text()).toContain(
      'Set as destination'
    )
    expect(renderPicker({ locationType: 'from' }).wrapper.text()).toContain(
      'Set as start'
    )
  })

  it('shows the coordinates under the pin so the rider can see it move', () => {
    const text = renderPicker().wrapper.text()
    expect(text).toContain('44.9778')
    expect(text).toContain('-93.265')
  })

  it('draws a pin over the centre of the map', () => {
    const wrapper = renderPicker().wrapper
    expect(wrapper.find('.map-pick-pin').exists()).toBe(true)
    expect(wrapper.find('.map-pick-dot').exists()).toBe(true)
  })

  it('hands the centre back on confirm and nothing on cancel', () => {
    const confirmed: any[] = []
    const cancelled: any[] = []
    const wrapper = renderPicker({
      onCancel: () => cancelled.push(true),
      onConfirm: (c: any) => confirmed.push(c)
    }).wrapper
    wrapper.find('button.map-pick-confirm').simulate('click')
    expect(confirmed).toEqual([CENTRE])
    wrapper.find('button.map-pick-cancel').simulate('click')
    expect(cancelled).toHaveLength(1)
    // Cancelling must not also set a location.
    expect(confirmed).toHaveLength(1)
  })

  it('waits for a map centre before it will confirm', () => {
    const wrapper = renderPicker({ center: null }).wrapper
    expect(wrapper.find('button.map-pick-confirm').prop('disabled')).toBe(true)
    expect(wrapper.text()).toContain('Drag the map')
  })

  describe('connected to the store', () => {
    function renderConnected(mapPickLocationType: string | null) {
      const state = getMockInitialState()
      state.otp.ui.mapPickLocationType = mapPickLocationType
      return mockWithProvider(ConnectedMapPointPicker, {}, state, messages)
    }

    it('renders nothing until the rider asks to pick a point', () => {
      expect(renderConnected(null).wrapper.find('.map-pick-bar').exists()).toBe(
        false
      )
    })

    it('shows the bar for the end the rider chose', () => {
      const wrapper = renderConnected('from').wrapper
      expect(wrapper.find('.map-pick-bar').exists()).toBe(true)
      expect(wrapper.text()).toContain('Set as start')
    })

    it('leaves pick mode when the rider cancels', () => {
      const { store, wrapper } = renderConnected('to')
      wrapper.find('button.map-pick-cancel').simulate('click')
      expect(store.getActions()).toContainEqual({
        payload: { locationType: null },
        type: 'SET_MAP_PICK_MODE'
      })
    })
  })
})
