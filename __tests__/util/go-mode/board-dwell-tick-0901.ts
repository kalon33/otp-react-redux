import { BOARDING_DENIAL_HOLD_MS } from '../../../lib/util/go-mode/boarding-confirmation'
import {
  boardingItinerary,
  dwellAtBoardStop,
  FakeClock,
  installBoardClock,
  makeGoModeStore,
  rideAlongTransitLeg
} from '../../test-utils/go-mode-board-dwell'
import { denyBoardingByRider, endGoMode } from '../../../lib/actions/go-mode'
import goModeReducer from '../../../lib/reducers/go-mode'

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

const initial = goModeReducer(undefined, { type: '@@INIT' } as any)

/**
 * The board gate and the rider's denial of it, AT THE TICK (backlog 6.36).
 *
 * Both were shipped with pure coverage only. `false-board-0901.ts` calls
 * `decideRiding` with a hand-written `boardStopDwellMs`, and
 * `boarding-confirmation-0901.ts` calls `ridingSuppressedByRider` directly —
 * so neither could say whether `handlePositionUpdate` actually accumulates the
 * dwell it hands to the decision, nor whether the suppression is consulted
 * where `SET_RIDING` is dispatched. Those are the two joins the 2026-09-01
 * false boards went through, and they were the untested part.
 *
 * The harness (`test-utils/go-mode-board-dwell`) is shared so `false-board`'s
 * own cases can be driven the same way; see its header for why a fake `Date`
 * is what was missing.
 */
describe('the board gate through handlePositionUpdate (2026-09-01)', () => {
  const BOARD_TIME = Date.UTC(2026, 8, 1, 13, 30, 0)
  let clock: FakeClock

  const liveStore = () =>
    makeGoModeStore({
      activeItinerary: boardingItinerary(BOARD_TIME),
      isActive: true,
      tracking: { ...initial.tracking, isTracking: true }
    })

  beforeEach(() => {
    // The trip session is module state: the dwell accumulator, the transition
    // guard and `riderDeniedBoardingAtMs` all live on it and none of them is
    // reset between cases. endGoMode is what a page actually does, and it
    // replaces the whole session — so every case below starts from a virgin
    // one, whatever its neighbours did.
    makeGoModeStore({ isActive: true }).run(endGoMode())
    clock = installBoardClock(BOARD_TIME - 90_000)
  })

  afterEach(() => {
    makeGoModeStore({ isActive: true }).run(endGoMode())
    clock.uninstall()
  })

  // -------------------------------------------------------------------------
  // 6.1 — the gate itself
  // -------------------------------------------------------------------------

  it('does not board a rider who never waited at the stop', async () => {
    // Straight onto the line and away: tight to the shape, an 8 m fix, past
    // RIDING_MIN_PROGRESS — everything the pre-6.1 gate asked for. This is a
    // cyclist overtaking the bus route, which is what 2026-09-01 ride 2 was.
    const store = liveStore()
    await rideAlongTransitLeg(store, clock)

    expect(store.types()).not.toContain('SET_RIDING')
    expect(store.getGoMode().riding).toBeNull()
  })

  it('boards a rider who waited a minute at the stop and then moved off along the route', async () => {
    const store = liveStore()
    await dwellAtBoardStop(store, clock, { totalMs: 70_000 })
    // Nothing yet: standing at the platform is not being aboard.
    expect(store.types()).not.toContain('SET_RIDING')

    await rideAlongTransitLeg(store, clock)

    expect(store.types()).toContain('SET_RIDING')
    expect(store.getGoMode().riding?.legIndex).toBe(1)
  })

  it('a wait that stops short of the minute is not a wait', async () => {
    // 40 s — well inside BOARD_STOP_DWELL_MIN_MS, so the latch never arms and
    // leaving the stop discards it.
    const store = liveStore()
    await dwellAtBoardStop(store, clock, { totalMs: 40_000 })
    await rideAlongTransitLeg(store, clock)

    expect(store.types()).not.toContain('SET_RIDING')
  })

  // -------------------------------------------------------------------------
  // 6.10c — the rider's denial, at the dispatch site
  // -------------------------------------------------------------------------

  it('holds off an evidence-free boarding for three minutes after the rider says no', async () => {
    const store = liveStore()
    await dwellAtBoardStop(store, clock, { totalMs: 70_000 })

    // "Not on the bus" — the trip-sheet chip, tapped at the platform.
    store.run(denyBoardingByRider())
    const denialIndex = store.types().length

    await rideAlongTransitLeg(store, clock)

    // The decision itself still says 'set'; what must not happen is the
    // dispatch. Assert on the actions AFTER the tap, so the CLEAR_RIDING the
    // denial itself dispatches cannot be mistaken for the answer.
    expect(store.types().slice(denialIndex)).not.toContain('SET_RIDING')
    expect(store.getGoMode().riding).toBeNull()
  })

  it('lets the same evidence board the rider once the hold has expired', async () => {
    const store = liveStore()
    await dwellAtBoardStop(store, clock, { totalMs: 70_000 })

    store.run(denyBoardingByRider())
    const denialIndex = store.types().length

    // Past BOARDING_DENIAL_HOLD_MS. The dwell latch survives it (a completed
    // wait is a fact about the leg, not a condition to keep satisfying), so
    // the evidence reaching the gate is identical to the case above.
    clock.tick(BOARDING_DENIAL_HOLD_MS + 30_000)
    await rideAlongTransitLeg(store, clock)

    expect(store.types().slice(denialIndex)).toContain('SET_RIDING')
    expect(store.getGoMode().riding?.legIndex).toBe(1)
  })
})
