import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import { endGoMode, handlePositionUpdate } from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),

  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
    modeSettings: [],
    numItineraries: 5
  })),
  // The tick polls vehicle positions for the boarding route and re-reads live
  // leg times; neither is under test and both would reach for the network.
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

const initial = goMode(undefined, { type: '@@INIT' })
const mockedFetch = fetchOnboardCandidatePlan as jest.Mock

/**
 * 2026-09-03, 18:24 — the ambiguous missed bus that told the rider nothing.
 *
 * `classifyMissedBus` has two verdicts. A DEFINITIVE miss (the feed says the
 * bus left, or the rider is provably away from the stop) auto-updates the trip
 * to the same route's next departure. An AMBIGUOUS one — schedule-only data
 * while the rider is standing at the stop, so the bus may simply be late —
 * must not touch their route, and `autoApply: missed.definitive` is exactly
 * that gate. What it was supposed to do instead was "surface the regular card".
 *
 * That card was deleted in `eb74a9d8`, which replaced it with the planner. From
 * then until this file, an ambiguous miss pushed
 *
 *   "The METRO Orange Line may have left I-35W & 66th St Station —
 *    checking alternatives…"                                (18:24:39.372)
 *
 * ran a real search, landed two real itineraries in `goMode.reRoute`
 * (18:24:43.856) — and showed the rider nothing, ever, because no screen has
 * read that slice since. `grep -rn "reRoute" lib/components/` returns zero.
 *
 * The honest behaviour, and what these cases hold:
 *
 *  - the candidates go to the planner the rider already knows, through
 *    `showRerouteCandidates` — the same results screen `browseFromCurrentPosition`
 *    hands them, with its "Switch to this trip" button. Nothing is applied:
 *    the app is not sure the bus is gone, so it must not change the route.
 *  - the trip is backgrounded, so the ReturnToTripBanner is there to go back
 *    with rather than the trip simply vanishing.
 *  - ONE push, sent when the answer is known, carrying the numbers the rider
 *    acts on — never a promise to check.
 *  - an empty search says so in that same push, and does NOT throw the rider
 *    onto an empty results list.
 *  - a definitive miss is untouched: it still auto-updates and still says so
 *    at the moment it happens.
 */

const ORIGIN: [number, number] = [44.9, -93.29]
const STOP: [number, number] = [44.9, -93.27]
const DEST: [number, number] = [44.9, -93.2]

/** When the bus was due. Everything below is measured from here. */
const BOARD = 1_788_000_000_000
/** Past MISSED_BUS_GRACE_SCHEDULED_MS (180 s), so the miss is raised. */
const T0 = BOARD + 200_000

const trip = () => ({
  duration: 3000,
  endTime: BOARD + 1_200_000,
  legs: [
    {
      distance: 1576,
      duration: 300,
      endTime: BOARD,
      from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Home' },
      legGeometry: { points: encode([ORIGIN, STOP]) },
      mode: 'WALK',
      startTime: BOARD - 300_000,
      to: {
        lat: STOP[0],
        lon: STOP[1],
        name: 'I-35W & 66th St Station',
        stop: { gtfsId: '1:66th' }
      },
      transitLeg: false
    },
    {
      distance: 5500,
      duration: 1200,
      endTime: BOARD + 1_200_000,
      from: {
        lat: STOP[0],
        lon: STOP[1],
        name: 'I-35W & 66th St Station',
        stop: { gtfsId: '1:66th' }
      },
      legGeometry: { points: encode([STOP, DEST]) },
      mode: 'BUS',
      routeId: '1:904',
      routeShortName: 'Orange Line',
      startTime: BOARD,
      to: { lat: DEST[0], lon: DEST[1], name: 'Downtown' },
      transitLeg: true
    }
  ],
  startTime: BOARD - 300_000
})

/** One alternative: the next Orange Line, twelve minutes out. */
const nextOrangeLine = (atMs: number) => ({
  duration: 1500,
  endTime: atMs + 1_200_000,
  legs: [
    {
      distance: 20,
      duration: 30,
      endTime: atMs,
      from: { lat: STOP[0], lon: STOP[1], name: 'I-35W & 66th St Station' },
      mode: 'WALK',
      startTime: atMs - 30_000,
      to: { lat: STOP[0], lon: STOP[1], name: 'I-35W & 66th St Station' },
      transitLeg: false
    },
    {
      distance: 5500,
      duration: 1200,
      endTime: atMs + 1_200_000,
      from: { lat: STOP[0], lon: STOP[1], name: 'I-35W & 66th St Station' },
      mode: 'BUS',
      routeId: '1:904',
      routeShortName: 'Orange Line',
      startTime: atMs,
      to: { lat: DEST[0], lon: DEST[1], name: 'Downtown' },
      transitLeg: true
    }
  ],
  startTime: atMs - 30_000
})

