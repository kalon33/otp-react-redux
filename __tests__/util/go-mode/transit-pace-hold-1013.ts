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
  TRANSIT_PACE_DWELL_MAX_MS,
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

// The hold's own answer on every tick, so the replay can say WHY there was or
// was not a re-plan rather than only whether there was one.
const mockHolds: { atMs: number; fixes: number | null; out: boolean }[] = []
jest.mock('../../../lib/util/go-mode/deviation', () => {
  const actual = jest.requireActual('../../../lib/util/go-mode/deviation')
  return {
    ...actual,
    transitPaceHoldsAccessReplan: (run: any, legIndex: number) => {
      const out = actual.transitPaceHoldsAccessReplan(run, legIndex)
      mockHolds.push({ atMs: Date.now(), fixes: run?.fixes ?? null, out })
      return out
    }
  }
})

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Backlog 26.6, second sighting — the transit-pace hold must survive the bus
 * slowing for a stop.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 2026-10-13, session mv6ret6s-h5he2i (`h5he2i-0952-transit-pace.json`, cut
 * 09:51:00-09:56:30 from the ride's fixture). After waiting at I-35W & 98th St
 * Gate C the rider rode west on 98th St W on a bus with the plan still on its
 * bike leg to Gate C (riding null, no vehicle match). The quiet access
 * re-plan went out twice anyway: 09:54:14 (BICYCLE 1,445 m back to Gate C)
 * and 09:55:35 (1,634 m).
 *
 * MEASURED on main `16bbde89d`, replaying the real tick from 09:51:00 and
 * reading the hold's answer per fix (the replay reproduces both: 09:54:14 and
 * 09:55:34). The hold had NOT failed to engage. From 09:53:32 every fix fed
 * trackTransitPace on access leg 0 with board leg 1, 4-9 m off the 539 leg's
 * shape, isOnRoute true, and the run counted 42 distinct fixes to 09:54:13
 * (12.2 m/s), holding (`transitPaceHoldsAccessReplan` true) on every tick from
 * 09:53:34. The 09:54:14 fix was 11.8 m/s — the bus braking for a stop — and
 * the access-board block's `speed >= ACCESS_BOARD_MIN_SPEED_MPS` precondition
 * sent it to the else branch, which nulled the run; the re-plan was asked on
 * that same tick and went out. 09:55:34 is the same mechanism: the bus stood
 * 09:54:43-09:55:28 and the run was never rebuilt. Ruled out by the same
 * print: the 09:52:11 trim swap (the run starts 09:52:42 and is unaffected by
 * it), a null leg-1 sample (2-9 m every fix), a leg-index mismatch (run leg 0,
 * routeMatch leg 0 throughout), anything else clearing the run.
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

// ─── the run through a dwell, as a pure function ───────────────────────────

