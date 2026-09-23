/* globals describe, expect, it, jest */
import FakeTimers from '@sinonjs/fake-timers'

import {
  ACCESS_BOARD_MIN_SPEED_MPS,
  RIDING_ESTABLISH_MAX_DISTANCE_M
} from '../../../lib/util/go-mode/riding'
import {
  convertPlanResponseItineraries,
  fetchOnboardCandidatePlan
} from '../../../lib/actions/apiV2'
import { endGoMode, handlePositionUpdate } from '../../../lib/actions/go-mode'
import {
  trackTransitPace,
  TRANSIT_PACE_REPLAN_HOLD_FIXES,
  transitPaceHoldsAccessReplan
} from '../../../lib/util/go-mode/deviation'
import goMode from '../../../lib/reducers/go-mode'
import type { AccessBoardSample } from '../../../lib/util/go-mode/riding'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

// Recording on, as it was on the day: ONBOARD_CANDIDATE_SNAPSHOT is how the
// ride's own record named the quiet re-plan (`request.reason`).
jest.mock('../../../lib/util/debug-log', () => ({
  ...jest.requireActual('../../../lib/util/debug-log'),
  isTripRecordingEnabled: jest.fn(() => true)
}))

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Backlog 26.6 — the quiet access re-plan must not hand a bicycle leg to a
 * rider doing 15 m/s on a bus.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 2026-09-22, session mucro0n0-obiueg (`ride-0922-0927.json`). The rider
 * boarded Orange Line 8148 / trip 1:1268952 at I-35W & Lake St at 09:33:35,
 * 4m09s ahead of the held 1:1273236. 8148's feed record was 52 s stale
 * (`lastSeen` 09:32:43, `STOPPED_AT` Lake St), so no vehicle could establish
 * the riding fact; the board time the app held for the bus leg was 09:40:11,
 * so the transition gate kept the matcher on the finished bike leg; and every
 * metre down the busway was a metre off that bike leg. At 09:33:49.183 the
 * quiet access re-plan (`request.reason: quiet-replan-scoped`, from the
 * 15.21 m/s fix) installed a 284.42 m BICYCLE leg 0, and "Board METRO Orange
 * Line" was pushed at 09:33:51.119 to a rider already on it. The riding fact
 * landed at 09:33:53 and the boarded-earlier swap put the ridden bus back at
 * 09:33:54.
 *
 * The replay runs the REAL tick from the trip's first fix with the ride's own
 * vehicle, trip and stop-time responses served as the store held them, and
 * answers the scoped re-plan with the plan OTP gave on the day. It reproduces
 * the day on main `b0a8fc811` (measured before this change):
 *
 *   09:33:46.999  13.30 m/s  deviated (the bike leg's threshold crossed —
 *                            the day's UPDATE_PROGRESS 09:33:47.081)
 *   09:33:48.999  15.21 m/s  ONBOARD_CANDIDATE_SNAPSHOT quiet-replan-scoped,
 *                            AUTO_REPLAN accepted -> START_GO_MODE
 *                            [BICYCLE 284, BUS 16473, BICYCLE 3970]
 *   09:33:50.999  16.68 m/s  TRANSITION_LEG 1, SET_RIDING, and
 *                            ADD_NOTIFICATION LEG_TRANSITION "Board METRO
 *                            Orange Line to I-35W & 98th St Station"
 *   09:33:51.999            START_REROUTE boarded-earlier
 *
 * — the day's own sequence (swap 09:33:49.19, push 09:33:51.119, boarded-
 * earlier 09:33:54.09), the riding fact two seconds earlier than the day's
 * because the replay's vehicle match is not waiting on a poll.
 */

const mockedFetch = fetchOnboardCandidatePlan as jest.Mock

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

const positionOf = (fix: any): GeolocationPosition =>
  ({
    coords: {
      accuracy: fix.accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: fix.heading,
      latitude: fix.lat,
      longitude: fix.lon,
      speed: fix.speed
    },
    timestamp: fix.tMs
  } as GeolocationPosition)

const initial = goMode(undefined, { type: '@@INIT' })

