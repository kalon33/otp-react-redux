import { matchPositionToRoute } from '../../../lib/util/go-mode/position-matching'
import {
  QUIET_REPLAN_MIN_INTERVAL_MS,
  quietReplanAdmitted,
  shouldQuietReplanAccessLeg,
  smoothDistanceFromRoute
} from '../../../lib/util/go-mode/deviation'
import fixture from '../../../lib/util/go-mode/replay/fixtures/orange-line-0729.json'
import type { NotificationEvent } from '../../../lib/util/go-mode/notification-service'

const bikeLeg = { mode: 'BICYCLE', transitLeg: false } as any
const walkLeg = { mode: 'WALK', transitLeg: false } as any
const busLeg = { mode: 'BUS', transitLeg: true } as any

const deviation = { type: 'ROUTE_DEVIATION' } as unknown as NotificationEvent
const connection = {
  type: 'CONNECTION_AT_RISK'
} as unknown as NotificationEvent

/** Runs of consecutive ticks above a threshold. */
const runsAbove = (series: number[], threshold: number): number[] => {
  const out: number[] = []
  let n = 0
  series.forEach((d) => {
    if (d > threshold) n += 1
    else {
      if (n) out.push(n)
      n = 0
    }
  })
  if (n) out.push(n)
  return out
}

describe('util > go-mode > deviation smoothing over the 7/29 ride', () => {
  const f: any = fixture
  const raw: number[] = []
  const smoothed: number[] = []

  beforeAll(() => {
    let prev: number | null = null
    f.gpsTrack.forEach((fix: any) => {
      const match = matchPositionToRoute(
        [fix.lat, fix.lon],
        f.itinerary.legs,
        0
      )
      if (!match) return
      const s = smoothDistanceFromRoute(prev, match.distanceFromRoute)
      prev = s.next
      raw.push(match.distanceFromRoute)
      smoothed.push(s.distance)
    })
  })

  it('replays the ride it claims to', () => {
    expect(f.itinerary.legs.map((l: any) => l.mode)).toEqual([
      'BICYCLE',
      'BUS',
      'BICYCLE'
    ])
    expect(raw).toHaveLength(3560)
  })

  it('never reports the rider further off route than they are', () => {
    // The smoothing may only ever be kinder than the raw match.
    raw.forEach((d, i) => expect(smoothed[i]).toBeLessThanOrEqual(d))
  })

  it('costs sustained drift exactly one tick, and no more', () => {
    // This ride drifts twice, and both are real: 90 and 164 consecutive ticks
    // past 100 m, with NOT ONE single-tick spike among them. So it exercises
    // the cost side of the trade — each excursion is recognised one tick late —
    // and nothing here is suppressed that should not be.
    const rawRuns = runsAbove(raw, 100)
    const smoothRuns = runsAbove(smoothed, 100)
    expect(rawRuns).toEqual([90, 164])
    expect(smoothRuns).toEqual([89, 163])
  })

  it('suppresses a one-tick spike dropped into the same real series', () => {
    // The benefit side, which this ride happens not to contain. 7/22's 5836 m
    // multipath fix, inserted mid-ride where the rider was dead on the line.
    const spiked = [...raw]
    const at = 1000
    expect(spiked[at]).toBeLessThan(50)
    spiked[at] = 5836

    let prev: number | null = null
    const out = spiked.map((d) => {
      const s = smoothDistanceFromRoute(prev, d)
      prev = s.next
      return s.distance
    })
    // The spike never reaches the deviation check at all.
    expect(out[at]).toBe(spiked[at - 1])
    expect(out[at]).toBeLessThan(50)
    // And it does not linger into the following tick either.
    expect(out[at + 1]).toBeLessThan(50)
  })

  it('has no baseline to accuse the rider with on the first fix', () => {
    expect(smoothDistanceFromRoute(null, 900)).toEqual({
      distance: 0,
      next: 900
    })
  })
})

describe('util > go-mode > what deviation does about it', () => {
  it('quietly re-plans a rider who went their own way on foot or by bike', () => {
    expect(
      shouldQuietReplanAccessLeg({
        currentLeg: bikeLeg,
        notifications: [deviation],
        reRouteStatus: 'idle'
      })
    ).toBe(true)
    expect(
      shouldQuietReplanAccessLeg({
        currentLeg: walkLeg,
        notifications: [deviation],
        reRouteStatus: 'idle'
      })
    ).toBe(true)
  })

  it('does nothing automatic when the rider is on a bus', () => {
    // An auto-swap here would change downstream routes without their consent.
    expect(
      shouldQuietReplanAccessLeg({
        currentLeg: busLeg,
        notifications: [deviation],
        reRouteStatus: 'idle'
      })
    ).toBe(false)
  })

  it('needs an actual deviation, not just any alert', () => {
    expect(
      shouldQuietReplanAccessLeg({
        currentLeg: bikeLeg,
        notifications: [connection],
        reRouteStatus: 'idle'
      })
    ).toBe(false)
    expect(
      shouldQuietReplanAccessLeg({
        currentLeg: bikeLeg,
        notifications: [],
        reRouteStatus: 'idle'
      })
    ).toBe(false)
  })

  it('stands down while a search is in flight or a card is up', () => {
    const busy = ['searching', 'found', 'error']
    busy.forEach((reRouteStatus) => {
      expect(
        shouldQuietReplanAccessLeg({
          currentLeg: bikeLeg,
          notifications: [deviation],
          reRouteStatus
        })
      ).toBe(false)
    })
  })

  it('treats a settled empty attempt as replannable', () => {
    expect(
      shouldQuietReplanAccessLeg({
        currentLeg: bikeLeg,
        notifications: [deviation],
        reRouteStatus: 'none'
      })
    ).toBe(true)
  })
})

describe('util > go-mode > quiet re-plan admission', () => {
  const T0 = 1_785_361_461_418

  it('gives the rider time to converge on the new path first', () => {
    expect(
      quietReplanAdmitted({
        lastReplanAtMs: T0,
        nowMs: T0 + QUIET_REPLAN_MIN_INTERVAL_MS - 1,
        reRouteStatus: 'idle'
      })
    ).toBe(false)
    expect(
      quietReplanAdmitted({
        lastReplanAtMs: T0,
        nowMs: T0 + QUIET_REPLAN_MIN_INTERVAL_MS,
        reRouteStatus: 'idle'
      })
    ).toBe(true)
  })

  it('admits the first re-plan of a trip immediately', () => {
    // lastQuietReplanAt starts at 0 on a fresh session.
    expect(
      quietReplanAdmitted({
        lastReplanAtMs: 0,
        nowMs: T0,
        reRouteStatus: 'idle'
      })
    ).toBe(true)
  })

  it('will not start one over a search in flight', () => {
    expect(
      quietReplanAdmitted({
        lastReplanAtMs: 0,
        nowMs: T0,
        reRouteStatus: 'searching'
      })
    ).toBe(false)
    expect(
      quietReplanAdmitted({
        lastReplanAtMs: 0,
        nowMs: T0,
        reRouteStatus: 'none'
      })
    ).toBe(true)
  })
})
