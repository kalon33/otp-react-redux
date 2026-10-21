/* eslint-disable @typescript-eslint/no-explicit-any */
import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { applyMiddleware, createStore } from 'redux'
import { ClassicLegIcon, ClassicModeIcon } from '@opentripplanner/icons'
import { IntlProvider } from 'react-intl'
import { mount } from 'enzyme'
import { Provider } from 'react-redux'
import clone from 'lodash/cloneDeep'
import React from 'react'
import thunk from 'redux-thunk'

import { ComponentContext } from '../../../lib/util/contexts'
import {
  getActiveSearchErrors,
  getRealtimeEffects
} from '../../../lib/util/state'
import { getMockInitialState } from '../../test-utils/mock-data/store'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'
import MetroItinerary, {
  MetroItinerary as MetroItineraryClass
} from '../../../lib/components/narrative/metro/metro-itinerary'
import NarrativeItineraries, {
  getListedItineraries
} from '../../../lib/components/narrative/narrative-itineraries'
import responses from '../../test-utils/mock-data/0921-0912-search-responses.json'

/**
 * Backlog 66.2 — after 66.1 the results list still re-rendered every row on
 * every dispatch, position polls included: mapStateToProps handed connect a
 * fresh `getActiveSearchErrors` object and a fresh `getRealtimeEffects` object
 * per call, so connect never short-circuited. Both selectors are now memoized;
 * an unrelated dispatch leaves every prop of the list identical and renders
 * no row.
 */

const SEARCH_ID = 'search-66-2'