function itineraryAt(fx: any, tMs: number): any {
  let best = fx.itinerary
  for (const s of fx.itinerarySwaps ?? []) if (s.tMs <= tMs) best = s.itinerary
  return best
}

/**
 * Replay `fromMs`-`toMs` of a fixture through handlePositionUpdate, each fix
 * on its own clock and each tick allowed to settle (the quiet re-plan's fetch
 * resolves inside the tick that issued it, as it did on the day: request
 * 09:33:49.18, swap 09:33:49.19).
 */
async function replay(fx: any, fromMs: number, toMs: number) {
  const routeIds: string[] = fx.meta.routeIds
  let goModeState: any = {
    ...initial,
    activeItinerary: itineraryAt(fx, fromMs),
    isActive: true,
    tracking: { ...initial.tracking, lastPosition: null }
  }
  let nowMs = 0
  const actions: any[] = []
  const ticks: any[] = []
  const latestBy = (rows: any[], key: string) => {
    const out: Record<string, any> = {}
    const seen: Record<string, number> = {}
    for (const row of rows ?? []) {
      const id = row[key]
      if (row.tMs > nowMs || (seen[id] != null && seen[id] > row.tMs)) continue
      seen[id] = row.tMs
      out[id] = row.payload
    }
    return out
  }
  const vehiclesAt = (routeId: string) => {
    let best: any = null
    for (const snap of fx.vehicleSnapshots ?? []) {
      if (snap.routeId !== routeId) continue
      if (snap.tMs <= nowMs && (!best || snap.tMs > best.tMs)) best = snap
    }
    return best?.payload?.vehicles ?? []
  }
  // refreshLiveLegTimes reads transitIndex.trips / .stops after its (mocked)
  // fetches, so serving the recorded responses here is what rebuilds the
  // 09:40:11 board time the day's app held for leg 1 — the precondition of
  // this incident. Started any later than the trip's first fix, the replay
  // does not rebuild it, the transition fires at 09:33:39 and there is no
  // incident to test.
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: {
        routes: Object.fromEntries(
          routeIds.map((r) => [r, { vehicles: vehiclesAt(r) }])
        ),
        stops: latestBy(fx.stopTimeSnapshots, 'stopId'),
        trips: latestBy(fx.tripSnapshots, 'tripId')
      }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push({ ...action, atMs: nowMs })
    goModeState = goMode(goModeState, action)
    return action
  }
  // The scoped request (access mode only) gets what OTP answered on the day;
  // anything else gets nothing, so a swap can only come from the path the
  // day's swap came from.
  mockedFetch.mockImplementation((combo: any) => () => {
    const scoped =
      (combo?.modes || []).length > 0 &&
      combo.modes.every((m: any) => m.mode === 'BICYCLE' || m.mode === 'WALK')
    const rec = scoped
      ? (fx.quietReplanPlans || []).find(
          (q: any) =>
            q.reason === 'quiet-replan-scoped' &&
            q.tMs >= nowMs &&
            q.tMs - nowMs < 5000
        )
      : null
    const response = rec?.response ?? { data: { plan: { itineraries: [] } } }
    return Promise.resolve({
      error: false,
      itineraries:
        convertPlanResponseItineraries(response, {
          combo,
          config: {},
          query: {},
          strictModes: false,
          validModeCombinations: []
        }) || [],
      query: '',
      response,
      variables: {}
    })
  })
  const clock = FakeTimers.install({ now: fromMs - 1000, toFake: ['Date'] })
  try {
    for (const fix of fx.gpsTrack) {
      if (fix.tMs < fromMs || fix.tMs > toMs) continue
      clock.setSystemTime(fix.tMs)
      nowMs = fix.tMs
      await dispatch(handlePositionUpdate(positionOf(fix)))
      await new Promise((resolve) => setTimeout(resolve, 0))
      ticks.push({
        legIndex: goModeState.routeMatch?.legIndex,
        riding: goModeState.riding?.tripId ?? null,
        speed: fix.speed,
        status: goModeState.progress?.status,
        tMs: fix.tMs
      })
    }
    return { actions, itinerary: goModeState.activeItinerary, ticks }
  } finally {
    dispatch(endGoMode())
    clock.uninstall()
  }
}

