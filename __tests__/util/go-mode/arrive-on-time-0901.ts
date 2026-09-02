import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import {
  accessArriveByTarget,
  ARRIVE_ON_TIME_LEAD_MINUTES
} from '../../../lib/util/go-mode/arrive-on-time'
import { endGoMode, quietReplanAccessLeg } from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
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
 * "Arrive on time" bike routing — the rider's second ask from 2026-09-01
 * (backlog 6.10b): "target departure − N min for the access leg instead of
 * arrive-ASAP".
 *
 * Every access re-plan Go Mode has ever issued is `arriveBy: false` at the
 * wall clock, so the answer is always as-fast-as-possible and the rider gets
 * whatever slack falls out of it. Opted in, the SCOPED access query (the one
 * that keeps the transit suffix and only re-plans GPS → boarding stop) is
 * anchored on the boarding instead: arrive by three minutes before the bus.
 *
 * The full-trip fallback below it is deliberately NOT changed. It re-plans the
 * whole journey including the transit, where an arrive-by deadline aimed at
 * one boarding means nothing.
 */

const ORIGIN: [number, number] = [44.8132, -93.3055]
const STOP: [number, number] = [44.8165, -93.3098]
const DEST: [number, number] = [44.8402, -93.2977]
const NOW = 1_788_278_889_000
const BOARD = NOW + 900_000
const ALIGHT = NOW + 1_800_000

/** Bike to the stop, then the bus. The shape of the 09-01 access legs. */
const currentPlan = () => ({
  duration: (ALIGHT - NOW) / 1000,
  endTime: ALIGHT,
  legs: [
    {
      distance: 1500,
      duration: 450,
      endTime: NOW + 450_000,
      from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Current location' },
      legGeometry: { points: encode([ORIGIN, STOP]) },
      mode: 'BICYCLE',
      startTime: NOW,
      to: { lat: STOP[0], lon: STOP[1], name: 'I-35W & 98th St Station' },
      transitLeg: false
    },
    {
      distance: 9000,
      duration: 900,
      endTime: ALIGHT,
      from: { lat: STOP[0], lon: STOP[1], name: 'I-35W & 98th St Station' },
      legGeometry: { points: encode([STOP, DEST]) },
      mode: 'BUS',
      routeShortName: '535',
      startTime: BOARD,
      to: { lat: DEST[0], lon: DEST[1], name: 'Downtown' },
      transitLeg: true
    }
  ],
  startTime: NOW
})

/** A replacement access chain: bike only, origin at the rider. */
const accessCandidate = () => ({
  duration: 400,
  endTime: NOW + 400_000,
  legs: [
    {
      distance: 1500,
      duration: 400,
      endTime: NOW + 400_000,
      from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Current location' },
      legGeometry: { points: encode([ORIGIN, STOP]) },
      mode: 'BICYCLE',
      startTime: NOW,
      to: { lat: STOP[0], lon: STOP[1], name: 'I-35W & 98th St Station' },
      transitLeg: false
    }
  ],
  startTime: NOW
})

const fix = (): GeolocationPosition =>
  ({
    coords: {
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: ORIGIN[0],
      longitude: ORIGIN[1],
      speed: 7.5
    },
    timestamp: NOW
  } as GeolocationPosition)

const makeStore = (
  currentQuery: any = {},
  liveLegTimes: any = {},
  boardEpoch = BOARD
) => {
  const plan = currentPlan()
  plan.legs[1].startTime = boardEpoch
  let goModeState: any = {
    ...initial,
    activeItinerary: plan,
    isActive: true,
    liveLegTimes,
    riding: null,
    routeMatch: { legIndex: 0, progressAlongLeg: 0.3 },
    tracking: { ...initial.tracking, lastPosition: fix() }
  }
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery,
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    goModeState = goMode(goModeState, action)
    return action
  }
  return { run: (thunk: any) => thunk(dispatch, getState) }
}

/** "HH:mm" as minutes past midnight, for comparing two query anchors. */
const minutesOfDay = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

describe('accessArriveByTarget', () => {
  it('aims the default lead ahead of the boarding', () => {
    expect(
      accessArriveByTarget({ boardEpochMs: BOARD, enabled: true, nowMs: NOW })
    ).toBe(BOARD - ARRIVE_ON_TIME_LEAD_MINUTES * 60000)
  })

  it('is off unless the rider asked for it', () => {
    expect(
      accessArriveByTarget({ boardEpochMs: BOARD, enabled: false, nowMs: NOW })
    ).toBeNull()
  })

  it('stands down when the rider has no slack left to spend', () => {
    // Bus in two minutes: the target is already behind us, and asking OTP to
    // arrive by a moment that has passed is worse than asking it to hurry.
    expect(
      accessArriveByTarget({
        boardEpochMs: NOW + 120_000,
        enabled: true,
        nowMs: NOW
      })
    ).toBeNull()
  })

  it('needs a boarding time to aim at', () => {
    expect(
      accessArriveByTarget({ boardEpochMs: null, enabled: true, nowMs: NOW })
    ).toBeNull()
  })
})

