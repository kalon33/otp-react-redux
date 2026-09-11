import * as positionMatching from '../../../lib/util/go-mode/position-matching'
import {
  boardingItinerary,
  dwellAtBoardStop,
  FakeClock,
  installBoardClock,
  makeGoModeStore,
  rideAlongTransitLeg
} from '../../test-utils/go-mode-board-dwell'
import { endGoMode } from '../../../lib/actions/go-mode'
import {
  shouldTransitionToNextLeg,
  TRANSIT_BOARD_EARLY_MS,
  TRANSIT_BOARD_MAX_DISTANCE_M
} from '../../../lib/util/go-mode/position-matching'
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

/**
 * THE TRIP STEPPED ONTO THE BUS LEG BEFORE THE RIDER REACHED THE STOP
 * (2026-09-09 ride 1, backlog 13.1).
 *
 * 08:24:55.088 `TRANSITION_LEG {legIndex: 1}`, with the rider cycling at
 * 5.90 m/s, 59 m from I-35W & 98th St Station and 360 m of bike path short of
 * it — the leg's last stretch is the ramp over I-35W, which is why 59 m of
 * open ground was still 28 % of the leg. `SET_RIDING` (vehicle 1:8232, trip
 * 1:1346052) did not come until 08:27:31. In between, the current-leg card,
 * the progress bar and `nextStopName` all ran against the Orange Line for a
 * rider on a bicycle, and the rider wrote in at 08:26:21: *"Not even at the
 * stop yet and it thinks I'm on the bus."*
 *
 * Every gate the transition had passed honestly. The Hennepin bike trail runs
 * inside the I-35W busway corridor, so the projection onto the BUS leg was
 * 5.7 m — `isOnRoute`, well inside TRANSIT_BOARD_MAX_DISTANCE_M — and the live
 * board epoch 1788960360000 (08:26:00) had opened the five-minute window at
 * 08:21:00. What no gate asked was whether the rider had ARRIVED.
 *
 * Numbers below are the recorded ones, from the session's own action log
 * (`~/otp-debug-logs/debug-2026-09-09.jsonl`, session `mtu45mqw-co4i61`) and
 * from the ride fixtures `morning-orange-0817.json` (ride 1) and
 * `ride2-orange-0905.json` (ride 2, 09-09 09:05-09:46).
 */

const initialGoMode = goModeReducer(undefined, { type: '@@INIT' } as any)

/** The live board epoch the gate actually used: 08:26:00. */
const RIDE1_BOARD_EPOCH = 1788960360000
/** The tick that transitioned: 08:24:55.076 (fix) / .088 (dispatch). */
const RIDE1_TRANSITION_MS = 1788960295088
/** I-35W & 98th St Station — `legs[1].from`. */
const RIDE1_BOARD_STOP = { lat: 44.82569, lon: -93.290866 }

const rideOneBusLeg: any = {
  distance: 16257.19,
  endTime: 1788961497000,
  from: { ...RIDE1_BOARD_STOP, name: 'I-35W & 98th St Station' },
  mode: 'BUS',
  routeId: '1:904',
  startTime: 1788960447000,
  to: { lat: 44.948626, lon: -93.274662, name: 'I-35W & Lake St Station' },
  transitLeg: true
}

/** UPDATE_ROUTE_MATCH at 08:24:55.080 — the nomination that transitioned. */
const rideOneMatch: any = {
  distanceFromRoute: 5.735384679912459,
  isOnRoute: true,
  legIndex: 1,
  nearestPoint: [44.82622, -93.29094],
  progressAlongLeg: 0.003830562799520743,
  progressAlongSegment: 0,
  segmentIndex: 3
}

const rideOneGate = (over: any = {}) => ({
  // UPDATE_ROUTE_MATCH at 08:24:54.067, the last one that spoke about the
  // access leg: 71.88 % along it.
  accessLegProgress: 0.7187784336772175,
  boardEpoch: RIDE1_BOARD_EPOCH,
  isRiding: false,
  nowMs: RIDE1_TRANSITION_MS,
  // UPDATE_POSITION at 08:24:55.076.
  riderPosition: [44.826217424521104, -93.29086736645306] as [number, number],
  riderSpeedMps: 5.903992845194112,
  targetLeg: rideOneBusLeg,
  ...over
})

