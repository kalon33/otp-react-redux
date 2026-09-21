import {
  calculateDistance,
  matchPositionToRoute
} from '../../../lib/util/go-mode/position-matching'
import {
  calculateTripProgress,
  determineTripStatus,
  hasArrivedAtDestination
} from '../../../lib/util/go-mode/progress-calculator'
import { checkTripComplete } from '../../../lib/util/go-mode/notification-service'
import fixture from '../../../lib/util/go-mode/replay/fixtures/orange-0921-0854-arrival.json'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'

/**
 * 2026-09-21 ride 1 (session mub9m39o-9pmdbh), 08:54:10 — "You have arrived"
 * 83 m and 1m26s before the rider reached the door. Backlog 21.2.
 *
 * From `debug-2026-09-21.jsonl`, the closing bike leg of a 17.7 km trip
 * (16285 m BUS + 1450 m BICYCLE, the itinerary swapped in at 08:27:02):
 *
 *   08:54:08  legIndex 1  progressAlongLeg 0.93514  overall 99.470  dist 86.23 m  on_track
 *   08:54:09  legIndex 1  progressAlongLeg 0.93863  overall 99.498  dist 84.75 m  on_track
 *   08:54:10  legIndex 1  progressAlongLeg 0.94207  overall 99.526  dist 83.26 m  completed
 *             SET_ARRIVED 1789998850055
 *             UPDATE_TRACKING_INTERVAL {interval: 30000}
 *             ADD_NOTIFICATION TRIP_COMPLETE "Trip complete / Arrived"
 *   08:55:36  fix 44.94254982,-93.26389649 — 27.78 m from the last leg's `to`
 *
 * Accuracy was 2.8 m on every one of those fixes and 4.5 m on the last, so
 * this is not GPS. The scalar crossed 99.5 because it is OVERALL progress:
 * half a percent of 17.7 km is 88 m of ground, and the rider was 94.2% along
 * the leg that actually ends at their door.
 *
 * The 08:54:36 and 08:55:06 POSITION_RESPONSEs repeat the 08:54:10 coordinates
 * verbatim (a cached fix on the 30 s arrived interval), so 08:55:36 is the
 * next tick that carries new ground — which is why the walk below has four
 * ticks and not eighty-six.
 *
 * Fixture: orange-0921-0854-arrival.json, the itinerary + the last 70 s of the
 * GPS track sliced out of the recorded orange-0921-0813.json (the OTP snapshot
 * arrays are not needed here and are dropped).
 */

const swaps = (fixture as any).itinerarySwaps
const itinerary = swaps[swaps.length - 1].itinerary
const legs: any[] = itinerary.legs

/** The last fix Go Mode ever matched on this trip, and the one after it. */
const FIX_0854_09 = {
  accuracy: 2.8622901434388845,
  lat: 44.943160164439796,
  lon: -93.26461106643693,
  speed: 5.236306083727783,
  tMs: 1789998849000
}
const FIX_0854_10 = {
  accuracy: 2.81917563074998,
  lat: 44.943162304931995,
  lon: -93.26454632685551,
  speed: 5.230971101553392,
  tMs: 1789998850000
}
/**
 * 08:55:36.842 POSITION_RESPONSE — recorded after SET_ARRIVED had already
 * tapered the stream, so it is in the debug log but not in the fixture's
 * gpsTrack (the builder records UPDATE_POSITION, and the tick had quiesced).
 */
const FIX_0855_36 = {
  accuracy: 4.5143359916247165,
  lat: 44.94254981976731,
  lon: -93.26389649263132,
  speed: 0,
  tMs: 1789998936001
}

/** The projection the store held going into 08:54:09 (UPDATE_ROUTE_MATCH). */
const MATCH_0854_08: RouteMatchResult = {
  distanceFromRoute: 2.0931784509762905,
  isOnRoute: true,
  legIndex: 1,
  matchedAtMs: 1789998848000,
  nearestPoint: [44.94317372384099, -93.26467619204965],
  progressAlongLeg: 0.9351448510353823,
  progressAlongSegment: 0.6276159006977163,
  segmentIndex: 59,
  unaccountedPathM: 148.79674125797777
}

