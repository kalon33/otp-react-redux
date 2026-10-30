import {
  calculateTimeRemaining,
  calculateTripProgress,
  smoothRiderPace
} from '../../../lib/util/go-mode/progress-calculator'
import slice from '../../mocks/eta-pace-1013-0831.json'
import type { RiderPace } from '../../../lib/util/go-mode/progress-calculator'

/**
 * THE ARRIVAL TIME MAY NOT THRASH ONCE THE PLAN END HAS PASSED — backlog 75.7.
 *
 * Replay `orange-bike-1013-0831` (session `mv6pyf7w-mzbql0`): the closing
 * 1,449.77 m bike leg to 3322 Columbus Ave, planned to end 08:47:07. The rider
 * was wheeling along at 0.44–1.12 m/s, ~1 km from the door. Once the plan end
 * passed, `calculateTimeRemaining` fell to `paceRemainingSeconds`, which
 * divided the ground ahead by THIS fix's speed when it was >= 0.5 m/s and by
 * 4.5 m/s below it: timeRemaining 1588.95, 1648.44, 2014.54, 304.89, 1941.09
 * … 2454.73 … 302.48, 2213.30 s from one second to the next. The real ride
 * did the same (20 swings > 10 min, debug-2026-10-13.jsonl 08:49:11–08:57:31).
 *
 * The slice is the replay's own ticks from the bike leg's TRANSITION_LEG
 * (08:44:35) to 08:47:30 on the replay clock: the fix, its speed, and the
 * route match the tick stored. Each tick is put through the pure producer the
 * store reads, with the pace folded the way handlePositionUpdate folds it.
 */

type Tick = {
  accuracy: number
  lat: number
  lon: number
  match: any
  speed?: number
  tMs: number
}

const itinerary = slice.itinerary as any
const ticks = slice.ticks as Tick[]
const PLAN_END_MS = Number(itinerary.endTime)

const hms = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/Chicago' })

const run = (withPace: boolean) => {
  let pace: RiderPace = {}
  return ticks.map((tick) => {
    pace = smoothRiderPace(pace, {
      mode: itinerary.legs[tick.match.legIndex].mode,
      speedMps: tick.speed ?? null,
      tMs: tick.tMs
    })
    const progress = calculateTripProgress(
      new Date(tick.tMs),
      itinerary,
      tick.match,
      null,
      undefined,
      tick.speed ?? null,
      null,
      null,
      [tick.lat, tick.lon],
      false,
      null,
      false,
      withPace ? pace : undefined
    )
    return { pace: pace.BICYCLE?.mps, progress, tick }
  })
}

const between = (rows: ReturnType<typeof run>, from: string, to: string) =>
  rows.filter((r) => hms(r.tick.tMs) >= from && hms(r.tick.tMs) <= to)

describe('75.7: the countdown after the plan end (orange-bike-1013-0831)', () => {
  it('is the 08:47:07 plan end, ~1 km out, at walking speed', () => {
    expect(hms(PLAN_END_MS)).toBe('08:47:07')
    const window = between(run(true), '08:47:07', '08:47:19')
    expect(window.length).toBe(13)
    for (const { tick } of window) {
      expect(tick.speed).toBeGreaterThan(0.44)
      expect(tick.speed).toBeLessThan(1.12)
      expect(tick.match.isOnRoute).toBe(true)
    }
  })

  it('as shipped (no pace supplied): the instantaneous speed thrashes it', () => {
    const rows = run(false)
    const tr = (clock: string) =>
      (rows.find((r) => hms(r.tick.tMs) === clock) as any).progress
        .timeRemaining
    // The replay's own numbers, to the hundredth.
    expect(tr('08:47:07')).toBeCloseTo(1588.95, 1)
    expect(tr('08:47:10')).toBeCloseTo(304.89, 1)
    expect(tr('08:47:14')).toBeCloseTo(2454.73, 1)
    expect(tr('08:47:18')).toBeCloseTo(302.48, 1)
    expect(tr('08:47:19')).toBeCloseTo(2213.3, 1)
  })

  it('with the smoothed pace, the arrival moves under 2 min per tick', () => {
    const window = between(run(true), '08:47:07', '08:47:30')
    for (let i = 1; i < window.length; i++) {
      const moved =
        window[i].progress.estimatedArrival.getTime() -
        window[i - 1].progress.estimatedArrival.getTime()
      expect(Math.abs(moved)).toBeLessThan(120000)
    }
  })

  it('still counts down from the ground ahead, at no less than walking pace (6.4)', () => {
    for (const { pace, progress, tick } of between(
      run(true),
      '08:47:07',
      '08:47:30'
    )) {
      const ahead =
        itinerary.legs[1].distance * (1 - tick.match.progressAlongLeg)
      // Past the plan end, so the pace answers — never the old zero.
      expect(tick.tMs).toBeGreaterThanOrEqual(PLAN_END_MS)
      expect(progress.timeRemaining).toBeGreaterThan(0)
      // ~1.36 km at the smoothed pace, which has fallen from the 4.5 m/s
      // bike figure toward the rider's walk and is floored at walking pace.
      expect(progress.timeRemaining).toBeCloseTo(
        ahead / Math.max(1.35, pace as number),
        6
      )
      expect(pace as number).toBeLessThan(4.5)
      expect(progress.timeRemaining).toBeLessThanOrEqual(ahead / 1.35 + 1e-6)
    }
  })
})

