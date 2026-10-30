import '../../test-utils/mock-window-matchMedia'
import { IntlProvider } from 'react-intl'
import Enzyme, { mount } from 'enzyme'
import EnzymeReactAdapter from 'enzyme-adapter-react-16'
import polyline from '@mapbox/polyline'
import React from 'react'

import {
  FOLLOW_EASE_MS,
  FOLLOW_ENGAGE_DELAY_MS,
  FOLLOW_ZOOM_TRANSIT
} from '../../../lib/util/go-mode/follow-camera'
import { GoModeMapOverlay } from '../../../lib/components/go-mode/GoModeMap'

/**
 * Backlog 75.20, mounted: what the Go Mode map asks MapLibre for, fix by fix,
 * on a bus at the transit zoom. Each frame of an ease is a full map render;
 * the follow used to ease FOLLOW_EASE_MS (800 ms) on every ~1 s fix, so the
 * map drew on ~every animation frame of a ride (169 renders in 5 s replaying
 * gold-74-1105, 145 of them mid-ease).
 */

let zoom = FOLLOW_ZOOM_TRANSIT
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMap: any = {
  easeTo: jest.fn(),
  fitBounds: jest.fn(),
  getZoom: () => zoom,
  off: jest.fn(),
  on: jest.fn()
}

jest.mock('react-map-gl/maplibre', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const react = jest.requireActual('react')
  const actual = jest.requireActual('react-map-gl/maplibre')
  return {
    ...actual,
    Layer: () => null,
    Marker: () => null,
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

// gold-74-1105's first fixes: METRO Gold Line eastbound at ~10 m/s.
const A: [number, number] = [44.9490724, -92.9846168]
const B: [number, number] = [44.9510724, -92.9946168]
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
const T0 = 1789315508999
// 1.5e-4 degree of longitude is ~11.8 m at this latitude: the ride's median
// step between fixes (12.0 m).
const STEP = 1.5e-4
const position = (i: number, t: number, speed: number | null = 10) =>
  ({
    coords: {
      accuracy: 3.5,
      latitude: A[0],
      longitude: A[1] - i * STEP,
      speed
    },
    timestamp: t
  } as unknown as GeolocationPosition)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Harness = (p: any) => (
  <IntlProvider locale="en-US" onError={() => undefined}>
    <GoModeMapOverlay {...p} />
  </IntlProvider>
)

describe('components > go-mode map > follow frames (75.20)', () => {
  let now = T0
  const mountFollowing = () => {
    const wrapper = mount(
      <Harness
        activeLegIndex={null}
        currentLegMode="BUS"
        currentPosition={position(0, now)}
        followUser
        onSetFollow={() => undefined}
        onToggleFollow={() => undefined}
        routeGeoJson={routeGeoJson}
      />
    )
    // The overview fit lands, then the first fix engages at the leg zoom.
    now += FOLLOW_ENGAGE_DELAY_MS + 10
    wrapper.setProps({ currentPosition: position(1, now) })
    expect(mockMap.easeTo).toHaveBeenCalledTimes(1)
    expect(mockMap.easeTo.mock.calls[0][0]).toMatchObject({
      duration: FOLLOW_EASE_MS,
      zoom: FOLLOW_ZOOM_TRANSIT
    })
    mockMap.easeTo.mockClear()
    return wrapper
  }

  beforeEach(() => {
    now = T0
    zoom = FOLLOW_ZOOM_TRANSIT
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    mockMap.easeTo.mockReset()
    mockMap.fitBounds.mockReset()
  })
  afterEach(() => jest.restoreAllMocks())

  it('eases a moving bus for the pixels it moves, not a fixed 800 ms', () => {
    // FAILS BEFORE: every follow ease was { duration: 800 }.
    const wrapper = mountFollowing()
    for (let i = 2; i <= 6; i++) {
      now += 1000
      wrapper.setProps({ currentPosition: position(i, now) })
    }
    const durations = mockMap.easeTo.mock.calls.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => c[0].duration
    )
    // Five fixes ~11.8 m apart = ~3.5 CSS px at zoom 14: ~175 ms each.
    expect(durations).toHaveLength(5)
    durations.forEach((ms: number) => {
      expect(ms).toBeGreaterThan(150)
      expect(ms).toBeLessThan(220)
    })
    // Still a follow: centred on each fix, the rider's zoom left alone.
    const last = mockMap.easeTo.mock.calls[4][0]
    expect(last.center).toEqual([A[1] - 6 * STEP, A[0]])
    expect(last.zoom).toBeUndefined()
  })

  it('does not ease while the fix says the bus is standing', () => {
    // FAILS BEFORE: ~6 m of wander past the 4 m dead-band eased 800 ms.
    const wrapper = mountFollowing()
    now += 1000
    wrapper.setProps({
      currentPosition: {
        coords: {
          accuracy: 3.5,
          latitude: A[0] + 0.000054,
          longitude: A[1] - STEP,
          speed: 0.1
        },
        timestamp: now
      }
    })
    expect(mockMap.easeTo).not.toHaveBeenCalled()
    // A minute at the stop, every fix inside the dead-band: no ease either —
    // a long wait is not a GPS gap.
    for (let s = 0; s < 60; s++) {
      now += 1000
      wrapper.setProps({ currentPosition: position(1, now, 0) })
    }
    expect(mockMap.easeTo).not.toHaveBeenCalled()
    // Moving again: followed on the first fix.
    now += 1000
    wrapper.setProps({ currentPosition: position(3, now) })
    expect(mockMap.easeTo).toHaveBeenCalledTimes(1)
  })

  it('skips a pan too small to draw at a pinched-out zoom, then catches up', () => {
    // FAILS BEFORE: every ~12 m fix eased, at any zoom.
    const wrapper = mountFollowing()
    // Zoom 10: one CSS px is ~54 m; a ~12 m step is a fifth of a pixel.
    zoom = 10
    for (let i = 2; i <= 5; i++) {
      now += 1000
      wrapper.setProps({ currentPosition: position(i, now) })
    }
    // Four steps from the last accepted fix: ~47 m, 0.87 px.
    expect(mockMap.easeTo).not.toHaveBeenCalled()
    // ...and the drift is kept, not lost: the fifth passes a pixel and moves.
    now += 1000
    wrapper.setProps({ currentPosition: position(6, now) })
    expect(mockMap.easeTo).toHaveBeenCalledTimes(1)
    expect(mockMap.easeTo.mock.calls[0][0].center).toEqual([
      A[1] - 6 * STEP,
      A[0]
    ])
  })
})
