import { calculateDistance } from './position-matching'
import { FIX_ACCURACY_MAX_M } from './transit-trust'

// Live follow camera (7/29 rider request: "real time view of navigation
// similar to Google Maps routing. It should follow dot as you are moving").
// Every numeric decision lives here, pure and jest-testable; the map effect
// in GoModeMap only executes what this module decides.
//
// Bearing is deliberately north-up, pitch 0 (v1): heading is null whenever the
// rider is stationary (native fix shape) and noisy at walking speed, so
// bearing-up at ~1 Hz means constant micro-rotations — label re-renders
// (battery) and disorientation. The fix's heading already arrives here, so a
// Google-style bearing-up mode later is just one more field in the decision.

// Fits inside the ~1 s fix cadence: motion reads continuous, never
// queues/teleports. Since 75.20 this is the CEILING of a per-fix ease, and
// the ease for the camera's big moves (engage, a leg-type zoom change, a
// confirmed spike) — see FOLLOW_EASE_MS_PER_PX.
export const FOLLOW_EASE_MS = 800
// What a per-fix ease actually needs (75.20): about one device pixel of
// motion per 60 Hz frame on a 3x phone — three frames, 50 ms, for every CSS
// pixel the map moves. Every frame of an ease is a full map render, and an
// 800 ms ease on each ~1 s fix kept MapLibre drawing ~85 % of the ride:
// gold-74-1105 replayed at 1x drew 162 frames in 5 s, 135 of them mid-ease,
// to move the map a median 3.6 px per fix (bus, zoom 14). Those 3.6 px now
// take 180 ms — the same per-frame step a phone can show, without the frames
// that move the picture less than a device pixel. A move of 16 px or more
// (a fast leg, a zoomed-in map) still gets the full FOLLOW_EASE_MS.
export const FOLLOW_EASE_MS_PER_PX = 50
// A move smaller than this many CSS pixels at the current zoom draws the
// same picture: the camera does not move, and the fix is not accepted, so the
// drift adds up until it is worth a frame (75.20). The rider's dot is a DOM
// marker and moves on every fix regardless.
export const FOLLOW_MIN_MOVE_PX = 1
// Standing still (75.20): the fix's own speed below this — under even a slow
// walk — means GPS wander, not travel, so the camera holds...
export const FOLLOW_STATIONARY_MPS = 0.5
// ...for wander within this radius of the last accepted fix, or within the
// fix's own accuracy if that is wider. Farther than that it is a real
// displacement whatever the speed says (a bus creeping in traffic), and the
// camera catches up.
export const FOLLOW_STATIONARY_RADIUS_M = 10
// Walk/bike: matches tap-to-zoom's existing maxZoom 16 — street names visible.
export const FOLLOW_ZOOM_ACCESS = 16
// On the bus/train: more route ahead at vehicle speed.
export const FOLLOW_ZOOM_TRANSIT = 14
// Don't animate a stationary rider (GPS jitter). Waiting at a stop — most of a
// transit trip's wall time — issues zero camera animations, so the map's
// render loop idles; this is the feature's battery lever.
export const FOLLOW_DEADBAND_M = 4
// >252 km/h implied speed = garbage jump, not travel.
export const FOLLOW_SPIKE_MPS = 70
// After a GPS gap this long (tunnel, backgrounded), spike math is meaningless
// — the re-acquisition skips the spike gate (and only that, 75.20).
export const FOLLOW_GAP_ACCEPT_MS = 30_000
// Let the initial itinerary fitBounds animation land before following.
export const FOLLOW_ENGAGE_DELAY_MS = 1500

export interface FollowDecision {
  center?: [number, number]
  /** The ease to run for a move (75.20); absent when move is false. */
  durationMs?: number
  move: boolean
  reason: string
  zoom?: number
}

/**
 * Metres one CSS pixel spans at this latitude and zoom on a MapLibre map
 * (512 px world at zoom 0).
 */
export function metresPerPixel(lat: number, zoom: number): number {
  return (
    (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * Math.pow(2, zoom))
  )
}

/**
 * The per-fix ease for a move of `px` CSS pixels (75.20): FOLLOW_EASE_MS_PER_PX
 * per pixel, at most FOLLOW_EASE_MS. Unknown size → the full ease.
 */
export function followEaseMs(px: number | null): number {
  if (px == null || !Number.isFinite(px)) return FOLLOW_EASE_MS
  return Math.min(FOLLOW_EASE_MS, Math.round(px * FOLLOW_EASE_MS_PER_PX))
}

/** CSS pixels a pan of `distanceM` moves the map; null when the zoom is unknown. */
function panPixels(
  distanceM: number,
  lat: number,
  zoom: number | null | undefined
): number | null {
  if (zoom == null || !Number.isFinite(zoom)) return null
  return distanceM / metresPerPixel(lat, zoom)
}

/**
 * The fix's own speed says the rider is standing — known (a browser poll has
 * none, iOS sends -1 for invalid) and under FOLLOW_STATIONARY_MPS — and it
 * has only wandered: within FOLLOW_STATIONARY_RADIUS_M, or its own accuracy.
 */
function isStandingWander(
  fix: { accuracyM: number | null; speedMps?: number | null },
  distanceM: number
): boolean {
  const speed = fix.speedMps
  if (speed == null || !Number.isFinite(speed) || speed < 0) return false
  return (
    speed < FOLLOW_STATIONARY_MPS &&
    distanceM <= Math.max(FOLLOW_STATIONARY_RADIUS_M, fix.accuracyM ?? 0)
  )
}

