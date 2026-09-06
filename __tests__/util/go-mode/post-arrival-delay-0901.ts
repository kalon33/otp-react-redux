import FakeTimers from '@sinonjs/fake-timers'

import '../../test-utils/mock-window-url'
import {
  clearGoModeSession,
  loadGoModeSession,
  saveGoModeSession
} from '../../../lib/util/go-mode/session-persistence'
import { endGoMode, handlePositionUpdate } from '../../../lib/actions/go-mode'
import { getInitialState } from '../../../lib/reducers/create-otp-reducer'
import fixture from '../../../lib/util/go-mode/replay/fixtures/orange-bike-0823.json'
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
 * "`delay` counts wall clock forever after arrival", measured — 2026-09-01
 * ride 1, session `mtin0l9c-yieexg`, replayed from
 * `replay/fixtures/orange-bike-0823.json` through the real `handlePositionUpdate`
 * and the real reducer.
 *
 * The ride: a METRO Orange Line leg 13:26:27Z → 13:45:04Z, then a 1450 m bike
 * leg to 3322 Columbus Ave scheduled to end 13:51:45Z. The rider arrived at
 * 13:59:36.999Z and the phone went on reporting until 14:48:29Z — 48m52s and
 * 96 further fixes at the post-arrival 30 s cadence.
 *
 * TWO HALVES, and they behaved differently.
 *
 * 1. A LIVE arrival already held. Replaying the 921 fixes from the bike leg's
 *    start: `SET_ARRIVED 13:59:36.999Z`, one `UPDATE_TRACKING_INTERVAL {30000}`,
 *    six notifications ending in the single TRIP_COMPLETE, and 98 post-arrival
 *    `UPDATE_PROGRESS` actions every one of which carries
 *    delay = 495.98664868164065 s. One distinct value across 48m52s. Unfrozen
 *    the last of them would have read 3404 s — the card would have said
 *    "57 min late" about a rider who arrived 8 min late.
 *
 * 2. A RE-MOUNT did not. `progress` is GPS-derived state `session-persistence`
 *    deliberately omits, so a page load restored `arrivedAt` (cb453726) with no
 *    measurement beside it, and the freeze — which read the PREVIOUS tick's
 *    `progress.delay` — had nothing to carry. The first resumed tick re-measured
 *    against the wall clock and every tick after it froze THAT: with the page
 *    coming back 61 s after the arrival, 534.7056889648437 s for the remaining
 *    46 minutes, 38.72 s adrift of the arrival measurement and rising with the
 *    length of the gap. `ARRIVED_RESUME_GRACE_MS` bounds a one-way trip's error
 *    at ~5 min; a ROUND trip's session is measured against `leaveByMs` instead
 *    and legitimately outlives the outbound arrival by hours, so there it is
 *    unbounded.
 *
 * The fix is one fact travelling with the trip: `goMode.arrivedDelay`, recorded
 * by SET_ARRIVED and saved with the session, read by the tick ahead of
 * `progress.delay`.
 *
 * RULED OUT, by this same replay: the notifier and the funnel. The notification
 * pass fires TRIP_COMPLETE exactly once and nothing after it (e737da85 holds),
 * and no second `SET_ARRIVED` is ever dispatched across either half. Row 4.10's
 * funnel closure holds too — the resumed trip's 96 ticks arrive at exactly the
 * 30 s cadence, never the 1 Hz the native watcher is really delivering.
 */

const initial = goMode(undefined, { type: '@@INIT' })
const itinerary: any = (fixture as any).itinerary
const track: any[] = [...(fixture as any).gpsTrack].sort(
  (a, b) => a.tMs - b.tMs
)

/** From the moment the rider got off the bus — enough to warm the matcher. */
const SEGMENT = track.filter((g) => g.tMs >= itinerary.legs[1].startTime)

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

/** Real reducer, every action recorded, nested thunks dropped. */
const makeStore = (overrides: any = {}) => {
  let state: any = { ...initial, ...overrides }
  const actions: any[] = []
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
    actions.push(action)
    state = goMode(state, action)
    return action
  }
  return {
    actions: () => actions,
    getGoMode: () => state,
    run: (t: any) => t(dispatch, getState)
  }
}

/** Drive a run of recorded fixes through the tick, clock following the fix. */
const replay = (store: any, clock: any, fixes: any[]) => {
  for (const g of fixes) {
    clock.setSystemTime(g.tMs)
    store.run(handlePositionUpdate(posOf(g)))
  }
}

const progressRows = (store: any) =>
  store
    .actions()
    .filter((a: any) => a.type === 'UPDATE_PROGRESS')
    .map((a: any) => a.payload)

/**
 * The delay the arrival tick measured on this ride. Asserted as a literal
 * because it is the whole point: every post-arrival tick, on both sides of a
 * re-mount, must quote this number and no other.
 */
const ARRIVAL_DELAY_S = 495.98664868164065
const ARRIVED_AT = 1788271176999 // 2026-09-01T13:59:36.999Z
const LAST_FIX_MS = 1788274109000 // 2026-09-01T14:48:29.000Z

