import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import { ClassicLegIcon } from '@opentripplanner/icons'
import React from 'react'
import yaml from 'js-yaml'

import { ComponentContext } from '../../../lib/util/contexts'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { setDefaultTestTime } from '../../test-utils'
import TripSheet from '../../../lib/components/go-mode/TripSheet'

jest.mock('../../../lib/util/debug-log', () => ({
  getBuildInfo: () => 'test',
  getDeviceId: () => null,
  isDebugLogEnabled: () => false,
  logDebugAction: () => undefined,
  setDebugLogEnabled: () => undefined
}))
// The switch's action is under test in
// __tests__/util/go-mode/explore-replan-gomode-1121.ts; here, only what the
// sheet hands it.
jest.mock('../../../lib/actions/go-mode-explore', () => ({
  chooseGoModeExploreMode: (mode: string) => ({
    payload: mode,
    type: 'TEST_CHOOSE_EXPLORE_MODE'
  })
}))

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

/**
 * BACKLOG 76.3 — Direct | Calm | Wander on the trip sheet, beside the
 * turn-by-turn chip, while the rider is on their own bike to the bus.
 */
const NOW = 1_788_537_600_000
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const place = (name: string): any => ({ lat: 44.9, lon: -93.27, name })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const itinerary = (first: any) => ({
  endTime: NOW + 28 * 60000,
  legs: [
    {
      distance: 2500,
      duration: 549,
      endTime: NOW + 9 * 60000,
      from: place('Your location'),
      intermediateStops: [],
      mode: 'BICYCLE',
      startTime: NOW,
      steps: [],
      to: place('I-35W & 46th St Station'),
      ...first
    },
    {
      distance: 9000,
      duration: 900,
      endTime: NOW + 28 * 60000,
      from: place('I-35W & 46th St Station'),
      intermediateStops: [],
      mode: 'BUS',
      routeShortName: 'METRO Orange Line',
      startTime: NOW + 13 * 60000,
      steps: [],
      to: place('I-35W & 82nd St Station'),
      transitLeg: true
    }
  ],
  startTime: NOW
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Harness = (): any => (
  <ComponentContext.Provider value={{ LegIcon: ClassicLegIcon } as never}>
    <TripSheet onClose={() => undefined} />
  </ComponentContext.Provider>
)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(goMode: any, first: any = {}) {
  const state = getMockInitialState()
  state.otp.goMode = {
    ...state.otp.goMode,
    activeItinerary: itinerary(first),
    isActive: true,
    liveLegTimes: {},
    progress: { currentLegIndex: 0, stopsRemaining: 3 },
    ...goMode
  }
  return mockWithProvider(Harness, {}, state, messages)
}

const radios = (wrapper: any) =>
  wrapper
    .find('.go-mode-ride-style button[role="radio"]')
    .map((b: any) => `${b.text()}${b.prop('aria-checked') ? '*' : ''}`)

describe('components > go-mode > the in-ride Direct | Calm | Wander switch (76.3)', () => {
  beforeEach(setDefaultTestTime)

  it('shows the trip’s own mode on a bike ride to the bus', () => {
    const { wrapper } = render({ exploreMode: 'calm' })
    expect(radios(wrapper)).toEqual(['Direct', 'Calm*', 'Wander'])
    expect(wrapper.find('.ride-style-note')).toHaveLength(0)
  })

  it('Direct when the trip has no mode of its own', () => {
    const { wrapper } = render({})
    expect(radios(wrapper)).toEqual(['Direct*', 'Calm', 'Wander'])
  })

  it('a tap hands the sheet’s action the mode', () => {
    const { store, wrapper } = render({ exploreMode: 'direct' })
    wrapper.find('button.ride-style-wander').simulate('click')
    expect(store.getActions()).toContainEqual({
      payload: 'wander',
      type: 'TEST_CHOOSE_EXPLORE_MODE'
    })
  })

  it('says so when the bus cut the ride short', () => {
    const partial = render(
      { exploreMode: 'wander' },
      {
        exploreShortfall: 'partial'
      }
    ).wrapper
    expect(partial.find('.ride-style-note').text()).toBe(
      'Short on time — taking a faster way'
    )
    const fastest = render(
      { exploreMode: 'calm' },
      {
        exploreShortfall: 'fastest'
      }
    ).wrapper
    expect(fastest.find('.ride-style-note').text()).toBe(
      'Short on time — taking the fastest way'
    )
    // Direct makes no claim about a ride it is not choosing.
    const direct = render(
      { exploreMode: 'direct' },
      {
        exploreShortfall: 'fastest'
      }
    ).wrapper
    expect(direct.find('.ride-style-note')).toHaveLength(0)
  })

  it('is not offered on a walk, a rented bike, or once a bus has the rider', () => {
    expect(
      render({ exploreMode: 'calm' }, { mode: 'WALK' }).wrapper.find(
        '.go-mode-ride-style'
      )
    ).toHaveLength(0)
    expect(
      render({ exploreMode: 'calm' }, { rentedBike: true }).wrapper.find(
        '.go-mode-ride-style'
      )
    ).toHaveLength(0)
    expect(
      render({
        exploreMode: 'calm',
        riding: { legIndex: 1, tripId: '1:orange-1' }
      }).wrapper.find('.go-mode-ride-style')
    ).toHaveLength(0)
    expect(
      render({
        exploreMode: 'calm',
        progress: { currentLegIndex: 1, stopsRemaining: 3 }
      }).wrapper.find('.go-mode-ride-style')
    ).toHaveLength(0)
  })
})
