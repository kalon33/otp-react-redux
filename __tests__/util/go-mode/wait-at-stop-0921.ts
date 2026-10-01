import { existsSync, readFileSync } from 'fs'
import path from 'path'

import {
  calculateDistance,
  matchPositionToRoute,
  TRANSIT_BOARD_STOP_RADIUS_M
} from '../../../lib/util/go-mode/position-matching'
import {
  calculateExpectedProgress,
  calculateTripProgress,
  determineTripStatus
} from '../../../lib/util/go-mode/progress-calculator'
import { waitingAtBoardingStop } from '../../../lib/util/go-mode/waiting-at-stop'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'

/**
 * Backlog 18.6 — standing at the boarding stop is not falling behind.
 *
 * `determineTripStatus` compares SPATIAL `overallProgress` with
 * `calculateExpectedProgress(itinerary.startTime, now, totalDuration)`, which
 * is purely time-based. A rider at the stop cannot make spatial progress, so
 * any wait longer than 5 % of the itinerary duration read `behind` and the
 * `delay` the rider was shown was how long they had been standing there.
 *
 * Three sightings, all at I-35W & Lake St, all on 2026-09-21:
 *
 *   09:19:00  mubbbiy9-6zjoq9 ride 1  leg 0 at 99.71 %, riderSpeedMps 0
 *   17:01:31  mubq7tfx-8dz3ar ride 2  leg 0 at 98.2 %, speed 0 (under 25.1's
 *                                     false missed-bus)
 *   17:57:15  mu63yfrb-ekv1fl (09-18) overallProgress frozen at 5.0079 for 75
 *                                     consecutive ticks while `delay` marched
 *                                     -95.9 -> -23.9 at +1 s/tick
 *
 * The decision taken in the cycle-3 plan is that the wait is neither ahead nor
 * behind, and a late bus is the BUS's delay.
 *
 * ## The row's proposed gate does not survive the ride
 *
 * The row asked for "the bus has not departed (`legBoard`, live preferred,
 * still ahead)". From `debug-2026-09-21.jsonl`, leg 1's live board epoch on
 * the 16:46 ride (every distinct `SET_LIVE_LEG_TIMES`, all `boardRealtime`):
 *
 *   16:57:07 -> 17:05:49   16:59:19 -> 17:06:16   17:04:01 -> 17:06:55
 *   16:57:55 -> 17:05:38   16:59:40 -> 17:06:13   17:04:22 -> 17:07:36
 *   16:58:36 -> 17:05:44   17:01:31 -> 17:06:17   17:04:42 -> 17:03:00
 *   16:58:58 -> 17:06:11   17:02:38 -> 17:06:20   17:05:03 .. 17:07:49 -> 17:03:00
 *
 * It tracked the late bus honestly and then fell back to a stale 17:03:00 from
 * 17:04:42 on, while `SET_RIDING` did not come until 17:08:19. A
 * `now < legBoard` gate releases at 17:04:42 and hands the rider back the
 * `behind` for the last three minutes of the wait. The gate built instead is
 * the spatial one `hasReachedBoardingStop` already uses for the leg
 * transition (13.1) — see waiting-at-stop.ts.
 *
 * ## The fixtures
 *
 * The 09-21 recordings are 13-15 MB and deliberately NOT committed, so every
 * block here measures the real rides when they are present and skips when they
 * are not.
 */

const FIXTURE_DIR = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)