/** A different route, so the copy has to name it. */
const the535 = (atMs: number) => ({
  duration: 1400,
  endTime: atMs + 1_100_000,
  legs: [
    {
      distance: 5500,
      duration: 1100,
      endTime: atMs + 1_100_000,
      from: { lat: STOP[0], lon: STOP[1], name: 'I-35W & 66th St Station' },
      mode: 'BUS',
      routeId: '1:535',
      routeShortName: '535',
      startTime: atMs,
      to: { lat: DEST[0], lon: DEST[1], name: 'Downtown' },
      transitLeg: true
    }
  ],
  startTime: atMs
})

/**
 * A fix AT the boarding stop (inside MISSED_BUS_AT_STOP_RADIUS_M, which is what
 * makes the miss ambiguous rather than definitive) at walking speed.
 */
const atStop = (timestamp: number): GeolocationPosition =>
  ({
    coords: {
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: STOP[0],
      longitude: STOP[1],
      speed: 0.4
    },
    timestamp
  } as GeolocationPosition)

/** Same fix, a kilometre short of the stop: provably away, so DEFINITIVE. */
const wellShortOfStop = (timestamp: number): GeolocationPosition =>
  ({
    coords: {
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: ORIGIN[0],
      longitude: ORIGIN[1],
      speed: 0.4
    },
    timestamp
  } as GeolocationPosition)

const makeStore = () => {
  let goModeState: any = {
    ...initial,
    activeItinerary: trip(),
    isActive: true,
    routeMatch: {
      distanceFromRoute: 0,
      legIndex: 0,
      nearestPoint: STOP,
      progressAlongLeg: 0.99
    },
    tracking: { ...initial.tracking, lastPosition: atStop(T0 - 5000) }
  }
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    goModeState = goMode(goModeState, action)
    return action
  }
  return {
    actions,
    dispatch,
    getState,
    goMode: () => goModeState,
    of: (type: string) => actions.filter((a) => a.type === type),
    run: (thunk: any) => thunk(dispatch, getState)
  }
}

/** Every MISSED_BUS message the rider was actually shown, in order. */
const missedBusMessages = (store: ReturnType<typeof makeStore>) =>
  store
    .of('ADD_NOTIFICATION')
    .filter((a) => a.payload?.type === 'MISSED_BUS')
    .map((a) => a.payload.message)