/** Transit legs get the wider zoom; walk/bike (and unknown) the closer one. */
export function isTransitLegMode(mode: string | null): boolean {
  return mode != null && mode !== 'WALK' && mode !== 'BICYCLE'
}

/**
 * Decide whether (and where) the follow camera moves for a new GPS fix.
 * Stateless: the caller keeps prevAccepted / prevRejectedSpike /
 * prevLegTransit in refs and updates them from the returned decision.
 *
 * No wall-clock staleness check on purpose: the camera only runs when a NEW
 * fix arrives, so a dead stream simply stops it — and fix timestamps are the
 * simulated clock during replay, where Date.now() math would be wrong.
 * assessRiderGpsTrust is deliberately NOT used here: it requires on-route +
 * leg-anchored, and follow must keep working precisely when the rider is
 * off-route.
 */
export function decideFollowCamera(input: {
  fix: {
    accuracyM: number | null
    lat: number
    lng: number
    /** The fix's own speed, m/s; null/negative = unknown (browser poll). */
    speedMps?: number | null
    timestampMs: number
  }
  legMode: string | null
  prevAccepted: { lat: number; lng: number; timestampMs: number } | null
  prevLegTransit: boolean | null
  prevRejectedSpike: { lat: number; lng: number } | null
  /** The map's zoom now, for the pixel tests; null = unknown (none run). */
  zoom?: number | null
}): FollowDecision {
  const {
    fix,
    legMode,
    prevAccepted,
    prevLegTransit,
    prevRejectedSpike,
    zoom
  } = input

  // Accuracy gate: the raw blue dot still renders (deliberately raw), the
  // camera just doesn't chase it — a pinned garbage dot never fights the
  // camera. Null accuracy passes, same philosophy as isFixTrustworthy.
  if (fix.accuracyM != null && fix.accuracyM > FIX_ACCURACY_MAX_M) {
    return { move: false, reason: 'accuracy' }
  }

  const legTransit = isTransitLegMode(legMode)
  const legZoom = legTransit ? FOLLOW_ZOOM_TRANSIT : FOLLOW_ZOOM_ACCESS

  // First accepted fix = engage: move and set the leg-appropriate zoom.
  if (!prevAccepted) {
    return {
      center: [fix.lng, fix.lat],
      durationMs: FOLLOW_EASE_MS,
      move: true,
      reason: 'engage',
      zoom: legZoom
    }
  }

  // Zoom is otherwise emitted only when the leg type flips access<->transit;
  // per-fix eases omit it so a rider's pinch level survives while following.
  const zoomPending = prevLegTransit != null && prevLegTransit !== legTransit
  const zoomChange = zoomPending ? { zoom: legZoom } : {}

  const dtMs = fix.timestampMs - prevAccepted.timestampMs
  // Gap acceptance: across a tunnel/backgrounded gap the implied-speed math is
  // meaningless — take the re-acquisition as truth. It skips the spike gate
  // only: `dtMs` runs from the last ACCEPTED fix, so a rider standing at a
  // stop (every fix in the dead-band) reached it every 30 s and got an 800 ms
  // ease of a fix that had not moved (75.20).
  const gap = dtMs > FOLLOW_GAP_ACCEPT_MS

  const distanceM = calculateDistance(
    prevAccepted.lat,
    prevAccepted.lng,
    fix.lat,
    fix.lng
  )

  // Spike gate with two-tick confirmation (same precedent as the deviation
  // banner smoothing that fixed the 7/29 "5246 m from route" flash): reject a
  // teleport once, but if the next fix lands near the rejected point the jump
  // was a genuine re-acquisition — accept it rather than freezing forever.
  const impliedMps = distanceM / (Math.max(dtMs, 500) / 1000)
  if (!gap && impliedMps > FOLLOW_SPIKE_MPS) {
    if (
      prevRejectedSpike &&
      calculateDistance(
        prevRejectedSpike.lat,
        prevRejectedSpike.lng,
        fix.lat,
        fix.lng
      ) <= FIX_ACCURACY_MAX_M
    ) {
      return {
        center: [fix.lng, fix.lat],
        durationMs: FOLLOW_EASE_MS,
        move: true,
        reason: 'spike-confirmed',
        ...zoomChange
      }
    }
    return { move: false, reason: 'spike-rejected' }
  }

  // Dead-band: GPS jitter around a stationary rider moves nothing.
  if (distanceM < FOLLOW_DEADBAND_M) {
    return { move: false, reason: 'deadband' }
  }

  // Standing still (75.20): wander past the dead-band with the fix's own
  // speed saying the rider is not moving is still wander. A leg-type change
  // still sets its zoom now — these two checks only hold back a pan.
  if (!zoomPending && isStandingWander(fix, distanceM)) {
    return { move: false, reason: 'stationary' }
  }

  // Too small to draw at this zoom (75.20).
  const px = panPixels(distanceM, fix.lat, zoom)
  if (!zoomPending && px != null && px < FOLLOW_MIN_MOVE_PX) {
    return { move: false, reason: 'subpixel' }
  }

  return {
    center: [fix.lng, fix.lat],
    // A zoom change animates the whole picture, not a pan: the full ease.
    durationMs: zoomPending ? FOLLOW_EASE_MS : followEaseMs(px),
    move: true,
    reason: gap ? 'gap-accept' : 'follow',
    ...zoomChange
  }
}
