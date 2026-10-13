import { calculateDistance } from './position-matching'
import type { RidingState } from './types'
import type { VehicleMatchResult } from './vehicle-matching'

/**
 * ─── Is the rider still WITH the bus they are riding? (backlog 47.1) ────────
 *
 * 2026-10-12 16:17, session `mv5q7id5-who0wz`: the rider confirmed Orange Line
 * bus 8143 at 16:17:26 and rode it to Lake St. From 16:22:58 to 16:32:02 the
 * bus ran a road detour ~750 m east of the leg's shape. The riding fact's
 * off-route clock only ever asks the SHAPE, so it stamped `offRouteSince` at
 * 16:23:00 and dropped the fact 90 s later (`CLEAR_RIDING` 16:24:31), while
 * the confirmed match said "8143, 2 m" — the vehicle evidence said "on the
 * bus", and the shape clock overruled it.
 *
 * The vehicle's own distance to the rider (`match.distanceMeters`) cannot
 * answer the question: it is the rider NOW against a feed frame that is 21-68 s
 * old on every poll on this feed (median ~33 s), so it swings with speed — 386 m
 * at 16:26:25 and 1,398 m at 16:40:15, both with the rider aboard. What does
 * answer it is the distance TIME-ALIGNED: each frame of the bus against where
 * the rider was at that frame's own timestamp. On the 10-12 ride that was
 * ≤ 45 m on all 65 frames of the leg and ≤ 30 m through the detour.
 *
 * This module keeps the two halves of that measurement — a short ring of the
 * rider's fixes, and a verdict per feed frame — and answers one question:
 * {@link ridingHeldByVehicle}.
 */

/**
 * At or under this, a frame says the rider and the bus are together.
 *
 * Measured, time-aligned, over every frame of six aboard legs (326 frames:
 * who0wz-1617-detour 8143, ride-0928-1651 8220, orange-0915-0931 8220,
 * 0921-0902-orange-lake-st 8228, orange-0921-0813 8231,
 * orange-alight-rank-0915-1534 8140): p50 9 m, p90 27 m, p95 30 m, p99 45 m,
 * max 89 m. The only two frames over 55 m (89 m, 77 m) are 09:54:54 and
 * 09:55:21 on 09-15, the bus at 0-3 m/s at the boarding platform with the
 * rider standing — the boarding itself, before any riding fact exists.
 */
export const COMPANY_TOGETHER_M = 75

/**
 * Over this, a frame says the rider and the bus are apart. No aboard frame on
 * the six legs above came within 60 m of it. Between the two bounds a frame
 * proves nothing either way and the standing verdict is kept.
 */
export const COMPANY_APART_M = 150

/** Consecutive apart frames that break company — one bad fix cannot. */
export const COMPANY_APART_FRAMES = 2

/**
 * How long the last together frame keeps speaking when no new frame arrives.
 * Bus 8143 vanished from the feed 16:28:32-16:32:48 mid-detour (the longest
 * frame gap on the leg was 330 s); past this the hold lapses and the shape
 * clock runs exactly as before.
 */
export const COMPANY_SILENCE_CAP_MS = 600000

/** How much of the rider's own track is kept to align frames against. */
export const RIDER_FIX_RING_MS = 120000

/**
 * The widest gap between two of the rider's fixes that may be interpolated
 * across, and the furthest a frame may sit outside the ring and still be
 * read against the nearest fix.
 */
const RIDER_FIX_MAX_GAP_MS = 30000
const RIDER_FIX_EDGE_MS = 5000

export interface RiderFix {
  lat: number
  lon: number
  tMs: number
}

/** Append a fix and drop everything older than {@link RIDER_FIX_RING_MS}. */
export function pushRiderFix(
  ring: RiderFix[] | null | undefined,
  fix: RiderFix
): RiderFix[] {
  const base = ring ?? []
  if (
    !Number.isFinite(fix.tMs) ||
    !Number.isFinite(fix.lat) ||
    !Number.isFinite(fix.lon)
  ) {
    return base
  }
  const last = base[base.length - 1]
  // A fix out of order (a re-delivered or replayed one) would break the
  // ordering riderPositionAt relies on; it adds nothing a later fix doesn't.
  if (last && fix.tMs <= last.tMs) return base
  const cutoff = fix.tMs - RIDER_FIX_RING_MS
  const kept = base.filter((f) => f.tMs >= cutoff)
  kept.push(fix)
  return kept
}

/**
 * Where the rider was at `tMs`, interpolated between the two fixes either side
 * of it. Null when the ring does not cover that moment.
 */
