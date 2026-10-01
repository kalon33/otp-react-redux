import { existsSync } from 'fs'
import path from 'path'

import {
  ageCorrectVehicle,
  hasUsablePosition,
  matchUserToVehicle,
  MAX_CORRECTABLE_FRAME_AGE_SECONDS,
  MAX_TRANSIT_SPEED_MPS,
  measureVehicle
} from '../../../lib/util/go-mode/vehicle-matching'
import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import type { VehiclePosition } from '../../../lib/util/go-mode/vehicle-matching'

/**
 * 12.11 — the matcher compared a fresh GPS fix against a vehicle position it
 * never age-corrected.
 *
 * A GTFS-RT frame says where the bus WAS, at `vehicle.seconds`. On the
 * 2026-09-15 Orange Line ride (session mu2rh9og-fw6prf) the feed ran 28-61 s
 * behind while bus 8220 did 20-24 m/s on I-35W, so the published point sat
 * 600-1,400 m behind a rider who was sitting on that bus — and the gate,
 * `speedAdjustedRadius(80, riderSpeed)`, made the RIDER's speed pay for the
 * FEED's age. That is not a constant that can be tuned: at 22 m/s it opens to
 * 1,070 m against a frame 1,340 m back, and at a station (2026-09-09) the
 * rider's speed collapses to ~0 and it slams shut to the 80 m base at exactly
 * the moment the rider is looking at the screen.
 *
 * The frame carries its own `seconds`, `speed` and `heading`, so it can
 * correct itself. Both fields were checked against this recording before being
 * trusted (see the unit cases below).
 */

// --- Unit: the projection maths ---

const frame = (over: Partial<VehiclePosition> = {}): VehiclePosition => ({
  directionId: 0,
  heading: 0, // due north, so the maths is checkable by hand
  label: '8220',
  lat: 44.9,
  lon: -93.28,
  nextStopId: '1:52719',
  nextStopName: 'I-35W & 66th St Station',
  patternId: 'UGF0dGVybjoxOjkwNDoxOjAx',
  routeId: '1:904',
  seconds: 1789484400,
  speed: 22,
  stopStatus: 'IN_TRANSIT_TO',
  tripHeadsign: 'ORANGE Downtown Minneapolis',
  tripId: '1:1348203',
  vehicleId: '1:8220',
  ...over
})

