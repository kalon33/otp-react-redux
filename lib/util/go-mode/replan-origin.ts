import { FIX_ACCURACY_MAX_M } from './transit-trust'

/**
 * Where an automatic re-plan should say the rider IS, given that the answer
 * takes seconds to come back.
 *
 * A Go Mode re-plan is anchored to the GPS fix that was current when the
 * request went out, and the rider keeps riding while OTP answers. By the time
 * the itinerary is installed the anchor is old, and a plan whose first leg
 * begins behind the rider is dead on arrival: the matcher pins them to the
 * start of a polyline they have already left, `currentLegProgress` sits at 0,
 * and the next tick calls them deviated — from the route the app itself just
 * handed them.
 *
 * ## The latency is measured, not guessed
 *
 * Every `quiet-replan-*` record in the fixtures carries the exact GPS fix its
 * `fromPlace` was built from, so the gap between that fix's timestamp and the
 * moment the plan was installed IS the round trip. Measured across eight
 * recorded rides (`0921-1605-465-wrongdir`, `0921-1727-newbundle`,
 * `0921-0902-orange-lake-st`, `0921-0924-orange-onboard`,
 * `0921-1646-orange-missedbus`, `orange-arbeiter-0917-1750`,
 * `orange-0917-2053`, `orange-bike-0920-1253`):
 *
 * - **scoped** (one access mode, `ACCESS_REPLAN_NUM_ITINERARIES`):
 *   0.133 / 0.154 / 0.158 / 0.165 / 0.178 / 0.191 / 0.195 / 0.198 / 0.205 s.
 * - **full trip** (transit + bike, the whole search window):
 *   1.268 / 1.519 / 1.679 / 1.682 / 9.145 / 9.502 / 9.521 / 10.018 / 10.099 /
 *   10.286 s — bimodal, nothing in between.
 *
 * At the 6-7 m/s this rider cycles, the slow mode is 60-72 m of road. That is
 * the whole of the 2026-09-21 16:38 defect (backlog 24.3): three full-trip
 * re-plans in 61 s, origins 58 / 65 / 34 m behind the rider, every one of them
 * opening with a turn already passed.
 *
 * **The row is wrong about this number.** It reads the latency as 76 s, from
 * `REROUTE_SNAPSHOT` 16:36:49 -> `START_GO_MODE` 16:38:05. Those two events are
 * unrelated: the snapshots on that ride run at 16:36:49.309, 16:38:19.811,
 * 16:39:49.287, 16:41:19.324 — the flat 90 s `REROUTE_SNAPSHOT_INTERVAL_MS`
 * cadence — and nothing consumes them. The request behind the 16:38:05 swap is
 * the `ONBOARD_CANDIDATE_SNAPSHOT {reason: 'quiet-replan-full'}` logged 8 ms
 * earlier, whose `fromPlace` is the 16:37:55 fix to twelve decimal places.
 *
 * ## What the projection can and cannot do
 *
 * Advancing the fix along its own heading is right while the rider holds a
 * line and wrong the moment they turn, and this rider turns every ~30 s
 * through the street grid. So the projection is a better guess, never a
 * guarantee, and it is deliberately paired with a gate that judges the plan
 * against the rider's REAL position when it lands
 * (`originIsBehindHeading` in replan-acceptance). Measured on the two 09-21
 * fixtures the projection moves the origin gap at install time
 * 58.2 -> 20.0 m, 65.4 -> 83.7 m, 33.9 -> 11.5 m, 9.1 -> 30.9 m and
 * 68.2 -> 32.3 m: three improved, two made worse by a turn the heading could
 * not see, and both of those are refused by the gate rather than applied.
 */

/**
 * Seed for the full-trip re-plan's round trip, before this session has
 * measured its own.
 *
 * The slow mode of the measured distribution (9.145-10.286 s), not its mean.
 * Under-projecting leaves the origin behind the rider, which is the defect;
 * over-projecting puts it ahead on the road they are already riding, which the
 * rider simply arrives at. The two failures are not symmetric.
 */
export const REPLAN_LATENCY_SEED_FULL_MS = 9500

/** Seed for the scoped access re-plan — the whole measured range is 0.13-0.21 s. */
export const REPLAN_LATENCY_SEED_SCOPED_MS = 200

/**
 * Ceiling on any latency estimate: `GO_MODE_FETCH_TIMEOUT_MS` (api.js). A
 * request that has not answered by then is aborted, so no honest round trip
 * can exceed it and a wild sample must not be allowed to poison the estimate.
 */
export const REPLAN_LATENCY_MAX_MS = 12000