const load = (name: string): any => {
  const p = path.join(FIXTURE_DIR, name)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

const MISSED_BUS = '0921-1646-orange-missedbus.json'
const LAKE_ST = '0921-0902-orange-lake-st.json'
const WRONG_DIR = '0921-1605-465-wrongdir.json'

const have = (n: string) => existsSync(path.join(FIXTURE_DIR, n))
const describeRide =
  have(MISSED_BUS) && have(LAKE_ST) && have(WRONG_DIR)
    ? describe
    : describe.skip

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

interface Tick {
  /** The status this tick would have had with the 18.6 gate off. */
  before: string
  distanceToBoardStopM: number | null
  fix: any
  progress: ReturnType<typeof calculateTripProgress>
}

/**
 * The ride's own ticks: match, then progress, exactly as handlePositionUpdate
 * drives them. `before` re-runs determineTripStatus on the SAME inputs with
 * the wait gate off, so the two columns differ in one term and nothing else.
 *
 * The itinerary in force is the last swap at or before the fix; the matcher is
 * reset on a swap because the app's is (a new itinerary is new geometry).
 */
function walk(fx: any, fromMs: number, toMs: number): Tick[] {
  const swaps = [
    { itinerary: fx.itinerary, tMs: fx.meta.startMs },
    ...(fx.itinerarySwaps || [])
  ]
  let match: RouteMatchResult | null = null
  let prevFix: any = null
  let swapIdx = -1
  const out: Tick[] = []
  for (const fix of fx.gpsTrack) {
    if (fix.tMs < fromMs || fix.tMs > toMs) continue
    let k = 0
    for (let i = 0; i < swaps.length; i++) if (swaps[i].tMs <= fix.tMs) k = i
    if (k !== swapIdx) {
      swapIdx = k
      match = null
      prevFix = null
    }
    const itinerary = swaps[k].itinerary
    const movedSinceFixM = prevFix
      ? calculateDistance(prevFix.lat, prevFix.lon, fix.lat, fix.lon)
      : undefined
    match = matchPositionToRoute(
      [fix.lat, fix.lon],
      itinerary.legs,
      match?.legIndex ?? 0,
      match,
      { accuracyM: fix.accuracy, movedSinceFixM, nowMs: fix.tMs }
    )
    prevFix = fix
    const progress = calculateTripProgress(
      new Date(fix.tMs),
      itinerary,
      match,
      null,
      undefined,
      fix.speed,
      null,
      null,
      [fix.lat, fix.lon]
    )
    const totalDuration =
      (new Date(itinerary.endTime).getTime() -
        new Date(itinerary.startTime).getTime()) /
      1000
    const before = determineTripStatus(
      match,
      calculateExpectedProgress(
        new Date(itinerary.startTime),
        new Date(fix.tMs),
        totalDuration
      ),
      progress.overallProgress,
      progress.distanceToDestination,
      false,
      progress.finalLegProgress,
      false
    )
    const legs = itinerary.legs
    const li = progress.currentLegIndex
    const bi = legs[li]?.transitLeg
      ? li
      : legs[li + 1]?.transitLeg
      ? li + 1
      : -1
    out.push({
      before,
      distanceToBoardStopM:
        bi >= 0 && legs[bi].from?.lat != null
          ? calculateDistance(
              fix.lat,
              fix.lon,
              legs[bi].from.lat,
              legs[bi].from.lon
            )
          : null,
      fix,
      progress
    })
  }
  return out
}

const count = (ticks: Tick[], pick: (t: Tick) => boolean) =>
  ticks.filter(pick).length

const atStop = (t: Tick) =>
  t.distanceToBoardStopM != null &&
  t.distanceToBoardStopM <= TRANSIT_BOARD_STOP_RADIUS_M

describeRide('util > go-mode > 18.6: the platform wait, on the rides', () => {
  it('16:46 ride: zero `behind` across the 16:57-17:08 wait (was 115)', () => {
    const fx = load(MISSED_BUS)
    // 16:57:00 - 17:08:00 local. SET_RIDING landed at 17:08:19.
    const ticks = walk(fx, 1790027820000, 1790028480000)
    expect(ticks.length).toBe(390)

    // The row's own instant, reproduced: the flip is at 17:01:31.
    const firstBefore = ticks.find((t) => t.before === 'behind')
    expect(hhmmss(firstBefore!.fix.tMs)).toBe('17:01:31')
    // ...on the TRANSIT leg with its progress pinned at 0 — the trip had
    // already stepped onto leg 1 (13.1's early transition), which is why the
    // gate's transit-leg branch is the one that carries this ride.
    expect(firstBefore!.progress.currentLegIndex).toBe(1)
    expect(firstBefore!.progress.currentLegProgress).toBeLessThan(0.1)

    expect(count(ticks, (t) => t.before === 'behind')).toBe(115)
    expect(count(ticks, (t) => t.progress.status === 'behind')).toBe(0)
    // Within the stop radius specifically: 113 -> 0.
    expect(count(ticks, (t) => atStop(t) && t.before === 'behind')).toBe(113)
    expect(
      count(ticks, (t) => atStop(t) && t.progress.status === 'behind')
    ).toBe(0)

    // The wait is published, and the delay it used to carry is zero.
    const waiting = ticks.filter((t) => t.progress.waitingAtBoardingStop)
    expect(waiting.length).toBeGreaterThan(300)
    waiting.forEach((t) => expect(t.progress.delay).toBe(0))
  })

  it('09:02 ride: the 09:19 flip goes, and moving off the stop ends it', () => {
    const fx = load(LAKE_ST)
    // 09:14:00 - 09:30:00 local. The row's sighting is 09:19:00.
    const ticks = walk(fx, 1790000040000, 1790001000000)
    expect(count(ticks, (t) => t.before === 'behind')).toBe(236)
    expect(count(ticks, (t) => t.progress.status === 'behind')).toBe(31)
    // At the stop it is total: 204 -> 0.
    expect(count(ticks, (t) => atStop(t) && t.before === 'behind')).toBe(204)
    expect(
      count(ticks, (t) => atStop(t) && t.progress.status === 'behind')
    ).toBe(0)

    // The 31 that remain are 09:20:09-09:20:38, 147-846 m from the stop with
    // the leg's own progress already moving: the rider left. The gate is a
    // statement about standing at a stop, not a licence to stop measuring.
    const left = ticks.filter((t) => t.progress.status === 'behind')
    expect(hhmmss(left[0].fix.tMs)).toBe('09:20:09')
    expect(hhmmss(left[left.length - 1].fix.tMs)).toBe('09:20:38')
    left.forEach((t) =>
      expect(t.distanceToBoardStopM).toBeGreaterThan(
        TRANSIT_BOARD_STOP_RADIUS_M
      )
    )
  })

  it('16:05 ride: a rider still travelling to the stop keeps saying behind', () => {
    const fx = load(WRONG_DIR)
    // 16:05:00 - 16:23:00 local; the 465 came at 16:31:17.
    const ticks = walk(fx, 1790024700000, 1790025780000)
    expect(count(ticks, (t) => t.before === 'behind')).toBe(636)
    expect(count(ticks, (t) => t.progress.status === 'behind')).toBe(215)

    // This is the control the row asks for. The rider was 911-1086 m out at
    // 37-42 % of the bike leg at 16:10:30 and that `behind` is honest — it
    // survives, because none of the arrival terms hold.
    const far = ticks.filter(
      (t) =>
        t.progress.status === 'behind' &&
        (t.distanceToBoardStopM ?? 0) > TRANSIT_BOARD_STOP_RADIUS_M
    )
    expect(far.length).toBeGreaterThan(150)

    // Inside the radius, 453 -> 32, and every one of the 32 is a rider still
    // moving faster than walking pace: the stop radius alone does not silence
    // someone riding in late.
    expect(count(ticks, (t) => atStop(t) && t.before === 'behind')).toBe(453)
    const near = ticks.filter(
      (t) => atStop(t) && t.progress.status === 'behind'
    )
    expect(near.length).toBe(32)
    near.forEach((t) => expect(t.fix.speed).toBeGreaterThan(1.5))
  })
})

/**
 * The gate itself, away from the rides. Every term is a positive fact, and a
 * missing input never manufactures a wait.
 */
describe('util > go-mode > 18.6: waitingAtBoardingStop', () => {
  const STOP = { lat: 44.948, lon: -93.2795, name: 'I-35W & Lake St Station' }
  const bikeLeg: any = {
    distance: 3000,
    from: { lat: 44.92, lon: -93.28 },
    mode: 'BICYCLE',
    to: STOP
  }
  const busLeg: any = {
    distance: 8000,
    from: STOP,
    mode: 'BUS',
    to: { lat: 44.97, lon: -93.27 },
    transitLeg: true
  }
  const legs = [bikeLeg, busLeg]

  it('holds on the transit leg until the bus has gone 150 m', () => {
    const at = (progressAlongLeg: number) =>
      waitingAtBoardingStop({
        currentLegIndex: 1,
        legs,
        progressAlongLeg,
        riderPosition: [STOP.lat, STOP.lon],
        riderSpeedMps: 0
      })
    expect(at(0)).toBe(true)
    // 0.018 * 8000 m = 144 m — still at the kerb.
    expect(at(0.018)).toBe(true)
    // 0.02 * 8000 m = 160 m — gone.
    expect(at(0.02)).toBe(false)
  })

  it('ignores GPS scatter at the platform, which a radius would not', () => {
    // 181 m north of the stop node: the widest fix in the 16:57-17:08 wait.
    expect(
      waitingAtBoardingStop({
        currentLegIndex: 1,
        legs,
        progressAlongLeg: 0,
        riderPosition: [STOP.lat + 0.00163, STOP.lon],
        riderSpeedMps: 0
      })
    ).toBe(true)
  })

  it('the riding fact ends it whatever the geometry says', () => {
    expect(
      waitingAtBoardingStop({
        currentLegIndex: 1,
        legs,
        progressAlongLeg: 0,
        riderPosition: [STOP.lat, STOP.lon],
        riderSpeedMps: 0,
        ridingLegIndex: 1
      })
    ).toBe(false)
  })

  it('on the access leg wants arrival, not proximity alone', () => {
    const near = (riderSpeedMps: number | null, progressAlongLeg = 0.6) =>
      waitingAtBoardingStop({
        currentLegIndex: 0,
        legs,
        progressAlongLeg,
        riderPosition: [STOP.lat, STOP.lon],
        riderSpeedMps
      })
    // Standing at the stop.
    expect(near(0)).toBe(true)
    // Still riding in at 6 m/s, 0 m away: not arrived.
    expect(near(6)).toBe(false)
    // A speed the platform never reported is not evidence of travel.
    expect(near(null)).toBe(true)
    // ...and running the access leg out is arrival on its own.
    expect(
      waitingAtBoardingStop({
        currentLegIndex: 0,
        legs,
        progressAlongLeg: 0.96,
        riderPosition: [44.92, -93.28],
        riderSpeedMps: 6
      })
    ).toBe(true)
  })

  it('says nothing when there is no boarding in reach', () => {
    expect(
      waitingAtBoardingStop({
        currentLegIndex: 0,
        legs: [bikeLeg],
        progressAlongLeg: 1,
        riderPosition: [STOP.lat, STOP.lon],
        riderSpeedMps: 0
      })
    ).toBe(false)
    // No fix, mid-access-leg: nothing positive to go on.
    expect(
      waitingAtBoardingStop({
        currentLegIndex: 0,
        legs,
        progressAlongLeg: 0.5,
        riderPosition: null,
        riderSpeedMps: null
      })
    ).toBe(false)
  })
})

/**
 * determineTripStatus keeps its order: the wait suppresses the CLOCK
 * comparison and nothing else.
 */
describe('util > go-mode > 18.6: determineTripStatus ordering', () => {
  const onRoute: any = {
    distanceFromRoute: 3,
    isOnRoute: true,
    legIndex: 1,
    progressAlongLeg: 0
  }
  it('a waiting rider reads on_track where they read behind', () => {
    expect(determineTripStatus(onRoute, 60, 5, 5000, false, null, false)).toBe(
      'behind'
    )
    expect(determineTripStatus(onRoute, 60, 5, 5000, false, null, true)).toBe(
      'on_track'
    )
  })
  it('does not rescue a deviated projection or hide an arrival', () => {
    const off = { ...onRoute, isOnRoute: false }
    expect(determineTripStatus(off, 60, 5, 5000, false, null, true)).toBe(
      'deviated'
    )
    expect(determineTripStatus(null, 60, 5, 5000, false, null, true)).toBe(
      'deviated'
    )
    expect(determineTripStatus(onRoute, 60, 99.7, 10, false, null, true)).toBe(
      'completed'
    )
  })
})