const progressFor = (fix: typeof FIX_0854_09, match: RouteMatchResult | null) =>
  calculateTripProgress(
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

/** The tick as handlePositionUpdate drives it: match, then progress. */
function walk(fixes: Array<typeof FIX_0854_09>) {
  let match: RouteMatchResult | null = MATCH_0854_08
  let previous: typeof FIX_0854_09 | null = null
  return fixes.map((fix) => {
    const step = previous
      ? calculateDistance(previous.lat, previous.lon, fix.lat, fix.lon)
      : undefined
    match = matchPositionToRoute(
      [fix.lat, fix.lon],
      legs,
      match?.legIndex ?? 0,
      match,
      { accuracyM: fix.accuracy, movedSinceFixM: step, nowMs: fix.tMs }
    )
    previous = fix
    return { fix, match, progress: progressFor(fix, match) }
  })
}

describe('util > go-mode > 2026-09-21 arrival on the final leg (21.2)', () => {
  describe('the arrival rule reads the leg that ends at the door', () => {
    it('refuses the recorded 08:54:09 and 08:54:10 pairs', () => {
      // Exactly the numbers SET_ARRIVED fired on. Overall progress alone —
      // the whole test until now — still says yes, which is the defect.
      expect(
        hasArrivedAtDestination(99.52647667374727, 83.26482398443514)
      ).toBe(true)
      expect(
        hasArrivedAtDestination(
          99.52647667374727,
          83.26482398443514,
          94.20738316780518
        )
      ).toBe(false)
      expect(
        hasArrivedAtDestination(
          99.49830824036219,
          84.75305276988541,
          93.86279836634623
        )
      ).toBe(false)
    })

    it('arrives once the rider is at the door', () => {
      // 08:55:36, 27.78 m out. Replayed through the same producer the store
      // reads, that fix is overall 99.938 / final leg 99.24 — still under the
      // progress bar, so it is the DISTANCE branch that ends this trip, which
      // is the branch that was always going to end it correctly.
      expect(hasArrivedAtDestination(99.938, 27.78, 99.24)).toBe(true)
    })

    it('leaves every earlier arrival decision alone', () => {
      // 2026-08-27: the final leg's own scalar frozen short of the bar with
      // the rider at the door. The distance branch still carries it, and it
      // is judged on overall progress on purpose.
      expect(hasArrivedAtDestination(99.28, 12, 99.28)).toBe(true)
      // 2026-09-01 11:10:06: the 159 m veto outranks any progress figure.
      expect(hasArrivedAtDestination(100, 159.29425813791872, 100)).toBe(false)
      // No leg figure (not on the last leg, or an older caller) = the rule as
      // it was.
      expect(hasArrivedAtDestination(99.5, null)).toBe(true)
      expect(hasArrivedAtDestination(99.5, null, null)).toBe(true)
      expect(determineTripStatus(null, 99, 99.5)).toBe('completed')
      // A leg that really has run out still completes on progress alone.
      expect(hasArrivedAtDestination(99.6, 80, 99.9)).toBe(true)
    })
  })

  describe('the tick the rider actually saw', () => {
    it('does not complete at 08:54:10, 83 m from the door', () => {
      const ticks = walk([FIX_0854_09, FIX_0854_10])
      const arrival = ticks[1]

      expect(arrival.match?.legIndex).toBe(1)
      expect(legs.length).toBe(2)
      expect(Math.round(arrival.progress.distanceToDestination as number)).toBe(
        83
      )
      // The scalar that fired it is still over the bar — nothing here is
      // fixed by moving the bar.
      expect(arrival.progress.overallProgress).toBeGreaterThanOrEqual(99.5)
      expect(arrival.progress.finalLegProgress).toBeLessThan(95)
      expect(arrival.progress.status).not.toBe('completed')
      expect(checkTripComplete(arrival.progress, [])).toBeNull()
      expect(ticks[0].progress.status).not.toBe('completed')

      // The counterfactual, so this test says what changed: judged on overall
      // progress, that same tick is an arrival.
      expect(
        hasArrivedAtDestination(
          arrival.progress.overallProgress,
          arrival.progress.distanceToDestination
        )
      ).toBe(true)
    })

    it('completes on the next fix that carries new ground', () => {
      const ticks = walk([FIX_0854_09, FIX_0854_10, FIX_0855_36])
      const home = legs[legs.length - 1].to
      const arrived = ticks[2]

      expect(
        Math.round(
          calculateDistance(
            FIX_0855_36.lat,
            FIX_0855_36.lon,
            home.lat,
            home.lon
          )
        )
      ).toBe(28)
      expect(arrived.progress.status).toBe('completed')
      expect(checkTripComplete(arrived.progress, [])).not.toBeNull()

      // And it is the FIRST completed tick of the four.
      const first = ticks.findIndex((t) => t.progress.status === 'completed')
      expect(first).toBe(2)
      expect(ticks[2].fix.tMs - ticks[1].fix.tMs).toBe(86001)
    })
  })
})
