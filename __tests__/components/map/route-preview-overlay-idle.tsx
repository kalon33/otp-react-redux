/* eslint-disable @typescript-eslint/no-explicit-any */
import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { applyMiddleware, createStore } from 'redux'
import { mount } from 'enzyme'
import { Provider } from 'react-redux'
import clone from 'lodash/cloneDeep'
import polyline from '@mapbox/polyline'
import React from 'react'
import thunk from 'redux-thunk'

import { doMergeItineraries } from '../../../lib/components/narrative/narrative-itineraries'
import { getMockInitialState } from '../../test-utils/mock-data/store'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'
import responses from '../../test-utils/mock-data/0921-0912-search-responses.json'
import RoutePreviewOverlay, {
  mapStateToProps
} from '../../../lib/components/map/route-preview-overlay'

const mockSourceData: any[] = []
const mockToGeoJSON = jest.fn()

jest.mock('react-map-gl/maplibre', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const react = jest.requireActual('react')
  return {
    ...jest.requireActual('react-map-gl/maplibre'),
    Layer: () => null,
    Source: ({ children, data }: any) => {
      mockSourceData.push(data)
      return react.createElement(react.Fragment, null, children)
    },
    useMap: () => ({ current: null })
  }
})

jest.mock('@mapbox/polyline', () => {
  const real = jest.requireActual('@mapbox/polyline')
  return {
    ...real,
    toGeoJSON: (...args: any[]) => {
      mockToGeoJSON(...args)
      return real.toGeoJSON(...args)
    }
  }
})

/**
 * Backlog 66.3 — RoutePreviewOverlay re-decoded every leg polyline and
 * deep-compared the whole FeatureCollection on every dispatch, because its
 * mapStateToProps flatMapped a new `geometries` array per call.
 */

const SEARCH_ID = 'search-66-3'
const reducer = createOtpReducer({})

// The fixture's legs carry no geometry; give each a polyline, 12 distinct ones
// repeated across legs (the real answers repeat shapes across itineraries).
function withGeometry(itineraries: any[]) {
  let n = 0
  return clone(itineraries).map((itin: any) => ({
    ...itin,
    legs: itin.legs.map((leg: any) => {
      const k = n++ % 12
      return {
        ...leg,
        legGeometry: {
          length: 2,
          points: polyline.encode([
            [44.9 + k * 0.01, -93.3],
            [44.9 + k * 0.01, -93.2]
          ])
        }
      }
    })
  }))
}

const responseAction = (index: number) => ({
  payload: {
    index,
    response: {
      plan: {
        itineraries: withGeometry((responses as any)[String(index)].itineraries)
      },
      requestId: SEARCH_ID
    },
    searchId: SEARCH_ID
  },
  type: 'ROUTING_RESPONSE'
})

function settledState(indexes = [0, 1, 2]) {
  const base = getMockInitialState()
  base.otp.config.itinerary = {
    ...base.otp.config.itinerary,
    showFirstResultByDefault: false
  }
  base.otp.currentQuery.from = { lat: 44.948, lon: -93.287, name: 'Lake St' }
  base.otp.currentQuery.to = { lat: 44.857, lon: -93.29, name: '98th St' }
  let otp = reducer(base.otp, {
    payload: {
      activeItinerary: null,
      pending: indexes.length,
      pendingCombos: [],
      searchId: SEARCH_ID
    },
    type: 'ROUTING_REQUEST'
  })
  indexes.forEach((i) => {
    otp = reducer(otp, responseAction(i))
  })
  return { ...base, otp }
}

