import {
  calculateCumulativeDistances,
  calculateDistance,
  decodeLegGeometry,
  matchPositionToRoute,
  projectPointOntoSegment
} from '../../../lib/util/go-mode/position-matching'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'

/**
 * PROPOSED — backlog 21.3, measured 2026-09-21, nothing shipped.
 *
 * The near-tie band is a fixed 5 m (MATCH_NEAR_TIE_M), and 5 m is a statement
 * about GPS noise on a GOOD fix. Two rides say it is the wrong quantity when
 * the fix itself is bad.
 *
 * (a) 2026-09-21, session `mub9m39o-9pmdbh`, the closing 1,477.7 m bike leg of
 *     a path that folds back on itself. The rider rode ~250 m of a loop the
 *     geometry does not follow; the projection sat on segment 6 and the fix
 *     then degraded from 17 m to 56 m accuracy and froze for nine ticks on
 *     identical coordinates. At 08:49:07 local the fix moved 8.0 m, reported
 *     59.1 m of accuracy, and the two candidates were
 *
 *         seg 13   51.14 m perpendicular   progress 0.124980
 *         seg  6   59.96 m perpendicular   progress 0.053649   <- held
 *
 *     8.8 m apart. The strict global minimum took segment 13 and the trip
 *     gained 105.4 m of progress it had not made, then snapped back to
 *     segment 7 ten seconds later.
 *
 * (b) 2026-09-20, session `mua45zwn-ik29ib`, the 1,839.2 m bike leg home. At
 *     18:11:41 UTC, on a 14.6 m fix 53 m off-route, segment 53 (49.25 m) beat
 *     segment 45 (58.65 m) and the projection moved 120.8 m, to 99.19 % of a
 *     leg the rider still had 74 m of, then pinned there for three ticks.
 *
 * What this is NOT, and the replay says so: neither window contains a single
 * hold by the continuity gate of backlog 12.17. `matchedAtMs` advances on
 * every tick of both — the gate never engages, so there is nothing for it to
 * release and nothing here that 12.17's re-seed touches. The frozen stretches
 * in (a) are a frozen FIX (step 0.0 m, identical coordinates) and the pinned
 * stretches in both are a projection sitting on a polyline VERTEX, which is
 * honestly the nearest point. This is the search's tie rule and nothing else.
 *
 * Deliberately no imported constants in the arithmetic: a build that exports
 * none computes NaN, every comparison against NaN is false, and the case would
 * pass on exactly the source it exists to fail against.
 */

const load = (name: string) =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(`../../../lib/util/go-mode/replay/fixtures/${name}.json`)

const legDistancesOf = (legs: any[]) =>
  legs.map((leg) => {
    const polyline = decodeLegGeometry(leg)
    if (polyline.length < 2) return 0
    const cumulative = calculateCumulativeDistances(polyline)
    return cumulative[cumulative.length - 1]
  })

type Tick = {
  accuracy: number
  advanceM: number
  distanceFromRoute: number
  held: boolean
  legIndex: number
  progressAlongLeg: number
  segmentIndex: number
  stepM: number
  tMs: number
}

/**
 * Replay a recorded ride from its first fix, exactly as `handlePositionUpdate`
 * drives the matcher — previous match threaded, gate armed off the fix's own
 * accuracy, clock and ground step — and return the ticks inside a window.
 *
 * Replayed from the START of the ride, not from the window: `unaccountedPathM`
 * is a running total and the leg index is carried, so a window opened cold
 * would be measuring a different matcher state than the ride had. Itinerary
 * swaps are applied at their own timestamps and clear the held match, which is
 * what `START_GO_MODE` does in the reducer.
 */
