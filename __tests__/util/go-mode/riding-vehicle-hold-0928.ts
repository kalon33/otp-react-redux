import { existsSync } from 'fs'
import path from 'path'

import {
  hasUsablePosition,
  matchUserToVehicle
} from '../../../lib/util/go-mode/vehicle-matching'
import {
  shouldRebindRidingTrip,
  shouldReplanBoardedEarlier
} from '../../../lib/util/go-mode/transit-trust'
import type {
  VehicleMatchResult,
  VehiclePosition
} from '../../../lib/util/go-mode/vehicle-matching'

/**
 * 35.1 + 12.11 — while the rider is riding a known bus, that bus keeps the
 * match unless it is truly gone.
 *
 * 2026-09-28 16:51 ride (session muls77mv-9u3dsl, dev 2026.0926.3): aboard
 * Orange Line bus 8220 on trip 1:1273254 from 17:06:28 to 17:25:12 CDT.
 *
 *  - 35.1, 17:22:48: 8220's frames were stamped at 25 m/s heading 155°, the
 *    rider braked into 98th St, and the age projection carried 8220 ~460 m
 *    PAST the rider. The stopped 8151 (1:1273216) at the station sat at
 *    ~304 m, won Phase 5's 150 m margin, and nine one-second ticks against a
 *    single 8151 frame satisfied RIDING_REBIND_MIN_CONSECUTIVE: SET_RIDING to
 *    1:8151 at 17:22:56 and a boarded-earlier re-plan at 17:22:57.
 *  - 12.11 (fifth sighting): the match fell to `none` at 17:13:04, 17:16:29,
 *    17:16:59 and 17:17:45. Three of those follow a `heading: null, speed: 0`
 *    frame, which ageCorrectVehicle cannot project, so the gate fell back to
 *    `speedAdjustedRadius(80, riderSpeed)`; the fourth follows a 272° frame of
 *    a bus that had since turned south onto Knox.
 *
 * Both fixtures are large recordings kept out of git (as vehicle-age-0915.ts
 * does), so each replay runs when its fixture is present and skips otherwise.
 */

const FIXTURES = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)

interface Tick {
  confidence: string
  tMs: number
  vehicleId: string | null
}

interface ReplayResult {
  boardedEarlier: number[]
  drops: number[]
  rebinds: Array<{ tMs: number; vehicleId: string | null }>
  share: number
  ticks: Tick[]
  wrongVehicle: number
}

/**
 * Drive the recorded GPS track through the real matcher the way
 * performVehicleMatching does — previous match threaded, the same run
 * counters, the riding vehicle passed in — and apply the riding rebind gate
 * and the boarded-earlier trigger to every tick. The riding fact starts on the
 * rider's actual bus (SET_RIDING at the start of the leg, as recorded) and
 * moves only when shouldRebindRidingTrip lets it.
 */
