import { encode } from '@mapbox/polyline'

import '../../test-utils/mock-window-url'
import { handlePositionUpdate } from '../../../lib/actions/go-mode'
import {
  hasPlaceableCoords,
  isUsableFix
} from '../../../lib/util/go-mode/position-source'
import { recordedSessionEvents } from '../../test-utils/mock-data/debug-log'
import { restoreDateNowBehavior, setTestTime } from '../../test-utils'
import goModeReducer from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchRerouteSnapshotPlan: jest.fn(() => () => Promise.resolve(null)),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve(null))
}))

/**
 * Backlog 75.1, the entry-point half. Chaos agent C26 (2026-10-29,
 * `chaos/s3b-walk-pathology.js`): a live `BICYCLE>BUS:2>BICYCLE` trip on its
 * 4 534 m access leg; the last good fix 44.92145,-93.27796 (accuracy 10), then
 * one fix `{latitude: NaN, longitude: NaN, accuracy: 8}` 500 ms later through
 * `handlePositionUpdate` — the thunk the native watcher, the browser poll, the
 * GPS sim and trip replay all dispatch. On otprr main 3a7050816 it was stored
 * as `tracking.lastPosition` and the map threw on it. The other pathologies the
 * same run injected — heading NaN with speed null, 1400 m accuracy — were
 * handled downstream and must still be let through.
 */

const NOW = 1793252842259
const ORIGIN: [number, number] = [44.92145, -93.27796]
const DEST: [number, number] = [44.95911, -93.28276]

const itinerary = {
  duration: 1080,
  endTime: NOW + 1080000,
  legs: [
    {
      distance: 4534,
      duration: 1080,
      endTime: NOW + 1080000,
      from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Test origin' },
      legGeometry: { points: encode([ORIGIN, DEST]) },
      mode: 'BICYCLE',
      startTime: NOW,
      to: { lat: DEST[0], lon: DEST[1], name: '26th St E & Nicollet Ave' },
      transitLeg: false
    }
  ],
  startTime: NOW
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fix = (over: any = {}, timestamp = NOW): any => ({
  coords: {
    accuracy: 10,
    altitude: null,
    altitudeAccuracy: null,
    heading: 0,
    latitude: ORIGIN[0],
    longitude: ORIGIN[1],
    speed: 5,
    ...over
  },
  timestamp
})

const initial = goModeReducer(undefined, { type: '@@INIT' })

const liveTrip = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let goModeState: any = {
    ...initial,
    activeItinerary: itinerary,
    isActive: true
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    goModeState = goModeReducer(goModeState, action)
    return action
  }
  return {
    actions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    feed: (position: any) => dispatch(handlePositionUpdate(position)),
    goMode: () => goModeState
  }
}

describe('handlePositionUpdate turns away a fix it cannot use (75.1)', () => {
  beforeEach(() => {
    setTestTime(NOW)
  })
  afterEach(restoreDateNowBehavior)

  // FIRST in the file on purpose: the count is per page load (module state),
  // and this is the page load's first refusal.
  it('says so in the diagnostics stream — the first, then one a minute of them', () => {
    recordedSessionEvents.length = 0
    const trip = liveTrip()
    for (let i = 0; i < 60; i++) {
      trip.feed(fix({ latitude: NaN, longitude: NaN }, NOW + i * 1000))
    }
    expect(recordedSessionEvents).toEqual([
      {
        accuracy: '10',
        count: 1,
        event: 'position-rejected',
        latitude: 'NaN',
        longitude: 'NaN',
        source: null
      },
      expect.objectContaining({ count: 60, event: 'position-rejected' })
    ])
  })

  it('the C26 NaN fix never becomes tracking.lastPosition', () => {
    const trip = liveTrip()
    trip.feed(fix())
    const good = trip.goMode().tracking.lastPosition
    expect(good.coords.latitude).toBe(ORIGIN[0])
    const before = trip.actions.length

    trip.feed(fix({ accuracy: 8, latitude: NaN, longitude: NaN }, NOW + 500))

    // Before: UPDATE_POSITION with NaN coords, then a route match on them.
    expect(trip.actions.slice(before).map((a) => a.type)).toEqual([])
    expect(trip.goMode().tracking.lastPosition).toBe(good)
  })

  it.each([
    ['latitude only', { latitude: NaN }],
    ['longitude Infinity', { longitude: Infinity }],
    ['latitude past the pole', { latitude: 91 }],
    ['accuracy NaN', { accuracy: NaN }],
    ['accuracy negative', { accuracy: -1 }]
  ])('refuses %s', (_label, over) => {
    const trip = liveTrip()
    trip.feed(fix(over))
    expect(trip.actions).toEqual([])
    expect(trip.goMode().tracking.lastPosition).toBeNull()
  })

  it('still takes the pathologies C26 saw handled: heading NaN + speed null, 1400 m accuracy', () => {
    const trip = liveTrip()
    trip.feed(fix({ heading: NaN, speed: null }))
    expect(trip.goMode().tracking.lastPosition.coords.latitude).toBe(ORIGIN[0])
    trip.feed(fix({ accuracy: 1400 }, NOW + 500))
    expect(trip.goMode().tracking.lastPosition.coords.accuracy).toBe(1400)
  })
})

describe('the predicates', () => {
  it('places finite, in-range coordinates and nothing else', () => {
    expect(hasPlaceableCoords(fix())).toBe(true)
    expect(hasPlaceableCoords(fix({ latitude: NaN }))).toBe(false)
    expect(hasPlaceableCoords(fix({ longitude: 181 }))).toBe(false)
    expect(hasPlaceableCoords(null)).toBe(false)
    // A JSON round trip turns NaN into null — a restored fix must not read as 0,0.
    expect(hasPlaceableCoords(fix({ latitude: null, longitude: null }))).toBe(
      false
    )
  })

  it('needs a real accuracy on top for the pipeline', () => {
    expect(isUsableFix(fix())).toBe(true)
    expect(isUsableFix(fix({ accuracy: 0 }))).toBe(true)
    expect(isUsableFix(fix({ accuracy: null }))).toBe(false)
    expect(isUsableFix(fix({ accuracy: NaN }))).toBe(false)
  })
})
