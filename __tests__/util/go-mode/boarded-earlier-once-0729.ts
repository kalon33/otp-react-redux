/* globals afterEach, describe, expect, it, jest */
import '../../test-utils/mock-window-url'

import { applyMiddleware, combineReducers, createStore } from 'redux'
import FakeTimers from '@sinonjs/fake-timers'
import thunk from 'redux-thunk'

import * as replanAcceptance from '../../../lib/util/go-mode/replan-acceptance'
import * as transitTrust from '../../../lib/util/go-mode/transit-trust'
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
 * BACKLOG 25.8, MEASURED — the three `boarded-earlier` auto-replans that
 * `verify-transit-trust` (b) counts on `orange-line-0729.json`.
 *
 * The nightly of 2026-09-23 (main `0c4afc7e8`) saw three `autoApply`
 * `boarded-earlier` searches once aboard — 17:27:52, 17:35:14, 17:41:31 — and
 * no itinerary swap. The row read that as a gate that RE-ARMS ~6–7 min after a
 * re-plan that changed nothing. This runs the same fixture through the real
 * store, the real replay engine (`replayTrip`: every OTP read served from the
 * recording) and the real position tick, with the verify script's one
 * hand-reconstructed state (the "tracking reset") reproduced, and prints what
 * `shouldReplanBoardedEarlier` saw on every tick it said yes.
 *
 * What it measures (the same at a fixed speed on `540b5373b^`, the tree before
 * the 09-17 merge batch, on `13dce7c2b` after it, and on `3b31b99f9`):
 *
 *  - The trigger is one standing fact, not something the re-plan re-arms: the
 *    plan in hand still names the 17:08:29 run `1:1171228` — the bus the rider
 *    MISSED — while the rider is verifiably on `1:1173133` / `1:8140`. Every
 *    yes is the `tripMismatch` disjunct (match `high` on `1:1173133`, >= 8
 *    consecutive, fresh record, same headsign); `aboardBeforePlanned` is never
 *    what fires (liveLegTimes is empty under replay, so it reads 17:08:29).
 *    Shadowed on every aboard tick, the gate says yes on 405 of 1051 and rises
 *    19 times — exactly when the vehicle evidence re-forms after the matcher
 *    loses 8140, flaps to an opposite-direction trip (`1:1082792`,
 *    `1:1085322`, `1:1085082`) or 8140 drops out of a snapshot. The plan never
 *    changes, so nothing the re-plan did is an input.
 *  - The re-plan does not "change nothing" by accident: it builds the splice
 *    onto the ridden trip and `acceptAutoReplan` REFUSES it `arrives-later`,
 *    against a plan arriving 17:40:00 on a bus that left before the rider
 *    boarded. `currentPlanIsDead` is passed only for `missed-bus`.
 *  - Three is `EARLY_BOARD_REPLAN_MAX_ATTEMPTS`; the spacing is
 *    `EARLY_BOARD_REPLAN_RETRY_MS`, 60 s of WALL clock (`Date.now()` in the
 *    latch). "6–7 min" is 60 s of wall at the nightly's effective ~6x.
 *  - Whether the rider reaches the bus on the dead plan at all is also a
 *    wall-clock question: the missed-bus auto-update retries on `Date.now()`
 *    (`evaluateMissedBusRecovery` — "a sped-up replay does not reproduce the
 *    retry cadence faithfully"). At 1x — the phone — it lands at 17:20:27 and
 *    17:24:43, the plan names `1:1173133` before boarding, and no
 *    boarded-earlier re-plan happens at all.
 *
 * So the 09-18 flip of verify-transit-trust (b) was not the gate: the count is
 * set by the nightly's wall/sim ratio (in this harness 1x: 0, 6x: 3, 8x: 0,
 * 25x: 1). No once-per-boarding guard is written — it would leave (b) red at
 * one, and make final the thing that is actually wrong here: the ride runs on
 * a plan naming a bus that already left.
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
  const itineraries: Array<{ simMs: number; tripIds: string[] }> = []
  const ridingFacts: Array<{ tripId: string; vehicleId: string }> = []
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
      itineraries.push({
        simMs: lastSim,
        tripIds: (lastItin.legs || [])
          .filter((l: any) => l.transitLeg)
          .map((l: any) => l.trip?.gtfsId)
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
    boardedEarlier: searches.filter((s) => s.reason === 'boarded-earlier'),
    firstRidingMs: firstRidingMs ?? Number.POSITIVE_INFINITY,
    gateYes,
    itineraries,
    replans,
    ridingFacts,
    shadow
  }
}

jest.setTimeout(300000)

