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
// queues/teleports.
export const FOLLOW_EASE_MS = 800
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
// — accept the re-acquisition unconditionally.
export const FOLLOW_GAP_ACCEPT_MS = 30_000
// Let the initial itinerary fitBounds animation land before following.
export const FOLLOW_ENGAGE_DELAY_MS = 1500

export interface FollowDecision {
  center?: [number, number]
  move: boolean
  reason: string
  zoom?: number
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
    timestampMs: number
  }
  legMode: string | null
  prevAccepted: { lat: number; lng: number; timestampMs: number } | null
  prevLegTransit: boolean | null
  prevRejectedSpike: { lat: number; lng: number } | null
}): FollowDecision {
  const { fix, legMode, prevAccepted, prevLegTransit, prevRejectedSpike } =
    input

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
      move: true,
      reason: 'engage',
      zoom: legZoom
    }
  }

  // Zoom is otherwise emitted only when the leg type flips access<->transit;
  // per-fix eases omit it so a rider's pinch level survives while following.
  const zoomChange =
    prevLegTransit != null && prevLegTransit !== legTransit
      ? { zoom: legZoom }
      : {}

  const dtMs = fix.timestampMs - prevAccepted.timestampMs

  // Gap acceptance: across a tunnel/backgrounded gap the implied-speed math is
  // meaningless — take the re-acquisition as truth.
  if (dtMs > FOLLOW_GAP_ACCEPT_MS) {
    return {
      center: [fix.lng, fix.lat],
      move: true,
      reason: 'gap-accept',
      ...zoomChange
    }
  }

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
  if (impliedMps > FOLLOW_SPIKE_MPS) {
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

  return {
    center: [fix.lng, fix.lat],
    move: true,
    reason: 'follow',
    ...zoomChange
  }
}
