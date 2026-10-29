import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { IntlProvider } from 'react-intl'
import Enzyme, { mount } from 'enzyme'
import EnzymeReactAdapter from 'enzyme-adapter-react-16'
import polyline from '@mapbox/polyline'
import React from 'react'

import { FOLLOW_ENGAGE_DELAY_MS } from '../../../lib/util/go-mode/follow-camera'
import { GoModeMapOverlay } from '../../../lib/components/go-mode/GoModeMap'

/**
 * Backlog 75.1, the map half. Chaos agent C26 (2026-10-29,
 * `chaos/s3b-walk-pathology.js`, kind `nan-coords`): one fix
 * `{latitude: NaN, longitude: NaN}` on a live access leg and the page threw
 * `Error: Invalid LngLat object: (NaN, NaN) at … setLngLat`, component stack
 * `ForwardRef (at GoModeMap.tsx:906) / GoModeMapOverlay (at GoModeMap.tsx:1005)`
 * — the user-position `<Marker>` — and the whole app fell to "Something went
 * wrong · Reload to keep going".
 *
 * The Marker here does what react-map-gl's does on render: hand its
 * coordinates to MapLibre's own `LngLat`, which is the constructor that threw.
 * The follow camera does the same through `easeTo`.
 */

const markerCoords: Array<[number, number]> = []
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMap: any = {
  easeTo: jest.fn(({ center }: { center: [number, number] }) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LngLat } = jest.requireActual('maplibre-gl')
    LngLat.convert(center)
  }),
  fitBounds: jest.fn(),
  getCanvasContainer: () => ({
    addEventListener: jest.fn(),
    removeEventListener: jest.fn()
  }),
  getZoom: () => 15,
  isMoving: () => false,
  off: jest.fn(),
  on: jest.fn(),
  once: jest.fn(),
  triggerRepaint: jest.fn()
}

jest.mock('react-map-gl/maplibre', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const react = jest.requireActual('react')
  const actual = jest.requireActual('react-map-gl/maplibre')
  return {
    ...actual,
    Layer: () => null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Marker: ({ latitude, longitude }: any) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LngLat } = jest.requireActual('maplibre-gl')
      // react-map-gl's Marker: `marker.setLngLat([longitude, latitude])`.
      const at = new LngLat(longitude, latitude)
      markerCoords.push([at.lng, at.lat])
      return react.createElement('div', { 'data-testid': 'marker' })
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Source: ({ children }: any) =>
      react.createElement(react.Fragment, null, children),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useControl: (onCreate: (ctx: any) => any) => {
      const ref = react.useRef(null)
      if (!ref.current) {
        ref.current = onCreate({})
        ref.current.onAdd()
      }
      return ref.current
    },
    useMap: () => ({ current: mockMap })
  }
})

Enzyme.configure({ adapter: new EnzymeReactAdapter() })

const A: [number, number] = [44.92145, -93.27796]
const B: [number, number] = [44.95911, -93.28276]
const routeGeoJson: GeoJSON.FeatureCollection = {
  features: [
    {
      geometry: polyline.toGeoJSON(polyline.encode([A, B])),
      properties: { index: 0 },
      type: 'Feature'
    }
  ],
  type: 'FeatureCollection'
}

const T0 = 1793252842259
const fixAt = (lat: number, lon: number, t: number) =>
  ({
    coords: { accuracy: 8, latitude: lat, longitude: lon },
    timestamp: t
  } as unknown as GeolocationPosition)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Harness = (p: any) => (
  <IntlProvider locale="en-US" onError={() => undefined}>
    <GoModeMapOverlay {...p} />
  </IntlProvider>
)

const props = (currentPosition: GeolocationPosition | null) => ({
  activeLegIndex: null,
  currentLegMode: 'BICYCLE',
  currentPosition,
  followUser: true,
  onSetFollow: () => undefined,
  onToggleFollow: () => undefined,
  routeGeoJson
})

describe('components > go-mode map > a fix MapLibre cannot place (75.1)', () => {
  let now = T0

  beforeEach(() => {
    now = T0
    markerCoords.length = 0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    mockMap.easeTo.mockClear()
  })
  afterEach(() => jest.restoreAllMocks())

  it('the stand-in Marker uses the constructor that threw on the page', () => {
    // The reproduction is only as good as this: MapLibre's own message.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LngLat } = jest.requireActual('maplibre-gl')
    expect(() => new LngLat(NaN, NaN)).toThrow(
      'Invalid LngLat object: (NaN, NaN)'
    )
  })

  it('mounts on a NaN fix without a dot', () => {
    const wrapper = mount(<Harness {...props(fixAt(NaN, NaN, T0))} />)
    expect(wrapper.find('[data-testid="marker"]')).toHaveLength(0)
  })

  it('draws no dot for a NaN fix, and keeps the map up', () => {
    const wrapper = mount(<Harness {...props(fixAt(A[0], A[1], T0))} />)
    expect(markerCoords).toEqual([[A[1], A[0]]])
    // The C26 injection: one NaN fix 500 ms after the last good one.
    wrapper.setProps({ currentPosition: fixAt(NaN, NaN, T0 + 500) })
    expect(wrapper.find('[data-testid="marker"]')).toHaveLength(0)
    // ...and the next good fix brings the dot straight back.
    wrapper.setProps({ currentPosition: fixAt(A[0], A[1] - 0.0003, T0 + 1500) })
    expect(wrapper.find('[data-testid="marker"]')).toHaveLength(1)
  })

  it('does not hand the follow camera a NaN centre', () => {
    const wrapper = mount(<Harness {...props(fixAt(A[0], A[1], T0))} />)
    now += FOLLOW_ENGAGE_DELAY_MS + 10
    wrapper.setProps({ currentPosition: fixAt(A[0], A[1], now) })
    expect(mockMap.easeTo).toHaveBeenCalledTimes(1)
    now += 1000
    wrapper.setProps({ currentPosition: fixAt(NaN, NaN, now) })
    expect(mockMap.easeTo).toHaveBeenCalledTimes(1)
  })

  it('treats a latitude past the pole the same way (LngLat throws on it too)', () => {
    const wrapper = mount(<Harness {...props(fixAt(A[0], A[1], T0))} />)
    wrapper.setProps({ currentPosition: fixAt(91, A[1], T0 + 500) })
    expect(wrapper.find('[data-testid="marker"]')).toHaveLength(0)
  })
})