describe('ageCorrectVehicle — projecting a stale frame forward', () => {
  it('moves a 61s-old frame at 22 m/s the 1,342 m the bus covered', () => {
    const v = frame()
    const nowMs = (v.seconds + 61) * 1000
    const aged = ageCorrectVehicle(v, nowMs)

    expect(aged.ageSeconds).toBeCloseTo(61, 6)
    // 61 s x 22 m/s. This is the whole fix: on 2026-09-15 that is the gap the
    // un-aged comparison was measuring as the rider being 1.3 km from the bus
    // they were sitting on.
    expect(aged.projectedMeters).toBeCloseTo(1342, 6)

    // Heading 0 is due north, so the projection is pure latitude and the
    // distance from the original point is the projection distance.
    expect(calculateDistance(v.lat, v.lon, aged.lat, aged.lon)).toBeCloseTo(
      1342,
      0
    )
    expect(aged.lat).toBeGreaterThan(v.lat)
    expect(aged.lon).toBeCloseTo(v.lon, 9)

    // And the corridor — everywhere the bus could be — runs the same way, as
    // far as a transit vehicle could have got in 61 s.
    expect(aged.corridorMeters).toBeCloseTo(61 * MAX_TRANSIT_SPEED_MPS, 6)
    expect(
      calculateDistance(v.lat, v.lon, aged.corridorLat, aged.corridorLon)
    ).toBeCloseTo(61 * MAX_TRANSIT_SPEED_MPS, 0)
  })

  it('projects along the heading, not along north', () => {
    const aged = ageCorrectVehicle(
      frame({ heading: 90 }),
      (1789484400 + 61) * 1000
    )
    // Due east: longitude carries the movement. Latitude drifts by 0.14 m over
    // the 1,342 m — a great circle launched due east does bend, unlike a rhumb
    // line — so this is 4 decimal places, not 6.
    expect(aged.lat).toBeCloseTo(44.9, 4)
    expect(aged.lon).toBeGreaterThan(-93.28)
    expect(calculateDistance(44.9, -93.28, aged.lat, aged.lon)).toBeCloseTo(
      1342,
      0
    )
  })

  it('leaves the frame alone when it cannot be projected', () => {
    const at = (v: VehiclePosition, ageS: number) =>
      ageCorrectVehicle(v, ((v.seconds || 0) + ageS) * 1000)

    // No heading to project along — inventing one is worse than not trying.
    expect(at(frame({ heading: null as any }), 61).projectedMeters).toBe(0)
    expect(at(frame({ heading: null as any }), 61).corridorMeters).toBe(0)
    // No usable timestamp.
    expect(
      ageCorrectVehicle(frame({ seconds: 0 }), Date.now()).corridorMeters
    ).toBe(0)
    // A frame from the future (clock skew) is not projected backwards.
    expect(at(frame(), -30).projectedMeters).toBe(0)
    // Past the age ceiling a constant-heading extrapolation is fiction.
    expect(
      at(frame(), MAX_CORRECTABLE_FRAME_AGE_SECONDS + 1).corridorMeters
    ).toBe(0)
    expect(
      at(frame(), MAX_CORRECTABLE_FRAME_AGE_SECONDS - 1).corridorMeters
    ).toBeGreaterThan(0)
  })

  it('still opens a corridor for a frame stamped at a standstill', () => {
    // The 2026-09-09 shape: the poll carries a frame from while the bus was
    // still dwelling, and by now it has pulled out. Its own speed says it went
    // nowhere; the corridor says it could be a long way up the road.
    const aged = ageCorrectVehicle(
      frame({ speed: 0 }),
      (1789484400 + 40) * 1000
    )
    expect(aged.projectedMeters).toBe(0)
    expect(aged.corridorMeters).toBeCloseTo(40 * MAX_TRANSIT_SPEED_MPS, 6)
  })
})

describe('measureVehicle — the corridor is not a disc', () => {
  const v = frame() // heading 0 (north), 22 m/s
  const nowMs = (v.seconds + 61) * 1000

  it('matches a rider ahead along the corridor', () => {
    // Sitting on the bus: ~1.3 km north of where the frame put it.
    const ahead = ageCorrectVehicle(v, nowMs)
    const m = measureVehicle(ahead.lat, ahead.lon, v, 80, 0, nowMs)
    expect(m.inRange).toBe(true)
    // Rider speed is 0 here — under the old gate this was an 80 m radius
    // against a 1,342 m gap, which is the bug.
    expect(
      calculateDistance(ahead.lat, ahead.lon, v.lat, v.lon)
    ).toBeGreaterThan(1300)
  })

  it('rejects a rider the same distance away SIDEWAYS', () => {
    // Same 1,342 m, due east instead of along the corridor. A disc inflated to
    // the corridor's length would take this; the segment must not.
    const side = ageCorrectVehicle(frame({ heading: 90 }), nowMs)
    const m = measureVehicle(side.lat, side.lon, v, 80, 0, nowMs)
    expect(m.inRange).toBe(false)
  })

  it('rejects a rider the same distance BEHIND the frame', () => {
    const behind = ageCorrectVehicle(frame({ heading: 180 }), nowMs)
    const m = measureVehicle(behind.lat, behind.lon, v, 80, 0, nowMs)
    expect(m.inRange).toBe(false)
  })

  it('falls back to the rider-speed radius when the frame cannot be aged', () => {
    const unagedeable = frame({ heading: null as any })
    // 700 m away, rider doing 20 m/s: speedAdjustedRadius(80, 20) = 980 m.
    const far = ageCorrectVehicle(frame(), (v.seconds + 32) * 1000) // ~704 m north
    expect(
      measureVehicle(far.lat, far.lon, unagedeable, 80, 20, nowMs).inRange
    ).toBe(true)
    // Same geometry, stationary rider: the old 80 m base, unchanged.
    expect(
      measureVehicle(far.lat, far.lon, unagedeable, 80, 0, nowMs).inRange
    ).toBe(false)
  })
})

