import {
  ARRIVAL_MAX_DISTANCE_M,
  calculateTimeRemaining,
  calculateTripProgress,
  hasArrivedAtDestination,
  remainingTripDistanceM
} from '../../../lib/util/go-mode/progress-calculator'
import {
  calculateCumulativeDistances,
  calculateDistance,
  decodeLegGeometry,
  matchPositionToRoute
} from '../../../lib/util/go-mode/position-matching'
import { checkTripComplete } from '../../../lib/util/go-mode/notification-service'
import { clampNonLiveLegTimes } from '../../../lib/util/go-mode/alight-optimizer'
import fixture from '../../../lib/util/go-mode/replay/fixtures/ride-1048-orange-bike.json'
import ride1 from '../../../lib/util/go-mode/replay/fixtures/orange-bike-0823.json'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'

/**
 * 2026-09-01 ride 3 (session mtin0l9c-yieexg), 11:10:06 — the tick that told
 * the rider they had arrived 159 m and 3m32s before they got home, and the two
 * separate defects that produced it.
 *
 * The recorded sequence, from `debug-2026-09-01.jsonl`:
 *
 *   11:10:05  fix 44.81730122,-93.30808121  routeMatch segment 0,  progress 0.000
 *             distanceFromRoute 133.8 m, isOnRoute false
 *   11:10:06  fix 44.81728932,-93.30813350  routeMatch segment 40, progress 1.000
 *             distanceToDestination 159.29 m, overallProgress 100, status completed
 *             SET_ARRIVED 1788279006042
 *             UPDATE_TRACKING_INTERVAL {interval: 30000}
 *             TRIP_COMPLETE "You have arrived at your destination!"
 *
 * The rider moved 4.3 m between those two fixes. The projection moved the
 * whole 1587 m leg.
 *
 * The itinerary is the third of ride 3's three replacements, applied at
 * 11:09:32: a single 1587 m BICYCLE leg ending at Home, 44.8165459,-93.3098598.
 */

const swaps = (fixture as any).itinerarySwaps
const itinerary = swaps[swaps.length - 1].itinerary
const legs: any[] = itinerary.legs

const track: any[] = [...(fixture as any).gpsTrack].sort(
  (a, b) => a.tMs - b.tMs
)
const fixAt = (tMs: number) => {
  const fix = track.find((f) => f.tMs === tMs)
  if (!fix) throw new Error(`fixture has no GPS fix at ${tMs}`)
  return fix
}

const ARRIVAL_TICK_MS = 1788279006000
const PRIOR_TICK_MS = 1788279005000

const legDistance = (() => {
  const cumulative = calculateCumulativeDistances(decodeLegGeometry(legs[0]))
  return cumulative[cumulative.length - 1]
})()

/** The projection the store held going into the arrival tick. */
const heldMatch: RouteMatchResult = {
  distanceFromRoute: 133.83547632351247,
  isOnRoute: false,
  legIndex: 0,
  matchedAtMs: PRIOR_TICK_MS,
  nearestPoint: [44.81798, -93.30668],
  progressAlongLeg: 0,
  progressAlongSegment: 0,
  segmentIndex: 0,
  unaccountedPathM: 0
}

/**
 * Projection movement in excess of the rider's own fix-to-fix displacement,
 * summed over a track — the measure Session 1.9 used, and the only one that
 * separates a projection that tracks a moving rider from one that invents
 * motion. Driven the way handlePositionUpdate drives the matcher.
 */
function unexplainedMetres(
  legs: any[],
  startLegIndex: number,
  track: any[],
  withStep: boolean
): { metres: number; ticks: number; worst: number; worstAt: number } {
  const legDistances = legs.map((leg) => {
    const polyline = decodeLegGeometry(leg)
    if (polyline.length < 2) return 0
    const cumulative = calculateCumulativeDistances(polyline)
    return cumulative[cumulative.length - 1]
  })
  let previousMatch: RouteMatchResult | null = null
  let previousFix: any = null
  let metres = 0
  let ticks = 0
  let worst = 0
  let worstAt = 0
  for (const fix of track) {
    const step = previousFix
      ? calculateDistance(previousFix.lat, previousFix.lon, fix.lat, fix.lon)
      : null
    const match = matchPositionToRoute(
      [fix.lat, fix.lon],
      legs,
      startLegIndex,
      previousMatch,
      {
        accuracyM: fix.accuracy,
        movedSinceFixM: withStep ? step : undefined,
        nowMs: fix.tMs
      }
    )
    if (match && previousMatch && match.legIndex === previousMatch.legIndex) {
      const alongM =
        Math.abs(match.progressAlongLeg - previousMatch.progressAlongLeg) *
        legDistances[match.legIndex]
      const extra = alongM - (step || 0)
      if (extra > 1) {
        metres += extra
        ticks++
        if (extra > worst) {
          worst = extra
          worstAt = fix.tMs
        }
      }
    }
    previousMatch = match
    previousFix = fix
  }
  return {
    metres: Math.round(metres),
    ticks,
    worst: Math.round(worst),
    worstAt
  }
}

