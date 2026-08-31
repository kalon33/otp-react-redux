import { encode } from '@mapbox/polyline'

import {
  calculateCumulativeDistances,
  decodeLegGeometry,
  MATCH_JUMP_CEILING_BICYCLE_MPS,
  MATCH_JUMP_CEILING_TRANSIT_MPS,
  MATCH_JUMP_SLACK_M,
  matchPositionToRoute
} from '../../../lib/util/go-mode/position-matching'
import fixture from '../../../lib/util/go-mode/replay/fixtures/orange-early-board-0828.json'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'

/**
 * The 2026-08-28 ride (session mtdh67f3-0z5p24), driven from its own recorded
 * GPS track.
 *
 * `matchPositionToRoute` scans for a global minimum with no memory of when a
 * candidate became the nearest one, so a projection can sit on one segment for
 * twenty seconds and then cross to another in a single tick. On this ride that
 * happened twice over: at 21:41:04Z and 21:43:10Z on the 215 m bike leg that
 * folds back on itself (165 m of "progress" per second, 16:41 local — the match
 * spikes), and repeatedly from 22:13:14Z while the rider was 110–230 m off the
 * final bike leg (266 m, then 315 m, then 179 m, each on one ~1 s step, each on
 * a fix reporting 11–22 m of accuracy). ride-watch's two `progress-without-
 * motion` findings are that invented motion: the rule was right.
 *
 * These drive the real recorded track through the real matcher. The invariant
 * asserted is the one the gate enforces — along-leg movement is bounded by the
 * time since the projection last MOVED, not since the last fix — because a
 * rate limit that holds a match for 20 s must be allowed to catch up when it
 * releases.
 */

const legs: any[] = (fixture as any).itinerary.legs

const legDistances = legs.map((leg) => {
  const polyline = decodeLegGeometry(leg)
  if (polyline.length < 2) return 0
  const cumulative = calculateCumulativeDistances(polyline)
  return cumulative[cumulative.length - 1]
})

const track = [...(fixture as any).gpsTrack].sort(
  (a: any, b: any) => a.tMs - b.tMs
)

const between = (fromIso: string, toIso: string) =>
  track.filter(
    (fix: any) => fix.tMs >= Date.parse(fromIso) && fix.tMs <= Date.parse(toIso)
  )

/**
 * Replay a stretch of the recorded track and return the worst along-leg
 * movement seen, expressed against the budget the gate allows for it.
 */
const worstStep = (fixes: any[], startLegIndex: number) => {
  let currentLegIndex = startLegIndex
  let previous: RouteMatchResult | null = null
  let movedSinceMs = 0
  let worst = { budgetM: 0, movedM: 0, tMs: 0 }

  for (const fix of fixes) {
    const match = matchPositionToRoute(
      [fix.lat, fix.lon],
      legs,
      currentLegIndex,
      previous,
      { accuracyM: fix.accuracy, nowMs: fix.tMs }
    )
    if (!match) continue

    if (previous && match.legIndex === previous.legIndex) {
      const movedM =
        Math.abs(match.progressAlongLeg - previous.progressAlongLeg) *
        legDistances[match.legIndex]
      const ceilingMps =
        legs[match.legIndex].mode === 'BICYCLE'
          ? MATCH_JUMP_CEILING_BICYCLE_MPS
          : MATCH_JUMP_CEILING_TRANSIT_MPS
      const allowed =
        MATCH_JUMP_SLACK_M + ceilingMps * ((fix.tMs - movedSinceMs) / 1000)
      // A build that exports no ceilings computes NaN here, and every `>`
      // against NaN is false — which would let these cases pass on exactly the
      // source they exist to fail against. Zero instead: no budget, no excuse.
      const budgetM = Number.isFinite(allowed) ? allowed : 0
      if (movedM - budgetM > worst.movedM - worst.budgetM) {
        worst = { budgetM, movedM, tMs: fix.tMs }
      }
    }

    if (
      !previous ||
      match.legIndex !== previous.legIndex ||
      match.progressAlongLeg !== previous.progressAlongLeg
    ) {
      movedSinceMs = fix.tMs
    }
    if (match.legIndex > currentLegIndex) currentLegIndex = match.legIndex
    previous = match
  }

  return worst
}

