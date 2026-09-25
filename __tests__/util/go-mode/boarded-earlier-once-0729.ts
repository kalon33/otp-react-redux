/* globals afterEach, describe, expect, it, jest */
import '../../test-utils/mock-window-url'

import { applyMiddleware, combineReducers, createStore } from 'redux'
import FakeTimers from '@sinonjs/fake-timers'
import thunk from 'redux-thunk'

import * as replanAcceptance from '../../../lib/util/go-mode/replan-acceptance'
import * as transitTrust from '../../../lib/util/go-mode/transit-trust'
import {
  PLAN_RUN_LEFT_SLACK_MS,
  planRunLeftBeforeRider
} from '../../../lib/util/go-mode/replan-acceptance'
import { replayTrip, stopReplay } from '../../../lib/actions/go-mode'
import { ridingTransitLegIndex } from '../../../lib/util/go-mode/riding'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'

/**
 * jest maps `*.graphql` to an empty string, so core-utils' `generateOtp2Query`
 * cannot `print()` its default document — and this replay runs the quiet and
 * missed-bus re-plans for real. Same stub as plan-fan-out.ts.
 */
jest.mock('@opentripplanner/core-utils', () => {
  const actual = jest.requireActual('@opentripplanner/core-utils')
  const { parse } = jest.requireActual('graphql')
  const stub = parse('query Plan { plan { itineraries { duration } } }')
  const core = actual.default || actual
  const patched = {
    ...core,
    queryGen: {
      ...core.queryGen,
      generateOtp2Query: (params: unknown) =>
        core.queryGen.generateOtp2Query(params, stub)
    }
  }
  return { ...actual, __esModule: true, default: patched }
})

/**
 * BACKLOG 25.8 / 28.6 / 28.7 — the 0729 boarded-earlier re-plans, replayed
 * deterministically at fixed speeds.
 *
 * The nightly's `verify-transit-trust` (b) went red 09-18 -> 09-24 on three
 * `autoApply` `boarded-earlier` searches once aboard (09-23: 17:27:52,
 * 17:35:14, 17:41:31) and no itinerary swap. This runs the same fixture
 * through the real store, the real replay engine (`replayTrip`: every OTP read
 * served from the recording) and the real position tick, with the verify
 * script's one hand-reconstructed state (the "tracking reset") reproduced.
 *
 * Measured 2026-09-23 (25.8, `3328efd88`) and re-measured on this branch
 * before the 28.6 fix (main `a964e819b` + the harness):
 *
 *  - The trigger is one standing fact, not something a re-plan re-arms: the
 *    plan in hand still names the 17:08:29 run `1:1171228` — the bus the rider
 *    MISSED — while the rider is verifiably on `1:1173133` / `1:8140`
 *    (`riding.boardedAt` 17:27:50). Every gate yes is the `tripMismatch`
 *    disjunct; `aboardBeforePlanned` never fires (liveLegTimes is empty under
 *    replay, so it reads 17:08:29).
 *  - Each re-plan built the splice onto the ridden trip and `acceptAutoReplan`
 *    refused it `arrives-later` against the plan's 17:40:00 — an arrival on a
 *    bus that left 19 minutes before the rider boarded. Three is
 *    `EARLY_BOARD_REPLAN_MAX_ATTEMPTS`; the spacing is
 *    `EARLY_BOARD_REPLAN_RETRY_MS`, 60 s of WALL clock (`Date.now()`).
 *  - Whether the rider reaches the bus on the dead plan at all is also a
 *    wall-clock question: the missed-bus auto-update retries on `Date.now()`.
 *    At 1x (the phone) and 8x it lands at 17:20:27 and 17:24:43, the plan
 *    names `1:1173133` before boarding and nothing fires aboard. At 6x and 25x
 *    it does not, and the rider boards on the dead plan.
 *    Before the fix: 1x 0, 6x 3 refused, 8x 0, 25x 1 refused.
 *
 * 28.6: `replanFromAboard` now passes `currentPlanIsDead` when the plan leg the
 * splice replaces boarded (live board time, else `startTime`) more than
 * `PLAN_RUN_LEFT_SLACK_MS` before `riding.boardedAt` — `planRunLeftBeforeRider`.
 * After: 1x 0, 6x ONE accepted swap onto `1:1173133`, 8x 0, 25x one. Riding
 * and the vehicle never move, the one push is TRIP_UPDATED, and with the plan
 * naming the ridden bus the gate has nothing left to see.
 *
 * 28.7: this file is the deterministic form of verify-transit-trust (b): the
 * browser run cannot pin its speed (it asks 25x and gets ~6x), this can.
 *
 * The splice builder dates the bus leg on the tick clock (`getCurrentTime`),
 * not `Date.now()` — identical on a phone; under this replay the accepted plan
 * was otherwise dated two months after the ride ("arriving in 80320 min").
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fx: any = require('../../../lib/util/go-mode/replay/fixtures/orange-line-0729.json')

const CONFIG = {
  api: { host: 'http://mock-host.com', path: '/api', port: 80 },
  homeTimezone: 'America/Chicago',
  itinerary: {},
  modes: {
    initialState: { enabledModeButtons: ['transit', 'bicycle'] },
    modeButtons: [
      { key: 'transit', modes: [{ mode: 'TRANSIT' }] },
      { key: 'bicycle', modes: [{ mode: 'BICYCLE' }] }
    ],
    transitModes: []
  },
  persistence: { enabled: false }
}

/** The ride's ground truth (verify-transit-trust.js BOARDED). */
const BOARDED = { tripId: '1:1173133', vehicleId: '1:8140' }
/** The 17:08:29 run the recorded plan names, and the rider missed. */
const PLANNED_TRIP = '1:1171228'
/** transit-trust.ts EARLY_BOARD_MIN_MS. */
const EARLY_BOARD_MIN_MS = transitTrust.EARLY_BOARD_MIN_MS