describe('util > go-mode > 2026-09-01 ride 3 arrival latch', () => {
  describe('6.11 the arrival latch has a distance cross-check', () => {
    it('refuses arrival at the recorded 159 m, whatever progress claims', () => {
      // The exact pair the ride latched on. Before the veto this was `true`
      // on the strength of `overallProgress >= 99.5` alone.
      expect(hasArrivedAtDestination(100, 159.29425813791872)).toBe(false)
      expect(hasArrivedAtDestination(99.5, 159.29425813791872)).toBe(false)
    })

    it('still arrives where the rider actually is', () => {
      // 2026-08-27's frozen 99.28% at the door, and the ordinary case.
      expect(hasArrivedAtDestination(99.28, 12)).toBe(true)
      expect(hasArrivedAtDestination(100, 12)).toBe(true)
      // A distance nobody measured cannot veto anything.
      expect(hasArrivedAtDestination(100, null)).toBe(true)
      expect(hasArrivedAtDestination(100, undefined)).toBe(true)
      // The veto sits above the positive radius, so the distance branch is
      // still reachable.
      expect(ARRIVAL_MAX_DISTANCE_M).toBeGreaterThan(75)
      // Every real arrival in the recorded telemetry still latches:
      // 2026-08-31 16:22:05 (70 m, 95.5%), 18:52:55 (41 m, 99.7%) and
      // 2026-09-01 08:59:37 (81 m, 99.51%).
      expect(
        hasArrivedAtDestination(95.47520431072041, 69.95598543807816)
      ).toBe(true)
      expect(hasArrivedAtDestination(99.7163907051284, 41.31963453162068)).toBe(
        true
      )
      expect(
        hasArrivedAtDestination(99.51038526814618, 81.39010289820457)
      ).toBe(true)
    })

    it('does not report the trip complete on the arrival tick', () => {
      const fix = fixAt(ARRIVAL_TICK_MS)
      // The projection as it was recorded — progress snapped to 1.000. Even
      // handed that, the latch must not fire: the rider is 159 m from home.
      const snapped: RouteMatchResult = {
        ...heldMatch,
        distanceFromRoute: 132.46250984061254,
        nearestPoint: [44.81686, -93.3097],
        progressAlongLeg: 1,
        progressAlongSegment: 1,
        segmentIndex: 40
      }
      const progress = calculateTripProgress(
        new Date(ARRIVAL_TICK_MS),
        itinerary,
        snapped,
        null,
        undefined,
        fix.speed,
        null,
        null,
        [fix.lat, fix.lon]
      )

      expect(progress.overallProgress).toBeGreaterThanOrEqual(99.5)
      expect(Math.round(progress.distanceToDestination as number)).toBe(159)
      expect(progress.status).not.toBe('completed')
      // The one push the rider actually saw.
      expect(checkTripComplete(progress, [])).toBeNull()
    })

    it('completes once the rider is home', () => {
      // 11:13:38, the first fix inside 33 m of 44.8165459,-93.3098598 — three
      // and a half minutes after the ride said so. (The fixes between are 30 s
      // apart: UPDATE_TRACKING_INTERVAL had already tapered the stream.)
      const home = legs[0].to
      const arrived = track
        .filter((f) => f.tMs > ARRIVAL_TICK_MS)
        .find((f) => calculateDistance(f.lat, f.lon, home.lat, home.lon) <= 33)
      expect(arrived).toBeDefined()
      const progress = calculateTripProgress(
        new Date(arrived.tMs),
        itinerary,
        { ...heldMatch, progressAlongLeg: 1 },
        null,
        undefined,
        arrived.speed,
        null,
        null,
        [arrived.lat, arrived.lon]
      )
      expect(progress.status).toBe('completed')
      expect(checkTripComplete(progress, [])).not.toBeNull()
    })
  })

  describe('6.5 the projection may not outrun the rider', () => {
    it('is the recorded 4.3 m step against a 1587 m leg', () => {
      const prev = fixAt(PRIOR_TICK_MS)
      const now = fixAt(ARRIVAL_TICK_MS)
      const step = calculateDistance(prev.lat, prev.lon, now.lat, now.lon)
      expect(step).toBeLessThan(5)
      expect(Math.round(legDistance)).toBeGreaterThan(1500)
    })

    it('holds the arrival tick verbatim and accumulates the evidence', () => {
      const prev = fixAt(PRIOR_TICK_MS)
      const now = fixAt(ARRIVAL_TICK_MS)
      const step = calculateDistance(prev.lat, prev.lon, now.lat, now.lon)

      const gated = matchPositionToRoute(
        [now.lat, now.lon],
        legs,
        0,
        heldMatch,
        {
          accuracyM: now.accuracy,
          movedSinceFixM: step,
          nowMs: now.tMs
        }
      )
      expect(gated?.progressAlongLeg).toBe(0)
      expect(gated?.segmentIndex).toBe(0)
      // Held verbatim, stamp included — only the evidence accumulates.
      expect(gated?.matchedAtMs).toBe(PRIOR_TICK_MS)
      expect(gated?.unaccountedPathM).toBeCloseTo(step, 6)

      // With no stamp to measure from there is no budget at all, and the
      // whole leg goes through in one tick. That is the ride as it happened:
      // the phone's bundle on 2026-09-01 emitted no `matchedAtMs` on any of
      // the day's route matches.
      const ungated = matchPositionToRoute(
        [now.lat, now.lon],
        legs,
        0,
        { ...heldMatch, matchedAtMs: undefined },
        { accuracyM: now.accuracy, movedSinceFixM: step, nowMs: now.tMs }
      )
      expect(ungated?.segmentIndex).toBe(40)
      expect(ungated?.progressAlongLeg).toBe(1)
    })

    it("the mode ceiling only defers the snap; the rider's own step removes it", () => {
      // Session 1.4 warned in the abstract that a rate limiter defers a jump
      // rather than removing it; replayed against ride 3's own track that is
      // exactly what the mode ceiling does. It refuses the 1587 m snap on the
      // tick it arrives — and then, because a hold preserves `matchedAtMs`
      // while the clock keeps running, 15 m/s x 122 s grows past the whole leg
      // and it admits 1545 m of it at 11:12:07, on a 16 m fix. The ground the
      // rider has covered never grows that way, because the rider was never on
      // that polyline.
      const window = track.filter((f) => f.tMs >= 1788278972000)
      expect(window.length).toBeGreaterThan(30)

      const ceilingOnly = unexplainedMetres(legs, 0, window, false)
      const withStep = unexplainedMetres(legs, 0, window, true)

      expect(ceilingOnly.metres).toBeGreaterThan(1500)
      expect(ceilingOnly.worst).toBeGreaterThan(1500)
      // 11:12:07 — 122 s after the hold began, on a 16 m fix.
      expect(ceilingOnly.worstAt).toBe(1788279127000)
      expect(withStep.metres).toBe(0)
      expect(withStep.ticks).toBe(0)
    })

    it('releases the hold once the rider has covered the ground', () => {
      const now = fixAt(ARRIVAL_TICK_MS)
      // Same tick, but with the rider having already ridden most of the leg
      // while the projection was held. Corroboration, not a single fix.
      const released = matchPositionToRoute(
        [now.lat, now.lon],
        legs,
        0,
        { ...heldMatch, unaccountedPathM: legDistance },
        {
          accuracyM: now.accuracy,
          movedSinceFixM: 4,
          // Elapsed has to allow it too — the two budgets are an AND.
          nowMs: PRIOR_TICK_MS + 200 * 1000
        }
      )
      expect(released?.progressAlongLeg).toBe(1)
    })

    it('does not make ride 1 worse', () => {
      // The other 6.5 sighting (08:56:20, a 6.9 m fix advancing the projection
      // ~75 m of the 1450 m closing bike leg at a corner that doubles back) is
      // already refused by the mode ceiling, so this ride is the regression
      // guard rather than the fix: the step budget must not trade ride 3's
      // 1587 m for invented metres somewhere else.
      const r1legs: any[] = (ride1 as any).itinerary.legs
      const r1track: any[] = [...(ride1 as any).gpsTrack].sort(
        (a, b) => a.tMs - b.tMs
      )
      const ceilingOnly = unexplainedMetres(r1legs, 0, r1track, false)
      const withStep = unexplainedMetres(r1legs, 0, r1track, true)
      // Measured: 1796 m over 201 ticks (worst 270 m) becomes 1731 m over 199
      // (worst 206 m), and the ticks where the projection sits pinned while
      // the rider moves fall 151 -> 140. The tighter budget is not buying
      // ride 3 with a stalled dot somewhere else.
      expect(withStep.metres).toBeLessThan(ceilingOnly.metres)
      expect(withStep.worst).toBeLessThan(ceilingOnly.worst)
    })
  })

  describe('6.4 one source of truth for the time remaining', () => {
    it('leaves a realtime alight alone when it raises a schedule board', () => {
      // The shape the ride actually carried at 11:48:57 local: the feed's
      // alight for the ridden trip already in the past and flagged realtime,
      // the board schedule-only. The board is raised to now; the alight is
      // evidence and must not be dragged with it.
      const nowMs = 1788270557000
      const clamped = clampNonLiveLegTimes(
        {
          0: {
            alightEpoch: 1788270300000,
            alightProjected: false,
            alightRealtime: true,
            boardEpoch: 1788270300000,
            boardProjected: false,
            boardRealtime: false,
            realtime: true
          }
        },
        nowMs
      )
      expect(clamped).not.toBeNull()
      // The feed's alight survives; the board gives way to it instead, so the
      // leg still cannot read backwards.
      expect((clamped as any)[0].alightEpoch).toBe(1788270300000)
      expect((clamped as any)[0].boardEpoch).toBe(1788270300000)
    })

    it('still carries a non-live alight with the board it inverted', () => {
      const nowMs = 1788270557000
      const clamped = clampNonLiveLegTimes(
        {
          0: {
            alightEpoch: 1788270300000,
            alightRealtime: false,
            boardEpoch: 1788270290000,
            boardRealtime: false,
            realtime: false
          }
        },
        nowMs
      )
      expect((clamped as any)[0].boardEpoch).toBe(nowMs)
      expect((clamped as any)[0].alightEpoch).toBe(nowMs)
    })

    it('counts down from the ground ahead once the plan end has passed', () => {
      // Ride 1's closing bike leg: 1068 m to go at 08:52:29, on a plan whose
      // end was 08:52:01. Recorded: timeRemaining 0 and estimatedArrival = now
      // on all 487 ticks from there to 25 m out.
      const now = new Date(1788271949000)
      const pastPlan: any = {
        endTime: now.getTime() - 28000,
        legs: [{ distance: 1200, duration: 300, mode: 'BICYCLE' }],
        startTime: now.getTime() - 900000
      }
      // Callers that pass no pace keep the old clamp exactly.
      expect(calculateTimeRemaining(now, pastPlan, 0, 0.11, null)).toBe(0)
      // A stationary rider gets the mode's own pace, not a division by zero.
      const stopped = calculateTimeRemaining(now, pastPlan, 0, 0.11, null, {
        distanceRemainingM: 1068,
        mode: 'BICYCLE',
        speedMps: 0
      })
      expect(stopped).toBeGreaterThan(200)
      expect(Number.isFinite(stopped)).toBe(true)
      // And a real pace is preferred to the fallback.
      expect(
        calculateTimeRemaining(now, pastPlan, 0, 0.11, null, {
          distanceRemainingM: 1068,
          mode: 'BICYCLE',
          speedMps: 8
        })
      ).toBeCloseTo(1068 / 8, 3)
    })

    it('leaves a live arrival still ahead of the rider untouched', () => {
      const now = new Date(1788270977000)
      const plan: any = {
        endTime: now.getTime() + 600000,
        legs: [{ distance: 3000, duration: 600, mode: 'BUS' }],
        startTime: now.getTime() - 600000
      }
      expect(calculateTimeRemaining(now, plan, 0, 0.5, null)).toBeCloseTo(
        600,
        3
      )
      expect(
        calculateTimeRemaining(now, plan, 0, 0.5, now.getTime() + 120000)
      ).toBeCloseTo(120, 3)
    })

    it('measures the ground ahead across the whole remainder', () => {
      const three: any[] = [
        { distance: 100 },
        { distance: 1000 },
        { distance: 400 }
      ]
      expect(remainingTripDistanceM(three, 0, 0.5)).toBeCloseTo(1450, 6)
      expect(remainingTripDistanceM(three, 1, 0.25)).toBeCloseTo(1150, 6)
      expect(remainingTripDistanceM(three, 2, 1)).toBeCloseTo(0, 6)
      expect(remainingTripDistanceM([], 0, 0)).toBeNull()
    })

    it('gives the closing bike leg an arrival that is still ahead', () => {
      // The same leg, driven through the producer the store actually reads.
      const fix = fixAt(1788279097000)
      const progress = calculateTripProgress(
        new Date(1788279400000),
        // endTime 1788279311000 — already past by 89 s.
        itinerary,
        { ...heldMatch, progressAlongLeg: 0.4 },
        null,
        undefined,
        fix.speed,
        null,
        null,
        [fix.lat, fix.lon]
      )
      expect(progress.timeRemaining).toBeGreaterThan(0)
      expect(progress.estimatedArrival.getTime()).toBeGreaterThan(1788279400000)
    })
  })
})
