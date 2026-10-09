import '../../test-utils/mock-window-matchMedia'
import { IntlProvider } from 'react-intl'
import Enzyme, { mount } from 'enzyme'
import EnzymeReactAdapter from 'enzyme-adapter-react-16'
import polyline from '@mapbox/polyline'
import React from 'react'

import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import {
  FOLLOW_ENGAGE_DELAY_MS,
  FOLLOW_ZOOM_ACCESS
} from '../../../lib/util/go-mode/follow-camera'
import { GoModeMapOverlay } from '../../../lib/components/go-mode/GoModeMap'

/**
 * Backlog 44.3, the map half, mounted. With follow on and the next corner
 * close, the camera eases to a frame rotated so the street into the corner
 * points up; once the turn is passed (or far) it eases back to north-up at
 * the access zoom. The turn itself is drawn as its own source.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMap: any = {
  cameraForBounds: jest.fn(() => ({
    bearing: 0,
    center: { lat: 44.942, lng: -93.2895 },
    zoom: 17.4
  })),
  easeTo: jest.fn(),
  fitBounds: jest.fn(),
  off: jest.fn(),
  on: jest.fn()
}
const mockSources: string[] = []

jest.mock('react-map-gl/maplibre', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const react = jest.requireActual('react')
  const actual = jest.requireActual('react-map-gl/maplibre')
  return {
    ...actual,
    Layer: () => null,
    Marker: () => null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Source: ({ children, id }: any) => {
      mockSources.push(id)
      return react.createElement(react.Fragment, null, children)
    },
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

const SOUTH: [number, number] = [44.94, -93.29]
const CORNER: [number, number] = [44.9427, -93.29]
const EAST: [number, number] = [44.9427, -93.2875]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const leg: any = {
  legGeometry: { points: polyline.encode([SOUTH, CORNER, EAST]) },
  mode: 'BICYCLE'
}
const cornerOffset = calculateDistance(...SOUTH, ...CORNER)
const cue = {
  distanceMeters: 200,
  index: 1,
  instruction: 'Turn right on W 32nd St',
  lat: CORNER[0],
  lon: CORNER[1],
  offsetMeters: cornerOffset,
  relativeDirection: 'RIGHT',
  significant: true,
  streetName: 'W 32nd St'
}
const routeGeoJson: GeoJSON.FeatureCollection = {
  features: [
    {
      geometry: polyline.toGeoJSON(leg.legGeometry.points),
      properties: { index: 0 },
      type: 'Feature'
    }
  ],
  type: 'FeatureCollection'
}

const position = (lat: number, t: number) =>
  ({
    coords: { accuracy: 8, latitude: lat, longitude: -93.29 },
    timestamp: t
  } as unknown as GeolocationPosition)

const T0 = 1_791_500_000_000
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const props = (over: any = {}) => ({
  activeLegIndex: null,
  currentLeg: leg,
  currentLegMode: 'BICYCLE',
  currentPosition: position(44.9405, T0),
  distanceToNextTurn: 300,
  followUser: true,
  nextTurnCue: cue,
  onSetFollow: () => undefined,
  onToggleFollow: () => undefined,
  routeGeoJson,
  ...over
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Harness = (p: any) => (
  <IntlProvider locale="en-US" onError={() => undefined}>
    <GoModeMapOverlay {...p} />
  </IntlProvider>
)

describe('components > go-mode map > the turn view (44.3)', () => {
  let now = T0
  beforeEach(() => {
    now = T0
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    mockMap.easeTo.mockClear()
    mockMap.cameraForBounds.mockClear()
    mockSources.length = 0
  })
  afterEach(() => jest.restoreAllMocks())

  it('turns the map to the corner when it comes up, then back to north-up', () => {
    const wrapper = mount(<Harness {...props()} />)
    // The next turn is drawn as its own source on the map.
    expect(mockSources).toContain('go-mode-turn')
    now += FOLLOW_ENGAGE_DELAY_MS + 10

    // 300 m out: plain north-up follow, no rotation.
    wrapper.setProps({ currentPosition: position(44.9406, T0 + 1000) })
    expect(mockMap.easeTo).toHaveBeenCalledTimes(1)
    expect(mockMap.easeTo.mock.calls[0][0].bearing).toBeUndefined()

    // 150 m out on a bike: the camera turns to the corner.
    wrapper.setProps({
      currentPosition: position(44.9414, T0 + 2000),
      distanceToNextTurn: 150
    })
    expect(mockMap.cameraForBounds).toHaveBeenCalledTimes(1)
    const turnEase = mockMap.easeTo.mock.calls[1][0]
    // Due north is the street into the corner.
    expect(Math.min(turnEase.bearing, 360 - turnEase.bearing)).toBeLessThan(1)
    expect(turnEase.zoom).toBeCloseTo(17.4)

    // Past the corner, the next turn far away: back to north-up, access zoom.
    wrapper.setProps({
      currentPosition: position(44.9427, T0 + 3000),
      distanceToNextTurn: 900,
      nextTurnCue: { ...cue, index: 2, offsetMeters: cornerOffset + 900 }
    })
    const release = mockMap.easeTo.mock.calls[2][0]
    expect(release.bearing).toBe(0)
    expect(release.zoom).toBe(FOLLOW_ZOOM_ACCESS)
  })

  it('leaves the camera alone when the rider has turned follow off', () => {
    const wrapper = mount(<Harness {...props({ followUser: false })} />)
    now += FOLLOW_ENGAGE_DELAY_MS + 10
    wrapper.setProps({
      currentPosition: position(44.9414, T0 + 2000),
      distanceToNextTurn: 150
    })
    expect(mockMap.easeTo).not.toHaveBeenCalled()
    // The turn is still drawn.
    expect(mockSources).toContain('go-mode-turn')
  })

  it('never turns the map on a bus leg', () => {
    const wrapper = mount(
      <Harness {...props({ currentLegMode: 'BUS', distanceToNextTurn: 50 })} />
    )
    now += FOLLOW_ENGAGE_DELAY_MS + 10
    wrapper.setProps({ currentPosition: position(44.9414, T0 + 2000) })
    expect(mockMap.cameraForBounds).not.toHaveBeenCalled()
    expect(mockSources).not.toContain('go-mode-turn')
  })

  it('draws nothing and turns nothing after arrival', () => {
    const wrapper = mount(
      <Harness {...props({ arrived: true, distanceToNextTurn: 50 })} />
    )
    now += FOLLOW_ENGAGE_DELAY_MS + 10
    wrapper.setProps({ currentPosition: position(44.9414, T0 + 2000) })
    expect(mockMap.cameraForBounds).not.toHaveBeenCalled()
    expect(mockSources).not.toContain('go-mode-turn')
  })
})
