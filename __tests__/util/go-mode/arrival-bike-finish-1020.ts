import FakeTimers from '@sinonjs/fake-timers'

import '../../test-utils/mock-window-url'
import { endGoMode, handlePositionUpdate } from '../../../lib/actions/go-mode'
import { hasArrivedAtDestination } from '../../../lib/util/go-mode/progress-calculator'
import fixture from '../../../lib/util/go-mode/replay/fixtures/slices/ride-1020-0907-arrival-slice.json'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchRerouteSnapshotPlan: jest.fn(() => () => Promise.resolve(null)),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve(null))
}))

/**
 * "You have arrived" 86 m short on a bike finish — 2026-10-20 10:10:20 local
 * (15:10:20Z), session `mvgr2jqp-b81j4g`, backlog 67.4. The ride ran bundle
 * 2026.1020.2, before 12.17's 40 m bike/walk veto (`hasArrivedAtDestination`).
 *
 * Replays a committed 15:09:30-15:11:00Z slice of `ride-1020-0907.json` (52
 * fixes) plus the itinerary the rider was on (the fourth swap: 94 -> Gold
 * Line -> a bike leg to 3510 Hopkins Place) through the real
 * `handlePositionUpdate` and reducer. MEASURE test: no app code changed.
 */

const initial = goMode(undefined, { type: '@@INIT' })

const LATCH_TICK_MS = Date.parse('2026-10-20T15:10:20Z')
const DEST = { lat: 45.00028, lon: -92.949399 }

const posOf = (g: any) =>
  ({
    coords: {
      accuracy: g.accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: g.heading,
      latitude: g.lat,
      longitude: g.lon,
      speed: g.speed
    },
    timestamp: g.tMs
  } as GeolocationPosition)

const makeStore = () => {
  let state: any = {
    ...initial,
    activeItinerary: (fixture as any).itinerary,
    isActive: true,
    tracking: { ...initial.tracking, isTracking: true }
  }
  const actions: { a: any; t: number }[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: state,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return undefined
    actions.push({ a: action, t: Date.now() })
    state = goMode(state, action)
    return action
  }
  return {
    actions: () => actions,
    getGoMode: () => state,
    run: (t: any) => t(dispatch, getState)
  }
}

const track: any[] = [...(fixture as any).gpsTrack].sort(
  (a, b) => a.tMs - b.tMs
)

const of = (store: ReturnType<typeof makeStore>, type: string) =>
  store.actions().filter(({ a }) => a.type === type)

describe('bike finish 86 m out (12.17 covers 67.4, 2026-10-20 10:10 ride)', () => {
  let clock: FakeTimers.InstalledClock
  let store: ReturnType<typeof makeStore>

  const feed = (g: any) => {
    clock.setSystemTime(g.tMs)
    store.run(handlePositionUpdate(posOf(g)))
  }
  const replayUntil = (untilMs: number) => {
    for (const g of track) {
      if (g.tMs > untilMs) break
      feed(g)
    }
  }

  beforeEach(() => {
    window.localStorage.clear()
    clock = FakeTimers.install({
      now: track[0].tMs,
      toFake: ['Date', 'setTimeout', 'clearTimeout']
    })
    store = makeStore()
  })

  afterEach(() => {
    try {
      if (store.getGoMode().isActive) store.run(endGoMode())
    } catch (e) {
      /* nothing to end */
    }
    clock.uninstall()
  })

  // The recorded tick (debug log, 15:10:20.097Z, bundle 2026.1020.2): overall
  // 99.887 %, final leg 99.582 %, 86.37 m out, finalLegMode absent, status
  // 'completed'. The replay on current main reads the final leg at 96.56 %
  // 'ahead' for the same fix, so the scalar jump itself does not reproduce;
  // this pins the decision on the recorded inputs instead.
  it('the recorded inputs latch with no mode (old bundle) but not on a bike finish', () => {
    // No mode = the old bundle: inside the 120 m cap, so the 99.5 % shortcut latches.
    expect(hasArrivedAtDestination(99.887, 86.369, 99.582, null)).toBe(true)
    expect(hasArrivedAtDestination(99.887, 86.369, 99.582, 'BICYCLE')).toBe(
      false
    )
    expect(hasArrivedAtDestination(99.887, 86.369, 99.582, 'WALK')).toBe(false)
  })

  it('the slice holds the 10:10:20 fix, 86 m out', () => {
    const g = track.find((x) => x.tMs === LATCH_TICK_MS)
    expect(g).toBeTruthy()
    expect(track[0].tMs).toBe(Date.parse('2026-10-20T15:09:30Z'))
  })

  it('does not latch at 10:10:20/21 and never arms the 75 m minute', () => {
    replayUntil(Date.parse('2026-10-20T15:10:30Z'))
    const atLatch = of(store, 'UPDATE_PROGRESS').filter(
      ({ t }) => t >= LATCH_TICK_MS && t <= LATCH_TICK_MS + 1000
    )
    expect(atLatch.length).toBeGreaterThan(0)
    const p = atLatch[atLatch.length - 1].a.payload
    expect(p.finalLegMode).toBe('BICYCLE')
    expect(p.distanceToDestination).toBeCloseTo(86.4, 0)
    expect(p.status).not.toBe('completed')
    expect(of(store, 'SET_ARRIVED')).toEqual([])
    expect(store.getGoMode().arrivedAt).toBeNull()
    expect(of(store, 'SET_NEAR_DESTINATION')).toEqual([])
    expect(store.getGoMode().nearDestination).toBeNull()
  })

  it('stays unarrived through the whole slice (no fix within 75 m)', () => {
    replayUntil(track[track.length - 1].tMs)
    expect(of(store, 'SET_ARRIVED')).toEqual([])
    expect(of(store, 'SET_NEAR_DESTINATION')).toEqual([])
    clock.tick(5 * 60_000)
    expect(of(store, 'SET_ARRIVED')).toEqual([])
    expect(
      of(store, 'ADD_NOTIFICATION').filter(
        ({ a }) => a.payload?.type === 'TRIP_COMPLETE'
      )
    ).toEqual([])
  })

  it('control: a fix ~25 m from the destination does arrive', () => {
    replayUntil(LATCH_TICK_MS)
    expect(of(store, 'SET_ARRIVED')).toEqual([])
    const t = LATCH_TICK_MS + 4000
    // 25 m due south of the door, on the approach side.
    feed({
      accuracy: 5,
      heading: 20,
      lat: DEST.lat - 25 / 111320,
      lon: DEST.lon,
      speed: 6,
      tMs: t
    })
    const last = of(store, 'UPDATE_PROGRESS').pop()!.a.payload
    expect(last.distanceToDestination).toBeLessThan(40)
    expect(of(store, 'SET_ARRIVED')).toHaveLength(1)
    expect(store.getGoMode().progress.status).toBe('completed')
  })
})