function replayWindow(
  fixtureName: string,
  fromIso: string,
  toIso: string
): Tick[] {
  const fixture = load(fixtureName)
  const track = [...fixture.gpsTrack].sort((a: any, b: any) => a.tMs - b.tMs)
  const swaps = [...(fixture.itinerarySwaps || [])].sort(
    (a: any, b: any) => a.tMs - b.tMs
  )
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)

  let legs: any[] = fixture.itinerary.legs
  let legDistances = legDistancesOf(legs)
  let swapAt = 0
  let currentLegIndex = 0
  let previous: RouteMatchResult | null = null
  let previousFix: any = null
  const window: Tick[] = []

  for (const fix of track) {
    while (swapAt < swaps.length && swaps[swapAt].tMs <= fix.tMs) {
      legs = swaps[swapAt].itinerary.legs
      legDistances = legDistancesOf(legs)
      previous = null
      currentLegIndex = 0
      swapAt++
    }
    const stepM = previousFix
      ? calculateDistance(previousFix.lat, previousFix.lon, fix.lat, fix.lon)
      : 0
    const match = matchPositionToRoute(
      [fix.lat, fix.lon],
      legs,
      currentLegIndex,
      previous,
      { accuracyM: fix.accuracy, movedSinceFixM: stepM, nowMs: fix.tMs }
    )
    if (match) {
      if (fix.tMs >= from && fix.tMs <= to) {
        const advanceM =
          previous && match.legIndex === previous.legIndex
            ? Math.abs(match.progressAlongLeg - previous.progressAlongLeg) *
              legDistances[match.legIndex]
            : 0
        window.push({
          accuracy: fix.accuracy,
          advanceM,
          distanceFromRoute: match.distanceFromRoute,
          // A hold returns the previous match verbatim, stamp included; an
          // accepted match is re-stamped with this fix's own clock.
          held: previous != null && match.matchedAtMs !== fix.tMs,
          legIndex: match.legIndex,
          progressAlongLeg: match.progressAlongLeg,
          segmentIndex: match.segmentIndex,
          stepM,
          tMs: fix.tMs
        })
      }
      if (match.legIndex > currentLegIndex) currentLegIndex = match.legIndex
      previous = match
    }
    previousFix = fix
  }
  return window
}

/** Every segment of one leg, ranked by perpendicular distance from one fix. */
function candidatesAt(fixtureName: string, tMs: number, legIndex: number) {
  const fixture = load(fixtureName)
  const swaps = [...(fixture.itinerarySwaps || [])].sort(
    (a: any, b: any) => a.tMs - b.tMs
  )
  let legs: any[] = fixture.itinerary.legs
  for (const swap of swaps) if (swap.tMs <= tMs) legs = swap.itinerary.legs
  const fix = fixture.gpsTrack.find((f: any) => f.tMs === tMs)
  if (!fix) throw new Error(`fixture has no GPS fix at ${tMs}`)
  const polyline = decodeLegGeometry(legs[legIndex])
  const cumulative = calculateCumulativeDistances(polyline)
  const total = cumulative[cumulative.length - 1]
  const rows = []
  for (let i = 0; i < polyline.length - 1; i++) {
    const projection = projectPointOntoSegment(
      [fix.lat, fix.lon],
      polyline[i],
      polyline[i + 1]
    )
    rows.push({
      perpDistance: projection.perpDistance,
      progressAlongLeg:
        (cumulative[i] +
          (cumulative[i + 1] - cumulative[i]) * projection.alongSegment) /
        total,
      segmentIndex: i
    })
  }
  rows.sort((a, b) => a.perpDistance - b.perpDistance)
  return { accuracy: fix.accuracy, legDistance: total, rows }
}

const A_FIXTURE = 'orange-0921-0813'
const A_JUMP_MS = 1789998547000 // 2026-09-21T13:49:07Z, 08:49:07 local
const A_FROM = '2026-09-21T13:48:45Z'
const A_TO = '2026-09-21T13:49:30Z'

const B_FIXTURE = 'orange-bike-0920-1253'
const B_JUMP_MS = 1789927901000 // 2026-09-20T18:11:41Z, 13:11:41 local
const B_FROM = '2026-09-20T18:11:25Z'
const B_TO = '2026-09-20T18:12:10Z'