const hhmmss = (ms: number | null | undefined) =>
  ms == null
    ? 'n/a'
    : new Date(ms).toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: 'America/Chicago'
      })

type GateYes = {
  aboardBeforePlanned: boolean
  consecutiveMatches: number | undefined
  legStartMs: number
  liveBoardEpochMs: number | null | undefined
  matchConfidence: string | undefined
  matchTripId: string | undefined
  nowMs: number
  plannedTripId: string | undefined
  ridingTripId: string | null | undefined
  ridingVehicleId: string | null | undefined
  tripMismatch: boolean
  wallMs: number
}

type Replan = {
  arrivalCandidateMs: number | null
  arrivalCurrentMs: number | null
  refusedBecause: string | null
  simMs: number
  wallMs: number
}

/**
 * Replay the whole fixture at `speed` and record, from the store: every
 * boarded-earlier search, what the gate saw when it said yes, the verdict on
 * each splice, and every itinerary the trip ran on.
 */
async function replay(speed: number) {
  const globalScope: any = global
  globalScope.fetch = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({}), ok: true, status: 200 })
  )
  const clock = FakeTimers.install({ now: 1790181000000 })
  const gateYes: GateYes[] = []
  const shadow: Array<{
    fresh: boolean
    matchTripId: string | null
    sustained: boolean
    t: number
    yes: boolean
  }> = []
  const searches: Array<{ reason: string; simMs: number; wallMs: number }> = []
  const replans: Replan[] = []
  const itineraries: Array<{
    alightStop: string | undefined
    arrivalMs: number
    boardStop: string | undefined
    simMs: number
    tripIds: string[]
  }> = []
  const ridingFacts: Array<{ tripId: string; vehicleId: string }> = []
  const autoReplans: Array<{
    accepted: boolean
    reason: string
    refusedBecause: string | null
    simMs: number
  }> = []
  const notifications: Array<{ message: string; simMs: number; type: string }> =
    []
  const confirmedVehicles: Array<{ tripId: string; vehicleId: string }> = []
  const progress: Array<{
    status: string | undefined
    stopsRemaining: number | null
    t: number
  }> = []
  let lastSim = 0
  let firstRidingMs: number | null = null
  let pendingArrivals: { candidate: number | null; current: number | null } = {
    candidate: null,
    current: null
  }

  const recorder = () => (next: any) => (action: any) => {
    if (action && typeof action === 'object') {
      if (action.type === 'START_REROUTE' && action.payload?.autoApply) {
        searches.push({
          reason: action.payload.reason,
          simMs: lastSim,
          wallMs: Date.now()
        })
      }
      if (
        action.type === 'AUTO_REPLAN' &&
        action.payload?.reason === 'boarded-earlier'
      ) {
        replans.push({
          arrivalCandidateMs: pendingArrivals.candidate,
          arrivalCurrentMs: pendingArrivals.current,
          refusedBecause: action.payload.refusedBecause,
          simMs: action.payload.tMs,
          wallMs: Date.now()
        })
      }
      if (action.type === 'AUTO_REPLAN') {
        autoReplans.push({
          accepted: action.payload.accepted,
          reason: action.payload.reason,
          refusedBecause: action.payload.refusedBecause,
          simMs: lastSim
        })
      }
      if (action.type === 'ADD_NOTIFICATION' && action.payload) {
        notifications.push({
          message: action.payload.message,
          simMs: lastSim,
          type: action.payload.type
        })
      }
      if (action.type === 'CONFIRM_VEHICLE' && action.payload) {
        confirmedVehicles.push({
          tripId: action.payload.tripId,
          vehicleId: action.payload.vehicleId
        })
      }
      if (action.type === 'SET_RIDING' && action.payload?.tripId) {
        if (firstRidingMs == null) firstRidingMs = lastSim
        ridingFacts.push({
          tripId: action.payload.tripId,
          vehicleId: action.payload.vehicleId
        })
      }
    }
    return next(action)
  }
  const store = createStore(
    combineReducers({ otp: createOtpReducer(CONFIG as any) }),
    applyMiddleware(thunk, recorder)
  )

  const trust = jest.requireActual('../../../lib/util/go-mode/transit-trust')
  const realGate = jest.requireActual(
    '../../../lib/util/go-mode/transit-trust'
  ).shouldReplanBoardedEarlier
  jest
    .spyOn(transitTrust, 'shouldReplanBoardedEarlier')
    .mockImplementation((args: any) => {
      const yes = realGate(args)
      if (yes) {
        const match = args.vehicleMatchState?.match
        const plannedTripId =
          args.ridingLeg?.trip?.gtfsId || args.ridingLeg?.tripId
        const legStartMs = Number(args.ridingLeg.startTime)
        const boardMs = args.liveBoardEpochMs ?? legStartMs
        gateYes.push({
          aboardBeforePlanned: args.nowMs < boardMs - EARLY_BOARD_MIN_MS,
          consecutiveMatches: args.vehicleMatchState?.consecutiveMatches,
          legStartMs,
          liveBoardEpochMs: args.liveBoardEpochMs,
          matchConfidence: match?.confidence,
          matchTripId: match?.tripId,
          nowMs: args.nowMs,
          plannedTripId,
          ridingTripId: args.ridingTripId,
          ridingVehicleId: store.getState().otp.goMode.riding?.vehicleId,
          // The other disjunct, restated from its operands (the gate is the
          // OR of the two, and this is the one that is not the clock).
          tripMismatch:
            (match?.confidence === 'confirmed' ||
              match?.confidence === 'high') &&
            match?.tripId != null &&
            match.tripId !== plannedTripId &&
            args.ridingTripId != null &&
            args.ridingTripId !== plannedTripId &&
            !!args.vehicleRecord,
          wallMs: Date.now()
        })
      }
      return yes
    })
  const realAccept = jest.requireActual(
    '../../../lib/util/go-mode/replan-acceptance'
  ).acceptAutoReplan
  jest
    .spyOn(replanAcceptance, 'acceptAutoReplan')
    .mockImplementation((candidate: any, current: any, context: any) => {
      pendingArrivals = {
        candidate:
          candidate?.endTime != null ? Number(candidate.endTime) : null,
        current: current?.endTime != null ? Number(current.endTime) : null
      }
      return realAccept(candidate, current, context)
    })

  let lastItin: any = null
  let trackingReset = false
  let lastShadowSim = 0
  store.subscribe(() => {
    const state = store.getState()
    const g = state.otp.goMode
    if (!g || g.simulation?.status !== 'running') return
    if (g.progress?.currentTime) {
      lastSim = new Date(g.progress.currentTime).getTime()
      if (g.riding && progress[progress.length - 1]?.t !== lastSim) {
        progress.push({
          status: g.progress.status,
          stopsRemaining: g.progress.stopsRemaining ?? null,
          t: lastSim
        })
      }
    }
    // Shadow the gate on every sim tick while aboard, with the inputs the
    // caller hands it (go-mode.ts, the boarded-earlier IIFE) — the caller only
    // ASKS when its 60 s latch is open, so its own calls cannot show whether
    // the answer ever went false in between.
    if (g.riding && g.activeItinerary && lastSim !== lastShadowSim) {
      lastShadowSim = lastSim
      const legs = g.activeItinerary.legs || []
      const idx = ridingTransitLegIndex(legs, g.riding)
      if (idx >= 0) {
        const match = g.vehicleMatch?.match
        const vehicles =
          state.otp.transitIndex?.routes?.[g.riding.routeId ?? '']?.vehicles
        const record =
          trust.findVehicleById(vehicles, match?.vehicleId, lastSim) ??
          trust.findVehicleForTrip(vehicles, match?.tripId, lastSim)
        const live = g.liveLegTimes?.[idx]
        const yes = realGate({
          liveBoardEpochMs:
            live?.boardRealtime && live.boardEpoch != null
              ? live.boardEpoch
              : null,
          nowMs: lastSim,
          plannedTripIds: legs.map(
            (l: any) => l?.trip?.gtfsId ?? l?.tripId ?? null
          ),
          ridingLeg: legs[idx],
          ridingTripId: g.riding.tripId,
          vehicleMatchState: g.vehicleMatch,
          vehicleRecord: record
        })
        const cm = g.vehicleMatch?.consecutiveMatches ?? 0
        shadow.push({
          fresh: trust.isVehicleRecordFresh(record),
          matchTripId: match?.tripId ?? null,
          sustained:
            match?.confidence === 'confirmed' ||
            cm >= trust.RIDING_REBIND_MIN_CONSECUTIVE,
          t: lastSim,
          yes
        })
      }
    }
    if (g.activeItinerary && g.activeItinerary !== lastItin) {
      lastItin = g.activeItinerary
      const transit = (lastItin.legs || []).filter((l: any) => l.transitLeg)
      itineraries.push({
        alightStop: transit[0]?.to?.name,
        arrivalMs: Number(lastItin.endTime),
        boardStop: transit[0]?.from?.name,
        simMs: lastSim,
        tripIds: transit.map((l: any) => l.trip?.gtfsId)
      })
    }
    // verify-transit-trust.js's "tracking reset": the one recorded state the
    // replay engine cannot produce itself — the real missed-bus swap wiped the
    // match as the rider boarded. Fired at the same moment the script fires it.
    if (
      !trackingReset &&
      g.riding &&
      g.vehicleMatch?.match?.confidence === 'confirmed'
    ) {
      trackingReset = true
      store.dispatch({ type: 'CLEAR_VEHICLE_MATCH' })
      store.dispatch({ payload: lastSim, type: 'SET_TRANSIT_LEG_ENTERED' })
    }
  })

  await store.dispatch(replayTrip(fx, { speedMultiplier: speed }) as any)
  for (let i = 0; i < 10000; i++) {
    await clock.tickAsync(1000)
    if (store.getState().otp.goMode.simulation.status !== 'running') break
  }
  store.dispatch(stopReplay() as any)
  clock.uninstall()
  jest.restoreAllMocks()

  return {
    autoReplans,
    boardedEarlier: searches.filter((s) => s.reason === 'boarded-earlier'),
    confirmedVehicles,
    firstRidingMs: firstRidingMs ?? Number.POSITIVE_INFINITY,
    gateYes,
    itineraries,
    notifications,
    progress,
    replans,
    ridingFacts,
    searches,
    shadow
  }
}

