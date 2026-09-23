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
import BatchSearchScreen from '../../../lib/components/mobile/batch-search-screen'
import PlacesChips, {
  getPlaceChips
} from '../../../lib/components/mobile/places-chips'

// The search screen's map and app menu need a browser map and the debug log;
// neither matters to the chip row's wiring.
jest.mock('../../../lib/components/map/default-map', () => () => null)
jest.mock('../../../lib/components/app/app-menu', () => () => null)

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

const HOME = {
  address: '3120 Cedar Ave S, Minneapolis',
  icon: 'home',
  lat: 44.9467,
  lon: -93.2474,
  name: '3120 Cedar Ave S, Minneapolis',
  type: 'home'
}
const WORK = {
  address: '250 Marquette Ave, Minneapolis',
  icon: 'briefcase',
  lat: 44.9791,
  lon: -93.2663,
  name: '250 Marquette Ave, Minneapolis',
  type: 'work'
}
const GYM = {
  address: '1200 Nicollet Mall, Minneapolis',
  icon: 'map-marker',
  id: 'gym-1',
  lat: 44.9707,
  lon: -93.2773,
  name: 'Gym',
  type: 'custom'
}
const RECENT = {
  address: '5116 27th Ave S, Minneapolis, MN, USA',
  icon: 'clock-o',
  id: 'recent-1',
  lat: 44.9097,
  lon: -93.2336,
  name: '5116 27th Ave S, Minneapolis, MN, USA',
  timestamp: 1790000000000,
  type: 'recent'
}

function render({
  onPlanTrip = jest.fn(),
  recent = [RECENT],
  saved = [HOME, WORK, GYM],
  to = null
}: {
  onPlanTrip?: jest.Mock
  recent?: any[]
  saved?: any[]
  to?: any
} = {}) {
  const state: any = getMockInitialState()
  state.otp.config.persistence = { enabled: true, strategy: 'localStorage' }
  state.otp.currentQuery.to = to
  state.router = { location: { pathname: '/', search: '' } }
  state.user.localUser = {
    ...state.user.localUser,
    recentPlaces: recent,
    savedLocations: saved
  }
  const { store, wrapper } = mockWithProvider(
    PlacesChips,
    { onPlanTrip },
    state,
    messages
  )
  return { onPlanTrip, store, wrapper }
}

const chipTexts = (wrapper: any) =>
  wrapper.find('.places-chips button').map((b: any) => b.text())

describe('components > mobile > places chips (backlog 28.3)', () => {
  it('renders Home, Work, the saved places, the last recent, then Add', () => {
    expect(chipTexts(render().wrapper)).toEqual([
      'Home',
      'Work',
      'Gym',
      '5116 27th Ave S',
      'Add'
    ])
    expect(render().wrapper.text()).toContain('Your places')
  })

  it('a tap fills the destination with that place', () => {
    const { onPlanTrip, store, wrapper } = render()
    wrapper.find('.places-chips button').at(2).simulate('click')
    const set = store.getActions().find((a: any) => a.type === 'SET_LOCATION')
    expect(set.payload.locationType).toBe('to')
    expect(set.payload.location).toMatchObject({ lat: GYM.lat, name: 'Gym' })
    expect(onPlanTrip).not.toHaveBeenCalled()
  })

  it('a tap on the chip that is already the destination plans the trip', () => {
    const { onPlanTrip, store, wrapper } = render({ to: { ...GYM } })
    const gym = wrapper.find('.places-chips button').at(2)
    expect(gym.prop('aria-pressed')).toBe(true)
    gym.simulate('click')
    expect(onPlanTrip).toHaveBeenCalledTimes(1)
    expect(store.getActions().some((a: any) => a.type === 'SET_LOCATION')).toBe(
      false
    )
  })

  it('renders nothing when there are no places and no recents', () => {
    const { wrapper } = render({ recent: [], saved: [] })
    expect(wrapper.find('.places-chips')).toHaveLength(0)
  })

  it('shows Home and Work only when they are set', () => {
    expect(chipTexts(render({ saved: [GYM] }).wrapper)).toEqual([
      'Gym',
      '5116 27th Ave S',
      'Add'
    ])
    expect(chipTexts(render({ recent: [], saved: [WORK] }).wrapper)).toEqual([
      'Work',
      'Add'
    ])
  })

  it('+ Add opens the places editor', () => {
    const { wrapper } = render()
    wrapper.find('.places-chips button.add').simulate('click')
    // The mock store's router middleware turns the push into a hash change.
    expect(window.location.hash).toMatch(/^#\/places\/new/)
  })
})

describe('components > mobile > batch search screen', () => {
  it('puts the chips under the destination box, planning as the Plan button does', () => {
    const state: any = getMockInitialState()
    state.otp.config.persistence = { enabled: true, strategy: 'localStorage' }
    state.router = { location: { pathname: '/', search: '' } }
    state.user.localUser = {
      ...state.user.localUser,
      recentPlaces: [RECENT],
      savedLocations: [HOME, WORK, GYM]
    }
    const { wrapper } = mockWithProvider(BatchSearchScreen, {}, state, messages)
    const screen: any = wrapper.find('BatchSearchScreen').instance()
    const chips = wrapper.find('PlacesChips')
    expect(chips).toHaveLength(1)
    expect(chips.prop('onPlanTrip')).toBe(screen.handlePlanTripClick)
  })
})

describe('getPlaceChips', () => {
  it('skips a recent that is already a chip and takes the newest other one', () => {
    const older = { ...RECENT, id: 'r0', lat: 44.9, timestamp: 1 }
    const sameAsHome = { ...HOME, id: 'r2', timestamp: 1790000000001 }
    const chips = getPlaceChips([HOME], [older, sameAsHome, RECENT])
    expect(chips.map((c) => c.kind)).toEqual(['home', 'recent'])
    expect(chips[1].place.id).toBe('recent-1')
  })

  it('leaves out config-suggested locations and places without coordinates', () => {
    const chips = getPlaceChips(
      [
        { lat: 1, lon: 2, name: 'Airport', type: 'suggested' },
        { name: 'Home', type: 'home' },
        GYM
      ],
      []
    )
    expect(chips.map((c) => c.place.name)).toEqual(['Gym'])
  })
})
