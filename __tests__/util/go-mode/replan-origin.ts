/* globals describe, expect, it */
import {
  acceptAutoReplan,
  AUTO_REPLAN_ORIGIN_BEHIND_MAX_M,
  originIsBehindHeading
} from '../../../lib/util/go-mode/replan-acceptance'
import {
  angleBetweenDegrees,
  bearingDegrees,
  blendReplanLatencyMs,
  moveAlongBearing,
  PROJECTION_MAX_M,
  PROJECTION_MIN_SPEED_MPS,
  projectReplanOrigin,
  REPLAN_LATENCY_MAX_MS,
  REPLAN_LATENCY_SEED_FULL_MS
} from '../../../lib/util/go-mode/replan-origin'
import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import {
  ignoredReplanBackoffMs,
  noteReplanFollowed,
  QUIET_REPLAN_IGNORED_BACKOFF_MAX_MS,
  QUIET_REPLAN_IGNORED_BACKOFF_MS,
  QUIET_REPLAN_IGNORED_WINDOW_MS,
  quietReplanAdmitted,
  quietReplanCooldownMs
} from '../../../lib/util/go-mode/deviation'

/** The 16:37:55 fix of 2026-09-21 ride 1 — the one 24.3's first swap used. */
const FIX = {
  accuracyM: 2.4,
  headingDeg: 179.81,
  lat: 44.94546112213161,
  lon: -93.27284622385396,
  speedMps: 7.105825008373522
}

const bikeItinerary = (lat: number, lon: number, endTime = 2_000_000) =>
  ({
    endTime,
    legs: [{ from: { lat, lon }, mode: 'BICYCLE', transitLeg: false }]
  } as any)

describe('util > go-mode > replan-origin > blendReplanLatencyMs', () => {
  it('ignores a sample that is not a round trip', () => {
    expect(blendReplanLatencyMs(9500, 0)).toBe(9500)
    expect(blendReplanLatencyMs(9500, -1)).toBe(9500)
    expect(blendReplanLatencyMs(9500, null)).toBe(9500)
    expect(blendReplanLatencyMs(9500, NaN)).toBe(9500)
  })

  it('halves the distance to each new observation', () => {
    // The ride's own three: 10018 / 10099 / 9845 against the 9500 seed.
    let est = REPLAN_LATENCY_SEED_FULL_MS
    est = blendReplanLatencyMs(est, 10018)
    expect(est).toBe(9759)
    est = blendReplanLatencyMs(est, 10099)
    expect(est).toBe(9929)
    est = blendReplanLatencyMs(est, 9845)
    expect(est).toBe(9887)
  })

  it('never exceeds the fetch timeout', () => {
    expect(blendReplanLatencyMs(REPLAN_LATENCY_MAX_MS, 60000)).toBe(
      REPLAN_LATENCY_MAX_MS
    )
  })
})

