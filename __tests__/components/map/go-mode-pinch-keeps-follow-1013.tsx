import '../../test-utils/mock-window-matchMedia'
import { IntlProvider } from 'react-intl'
import Enzyme, { mount } from 'enzyme'
import EnzymeReactAdapter from 'enzyme-adapter-react-16'
import polyline from '@mapbox/polyline'
import React from 'react'

import {
  FOLLOW_EASE_MS,
  FOLLOW_ENGAGE_DELAY_MS
} from '../../../lib/util/go-mode/follow-camera'
import {
  GESTURE_SETTLE_MS,
  GoModeMapOverlay
} from '../../../lib/components/go-mode/GoModeMap'

/**
 * Backlog 48.1. Ride 2026-10-12, first bike leg: SET_MAP_FOLLOW false at
 * 16:58:20 / :45 / :49 / 16:59:17 with the rider's arrow taps between, and
 * the rider's note "When is biking and I zoom out it cancels the auto
 * center. Do not cancel unless I press the arrow button".
 *
 * Measured on maplibre-gl 5.6.1 (headless Chrome, CDP touch events): a
 * lopsided pinch fires `dragstart` with 2 touches beside `zoomstart`, and a
 * pinch whose first finger slid before the second landed fires `dragstart`
 * with ONE touch. The map now judges each touch gesture when the last finger
 * lifts: any gesture that ever had 2+ fingers keeps follow; a one-finger drag
 * drops it (Q4, default A).
 */

type Handler = (e?: unknown) => void
const mapHandlers: Record<string, Handler[]> = {}
const domHandlers: Record<string, Handler[]> = {}
let zoom = 15
let moving = false
const add = (bag: Record<string, Handler[]>) => (ev: string, fn: Handler) => {
  bag[ev] = [...(bag[ev] || []), fn]
}
const remove =
  (bag: Record<string, Handler[]>) => (ev: string, fn: Handler) => {
    bag[ev] = (bag[ev] || []).filter((h) => h !== fn)
  }
