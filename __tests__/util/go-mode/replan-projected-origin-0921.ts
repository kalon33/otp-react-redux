/* globals afterEach, beforeEach, describe, expect, it, jest */
import { existsSync } from 'fs'
import path from 'path'

import FakeTimers from '@sinonjs/fake-timers'

import {
  angleBetweenDegrees,
  bearingDegrees
} from '../../../lib/util/go-mode/replan-origin'
import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import { endGoMode, handlePositionUpdate } from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(
    () => () => Promise.resolve({ error: true, itineraries: [] })
  ),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * 2026-09-21, backlog 24.3 — the re-plan that starts where the rider was.
 *
 * Two rides, one shape. After alighting at I-35W & Lake St the app issued
 * three full-trip re-plans in 61 s, each anchored to a GPS fix that was ten
 * seconds old by the time the itinerary was installed, each opening with a
 * turn the rider had already passed. The 17:27 ride repeated it more mildly:
 * two re-plans 84 s apart, the second from an origin 68 m behind.
 *
 * ## Two corrections to the row, both load-bearing
 *
 * **The latency is not 76 s, it is ~10 s.** The row reads it off
 * `REROUTE_SNAPSHOT` 16:36:49 -> `START_GO_MODE` 16:38:05. Those are unrelated
 * events: the snapshots that ride land at 16:36:49.309, 16:38:19.811,
 * 16:39:49.287 and 16:41:19.324 — the flat 90 s `REROUTE_SNAPSHOT_INTERVAL_MS`
 * cadence — and no reducer consumes them. The `describe` below proves the real
 * pairing out of the fixture: each swap's `legs[0].from` is a recorded GPS fix
 * to twelve decimal places, and that fix is 9.8-10.1 s older than the swap.
 *
 * **It is not the deviation re-plan.** `reRouteFromCurrentPosition` /
 * `START_REROUTE` fired ZERO times in 16:36-16:40 (checked in
 * `debug-2026-09-21.jsonl`). All three were `quietReplanAccessLeg`'s full-trip
 * fallback: `ONBOARD_CANDIDATE_SNAPSHOT {reason: 'quiet-replan-full'}` and a
 * `START_GO_MODE` 8-12 ms later.
 *
 * ## What the second describe measures, and what it models
 *
 * The real tick runs over the ride's own fixes. The plan fetch is deferred by
 * the round trip the ride actually measured, so the itinerary lands against
 * the fix that was current when it landed — which is the whole defect. The one
 * thing modelled is OTP's answer: a plan from the PROJECTED origin was never
 * requested, so it was never recorded. The mock therefore replays the recorded
 * itinerary with its first leg moved to whatever origin the code asked for —
 * exactly what OTP did on the day (every recorded swap's `legs[0].from` IS its
 * request's `fromPlace`) — and leaves the geometry and the clock alone, so the
 * route matching the tick does afterwards is the ride's own.
 */

/**
 * Both recordings are multi-megabyte and deliberately NOT committed, so every
 * block here measures the real rides when they are present and skips when they
 * are not.
 */
const FIXTURE_DIR = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)
const EVENING = path.join(FIXTURE_DIR, '0921-1605-465-wrongdir.json')
const LATER = path.join(FIXTURE_DIR, '0921-1727-newbundle.json')
const hasFixtures = existsSync(EVENING) && existsSync(LATER)
const describeRide = hasFixtures ? describe : describe.skip
// eslint-disable-next-line @typescript-eslint/no-var-requires
const evening: any = hasFixtures ? require(EVENING) : null
// eslint-disable-next-line @typescript-eslint/no-var-requires
const later: any = hasFixtures ? require(LATER) : null

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

const mockedPlan = fetchOnboardCandidatePlan as unknown as jest.Mock

/**
 * The windows the row names, opened one leg transition early so the matcher
 * starts where the ride's own matcher was.
 *
 * 16:36:20 is 9 s after `TRANSITION_LEG 1` (16:36:29 in the stream, the rider
 * already walking away from I-35W & Lake St) and 95 s before the first
 * re-plan; 17:33:30 is on the closing bike leg of the 17:27 ride, 71 s before
 * its first.
 */
const EVENING_FROM = Date.parse('2026-09-21T21:36:20Z')
const EVENING_ARM = Date.parse('2026-09-21T21:37:00Z')
const EVENING_TO = Date.parse('2026-09-21T21:41:00Z')
const LATER_FROM = Date.parse('2026-09-21T22:33:30Z')
const LATER_ARM = Date.parse('2026-09-21T22:34:10Z')
const LATER_TO = Date.parse('2026-09-21T22:37:30Z')