describe('an ambiguous missed bus (2026-09-03)', () => {
  let clock: FakeTimers.InstalledClock | undefined
  let store: ReturnType<typeof makeStore> | undefined

  beforeEach(() => {
    mockedFetch.mockReset()
    clock = FakeTimers.install({ now: T0, toFake: ['Date'] })
  })
  afterEach(() => {
    store?.run(endGoMode())
    store = undefined
    clock?.uninstall()
    clock = undefined
  })

  /** A fix, then the microtask turn the isolated re-plan resolves on. */
  const tick = async (
    at: number,
    fix: (t: number) => GeolocationPosition = atStop
  ) => {
    clock?.setSystemTime(at)
    store?.run(handlePositionUpdate(fix(at)))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('shows the rider the alternatives it found, and arms the way back', async () => {
    store = makeStore()
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({
        error: false,
        itineraries: [nextOrangeLine(T0 + 720_000)]
      })
    )

    // Tick 1 raises the miss and starts the isolated re-plan.
    await tick(T0)
    expect(store.goMode().reRoute.reason).toBe('missed-bus')
    // Never auto-applied: the app is not sure the bus is gone.
    expect(store.goMode().reRoute.autoApply).toBe(false)
    expect(store.goMode().reRoute.status).toBe('found')

    // Tick 2 hands the settled result to the rider.
    await tick(T0 + 5000)

    // The candidates reach the planner as a real results screen — without a
    // second search: the plan fetch ran once, for the re-plan.
    const seeded = store.of('ROUTING_RESPONSE')
    expect(seeded).toHaveLength(1)
    expect(seeded[0].payload.response.plan.itineraries).toHaveLength(1)
    expect(store.of('ROUTING_REQUEST')).toHaveLength(1)
    expect(mockedFetch).toHaveBeenCalledTimes(1)

    // ...and the trip is backgrounded, which is what puts the
    // ReturnToTripBanner on screen instead of stranding them in the planner.
    expect(store.goMode().ui.backgrounded).toBe(true)
  })

  it('replaces "checking alternatives…" with the wait, in minutes', async () => {
    store = makeStore()
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({
        error: false,
        itineraries: [nextOrangeLine(T0 + 720_000)]
      })
    )

    await tick(T0)
    // Nothing is said while the search is still a search.
    expect(missedBusMessages(store)).toEqual([])

    await tick(T0 + 5000)
    expect(missedBusMessages(store)).toEqual([
      'Orange Line likely missed · next in 12 min'
    ])
  })

  it('names the route when the best answer is a different one', async () => {
    store = makeStore()
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [the535(T0 + 240_000)] })
    )

    await tick(T0)
    await tick(T0 + 5000)
    expect(missedBusMessages(store)).toEqual([
      'Orange Line likely missed · 535 in 4 min'
    ])
  })

  it('says so when there is nothing, instead of going quiet', async () => {
    store = makeStore()
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [] })
    )

    await tick(T0)
    await tick(T0 + 5000)
    expect(missedBusMessages(store)).toEqual([
      'Orange Line likely missed · no alternatives'
    ])
    // An empty answer must not also throw them onto an empty results list.
    expect(store.of('ROUTING_RESPONSE')).toHaveLength(0)
    expect(store.goMode().ui.backgrounded).toBe(false)
  })

  it('says it once, however long the rider stands there', async () => {
    store = makeStore()
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({
        error: false,
        itineraries: [nextOrangeLine(T0 + 720_000)]
      })
    )

    await tick(T0)
    for (let i = 1; i <= 8; i++) await tick(T0 + i * 5000)
    expect(missedBusMessages(store)).toHaveLength(1)
    expect(store.of('ROUTING_REQUEST')).toHaveLength(1)
  })

  it('withdraws the claim when the bus turns out not to be missed', async () => {
    store = makeStore()
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({
        error: false,
        itineraries: [nextOrangeLine(T0 + 720_000)]
      })
    )

    await tick(T0)
    await tick(T0 + 5000)
    expect(missedBusMessages(store)).toHaveLength(1)

    // The rider boards: classifyMissedBus returns null outright while the
    // sticky riding fact is set, so the miss is no longer a fact about the
    // world. The settled re-plan goes with it.
    store.dispatch({
      payload: { boardedAt: T0 + 6000, legIndex: 1, routeId: '1:904' },
      type: 'SET_RIDING'
    })
    await tick(T0 + 10_000)
    expect(store.goMode().reRoute.status).toBe('idle')
    expect(store.goMode().reRoute.candidates).toEqual([])
    // No second push, and no new claim: boarding announces itself.
    expect(missedBusMessages(store)).toHaveLength(1)
  })
})

describe('a definitive missed bus is unchanged (2026-09-03)', () => {
  let clock: FakeTimers.InstalledClock | undefined
  let store: ReturnType<typeof makeStore> | undefined

  beforeEach(() => {
    mockedFetch.mockReset()
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [] })
    )
    clock = FakeTimers.install({ now: T0, toFake: ['Date'] })
  })
  afterEach(() => {
    store?.run(endGoMode())
    store = undefined
    clock?.uninstall()
    clock = undefined
  })

  it('still says so the moment it happens, and still auto-applies', async () => {
    store = makeStore()
    clock?.setSystemTime(T0)
    store.run(handlePositionUpdate(wellShortOfStop(T0)))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(missedBusMessages(store)).toEqual([
      'Missed the Orange Line — updating your trip to the next departure.'
    ])
    const started = store.of('START_REROUTE')
    expect(started).toHaveLength(1)
    expect(started[0].payload.autoApply).toBe(true)
    expect(started[0].payload.keepRouteId).toBe('1:904')
    // No planner hand-off: there is nothing for the rider to choose.
    expect(store.of('ROUTING_REQUEST')).toHaveLength(0)
    expect(store.goMode().ui.backgrounded).toBe(false)
  })
})