jest.setTimeout(300000)

type Run = Awaited<ReturnType<typeof replay>>

/** What must hold at every speed, fixed or not (verify-transit-trust a-c). */
function expectTrustHeld(r: Run) {
  // The rider boarded the bus the ride says they boarded, and stayed on it:
  // no rebind of riding, and every vehicle confirmation is that bus.
  expect(r.ridingFacts.length).toBeGreaterThan(0)
  for (const f of r.ridingFacts) expect(f).toEqual(BOARDED)
  for (const c of r.confirmedVehicles) expect(c).toEqual(BOARDED)
  // (b), rewritten: no swap aboard off the ridden trip, at most one, and it
  // is a boarded-earlier one that names the ridden trip.
  const aboard = r.itineraries.filter((i) => i.simMs > r.firstRidingMs)
  expect(aboard.length).toBeLessThanOrEqual(1)
  for (const i of aboard) expect(i.tripIds).toContain(BOARDED.tripId)
  expect(
    r.autoReplans
      .filter((a) => a.accepted && a.simMs > r.firstRidingMs)
      .map((a) => a.reason)
  ).toEqual(aboard.map(() => 'boarded-earlier'))
  expect(
    r.searches.filter(
      (s) => s.reason === 'missed-bus' && s.simMs > r.firstRidingMs
    )
  ).toEqual([])
  // No MISSED_BUS once aboard (a).
  expect(
    r.notifications.filter(
      (n) => n.type === 'MISSED_BUS' && n.simMs > r.firstRidingMs
    )
  ).toEqual([])
  // (d)-lite: stops remaining never rise while aboard.
  const stops = r.progress
    .map((p) => p.stopsRemaining)
    .filter((n): n is number => n != null)
  for (let i = 1; i < stops.length; i++) {
    expect(stops[i]).toBeLessThanOrEqual(stops[i - 1])
  }
}