const position = (n: number) => ({
  payload: {
    position: { coords: { latitude: 44.95, longitude: -93.26 }, timestamp: n }
  },
  type: 'POSITION_RESPONSE'
})

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('backlog 66.3 > the route preview overlay on unrelated dispatches', () => {
  beforeEach(() => {
    mockSourceData.length = 0
    mockToGeoJSON.mockClear()
  })

  it('mapStateToProps: same geometries array until the response changes', () => {
    const state: any = settledState()
    const first = mapStateToProps(state) as any
    expect(first.geometries.length).toBe(12)
    // De-duplicated and free of empty entries.
    expect(new Set(first.geometries).size).toBe(first.geometries.length)
    expect(first.geometries.every((g: any) => !!g)).toBe(true)

    const unrelated: any = {
      ...state,
      otp: reducer(state.otp, position(1))
    }
    expect((mapStateToProps(unrelated) as any).geometries).toBe(
      first.geometries
    )

    const newer: any = {
      ...state,
      otp: reducer(state.otp, responseAction(0))
    }
    expect((mapStateToProps(newer) as any).geometries).not.toBe(
      first.geometries
    )
  })

  it('keeps the empty returns: no search id, no response, Go Mode backgrounded', () => {
    const state: any = settledState()
    expect(
      mapStateToProps({
        ...state,
        otp: { ...state.otp, activeSearchId: null }
      } as any)
    ).toEqual({})
    const noResponse: any = {
      ...state,
      otp: {
        ...state.otp,
        searches: {
          [SEARCH_ID]: { ...state.otp.searches[SEARCH_ID], response: undefined }
        }
      }
    }
    expect((mapStateToProps(noResponse) as any).geometries).toBeUndefined()
  })

  it('mounted: two unrelated dispatches hand the source the same data and decode nothing', () => {
    const state = settledState()
    const root = (st: any, action: any) => {
      const next = reducer(st.otp, action)
      return next === st.otp ? st : { ...st, otp: next }
    }
    const store = createStore(root, state as any, applyMiddleware(thunk))
    const wrapper = mount(
      <Provider store={store}>
        <RoutePreviewOverlay />
      </Provider>
    )
    expect(mockSourceData.length).toBe(1)
    const data = mockSourceData[0]
    expect(data.type).toBe('FeatureCollection')
    expect(data.features.length).toBe(12)
    const decoded = mockToGeoJSON.mock.calls.length
    // Each distinct polyline once.
    expect(decoded).toBe(data.features.length)

    store.dispatch(position(1) as any)
    store.dispatch({
      payload: { type: 'x' },
      type: 'POSITION_FETCHING'
    } as any)
    wrapper.update()
    expect(mockToGeoJSON.mock.calls.length).toBe(decoded)
    expect(mockSourceData.every((d) => d === data)).toBe(true)

    // A new ROUTING_RESPONSE is a new collection.
    store.dispatch(responseAction(1) as any)
    wrapper.update()
    const latest = mockSourceData[mockSourceData.length - 1]
    expect(latest).not.toBe(data)
    wrapper.unmount()
  })
})

describe('backlog 66.4 > doMergeItineraries is keyed on the array, weakly', () => {
  const makeList = (n: number) =>
    clone((responses as any)['0'].itineraries).slice(0, n)

  it('returns the same merged object for the same array', () => {
    const list = makeList(8)
    const first = doMergeItineraries(list, undefined, true)
    expect(doMergeItineraries(list, undefined, true)).toBe(first)
    expect(first.allItineraries.length).toBe(8)
  })

  it('a different array is a different merge, 50 times over', () => {
    const seen = new Set<any>()
    for (let i = 0; i < 50; i++) {
      seen.add(doMergeItineraries(makeList(4), undefined, true))
    }
    expect(seen.size).toBe(50)
  })

  it('holds no strong reference: no Map on the function', () => {
    expect((doMergeItineraries as any).cache).toBeUndefined()
  })

  it('lets a merged list be collected once its array is dropped', async () => {
    const gc = (global as any).gc
    if (typeof gc !== 'function') return // only under node --expose-gc
    const refs: any[] = []
    const make = () => {
      for (let i = 0; i < 5; i++) {
        refs.push(
          new (global as any).WeakRef(
            doMergeItineraries(makeList(6), undefined, true)
          )
        )
      }
    }
    make()
    await new Promise((resolve) => setTimeout(resolve, 0))
    gc()
    expect(refs.some((ref) => ref.deref() === undefined)).toBe(true)
  })
})
