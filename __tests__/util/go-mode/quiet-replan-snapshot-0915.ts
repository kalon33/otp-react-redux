import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import { endGoMode, quietReplanAccessLeg } from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import { isTripRecordingEnabled } from '../../../lib/util/debug-log'
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

jest.mock('../../../lib/util/debug-log', () => ({
  ...jest.requireActual('../../../lib/util/debug-log'),
  isTripRecordingEnabled: jest.fn(() => true)
}))

const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
const mockedRecording = isTripRecordingEnabled as jest.Mock

/**
 * 2026-09-15, backlog 13.8 (second sighting) — the ride installed NINE
 * itinerary swaps, every one of them out of `quietReplanAccessLeg`, and the
 * fixture's `onboardCandidatePlans` held ZERO of the requests behind them.
 *
 * `fetchOnboardCandidatePlan` hands the raw payload back "for trip recording",
 * but only the onboard alight optimizer's caller ever dispatched
 * ONBOARD_CANDIDATE_SNAPSHOT; the quiet re-plan's two call sites dispatched
 * nothing, so the fetch resolved through its local promise and vanished. That
 * is why what OTP offered just before the 09:43:37 backwards splice (16.2) is
 * unknowable, and why the daemon's `replan-not-converging` rule has been
 * counting an event nothing emits (it saw `replansSinceGain: 0` where the
 * client had 3).
 *
 * Both call sites now record. The 16.2 guard is exercised here too, because
 * the recording has to happen whether or not the plan is accepted — a refused
 * plan is precisely the one a later session needs to see.
 */

const NOW = 1789483380000 // 2026-09-15 09:43:00 America/Chicago
const BOARD = 1789484042000 // 09:54:02
const ALIGHT = 1789485385000 // 10:16:25
const ACCESS_OK = 1789483980000 // 09:53:00 — reaches the stop in time
const ACCESS_LATE = 1789484227000 // 09:57:07 — swap #5's bike leg

const RIDER: [number, number] = [44.85773, -93.24118]
const STOP: [number, number] = [44.85472, -93.24276]
const DEST: [number, number] = [44.9739, -93.2673]

const bike = (endTime: number) => ({
  distance: 1173,
  duration: (endTime - NOW) / 1000,
  endTime,
  from: { lat: RIDER[0], lon: RIDER[1], name: 'Current location' },
  legGeometry: { points: encode([RIDER, STOP]) },
  mode: 'BICYCLE',
  startTime: NOW,
  to: { lat: STOP[0], lon: STOP[1], name: '98th St Station' },
  transitLeg: false
})

const bus = {
  distance: 12800,
  duration: (ALIGHT - BOARD) / 1000,
  endTime: ALIGHT,
  from: { lat: STOP[0], lon: STOP[1], name: '98th St Station' },
  legGeometry: { points: encode([STOP, DEST]) },
  mode: 'BUS',
  route: { gtfsId: '1:904' },
  startTime: BOARD,
  to: { lat: DEST[0], lon: DEST[1], name: 'Nicollet Mall' },
  transitLeg: true
}

/** bike -> Orange Line: the shape the SCOPED re-plan is built for. */
const transitPlan = () => ({
  duration: (ALIGHT - NOW) / 1000,
  endTime: ALIGHT,
  legs: [bike(ACCESS_OK), bus],
  startTime: NOW
})

/** An all-bike access itinerary, as the scoped (mode-restricted) query returns. */
const accessItinerary = (endTime: number) => ({
  duration: (endTime - NOW) / 1000,
  endTime,
  legs: [bike(endTime)],
  startTime: NOW
})

/** bike-only to the destination: no boarding ahead, so the FULL path runs. */
const bikeOnlyPlan = () => ({
  duration: 300,
  endTime: NOW + 300000,
  legs: [
    {
      distance: 560,
      duration: 300,
      endTime: NOW + 300000,
      from: { lat: RIDER[0], lon: RIDER[1], name: 'Current location' },
      legGeometry: { points: encode([RIDER, DEST]) },
      mode: 'BICYCLE',
      startTime: NOW,
      to: { lat: DEST[0], lon: DEST[1], name: 'Home' },
      transitLeg: false
    }
  ],
  startTime: NOW
})

const fix = (at: [number, number]): GeolocationPosition =>
  ({
    coords: {
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: at[0],
      longitude: at[1],
      speed: 4.2
    },
    timestamp: NOW
  } as GeolocationPosition)

const initial = goMode(undefined, { type: '@@INIT' })

const makeStore = (itinerary: any) => {
  let goModeState: any = {
    ...initial,
    activeItinerary: itinerary,
    isActive: true,
    routeMatch: { legIndex: 0, progressAlongLeg: 0.4 },
    tracking: { ...initial.tracking, lastPosition: fix(RIDER) }
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
    activeItinerary: () => goModeState.activeItinerary,
    run: (thunk: any) => thunk(dispatch, getState),
    snapshots: () =>
      actions.filter((a) => a.type === 'ONBOARD_CANDIDATE_SNAPSHOT'),
    types: () => actions.map((a) => a.type)
  }
}

