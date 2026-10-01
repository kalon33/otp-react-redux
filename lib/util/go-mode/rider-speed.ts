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
 * ---------------------------------------------------------------------------
 * THE RIDE-LEVEL ANCHOR (2026-09-15, backlog 16.1)
 * ---------------------------------------------------------------------------
 *
 * A five-minute median is the right answer to "how fast now" and the WRONG
 * number to time a whole access leg with, because it cannot tell a rider who
 * has slowed down from a rider who is momentarily stuck. On the 2026-09-15
 * Orange Line ride the estimator did exactly what it was built to do and was
 * still wrong in effect: crossing the downtown grid 09:41-09:52 its honest
 * moving-only median fell 3.41 -> 2.47 -> 2.05 -> 2.00 (the bottom of
 * LEVER_RANGES.bikeSpeed), every re-plan in that window was timed for a 2 m/s
 * cyclist, and OTP then installed access legs that ran 1.29-1.60 m/s effective
 * on top of that — one of them 1,173 m of one-way loops for a stop 345 m away.
 * The same rider had been doing 5.6-6.3 m/s ten minutes earlier and was back to
 * 5.4 m/s after the bus. Two minutes of kerb-crawling should not be allowed to
 * re-describe the bicycle.
 *
 * So the short window now has a FLOOR under it, taken from the ride itself:
 *
 * - a second, much sparser series records one number per
 *   RIDER_SPEED_ANCHOR_BUCKET_MS (one minute) of riding: the PEAK moving fix in
 *   that minute. Within one minute the fastest fix is the best evidence of what
 *   the street actually allowed; the slower fixes in the same minute are the
 *   lights and the pedestrians, which is what the floor exists to survive,
 * - the anchor is the MEDIAN of those per-minute peaks over the last
 *   RIDER_SPEED_ANCHOR_WINDOW_MS. Median, not mean and not a percentile of the
 *   peaks: a multipath spike owns at most the one minute it lands in, and the
 *   median then ignores it, so the anchor keeps the same spike-immunity the
 *   short window has,
 * - the estimate never comes back below RIDER_SPEED_ANCHOR_FLOOR_FRACTION (0.7)
 *   of that anchor. 0.7 is the largest honest slowdown: a rider who has really
 *   changed pace — a headwind, a hill, a heavy bag, fatigue — loses roughly a
 *   fifth to a quarter of their cruising speed and keeps riding, so 0.7x still
 *   believes a genuine slowdown, while 30% off cruising is where "slower" stops
 *   being a pace and starts being a traffic light. Below the fraction the short
 *   window is measuring the street, not the rider,
 * - and there is NO floor until RIDER_SPEED_ANCHOR_MIN_BUCKETS (10) minutes of
 *   riding are on record. An anchor must outlast the window it overrules — ten
 *   minutes is twice RIDER_SPEED_WINDOW_MS — or the first slow minute of a ride
 *   would floor itself against its own first fast minute.
 *
 * Measured on that ride's own fixture (orange-0915-0931.json, replayed through
 * __tests__/util/go-mode/rider-speed-anchor-0915.ts): 09:43:21 2.42 -> 4.51,
 * 09:49:25 2.05 -> 3.56, 09:50:56 2.00 -> 3.54, against a ride anchor of
 * 5.06-6.44 m/s. 09:32:48 is untouched at 5.89 — ten minutes of riding had not
 * accumulated yet, and the short window was right anyway.
 *
 * Note what the anchor is NOT. It is not "the ride's median speed": on this
 * ride the plain median of moving fixes over the whole bike leg is 2.8-3.1 m/s,
 * because eleven of the twenty-one minutes WERE the crawl, so 0.7x of it lands
 * at 2.0 and the floor would have been inert on the very ride that motivated
 * it. The crawl has to be down-weighted within each minute before the ride-level
 * statistic is taken, which is what the per-minute peak does.
 *
 * The anchor series inherits the caller's leg-mode gate exactly as the short
 * buffer does — bike legs only, never aboard. It has to: a bus minute peaks
 * around 13 m/s, under RIDER_SPEED_IMPLAUSIBLE_MPS, and would anchor the rider
 * to a vehicle. (The short window has the identical exposure and the identical
 * defence; see handlePositionUpdate in lib/actions/go-mode.ts.)
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
 * One anchor sample per minute of riding. Short enough that a real change of
 * pace shows up within a few buckets, long enough that a bucket's peak is a
 * street speed and not one lucky fix.
 */
export const RIDER_SPEED_ANCHOR_BUCKET_MS = 60000

/**
 * How much ride the anchor remembers. Half an hour is longer than any downtown
 * crossing and shorter than "a different ride in a different place".
 */
export const RIDER_SPEED_ANCHOR_WINDOW_MS = 1800000

/**
 * No floor until this many minutes of riding are on record — twice
 * RIDER_SPEED_WINDOW_MS, so the anchor always outlasts what it overrules.
 */
export const RIDER_SPEED_ANCHOR_MIN_BUCKETS = 10

/**
 * Memory bound, and slack over WINDOW_MS / BUCKET_MS (30) so trimming is done
 * by age rather than by this.
 */
export const RIDER_SPEED_ANCHOR_MAX_BUCKETS = 40

/**
 * The deepest honest slowdown. A rider who has genuinely changed pace keeps
 * roughly three quarters of their cruising speed; a rider reading under 0.7x of
 * it over five minutes is stuck in traffic, not slower.
 */
export const RIDER_SPEED_ANCHOR_FLOOR_FRACTION = 0.7