describe('go-mode > the matcher cannot teleport (2026-08-28)', () => {
  // 16:41:00–16:41:10 local. The rider has just left the house on the 215 m
  // access leg; the unfixed matcher reports 164.6 m of it covered between the
  // 21:41:03Z and 21:41:04Z fixes.
  it('does not cross the folded access leg in one second at 16:41', () => {
    const worst = worstStep(
      between('2026-08-28T21:41:00Z', '2026-08-28T21:41:10Z'),
      0
    )
    expect(worst.movedM).toBeLessThanOrEqual(worst.budgetM)
  })

  // The 22:13:14Z fix — 1 s after the one before it, accuracy 14 m — moved the
  // projection 266 m down the final bike leg while the rider was 129 m off it.
  it('does not jump 266 m on one mid-ride fix', () => {
    const worst = worstStep(
      between('2026-08-28T22:12:00Z', '2026-08-28T22:14:00Z'),
      2
    )
    expect(worst.movedM).toBeLessThanOrEqual(worst.budgetM)
  })

  // Both bike legs and the Orange Line, 3,842 fixes, one pass — each leg held
  // to its own mode's ceiling, so the BRT running I-35W is judged as a bus and
  // the two bike legs are not.
  it('holds the whole recorded ride inside the ceiling', () => {
    const worst = worstStep(track, 0)
    expect(worst.movedM).toBeLessThanOrEqual(worst.budgetM)
  })

  // The gate may only ever slow the projection down, never lose the trip: the
  // rider still ends the ride where the unfixed matcher put them.
  it('still finishes the ride where the ungated matcher does', () => {
    const replay = (gated: boolean) => {
      let currentLegIndex = 0
      let previous: RouteMatchResult | null = null
      for (const fix of track) {
        const match = matchPositionToRoute(
          [fix.lat, fix.lon],
          legs,
          currentLegIndex,
          previous,
          gated ? { accuracyM: fix.accuracy, nowMs: fix.tMs } : undefined
        )
        if (!match) continue
        if (match.legIndex > currentLegIndex) currentLegIndex = match.legIndex
        previous = match
      }
      return previous!
    }
    const ungated = replay(false)
    const gated = replay(true)
    expect(gated.legIndex).toBe(ungated.legIndex)
    expect(gated.progressAlongLeg).toBeCloseTo(ungated.progressAlongLeg, 6)
  })
})