// ─── the run, as a pure function ────────────────────────────────────────────

describe('util > go-mode > the transit-pace run (26.6)', () => {
  const tick = (over: Partial<AccessBoardSample> = {}): AccessBoardSample => ({
    boardLeg: { transitLeg: true } as any,
    boardLegIndex: 1,
    fixAccuracyM: 12.7,
    legIndex: 0,
    nowMs: 1790087628999,
    riderSpeedMps: 15.21,
    routeMatch: { distanceFromRoute: 4.2, isOnRoute: true },
    vehicleMatch: null,
    ...over
  })

  it('asks no vehicle: the feed being stale is the case it exists for', () => {
    const run = trackTransitPace(null, tick())
    expect(run).toEqual({
      boardLegIndex: 1,
      fixes: 1,
      lastFixMs: 1790087628999,
      legIndex: 0
    })
  })

  it('holds from the third distinct fix, on that access leg only', () => {
    let run = null
    for (let i = 0; i < TRANSIT_PACE_REPLAN_HOLD_FIXES - 1; i++) {
      run = trackTransitPace(run, tick({ nowMs: 1790087623999 + i * 1000 }))
      expect(transitPaceHoldsAccessReplan(run, 0)).toBe(false)
    }
    run = trackTransitPace(run, tick({ nowMs: 1790087625999 }))
    expect(transitPaceHoldsAccessReplan(run, 0)).toBe(true)
    expect(transitPaceHoldsAccessReplan(run, 2)).toBe(false)
  })

  it('does not count a fix the stream delivers twice', () => {
    let run = trackTransitPace(null, tick({ nowMs: 1000 }))
    run = trackTransitPace(run, tick({ nowMs: 2000 }))
    run = trackTransitPace(run, tick({ nowMs: 2000 }))
    expect(run?.fixes).toBe(2)
    expect(transitPaceHoldsAccessReplan(run, 0)).toBe(false)
  })

  it('refuses a bicycle pace, a spike off the corridor, and a coarse fix', () => {
    let run = trackTransitPace(null, tick({ nowMs: 1000 }))
    run = trackTransitPace(run, tick({ nowMs: 2000 }))
    // Below transit pace resets the run on that fix: a cyclist's re-plan is
    // theirs again at once.
    expect(
      trackTransitPace(
        run,
        tick({ nowMs: 3000, riderSpeedMps: ACCESS_BOARD_MIN_SPEED_MPS - 0.01 })
      )
    ).toBeNull()
    // bike-false-board-1029's lone 13.0 m/s spike was 1,073 m off the bus
    // corridor.
    expect(
      trackTransitPace(
        run,
        tick({
          nowMs: 3000,
          riderSpeedMps: 13.0,
          routeMatch: { distanceFromRoute: 1073, isOnRoute: false }
        })
      )
    ).toBeNull()
    // The establish bound, not the matcher's 250 m corridor.
    expect(
      trackTransitPace(
        run,
        tick({
          nowMs: 3000,
          routeMatch: {
            distanceFromRoute: RIDING_ESTABLISH_MAX_DISTANCE_M + 1,
            isOnRoute: true
          }
        })
      )
    ).toBeNull()
    expect(
      trackTransitPace(run, tick({ fixAccuracyM: 1254.74, nowMs: 3000 }))
    ).toBeNull()
    expect(trackTransitPace(run, tick({ nowMs: 3000, routeMatch: null }))).toBe(
      null
    )
  })

  it('restarts on a different access leg or bus leg', () => {
    let run = trackTransitPace(null, tick({ nowMs: 1000 }))
    run = trackTransitPace(run, tick({ nowMs: 2000 }))
    expect(trackTransitPace(run, tick({ legIndex: 2, nowMs: 3000 }))).toEqual(
      expect.objectContaining({ fixes: 1, legIndex: 2 })
    )
    expect(
      trackTransitPace(run, tick({ boardLegIndex: 3, nowMs: 3000 }))
    ).toEqual(expect.objectContaining({ boardLegIndex: 3, fixes: 1 }))
  })
})