export function riderPositionAt(
  ring: RiderFix[] | null | undefined,
  tMs: number
): { lat: number; lon: number } | null {
  if (!ring?.length || !Number.isFinite(tMs)) return null
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (tMs <= first.tMs) {
    return first.tMs - tMs <= RIDER_FIX_EDGE_MS ? first : null
  }
  if (tMs >= last.tMs) {
    return tMs - last.tMs <= RIDER_FIX_EDGE_MS ? last : null
  }
  for (let i = 1; i < ring.length; i++) {
    const b = ring[i]
    if (b.tMs < tMs) continue
    const a = ring[i - 1]
    if (b.tMs - a.tMs > RIDER_FIX_MAX_GAP_MS) return null
    const f = (tMs - a.tMs) / (b.tMs - a.tMs)
    return {
      lat: a.lat + f * (b.lat - a.lat),
      lon: a.lon + f * (b.lon - a.lon)
    }
  }
  return null
}

export type CompanyVerdict = 'together' | 'apart' | 'unknown'

export interface VehicleCompany {
  /** Consecutive frames over {@link COMPANY_APART_M}. */
  apartFrames: number
  /** The last frame's time-aligned distance, for the record. */
  lastDistanceM: number | null
  /** The `frameSeconds` of the last frame judged. */
  lastFrameSeconds: number | null
  /** Epoch ms of the last frame that read together. */
  lastTogetherAtMs: number | null
  vehicleId: string
  verdict: CompanyVerdict
}

/**
 * Judge each NEW frame of `match`'s vehicle against the rider's own position at
 * that frame's timestamp. The matcher runs every second but the feed publishes
 * a frame every 15-20 s, so most calls see a frame already judged and return
 * `prev` untouched. A different vehicle starts a fresh record.
 */
export function trackVehicleCompany(
  prev: VehicleCompany | null | undefined,
  match: Pick<
    VehicleMatchResult,
    'frameLat' | 'frameLon' | 'frameSeconds' | 'vehicleId'
  > | null,
  ring: RiderFix[] | null | undefined
): VehicleCompany | null {
  const vehicleId = match?.vehicleId
  if (!vehicleId) return null
  const base: VehicleCompany =
    prev && prev.vehicleId === vehicleId
      ? prev
      : {
          apartFrames: 0,
          lastDistanceM: null,
          lastFrameSeconds: null,
          lastTogetherAtMs: null,
          vehicleId,
          verdict: 'unknown'
        }
  const seconds = match?.frameSeconds
  if (
    seconds == null ||
    !Number.isFinite(seconds) ||
    match?.frameLat == null ||
    match?.frameLon == null ||
    seconds === base.lastFrameSeconds
  ) {
    return base
  }
  const frameMs = seconds * 1000
  const rider = riderPositionAt(ring, frameMs)
  // The rider's fix for this moment has not arrived yet (or fell out of the
  // ring): leave the frame unjudged so a later tick can still read it.
  if (!rider) return base
  const d = calculateDistance(
    rider.lat,
    rider.lon,
    match.frameLat,
    match.frameLon
  )
  if (d <= COMPANY_TOGETHER_M) {
    return {
      ...base,
      apartFrames: 0,
      lastDistanceM: d,
      lastFrameSeconds: seconds,
      lastTogetherAtMs: frameMs,
      verdict: 'together'
    }
  }
  if (d > COMPANY_APART_M) {
    const apartFrames = base.apartFrames + 1
    return {
      ...base,
      apartFrames,
      lastDistanceM: d,
      lastFrameSeconds: seconds,
      verdict: apartFrames >= COMPANY_APART_FRAMES ? 'apart' : base.verdict
    }
  }
  // The grey band proves nothing: keep the verdict and the apart count.
  return { ...base, lastDistanceM: d, lastFrameSeconds: seconds }
}

/**
 * Is the riding fact being held by its bus — the rider verifiably still in the
 * company of the vehicle the fact names, whatever the leg's shape says?
 *
 * All of it has to hold together:
 *  - the fact names a trip and a REAL bus (a `route:` id is in no feed);
 *  - the vehicle match is `confirmed` and names that same bus;
 *  - that bus's last judged frame read together, no
 *    {@link COMPANY_APART_FRAMES} apart frames since, and it is not older than
 *    {@link COMPANY_SILENCE_CAP_MS}.
 */
export function ridingHeldByVehicle(input: {
  company: VehicleCompany | null | undefined
  match: VehicleMatchResult | null | undefined
  nowMs: number
  riding: RidingState | null | undefined
}): boolean {
  const { company, match, nowMs, riding } = input
  const vehicleId = riding?.vehicleId
  if (!riding?.tripId || !vehicleId || vehicleId.startsWith('route:')) {
    return false
  }
  if (match?.confidence !== 'confirmed' || match.vehicleId !== vehicleId) {
    return false
  }
  if (!company || company.vehicleId !== vehicleId) return false
  if (company.verdict !== 'together' || company.lastTogetherAtMs == null) {
    return false
  }
  return nowMs - company.lastTogetherAtMs <= COMPANY_SILENCE_CAP_MS
}