/** What OTP actually answered, as fetchOnboardCandidatePlan hands it back. */
const answer = (itineraries: any[]) => ({
  error: false,
  itineraries,
  query:
    'query Plan($from: InputCoordinates!) { plan { itineraries { duration } } }',
  response: { data: { plan: { itineraries } } },
  variables: { fromPlace: `${RIDER[0]},${RIDER[1]}` }
})

describe('the quiet access re-plan records the plans it acts on (13.8)', () => {
  let clock: FakeTimers.InstalledClock | undefined
  let store: ReturnType<typeof makeStore> | undefined

  beforeEach(() => {
    mockedFetch.mockReset()
    mockedRecording.mockReset()
    mockedRecording.mockReturnValue(true)
    clock = FakeTimers.install({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    // The re-plan cooldown is TripSession state, so every case is its own trip.
    store?.run(endGoMode())
    store = undefined
    clock?.uninstall()
    clock = undefined
  })

  const run = async (itinerary: any, offered: any[]) => {
    mockedFetch.mockReturnValue(() => Promise.resolve(answer(offered)))
    store = makeStore(itinerary)
    await store.run(quietReplanAccessLeg())
    return store
  }

  it('dispatches the snapshot from the SCOPED path, tagged quiet-replan-scoped', async () => {
    const s = await run(transitPlan(), [accessItinerary(ACCESS_OK)])
    const snaps = s.snapshots()
    expect(snaps).toHaveLength(1)
    expect(snaps[0].payload.request.reason).toBe('quiet-replan-scoped')
    // Request AND response AND tMs — the same three the optimizer records, so
    // build-fixture and the size ladder need no new case.
    expect(snaps[0].payload.request.query).toContain('query Plan')
    expect(snaps[0].payload.request.variables).toEqual({
      fromPlace: `${RIDER[0]},${RIDER[1]}`
    })
    expect(snaps[0].payload.request.to.name).toBe('98th St Station')
    expect(snaps[0].payload.response.data.plan.itineraries).toHaveLength(1)
    expect(snaps[0].payload.tMs).toBe(NOW)
    // No stopId: this is not an alight candidate, and build-fixture keys the
    // optimizer's series on that field.
    expect(snaps[0].payload.request.stopId).toBeUndefined()
    // This one is feasible, so it is also applied.
    expect(s.types()).toContain('START_GO_MODE')
  })

  it('dispatches the snapshot from the FULL path, tagged quiet-replan-full', async () => {
    // No boarding ahead (bike straight home), so the scoped path is skipped
    // and the full-trip fallback runs.
    const s = await run(bikeOnlyPlan(), [
      {
        duration: 200,
        endTime: NOW + 200000,
        legs: [
          {
            distance: 520,
            duration: 200,
            endTime: NOW + 200000,
            from: { lat: RIDER[0], lon: RIDER[1], name: 'Current location' },
            legGeometry: { points: encode([RIDER, DEST]) },
            mode: 'BICYCLE',
            startTime: NOW,
            to: { lat: DEST[0], lon: DEST[1], name: 'Home' },
            transitLeg: false
          }
        ],
        startTime: NOW
      }
    ])
    const snaps = s.snapshots()
    expect(snaps).toHaveLength(1)
    expect(snaps[0].payload.request.reason).toBe('quiet-replan-full')
    expect(snaps[0].payload.request.to.name).toBe('Home')
    expect(s.types()).toContain('START_GO_MODE')
  })

  it('records the plan even when the 16.2 guard refuses it', async () => {
    // Swap #5: a bike leg ending 09:57:07 spliced onto a 09:54:02 departure.
    // The refusal is the whole point of recording — an unrecorded refusal is
    // exactly the hole 13.8 describes.
    const s = await run(transitPlan(), [accessItinerary(ACCESS_LATE)])
    expect(s.snapshots()).toHaveLength(1)
    expect(s.snapshots()[0].payload.request.reason).toBe('quiet-replan-scoped')
    expect(s.types()).not.toContain('START_GO_MODE')
    // The rider keeps the plan they had.
    expect(s.activeItinerary().legs[0].endTime).toBe(ACCESS_OK)
  })

  it('records nothing when trip recording is off', async () => {
    // These are full-capture payloads (up to 1 MB each) uploaded from a phone
    // on cellular, and a quiet re-plan is far more frequent than an optimize.
    mockedRecording.mockReturnValue(false)
    const s = await run(transitPlan(), [accessItinerary(ACCESS_OK)])
    expect(s.snapshots()).toHaveLength(0)
    expect(s.types()).toContain('START_GO_MODE')
  })
})