// ─── the ride ───────────────────────────────────────────────────────────────

describe('go-mode > 2026-09-22 09:33, no quiet re-plan at transit pace (26.6)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fx: any = require('../../../lib/util/go-mode/replay/fixtures/ride-0922-0927.json')
  // 09:33:35 (the rider starts moving off the platform) to 09:33:55.
  const WINDOW_FROM = 1790087615000
  const WINDOW_TO = 1790087635999
  const inWindow = (a: any) => a.atMs >= WINDOW_FROM && a.atMs <= WINDOW_TO

  let result: any = null
  const ride = async () => {
    if (!result) {
      // From the trip's first fix (see getState above) to 09:34:30.
      result = await replay(fx, fx.meta.startMs, 1790087670000)
    }
    return result
  }

  it('reaches the incident: transit pace, held on the finished bike leg', async () => {
    const { ticks } = await ride()
    const at = (hms: string) => ticks.find((t: any) => hhmmss(t.tMs) === hms)
    // The precondition, measured: the matcher is held on leg 0 while the
    // rider rides away from the platform, and deviates from it at bus speed.
    expect(at('09:33:45')?.status).toBe('on_track')
    expect(at('09:33:46')).toEqual(
      expect.objectContaining({ legIndex: 0, riding: null, status: 'deviated' })
    )
    expect(at('09:33:48')?.speed).toBeCloseTo(15.21, 2)
    expect(at('09:33:48')?.legIndex).toBe(0)
    expect(at('09:33:48')?.riding).toBeNull()
  })

  it('sends no quiet re-plan and installs no 284 m bike leg', async () => {
    const { actions } = await ride()
    const quiet = actions.filter(
      (a: any) =>
        inWindow(a) &&
        ((a.type === 'ONBOARD_CANDIDATE_SNAPSHOT' &&
          a.payload?.request?.reason === 'quiet-replan-scoped') ||
          (a.type === 'AUTO_REPLAN' &&
            String(a.payload?.reason ?? '').startsWith('quiet-replan')))
    )
    expect(quiet).toHaveLength(0)
    const bikeFirst = actions.filter(
      (a: any) =>
        inWindow(a) &&
        a.type === 'START_GO_MODE' &&
        (a.payload?.itinerary ?? a.payload)?.legs?.[0]?.mode === 'BICYCLE'
    )
    expect(bikeFirst).toHaveLength(0)
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('pushes no "Board" to a rider who is aboard, in the window or after', async () => {
    const { actions } = await ride()
    const legTransitions = actions.filter(
      (a: any) =>
        a.type === 'ADD_NOTIFICATION' &&
        a.payload?.type === 'LEG_TRANSITION' &&
        a.atMs >= WINDOW_FROM
    )
    expect(legTransitions).toHaveLength(0)
  })

  it('ends on the bus the rider is on, alighting where the plan alights', async () => {
    const { actions, itinerary } = await ride()
    // The riding fact lands on the access-leg boarding (23.6) once 8148's
    // match is sustained — the 09:34:06.999 fix, fourteen seconds after the
    // day's 09:33:53, which the wrong swap's leg reset had brought forward.
    const firstRiding = actions.find((a: any) => a.type === 'SET_RIDING')
    expect(hhmmss(firstRiding.atMs)).toBe('09:34:06')
    expect(firstRiding.payload.tripId).toBe('1:1268952')
    // The boarded-earlier splice anchors on the TRANSIT leg of the ridden
    // route, not the bike leg the fact was written on: before that fix it
    // produced "1:1268952 Marquette -> Lake St, then board 1:1273236 at Lake
    // St", with a LEG_TRANSITION push, for a rider 250 m past Lake St.
    const legs = itinerary.legs.map((l: any) => [
      l.mode,
      l.trip?.gtfsId ?? null,
      l.from?.name,
      l.to?.name
    ])
    expect(legs[0]).toEqual([
      'BUS',
      '1:1268952',
      'I-35W & Lake St Station',
      'I-35W & 98th St Station'
    ])
    expect(legs[1][0]).toBe('BICYCLE')
    expect(legs).toHaveLength(2)
  })
})