function replay({
  endMs,
  file,
  headsign,
  holdRiding,
  plannedTripId,
  riddenTripId,
  riddenVehicleId,
  routeId,
  startMs
}: {
  endMs: number
  file: string
  headsign: string
  /** Pass the riding vehicle to the matcher (the fix) or not (as before). */
  holdRiding: boolean
  plannedTripId: string
  riddenTripId: string
  riddenVehicleId: string
  routeId: string
  startMs: number
}): ReplayResult {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fx = require(path.join(FIXTURES, file))
  const snaps = (fx.vehicleSnapshots || [])
    .filter((s: any) => s.routeId === routeId)
    .sort((a: any, b: any) => a.tMs - b.tMs)
  const vehiclesAt = (now: number): VehiclePosition[] => {
    let best: any = null
    for (const s of snaps)
      if (s.tMs <= now && (!best || s.tMs > best.tMs)) best = s
    return ((best || snaps[0])?.payload?.vehicles || []).filter(
      hasUsablePosition
    )
  }
  const track = [...fx.gpsTrack]
    .sort((a: any, b: any) => a.tMs - b.tMs)
    .filter((f: any) => f.tMs >= startMs && f.tMs <= endMs)

  const ridingLeg: any = {
    headsign,
    startTime: startMs,
    trip: { gtfsId: plannedTripId },
    tripId: plannedTripId
  }
  let riding = { headsign, tripId: riddenTripId, vehicleId: riddenVehicleId }
  let previous: VehicleMatchResult | null = null
  let consecutiveMatches = 0
  let consecutiveFrames = 0
  let wasLocked = true
  const out: ReplayResult = {
    boardedEarlier: [],
    drops: [],
    rebinds: [],
    share: 0,
    ticks: [],
    wrongVehicle: 0
  }

  for (const fix of track) {
    const vehicles = vehiclesAt(fix.tMs)
    if (!vehicles.length) continue
    const match = matchUserToVehicle(
      fix.lat,
      fix.lon,
      fix.heading,
      vehicles,
      routeId,
      previous,
      80,
      fix.speed,
      vehicles.find((v) => v.tripId === plannedTripId)?.directionId ?? null,
      holdRiding
        ? { nowMs: fix.tMs, ridingVehicleId: riding.vehicleId }
        : { nowMs: fix.tMs }
    )
    // performVehicleMatching's run counters, verbatim in shape.
    if (match.vehicleId && match.vehicleId === previous?.vehicleId) {
      consecutiveMatches++
      if (match.frameKey !== previous?.frameKey) consecutiveFrames++
      if (consecutiveMatches >= 2 && match.confidence === 'medium') {
        match.confidence = 'high'
      }
    } else {
      consecutiveMatches = match.vehicleId ? 1 : 0
      consecutiveFrames = match.vehicleId ? 1 : 0
    }
    previous = match
    const state = { consecutiveFrames, consecutiveMatches, match }

    // The riding fact follows a trusted match only through the rebind gate.
    if (
      match.tripId &&
      match.tripId !== riding.tripId &&
      (match.confidence === 'high' || match.confidence === 'confirmed') &&
      shouldRebindRidingTrip(riding, match.tripId, ridingLeg, state)
    ) {
      riding = { ...riding, tripId: match.tripId, vehicleId: match.vehicleId! }
      out.rebinds.push({ tMs: fix.tMs, vehicleId: match.vehicleId })
    }
    const record = vehicles.find((v) => v.vehicleId === match.vehicleId)
    if (
      shouldReplanBoardedEarlier({
        liveBoardEpochMs: null,
        nowMs: fix.tMs,
        plannedTripIds: [null, plannedTripId, null],
        ridingLeg,
        ridingTripId: riding.tripId,
        vehicleMatchState: state,
        vehicleRecord: record
          ? { ageSec: fix.tMs / 1000 - record.seconds, vehicle: record }
          : null
      })
    ) {
      out.boardedEarlier.push(fix.tMs)
    }

    out.ticks.push({
      confidence: match.confidence,
      tMs: fix.tMs,
      vehicleId: match.vehicleId
    })
    if (match.confidence === 'none' && wasLocked) out.drops.push(fix.tMs)
    wasLocked = match.confidence !== 'none'
    if (match.vehicleId && match.vehicleId !== riddenVehicleId) {
      out.wrongVehicle++
    }
  }
  const tracked = out.ticks.filter(
    (t) => t.confidence === 'high' || t.confidence === 'confirmed'
  ).length
  out.share = (100 * tracked) / out.ticks.length
  return out
}

/** HH:MM:SS in the rider's zone (CDT, UTC-5, on both rides). */
const cdt = (ms: number) =>
  new Date(ms - 5 * 3600 * 1000).toISOString().slice(11, 19)

const at = (hms: string, dateIso: string) =>
  Date.parse(`${dateIso}T${hms}-05:00`)

const has0928 = existsSync(path.join(FIXTURES, 'ride-0928-1651.json'))
const has0915 = existsSync(path.join(FIXTURES, 'orange-0915-0931.json'))