describe('post-arrival delay, replayed live (2026-09-01 ride 1)', () => {
  let clock: FakeTimers.InstalledClock
  let store: any
  let arrivalRowIndex = -1

  beforeAll(() => {
    window.localStorage.clear()
    clearGoModeSession()
    clock = FakeTimers.install({ now: SEGMENT[0].tMs, toFake: ['Date'] })
    store = makeStore({
      activeItinerary: itinerary,
      isActive: true,
      tracking: { ...initial.tracking, isTracking: true }
    })
    for (const g of SEGMENT) {
      clock.setSystemTime(g.tMs)
      const before = store.actions().length
      store.run(handlePositionUpdate(posOf(g)))
      if (
        arrivalRowIndex < 0 &&
        store
          .actions()
          .slice(before)
          .some((a: any) => a.type === 'SET_ARRIVED')
      ) {
        arrivalRowIndex =
          store
            .actions()
            .slice(0, store.actions().length)
            .filter((a: any) => a.type === 'UPDATE_PROGRESS').length - 1
      }
    }
  })

  afterAll(() => {
    clock?.uninstall()
  })

  it('replayed the whole ride: 921 recorded fixes, one arrival', () => {
    expect(SEGMENT).toHaveLength(921)
    expect(SEGMENT[SEGMENT.length - 1].tMs).toBe(LAST_FIX_MS)
    const arrivals = store
      .actions()
      .filter((a: any) => a.type === 'SET_ARRIVED')
    expect(arrivals).toHaveLength(1)
    expect(arrivals[0].payload).toBe(ARRIVED_AT)
    expect(store.getGoMode().arrivedAt).toBe(ARRIVED_AT)
  })

  it('records the delay measured at arrival, so it can outlive `progress`', () => {
    expect(store.getGoMode().arrivedDelay).toBe(ARRIVAL_DELAY_S)
  })

  it('holds that one number across every post-arrival tick — 48m52s of them', () => {
    const rows = progressRows(store)
    const post = rows.slice(arrivalRowIndex)
    // 98 ticks: the arrival tick plus the 97 that follow it.
    expect(post).toHaveLength(98)
    expect(Array.from(new Set(post.map((p: any) => p.delay)))).toEqual([
      ARRIVAL_DELAY_S
    ])
  })

  it('CONTROL: the schedule the wall clock would have measured against had moved 3404 s', () => {
    // Nothing frozen here — just the arithmetic the tick refuses to redo. The
    // rider is past the last leg's scheduled end, so a re-measurement is now
    // minus that end and nothing else.
    const scheduledEnd = itinerary.legs[itinerary.legs.length - 1].endTime
    expect(Math.round((LAST_FIX_MS - scheduledEnd) / 1000)).toBe(3404)
  })

  it('says "you have arrived" once, and says nothing after it', () => {
    const notifications = store
      .actions()
      .filter((a: any) => a.type === 'ADD_NOTIFICATION')
    expect(
      notifications.filter((a: any) => a.payload?.type === 'TRIP_COMPLETE')
    ).toHaveLength(1)
    // ...and it is the last thing the notifier said on this ride.
    expect(notifications[notifications.length - 1].payload.type).toBe(
      'TRIP_COMPLETE'
    )
  })

  it('tapers the GPS cadence once, at the arrival', () => {
    const intervals = store
      .actions()
      .filter((a: any) => a.type === 'UPDATE_TRACKING_INTERVAL')
      .map((a: any) => a.payload.interval)
    expect(intervals).toEqual([30000])
  })
})

/**
 * The re-mount, which is where the row's remainder actually lived. Same ride,
 * same recorded fixes: the page dies a second after the arrival tick and comes
 * back 61 s later, inside `ARRIVED_RESUME_GRACE_MS`.
 */
