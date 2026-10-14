import path from 'path'

import {
  hasUsablePosition,
  matchUserToVehicle,
  MIN_SPEED_FOR_HEADING_MPS,
  OPPOSING_HEADING_MIN_DEG,
  ridingVehicleReachable
} from '../../../lib/util/go-mode/vehicle-matching'
import type {
  VehicleMatchResult,
  VehiclePosition
} from '../../../lib/util/go-mode/vehicle-matching'

/**
 * 12.11 (seventh and eighth sightings) — the opposing-heading gate must not
 * throw out the bus the rider is riding.
 *
 * Phase 1 of matchUserToVehicle keeps the riding vehicle in range while the
 * rider is anywhere it could have reached since its frame (the 09-28 reach
 * disc). Phase 2's opposing-heading gate then ran on it anyway, comparing the
 * rider's CURRENT heading with the frame's STALE one — and on the station
 * loops into 98th St the rider turns while the frame does not:
 *
 *  - 2026-10-12 (session mv5siquz-q3raua, dev 2026.1012.2), aboard 8227:
 *    `none` at 17:18:12, 17:18:13, 17:18:14 — rider 271/269/262° against the
 *    17:17:38 frame's 130° (141/139/132° > 120).
 *  - 2026-09-30 (session muomy26h-g1zujp, dev 2026.0930.1), aboard 8230:
 *    `none` 17:26:18 (16 ticks; rider 91° vs the 17:25:47 frame's 229°) and
 *    17:27:07 (13 ticks, to the leg change; rider 212°→270° vs 91°).
 *
 * Measured with the full-leg replay of riding-vehicle-hold-0928.ts (riding
 * vehicle passed), before → after this change:
 *   orange-1655-1012  17:06:05-17:19:15, 769 ticks: 1 drop (17:18:12 ×3),
 *                     99.35 % → 0 drops, 99.87 %, 0 wrong-vehicle both.
 *   ride-0930-1648    17:13:04-17:27:19, 852 ticks: 2 drops (17:26:18 ×16,
 *                     17:27:07 ×13), 96.60 % → 0 drops, 100 %, 0 wrong.
 *   ride-0928-1651    1,121 ticks: 0 drops, 99.82 %, 11 wrong → unchanged.
 *   orange-0915-0931  1,643 ticks: 1 drop (10:14:21 ×3), 99.70 %, 0 wrong
 *                     → 0 drops, 99.94 %, 0 wrong.
 *
 * The 10-12 slice here (17:16:30-17:19:15 gpsTrack + route 1:904 vehicle
 * snapshots + the itinerary) is cut from the untracked recording so the replay
 * runs in CI; the 09-30 track and snapshots are already tracked whole in
 * ride-0930-1648-card.json (38.1), replayed here from 17:25:20.
 */

const FIXTURES = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)

interface Tick {
  confidence: string
  heading: number | null
  speed: number | null
  tMs: number
  vehicleId: string | null
}

/** Thread the matcher over a slice the way performVehicleMatching does. */
function replay(
  file: string,
  routeId: string,
  ridingVehicleId: string | null,
  window: [number, number] = [0, Infinity]
): Tick[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fx = require(path.join(FIXTURES, file))
  const snaps = [...fx.vehicleSnapshots]
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
  let previous: VehicleMatchResult | null = null
  let consecutive = 0
  const ticks: Tick[] = []
  const track = [...fx.gpsTrack]
    .filter((f: any) => f.tMs >= window[0] && f.tMs <= window[1])
    .sort((a: any, b: any) => a.tMs - b.tMs)
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
      null,
      { nowMs: fix.tMs, ridingVehicleId }
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
    ticks.push({
      confidence: match.confidence,
      heading: fix.heading,
      speed: fix.speed,
      tMs: fix.tMs,
      vehicleId: match.vehicleId
    })
  }
  return ticks
}

/** Smallest angle between two compass headings, 0-180. */
const headingDifference = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** HH:MM:SS CDT (UTC-5 on both rides). */
const cdt = (ms: number) =>
  new Date(ms - 5 * 3600 * 1000).toISOString().slice(11, 19)
const nones = (ticks: Tick[]) =>
  ticks.filter((t) => t.confidence === 'none').map((t) => cdt(t.tMs))

