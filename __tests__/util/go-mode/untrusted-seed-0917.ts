import {
  calculateDistance,
  MATCH_FIX_ACCURACY_TRUSTED_M,
  matchPositionToRoute
} from '../../../lib/util/go-mode/position-matching'
import fixture from '../../mocks/untrusted-seed-0917.json'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'

/**
 * WHAT THE CONTINUITY GATE WAS HANDED — backlog 12.17, ninth sighting.
 *
 * 2026-09-17 ride 2 (`mu69yw00-bo98a0`, 20:53:37–20:54:01 CDT): the trip's
 * opening tick ran on a CACHED fix — 44.94989,-93.23757, accuracy 207.7 m, no
 * speed — and 1.9 s later the `missed-bus` swap replayed that identical stale
 * fix as the opening tick of the new itinerary. It seeded a held projection at
 * `progressAlongLeg 0.003355`, `distanceFromRoute 38.601`,
 * `nearestPoint 44.949651,-93.237922`. From 20:53:38 the phone delivered real
 * fixes (3.5–9.3 m, ~5 m/s) whose own projection was 590 m further along the
 * 3,614 m leg, and every `UPDATE_ROUTE_MATCH` for 23 ticks re-emitted that
 * byte-identical triple before releasing to 0.166793 at 20:54:01.
 *
 * The gate did nothing wrong, and the arithmetic is exact: the first real fix
 * carried the rider 166 m from the stale one, so `unaccountedPathM` opened at
 * 166.31 and grew ~5 m a tick, while the budget it has to beat is
 * `MATCH_JUMP_SLACK_MOVED_M (25) + 2 x unaccountedPathM` against a 590 m gap —
 * 283.29 m of unaccounted ground is the tick that pays for it.
 *
 * What was wrong is what the gate was HANDED. A leg's OPENING match is ungated
 * by design (`exceedsJumpBudget` returns false with no previous match), and
 * `jumpCeilingMps` consults accuracy only to lower the ceiling a fix may move
 * the projection BY. Nothing consulted accuracy on the way IN, so a fix that
 * could not place the rider inside a city block established the projection
 * every honest fix afterwards was then measured against.
 *
 * These run the recorded leg geometry and the recorded fixes through the real
 * matcher. The release logic is deliberately untouched, and the control below
 * holds it in place: the same track seeded from the same wrong place, on a fix
 * good enough to believe, still waits the recorded 23 ticks.
 */

type Fix = { accuracy: number; lat: number; lon: number; tMs: number }

const legs: any[] = [(fixture as any).leg]
const recorded: Fix[] = (fixture as any).fixes

/**
 * Thread fixes through the matcher exactly as `handlePositionUpdate` does:
 * last tick's match as `previousMatch`, the ground step since the last FIX as
 * `movedSinceFixM`, and the fix's own clock as `nowMs`.
 */
const run = (fixes: Fix[]) => {
  const matches: RouteMatchResult[] = []
  let previous: RouteMatchResult | null = null
  let previousFix: Fix | null = null
  for (const fix of fixes) {
    const movedSinceFixM =
      previousFix == null
        ? null
        : calculateDistance(previousFix.lat, previousFix.lon, fix.lat, fix.lon)
    const match = matchPositionToRoute([fix.lat, fix.lon], legs, 0, previous, {
      accuracyM: fix.accuracy,
      movedSinceFixM,
      nowMs: fix.tMs
    })
    if (!match) throw new Error('matcher returned no projection')
    matches.push(match)
    previous = match
    previousFix = fix
  }
  return matches
}

/** Ticks after the seed that keep the seed's own projection verbatim. */
const heldTicks = (matches: RouteMatchResult[]) => {
  const seeded = matches[0].progressAlongLeg
  let n = 0
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].progressAlongLeg !== seeded) break
    n++
  }
  return n
}

/** The same recorded track with the opening fix's accuracy overridden. */
const withSeedAccuracy = (accuracy: number): Fix[] => [
  { ...recorded[0], accuracy },
  ...recorded.slice(1)
]

