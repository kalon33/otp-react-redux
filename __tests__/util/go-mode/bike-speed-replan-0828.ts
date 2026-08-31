import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import {
  endGoMode,
  handlePositionUpdate,
  quietReplanAccessLeg
} from '../../../lib/actions/go-mode'
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
 * 2026-08-28 — "the most rider-visible open item".
 *
 * Every access re-plan of that day re-derived the bike leg at OTP's default
 * speed while the rider was measurably doing 5.6–7.8 m/s. `riderSpeedMps` was
 * read off every fix and spent only on local heuristics (riding establishment,
 * missed-bus, turn-cue lead) — it never reached a plan query, so the transit
 * suffix spliced onto each re-planned bike leg was sequenced for an arrival at
 * the boarding stop the rider beat every time. Three backwards trip sheets.
 *
 * The fix routes an OBSERVED (rolling, median-of-moving) speed through
 * `routingPreferences` — the channel applyRoutingPreferences merges after
 * generateOtp2Query, which is the only one a lever the default planQuery does
 * not declare survives.
 */

// A bike leg heading due east, then a bus. Far enough from the destination that
// nothing here trips the arrival latch.
const ORIGIN: [number, number] = [44.95, -93.29]
const STOP: [number, number] = [44.95, -93.27]
const DEST: [number, number] = [44.95, -93.2]

const trip = () => ({
  duration: 3000,
  endTime: 0,
  legs: [
    {
      distance: 1576,
      duration: 300,
      endTime: 0,
      from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Home' },
      legGeometry: { points: encode([ORIGIN, STOP]) },
      mode: 'BICYCLE',
      startTime: 0,
      to: { lat: STOP[0], lon: STOP[1], name: 'Knox & 76th' },
      transitLeg: false
    },
    {
      distance: 5500,
      duration: 1200,
      endTime: 0,
      from: { lat: STOP[0], lon: STOP[1], name: 'Knox & 76th' },
      legGeometry: { points: encode([STOP, DEST]) },
      mode: 'BUS',
      routeId: '1:904',
      startTime: 0,
      to: { lat: DEST[0], lon: DEST[1], name: 'Downtown' },
      transitLeg: true
    }
  ],
  startTime: 0
})

const fixAt = (
  lon: number,
  timestamp: number,
  speed: number | null
): GeolocationPosition =>
  ({
    coords: {
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: ORIGIN[0],
      longitude: lon,
      speed
    },
    timestamp
  } as GeolocationPosition)

/**
 * Minimal store, the shape arrival-quiesce-0828 uses. Nested thunks are dropped
 * while the rider is riding — handlePositionUpdate dispatches several (live
 * times, leg advance, poll restart) and none is under test — and run while the
 * re-plan is, since that is where the mocked plan fetch lives.
 */
const makeStore = (currentQuery: any = {}) => {
  let runThunks = false
  let goModeState: any = {
    ...initial,
    activeItinerary: trip(),
    isActive: true,
    routeMatch: { legIndex: 0, progressAlongLeg: 0 },
    tracking: { ...initial.tracking, lastPosition: fixAt(-93.29, 0, 6.5) }
  }
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery,
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') {
      return runThunks ? action(dispatch, getState) : undefined
    }
    actions.push(action)
    goModeState = goMode(goModeState, action)
    return action
  }
  return {
    getState,
    run: (thunk: any) => thunk(dispatch, getState),
    setRunThunks: (on: boolean) => {
      runThunks = on
    },
    types: () => actions.map((a) => a.type)
  }
}

/**
 * Ride the first third of the bike leg: `count` fixes `stepMs` apart, each
 * carrying `speed`. Returns the timestamp of the last fix.
 */
const rideTheBikeLeg = (
  store: ReturnType<typeof makeStore>,
  startMs: number,
  speeds: (number | null)[],
  stepMs = 12000
): number => {
  let t = startMs
  speeds.forEach((speed, i) => {
    t = startMs + i * stepMs
    store.run(handlePositionUpdate(fixAt(-93.29 + i * 0.0004, t, speed)))
  })
  return t
}

describe('bike time a re-plan can believe (2026-08-28)', () => {
  // The rolling buffer, the re-plan cooldown and the destination-progress
  // tracker are all TripSession state, which outlives a store but not a trip —
  // so each case is its own trip, ended the way the rider ends one.
  let clock = 1_756_400_000_000
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

  const runReplanAfterRiding = async (
    speeds: (number | null)[],
    currentQuery: any = {}
  ) => {
    store = makeStore(currentQuery)
    const last = rideTheBikeLeg(store, clock, speeds)
    dateFaker?.setSystemTime(last)
    store.setRunThunks(true)
    await store.run(quietReplanAccessLeg())
    return mockedFetch.mock.calls[0]?.[0]
  }

  it('tells OTP the pace the rider is actually keeping', async () => {
    const scoped = await runReplanAfterRiding(new Array(12).fill(6.5))
    expect(scoped.modes).toEqual([{ mode: 'BICYCLE' }])
    // Unfixed, this whole key is absent and the bike leg is re-derived at
    // OTP's default while the rider does 6.5 m/s.
    expect(scoped.routingPreferences?.bikeSpeed).toBeCloseTo(6.5, 5)
  })

  it('does not quote the red light it was stopped at', async () => {
    // The naive version of this fix — hand OTP `position.coords.speed` — routes
    // a 0 m/s (clamped to 2) cyclist whenever a re-plan lands at a junction.
    // Half this ride is stopped; the answer is still the cruising pace.
    const speeds = [7, 7, 0, 0, 7, 0, 7, 7, 0, 7, 0, 7, 7, 7]
    const scoped = await runReplanAfterRiding(speeds)
    expect(scoped.routingPreferences?.bikeSpeed).toBeCloseTo(7, 5)
  })

  it('says nothing at all until it has watched the rider ride', async () => {
    // Three fixes is an anecdote. Better to let OTP use its own default than to
    // quote a number from a moment.
    const scoped = await runReplanAfterRiding([6.5, 6.5, 6.5])
    expect(scoped.routingPreferences).toBeUndefined()
  })

  it('leaves a speed the rider chose alone', async () => {
    // bike-forward's 5.5. An explicit choice outranks an observation, however
    // well evidenced — the other levers still ride along untouched.
    const scoped = await runReplanAfterRiding(new Array(12).fill(7.4), {
      routingPreferences: { bikeReluctance: 0.6, bikeSpeed: 5.5 }
    })
    expect(scoped.routingPreferences).toEqual({
      bikeReluctance: 0.6,
      bikeSpeed: 5.5
    })
  })

  it('fills an unset lever on a profile that names no speed', async () => {
    // stay-seated and the rest set transfer levers only; there is nothing to
    // overrule, so the observation lands beside them.
    const scoped = await runReplanAfterRiding(new Array(12).fill(6.2), {
      routingPreferences: { transferPenalty: 600, waitReluctance: 4 }
    })
    expect(scoped.routingPreferences.bikeSpeed).toBeCloseTo(6.2, 5)
    expect(scoped.routingPreferences.transferPenalty).toBe(600)
    expect(scoped.routingPreferences.waitReluctance).toBe(4)
  })

  it('cannot put an absurd number in a plan query', async () => {
    // A multipath burst reading 30 m/s never reaches the buffer at all, and a
    // whole ride of e-bike speeds still clamps to the lever range [2, 8].
    const scoped = await runReplanAfterRiding(new Array(12).fill(11.5))
    expect(scoped.routingPreferences?.bikeSpeed).toBe(8)
  })
})
