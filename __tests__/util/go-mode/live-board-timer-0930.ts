import {
  endGoMode,
  handlePositionUpdate,
  startGoModeTracking
} from '../../../lib/actions/go-mode'
import {
  LIVE_BOARD_FIX_GAP_MS,
  LIVE_BOARD_TIMER_MS,
  shouldTimerPollLiveBoard
} from '../../../lib/util/go-mode/live-board-timer'
import fixture from '../../test-utils/mock-data/live-board-timer-0930.json'
import goModeReducer from '../../../lib/reducers/go-mode'

/**
 * Backlog 38.2 — the live board polls ran only when a GPS fix arrived.
 *
 * Session `muomy26h-g1zujp`, 2026-09-30, dev `2026.0930.1`: bike to the 1:904
 * bus at stop 1:53543, a platform wait under a station canopy. The boarding
 * stop was polled every ~20 s 16:59:10–17:06:04; then fixes stopped (a 54.6 s
 * gap from 17:06:08, the GPS watchdog's forced fixes at 17:07:03 and 17:08:03)
 * and so did the polls — the next two landed on those forced fixes. The rider,
 * 17:08:00: "live bus times lag a bit".
 *
 * The fixture beside this test (`test-utils/mock-data/live-board-timer-0930.json`)
 * is distilled by `live-board-timer-0930.py` from the uncommitted replay
 * fixture `ride-0930-1648.json`: the itinerary in force over the wait (the
 * 16:59:03 swap), every recorded fix 16:59:03–17:10:00, and the recorded stop
 * poll instants. Nothing is edited.
 *
 * The harness drives the REAL tick (handlePositionUpdate) with each recorded
 * fix at its own wall-clock instant, the clock and jest's fake timers moving
 * together in 1 s steps. "Before" is the tick alone — what shipped; "after"
 * arms the trip through startGoModeTracking, the door every live trip uses.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPolls: { key: string; kind: string; t: number }[] = []

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(
    () => () => Promise.resolve({ error: false, itineraries: [] })
  ),
  fetchRerouteSnapshotPlan: jest.fn(() => () => Promise.resolve(null)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findStopTimesForStop: jest.fn((params: any) => {
    mockPolls.push({ key: params.stopId, kind: 'stop', t: Date.now() })
    return () => Promise.resolve({})
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findTrip: jest.fn((params: any) => {
    mockPolls.push({ key: params.tripId, kind: 'trip', t: Date.now() })
    return () => Promise.resolve(null)
  }),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn((routeId: string) => {
    mockPolls.push({ key: routeId, kind: 'vehicle', t: Date.now() })
    return () => Promise.resolve(null)
  })
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const f: any = fixture
const STOP = '1:53543'
const ROUTE = '1:904'
const TRIP = '1:1273254'
const MIN = 60000
const T_START = f.source.fromMs as number // 16:59:03.386
const T_WATCHDOG_1 = 1790806023000 // 17:07:03 local
const T_LAST_GOOD = 1790805964000 // 17:06:04 local

const initial = goModeReducer(undefined, { type: '@@INIT' })

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toPosition = (p: any): GeolocationPosition =>
  ({
    coords: {
      accuracy: p.accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: p.heading,
      latitude: p.lat,
      longitude: p.lon,
      speed: p.speed
    },
    timestamp: p.tMs
  } as GeolocationPosition)

const RealDate = Date
let fakeNow = T_START

/** Move the wall clock and the fake timers together, 1 s at a time. */
const advanceTo = (t: number) => {
  while (fakeNow + 1000 <= t) {
    fakeNow += 1000
    jest.advanceTimersByTime(1000)
  }
  const rest = t - fakeNow
  if (rest > 0) {
    fakeNow = t
    jest.advanceTimersByTime(rest)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const openStores: any[] = []

const makeStore = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let goModeState: any = {
    ...initial,
    activeItinerary: f.itinerary,
    isActive: true,
    startedAt: T_START
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
  const store = {
    getGoMode: () => goModeState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: (thunk: any) => thunk(dispatch, getState),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setGoMode: (patch: any) => {
      goModeState = { ...goModeState, ...patch }
    },
    types: () => actions.map((a) => a.type)
  }
  openStores.push(store)
  return store
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** Arm the trip the way every live trip is armed, then forget its prefetch. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const arm = async (store: any) => {
  await store.run(startGoModeTracking(f.itinerary))
  await flush()
  mockPolls.length = 0
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const replay = (store: any, fixes: any[], untilMs: number) => {
  for (const p of fixes) {
    advanceTo(p.tMs)
    store.run(handlePositionUpdate(toPosition(p)))
  }
  advanceTo(untilMs)
}

const stopPollTimes = () =>
  mockPolls.filter((p) => p.kind === 'stop' && p.key === STOP).map((p) => p.t)

const gapsSec = (ts: number[]) =>
  ts.slice(1).map((t, i) => Math.round((t - ts[i]) / 100) / 10)

/** The wait, 16:59:03 to the bus (17:08:38 is the last recorded stop poll). */
const T_END = 1790806140000 // 17:09:00 local
const waitFixes = f.fixes.filter((p: { tMs: number }) => p.tMs <= T_END)

beforeEach(() => {
  jest.useFakeTimers()
  fakeNow = T_START
  mockPolls.length = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = global as any
  g.Date = class extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      super(...((args.length ? args : [fakeNow]) as [any]))
    }

    static now(): number {
      return fakeNow
    }
  }
  jest.spyOn(console, 'log').mockImplementation(() => undefined)
  jest.spyOn(console, 'info').mockImplementation(() => undefined)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  while (openStores.length) {
    const store = openStores.pop()
    try {
      if (store.getGoMode().isActive) store.run(endGoMode())
    } catch (e) {
      /* nothing to end */
    }
  }
  jest.clearAllTimers()
  jest.useRealTimers()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(global as any).Date = RealDate
  jest.restoreAllMocks()
})

describe('the gate', () => {
  const base = {
    arrived: false,
    isActive: true,
    lastPollAtMs: 0,
    lastPositionAtMs: 0,
    legIndex: 0,
    legs: f.itinerary.legs,
    nowMs: 100000,
    pollIntervalMs: 20000,
    replay: false,
    simulation: false
  }

  it('polls when the poll is due and no fix has come in', () => {
    expect(shouldTimerPollLiveBoard(base)).toBe(true)
  })

  it('stands aside while fixes flow — the tick takes the poll', () => {
    expect(
      shouldTimerPollLiveBoard({
        ...base,
        lastPositionAtMs: base.nowMs - LIVE_BOARD_FIX_GAP_MS + 1
      })
    ).toBe(false)
  })

  it('shares the tick’s throttle', () => {
    expect(
      shouldTimerPollLiveBoard({ ...base, lastPollAtMs: base.nowMs - 20000 })
    ).toBe(false)
    expect(
      shouldTimerPollLiveBoard({ ...base, lastPollAtMs: base.nowMs - 20001 })
    ).toBe(true)
  })

  it('never polls a trip that is over, replayed, simulated, or past its last transit leg', () => {
    expect(shouldTimerPollLiveBoard({ ...base, arrived: true })).toBe(false)
    expect(shouldTimerPollLiveBoard({ ...base, isActive: false })).toBe(false)
    expect(shouldTimerPollLiveBoard({ ...base, replay: true })).toBe(false)
    expect(shouldTimerPollLiveBoard({ ...base, simulation: true })).toBe(false)
    expect(shouldTimerPollLiveBoard({ ...base, legIndex: 2 })).toBe(false)
    expect(shouldTimerPollLiveBoard({ ...base, legIndex: null })).toBe(false)
    // On the bus leg itself (the platform wait after the transition) it does.
    expect(shouldTimerPollLiveBoard({ ...base, legIndex: 1 })).toBe(true)
  })
})

describe('38.2 — the recorded wait, replayed through the real tick', () => {
  it('the fixture is the ride: polls every ~20 s, then two on the watchdog fixes', () => {
    const rec: number[] = f.recordedStopPolls
    expect(rec.length).toBe(24)
    expect(hhmmss(rec[0])).toBe('16:59:10')
    expect(hhmmss(rec[20])).toBe('17:06:04')
    expect(hhmmss(rec[21])).toBe('17:07:03')
    expect(hhmmss(rec[22])).toBe('17:08:04')
  })

  it('BEFORE (tick only): the harness reproduces the recorded 60 s gaps', () => {
    const store = makeStore()
    replay(store, waitFixes, T_END)
    const polls = stopPollTimes()
    const after0606 = polls.filter((t) => t > T_LAST_GOOD)
    // The first poll after 17:06:04 rides the watchdog's forced fix.
    expect(hhmmss(after0606[0])).toBe('17:07:03')
    expect(Math.max(...gapsSec(polls))).toBeGreaterThanOrEqual(50)
    // eslint-disable-next-line no-console
    process.stdout.write(
      `[38.2 measure] BEFORE recorded track: ${polls.length} stop polls, ` +
        `gaps ${JSON.stringify(gapsSec(polls))}\n`
    )
  })

  it('AFTER (tick + timer): the board keeps ~20 s through the canopy gap', async () => {
    const store = makeStore()
    await arm(store)
    replay(store, waitFixes, T_END)
    const polls = stopPollTimes()
    const gaps = gapsSec(polls)
    // Never two inside one interval, never a minute without one.
    expect(Math.min(...gaps)).toBeGreaterThan(20)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(
      20 + (LIVE_BOARD_TIMER_MS + LIVE_BOARD_FIX_GAP_MS) / 1000
    )
    // The 17:06:08 – 17:07:03 hole is filled before the watchdog fires.
    expect(polls.some((t) => t > T_LAST_GOOD && t < T_WATCHDOG_1 - 10000)).toBe(
      true
    )
    // eslint-disable-next-line no-console
    process.stdout.write(
      `[38.2 measure] AFTER recorded track: ${polls.length} stop polls, ` +
        `gaps ${JSON.stringify(gaps)}\n`
    )
  })

  it('fixes thinned to one a minute: tick only starves, the timer holds ~20 s', async () => {
    const thinned: { tMs: number }[] = []
    for (const p of waitFixes) {
      if (!thinned.length || p.tMs - thinned[thinned.length - 1].tMs >= MIN)
        thinned.push(p)
    }
    const before = makeStore()
    replay(before, thinned, T_END)
    const beforePolls = stopPollTimes()
    before.run(endGoMode())

    mockPolls.length = 0
    fakeNow = T_START
    const after = makeStore()
    await arm(after)
    replay(after, thinned, T_END)
    const afterPolls = stopPollTimes()

    // 10 fixes over 10 minutes: one poll per fix before; the timer triples it.
    expect(thinned.length).toBe(10)
    expect(beforePolls.length).toBe(thinned.length)
    expect(Math.min(...gapsSec(beforePolls))).toBeGreaterThanOrEqual(59)
    expect(afterPolls.length).toBeGreaterThanOrEqual(26)
    expect(Math.max(...gapsSec(afterPolls))).toBeLessThanOrEqual(26)
    expect(Math.min(...gapsSec(afterPolls))).toBeGreaterThan(20)
    // The trip and vehicle polls ride the same timer.
    const kinds = new Set(mockPolls.map((p) => `${p.kind}:${p.key}`))
    expect(kinds).toContain(`trip:${TRIP}`)
    expect(kinds).toContain(`vehicle:${ROUTE}`)
    // eslint-disable-next-line no-console
    process.stdout.write(
      `[38.2 measure] THINNED (1 fix/min, ${thinned.length} fixes): ` +
        `before ${beforePolls.length} polls gaps ${JSON.stringify(
          gapsSec(beforePolls)
        )}; after ${afterPolls.length} polls gaps ${JSON.stringify(
          gapsSec(afterPolls)
        )}\n`
    )
  })

  it('no fixes at all for 60 s after the first: polls still every ~20 s', async () => {
    const store = makeStore()
    await arm(store)
    replay(store, waitFixes.slice(0, 1), T_START + MIN)
    const polls = stopPollTimes()
    // The fix's own poll, then the timer's at ~21 s and ~42 s (and ~63 s).
    expect(polls.length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...gapsSec(polls))).toBeLessThanOrEqual(24)
  })

  it('fixes every second: exactly the tick’s polls, the timer adds none', async () => {
    const dense = waitFixes.filter((p: { tMs: number }) => p.tMs < T_LAST_GOOD)
    const before = makeStore()
    replay(before, dense, T_LAST_GOOD)
    const beforePolls = stopPollTimes()
    before.run(endGoMode())

    mockPolls.length = 0
    fakeNow = T_START
    const after = makeStore()
    await arm(after)
    replay(after, dense, T_LAST_GOOD)
    const afterPolls = stopPollTimes()
    expect(afterPolls).toEqual(beforePolls)
    expect(Math.min(...gapsSec(afterPolls))).toBeGreaterThan(20)
  })
})

describe('38.2 — the timer does not outlive the trip', () => {
  /**
   * Every interval armed at the live board timer's period, and every id handed
   * to clearInterval. Counting polls alone is not proof — a leaked timer whose
   * gate happens to read "nothing to poll" would pass that and still tick for
   * as long as the page lives (2026-08-28: 88 minutes).
   */
  const watchIntervals = () => {
    const set = jest.spyOn(global, 'setInterval')
    const clear = jest.spyOn(global, 'clearInterval')
    return {
      cleared: () => clear.mock.calls.map((c) => c[0]),
      live: () =>
        set.mock.calls
          .map((c, i) => ({ delay: c[1], id: set.mock.results[i].value }))
          .filter((x) => x.delay === LIVE_BOARD_TIMER_MS)
          .map((x) => x.id)
    }
  }

  const quietTenMinutes = () => {
    mockPolls.length = 0
    advanceTo(fakeNow + 10 * MIN)
    return mockPolls.length
  }

  it('endGoMode clears it: the interval is cleared, and nothing polls for 10 minutes', async () => {
    const intervals = watchIntervals()
    const store = makeStore()
    await arm(store)
    replay(store, waitFixes.slice(0, 1), T_START + 30000)
    expect(stopPollTimes().length).toBeGreaterThanOrEqual(2)
    const armed = intervals.live()
    expect(armed.length).toBe(1)
    store.run(endGoMode())
    expect(store.getGoMode().isActive).toBe(false)
    // Cleared BY endGoMode, synchronously — not left for its own next tick.
    expect(intervals.cleared()).toContain(armed[0])
    // ...and even with the store put back to a live-looking trip at the
    // platform, nothing of the old trip may poll.
    store.setGoMode({
      activeItinerary: f.itinerary,
      arrivedAt: null,
      isActive: true,
      routeMatch: { legIndex: 0 }
    })
    expect(quietTenMinutes()).toBe(0)
    store.setGoMode({ isActive: false })
  })

  it('arrival through the real tick clears it: SET_ARRIVED, then zero polls over 10 minutes', async () => {
    const intervals = watchIntervals()
    const store = makeStore()
    await arm(store)
    replay(store, waitFixes.slice(0, 1), T_START + 30000)
    const armed = intervals.live()
    expect(armed.length).toBe(1)
    const dest = f.itinerary.legs[f.itinerary.legs.length - 1].to
    store.run(
      handlePositionUpdate(
        toPosition({
          accuracy: 5,
          heading: null,
          lat: dest.lat,
          lon: dest.lon,
          speed: 0,
          tMs: fakeNow
        })
      )
    )
    expect(store.types()).toContain('SET_ARRIVED')
    // The arrival quiesce clears it in the same tick.
    expect(intervals.cleared()).toContain(armed[0])
    expect(quietTenMinutes()).toBe(0)
  })

  it('a trip resumed already arrived never arms one', async () => {
    const intervals = watchIntervals()
    const store = makeStore()
    store.setGoMode({ arrivedAt: T_START - 30000 })
    await store.run(startGoModeTracking(f.itinerary))
    expect(intervals.live().length).toBe(0)
  })

  it('a timer whose trip went inactive without passing an exit clears itself on its next tick', async () => {
    // Belt and braces for a future exit that forgets stopLiveBoardTimer: the
    // timer only ever polls for the session that armed it.
    const intervals = watchIntervals()
    const store = makeStore()
    await arm(store)
    const armed = intervals.live()
    store.setGoMode({ isActive: false })
    advanceTo(fakeNow + LIVE_BOARD_TIMER_MS + 1000)
    expect(intervals.cleared()).toContain(armed[0])
  })

  it('re-entry replaces the timer instead of stacking it', async () => {
    const intervals = watchIntervals()
    const store = makeStore()
    await arm(store)
    await arm(store)
    await arm(store)
    const armed = intervals.live()
    expect(armed.length).toBe(3)
    // The first two were cleared by the re-arm; one is left running.
    expect(intervals.cleared()).toEqual(
      expect.arrayContaining([armed[0], armed[1]])
    )
    expect(intervals.cleared()).not.toContain(armed[2])
  })
})
