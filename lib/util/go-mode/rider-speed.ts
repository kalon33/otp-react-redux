import { LEVER_RANGES } from '../routing-profiles'
import type { RoutingPreferences } from '../routing-profiles'

/**
 * How fast the rider is actually cycling, in a form a plan query can carry.
 *
 * On 2026-08-28 every access re-plan re-derived the bike leg at OTP's default
 * speed while the rider was measurably doing 5.6–7.8 m/s. `riderSpeedMps` was
 * being read off every fix (`position.coords.speed`) and spent only on local
 * heuristics — riding establishment, the missed-bus classifier, turn-cue lead
 * scaling — and never reached a query, so a re-plan's bike leg was timed for
 * somebody else. That is what produced the three backwards trip sheets: the
 * rider kept arriving at the boarding stop well before the itinerary said they
 * could, and the transit suffix spliced onto it was sequenced for the wrong
 * arrival.
 *
 * The naive fix is worse than the bug. `coords.speed` is INSTANTANEOUS: a
 * cyclist stopped at a red light reports 0, and a multipath fix can report
 * nonsense. Handing OTP the latest sample would ask it to route a 0 m/s (in
 * practice, clamped-to-2 m/s) cyclist every time a re-plan happened to land at
 * a stoplight — a new way to lie about bike time, in the opposite direction.
 *
 * So the number that reaches a query is a ROLLING estimate, not a sample:
 *
 * - only fixes taken while the rider is on a bike leg reach the buffer at all
 *   (the caller gates that; a bus fix is 15 m/s and would clamp to the top of
 *   the lever range),
 * - samples below RIDER_SPEED_MOVING_MIN_MPS are discarded, so lights,
 *   junctions and kerb waits do not drag the estimate down. This matches what
 *   OTP means by `bikeSpeed` — street traversal speed, with intersection delay
 *   priced separately — rather than door-to-door average,
 * - samples above RIDER_SPEED_IMPLAUSIBLE_MPS are discarded as not-a-bicycle,
 *   so one bad fix (or a mis-detected mode) cannot poison the buffer,
 * - the statistic is the MEDIAN of what survives, not the mean and not a high
 *   percentile: the median of a moving-only sample is a fair cruising speed and
 *   is unmoved by the handful of spikes at either end that a GPS stream always
 *   carries. A high percentile would quote a downhill sprint as the rider's
 *   pace and re-create the same class of error,
 * - and it answers `null` — meaning "use the profile or OTP's default" — until
 *   there is real evidence: RIDER_SPEED_MIN_SAMPLES moving fixes spanning at
 *   least RIDER_SPEED_MIN_SPAN_MS. One block of riding is not a pace.
 *
 * The window is deliberately short (RIDER_SPEED_WINDOW_MS): the answer should
 * be "how fast is this rider going now, on this terrain", not a trip average
 * that a long transit leg in the middle would render meaningless.
 *
 * Everything here is pure so the estimator can be tested directly, the way
 * deviation.ts, riding.ts and transit-trust.ts are.
 */

export interface RiderSpeedSample {
  /** Ground speed in m/s, already known to be a plausible cycling speed. */
  speedMps: number
  /**
   * The FIX's own timestamp, not the wall clock — a replayed or simulated ride
   * then produces exactly the estimate the live one did.
   */
  tMs: number
}

/** Only the last few minutes of riding describe the pace right now. */
export const RIDER_SPEED_WINDOW_MS = 300000

/**
 * Below this the rider is stopped, rolling to a halt, or pushing the bike —
 * none of which is the speed OTP should time a bike leg at. Set under a slow
 * cyclist and over a brisk walk.
 */
export const RIDER_SPEED_MOVING_MIN_MPS = 1.5

/**
 * ~54 km/h. Above this it is not a bicycle: a GPS spike, or a fix taken in a
 * vehicle that the leg-mode gate failed to exclude.
 */
export const RIDER_SPEED_IMPLAUSIBLE_MPS = 15

/** Fewer moving fixes than this is an anecdote, not a pace. */
export const RIDER_SPEED_MIN_SAMPLES = 8

