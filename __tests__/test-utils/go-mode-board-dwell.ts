import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import { handlePositionUpdate } from '../../lib/actions/go-mode'
import goModeReducer from '../../lib/reducers/go-mode'

/**
 * A rider who WAITS at their boarding stop and then rides away on the bus,
 * driven through the real `handlePositionUpdate`.
 *
 * Why this exists (backlog 6.36). Since 6.1 the GPS-only half of the board
 * gate needs three things at once — a tight projection, a sound fix, and
 * `BOARD_STOP_DWELL_MIN_MS` (60 s) of dwell inside `BOARD_STOP_DWELL_RADIUS_M`
 * of the leg's boarding stop. The dwell is not a function of one fix: it is
 * accumulated ON THE TICK, in `session.boardStopDwell`, from the *wall clock*
 * (`getCurrentTime()`), in steps capped at `BOARD_STOP_DWELL_MAX_STEP_MS`.
 *
 * That is why `false-board-0901.ts` and `boarding-confirmation-0901.ts` both
 * test the decision PURELY, calling `decideRiding` with a hand-written
 * `boardStopDwellMs`: a jest case cannot spend a real minute at a stop, and
 * `jest.spyOn(Date, 'now')` does not reach `new Date()`, which is what
 * `getCurrentTime` actually calls. So nothing exercised the gate — or 6.10c's
 * denial hold, which lives at the DISPATCH site and not in `decideRiding` at
 * all — through the tick that has to enforce it.
 *
 * The missing piece is a fake clock over `Date` itself. With one, sixty
 * seconds of standing at the platform costs six ticks, and the rest of the
 * tick — the matcher, the leg transition, `trackBoardStopDwell`'s latch, the
 * `ridingSuppressedByRider` guard — runs for real.
 *
 * `toFake: ['Date']` and nothing else on purpose: `startVehicleTracking` arms
 * a `setInterval` on any transit-leg transition, and faking timers as well
 * would leave the suite holding a clock that job never gets to run on.
 */

/** Access-leg origin, ~1.4 km short of the platform. */
export const ORIGIN: [number, number] = [44.9, -93.3]
/** The boarding stop: where the bike leg ends and the bus leg begins. */
export const BOARD_STOP: [number, number] = [44.91, -93.29]
/** The alighting stop, ~7.8 km up the line on a different bearing. */
export const DEST: [number, number] = [44.96, -93.22]

/** The stop id the bus leg boards at, matching `vehicleReachedBoardStop`. */
export const BOARD_STOP_ID = '1:56831'
export const ROUTE_ID = '1:904'

/**
 * Bike access leg into a bus leg — the shape every recorded false board has,
 * and the only shape in which the dwell gate means anything.
 */
export const boardingItinerary = (boardTimeMs: number): any => ({
  duration: 3000,
  endTime: boardTimeMs + 1_800_000,
  legs: [
    {
      distance: 1370,
      duration: 1200,
      endTime: boardTimeMs,
      from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Origin' },
      legGeometry: { points: encode([ORIGIN, BOARD_STOP]) },
      mode: 'BICYCLE',
      startTime: boardTimeMs - 1_200_000,
      to: {
        lat: BOARD_STOP[0],
        lon: BOARD_STOP[1],
        name: 'I-35W & 98th St Station',
        stopId: BOARD_STOP_ID
      },
      transitLeg: false
    },
    {
      distance: 7830,
      duration: 1800,
      endTime: boardTimeMs + 1_800_000,
      from: {
        lat: BOARD_STOP[0],
        lon: BOARD_STOP[1],
        name: 'I-35W & 98th St Station',
        stop: { gtfsId: BOARD_STOP_ID },
        stopId: BOARD_STOP_ID
      },
      legGeometry: { points: encode([BOARD_STOP, DEST]) },
      mode: 'BUS',
      routeId: ROUTE_ID,
      routeShortName: 'METRO Orange Line',
      startTime: boardTimeMs,
      to: { lat: DEST[0], lon: DEST[1], name: 'Alight stop' },
      transitLeg: true
    }
  ],
  startTime: boardTimeMs - 1_200_000
})

/** A point `fraction` of the way from the boarding stop to the alight stop. */
export const alongTransitLeg = (fraction: number): [number, number] => [
  BOARD_STOP[0] + (DEST[0] - BOARD_STOP[0]) * fraction,
  BOARD_STOP[1] + (DEST[1] - BOARD_STOP[1]) * fraction
]

export const fixAt = (
  [lat, lon]: [number, number],
  timestamp: number,
  over: { accuracy?: number; speed?: number } = {}
): GeolocationPosition =>
  ({
    coords: {
      accuracy: over.accuracy ?? 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: lat,
      longitude: lon,
      speed: over.speed ?? 0
    },
    timestamp
  } as GeolocationPosition)

const initial = goModeReducer(undefined, { type: '@@INIT' } as any)

export interface DwellStore {
  actions: () => any[]
  getGoMode: () => any
  run: (thunk: any) => any
  types: () => string[]
}

/** Real reducer, thunks executed, every action recorded. */
export const makeGoModeStore = (goModeOverrides: any = {}): DwellStore => {
  let goModeState: any = { ...initial, ...goModeOverrides }
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
    goModeState = goModeReducer(goModeState, action)
    return action
  }
  return {
    actions: () => actions,
    getGoMode: () => goModeState,
    run: (thunk: any) => thunk(dispatch, getState),
    types: () => actions.map((a) => a.type)
  }
}

export type FakeClock = ReturnType<typeof FakeTimers.install>

/** A clock `getCurrentTime()` actually reads — `new Date()`, not `Date.now`. */
export const installBoardClock = (nowMs: number): FakeClock =>
  FakeTimers.install({ now: nowMs, toFake: ['Date'] })

/**
 * Stand at the platform. One tick every `stepMs` (≤
 * `BOARD_STOP_DWELL_MAX_STEP_MS`, or the step is clipped and the wait is
 * undercounted), for `totalMs` of clock time, at walking-pace speeds — which
 * is what a rider waiting for a bus looks like to the tick.
 */
export async function dwellAtBoardStop(
  store: DwellStore,
  clock: FakeClock,
  { stepMs = 10_000, totalMs = 70_000 }: { stepMs?: number; totalMs?: number }
): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await store.run(
      handlePositionUpdate(
        // A metre of GPS wander, so the fixes are not byte-identical.
        fixAt(
          [BOARD_STOP[0] + 0.00001 * (elapsed % 3), BOARD_STOP[1]],
          Date.now(),
          { speed: 0.3 }
        )
      )
    )
    clock.tick(stepMs)
  }
}

/**
 * Ride away up the transit leg. The fractions default past
 * `RIDING_MIN_PROGRESS` (5%) — below it no GPS establishment is possible at
 * all, dwell or no dwell.
 */
export async function rideAlongTransitLeg(
  store: DwellStore,
  clock: FakeClock,
  {
    fractions = [0.015, 0.03, 0.045, 0.06, 0.075],
    speed = 12,
    stepMs = 10_000
  }: { fractions?: number[]; speed?: number; stepMs?: number } = {}
): Promise<void> {
  for (const fraction of fractions) {
    await store.run(
      handlePositionUpdate(
        fixAt(alongTransitLeg(fraction), Date.now(), { speed })
      )
    )
    clock.tick(stepMs)
  }
}