describeRide('util > go-mode > 24.3: the ride as recorded', () => {
  it('pairs each swap with the quiet re-plan that produced it, ~10 s late', () => {
    const fulls = evening.quietReplanPlans.filter(
      (p: any) => p.reason === 'quiet-replan-full'
    )
    expect(fulls).toHaveLength(3)
    const swaps = evening.itinerarySwaps.slice(3)
    expect(swaps).toHaveLength(3)

    const latencies: number[] = []
    fulls.forEach((plan: any, i: number) => {
      const [lat, lon] = plan.request.variables.fromPlace
        .split('::')[1]
        .split(',')
        .map(Number)
      // The swap the app installed starts exactly where the request asked.
      expect(swaps[i].itinerary.legs[0].from.lat).toBeCloseTo(lat, 6)
      expect(swaps[i].itinerary.legs[0].from.lon).toBeCloseTo(lon, 6)
      // ...and that point is a GPS fix, not a synthesised one.
      const fix = evening.gpsTrack.reduce((best: any, f: any) =>
        calculateDistance(lat, lon, f.lat, f.lon) <
        calculateDistance(lat, lon, best.lat, best.lon)
          ? f
          : best
      )
      expect(calculateDistance(lat, lon, fix.lat, fix.lon)).toBeLessThan(0.01)
      latencies.push(plan.tMs - fix.tMs)
    })
    // 10.018 / 10.099 / 9.845 s — not the row's 76 s.
    latencies.forEach((ms) => {
      expect(ms).toBeGreaterThan(9000)
      expect(ms).toBeLessThan(11000)
    })
    expect(latencies.map((ms) => Math.round(ms / 100) / 10)).toEqual([
      10, 10.1, 9.8
    ])
  })

  it('the REROUTE_SNAPSHOTs are the 90 s cadence, not those requests', () => {
    const late = evening.rerouteSnapshots.filter(
      (s: any) => s.tMs > EVENING_FROM
    )
    const stamps = late.map((s: any) => hhmmss(s.tMs))
    expect(stamps).toEqual(['16:36:49', '16:38:19', '16:39:49', '16:41:19'])
    for (let i = 1; i < late.length; i++) {
      const gap = late[i].tMs - late[i - 1].tMs
      expect(gap).toBeGreaterThan(89000)
      expect(gap).toBeLessThan(91000)
    }
  })

  it('every installed plan began behind the rider, by heading', () => {
    const behind = [
      ...evening.itinerarySwaps.slice(3),
      ...later.itinerarySwaps
    ].map((swap: any) => {
      const at = swap.tMs
      const fix = later.gpsTrack
        .concat(evening.gpsTrack)
        .reduce((best: any, f: any) =>
          Math.abs(f.tMs - at) < Math.abs(best.tMs - at) ? f : best
        )
      const from = swap.itinerary.legs[0].from
      const gap = calculateDistance(fix.lat, fix.lon, from.lat, from.lon)
      const toOrigin = bearingDegrees(fix.lat, fix.lon, from.lat, from.lon)
      return {
        deg: Math.round(angleBetweenDegrees(toOrigin as number, fix.heading)),
        gap: Math.round(gap * 10) / 10
      }
    })
    expect(behind.map((b) => b.gap)).toEqual([58.2, 65.4, 33.9, 9.1, 68.2])
    expect(behind.map((b) => b.deg)).toEqual([106, 174, 137, 180, 158])
    // Every one of them in the rear half-plane: this is not GPS scatter.
    behind.forEach((b) => expect(b.deg).toBeGreaterThan(90))
  })
})

/**
 * One ride's window, run through the real tick.
 *
 * `latencyMs` is the round trip that ride measured, held open with a deferred
 * promise so the ticks in between really run.
 */