beforeAll(() => {
  // getInitialState warns about the unset homeTimezone.
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
const reducer = createOtpReducer({})

const responseAction = (index: number) => ({
  payload: {
    index,
    response: {
      plan: clone({
        itineraries: (responses as any)[String(index)].itineraries
      }),
      requestId: SEARCH_ID
    },
    searchId: SEARCH_ID
  },
  type: 'ROUTING_RESPONSE'
})

function settledOtp() {
  const base = getMockInitialState().otp
  base.currentQuery.from = { lat: 44.948, lon: -93.287, name: 'Lake St' }
  base.currentQuery.to = { lat: 44.857, lon: -93.29, name: '98th St' }
  base.config.itinerary = {
    ...base.config.itinerary,
    customBatchUiBackground: true,
    defaultFareType: { mediumId: null, riderCategoryId: null },
    groupByMode: true,
    groupTransitModes: true,
    hideSkeletons: true,
    mergeByRouteSignature: true,
    mergeItineraries: true,
    showBatchUiItineraryHeaders: false,
    showHeaderText: false
  }
  let otp = reducer(base, {
    payload: {
      activeItinerary: null,
      pending: 3,
      pendingCombos: [],
      searchId: SEARCH_ID
    },
    type: 'ROUTING_REQUEST'
  })
  ;[0, 1, 2].forEach((i) => {
    otp = reducer(otp, responseAction(i))
  })
  return otp
}

const stateOf = (otp: any) => ({ ...getMockInitialState(), otp })

const POSITION_FETCHING = {
  payload: { type: 'perf' },
  type: 'POSITION_FETCHING'
}
const positionResponse = (n: number) => ({
  payload: {
    position: {
      coords: { accuracy: 20, latitude: 44.95 + n * 1e-5, longitude: -93.26 },
      timestamp: n
    }
  },
  type: 'POSITION_RESPONSE'
})

describe('backlog 66.2 > selector identity', () => {
  it('getActiveSearchErrors: same state content, same object', () => {
    const otp = settledOtp()
    const first = getActiveSearchErrors(stateOf(otp))
    // A different state object whose inputs are the same objects.
    expect(getActiveSearchErrors({ ...stateOf(otp), otp: { ...otp } })).toBe(
      first
    )
    // An action that never touches the search.
    const after = reducer(otp, positionResponse(1))
    expect(after).not.toBe(otp)
    expect(getActiveSearchErrors(stateOf(after))).toBe(first)
  })

  it('getActiveSearchErrors: a new response is a new object', () => {
    const otp = settledOtp()
    const first = getActiveSearchErrors(stateOf(otp))
    const next = reducer(otp, {
      payload: {
        index: 3,
        response: { plan: { itineraries: [] }, requestId: SEARCH_ID },
        searchId: SEARCH_ID
      },
      type: 'ROUTING_RESPONSE'
    })
    expect(next.searches[SEARCH_ID].response).not.toBe(
      otp.searches[SEARCH_ID].response
    )
    expect(getActiveSearchErrors(stateOf(next))).not.toBe(first)
  })

  it('getActiveSearchErrors: still empty when there is no active search', () => {
    const state = stateOf({ ...settledOtp(), activeSearchId: null })
    expect(getActiveSearchErrors(state)).toEqual({})
  })

  it('getRealtimeEffects: same inputs, same object; changed response, new object', () => {
    const otp = settledOtp()
    otp.config.realtimeEffectsDisplayThreshold = 100
    const first = getRealtimeEffects(stateOf(otp))
    expect(first.exceedsThreshold).toBe(false)
    expect(getRealtimeEffects(stateOf(reducer(otp, positionResponse(1))))).toBe(
      first
    )
    const changed = reducer(otp, responseAction(0))
    expect(getRealtimeEffects(stateOf(changed))).not.toBe(first)
  })

  it('getRealtimeEffects: a changed display threshold is a new object', () => {
    const otp = settledOtp()
    otp.config.realtimeEffectsDisplayThreshold = 100
    const first = getRealtimeEffects(stateOf(otp))
    const other = {
      ...otp,
      config: { ...otp.config, realtimeEffectsDisplayThreshold: 0 }
    }
    const second = getRealtimeEffects(stateOf(other))
    expect(second).not.toBe(first)
    expect(second.exceedsThreshold).toBe(true)
  })
})

describe('backlog 66.2 > a mounted results list on an unrelated dispatch', () => {
  beforeAll(() => {
    const never = () => new Promise(() => undefined)
    Object.assign(global, { fetch: never })
  })

  it('keeps every NarrativeItineraries prop identical and renders no row', () => {
    const otp = settledOtp()
    const root = (st: any, action: any) => {
      const next = reducer(st.otp, action)
      return next === st.otp ? st : { ...st, otp: next }
    }
    const store = createStore(root, stateOf(otp) as any, applyMiddleware(thunk))
    const wrapper = mount(
      <IntlProvider defaultLocale="en-US" locale="en-US" onError={jest.fn()}>
        <Provider store={store}>
          <ComponentContext.Provider
            value={
              {
                ItineraryBody: MetroItinerary,
                LegIcon: ClassicLegIcon,
                ModeIcon: ClassicModeIcon
              } as any
            }
          >
            <NarrativeItineraries />
          </ComponentContext.Provider>
        </Provider>
      </IntlProvider>
    )
    expect(wrapper.find('li.result').length).toBeGreaterThan(5)

    const propsNow = () => {
      wrapper.update()
      return wrapper.find('NarrativeItineraries').props() as any
    }
    const before = propsNow()
    const rowRender = jest.spyOn(MetroItineraryClass.prototype, 'render')

    ;[
      POSITION_FETCHING,
      positionResponse(1),
      positionResponse(2),
      { payload: {}, type: 'SOME_UNHANDLED_ACTION' }
    ].forEach((action) => {
      store.dispatch(action as any)
      const after = propsNow()
      const changed = Object.keys({ ...before, ...after }).filter(
        (key) => before[key] !== after[key]
      )
      expect(changed).toEqual([])
    })
    expect(rowRender).not.toHaveBeenCalled()
    rowRender.mockRestore()
    wrapper.unmount()
  })
})

describe('backlog 66.2 > the listed rows keep their identity', () => {
  // demoteTokenTransitHops returns a NEW array whenever it reorders, so on a
  // search with a 602 m closing hop (2026-08-31) `mergedItineraries` changed
  // identity on every dispatch and the list re-rendered for a position poll.
  const street = (distance: number) => ({
    distance,
    mode: 'BICYCLE',
    transitLeg: false
  })
  const bus = (routeId: string, distance: number) => ({
    distance,
    mode: 'BUS',
    routeId,
    transitLeg: true
  })
  const tokenHop = {
    endTime: 1000 * 60 * 60 + 21000,
    legs: [street(7), bus('1:539', 602), street(1743)]
  }
  const rideIt = { endTime: 1000 * 60 * 60, legs: [street(3970)] }
  const realRide = {
    endTime: 1000 * 60 * 61,
    legs: [street(7), bus('1:540', 1273), street(1408)]
  }
  const CONFIG = {}
  const SORT = { direction: 'ASC', type: 'BEST' }
  const listed = (
    merged: any,
    over: { config?: any; routeLock?: any; sort?: any } = {}
  ) =>
    getListedItineraries(
      merged,
      true,
      over.config || CONFIG,
      over.sort || SORT,
      undefined,
      undefined,
      undefined,
      undefined,
      over.routeLock
    )

  it('demotes the hop, and returns the same array until an input changes', () => {
    const merged = { mergedItineraries: [tokenHop, rideIt, realRide] }
    const first = listed(merged) as any[]
    // Not left in place: the hop is below the trip without it.
    expect(first.indexOf(rideIt)).toBeLessThan(first.indexOf(tokenHop))
    expect(first[first.length - 1]).toBe(tokenHop)
    expect(listed(merged)).toBe(first)
    expect(listed(merged)).toBe(first)
    // A new merge result (a new response) is a new list.
    expect(
      listed({ mergedItineraries: [tokenHop, rideIt, realRide] })
    ).not.toBe(first)
  })

  it('a changed sort or route lock is a new list', () => {
    const merged = { mergedItineraries: [tokenHop, rideIt, realRide] }
    const first = listed(merged)
    expect(
      listed(merged, { sort: { direction: 'ASC', type: 'ARRIVALTIME' } })
    ).not.toBe(first)
    expect(
      listed(merged, { routeLock: { routes: ['1:540'], scope: 'only' } })
    ).not.toBe(first)
  })
})