/** One minute of riding, reduced to the fastest moving fix it contained. */
export interface RiderSpeedAnchorBucket {
  /** The fastest moving fix recorded inside the bucket. */
  peakMps: number
  /** Bucket start: floor(tMs / RIDER_SPEED_ANCHOR_BUCKET_MS) * BUCKET_MS. */
  startMs: number
}

/**
 * Is this fix usable evidence of a cycling pace at all? Shared by both series
 * so the anchor can never be built from samples the short window rejected.
 */
function isMovingFix(
  speedMps: number | null | undefined,
  tMs: number
): speedMps is number {
  return (
    Number.isFinite(tMs) &&
    speedMps != null &&
    Number.isFinite(speedMps) &&
    speedMps >= RIDER_SPEED_MOVING_MIN_MPS &&
    speedMps <= RIDER_SPEED_IMPLAUSIBLE_MPS
  )
}

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
  if (!isMovingFix(speedMps, tMs)) return samples
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
 * Fold one fix into the sparse ride-level series: it either raises the peak of
 * the minute it belongs to or opens that minute. Buckets are keyed on the FIX's
 * own timestamp, like the short buffer, so a replayed ride rebuilds exactly the
 * anchor the live one had.
 *
 * ~40 numbers for half an hour of riding, against RIDER_SPEED_MAX_SAMPLES (400)
 * for four minutes of the 1 Hz series — the anchor is cheap enough to keep for
 * the whole ride precisely because it throws away everything but the peak.
 */
export function recordRiderSpeedAnchorSample(
  buckets: RiderSpeedAnchorBucket[],
  sample: { speedMps: number | null | undefined; tMs: number }
): RiderSpeedAnchorBucket[] {
  const { speedMps, tMs } = sample
  if (!isMovingFix(speedMps, tMs)) return buckets
  const startMs =
    Math.floor(tMs / RIDER_SPEED_ANCHOR_BUCKET_MS) *
    RIDER_SPEED_ANCHOR_BUCKET_MS
  const kept = buckets.filter(
    (b) => tMs - b.startMs <= RIDER_SPEED_ANCHOR_WINDOW_MS
  )
  const at = kept.findIndex((b) => b.startMs === startMs)
  if (at >= 0) {
    if (speedMps <= kept[at].peakMps) return kept
    kept[at] = { peakMps: speedMps, startMs }
  } else {
    kept.push({ peakMps: speedMps, startMs })
    kept.sort((a, b) => a.startMs - b.startMs)
  }
  return kept.length > RIDER_SPEED_ANCHOR_MAX_BUCKETS
    ? kept.slice(kept.length - RIDER_SPEED_ANCHOR_MAX_BUCKETS)
    : kept
}

/**
 * The ride's own cruising pace — the median of its per-minute peaks — or null
 * while there is less than RIDER_SPEED_ANCHOR_MIN_BUCKETS minutes of riding
 * behind it.
 *
 * Deliberately NOT clamped to LEVER_RANGES: this is evidence, not a lever, and
 * the clamp belongs on the one number that reaches a query.
 */
export function estimateRideAnchorMps(
  buckets: RiderSpeedAnchorBucket[] | null | undefined,
  nowMs: number
): number | null {
  if (!buckets?.length || !Number.isFinite(nowMs)) return null
  const recent = buckets.filter(
    (b) => nowMs - b.startMs <= RIDER_SPEED_ANCHOR_WINDOW_MS
  )
  if (recent.length < RIDER_SPEED_ANCHOR_MIN_BUCKETS) return null
  return median(recent.map((b) => b.peakMps))
}

/**
 * The rider's cycling speed to hand OTP, or null when the evidence is too thin
 * to improve on the profile/engine default.
 *
 * The short-window median leads; `anchorBuckets` — when there is enough ride
 * behind it — puts a floor of RIDER_SPEED_ANCHOR_FLOOR_FRACTION x the ride's
 * cruising pace under the answer, so a downtown crawl cannot re-describe the
 * bicycle for a whole access leg. See the header for why the floor is a
 * fraction of a median-of-per-minute-peaks and not of the ride's own median.
 *
 * The anchor argument is optional so the estimator still answers the honest
 * short-window question on its own; callers that have a ride behind them
 * (observedBikeSpeedMps in lib/actions/go-mode.ts) pass it.
 *
 * Clamped to the same [2, 8] range routing-profiles.ts enforces on every other
 * lever — floor included — so no amount of bad GPS can put an absurd number in
 * a plan query.
 */
export function estimateBikeSpeedMps(
  samples: RiderSpeedSample[] | null | undefined,
  nowMs: number,
  anchorBuckets?: RiderSpeedAnchorBucket[] | null
): number | null {
  if (!samples?.length || !Number.isFinite(nowMs)) return null
  const recent = samples.filter((s) => nowMs - s.tMs <= RIDER_SPEED_WINDOW_MS)
  if (recent.length < RIDER_SPEED_MIN_SAMPLES) return null
  const span = recent[recent.length - 1].tMs - recent[0].tMs
  if (span < RIDER_SPEED_MIN_SPAN_MS) return null
  const observed = median(recent.map((s) => s.speedMps))
  const anchor = estimateRideAnchorMps(anchorBuckets, nowMs)
  const floored =
    anchor == null
      ? observed
      : Math.max(observed, anchor * RIDER_SPEED_ANCHOR_FLOOR_FRACTION)
  const [min, max] = LEVER_RANGES.bikeSpeed
  return Math.min(max, Math.max(min, floored))
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