describe('post-arrival delay across a re-mount (2026-09-01 ride 1)', () => {
  let clock: FakeTimers.InstalledClock
  let restored: any
  /** The 96 recorded fixes the resumed page received. */
  let tail: any[]

  const LOAD_MS = ARRIVED_AT + 60_000

  beforeAll(() => {
    window.localStorage.clear()
    clearGoModeSession()
    clock = FakeTimers.install({ now: SEGMENT[0].tMs, toFake: ['Date'] })

    // Ride it to the arrival, the way the live half above does.
    const live = makeStore({
      activeItinerary: itinerary,
      isActive: true,
      tracking: { ...initial.tracking, isTracking: true }
    })
    replay(
      live,
      clock,
      SEGMENT.filter((g) => g.tMs <= ARRIVED_AT)
    )
    if (live.getGoMode().arrivedAt !== ARRIVED_AT) {
      throw new Error('replay did not reach the recorded arrival')
    }

    // The last save the dying page made.
    clock.setSystemTime(ARRIVED_AT + 1000)
    saveGoModeSession(live.getGoMode() as any)
    // Reset the module-level trip session, which is what a page load destroys.
    live.run(endGoMode())

    clock.setSystemTime(LOAD_MS)
    restored = (getInitialState({} as any) as any).goMode
    tail = SEGMENT.filter((g) => g.tMs >= LOAD_MS)
  })

  afterAll(() => {
    clock?.uninstall()
    clearGoModeSession()
  })

  it('saves the arrival measurement beside the arrival itself', () => {
    const saved = loadGoModeSession()
    expect(saved?.arrivedAt).toBe(ARRIVED_AT)
    expect(saved?.arrivedDelay).toBe(ARRIVAL_DELAY_S)
  })

  it('restores both, and still no `progress` — which is the whole difficulty', () => {
    expect(restored.arrivedAt).toBe(ARRIVED_AT)
    expect(restored.arrivedDelay).toBe(ARRIVAL_DELAY_S)
    expect(restored.progress).toBeNull()
  })

  it('quotes the arrival measurement from the FIRST resumed tick onward', () => {
    const store = makeStore(restored)
    replay(store, clock, tail)
    const rows = progressRows(store)
    // The recorded post-arrival stream, at the 30 s cadence the funnel imposes.
    expect(rows).toHaveLength(96)
    expect(Array.from(new Set(rows.map((p: any) => p.delay)))).toEqual([
      ARRIVAL_DELAY_S
    ])
    store.run(endGoMode())
  })

  it('re-derives no arrival and re-speaks nothing', () => {
    const store = makeStore(restored)
    replay(store, clock, tail)
    const types = store.actions().map((a: any) => a.type)
    expect(types).not.toContain('SET_ARRIVED')
    expect(types).not.toContain('ADD_NOTIFICATION')
    store.run(endGoMode())
  })

  it('CONTROL: with the measurement missing, the same ticks re-measure and freeze the wrong number', () => {
    // Exactly the state a re-mount used to come back in: the trip is over and
    // nothing says how late it ended. This is what produced 534.7 s.
    const store = makeStore({ ...restored, arrivedDelay: null })
    replay(store, clock, tail)
    const delays = Array.from(
      new Set(progressRows(store).map((p: any) => p.delay))
    )
    expect(delays).toEqual([534.7056889648437])
    expect((delays[0] as number) - ARRIVAL_DELAY_S).toBeCloseTo(38.72, 2)
    store.run(endGoMode())
  })
})

/**
 * The unbounded case. `ARRIVED_RESUME_GRACE_MS` caps a one-way trip's error at
 * five minutes, but a ROUND trip's session is measured against `leaveByMs`
 * instead (session-persistence.ts) precisely so it can survive the dwell at the
 * destination — which is routinely hours. A re-mount two hours into that dwell
 * is not an edge case; it is the feature working.
 */
describe('post-arrival delay on a resumed round trip', () => {
  let clock: FakeTimers.InstalledClock
  const RESUME_MS = ARRIVED_AT + 2 * 60 * 60 * 1000

  const parkedFix = (tMs: number) => {
    const last = SEGMENT[SEGMENT.length - 1]
    return { ...last, speed: 0, tMs }
  }

  beforeAll(() => {
    window.localStorage.clear()
    clearGoModeSession()
    clock = FakeTimers.install({ now: SEGMENT[0].tMs, toFake: ['Date'] })
  })

  afterAll(() => {
    clock?.uninstall()
    clearGoModeSession()
  })

  it('still quotes the arrival measurement two hours later, not the dwell', () => {
    const roundTrip = {
      destination: { lat: 44.94245, lon: -93.26422, name: 'Home' },
      leaveByMs: ARRIVED_AT + 3 * 60 * 60 * 1000,
      origin: { lat: 44.94861, lon: -93.27408, name: 'Origin' },
      plannedDepartMs: ARRIVED_AT + 3 * 60 * 60 * 1000,
      refreshedAtMs: null,
      returnItinerary: itinerary,
      stayMinutes: 180
    }

    clock.setSystemTime(ARRIVED_AT + 1000)
    saveGoModeSession({
      ...initial,
      activeItinerary: itinerary,
      arrivedAt: ARRIVED_AT,
      arrivedDelay: ARRIVAL_DELAY_S,
      isActive: true,
      roundTrip
    } as any)

    clock.setSystemTime(RESUME_MS)
    const restored = (getInitialState({} as any) as any).goMode
    expect(restored.arrivedAt).toBe(ARRIVED_AT)
    expect(restored.arrivedDelay).toBe(ARRIVAL_DELAY_S)

    const store = makeStore(restored)
    replay(store, clock, [
      parkedFix(RESUME_MS),
      parkedFix(RESUME_MS + 30_000),
      parkedFix(RESUME_MS + 60_000)
    ])
    const rows = progressRows(store)
    expect(rows.length).toBeGreaterThan(0)
    expect(Array.from(new Set(rows.map((p: any) => p.delay)))).toEqual([
      ARRIVAL_DELAY_S
    ])
    store.run(endGoMode())
  })
})