describe('13.1 — the boarding stop has to be REACHED, not just due', () => {
  it('the gates that existed all passed at 08:24:55', () => {
    // The refusal below is the new term and nothing else: on-route, 5.7 m from
    // the bus shape, and 65 s inside the board window.
    expect(rideOneMatch.isOnRoute).toBe(true)
    expect(rideOneMatch.distanceFromRoute).toBeLessThan(
      TRANSIT_BOARD_MAX_DISTANCE_M
    )
    expect(RIDE1_TRANSITION_MS).toBeGreaterThanOrEqual(
      RIDE1_BOARD_EPOCH - TRANSIT_BOARD_EARLY_MS
    )
  })

  // FAILS AGAINST UNFIXED SOURCE: true — the recorded TRANSITION_LEG of
  // 08:24:55, 2m36s before the rider was aboard.
  it('refuses a rider still cycling 59 m short of the platform', () => {
    expect(shouldTransitionToNextLeg(rideOneMatch, 0, rideOneGate())).toBe(
      false
    )
  })

  it('transitions the moment they stop at the platform (08:25:20)', () => {
    // Recorded: 22 m from the stop, 0.08 m/s. The matcher's own progress was
    // still lagging 300 m behind on the bike leg, so ARRIVAL, not progress, is
    // what releases this.
    expect(
      shouldTransitionToNextLeg(
        rideOneMatch,
        0,
        rideOneGate({
          nowMs: 1788960320000,
          riderPosition: [44.825888, -93.290862],
          riderSpeedMps: 0.08
        })
      )
    ).toBe(true)
  })

  it('a rider already aboard still outranks every arrival term', () => {
    expect(
      shouldTransitionToNextLeg(
        rideOneMatch,
        0,
        rideOneGate({ isRiding: true })
      )
    ).toBe(true)
  })

  it('callers that hand it no fix keep the behaviour they had', () => {
    // scripts/verify-*.js and the pinned pure cases pass the four original
    // gate fields; missing evidence is not evidence of anything.
    expect(
      shouldTransitionToNextLeg(rideOneMatch, 0, {
        boardEpoch: RIDE1_BOARD_EPOCH,
        isRiding: false,
        nowMs: RIDE1_TRANSITION_MS,
        targetLeg: rideOneBusLeg
      })
    ).toBe(true)
  })

  it('never strands a trip joined past its boarding stop', () => {
    // 25 % along the bus leg is where verify-leg-transition.js puts the rider
    // to prove the leg still advances — 4 km from the stop, and the arrival
    // question no longer applies. advanceToLeg is the only place vehicle
    // tracking starts, so a refusal here would cost the whole ride.
    expect(
      shouldTransitionToNextLeg(
        { ...rideOneMatch, progressAlongLeg: 0.25 },
        0,
        rideOneGate({ accessLegProgress: null })
      )
    ).toBe(true)
  })

  it('still refuses when the clock has not opened either', () => {
    expect(
      shouldTransitionToNextLeg(
        rideOneMatch,
        0,
        rideOneGate({ nowMs: RIDE1_BOARD_EPOCH - TRANSIT_BOARD_EARLY_MS - 1 })
      )
    ).toBe(false)
  })
})

/**
 * Ride 2 of the same morning, 09:14:39 — the boarding this must NOT touch.
 * TRANSITION_LEG at 09:14:39.061 and SET_RIDING (vehicle 1:8145, trip
 * 1:1268952) 2.0 s later: the rider was on the Orange Line as it pulled out of
 * I-35W & Lake St Station. Their speed at that tick was 5.14 m/s — faster than
 * ride 1's 5.90 was slow — which is why speed alone cannot decide this. What
 * separates the two rides is the access leg: 100 % (09:14:38) against 71.88 %.
 */