describe('12.11: the riding bus is exempt from the opposing-heading gate', () => {
  describe('2026-10-12, aboard 8227 into the 98th St loop', () => {
    const file = 'riding-heading-exempt-1012.json'
    const loop = (ticks: Tick[]) => nones(ticks).filter((t) => t >= '17:18')

    it('keeps 8227 on every tick of 17:16:30-17:19:15', () => {
      const ticks = replay(file, '1:904', '1:8227')
      expect(ticks.length).toBeGreaterThan(140)
      expect(nones(ticks)).toEqual([])
      expect(ticks.every((t) => t.vehicleId === '1:8227')).toBe(true)
    })

    it('the stale frame really did read as opposing at 17:18:12-14', () => {
      // The 17:17:38 frame (heading 130°, speed 9) is the one in force; the
      // rider is moving and over 120° off it, so the gate would fire.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fx = require(path.join(FIXTURES, file))
      const frame = [...fx.vehicleSnapshots]
        .filter((s: any) => cdt(s.tMs) <= '17:18:12')
        .pop()
        .payload.vehicles.find((v: VehiclePosition) => v.vehicleId === '1:8227')
      expect(frame.heading).toBe(130)
      const turning = fx.gpsTrack.filter((f: any) =>
        ['17:18:12', '17:18:13', '17:18:14'].includes(cdt(f.tMs))
      )
      expect(turning).toHaveLength(3)
      for (const f of turning) {
        expect(f.speed).toBeGreaterThan(MIN_SPEED_FOR_HEADING_MPS)
        expect(headingDifference(f.heading, frame.heading)).toBeGreaterThan(
          OPPOSING_HEADING_MIN_DEG
        )
      }
    })

    it('control: with no riding bus the gate still drops 8227 there', () => {
      // Exactly the pre-fix outcome, because before boarding (and for every
      // bus the rider is not on) the gate is unchanged. (17:17:55 is the
      // Phase 1 drop the 09-28 reach disc already fixes for the riding bus.)
      expect(loop(replay(file, '1:904', null))).toEqual([
        '17:18:12',
        '17:18:13',
        '17:18:14'
      ])
    })

    it('control: naming another bus as riding does not exempt 8227', () => {
      expect(loop(replay(file, '1:904', '1:8151'))).toEqual([
        '17:18:12',
        '17:18:13',
        '17:18:14'
      ])
    })
  })

  describe('2026-09-30, aboard 8230 into the 98th St loop', () => {
    const file = 'ride-0930-1648-card.json'
    const window: [number, number] = [
      Date.parse('2026-09-30T17:25:20-05:00'),
      Date.parse('2026-09-30T17:27:19-05:00')
    ]

    it('keeps 8230 through 17:26:18 and 17:27:07 to the leg change', () => {
      const ticks = replay(file, '1:904', '1:8230', window)
      expect(ticks.length).toBeGreaterThan(100)
      expect(nones(ticks)).toEqual([])
      expect(ticks.every((t) => t.vehicleId === '1:8230')).toBe(true)
    })

    it('control: with no riding bus both gaps come back (16 + 13 ticks)', () => {
      const lost = nones(replay(file, '1:904', null, window))
      expect(
        lost.filter((t) => t >= '17:26:18' && t < '17:26:34')
      ).toHaveLength(16)
      expect(lost.filter((t) => t >= '17:27:07')).toHaveLength(13)
    })
  })

  describe('negative controls (synthetic)', () => {
    // Rider southbound on I-35W at BRT speed (the 7/29 shape).
    const RIDER: [number, number] = [44.921, -93.269]
    const HEADING = 179.5
    const SPEED = 17.4
    const NOW = 1_700_000_010_000
    const bus = (over: Partial<VehiclePosition>): VehiclePosition => ({
      heading: 179,
      label: '8140',
      lat: RIDER[0] + 0.0005,
      lon: RIDER[1],
      nextStopId: '1:stop-46th',
      nextStopName: 'I-35W & 46th St Station',
      patternId: '1:904:0:01',
      routeId: '1:904',
      seconds: 1_700_000_000,
      speed: 15,
      stopStatus: 'IN_TRANSIT_TO',
      tripHeadsign: 'Orange Burnsville',
      tripId: '1:1173133',
      vehicleId: '1:8140',
      ...over
    })
    const opposing = bus({
      heading: 2,
      label: '8141',
      tripHeadsign: 'Orange Downtown Minneapolis',
      tripId: '1:1082792',
      vehicleId: '1:8141'
    })

    it('a non-riding opposite-heading bus is still dropped (7/29 hijack)', () => {
      const match = matchUserToVehicle(
        RIDER[0],
        RIDER[1],
        HEADING,
        [opposing],
        '1:904',
        null,
        80,
        SPEED,
        null,
        { nowMs: NOW, ridingVehicleId: '1:8140' }
      )
      expect(match.confidence).toBe('none')
      expect(match.vehicleId).toBeNull()
    })

    it('the opposing bus never displaces the riding one', () => {
      const match = matchUserToVehicle(
        RIDER[0],
        RIDER[1],
        HEADING,
        [opposing, bus({ lat: RIDER[0] + 0.002 })],
        '1:904',
        null,
        80,
        SPEED,
        null,
        { nowMs: NOW, ridingVehicleId: '1:8140' }
      )
      expect(match.vehicleId).toBe('1:8140')
    })

    it('the riding bus with a stale opposing heading is kept inside its reach', () => {
      const turned = bus({ heading: 2 })
      expect(ridingVehicleReachable(RIDER[0], RIDER[1], turned, 80, NOW)).toBe(
        true
      )
      const match = matchUserToVehicle(
        RIDER[0],
        RIDER[1],
        HEADING,
        [turned],
        '1:904',
        null,
        80,
        SPEED,
        null,
        { nowMs: NOW, ridingVehicleId: '1:8140' }
      )
      expect(match.vehicleId).toBe('1:8140')
    })

    it('the riding bus outside its reach disc is still dropped', () => {
      // 10 s frame → reach 80 + 30 × 10 = 380 m; this one is ~3.3 km away,
      // heading the other way, so neither Phase 1 test admits it.
      const gone = bus({ heading: 2, lat: RIDER[0] + 0.03 })
      expect(ridingVehicleReachable(RIDER[0], RIDER[1], gone, 80, NOW)).toBe(
        false
      )
      const match = matchUserToVehicle(
        RIDER[0],
        RIDER[1],
        HEADING,
        [gone],
        '1:904',
        null,
        80,
        SPEED,
        null,
        { nowMs: NOW, ridingVehicleId: '1:8140' }
      )
      expect(match.confidence).toBe('none')
      expect(match.vehicleId).toBeNull()
    })
  })
})
