import fs from 'fs'
import path from 'path'

import { assessMatchTrust } from '../../../lib/util/go-mode/geometry-trust'
import { calculateTripProgress } from '../../../lib/util/go-mode/progress-calculator'
import { matchPositionToRoute } from '../../../lib/util/go-mode/position-matching'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'

/**
 * Every recorded fixture must replay through the per-tick pure pipeline —
 * match → trust → progress — without throwing, and hold the invariants the
 * action layer relies on. This is the floor under "the NEXT ride can be
 * replay-verified": a fixture the pipeline cannot even walk is the 8/27
 * failure (two unreplayable rides) all over again, discovered only when a
 * ride goes wrong. First green run: the 2026-08-28 evening fixture, the first
 * trip recorded whole since the capture ceilings were raised.
 *
 * Deliberately not asserting ride-specific behaviour: incident suites
 * (turn-honesty-0729, turn-storm-0731, alight-backwards-0809, ...) pin those
 * against their own fixtures. This sweep only proves replayability.
 */

const FIXTURES_DIR = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)

const fixtureFiles = fs
  .readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.json'))

describe('util > go-mode > fixture replay smoke', () => {
  it('found the recorded fixtures', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0)
  })

  describe.each(fixtureFiles)('%s', (file) => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8')
    )

    it('carries a whole itinerary and a GPS track', () => {
      expect(fixture.itinerary?.legs?.length).toBeGreaterThan(0)
      expect(fixture.gpsTrack?.length).toBeGreaterThan(0)
      expect(fixture.meta?.startMs).toBeGreaterThan(0)
      // Every leg the matcher must see through decodes — a stubbed itinerary
      // (the 8/27 failure mode) dies here, not mid-ride.
      for (const leg of fixture.itinerary.legs) {
        expect(typeof leg.legGeometry?.points).toBe('string')
      }
    })

    it('replays through match → trust → progress with sane invariants', () => {
      const { legs } = fixture.itinerary
      let currentLegIndex = 0
      let prevMatch: RouteMatchResult | null = null
      const track = [...fixture.gpsTrack].sort(
        (a: any, b: any) => a.tMs - b.tMs
      )

      for (const fix of track) {
        const match = matchPositionToRoute(
          [fix.lat, fix.lon],
          legs,
          currentLegIndex,
          prevMatch
        )
        expect(match).not.toBeNull()
        if (!match) continue

        // The matcher only ever searches its forward window.
        expect(match.legIndex).toBeGreaterThanOrEqual(currentLegIndex)
        expect(match.legIndex).toBeLessThan(legs.length)
        expect(match.progressAlongLeg).toBeGreaterThanOrEqual(0)
        expect(match.progressAlongLeg).toBeLessThanOrEqual(1)
        expect(Number.isFinite(match.distanceFromRoute)).toBe(true)

        // A committed fixture's geometry is settled by construction, so the
        // provisional hold must never engage on replayed real data.
        const trust = assessMatchTrust(legs, currentLegIndex, match.legIndex)
        expect(trust.provisional).toBe(false)

        const progress = calculateTripProgress(
          new Date(fix.tMs),
          fixture.itinerary,
          match,
          null,
          undefined,
          fix.speed ?? null,
          null,
          null,
          [fix.lat, fix.lon]
        )
        expect(progress.overallProgress).toBeGreaterThanOrEqual(0)
        expect(progress.overallProgress).toBeLessThanOrEqual(100)
        expect(progress.currentLegIndex).toBe(match.legIndex)

        prevMatch = match
        currentLegIndex = match.legIndex
      }
    })
  })
})