describe('go-mode > the near-tie band is a fix-accuracy question (2026-09-21)', () => {
  // Provenance: the recordings still have to carry the defect's own input.
  it('(a) still carries the 8.8 m decision taken on a 59 m fix', () => {
    const { accuracy, legDistance, rows } = candidatesAt(
      A_FIXTURE,
      A_JUMP_MS,
      1
    )
    expect(load(A_FIXTURE).meta.session).toBe('mub9m39o-9pmdbh')
    expect(legDistance).toBeGreaterThan(1470)
    expect(legDistance).toBeLessThan(1485)
    expect(accuracy).toBeGreaterThan(59)
    expect(accuracy).toBeLessThan(60)

    const best = rows[0]
    const heldSegment = rows.find((r) => r.segmentIndex === 6)!
    expect(best.segmentIndex).toBe(13)
    expect(best.perpDistance).toBeCloseTo(51.14, 1)
    expect(heldSegment.perpDistance).toBeCloseTo(59.96, 1)
    // The whole row: a difference five times smaller than the instrument's own
    // stated error, and 105 m of progress riding on it.
    expect(heldSegment.perpDistance - best.perpDistance).toBeLessThan(9)
    expect(
      (best.progressAlongLeg - heldSegment.progressAlongLeg) * legDistance
    ).toBeGreaterThan(100)
  })

  it('(b) still carries the 9.4 m decision taken on a 14.6 m fix', () => {
    const { accuracy, legDistance, rows } = candidatesAt(
      B_FIXTURE,
      B_JUMP_MS,
      0
    )
    expect(load(B_FIXTURE).meta.session).toBe('mua45zwn-ik29ib')
    expect(legDistance).toBeGreaterThan(1830)
    expect(legDistance).toBeLessThan(1845)
    expect(accuracy).toBeGreaterThan(14)
    expect(accuracy).toBeLessThan(15)

    expect(rows[0].segmentIndex).toBe(53)
    expect(rows[0].perpDistance).toBeCloseTo(49.25, 1)
    const heldSegment = rows.find((r) => r.segmentIndex === 45)!
    expect(heldSegment.perpDistance).toBeCloseTo(58.65, 1)
    expect(heldSegment.perpDistance - rows[0].perpDistance).toBeLessThan(10)
  })

  // Ruled out, and the reason this is not another 12.17 sighting: the gate
  // never acts in either window. Unfixed, both windows contain zero holds.
  it('neither window contains a single continuity-gate hold', () => {
    expect(replayWindow(A_FIXTURE, A_FROM, A_TO).filter((t) => t.held)).toEqual(
      []
    )
    expect(replayWindow(B_FIXTURE, B_FROM, B_TO).filter((t) => t.held)).toEqual(
      []
    )
  })

  // THE DEFECT. Unfixed, the worst single-tick along-leg advance in window (a)
  // is 105.4 m on an 8.0 m step, and in window (b) 120.8 m on an 8.6 m step.
  it('(a) does not cross seven segments on one degraded fix', () => {
    const window = replayWindow(A_FIXTURE, A_FROM, A_TO)
    expect(window.length).toBeGreaterThan(40)
    const worst = window.reduce((a, b) => (b.advanceM > a.advanceM ? b : a))
    expect(worst.advanceM).toBeLessThan(50)

    // And specifically: the tick that jumped stays on the held segment.
    const jump = window.find((t) => t.tMs === A_JUMP_MS)!
    expect(jump.accuracy).toBeGreaterThan(59)
    expect(jump.stepM).toBeCloseTo(8.0, 0)
    expect(jump.segmentIndex).toBeLessThan(13)
    expect(jump.progressAlongLeg).toBeLessThan(0.07)
  })

  it('(b) does not skip to 99 % of the leg with 74 m left to ride', () => {
    const window = replayWindow(B_FIXTURE, B_FROM, B_TO)
    expect(window.length).toBeGreaterThan(15)
    const worst = window.reduce((a, b) => (b.advanceM > a.advanceM ? b : a))
    // Unfixed: 120.8 m in one tick. This is an improvement, not a cure — the
    // band buys two ticks (+36.0 m then +77.1 m) instead of one, and the row
    // should say so.
    expect(worst.advanceM).toBeLessThan(100)

    const jump = window.find((t) => t.tMs === B_JUMP_MS)!
    expect(jump.segmentIndex).toBeLessThan(52)
    expect(jump.progressAlongLeg).toBeLessThan(0.99)
  })

  // The band may only ever REORDER near-ties, so a caller with no previous
  // match — every leg's opening fix — must be the plain global minimum however
  // bad the fix is.
  it('a first match is the global minimum whatever the accuracy says', () => {
    const { rows } = candidatesAt(A_FIXTURE, A_JUMP_MS, 1)
    const fixture = load(A_FIXTURE)
    const swaps = [...fixture.itinerarySwaps].sort(
      (a: any, b: any) => a.tMs - b.tMs
    )
    const legs = swaps[swaps.length - 1].itinerary.legs
    const fix = fixture.gpsTrack.find((f: any) => f.tMs === A_JUMP_MS)
    const first = matchPositionToRoute([fix.lat, fix.lon], legs, 1, null, {
      accuracyM: fix.accuracy,
      movedSinceFixM: 8,
      nowMs: fix.tMs
    })
    expect(first!.segmentIndex).toBe(rows[0].segmentIndex)
    expect(first!.distanceFromRoute).toBeCloseTo(rows[0].perpDistance, 6)
  })
})