describe('the scoped access re-plan honours "arrive on time" (2026-09-01)', () => {
  let clock: FakeTimers.InstalledClock | undefined
  let store: ReturnType<typeof makeStore> | undefined

  beforeEach(() => {
    mockedFetch.mockReset()
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [accessCandidate()] })
    )
    clock = FakeTimers.install({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    // The re-plan cooldown is TripSession state, so every case is its own trip.
    store?.run(endGoMode())
    store = undefined
    clock?.uninstall()
    clock = undefined
  })

  const combos = () => mockedFetch.mock.calls.map((c) => c[0])

  it('leaves the query as depart-now when the rider has not opted in', () => {
    store = makeStore({})
    return store.run(quietReplanAccessLeg()).then(() => {
      expect(combos()).toHaveLength(1)
      expect(combos()[0].arriveBy).toBe(false)
    })
  })

  it('anchors the query three minutes before the bus when they have', async () => {
    const off = makeStore({})
    await off.run(quietReplanAccessLeg())
    const departNow = combos()[0].time
    await off.run(endGoMode())
    mockedFetch.mockClear()

    store = makeStore({ arriveOnTimeAccess: true })
    await store.run(quietReplanAccessLeg())
    const [scoped] = combos()
    expect(scoped.arriveBy).toBe(true)
    // Bus at NOW + 15 min, lead 3 min: the deadline is 12 minutes after the
    // moment the depart-now query would have been anchored on.
    expect(minutesOfDay(scoped.time) - minutesOfDay(departNow)).toBe(12)
    // Everything else about the query is untouched — same origin, same
    // boarding stop, same single access mode.
    expect(scoped.modes).toEqual([{ mode: 'BICYCLE' }])
    expect(scoped.to.name).toBe('I-35W & 98th St Station')
    // One question asked, not two: the arrive-by plan was usable.
    expect(combos()).toHaveLength(1)
  })

  it('prefers the feed’s departure over the timetable’s', async () => {
    // The bus is running six minutes late. Aiming at the plan's 15-minute mark
    // would send the rider to a kerb they then stand on for nine minutes.
    store = makeStore(
      { arriveOnTimeAccess: true },
      {
        1: {
          alightEpoch: ALIGHT,
          boardEpoch: BOARD + 360_000,
          boardRealtime: true,
          realtime: true
        }
      }
    )
    await store.run(quietReplanAccessLeg())
    const withLive = combos()[0].time
    await store.run(endGoMode())
    mockedFetch.mockClear()

    const scheduled = makeStore({ arriveOnTimeAccess: true })
    await scheduled.run(quietReplanAccessLeg())
    expect(minutesOfDay(withLive) - minutesOfDay(combos()[0].time)).toBe(6)
    await scheduled.run(endGoMode())
  })

  it('ignores a board epoch the feed is not actually predicting', async () => {
    // A non-realtime boardEpoch has been clamped forward to `now` by
    // clampNonLiveLegTimes, so believing it would set a deadline of about now
    // and silently disable the feature. The plan's own leg start is the
    // fallback, and it is the honest one.
    store = makeStore(
      { arriveOnTimeAccess: true },
      {
        1: {
          alightEpoch: ALIGHT,
          boardEpoch: NOW,
          boardRealtime: false,
          realtime: false
        }
      }
    )
    await store.run(quietReplanAccessLeg())
    expect(combos()[0].arriveBy).toBe(true)
  })

  it('asks the depart-now question rather than losing the scoped re-plan', async () => {
    // An arrive-by query that comes back empty must not drop the rider into
    // the full-trip fallback — that is where all three of 09-01's unwanted
    // swaps came from (6.12).
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [] })
    )
    store = makeStore({ arriveOnTimeAccess: true })
    await store.run(quietReplanAccessLeg())
    const asked = combos()
    expect(asked[0].arriveBy).toBe(true)
    expect(asked[1].arriveBy).toBe(false)
    expect(asked[1].to.name).toBe('I-35W & 98th St Station')
  })

  it('does not aim at a deadline the rider cannot make', async () => {
    // Bus in two minutes. Depart-now is the only honest question left.
    store = makeStore({ arriveOnTimeAccess: true }, {}, NOW + 120_000)
    await store.run(quietReplanAccessLeg())
    expect(combos()[0].arriveBy).toBe(false)
    expect(combos()).toHaveLength(1)
  })
})