/** The run where the missed-bus update lands before boarding (1x, 8x). */
function expectPlanCaughtUpBeforeBoarding(r: Run) {
  const beforeBoard = r.itineraries.filter(
    (i) =>
      i.simMs <= r.firstRidingMs &&
      i.tripIds.length &&
      i.tripIds[0] === BOARDED.tripId
  )
  expect(beforeBoard.length).toBeGreaterThan(0)
  expect(hhmmss(beforeBoard[0].simMs)).toBe('17:24:43')
  // ...so there is nothing for the boarded-earlier gate to see.
  expect(r.gateYes).toEqual([])
  expect(r.boardedEarlier).toEqual([])
  expect(r.itineraries.filter((i) => i.simMs > r.firstRidingMs)).toEqual([])
}

/** The run where the rider boards on the dead plan (6x, 25x). */
function expectOneSwapOntoRiddenBus(r: Run) {
  // ...on a plan that still names the run they missed.
  const atBoarding = r.itineraries.filter((i) => i.simMs <= r.firstRidingMs)
  expect(atBoarding[atBoarding.length - 1].tripIds).toEqual([PLANNED_TRIP])
  expect(hhmmss(r.firstRidingMs)).toBe('17:27:49')

  // One search, heard yes once, for the standing mismatch.
  expect(r.boardedEarlier.map((s) => hhmmss(s.simMs))).toEqual(['17:27:52'])
  expect(r.gateYes).toHaveLength(1)
  const g = r.gateYes[0]
  expect(g.plannedTripId).toBe(PLANNED_TRIP)
  expect(hhmmss(g.legStartMs)).toBe('17:08:29')
  expect(g.liveBoardEpochMs).toBeNull()
  expect(g.ridingTripId).toBe(BOARDED.tripId)
  expect(g.ridingVehicleId).toBe(BOARDED.vehicleId)
  expect(g.matchTripId).toBe(BOARDED.tripId)
  expect(g.aboardBeforePlanned).toBe(false)
  expect(g.tripMismatch).toBe(true)

  // Judged against a dead plan now, so accepted — 17:40:00 is an arrival on a
  // bus that left 19 min before the rider boarded; the splice's 17:59:13 is
  // the ridden bus's own.
  expect(r.replans).toHaveLength(1)
  expect(r.replans[0].refusedBecause).toBeNull()
  expect(hhmmss(r.replans[0].arrivalCurrentMs)).toBe('17:40:00')
  expect(hhmmss(r.replans[0].arrivalCandidateMs)).toBe('17:59:13')

  // The plan's bus leg becomes the ridden trip, from where the rider boarded
  // to the stop the plan already alighted at.
  const aboard = r.itineraries.filter((i) => i.simMs > r.firstRidingMs)
  expect(aboard).toHaveLength(1)
  expect(hhmmss(aboard[0].simMs)).toBe('17:27:52')
  expect(aboard[0].tripIds).toEqual([BOARDED.tripId])
  expect(aboard[0].boardStop).toBe('I-35W & 46th St Station')
  expect(aboard[0].alightStop).toBe('I-35W & 98th St Station')
  expect(hhmmss(aboard[0].arrivalMs)).toBe('17:59:13')

  // One push for it, TRIP_UPDATED, and nothing else from the swap.
  const pushedAfterSwap = r.notifications.filter(
    (n) => n.simMs >= aboard[0].simMs
  )
  expect(pushedAfterSwap.map((n) => n.type)).toEqual(['TRIP_UPDATED'])
  expect(pushedAfterSwap[0].message).toBe(
    'METRO Orange Line · off at I-35W & 98th St Station · arriving in 31 min'
  )

  // With the plan naming the ridden bus, the gate has nothing left to see:
  // shadowed on every aboard tick after the swap it never says yes again, so
  // the latch's second and third asks are gone, not merely capped.
  const afterSwap = r.shadow.filter((x) => x.t > aboard[0].simMs)
  expect(afterSwap.length).toBeGreaterThan(100)
  expect(afterSwap.filter((x) => x.yes)).toEqual([])
}