;(has0928 ? describe : describe.skip)(
  'the 2026-09-28 Orange Line leg, riding 8220 (35.1, 12.11)',
  () => {
    const day = '2026-09-28'
    const leg = {
      endMs: at('17:25:12', day),
      file: 'ride-0928-1651.json',
      headsign: 'ORANGE Burnsville',
      plannedTripId: '1:1273254',
      riddenTripId: '1:1273254',
      riddenVehicleId: '1:8220',
      routeId: '1:904',
      startMs: at('17:06:30', day)
    }
    // `before` is the matcher without the riding vehicle (the frame gate of
    // the rebind is in both). Measured on this fixture, 1,121 ticks:
    //   before — drops 17:13:03, 17:16:28, 17:16:58, 17:17:45 (the recording:
    //            17:13:04, 17:16:29, 17:16:59, 17:17:45); 8151 held 17:22:4x;
    //            rebind to 8151 17:23:13 + boarded-earlier on 15 ticks (with
    //            ticks alone, as shipped: 17:22:54, the recording's 17:22:56);
    //            95.3 % tracked; 52 ticks on a bus other than 8220.
    //   after  — no drops, no rebind, no boarded-earlier; 99.8 % tracked; 11
    //            ticks on 8151, all 17:24:03-17:24:13 at 98th St, where both
    //            buses stand in the station with `heading: null` frames — held
    //            off the riding fact by the frame count (two 8151 frames).
    const before = replay({ ...leg, holdRiding: false })
    const after = replay({ ...leg, holdRiding: true })

    it('reproduces the recording without the hold', () => {
      expect(before.ticks.length).toBeGreaterThan(1000)
      expect(before.drops.map(cdt)).toEqual([
        '17:13:03',
        '17:16:28',
        '17:16:58',
        '17:17:45'
      ])
      expect(before.rebinds.map((r) => r.vehicleId)).toContain('1:8151')
      expect(before.boardedEarlier.length).toBeGreaterThan(0)
    })

    it('keeps 8220 on every tick of 17:22:20-17:23:45 (35.1)', () => {
      const win = after.ticks.filter(
        (t) => t.tMs >= at('17:22:20', day) && t.tMs <= at('17:23:45', day)
      )
      expect(win.length).toBeGreaterThan(60)
      expect(win.every((t) => t.vehicleId === '1:8220')).toBe(true)
      expect(after.rebinds).toEqual([])
      expect(after.boardedEarlier).toEqual([])
    })

    it('never drops the lock on the bus the rider is riding (12.11)', () => {
      expect(after.drops).toEqual([])
      expect(after.share).toBeGreaterThan(99)
      expect(after.wrongVehicle).toBeLessThan(before.wrongVehicle)
    })
  }
)
;(has0915 ? describe : describe.skip)(
  'the 2026-09-15 Orange Line leg still tracks (09-15 corridor gate bar)',
  () => {
    const day = '2026-09-15'
    const leg = {
      endMs: at('10:20:00', day),
      file: 'orange-0915-0931.json',
      headsign: 'ORANGE Downtown Minneapolis',
      plannedTripId: '1:1348203',
      riddenTripId: '1:1348203',
      riddenVehicleId: '1:8220',
      routeId: '1:904',
      startMs: at('09:52:37', day)
    }
    // Measured, 1,643 ticks: before 93.9 % tracked / 8 drops / 0 wrong-vehicle
    // (the 09-15 fix's own numbers); after 99.7 % / 1 drop (10:14:21) / 0.
    const before = replay({ ...leg, holdRiding: false })
    const after = replay({ ...leg, holdRiding: true })

    it('stays at or above 93.9 % tracked with no wrong-vehicle tick', () => {
      expect(before.share).toBeCloseTo(93.9, 1)
      expect(after.share).toBeGreaterThanOrEqual(before.share)
      expect(after.drops.length).toBeLessThanOrEqual(before.drops.length)
      expect(after.wrongVehicle).toBe(0)
      expect(after.rebinds).toEqual([])
    })
  }
)
