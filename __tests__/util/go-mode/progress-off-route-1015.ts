import {
  calculateDistance,
  MATCH_CORRIDOR_ACTIVE_M,
  matchPositionToRoute
} from '../../../lib/util/go-mode/position-matching'
import fixture from '../../mocks/progress-off-route-1015.json'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'

/**
 * PROGRESS MAY NOT JUMP ALONG A LEG ON GROUND RIDDEN AWAY FROM IT — backlog
 * 12.17, the 2026-10-15 sighting (was 54.5).
 *
 * Ride `mva4fpf5-hhg1cf`, DEV `2026.1015.1`, report
 * `2026-10-15-hhg1cf-ride3.md` §3. The 21:38:56 quiet re-plan installed a
 * 679.96 m bike leg to MOA Gate H that opens NORTH, runs west along 44.8552 and
 * comes back south to the gate. The rider rode SOUTH, then west. The
 * projection sat on the leg's first vertex at 0 % while `distanceFromRoute`
 * climbed 11 -> 339 m, and at 21:39:41.999 the leg's LAST vertex became the
 * nearer of the two: progress 0 -> 100 % in one tick, 334.6 m off the line.
 *
 * The jump budget let it through because its ground term is a scalar —
 * `unaccountedPathM` 419.9 m, 25 + 2 x 419.9 = 865 m against a 680 m advance —
 * so the metres ridden AWAY from the leg paid for the jump ALONG it.
 *
 * These run the recorded leg geometry and the recorded fixes through the real
 * matcher, threaded the way `handlePositionUpdate` threads them when the
 * leg-transition gate re-takes the match over the legs the trip has reached
 * (`itinerary.legs.slice(0, 1)` here — the recording stayed on leg 0
 * throughout). The opening tick runs on the cached last fix with a zero step,
 * as a re-plan's install does.
 *
 * The controls are two other recordings in which an off-corridor release is
 * honest and must keep its tick: 2026-09-21 16:38:31 (a rider on a parallel
 * street 196 m south of a leg that opened with a 130 m stub) and 2026-09-19
 * 14:40:29 (a corner, 107.5 m off).
 */

type Fix = { accuracy: number; lat: number; lon: number; tMs: number }
type Slice = { fixes: Fix[]; leg: any }

const slices = fixture as unknown as Record<string, Slice>

const hms = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/Chicago' })

const run = ({ fixes, leg }: Slice) => {
  const ticks: Array<{ fix: Fix; match: RouteMatchResult }> = []
  let previous: RouteMatchResult | null = null
  let previousFix: Fix | null = null
  for (const fix of fixes) {
    const movedSinceFixM =
      previousFix == null
        ? 0
        : calculateDistance(previousFix.lat, previousFix.lon, fix.lat, fix.lon)
    const match = matchPositionToRoute([fix.lat, fix.lon], [leg], 0, previous, {
      accuracyM: fix.accuracy,
      movedSinceFixM,
      nowMs: fix.tMs
    })
    if (!match) throw new Error('matcher returned no projection')
    ticks.push({ fix, match })
    previous = match
    previousFix = fix
  }
  return ticks
}

const at = (ticks: ReturnType<typeof run>, clock: string) => {
  const tick = ticks.find((t) => hms(t.fix.tMs) === clock)
  if (!tick) throw new Error(`no fix at ${clock}`)
  return tick.match
}

/** The biggest one-tick advance in metres inside [from, to], and its clock. */
const biggestAdvance = (
  ticks: ReturnType<typeof run>,
  legM: number,
  from: string,
  to: string
) => {
  let best = { at: '', m: 0 }
  for (let i = 1; i < ticks.length; i++) {
    const clock = hms(ticks[i].fix.tMs)
    if (clock < from || clock > to) continue
    const m =
      (ticks[i].match.progressAlongLeg - ticks[i - 1].match.progressAlongLeg) *
      legM
    if (m > best.m) best = { at: clock, m }
  }
  return best
}