describe('75.7: smoothRiderPace', () => {
  const T0 = 1791900000000
  const ride = (pace: RiderPace, mps: number, seconds: number, from = T0) => {
    let next = pace
    for (let s = 0; s < seconds; s++) {
      next = smoothRiderPace(next, {
        mode: 'BICYCLE',
        speedMps: mps,
        tMs: from + s * 1000
      })
    }
    return next
  }

  it('starts from the mode’s own figure and converges on a steady rider', () => {
    expect(
      smoothRiderPace({}, { mode: 'BICYCLE', speedMps: 6, tMs: T0 }).BICYCLE.mps
    ).toBe(4.5)
    expect(
      smoothRiderPace({}, { mode: 'WALK', speedMps: null, tMs: T0 }).WALK.mps
    ).toBe(1.35)
    // Ten minutes at 6 m/s: the rider's pace, not the figure (6.4: a real
    // pace is preferred to the fallback).
    expect(ride({}, 6, 600).BICYCLE.mps).toBeCloseTo(6, 1)
  })

  it('holds through a red light: a stop is not a pace', () => {
    const cruising = ride({}, 5, 600)
    const stopped = ride(cruising, 0, 60, T0 + 600000)
    expect(stopped.BICYCLE.mps).toBe(cruising.BICYCLE.mps)
    // ...so the arrival slides by the stop and no more: the ground ahead and
    // the pace are both unchanged, only the clock moved.
    const ahead = { distanceRemainingM: 1000, mode: 'BICYCLE' }
    const plan: any = { endTime: T0, legs: [] }
    const before = calculateTimeRemaining(
      new Date(T0 + 600000),
      plan,
      0,
      0,
      null,
      {
        ...ahead,
        smoothedSpeedMps: cruising.BICYCLE.mps
      }
    )
    const after = calculateTimeRemaining(
      new Date(T0 + 660000),
      plan,
      0,
      0,
      null,
      {
        ...ahead,
        smoothedSpeedMps: stopped.BICYCLE.mps
      }
    )
    expect(after).toBe(before)
  })

  it('no single fix can swing it, however long since the last one', () => {
    const cruising = ride({}, 5, 600)
    const held = cruising.BICYCLE
    // First moving fix after a two-minute standstill, rolling at 1 m/s.
    const next = smoothRiderPace(cruising, {
      mode: 'BICYCLE',
      speedMps: 1,
      tMs: held.tMs + 120000
    }).BICYCLE.mps
    expect(held.mps - next).toBeLessThan((held.mps - 1) * 0.05)
  })

  it('takes nothing from a transit leg or an impossible fix', () => {
    const cruising = ride({}, 5, 600)
    expect(
      smoothRiderPace(cruising, { mode: 'BUS', speedMps: 14, tMs: T0 + 6e5 })
    ).toBe(cruising)
    expect(
      smoothRiderPace(cruising, {
        mode: 'BICYCLE',
        speedMps: 40,
        tMs: T0 + 6e5
      })
    ).toBe(cruising)
  })
})

describe('75.7: a transit leg past its anchor', () => {
  // orange-stall-0922-0804 08:41:21 (replay): waiting on the BUS leg, 17.7 km
  // of trip ahead, the fix reading 0.64 m/s — 27,627.8 s (7 h 40 min), and
  // 2,215.7 s on the next tick when the fix read 0.
  const plan: any = { endTime: 1790084000000, legs: [] }
  const now = new Date(1790084481000)
  const ahead = { distanceRemainingM: 17725.6, mode: 'BUS' }

  it('as shipped: the rider’s own speed sets it', () => {
    expect(
      calculateTimeRemaining(now, plan, 0, 0, null, {
        ...ahead,
        speedMps: 0.64158719789711
      })
    ).toBeCloseTo(27627.8, 0)
  })

  it('with a pace supplied: the transit figure, whatever the fix reads', () => {
    for (const speedMps of [0, 0.64158719789711, 14]) {
      expect(
        calculateTimeRemaining(now, plan, 0, 0, null, {
          ...ahead,
          smoothedSpeedMps: null,
          speedMps
        })
      ).toBeCloseTo(17725.6 / 8, 6)
    }
  })
})