function runWindow({
  armFromMs,
  fixture,
  fromMs,
  itinerary,
  latencies,
  swaps,
  toMs
}: {
  /**
   * Before this instant the harness answers every plan with nothing.
   *
   * The window has to open on the BUS leg so the matcher walks onto the bike
   * leg the way the ride's own matcher did (it transitions at 16:36:31 here,
   * 16:36:29 in the stream). While it is still on the spent bus leg,
   * `findBoardLegIndex` sees a boarding the rider has in fact already made and
   * `reRouteFromCurrentPosition` fires a missed-bus recovery — a harness
   * artefact, because the real app carried the riding and alight facts this
   * store does not. The ride itself has ZERO `START_REROUTE` in the window.
   * Answering nothing until the matcher is on the access leg settles it
   * exactly as an empty OTP response would, and installs nothing.
   */
  armFromMs: number
  fixture: any
  fromMs: number
  itinerary: any
  latencies: number[]
  swaps: any[]
  toMs: number
}) {
  const initial = goMode(undefined, { type: '@@INIT' })
  let goModeState: any = {
    ...initial,
    activeItinerary: itinerary,
    isActive: true,
    tracking: { ...initial.tracking, lastPosition: null }
  }
  const actions: any[] = []
  const requests: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {}, trips: {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    goModeState = goMode(goModeState, action)
    return action
  }

  const pending: Array<{ at: number; settle: () => void }> = []
  mockedPlan.mockImplementation((combo: any) => () => {
    if (Date.now() < armFromMs) {
      return Promise.resolve({ error: false, itineraries: [] })
    }
    const n = requests.length
    requests.push({ combo, sentAtMs: Date.now() })
    const latency = latencies[Math.min(n, latencies.length - 1)]
    // OTP starts the plan where it was asked to — the one thing modelled.
    const served = swaps[Math.min(n, swaps.length - 1)]
    const answer = {
      ...served,
      legs: served.legs.map((leg: any, i: number) =>
        i === 0
          ? {
              ...leg,
              from: { ...leg.from, lat: combo.from.lat, lon: combo.from.lon }
            }
          : { ...leg }
      )
    }
    return new Promise((resolve) => {
      pending.push({
        at: Date.now() + latency,
        settle: () =>
          resolve({
            error: false,
            itineraries: [answer],
            query: {},
            response: null,
            variables: {}
          })
      })
    })
  })

  const clock = FakeTimers.install({ now: fromMs - 1000, toFake: ['Date'] })
  const flush = async (nowMs: number) => {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].at <= nowMs) {
        pending[i].settle()
        pending.splice(i, 1)
      }
    }
    // Let the awaited thunks run to their beginGoMode.
    for (let i = 0; i < 6; i++) await Promise.resolve()
  }

  return (async () => {
    try {
      for (const fix of fixture.gpsTrack) {
        if (fix.tMs < fromMs || fix.tMs > toMs) continue
        clock.setSystemTime(fix.tMs)
        await flush(fix.tMs)
        dispatch(
          handlePositionUpdate({
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
        )
        await flush(fix.tMs)
      }
      return { actions, dispatch, getGoMode: () => goModeState, requests }
    } finally {
      dispatch(endGoMode())
      clock.uninstall()
    }
  })()
}

describeRide(
  'util > go-mode > 24.3: the 16:36-16:40 loop, on this branch',
  () => {
    beforeEach(() => mockedPlan.mockReset())
    afterEach(() => mockedPlan.mockReset())

    it('installs ONE automatic re-plan where the ride installed three', async () => {
      const { actions, requests } = await runWindow({
        armFromMs: EVENING_ARM,
        fixture: evening,
        fromMs: EVENING_FROM,
        // What the rider was on when they alighted: the 16:31:17 swap.
        itinerary: evening.itinerarySwaps[2].itinerary,
        latencies: [10018, 10099, 9845],
        swaps: evening.itinerarySwaps.slice(3).map((s: any) => s.itinerary),
        toMs: EVENING_TO
      })
      const installed = actions.filter((a) => a.type === 'START_GO_MODE')
      expect(installed).toHaveLength(1)

      // It goes out on the same tick the ride's first one did — the matcher
      // crosses the 120 m bike threshold at 16:37:55 here and at 16:37:55 in the
      // stream — so this is the ride's own re-plan, kept.
      expect(hhmmss(requests[0].sentAtMs)).toBe('16:37:55')
      const verdicts = actions.filter((a) => a.type === 'AUTO_REPLAN')
      expect(verdicts[0].payload).toMatchObject({
        accepted: true,
        autoApply: true,
        reason: 'quiet-replan-full'
      })

      // The ride's 16:38:31 and 16:38:56 re-plans are never even asked for: the
      // rider was off the 16:38:05 plan 11 s after it landed, which arms the
      // two-minute backoff. The next question the app asks is at 16:39:55, and
      // that one comes back starting 46 m behind them and is refused.
      expect(requests.map((r: any) => hhmmss(r.sentAtMs))).toEqual([
        '16:37:55',
        '16:39:55'
      ])
      expect(verdicts).toHaveLength(2)
      expect(verdicts[1].payload.refusedBecause).toBe('origin-behind-heading')
    })

    it('asks from where the rider will be, and for the minute they get there', async () => {
      const { requests } = await runWindow({
        armFromMs: EVENING_ARM,
        fixture: evening,
        fromMs: EVENING_FROM,
        itinerary: evening.itinerarySwaps[2].itinerary,
        latencies: [10018, 10099, 9845],
        swaps: evening.itinerarySwaps.slice(3).map((s: any) => s.itinerary),
        toMs: EVENING_TO
      })
      const { combo } = requests[0]
      // The fix the request went out on: 16:37:55, 44.945461 / -93.272846.
      // Projected 9.5 s along heading 179.8 at 7.11 m/s -> ~67 m south.
      const moved = calculateDistance(
        44.94546112213161,
        -93.27284622385396,
        combo.from.lat,
        combo.from.lon
      )
      expect(moved).toBeGreaterThan(60)
      expect(moved).toBeLessThan(75)
      // ...and the query is anchored to when the rider gets there, TO THE
      // SECOND. The recorded request asked for "16:37" — the minute the fix
      // fell in — and the plan OTP returned started at 16:37:00 while the app
      // installed it at 16:38:05.029, which is the whole 65.029 s that ride
      // opened `behind` by. 24.3 alone moved the anchor to 16:38:04.5 and
      // `OTP_API_TIME_FORMAT` floored it straight back to 16:38:00, leaving
      // 5.029 s; 18.4's `GO_MODE_API_TIME_FORMAT` asks for the second itself.
      expect(combo.time).toBe('16:38:04')
      expect(combo.date).toBe('2026-09-21')
    })

    it('the plan it installs no longer begins behind the rider', async () => {
      const { actions } = await runWindow({
        armFromMs: EVENING_ARM,
        fixture: evening,
        fromMs: EVENING_FROM,
        itinerary: evening.itinerarySwaps[2].itinerary,
        latencies: [10018, 10099, 9845],
        swaps: evening.itinerarySwaps.slice(3).map((s: any) => s.itinerary),
        toMs: EVENING_TO
      })
      const verdict = actions.find((a) => a.type === 'AUTO_REPLAN')
      // 58.2 m on the day; ~20 m here, and inside the "honest gap" bound that
      // AUTO_REPLAN_ORIGIN_BEHIND_MAX_M draws at 25 m.
      expect(verdict.payload.originGapM).toBeLessThan(25)
      expect(verdict.payload.projectedM).toBeGreaterThan(60)
    })
  }
)

describeRide(
  'util > go-mode > 24.3: the 17:34-17:37 pair, on this branch',
  () => {
    beforeEach(() => mockedPlan.mockReset())
    afterEach(() => mockedPlan.mockReset())

    it('keeps the re-plan the rider rode and refuses the one behind them', async () => {
      const { actions, requests } = await runWindow({
        armFromMs: LATER_ARM,
        fixture: later,
        fromMs: LATER_FROM,
        itinerary: later.itinerary,
        latencies: [1679, 9502],
        swaps: later.itinerarySwaps.map((s: any) => s.itinerary),
        toMs: LATER_TO
      })
      const installed = actions.filter((a) => a.type === 'START_GO_MODE')
      expect(installed).toHaveLength(1)
      const verdicts = actions.filter((a) => a.type === 'AUTO_REPLAN')
      expect(verdicts.map((v: any) => v.payload.accepted)).toEqual([
        true,
        false
      ])

      // The one the rider actually rode: it lands 36 m from them, ahead, and
      // the ride shows them converging onto it (`behind` -> `on_track` in 14 s).
      expect(hhmmss(requests[0].sentAtMs)).toBe('17:34:41')
      expect(verdicts[0].payload.projectedM).toBeGreaterThan(35)

      // The 17:36:06 one, which the ride installed: still behind them with the
      // projection applied — a corner the heading could not see — so it is
      // refused instead, and that refusal arms the same backoff an ignored
      // re-plan does.
      expect(hhmmss(requests[1].sentAtMs)).toBe('17:35:57')
      expect(verdicts[1].payload.refusedBecause).toBe('origin-behind-heading')
      expect(requests).toHaveLength(2)
    })
  }
)