describe('go-mode > the continuity gate', () => {
  // ~2.2 km due north, one segment, so progressAlongLeg is linear in metres.
  const straight = encode([
    [44.9, -93.27],
    [44.92, -93.27]
  ])
  const straightLength = 0.02 * 111320
  const atFraction = (f: number): [number, number] => [44.9 + 0.02 * f, -93.27]

  const legOfMode = (mode: string) =>
    [{ legGeometry: { points: straight }, mode }] as any[]

  const T0 = new Date('2026-08-28T22:13:13Z').getTime()

  /** The held projection, a tenth of the way along, established at T0. */
  const heldAt = (mode: string) =>
    matchPositionToRoute(atFraction(0.1), legOfMode(mode), 0, null, {
      accuracyM: 8,
      nowMs: T0
    })!

  /** 350 m further on — 35 m/s over ten seconds, a bus on I-35W. */
  const tenSecondsOn = 0.1 + 350 / straightLength

  it('stamps the fix it was established at', () => {
    expect(heldAt('BUS').matchedAtMs).toBe(T0)
  })

  it('never rejects the first match of a trip', () => {
    const first = matchPositionToRoute(
      atFraction(0.9),
      legOfMode('WALK'),
      0,
      null,
      {
        accuracyM: 8,
        nowMs: T0
      }
    )
    expect(first).not.toBeNull()
    expect(first!.progressAlongLeg).toBeCloseTo(0.9, 3)
  })

  it('is byte-for-byte the old search when no gate is supplied', () => {
    const held = heldAt('WALK')
    const withoutStamp = { ...held }
    delete withoutStamp.matchedAtMs
    expect(matchPositionToRoute(atFraction(0.1), legOfMode('WALK'))).toEqual(
      withoutStamp
    )
    expect(
      matchPositionToRoute(atFraction(0.9), legOfMode('WALK'), 0, held)
    ).toEqual({ ...matchPositionToRoute(atFraction(0.9), legOfMode('WALK')) })
  })

  it('rejects 276 m on a one-second fix', () => {
    const held = heldAt('BUS')
    const jumped = matchPositionToRoute(
      atFraction(0.1 + 276 / straightLength),
      legOfMode('BUS'),
      0,
      held,
      { accuracyM: 8, nowMs: T0 + 1000 }
    )
    expect(jumped).toBe(held)
  })

  // The Orange Line is BRT: it runs I-35W at freeway speed, and a gate that
  // cannot tell a bus from a teleport is a gate that strands riders.
  it('lets a bus cover 35 m/s', () => {
    const held = heldAt('BUS')
    const moved = matchPositionToRoute(
      atFraction(tenSecondsOn),
      legOfMode('BUS'),
      0,
      held,
      { accuracyM: 8, nowMs: T0 + 10000 }
    )
    expect(moved!.progressAlongLeg).toBeCloseTo(tenSecondsOn, 4)
    expect(moved!.matchedAtMs).toBe(T0 + 10000)
  })

  it('does not let a walker cover 35 m/s', () => {
    const held = heldAt('WALK')
    expect(
      matchPositionToRoute(
        atFraction(tenSecondsOn),
        legOfMode('WALK'),
        0,
        held,
        {
          accuracyM: 8,
          nowMs: T0 + 10000
        }
      )
    ).toBe(held)
  })

  it('does not let a cyclist cover 35 m/s', () => {
    const held = heldAt('BICYCLE')
    expect(
      matchPositionToRoute(
        atFraction(tenSecondsOn),
        legOfMode('BICYCLE'),
        0,
        held,
        { accuracyM: 8, nowMs: T0 + 10000 }
      )
    ).toBe(held)
  })

  // A fix that cannot place the rider inside a city block is not evidence of
  // freeway travel, whatever leg it lands on.
  it('holds a low-accuracy fix to the walking ceiling', () => {
    const held = heldAt('BUS')
    expect(
      matchPositionToRoute(
        atFraction(tenSecondsOn),
        legOfMode('BUS'),
        0,
        held,
        {
          accuracyM: 150,
          nowMs: T0 + 10000
        }
      )
    ).toBe(held)
  })

  it('does not gate on a missing accuracy', () => {
    const held = heldAt('BUS')
    const moved = matchPositionToRoute(
      atFraction(tenSecondsOn),
      legOfMode('BUS'),
      0,
      held,
      { accuracyM: null, nowMs: T0 + 10000 }
    )
    expect(moved!.progressAlongLeg).toBeCloseTo(tenSecondsOn, 4)
  })

  it('accepts anything when the caller supplies no clock', () => {
    const held = heldAt('WALK')
    const moved = matchPositionToRoute(
      atFraction(0.95),
      legOfMode('WALK'),
      0,
      held,
      { accuracyM: 8 }
    )
    expect(moved!.progressAlongLeg).toBeCloseTo(0.95, 3)
    expect(moved!.matchedAtMs).toBeUndefined()
  })

  it('accepts on zero and on backwards elapsed time', () => {
    const held = heldAt('WALK')
    for (const nowMs of [T0, T0 - 60000]) {
      const moved = matchPositionToRoute(
        atFraction(0.95),
        legOfMode('WALK'),
        0,
        held,
        { accuracyM: 8, nowMs }
      )
      expect(moved!.progressAlongLeg).toBeCloseTo(0.95, 3)
    }
  })

  // A rider who really did move — a tunnel, a signal drop, a bus that covered
  // ground while the fixes were missing — must converge, not pin. The budget
  // is measured from the moment the held projection was established, so it
  // widens every tick the hold lasts and the hold cannot outlive the evidence.
  it('converges on a rider who genuinely moved', () => {
    const held = heldAt('WALK')
    const truth = atFraction(0.1 + 350 / straightLength)
    let match: RouteMatchResult = held
    let t = T0
    let ticks = 0
    while (match === held && ticks < 300) {
      t += 1000
      ticks++
      match = matchPositionToRoute(truth, legOfMode('WALK'), 0, held, {
        accuracyM: 8,
        nowMs: t
      })!
    }
    // (350 - MATCH_JUMP_SLACK_M) / 5 m/s = 60 s, and not seconds sooner.
    expect(ticks).toBeGreaterThan(50)
    expect(ticks).toBeLessThanOrEqual(61)
    expect(match.progressAlongLeg).toBeCloseTo(0.1 + 350 / straightLength, 4)
  })

  it('never returns null just because the gate rejected everything', () => {
    const held = heldAt('WALK')
    expect(
      matchPositionToRoute(atFraction(0.95), legOfMode('WALK'), 0, held, {
        accuracyM: 8,
        nowMs: T0 + 1000
      })
    ).not.toBeNull()
  })

  // An access leg and the transit leg after it share an endpoint, so a real
  // leg transition moves the projection ~0 m and must never be gated.
  it('does not gate a leg transition through a shared endpoint', () => {
    const accessLeg = {
      legGeometry: {
        points: encode([
          [44.9, -93.27],
          [44.92, -93.27]
        ])
      },
      mode: 'WALK'
    }
    const busLeg = {
      legGeometry: {
        points: encode([
          [44.92, -93.27],
          [44.99, -93.27]
        ])
      },
      mode: 'BUS'
    }
    const twoLegs = [accessLeg, busLeg] as any[]
    const atStop = matchPositionToRoute([44.92, -93.27], twoLegs, 0, null, {
      accuracyM: 8,
      nowMs: T0
    })!
    const aboard = matchPositionToRoute(
      [44.9201, -93.27],
      twoLegs,
      atStop.legIndex,
      atStop,
      { accuracyM: 8, nowMs: T0 + 1000 }
    )!
    expect(aboard.legIndex).toBe(1)
  })
})