/**
 * Below this the fix's `speed` and `heading` are not worth projecting on. A
 * stopped or walking rider will still be within a few metres when the plan
 * lands, so there is nothing to correct, and GPS heading at low speed is
 * mostly noise.
 */
export const PROJECTION_MIN_SPEED_MPS = 1.5

/**
 * ...and above this accuracy radius the fix cannot support a heading either.
 * Every request fix on the 09-21 rides measured 2.4-3.6 m; the 50 m bound only
 * excludes the urban-canyon fixes where `heading` flips 90 degrees between
 * consecutive seconds.
 */
export const PROJECTION_MAX_ACCURACY_M = 50

/**
 * The furthest a projection may move the origin. 120 m is about eighteen
 * seconds of cycling and comfortably over the worst measured round trip at
 * this rider's pace (10.3 s x 7.1 m/s = 73 m); it exists so a bogus `speed`
 * (a fix taken on a bus at 28 m/s, which the 09-21 morning ride has) cannot
 * throw the origin half a kilometre down the road.
 */
export const PROJECTION_MAX_M = 120

/** Weight on the newest observation when blending the latency estimate. */
export const REPLAN_LATENCY_ALPHA = 0.5

/**
 * Fold one observed round trip into the running estimate.
 *
 * A non-positive or non-finite sample is ignored outright: replay and the unit
 * harness resolve the fetch inside the same simulated millisecond, and a
 * zero-second "round trip" is not a measurement of a network.
 */
export function blendReplanLatencyMs(
  previousMs: number,
  observedMs: number | null | undefined
): number {
  const prev = Number.isFinite(previousMs) ? (previousMs as number) : 0
  if (
    observedMs == null ||
    !Number.isFinite(observedMs) ||
    (observedMs as number) <= 0
  ) {
    return prev
  }
  const blended =
    REPLAN_LATENCY_ALPHA * (observedMs as number) +
    (1 - REPLAN_LATENCY_ALPHA) * prev
  return Math.round(Math.min(REPLAN_LATENCY_MAX_MS, Math.max(0, blended)))
}

/** Great-circle bearing from a to b, in degrees clockwise from north. */
export function bearingDegrees(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number | null {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  ) {
    return null
  }
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δλ = ((lon2 - lon1) * Math.PI) / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** Smallest angle between two bearings, 0-180. */
export function angleBetweenDegrees(a: number, b: number): number {
  const d = Math.abs((a - b) % 360)
  return d > 180 ? 360 - d : d
}

/** Move a point `metres` along `bearingDeg`. */
export function moveAlongBearing(
  lat: number,
  lon: number,
  bearingDeg: number,
  metres: number
): { lat: number; lon: number } {
  const R = 6371000
  const δ = metres / R
  const θ = (bearingDeg * Math.PI) / 180
  const φ1 = (lat * Math.PI) / 180
  const λ1 = (lon * Math.PI) / 180
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  )
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    )
  return { lat: (φ2 * 180) / Math.PI, lon: (λ2 * 180) / Math.PI }
}

export interface ProjectedOrigin {
  /**
   * The instant the projected point is expected to be reached — what the query
   * should be time-anchored to, so the itinerary does not begin in the past
   * before it is rendered. NOT a change to the time FORMAT: the caller still
   * formats this through `OTP_API_TIME_FORMAT` (backlog 18.4 owns the
   * flooring).
   */
  atMs: number
  /** Where the rider is expected to be when the plan lands. */
  lat: number
  lon: number
  /** How far the origin was moved, in metres. 0 when nothing was projected. */
  metres: number
  /** Null when the fix could not support a projection; the reason, for logs. */
  skipped?: 'accuracy' | 'heading' | 'latency' | 'speed'
}

/**
 * The origin an automatic re-plan should ask about: the rider's latest fix
 * advanced along its own heading by the round trip the answer is expected to
 * take.
 *
 * Returns the fix unchanged (`metres: 0`) whenever the fix cannot support the
 * projection, so a caller can use the result unconditionally.
 */