/**
 * ...and they must span real time. Eight fixes one second apart is a single
 * moment; eight spread over a minute is a pace.
 */
export const RIDER_SPEED_MIN_SPAN_MS = 60000

/** Memory bound: ~4 minutes of a 1 Hz native stream. */
export const RIDER_SPEED_MAX_SAMPLES = 400

/**
 * Add one fix's ground speed to the buffer, dropping what is not usable and
 * what has aged out. Returns a new array — the caller owns where it is kept
 * (session.riderSpeedSamples).
 *
 * Trimming is judged against the incoming sample's own timestamp, for the same
 * reason the samples carry one: replay must reproduce the live buffer exactly.
 */
export function recordRiderSpeedSample(
  samples: RiderSpeedSample[],
  sample: { speedMps: number | null | undefined; tMs: number }
): RiderSpeedSample[] {
  const { speedMps, tMs } = sample
  if (!Number.isFinite(tMs)) return samples
  if (
    speedMps == null ||
    !Number.isFinite(speedMps) ||
    speedMps < RIDER_SPEED_MOVING_MIN_MPS ||
    speedMps > RIDER_SPEED_IMPLAUSIBLE_MPS
  ) {
    return samples
  }
  const kept = samples.filter((s) => tMs - s.tMs <= RIDER_SPEED_WINDOW_MS)
  kept.push({ speedMps, tMs })
  return kept.length > RIDER_SPEED_MAX_SAMPLES
    ? kept.slice(kept.length - RIDER_SPEED_MAX_SAMPLES)
    : kept
}

/** Median of a non-empty numeric array. Even lengths take the mean of the pair. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * The rider's cycling speed to hand OTP, or null when the evidence is too thin
 * to improve on the profile/engine default.
 *
 * Clamped to the same [2, 8] range routing-profiles.ts enforces on every other
 * lever, so no amount of bad GPS can put an absurd number in a plan query.
 */
export function estimateBikeSpeedMps(
  samples: RiderSpeedSample[] | null | undefined,
  nowMs: number
): number | null {
  if (!samples?.length || !Number.isFinite(nowMs)) return null
  const recent = samples.filter((s) => nowMs - s.tMs <= RIDER_SPEED_WINDOW_MS)
  if (recent.length < RIDER_SPEED_MIN_SAMPLES) return null
  const span = recent[recent.length - 1].tMs - recent[0].tMs
  if (span < RIDER_SPEED_MIN_SPAN_MS) return null
  const [min, max] = LEVER_RANGES.bikeSpeed
  return Math.min(max, Math.max(min, median(recent.map((s) => s.speedMps))))
}

/**
 * Merge an observed cycling speed into a re-plan's routing preferences.
 *
 * `bikeSpeed` rides the `routingPreferences` channel rather than mode settings
 * on purpose. generateOtp2Query re-destructures five named levers out of
 * modeSettingValues and overrides whatever the caller set; bikeSpeed is not one
 * of them — it is injected by extendPlanQueryWithLevers and merged onto the
 * GraphQL variables afterwards by applyRoutingPreferences, which is also what
 * clamps it. Setting it here is therefore the one place it survives to OTP.
 *
 * A speed the rider CHOSE always wins over one we inferred: if the active
 * profile or the rider's own levers already name a bikeSpeed (bike-forward's
 * 5.5, or anything the preferences box returned), the observation is dropped
 * rather than averaged in. Filling an unset lever is help; overwriting a set
 * one is second-guessing the rider.
 */
export function withObservedBikeSpeed(
  prefs: RoutingPreferences | undefined,
  observedMps: number | null | undefined
): RoutingPreferences | undefined {
  if (observedMps == null || !Number.isFinite(observedMps)) return prefs
  if (typeof prefs?.bikeSpeed === 'number') return prefs
  const [min, max] = LEVER_RANGES.bikeSpeed
  return {
    ...(prefs || {}),
    bikeSpeed: Math.min(max, Math.max(min, observedMps))
  }
}