describe('util > go-mode > the transit-pace run through a dwell (26.6)', () => {
  const tick = (over: Partial<AccessBoardSample> = {}): AccessBoardSample => ({
    boardLeg: { transitLeg: true } as any,
    boardLegIndex: 1,
    fixAccuracyM: 2.6,
    legIndex: 0,
    nowMs: 0,
    riderSpeedMps: 14,
    routeMatch: { distanceFromRoute: 7, isOnRoute: true },
    vehicleMatch: null,
    ...over
  })
  const held = () => {
    let run = null
    for (let i = 1; i <= TRANSIT_PACE_REPLAN_HOLD_FIXES; i++) {
      run = trackTransitPace(run, tick({ nowMs: i * 1000 }))
    }
    expect(transitPaceHoldsAccessReplan(run, 0)).toBe(true)
    return run
  }
  const lastFast = TRANSIT_PACE_REPLAN_HOLD_FIXES * 1000

  it('keeps a holding run, uncounted, while the bus slows and stands', () => {
    const run = held()
    // 09:54:14, 11.8 m/s: the fix that dropped the run on the day.
    const braking = trackTransitPace(
      run,
      tick({ nowMs: lastFast + 1000, riderSpeedMps: 11.8 })
    )
    expect(braking).toBe(run)
    const standing = trackTransitPace(
      braking,
      tick({ nowMs: lastFast + TRANSIT_PACE_DWELL_MAX_MS, riderSpeedMps: 0 })
    )
    expect(standing).toBe(run)
    expect(transitPaceHoldsAccessReplan(standing, 0)).toBe(true)
  })

  it('lets go after a stop longer than a bus makes', () => {
    const run = held()
    expect(
      trackTransitPace(
        run,
        tick({
          nowMs: lastFast + TRANSIT_PACE_DWELL_MAX_MS + 1,
          riderSpeedMps: 0
        })
      )
    ).toBeNull()
  })

  it('lets go at once when the slow fix leaves the corridor or is coarse', () => {
    const run = held()
    expect(
      trackTransitPace(
        run,
        tick({
          nowMs: lastFast + 1000,
          riderSpeedMps: 1.4,
          routeMatch: {
            distanceFromRoute: RIDING_ESTABLISH_MAX_DISTANCE_M + 1,
            isOnRoute: true
          }
        })
      )
    ).toBeNull()
    expect(
      trackTransitPace(
        run,
        tick({ fixAccuracyM: 1414, nowMs: lastFast + 1000, riderSpeedMps: 1.4 })
      )
    ).toBeNull()
  })

  it('a run that does not hold yet is not kept: one spike never becomes a hold', () => {
    // bike-false-board-1029: a lone 13.0 m/s fix. Even ON the corridor, the
    // slow fixes after it drop it, so it can never be topped up to a hold by
    // spikes minutes apart.
    let run = trackTransitPace(null, tick({ nowMs: 1000, riderSpeedMps: 13 }))
    expect(run?.fixes).toBe(1)
    run = trackTransitPace(
      run,
      tick({ nowMs: 2000, riderSpeedMps: ACCESS_BOARD_MIN_SPEED_MPS - 7 })
    )
    expect(run).toBeNull()
    run = trackTransitPace(null, tick({ nowMs: 1000 }))
    run = trackTransitPace(run, tick({ nowMs: 2000 }))
    expect(
      trackTransitPace(run, tick({ nowMs: 3000, riderSpeedMps: 11.8 }))
    ).toBeNull()
  })

  it('pace after the dwell counts on from where the run stood', () => {
    const run = held()
    const dwell = trackTransitPace(
      run,
      tick({ nowMs: lastFast + 30_000, riderSpeedMps: 0 })
    )
    const away = trackTransitPace(dwell, tick({ nowMs: lastFast + 40_000 }))
    expect(away).toEqual(
      expect.objectContaining({
        fixes: TRANSIT_PACE_REPLAN_HOLD_FIXES + 1,
        lastFixMs: lastFast + 40_000
      })
    )
  })
})

// ─── the ride ───────────────────────────────────────────────────────────────

describe('go-mode > 2026-10-13 09:54, the hold survives the bus stopping (26.6)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fx: any = require('../../../lib/util/go-mode/replay/fixtures/h5he2i-0952-transit-pace.json')
  const at = (hms: string) => Date.parse(`2026-10-13T${hms}-05:00`)
  // After the 09:52:11 quiet re-plan, which the rider had not boarded for
  // yet (6.0 m/s) and which is not this row's: its plan is the one held below.
  const WINDOW_FROM = at('09:52:12')
  const WINDOW_TO = at('09:56:00')
  const inWindow = (a: any) => a.atMs >= WINDOW_FROM && a.atMs <= WINDOW_TO

  let result: any = null
  const ride = async () => {
    if (!result) result = await replay(fx, fx.meta.startMs, WINDOW_TO)
    return result
  }

  it('reaches the incident: transit pace on the bike leg, then the bus slowing', async () => {
    const { ticks } = await ride()
    const tick = (hms: string) => ticks.find((t: any) => hhmmss(t.tMs) === hms)
    expect(tick('09:54:13')).toEqual(
      expect.objectContaining({ legIndex: 0, riding: null, status: 'deviated' })
    )
    expect(tick('09:54:13')?.speed).toBeCloseTo(12.2, 1)
    expect(tick('09:54:14')?.speed).toBeCloseTo(11.8, 1)
    expect(tick('09:55:34')?.legIndex).toBe(0)
  })

  it('still holds on the 09:54:14 and 09:55:34 fixes that went out on the day', async () => {
    await ride()
    const holdAt = (hms: string) =>
      mockHolds.filter((h) => hhmmss(h.atMs) === hms)
    for (const hms of ['09:54:14', '09:55:34']) {
      expect(holdAt(hms).length).toBeGreaterThan(0)
      expect(holdAt(hms).every((h) => h.out)).toBe(true)
    }
  })

  it('sends no quiet re-plan and installs no bike leg back to Gate C', async () => {
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
    const swaps = actions.filter(
      (a: any) => inWindow(a) && a.type === 'START_GO_MODE'
    )
    expect(swaps).toHaveLength(0)
  })
})