describe('util > go-mode > replan-origin > projectReplanOrigin', () => {
  it('advances the fix by speed x latency along its heading', () => {
    const p = projectReplanOrigin({
      ...FIX,
      latencyMs: REPLAN_LATENCY_SEED_FULL_MS,
      nowMs: 1000
    })
    expect(p.metres).toBeCloseTo(67.5, 1)
    expect(p.atMs).toBe(1000 + REPLAN_LATENCY_SEED_FULL_MS)
    // Due south, so the latitude drops and the longitude barely moves.
    expect(p.lat).toBeLessThan(FIX.lat)
    expect(Math.abs(p.lon - FIX.lon)).toBeLessThan(0.00001)
    expect(calculateDistance(FIX.lat, FIX.lon, p.lat, p.lon)).toBeCloseTo(
      67.5,
      1
    )
  })

  it('lands within 25 m of where the rider really was 10 s later', () => {
    const p = projectReplanOrigin({
      ...FIX,
      latencyMs: REPLAN_LATENCY_SEED_FULL_MS,
      nowMs: 0
    })
    // The recorded 16:38:05 fix. Unprojected, the plan began 58.2 m behind it.
    const gap = calculateDistance(p.lat, p.lon, 44.944959, -93.272637)
    expect(gap).toBeLessThan(AUTO_REPLAN_ORIGIN_BEHIND_MAX_M)
    expect(
      calculateDistance(FIX.lat, FIX.lon, 44.944959, -93.272637)
    ).toBeGreaterThan(55)
  })

  it('leaves a slow, headingless or inaccurate fix exactly where it is', () => {
    const at = (over: any) =>
      projectReplanOrigin({ ...FIX, latencyMs: 9500, nowMs: 0, ...over })
    expect(at({ speedMps: PROJECTION_MIN_SPEED_MPS - 0.01 })).toMatchObject({
      lat: FIX.lat,
      metres: 0,
      skipped: 'speed'
    })
    expect(at({ speedMps: null })).toMatchObject({
      metres: 0,
      skipped: 'speed'
    })
    expect(at({ headingDeg: null })).toMatchObject({
      metres: 0,
      skipped: 'heading'
    })
    expect(at({ accuracyM: 120 })).toMatchObject({
      metres: 0,
      skipped: 'accuracy'
    })
    expect(at({ latencyMs: 0 })).toMatchObject({
      metres: 0,
      skipped: 'latency'
    })
  })

  it('clamps a bus-speed fix rather than throwing the origin down the road', () => {
    // 2026-09-21 09:20:38 recorded speed 29.6 m/s on the Orange Line.
    const p = projectReplanOrigin({
      ...FIX,
      latencyMs: 9500,
      nowMs: 0,
      speedMps: 29.6
    })
    expect(p.metres).toBe(PROJECTION_MAX_M)
  })
})

describe('util > go-mode > replan-origin > bearings', () => {
  it('reads due south, east and back', () => {
    expect(bearingDegrees(44.9, -93.2, 44.8, -93.2)).toBeCloseTo(180, 3)
    expect(bearingDegrees(44.9, -93.2, 44.9, -93.1)).toBeCloseTo(90, 1)
    expect(angleBetweenDegrees(359, 1)).toBe(2)
    expect(angleBetweenDegrees(10, 200)).toBe(170)
  })

  it('round-trips with moveAlongBearing', () => {
    const p = moveAlongBearing(44.94, -93.27, 233, 64)
    expect(calculateDistance(44.94, -93.27, p.lat, p.lon)).toBeCloseTo(64, 2)
    expect(bearingDegrees(44.94, -93.27, p.lat, p.lon)).toBeCloseTo(233, 2)
  })
})

describe('util > go-mode > replan-acceptance > originIsBehindHeading', () => {
  const rider: [number, number] = [44.944959, -93.272637]

  it('refuses a plan that starts back down the road the rider left', () => {
    // The 16:38:05 swap as installed: 58 m away, bearing 344 vs heading 89.
    const verdict = acceptAutoReplan(
      bikeItinerary(44.94546112213161, -93.27284622385396),
      bikeItinerary(44.9, -93.2, 3_000_000),
      { headingDeg: 89.28, position: rider, speedMps: 6.37 }
    )
    expect(verdict).toEqual({
      accept: false,
      reason: 'origin-behind-heading'
    })
  })

  it('allows the same distance AHEAD of them', () => {
    // 60 m east, the way they are going.
    const ahead = moveAlongBearing(rider[0], rider[1], 89.28, 60)
    expect(
      acceptAutoReplan(
        bikeItinerary(ahead.lat, ahead.lon),
        bikeItinerary(44.9, -93.2, 3_000_000),
        { headingDeg: 89.28, position: rider, speedMps: 6.37 }
      )
    ).toEqual({ accept: true })
  })

  it('says nothing at all about a rider who is not moving', () => {
    const behind = moveAlongBearing(rider[0], rider[1], 269, 60)
    expect(
      originIsBehindHeading(
        bikeItinerary(behind.lat, behind.lon),
        rider,
        89.28,
        0.2
      )
    ).toBeNull()
    expect(
      originIsBehindHeading(bikeItinerary(behind.lat, behind.lon), rider, null)
    ).toBeNull()
    // ...nor about a plan that starts at a stop.
    expect(
      originIsBehindHeading(
        {
          legs: [
            { from: { lat: behind.lat, lon: behind.lon }, transitLeg: true }
          ]
        } as any,
        rider,
        89.28,
        6.37
      )
    ).toBeNull()
  })

  it('tolerates the honest gap a tick of cycling leaves', () => {
    const justBehind = moveAlongBearing(
      rider[0],
      rider[1],
      269,
      AUTO_REPLAN_ORIGIN_BEHIND_MAX_M - 1
    )
    expect(
      originIsBehindHeading(
        bikeItinerary(justBehind.lat, justBehind.lon),
        rider,
        89.28,
        6.37
      )
    ).toBe(false)
  })
})