describe('2026-10-15 21:38:56–21:40:56, the recording this row is built on', () => {
  const slice = slices['ride-1015-2130']
  const ticks = run(slice)

  it('is the 680 m Gate H leg on good fixes', () => {
    expect(slice.leg.distance).toBeCloseTo(679.96, 2)
    const window = ticks.filter(
      (t) => hms(t.fix.tMs) >= '21:38:56' && hms(t.fix.tMs) <= '21:39:55'
    )
    for (const { fix } of window) expect(fix.accuracy).toBeLessThan(5)
  })

  it('never jumps to the end of the leg while the rider is off it', () => {
    for (const { fix, match } of ticks) {
      if (hms(fix.tMs) > '21:40:56') break
      expect(match.progressAlongLeg).toBeLessThan(0.05)
    }
    expect(
      biggestAdvance(ticks, slice.leg.distance, '21:38:56', '21:40:56').m
    ).toBeLessThan(25)
  })

  it('was refused, not missed: the end vertex really did win from 21:39:41', () => {
    // The same fix, matched fresh: the global minimum is the leg's last vertex,
    // 334.6 m away — what the recording showed as 100 %.
    const found = ticks.find((t) => hms(t.fix.tMs) === '21:39:41')!
    const unheld = matchPositionToRoute(
      [found.fix.lat, found.fix.lon],
      [slice.leg],
      0
    ) as RouteMatchResult
    expect(unheld.progressAlongLeg).toBe(1)
    expect(unheld.distanceFromRoute).toBeCloseTo(334.6, 0)
    expect(unheld.isOnRoute).toBe(false)
    expect(at(ticks, '21:39:41').progressAlongLeg).toBe(0)
    // ...and the scalar budget alone would have licensed it.
    expect(at(ticks, '21:39:41').unaccountedPathM).toBeGreaterThan(
      (680 - 25) / 2
    )
  })

  it('reports the honest distance from the route while it refuses', () => {
    // A held projection used to freeze distanceFromRoute too (12.17's fourth
    // sighting). Off the corridor the winner's perpendicular is a real
    // measurement, so the deviation check sees the rider coming back.
    expect(at(ticks, '21:39:41').distanceFromRoute).toBeCloseTo(334.6, 0)
    expect(at(ticks, '21:39:55').distanceFromRoute).toBeCloseTo(271.4, 0)
    expect(at(ticks, '21:39:55').distanceFromRoute).toBeGreaterThan(
      MATCH_CORRIDOR_ACTIVE_M
    )
    expect(at(ticks, '21:39:55').isOnRoute).toBe(false)
  })
})

describe('honest off-corridor releases keep their tick', () => {
  it('2026-09-21 16:38:31: a parallel street 196 m off still releases 282 m', () => {
    const slice = slices['0921-1605-465-wrongdir']
    const ticks = run(slice)
    const release = biggestAdvance(
      ticks,
      slice.leg.distance,
      '16:38:05',
      '16:38:41'
    )
    expect(release.at).toBe('16:38:31')
    expect(release.m).toBeCloseTo(282.4, 0)
    expect(at(ticks, '16:38:31').isOnRoute).toBe(false)
    // The next 43 m (16:38:34) is refused: the rider has turned south, away
    // from the leg, and moved 7 m in its direction.
    expect(at(ticks, '16:38:34').progressAlongLeg).toBeCloseTo(0.2254, 4)
  })

  it('2026-09-19 14:40:29: the corner 107 m off still releases 225 m', () => {
    const slice = slices['orange-0919-1436']
    const ticks = run(slice)
    const release = biggestAdvance(
      ticks,
      slice.leg.distance,
      '14:40:10',
      '14:40:40'
    )
    expect(release.at).toBe('14:40:29')
    expect(release.m).toBeCloseTo(224.6, 0)
    expect(at(ticks, '14:40:29').isOnRoute).toBe(false)
  })
})

describe('the direction check needs its own evidence', () => {
  const slice = slices['ride-1015-2130']

  it('is off for a caller that supplies no step — the old search, exactly', () => {
    let previous: RouteMatchResult | null = null
    for (const fix of slice.fixes) {
      previous = matchPositionToRoute(
        [fix.lat, fix.lon],
        [slice.leg],
        0,
        previous,
        {
          accuracyM: fix.accuracy,
          nowMs: fix.tMs
        }
      )
      expect(previous?.unaccountedFromFix).toBeUndefined()
      if (hms(fix.tMs) === '21:39:41') break
    }
  })
})
