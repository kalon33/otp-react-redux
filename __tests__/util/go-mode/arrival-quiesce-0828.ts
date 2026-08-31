import { encode } from '@mapbox/polyline'

import {
  captureRerouteSnapshot,
  handlePositionUpdate
} from '../../../lib/actions/go-mode'
import { fetchRerouteSnapshotPlan } from '../../../lib/actions/apiV2'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchRerouteSnapshotPlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
    modeSettings: [],
    numItineraries: 5
  }))
}))

const initial = goMode(undefined, { type: '@@INIT' })

/**
 * 2026-08-28 evening ride (session mtdh67f3-0z5p24): the app said "You have
 * arrived" at 22:08:37 and kept running at full rate until the rider ended the
 * trip by hand 88 minutes later. 48% of the ride's telemetry (16,740 of 34,784
 * actions) was recorded after the arrival card went up — the tick's own quiesce
 * held (vehicle matching, live-times and realtime positions all dropped to
 * exactly 0), but the reroute-snapshot interval and the GPS funnel live outside
 * it and never heard about the arrival.
 */

// A one-leg walk whose geometry ends on the destination, so a fix at the end of
// the line reads as arrived without any transit machinery in the way.
const ORIGIN: [number, number] = [44.95, -93.29]
const DEST: [number, number] = [44.98, -93.27]

const walkItinerary = () => ({
  duration: 1800,
  endTime: 0,
  legs: [
    {
      distance: 3800,
      duration: 1800,
      endTime: 0,
      from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Origin' },
      legGeometry: { points: encode([ORIGIN, DEST]) },
      mode: 'WALK',
      startTime: 0,
      to: { lat: DEST[0], lon: DEST[1], name: 'Destination' },
      transitLeg: false
    }
  ],
  startTime: 0
})

const fixAt = (
  [lat, lon]: [number, number],
  timestamp: number
): GeolocationPosition =>
  ({
    coords: {
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: lat,
      longitude: lon,
      speed: 1.2
    },
    timestamp
  } as GeolocationPosition)

/**
 * Minimal store: the real goMode reducer behind a hand-rolled dispatch, and a
 * `run` that invokes the thunk under test against it. Nested thunks are
 * RECORDED rather than run unless `runThunks` says otherwise —
 * handlePositionUpdate dispatches several (live-times refresh, leg advance,
 * poll restart) and none of them is what is under test here.
 */
const makeStore = (goModeOverrides: any = {}, runThunks = false) => {
  let goModeState: any = {
    ...initial,
    activeItinerary: walkItinerary(),
    isActive: true,
    tracking: {
      ...initial.tracking,
      lastPosition: fixAt(ORIGIN, 0)
    },
    ...goModeOverrides
  }
  const actions: any[] = []
  const thunks: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') {
      thunks.push(action)
      return runThunks ? action(dispatch, getState) : undefined
    }
    actions.push(action)
    goModeState = goMode(goModeState, action)
    return action
  }
  return {
    dispatch,
    getGoMode: () => goModeState,
    getState,
    run: (thunk: any) => thunk(dispatch, getState),
    types: () => actions.map((a) => a.type)
  }
}

describe('arrival quiesce — the trip that would not end (2026-08-28)', () => {
  const snapshotPlan = fetchRerouteSnapshotPlan as jest.Mock

  beforeEach(() => {
    snapshotPlan.mockReset()
    snapshotPlan.mockReturnValue(() =>
      Promise.resolve({ query: 'q', response: {}, variables: {} })
    )
  })

  describe('captureRerouteSnapshot', () => {
    it('still fires a plan() while the trip is running', async () => {
      const store = makeStore({}, true)
      await store.run(captureRerouteSnapshot())
      expect(snapshotPlan).toHaveBeenCalledTimes(1)
      expect(store.types()).toContain('REROUTE_SNAPSHOT')
    })

    it('fires no plan() once the rider has arrived — 58 of them came from a parked phone', async () => {
      const store = makeStore({ arrivedAt: 1_756_000_000_000 }, true)
      await store.run(captureRerouteSnapshot())
      expect(snapshotPlan).not.toHaveBeenCalled()
      expect(store.types()).not.toContain('REROUTE_SNAPSHOT')
    })
  })

  describe('the arrival tick', () => {
    it('tapers the GPS interval to the idle cadence as it marks arrival', () => {
      const store = makeStore()
      store.run(handlePositionUpdate(fixAt(DEST, 1_756_100_000_000)))

      expect(store.getGoMode().arrivedAt).not.toBeNull()
      expect(store.types()).toContain('UPDATE_TRACKING_INTERVAL')
      expect(store.getGoMode().tracking.interval).toBe(30000)
    })
  })

  describe('the GPS funnel after arrival', () => {
    // Inside the iOS shell the native watcher streams at ~1/s no matter what
    // UPDATE_TRACKING_INTERVAL says (native-gps.ts asks for distanceFilter: 0),
    // so the taper only becomes real where the fixes land.
    const base = 1_756_200_000_000

    it('drops fixes arriving faster than the idle cadence', () => {
      const store = makeStore({ arrivedAt: base })
      // First post-arrival fix is always taken — it seeds the gate.
      store.run(handlePositionUpdate(fixAt(DEST, base + 1000)))
      const afterFirst = store.types().length
      // Eight more at the native ~1 Hz cadence, all inside the 30 s window.
      for (let i = 2; i <= 9; i++) {
        store.run(handlePositionUpdate(fixAt(DEST, base + i * 1000)))
      }
      expect(store.types()).toHaveLength(afterFirst)
    })

    it('takes the next fix once the idle cadence has elapsed', () => {
      const store = makeStore({ arrivedAt: base })
      store.run(handlePositionUpdate(fixAt(DEST, base + 100_000)))
      const afterFirst = store.types().length
      store.run(handlePositionUpdate(fixAt(DEST, base + 101_000)))
      expect(store.types()).toHaveLength(afterFirst)
      store.run(handlePositionUpdate(fixAt(DEST, base + 131_000)))
      expect(store.types().slice(afterFirst)).toContain('UPDATE_POSITION')
    })
  })
})