jest.setTimeout(300000)

describe('util > go-mode > 28.6/28.7: the 0729 boarded-earlier re-plan at fixed replay speeds', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('1x (the phone): the missed-bus update lands first and nothing fires aboard', async () => {
    const r = await replay(1)
    expectTrustHeld(r)
    expectPlanCaughtUpBeforeBoarding(r)
  })

  it('6x (what the nightly browser keeps up with): one boarded-earlier swap onto the ridden bus', async () => {
    const r = await replay(6)
    expectTrustHeld(r)
    expectOneSwapOntoRiddenBus(r)
  })

  it('8x: same as the phone', async () => {
    const r = await replay(8)
    expectTrustHeld(r)
    expectPlanCaughtUpBeforeBoarding(r)
  })

  it('25x (what the script asks for): one boarded-earlier swap onto the ridden bus', async () => {
    const r = await replay(25)
    expectTrustHeld(r)
    expectOneSwapOntoRiddenBus(r)
  })
})

describe('util > go-mode > 28.6: planRunLeftBeforeRider', () => {
  const BOARDED_AT = Date.parse('2026-07-29T22:27:50Z')
  const leg = (startIso: string, tripId = PLANNED_TRIP): any => ({
    startTime: Date.parse(startIso),
    transitLeg: true,
    trip: { gtfsId: tripId }
  })

  it('is true for the 0729 plan: its run left 19 min before the rider boarded', () => {
    expect(
      planRunLeftBeforeRider({
        boardedAtMs: BOARDED_AT,
        planLeg: leg('2026-07-29T22:08:29Z'),
        ridingTripId: BOARDED.tripId
      })
    ).toBe(true)
  })

  it('is false inside the slack: the two real rides whose plan run was due ~1 min before boardedAt', () => {
    // 09-21 mub9m39o (-59 s) and 09-22 mucordp1 (-52 s): boardedAt trails the
    // real boarding by the confirmation lag, so these are not proof of a miss.
    for (const lagS of [59, 52]) {
      expect(
        planRunLeftBeforeRider({
          boardedAtMs: BOARDED_AT,
          planLeg: {
            ...leg('2026-07-29T22:00:00Z'),
            startTime: BOARDED_AT - lagS * 1000
          },
          ridingTripId: BOARDED.tripId
        })
      ).toBe(false)
    }
    expect(PLAN_RUN_LEFT_SLACK_MS).toBe(120000)
  })

  it('is false for a genuine earlier boarding: the plan run is still ahead', () => {
    expect(
      planRunLeftBeforeRider({
        boardedAtMs: BOARDED_AT,
        planLeg: leg('2026-07-29T22:33:31Z'),
        ridingTripId: BOARDED.tripId
      })
    ).toBe(false)
  })

  it('reads the live board time over startTime, but never a floor', () => {
    const frozen = leg('2026-07-29T22:08:29Z')
    const liveLate = Date.parse('2026-07-29T22:29:00Z')
    expect(
      planRunLeftBeforeRider({
        boardedAtMs: BOARDED_AT,
        liveLegTime: { boardEpoch: liveLate, boardRealtime: true } as any,
        planLeg: frozen,
        ridingTripId: BOARDED.tripId
      })
    ).toBe(false)
    expect(
      planRunLeftBeforeRider({
        boardedAtMs: BOARDED_AT,
        liveLegTime: {
          boardEpoch: liveLate,
          boardIsFloor: true,
          boardRealtime: true
        } as any,
        planLeg: frozen,
        ridingTripId: BOARDED.tripId
      })
    ).toBe(true)
  })

  it('is false for the ridden trip itself, an access leg, or no board time', () => {
    const base = { boardedAtMs: BOARDED_AT, ridingTripId: BOARDED.tripId }
    expect(
      planRunLeftBeforeRider({
        ...base,
        planLeg: leg('2026-07-29T22:08:29Z', BOARDED.tripId)
      })
    ).toBe(false)
    expect(
      planRunLeftBeforeRider({
        ...base,
        planLeg: { ...leg('2026-07-29T22:08:29Z'), transitLeg: false }
      })
    ).toBe(false)
    expect(
      planRunLeftBeforeRider({
        ...base,
        boardedAtMs: null,
        planLeg: leg('2026-07-29T22:08:29Z')
      })
    ).toBe(false)
  })
})
