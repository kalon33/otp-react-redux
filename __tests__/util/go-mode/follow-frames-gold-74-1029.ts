import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import {
  decideFollowCamera,
  FOLLOW_EASE_MS,
  FOLLOW_ZOOM_TRANSIT
} from '../../../lib/util/go-mode/follow-camera'
import track from '../../test-utils/mock-data/gold-74-1105-track.json'

/**
 * Backlog 75.20, measured on the ride the perf agent replayed (P6): the
 * gold-74-1105 track — 399 fixes, one a second, METRO Gold Line, the follow
 * camera on at the transit zoom. In the browser every fix eased the map for
 * FOLLOW_EASE_MS (800 ms) inside a ~1 s cadence, so MapLibre was mid-ease in
 * 145 of 169 renders over 5 s and drew on ~every animation frame of the ride.
 *
 * This walks the same fixes through the decision GoModeMap executes, holding
 * the camera where the last accepted fix put it, and measures what the map
 * would be asked to do: how much of the ride it spends easing, whether it
 * eases while the bus stands at a stop, and how far the rider's dot ever
 * gets from the centre (the follow must still follow).
 */

type Row = [number, number, number, number | null, number | null]

/** CSS px per metre on a MapLibre map (512 px world), kept independent here. */
const metresPerPixel = (lat: number, zoom: number) =>
  (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom)

const fixes = (track.fixes as Row[]).map(
  ([dtMs, lat, lng, speedMps, accuracyM]) => ({
    accuracyM,
    lat,
    lng,
    speedMps,
    timestampMs: track.t0 + dtMs
  })
)

/** The track's own standing stretch: 70 fixes at < 0.5 m/s (a signal/stop). */
const DWELL = { from: 184, to: 253 }

function replay() {
  let prevAccepted: { lat: number; lng: number; timestampMs: number } | null =
    null
  let prevRejectedSpike: { lat: number; lng: number } | null = null
  let prevLegTransit: boolean | null = null
  const eases: { durationMs: number; index: number }[] = []
  const lagPx: number[] = []
  fixes.forEach((fix, index) => {
    const d = decideFollowCamera({
      fix,
      legMode: 'BUS',
      prevAccepted,
      prevLegTransit,
      prevRejectedSpike,
      zoom: FOLLOW_ZOOM_TRANSIT
    })
    if (d.reason === 'spike-rejected') {
      prevRejectedSpike = { lat: fix.lat, lng: fix.lng }
    }
    if (d.move) {
      // What GoModeMap does: `duration: decision.durationMs ?? FOLLOW_EASE_MS`.
      eases.push({ durationMs: d.durationMs ?? FOLLOW_EASE_MS, index })
      prevAccepted = {
        lat: fix.lat,
        lng: fix.lng,
        timestampMs: fix.timestampMs
      }
      prevRejectedSpike = null
      prevLegTransit = true
    }
    if (prevAccepted) {
      lagPx.push(
        calculateDistance(
          prevAccepted.lat,
          prevAccepted.lng,
          fix.lat,
          fix.lng
        ) / metresPerPixel(fix.lat, FOLLOW_ZOOM_TRANSIT)
      )
    }
  })
  return { eases, lagPx }
}

describe('follow camera frames on gold-74-1105 (75.20)', () => {
  const rideMs = fixes[fixes.length - 1].timestampMs - fixes[0].timestampMs
  const { eases, lagPx } = replay()

  it('is the ride the perf agent measured', () => {
    expect(fixes).toHaveLength(399)
    expect(rideMs).toBe(394999)
    // The dwell really is standing still.
    for (let i = DWELL.from; i <= DWELL.to; i++) {
      expect(fixes[i].speedMps).toBeLessThan(0.5)
    }
  })

  it('spends under a fifth of the ride easing, not three fifths', () => {
    // FAILS BEFORE: 304 eases x 800 ms = 243,200 ms of 394,999 (0.62).
    const easeMs = eases.reduce((sum, e) => sum + e.durationMs, 0)
    expect(easeMs / rideMs).toBeLessThan(0.2)
  })

  it('still moves on every fix of the moving stretches', () => {
    // Continuity: the camera keeps pace with the bus, it just eases for as
    // long as the pixels need (median ~3.6 px a fix at zoom 14 -> ~180 ms).
    const movingFixes = fixes
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => (f.speedMps ?? 0) >= 5)
    const moved = new Set(eases.map((e) => e.index))
    const followed = movingFixes.filter(({ i }) => moved.has(i)).length
    expect(followed / movingFixes.length).toBeGreaterThan(0.95)
    const durations = eases.map((e) => e.durationMs).sort((a, b) => a - b)
    expect(durations[Math.floor(durations.length / 2)]).toBeLessThan(250)
  })

  it('does not ease while the bus stands', () => {
    // FAILS BEFORE: the 30 s "gap" since the last accepted fix eased the
    // standing camera twice in the 70 s dwell.
    const inDwell = eases.filter(
      (e) => e.index >= DWELL.from && e.index <= DWELL.to
    )
    expect(inDwell).toEqual([])
  })

  it('keeps the rider within a few pixels of the centre throughout', () => {
    // ~1.1 px at worst on this ride, the same as with the 800 ms eases: the
    // stationary radius (10 m, ~3 px at zoom 14) is never reached here.
    expect(Math.max(...lagPx)).toBeLessThan(1.5)
  })
})