describe('13.1 — ride 2, the clean boarding, still transitions at once', () => {
  const busLeg: any = {
    distance: 16473,
    endTime: 1788964453000,
    from: { lat: 44.948118, lon: -93.274824, name: 'I-35W & Lake St Station' },
    mode: 'BUS',
    routeId: '1:904',
    startTime: 1788963311000,
    to: { lat: 44.82517, lon: -93.290862, name: 'I-35W & 98th St Station' },
    transitLeg: true
  }
  const match: any = {
    distanceFromRoute: 0.9347282873442113,
    isOnRoute: true,
    legIndex: 1,
    nearestPoint: [44.94806, -93.2748],
    progressAlongLeg: 0.00047245321480876676,
    progressAlongSegment: 1,
    segmentIndex: 1
  }

  it('transitions on the tick the ride actually transitioned', () => {
    expect(
      shouldTransitionToNextLeg(match, 0, {
        accessLegProgress: 1,
        boardEpoch: 1788963311000,
        isRiding: false,
        nowMs: 1788963279047,
        riderPosition: [44.94805162540313, -93.27480102916621],
        riderSpeedMps: 5.139888358319032,
        targetLeg: busLeg
      })
    ).toBe(true)
  })

  it('and on the tick before it, at 99.7 % of the access leg', () => {
    expect(
      shouldTransitionToNextLeg(match, 0, {
        accessLegProgress: 0.9966853186129613,
        boardEpoch: 1788963311000,
        isRiding: false,
        nowMs: 1788963277055,
        riderPosition: [44.94815650213768, -93.27481082482355],
        riderSpeedMps: 2.9770700164510338,
        targetLeg: busLeg
      })
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The term, through the tick that has to feed it.
//
// The gate is pure; what it judges is assembled in `handlePositionUpdate`, and
// a term nothing feeds is inert — which is how 6.36 got shipped with pure
// coverage only. The harness is the same one the board-gate tick tests use.
//
// NOT a replay of ride 1's own ticks, and deliberately so: what put the
// nomination in front of the gate at 08:24:55 was a leg-0 projection held
// 300 m behind the rider (71.88 % against a true 85 %), so the bus shape at
// 5.7 m beat a bike shape the continuity gate would not let advance. Replaying
// the fixes alone reproduces neither — the matcher tracks the rider correctly
// from a cold start and never nominates the bus leg at all. The recorded
// numbers are judged above, where they can be stated exactly; this is here to
// prove the tick hands them over.
// ---------------------------------------------------------------------------

describe('13.1 — the tick feeds the gate what it judges', () => {
  const BOARD_TIME = Date.UTC(2026, 8, 9, 13, 26, 0)
  let clock: FakeClock

  const liveStore = () =>
    makeGoModeStore({
      activeItinerary: boardingItinerary(BOARD_TIME),
      isActive: true,
      tracking: { ...initialGoMode.tracking, isTracking: true }
    })

  beforeEach(() => {
    // The trip session is module state — `lastTransitionedLegIndex` included.
    makeGoModeStore({ isActive: true }).run(endGoMode())
    clock = installBoardClock(BOARD_TIME - 90_000)
  })

  afterEach(() => {
    makeGoModeStore({ isActive: true }).run(endGoMode())
    clock.uninstall()
    jest.restoreAllMocks()
  })

  it("hands it the rider's fix, their speed and the access-leg progress", async () => {
    const spy = jest.spyOn(positionMatching, 'shouldTransitionToNextLeg')
    const store = liveStore()
    await dwellAtBoardStop(store, clock, { totalMs: 70_000 })
    await rideAlongTransitLeg(store, clock)

    const onTheBusLeg = spy.mock.calls.filter(
      ([, , gate]: any) => gate?.targetLeg?.transitLeg
    )
    expect(onTheBusLeg.length).toBeGreaterThan(0)

    const gate: any = onTheBusLeg[0][2]
    expect(gate.riderPosition).toEqual([expect.any(Number), expect.any(Number)])
    expect(typeof gate.riderSpeedMps).toBe('number')
    // The rider is at their boarding stop, so the access leg is run out — the
    // number that separated ride 2 from ride 1.
    expect(gate.accessLegProgress).toBeGreaterThan(0.9)
  })

  it('and the ordinary boarding still advances the leg, once', async () => {
    const store = liveStore()
    await dwellAtBoardStop(store, clock, { totalMs: 70_000 })
    await rideAlongTransitLeg(store, clock)

    const transitions = store
      .actions()
      .filter((a: any) => a.type === 'TRANSITION_LEG')
    expect(transitions.map((a: any) => a.payload.legIndex)).toEqual([1])
    expect(store.getGoMode().riding?.legIndex).toBe(1)
  })
})