describe('the recording this row is built on', () => {
  it('is the 09-17 swap: a 207.7 m cached fix, then a real track 590 m along', () => {
    expect(recorded[0].accuracy).toBeCloseTo(207.674, 3)
    expect(recorded[1].accuracy).toBeLessThan(10)
    // 166 m between the stale fix and the first real one — the ground that
    // opens the budget, and nowhere near the 590 m the projection owes.
    expect(
      calculateDistance(
        recorded[0].lat,
        recorded[0].lon,
        recorded[1].lat,
        recorded[1].lon
      )
    ).toBeCloseTo(166.3, 1)
  })
})

describe('the release logic itself is untouched', () => {
  it('still waits the recorded 23 ticks when the seed was trustworthy', () => {
    // The control, and the reason the fix is the seed and not the release: the
    // identical track, seeded from the identical wrong place, on a fix good
    // enough to be believed. 25 + 2 x the rider's own ground, as designed.
    const matches = run(withSeedAccuracy(9))
    expect(matches[0].provisionalSeed).toBeUndefined()
    expect(matches[0].progressAlongLeg).toBeCloseTo(0.003355, 6)
    expect(matches[0].distanceFromRoute).toBeCloseTo(38.601, 3)
    expect(heldTicks(matches)).toBe(23)
    expect(matches[24].progressAlongLeg).toBeCloseTo(0.166793, 6)
  })

  it('leaves a caller that supplies no accuracy exactly as it was', () => {
    const matches = run(
      withSeedAccuracy(NaN).map((f) => ({ ...f, accuracy: NaN }))
    )
    expect(matches[0].provisionalSeed).toBeUndefined()
    expect(heldTicks(matches)).toBe(23)
  })

  it('sets nothing at all when the caller passes no gate', () => {
    const match = matchPositionToRoute(
      [recorded[0].lat, recorded[0].lon],
      legs,
      0,
      null
    ) as RouteMatchResult
    expect(match.provisionalSeed).toBeUndefined()
    expect(match.matchedAtMs).toBeUndefined()
  })
})

describe('a projection seeded from a fix we do not believe', () => {
  it('is marked provisional on the tick it is established', () => {
    const [seed] = run([recorded[0]])
    expect(seed.provisionalSeed).toBe(true)
    // Identical to the recording: the gate's own numbers are unchanged.
    expect(seed.progressAlongLeg).toBeCloseTo(0.003355, 6)
    expect(seed.distanceFromRoute).toBeCloseTo(38.601, 3)
  })

  it('re-seeds on the FIRST trusted fix instead of after 23 ticks', () => {
    const matches = run(recorded)
    expect(heldTicks(matches)).toBe(0)
    // Straight onto the rider's real position: 13.5% of the 3,614 m leg, 59.7 m
    // off the polyline — the parallel path the recording did not reach until
    // 20:54:01 — and no longer provisional.
    expect(matches[1].progressAlongLeg).toBeCloseTo(0.135087, 6)
    expect(matches[1].distanceFromRoute).toBeCloseTo(59.712, 3)
    expect(matches[1].provisionalSeed).toBeUndefined()
    // ...and it tracks from there rather than jumping again.
    expect(matches[2].progressAlongLeg).toBeGreaterThan(
      matches[1].progressAlongLeg
    )
  })

  it('does not re-seed from another untrusted fix — the gate still holds', () => {
    // The flag is not a free pass. While every fix stays untrusted the ordinary
    // budget governs, and it takes the recorded 23 ticks exactly as before —
    // the release arithmetic never consulted accuracy and still does not.
    const matches = run(
      recorded.map((f) => ({
        ...f,
        accuracy: MATCH_FIX_ACCURACY_TRUSTED_M + 1
      }))
    )
    expect(heldTicks(matches)).toBe(23)
    // Still provisional when it finally releases, because nothing better ever
    // arrived — an honest statement about a projection nobody can vouch for.
    expect(matches[24].provisionalSeed).toBe(true)
  })

  it('is a seeding concept only — a later bad fix cannot re-arm it', () => {
    // Once re-seeded the projection is an ordinary one, and a coarse fix in the
    // middle of a leg neither marks it provisional again nor buys another
    // ungated tick. The flag is set only where `previousMatch == null`.
    const withBadFix = recorded.map((f, i) =>
      i === 5 ? { ...f, accuracy: 300 } : f
    )
    const matches = run(withBadFix)
    expect(heldTicks(matches)).toBe(0)
    expect(matches.slice(1).some((m) => m.provisionalSeed)).toBe(false)
  })
})