// --- Replay: the ride itself ---

/**
 * The fixture is a 18 MB recording and is deliberately NOT committed, so this
 * block measures the real ride when it is present and skips when it is not.
 */
const FIXTURE = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/orange-0915-0931.json'
)
const hasFixture = existsSync(FIXTURE)
const describeRide = hasFixture ? describe : describe.skip

describeRide(
  'the 2026-09-15 Orange Line leg, replayed through the matcher',
  () => {
    const ROUTE = '1:904'
    const TRIP = '1:1348203'
    // The bus leg as the ride report measured it: 09:52:37-10:20 CDT.
    const START = Date.parse('2026-09-15T14:52:37Z')
    const END = Date.parse('2026-09-15T15:20:00Z')

    /**
     * Drive the recorded GPS track through the real matcher exactly as
     * performVehicleMatching does — previous match threaded, the same
     * consecutive-match promotion, the expected direction read off the feed —
     * and report what the rider's card would have said on each tick.
     */
    const replay = () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fx = require(FIXTURE)
      const snaps = (fx.vehicleSnapshots || [])
        .filter((s: any) => s.routeId === ROUTE)
        .sort((a: any, b: any) => a.tMs - b.tMs)
      const vehiclesAt = (now: number) => {
        let best: any = null
        for (const s of snaps)
          if (s.tMs <= now && (!best || s.tMs > best.tMs)) best = s
        return ((best || snaps[0])?.payload?.vehicles || []).filter(
          hasUsablePosition
        )
      }
      const track = [...fx.gpsTrack]
        .sort((a: any, b: any) => a.tMs - b.tMs)
        .filter((f: any) => f.tMs >= START && f.tMs <= END)

      let previous: any = null
      let consecutive = 0
      let ticks = 0
      let tracked = 0
      let drops = 0
      let wrongVehicle = 0
      let wasLocked = true
      let ageSum = 0
      let ageN = 0

      for (const fix of track) {
        const vehicles = vehiclesAt(fix.tMs)
        if (!vehicles.length) continue
        const own = vehicles.find((v: any) => v.tripId === TRIP)
        const match = matchUserToVehicle(
          fix.lat,
          fix.lon,
          fix.heading,
          vehicles,
          ROUTE,
          previous,
          80,
          fix.speed,
          own?.directionId ?? null,
          { nowMs: fix.tMs }
        )
        if (match.vehicleId && match.vehicleId === previous?.vehicleId) {
          consecutive++
          if (consecutive >= 2 && match.confidence === 'medium') {
            match.confidence = 'high'
          }
        } else {
          consecutive = match.vehicleId ? 1 : 0
        }
        previous = match
        ticks++
        // TransitProgress shows "Locating your bus..." unless this holds.
        if (match.confidence === 'confirmed' || match.confidence === 'high') {
          tracked++
        }
        if (match.confidence === 'none' && wasLocked) drops++
        wasLocked = match.confidence !== 'none'
        if (match.vehicleId && match.vehicleId !== '1:8220') wrongVehicle++
        if (own) {
          ageSum += fix.tMs / 1000 - own.seconds
          ageN++
        }
      }
      return {
        drops,
        frameAge: ageSum / ageN,
        share: (100 * tracked) / ticks,
        ticks,
        wrongVehicle
      }
    }

    it('holds the lock for the ride instead of dropping it 27 times', () => {
      const r = replay()

      // The recording itself: ~1,643 ticks against a feed running ~46 s behind.
      expect(r.ticks).toBeGreaterThan(1500)
      expect(r.frameAge).toBeGreaterThan(30)

      // Measured on this fixture against the un-aged matcher: 55.8 % tracked,
      // 27 drops to `none`. Age-corrected: 93.9 % and 8. The thresholds are set
      // below those so an unrelated tuning change does not fail the case, but
      // far above the behaviour this row exists to describe.
      expect(r.share).toBeGreaterThan(90)
      expect(r.drops).toBeLessThanOrEqual(10)

      // A wider gate that matched the wrong bus would be a worse bug than the
      // one being fixed. Across the whole leg, every match is 8220.
      expect(r.wrongVehicle).toBe(0)
    })
  }
)