export function projectReplanOrigin(input: {
  accuracyM?: number | null
  headingDeg?: number | null
  lat: number
  latencyMs: number
  lon: number
  nowMs: number
  speedMps?: number | null
}): ProjectedOrigin {
  const { accuracyM, headingDeg, lat, latencyMs, lon, nowMs, speedMps } = input
  const latency = Number.isFinite(latencyMs)
    ? Math.min(REPLAN_LATENCY_MAX_MS, Math.max(0, latencyMs))
    : 0
  const unchanged = (skipped: ProjectedOrigin['skipped']): ProjectedOrigin => ({
    atMs: nowMs + latency,
    lat,
    lon,
    metres: 0,
    skipped
  })
  if (latency <= 0) return unchanged('latency')
  if (
    speedMps == null ||
    !Number.isFinite(speedMps) ||
    speedMps < PROJECTION_MIN_SPEED_MPS
  ) {
    return unchanged('speed')
  }
  if (headingDeg == null || !Number.isFinite(headingDeg)) {
    return unchanged('heading')
  }
  if (
    accuracyM != null &&
    Number.isFinite(accuracyM) &&
    accuracyM > PROJECTION_MAX_ACCURACY_M
  ) {
    return unchanged('accuracy')
  }
  const metres = Math.min(PROJECTION_MAX_M, (speedMps * latency) / 1000)
  if (metres <= 0) return unchanged('speed')
  const moved = moveAlongBearing(lat, lon, headingDeg, metres)
  return { atMs: nowMs + latency, lat: moved.lat, lon: moved.lon, metres }
}

/**
 * How old a fix may be and still be where an automatic re-plan starts (51.3).
 * A minute of standing still or walking is well inside any access leg the
 * re-plan would draw; a minute of cycling is not, but a fix that old is only
 * ever chosen when every newer one is worse than `FIX_ACCURACY_MAX_M`, and a
 * kilometre-wide fix is a far worse guess than a 60 s old one.
 */
export const REPLAN_ORIGIN_MAX_AGE_MS = 60000

/** Where a fix handed to `pickReplanOriginFix` came from. */
export type ReplanOriginSource = 'go-mode' | 'last-trusted' | 'planner'

export interface ReplanOriginPick {
  /** Its age at `nowMs`, in ms. */
  ageMs: number
  position: GeolocationPosition
  source: ReplanOriginSource
}

/** A fix's accuracy radius, or null when it reports none. */
function fixAccuracyM(fix: GeolocationPosition | null | undefined) {
  const a = fix?.coords?.accuracy
  return a != null && Number.isFinite(a) ? (a as number) : null
}

/**
 * The fix an AUTOMATIC re-plan may take as its origin: the freshest of the
 * three candidates whose accuracy is within `FIX_ACCURACY_MAX_M` and whose age
 * is within `REPLAN_ORIGIN_MAX_AGE_MS` — else null, and the caller waits for a
 * better fix rather than planning from a bad one.
 *
 * 2026-10-13 09:31:25, ride `mv6ret6s-h5he2i` (backlog 51.3): the missed-bus
 * re-plan went out from Go Mode's first watcher fix, accuracy 1,414 m and
 * 1,247 m south of a rider standing ~14 m from I-35W & 46th St, and built a
 * 2,060 m bike loop back to the same station. The planner's own fix from 23 s
 * earlier (14 m) was in state the whole time, and a 90 m fix came 23 s later.
 *
 * - `goModeFix` — `goMode.tracking.lastPosition`, the latest fix of any quality.
 * - `lastTrustedFix` — `goMode.tracking.lastTrustedPosition`, the latest Go
 *   Mode fix that was itself within the accuracy bound.
 * - `plannerFix` — `otp.location.currentPosition`, the trip planner's own
 *   geolocation (what the search that started the trip went out from).
 *
 * A fix with no reported accuracy is not trusted: the bound is the whole
 * point. A fix dated in the future by more than the age bound (a simulated
 * clock against a wall-clock fix) is as unusable as one that old.
 * Ties go to the earlier argument, Go Mode's own stream first.
 */
export function pickReplanOriginFix(input: {
  goModeFix?: GeolocationPosition | null
  lastTrustedFix?: GeolocationPosition | null
  nowMs: number
  plannerFix?: GeolocationPosition | null
}): ReplanOriginPick | null {
  const { nowMs } = input
  const candidates: Array<[ReplanOriginSource, any]> = [
    ['go-mode', input.goModeFix],
    ['last-trusted', input.lastTrustedFix],
    ['planner', input.plannerFix]
  ]
  let best: ReplanOriginPick | null = null
  for (const [source, fix] of candidates) {
    const lat = fix?.coords?.latitude
    const lon = fix?.coords?.longitude
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const accuracy = fixAccuracyM(fix)
    if (accuracy == null || accuracy > FIX_ACCURACY_MAX_M) continue
    const at = Number(fix.timestamp)
    if (!Number.isFinite(at)) continue
    const ageMs = nowMs - at
    if (Math.abs(ageMs) > REPLAN_ORIGIN_MAX_AGE_MS) continue
    if (!best || at > Number(best.position.timestamp)) {
      best = { ageMs, position: fix, source }
    }
  }
  return best
}