describe('util > go-mode > 25.8: the 0729 boarded-earlier re-plans, measured', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('at the nightly speed: one standing mismatch, asked three times by the latch, refused every time', async () => {
    // 6x of wall is what the 09-23 nightly's 17:27:52 / 17:35:14 / 17:41:31
    // spacing implies (60 s wall -> ~6-7 min sim); this harness gives
    // 17:27:52 / 17:33:49 / 17:39:51.
    const r = await replay(6)

    // The rider boarded the bus the ride says they boarded, and stayed on it.
    expect(r.ridingFacts.length).toBeGreaterThan(0)
    for (const f of r.ridingFacts) expect(f).toEqual(BOARDED)

    // ...on a plan that still names the run they missed.
    const atBoarding = r.itineraries.filter((i) => i.simMs <= r.firstRidingMs)
    expect(atBoarding[atBoarding.length - 1].tripIds).toEqual([PLANNED_TRIP])

    // Three searches: the cap, not three triggers.
    expect(r.boardedEarlier.map((s) => hhmmss(s.simMs))).toEqual([
      '17:27:52',
      '17:33:49',
      '17:39:51'
    ])
    // 60 s of WALL apart — EARLY_BOARD_REPLAN_RETRY_MS, read from Date.now().
    for (let i = 1; i < r.boardedEarlier.length; i++) {
      const wallGap =
        r.boardedEarlier[i].wallMs - r.boardedEarlier[i - 1].wallMs
      expect(wallGap).toBeGreaterThanOrEqual(60000)
      expect(wallGap).toBeLessThan(62000)
    }

    // The caller asked three times and heard yes three times, always for the
    // same reason...
    expect(r.gateYes).toHaveLength(3)
    for (const g of r.gateYes) {
      expect(g.plannedTripId).toBe(PLANNED_TRIP)
      expect(hhmmss(g.legStartMs)).toBe('17:08:29')
      expect(g.liveBoardEpochMs).toBeNull()
      expect(g.ridingTripId).toBe(BOARDED.tripId)
      expect(g.ridingVehicleId).toBe(BOARDED.vehicleId)
      expect(g.matchTripId).toBe(BOARDED.tripId)
      expect(g.matchConfidence).toBe('high')
      expect(g.consecutiveMatches).toBeGreaterThanOrEqual(
        transitTrust.RIDING_REBIND_MIN_CONSECUTIVE
      )
      expect(g.aboardBeforePlanned).toBe(false)
      expect(g.tripMismatch).toBe(true)
    }

    // Between the asks the answer comes and goes — but only with the vehicle
    // evidence. Shadowed on every aboard tick with the caller's own inputs:
    // every yes is the ridden bus, sustained, on a fresh record; every no is a
    // tick where one of those three is missing (the match lost, flapped to an
    // opposite-direction or other trip, re-building its 8-match run, or 8140
    // absent from the snapshot). The plan never moves, so nothing the re-plan
    // did or did not change is in it.
    const onBoardedEvidence = (x: any) =>
      x.matchTripId === BOARDED.tripId && x.sustained && x.fresh
    expect(r.shadow.length).toBeGreaterThan(500)
    for (const x of r.shadow) expect(x.yes).toBe(onBoardedEvidence(x))
    const rises = r.shadow.filter(
      (x, i) => x.yes && i > 0 && !r.shadow[i - 1].yes
    )
    // eslint-disable-next-line no-console
    console.log(
      `[25.8] gate rises (false -> true) at: ${rises
        .map((x) => hhmmss(x.t))
        .join(', ')}; yes on ${r.shadow.filter((x) => x.yes).length} of ${
        r.shadow.length
      } aboard ticks`
    )
    // It re-arms far more often than it is asked — three is the cap.
    expect(rises.length).toBeGreaterThan(3)

    // Every splice was built and refused: it arrives after a plan whose bus
    // left before the rider boarded.
    expect(r.replans).toHaveLength(3)
    for (const p of r.replans) {
      expect(p.refusedBecause).toBe('arrives-later')
      expect(hhmmss(p.arrivalCurrentMs)).toBe('17:40:00')
      expect(p.arrivalCandidateMs as number).toBeGreaterThan(
        p.arrivalCurrentMs as number
      )
    }

    // And so the itinerary never changed once aboard — (b)'s other half and
    // (c) both hold.
    expect(r.itineraries.filter((i) => i.simMs > r.firstRidingMs)).toEqual([])
  })

  it('at the phone speed: the missed-bus update lands first and nothing fires aboard', async () => {
    const r = await replay(1)
    expect(r.ridingFacts.length).toBeGreaterThan(0)
    for (const f of r.ridingFacts) expect(f).toEqual(BOARDED)
    // The plan names the bus the rider boards before they board it...
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
  })
})