const mockContainer = {
  addEventListener: jest.fn(add(domHandlers)),
  removeEventListener: jest.fn(remove(domHandlers))
}
// The 5.6.1 render task queue's shape, so the render guard (59.1) installs.
const renderQueue = {
  _cleared: false,
  _currentlyRunning: false as false | unknown[],
  _queue: [] as { callback: (t: number) => void }[],
  add(callback: (t: number) => void) {
    this._queue.push({ callback })
    return this._queue.length
  },
  run(t = 0) {
    if (this._currentlyRunning) throw new Error('already running')
    const queue = (this._currentlyRunning = this._queue)
    this._queue = []
    queue.forEach((task) => task.callback(t))
    this._currentlyRunning = false
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMap: any = {
  _renderTaskQueue: renderQueue,
  easeTo: jest.fn(),
  fitBounds: jest.fn(),
  getCanvasContainer: () => mockContainer,
  getZoom: () => zoom,
  isMoving: () => moving,
  off: jest.fn(remove(mapHandlers)),
  on: jest.fn(add(mapHandlers)),
  once: jest.fn(add(mapHandlers)),
  triggerRepaint: jest.fn()
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

const fire = (bag: Record<string, Handler[]>, ev: string, e?: unknown) =>
  (bag[ev] || []).slice().forEach((h) => h(e))
const touch = (type: string, fingers: number) =>
  fire(domHandlers, type, { touches: { length: fingers }, type })
// What MapLibre hands its camera events: the DOM event that drove them.
const mapEvent = (type: string, fingers: number) => ({
  originalEvent: { touches: { length: fingers }, type }
})

const A: [number, number] = [44.94, -93.29]
const B: [number, number] = [44.95, -93.29]
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
const position = (lat: number, t: number) =>
  ({
    coords: { accuracy: 8, latitude: lat, longitude: -93.29 },
    timestamp: t
  } as unknown as GeolocationPosition)

const T0 = 1_791_842_300_000
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Harness = (p: any) => (
  <IntlProvider locale="en-US" onError={() => undefined}>
    <GoModeMapOverlay {...p} />
  </IntlProvider>
)

describe('components > go-mode map > a pinch keeps follow (48.1)', () => {
  let now = T0
  const onSetFollow = jest.fn()
  const onFollowGesture = jest.fn()
  const onRenderRecovered = jest.fn()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = (over: any = {}) => ({
    activeLegIndex: null,
    currentLegMode: 'BICYCLE',
    currentPosition: position(44.941, T0),
    followUser: true,
    onFollowGesture,
    onRenderRecovered,
    onSetFollow,
    onToggleFollow: () => undefined,
    routeGeoJson,
    ...over
  })
  // Mount, let the overview fit land, and have the follow camera accept a
  // fix — the rider the camera re-centres on after a pinch.
  const mountFollowing = () => {
    const wrapper = mount(<Harness {...props()} />)
    now += FOLLOW_ENGAGE_DELAY_MS + 10
    wrapper.setProps({ currentPosition: position(44.9412, now) })
    expect(mockMap.easeTo).toHaveBeenCalledTimes(1)
    mockMap.easeTo.mockClear()
    return wrapper
  }

  beforeEach(() => {
    jest.useFakeTimers()
    now = T0
    zoom = 15
    moving = false
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    Object.keys(mapHandlers).forEach((k) => delete mapHandlers[k])
    Object.keys(domHandlers).forEach((k) => delete domHandlers[k])
    jest.clearAllMocks()
    mockMap.easeTo.mockReset()
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('a lopsided pinch (dragstart with 2 touches + zoom) keeps follow and re-centres', () => {
    const wrapper = mountFollowing()
    touch('touchstart', 1)
    touch('touchstart', 2)
    fire(mapHandlers, 'dragstart', mapEvent('touchmove', 2))
    fire(mapHandlers, 'zoomstart', mapEvent('touchmove', 2))
    zoom = 13.2
    // A GPS fix while the fingers are down: the follow ease waits.
    now += 1000
    wrapper.setProps({ currentPosition: position(44.9414, now) })
    expect(mockMap.easeTo).not.toHaveBeenCalled()
    touch('touchend', 1)
    touch('touchend', 0)
    jest.advanceTimersByTime(GESTURE_SETTLE_MS)

    expect(onSetFollow).not.toHaveBeenCalled()
    expect(onFollowGesture).toHaveBeenCalledTimes(1)
    expect(onFollowGesture).toHaveBeenCalledWith({
      followKept: true,
      handler: 'drag',
      maxTouches: 2,
      touches: 2,
      zoomDelta: -1.8
    })
    // Back on the rider (the last fix the camera took) at the pinched zoom.
    expect(mockMap.easeTo).toHaveBeenCalledTimes(1)
    expect(mockMap.easeTo).toHaveBeenCalledWith({
      center: [-93.29, 44.9412],
      duration: FOLLOW_EASE_MS
    })
    // The next fix follows again, without resetting the zoom.
    now += 1000
    wrapper.setProps({ currentPosition: position(44.9416, now) })
    expect(mockMap.easeTo).toHaveBeenCalledTimes(2)
    expect(mockMap.easeTo.mock.calls[1][0].zoom).toBeUndefined()
  })

  it('a pinch whose first finger slid first (dragstart with ONE touch) still keeps follow', () => {
    mountFollowing()
    touch('touchstart', 1)
    fire(mapHandlers, 'dragstart', mapEvent('touchmove', 1))
    touch('touchstart', 2)
    fire(mapHandlers, 'zoomstart', mapEvent('touchmove', 2))
    zoom = 16.6
    touch('touchend', 1)
    touch('touchend', 0)
    jest.advanceTimersByTime(GESTURE_SETTLE_MS)
    expect(onSetFollow).not.toHaveBeenCalled()
    expect(onFollowGesture).toHaveBeenCalledWith(
      expect.objectContaining({
        followKept: true,
        handler: 'drag',
        maxTouches: 2,
        touches: 1
      })
    )
  })

  it('waits for a pinch inertia to finish before re-centring', () => {
    mountFollowing()
    touch('touchstart', 2)
    fire(mapHandlers, 'zoomstart', mapEvent('touchmove', 2))
    touch('touchend', 0)
    moving = true
    jest.advanceTimersByTime(GESTURE_SETTLE_MS)
    expect(mockMap.easeTo).not.toHaveBeenCalled()
    moving = false
    fire(mapHandlers, 'moveend')
    // Never from inside moveend itself (59.1): on its own stack, right after.
    expect(mockMap.easeTo).not.toHaveBeenCalled()
    jest.advanceTimersByTime(0)
    expect(mockMap.easeTo).toHaveBeenCalledTimes(1)
    expect(onFollowGesture).toHaveBeenCalledWith(
      expect.objectContaining({ followKept: true, handler: 'zoom' })
    )
  })

  // 59.1: ride 2026-10-19 08:47:35.972 pinch settle with the inertia still
  // running, 08:47:36.043 GPS fix. The follow ease stops the inertia, and
  // maplibre fires moveend synchronously from inside that easeTo — the old
  // `once('moveend', recentre)` then started a second easeTo nested in the
  // first, leaving an orphan ease frame that later froze the map.
  const pinchStillMoving = () => {
    touch('touchstart', 2)
    fire(mapHandlers, 'zoomstart', mapEvent('touchmove', 2))
    touch('touchend', 0)
    moving = true
    jest.advanceTimersByTime(GESTURE_SETTLE_MS)
    expect(mockMap.easeTo).not.toHaveBeenCalled()
  }
  // easeTo the way maplibre does it: stopping a running ease fires moveend
  // before the new ease starts, all inside the call.
  let easeDepth = 0
  let maxEaseDepth = 0
  const easeLikeMaplibre = () =>
    mockMap.easeTo.mockImplementation(() => {
      easeDepth += 1
      maxEaseDepth = Math.max(maxEaseDepth, easeDepth)
      if (moving) {
        moving = false
        fire(mapHandlers, 'moveend')
      }
      moving = true
      easeDepth -= 1
    })

  it('a follow ease that ends the pinch inertia never nests a re-centre inside it (59.1)', () => {
    const wrapper = mountFollowing()
    easeDepth = 0
    maxEaseDepth = 0
    easeLikeMaplibre()
    pinchStillMoving()
    now += 71
    wrapper.setProps({ currentPosition: position(44.9414, now) })
    expect(mockMap.easeTo).toHaveBeenCalledTimes(1)
    expect(maxEaseDepth).toBe(1)
    // The follow ease already centred on the rider; the pending re-centre
    // is dropped rather than run after it.
    moving = false
    jest.advanceTimersByTime(1000)
    fire(mapHandlers, 'moveend')
    jest.advanceTimersByTime(1000)
    expect(mockMap.easeTo).toHaveBeenCalledTimes(1)
    // The follow ease, sized to its pixels since 75.20 (~13 px here).
    expect(mockMap.easeTo).toHaveBeenCalledWith({
      center: [-93.29, 44.9414],
      duration: expect.any(Number)
    })
  })

  it('a new touch cancels a re-centre still waiting on the last pinch', () => {
    mountFollowing()
    pinchStillMoving()
    touch('touchstart', 1)
    moving = false
    fire(mapHandlers, 'moveend')
    jest.advanceTimersByTime(0)
    expect(mockMap.easeTo).not.toHaveBeenCalled()
  })

  it('waits out another camera move before re-centring', () => {
    mountFollowing()
    pinchStillMoving()
    // moveend of the inertia, but something else (a fit) is already moving.
    fire(mapHandlers, 'moveend')
    jest.advanceTimersByTime(0)
    expect(mockMap.easeTo).not.toHaveBeenCalled()
    moving = false
    fire(mapHandlers, 'moveend')
    jest.advanceTimersByTime(0)
    expect(mockMap.easeTo).toHaveBeenCalledTimes(1)
  })

  it('records a caught render-frame throw instead of freezing (59.1)', () => {
    mountFollowing()
    mockMap._renderTaskQueue.add(() => {
      throw new TypeError('this._onEaseFrame is not a function')
    })
    expect(() => mockMap._renderTaskQueue.run(0)).not.toThrow()
    expect(mockMap._renderTaskQueue._currentlyRunning).toBe(false)
    expect(mockMap.triggerRepaint).toHaveBeenCalled()
    expect(onRenderRecovered).toHaveBeenCalledWith({
      message: 'this._onEaseFrame is not a function',
      suppressed: 0
    })
  })

  it('a one-finger drag still stops following, once the finger lifts (Q4 A)', () => {
    mountFollowing()
    touch('touchstart', 1)
    fire(mapHandlers, 'dragstart', mapEvent('touchmove', 1))
    expect(onSetFollow).not.toHaveBeenCalled()
    touch('touchend', 0)
    // A flick's dragstart can arrive after the lift; it joins the gesture.
    fire(mapHandlers, 'dragstart', mapEvent('touchmove', 1))
    jest.advanceTimersByTime(GESTURE_SETTLE_MS)
    expect(onSetFollow).toHaveBeenCalledTimes(1)
    expect(onSetFollow).toHaveBeenCalledWith(false)
    expect(onFollowGesture).toHaveBeenCalledWith({
      followKept: false,
      handler: 'drag',
      maxTouches: 1,
      touches: 1,
      zoomDelta: 0
    })
    expect(mockMap.easeTo).not.toHaveBeenCalled()
  })

  it('a two-finger twist and its inertia keep follow', () => {
    mountFollowing()
    touch('touchstart', 1)
    touch('touchstart', 2)
    fire(mapHandlers, 'rotatestart', mapEvent('touchmove', 2))
    touch('touchend', 1)
    touch('touchend', 0)
    jest.advanceTimersByTime(GESTURE_SETTLE_MS)
    // Inertia after the verdict: MapLibre's second rotatestart.
    fire(mapHandlers, 'rotatestart', mapEvent('touchend', 1))
    expect(onSetFollow).not.toHaveBeenCalled()
    expect(onFollowGesture).toHaveBeenCalledTimes(1)
  })

  it('a programmatic rotate (no originalEvent) does nothing', () => {
    mountFollowing()
    fire(mapHandlers, 'rotatestart', {})
    fire(mapHandlers, 'zoomstart', {})
    jest.advanceTimersByTime(GESTURE_SETTLE_MS)
    expect(onSetFollow).not.toHaveBeenCalled()
    expect(onFollowGesture).not.toHaveBeenCalled()
  })

  it('a mouse drag or rotate (desktop) stops following at once, as before', () => {
    mountFollowing()
    fire(mapHandlers, 'dragstart', { originalEvent: { type: 'mousemove' } })
    expect(onSetFollow).toHaveBeenCalledWith(false)
    onSetFollow.mockClear()
    fire(mapHandlers, 'rotatestart', { originalEvent: { type: 'mousemove' } })
    expect(onSetFollow).toHaveBeenCalledWith(false)
  })

  it('records nothing for a gesture made while not following', () => {
    mount(<Harness {...props({ followUser: false })} />)
    touch('touchstart', 1)
    fire(mapHandlers, 'dragstart', mapEvent('touchmove', 1))
    touch('touchend', 0)
    jest.advanceTimersByTime(GESTURE_SETTLE_MS)
    expect(onFollowGesture).not.toHaveBeenCalled()
    expect(onSetFollow).not.toHaveBeenCalled()
  })

  it('a leg tap in the trip sheet still fits the leg and stops following', () => {
    const wrapper = mountFollowing()
    wrapper.setProps({ activeLegIndex: 0 })
    expect(mockMap.fitBounds).toHaveBeenLastCalledWith(expect.any(Array), {
      duration: 600,
      maxZoom: 16,
      padding: 40
    })
    expect(onSetFollow).toHaveBeenCalledWith(false)
  })

  it('removes every listener it adds (8.3: reuseMaps keeps the map across remounts)', () => {
    const first = mount(<Harness {...props()} />)
    first.unmount()
    const second = mount(<Harness {...props()} />)
    second.unmount()
    // Same function off() as on(), per event, so remounts never stack.
    const pairs = (on: jest.Mock, off: jest.Mock) => {
      const key = (c: unknown[]) => c[0]
      expect(on.mock.calls.map(key).sort()).toEqual(
        off.mock.calls
          .filter((c) => c[0] !== 'moveend')
          .map(key)
          .sort()
      )
      on.mock.calls.forEach(([ev, fn]) =>
        expect(off).toHaveBeenCalledWith(ev, fn)
      )
    }
    pairs(mockMap.on, mockMap.off)
    pairs(mockContainer.addEventListener, mockContainer.removeEventListener)
    Object.values(mapHandlers).forEach((hs) => expect(hs).toHaveLength(0))
    Object.values(domHandlers).forEach((hs) => expect(hs).toHaveLength(0))
  })
})