describe('util > go-mode > deviation > the ignored-re-plan backoff', () => {
  it('doubles per consecutive ignored re-plan and stops at five minutes', () => {
    expect(ignoredReplanBackoffMs(0)).toBe(0)
    expect(ignoredReplanBackoffMs(undefined)).toBe(0)
    expect(ignoredReplanBackoffMs(1)).toBe(QUIET_REPLAN_IGNORED_BACKOFF_MS)
    expect(ignoredReplanBackoffMs(2)).toBe(QUIET_REPLAN_IGNORED_BACKOFF_MS * 2)
    expect(ignoredReplanBackoffMs(9)).toBe(QUIET_REPLAN_IGNORED_BACKOFF_MAX_MS)
  })

  it('counts a re-plan ignored when the rider is still off it', () => {
    const open = { appliedAtMs: 1000, ignoredStreak: 0, thresholdM: 120 }
    // 2026-09-21 16:38:16, 11 s after the swap, 190 m off the new route.
    expect(
      noteReplanFollowed({ ...open, distanceFromRoute: 190, nowMs: 12000 })
    ).toEqual({ appliedAtMs: null, ignoredStreak: 1 })
  })

  it('...and clears the streak when the rider rides it', () => {
    const open = { appliedAtMs: 1000, ignoredStreak: 2, thresholdM: 120 }
    // 2026-09-21 17:34:57: 14 s in, converged, 0 m off.
    expect(
      noteReplanFollowed({ ...open, distanceFromRoute: 3, nowMs: 15000 })
    ).toEqual({ appliedAtMs: 1000, ignoredStreak: 2 })
    expect(
      noteReplanFollowed({
        ...open,
        distanceFromRoute: 3,
        nowMs: 1000 + QUIET_REPLAN_IGNORED_WINDOW_MS + 1
      })
    ).toEqual({ appliedAtMs: null, ignoredStreak: 0 })
  })

  it('says nothing when no re-plan is open', () => {
    expect(
      noteReplanFollowed({
        appliedAtMs: null,
        distanceFromRoute: 900,
        ignoredStreak: 1,
        nowMs: 5,
        thresholdM: 120
      })
    ).toEqual({ appliedAtMs: null, ignoredStreak: 1 })
  })

  it('outranks the scaled cooldown in quietReplanAdmitted', () => {
    // The 16:38 loop's own numbers: ~1060 m of leg left admits a re-plan 36 s
    // after the last one, and did, twice.
    const base = {
      lastReplanAtMs: 0,
      recentReplanAtMs: [0],
      remainingAccessMeters: 1060,
      reRouteStatus: 'idle'
    }
    expect(quietReplanCooldownMs(1060)).toBeLessThan(36000)
    expect(quietReplanAdmitted({ ...base, nowMs: 36000 })).toBe(true)
    expect(
      quietReplanAdmitted({ ...base, ignoredStreak: 1, nowMs: 36000 })
    ).toBe(false)
    expect(
      quietReplanAdmitted({
        ...base,
        ignoredStreak: 1,
        nowMs: QUIET_REPLAN_IGNORED_BACKOFF_MS
      })
    ).toBe(true)
  })
})
