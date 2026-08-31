import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import {
  endGoMode,
  handlePositionUpdate,
  quietReplanAccessLeg
} from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import { QUIET_REPLAN_BURST_MAX } from '../../../lib/util/go-mode/deviation'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  }))
}))

const initial = goMode(undefined, { type: '@@INIT' })
const mockedFetch = fetchOnboardCandidatePlan as jest.Mock

/**
 * 2026-08-28: a quiet re-plan produced a 670 m access leg, the rider was 122 m
 * off it within 55 s, and the app did nothing for nearly three minutes.
 * QUIET_REPLAN_MIN_INTERVAL_MS was a flat 60 s with no leg-length, distance or
 * mode scaling — a rider two blocks from their boarding stop was held to the
 * same patience as one with half an hour of riding left.
 */

const A: [number, number] = [44.94, -93.28]
const B: [number, number] = [44.94, -93.275]
const DEST: [number, number] = [44.94, -93.2]

/** A bike access leg of `distance` metres, then the bus it feeds. */
const trip = (distance: number) => ({
  duration: 1500,
  endTime: 0,
  legs: [
    {
      distance,
      duration: 300,
      endTime: 0,
      from: { lat: A[0], lon: A[1], name: 'Here' },
      legGeometry: { points: encode([A, B]) },
      mode: 'BICYCLE',
      startTime: 0,
      to: { lat: B[0], lon: B[1], name: 'Nicollet & 46th' },
      transitLeg: false
    },
    {
      distance: 6000,
      duration: 1200,
      endTime: 0,
      from: { lat: B[0], lon: B[1], name: 'Nicollet & 46th' },
      legGeometry: { points: encode([B, DEST]) },
      mode: 'BUS',
      routeId: '1:18',
      startTime: 0,
      to: { lat: DEST[0], lon: DEST[1], name: 'Downtown' },
      transitLeg: true
    }
  ],
  startTime: 0
})

const fixAt = (lon: number, timestamp: number): GeolocationPosition =>
  ({
    coords: {
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: A[0],
      longitude: lon,
      speed: 5.5
    },
    timestamp
  } as GeolocationPosition)

const makeStore = (distance: number) => {
  let runThunks = false
  let goModeState: any = {
    ...initial,
    activeItinerary: trip(distance),
    isActive: true,
    routeMatch: { legIndex: 0, progressAlongLeg: 0 },
    tracking: { ...initial.tracking, lastPosition: fixAt(-93.28, 0) }
  }
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
      return runThunks ? action(dispatch, getState) : undefined
    }
    goModeState = goMode(goModeState, action)
    return action
  }
  return {
    run: (thunk: any) => thunk(dispatch, getState),
    setRunThunks: (on: boolean) => {
      runThunks = on
    }
  }
}

describe('a re-plan cooldown that knows how long the leg is (2026-08-28)', () => {
  let clock = 1_756_600_000_000
  let dateFaker: FakeTimers.InstalledClock | undefined
  let store: ReturnType<typeof makeStore> | undefined

  beforeEach(() => {
    mockedFetch.mockReset()
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [] })
    )
    clock += 1_800_000
    dateFaker = FakeTimers.install({ now: clock, toFake: ['Date'] })
  })
  afterEach(() => {
    store?.setRunThunks(false)
    store?.run(endGoMode())
    store = undefined
    dateFaker?.uninstall()
    dateFaker = undefined
  })

  /**
   * Admitted re-plans, not fetches: each one issues a mode-scoped access plan
   * and then — since these all come back empty — the full-trip fallback.
   */
  const replans = () =>
    mockedFetch.mock.calls.filter((c: any[]) => c[0]?.modes?.length === 1)
      .length

  /**
   * A fix, then a re-plan attempt, at `atMs`. `lonStep` walks the rider toward
   * the destination so the non-convergence tracker never arms — the only thing
   * under test here is the cooldown.
   */
  const attemptAt = async (atMs: number, lonStep: number) => {
    dateFaker?.setSystemTime(atMs)
    store?.setRunThunks(false)
    store?.run(handlePositionUpdate(fixAt(-93.28 + lonStep, atMs)))
    store?.setRunThunks(true)
    await store?.run(quietReplanAccessLeg())
  }

  it('retries a 670 m leg inside the minute it used to wait out', async () => {
    store = makeStore(670)
    await attemptAt(clock, 0)
    expect(replans()).toBe(1)
    // 55 s: exactly where 8/28's rider was already 122 m off the new leg.
    await attemptAt(clock + 55_000, 0.001)
    expect(replans()).toBe(2)
  })

  it('still gives a long leg the full minute to converge', async () => {
    store = makeStore(3000)
    await attemptAt(clock, 0)
    expect(replans()).toBe(1)
    await attemptAt(clock + 55_000, 0.001)
    expect(replans()).toBe(1)
    await attemptAt(clock + 61_000, 0.002)
    expect(replans()).toBe(2)
  })

  it('cannot become a re-plan storm however short the leg', async () => {
    store = makeStore(120)
    for (let i = 0; i <= QUIET_REPLAN_BURST_MAX; i++) {
      await attemptAt(clock + i * 30_000, i * 0.001)
    }
    expect(replans()).toBe(QUIET_REPLAN_BURST_MAX)
  })
})
