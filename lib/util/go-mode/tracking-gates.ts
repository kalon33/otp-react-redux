/**
 * tracking-gates.ts — the four decisions that govern the position stream,
 * pulled out of the action file so each can be asserted without a store, a
 * Capacitor bridge, or a phone.
 *
 * They exist because every one of them was wrong on a ride we have the logs
 * for, and each was wrong in a way that only showed up in the RELATIONSHIP
 * between two subsystems — the radio and the watchdog, the boot card and the
 * replan, the planner's poll and Go Mode's own stream. The decision is the part
 * worth pinning; the wiring around it is not.
 */

/**
 * Live trip: every fix. Vehicle matching wants ~1 Hz and the fix is also the
 * app's background heartbeat (tick-on-position), so a filtered stream mid-ride
 * would cost the trip its clock.
 */
export const LIVE_DISTANCE_FILTER_METERS = 0

/**
 * After arrival: a coarse filter, so a phone sitting on a table wakes the GPS
 * chip for nothing. 50 m is deliberately gentle — far enough that a parked
 * rider produces no fixes at all, near enough that walking back out of the
 * building still re-establishes the stream within a block.
 *
 * The consumer-side funnel (Session 1.3) already throttled what ARRIVES to one
 * fix per 30 s; this is the half that stops them being generated. On
 * 2026-08-28 the untouched watcher delivered 5,318 post-arrival fixes over 88
 * parked minutes.
 */
export const ARRIVED_DISTANCE_FILTER_METERS = 50

/** The distance filter the native watcher should be holding right now. */
export function nativeGpsDistanceFilterFor(arrived: boolean): number {
  return arrived ? ARRIVED_DISTANCE_FILTER_METERS : LIVE_DISTANCE_FILTER_METERS
}

export interface WatchdogDecision {
  /** `goMode.arrivedAt != null` — the trip is over. */
  arrived: boolean
  /** Consecutive fast retries allowed before backing off to `watchdogMs`. */
  maxFastRetries: number
  /** How many times in a row we have restarted without a fix coming back. */
  restartsSinceLastFix: number
  /** The shortened window used while a restart is still unproven. */
  retryMs: number
  /** Wall-clock silence on the position stream. */
  silenceMs: number
  /** The ordinary silence budget for a healthy trip. */
  watchdogMs: number
}

/**
 * Whether the wedged-watcher watchdog should tear the native watcher down and
 * build a new one.
 *
 * Two things it has to get right, and neither is "has it been quiet for a
 * while".
 *
 * **After arrival, silence is the goal.** The watcher is re-armed with
 * `ARRIVED_DISTANCE_FILTER_METERS` once the rider is at the door, and a parked
 * phone under a distance filter delivers exactly nothing — which is the
 * watchdog's own definition of a wedge. Left alone it would restart the
 * watcher every window forever, and idling the radio would cost more battery
 * than not idling it. So arrival suppresses the restart outright: there is
 * nothing left to navigate, and the next real trip re-arms the watcher through
 * `startPositionTracking` anyway.
 *
 * **A restart is not proof of a fix.** On 2026-08-31 (session
 * `mthnk1al-x7m0iv`) the watcher went quiet at 17:15:01; the watchdog fired at
 * 17:16:01 ("no fix for 60s"), the restart delivered ONE 1615 m cell-tower fix
 * and wedged again, and the rider then waited another full window — 17:17:01,
 * "no fix for 60s" — before the second restart brought the stream back at
 * 17:17:12. Nearly two and a half minutes of dead navigation for a fault that
 * a 20-second re-check would have cleared in twenty. So while a restart is
 * still unproven the window shortens, for a bounded number of tries, and then
 * backs off — a genuinely dead radio must not be churned at 20 s forever.
 */
export function shouldRestartNativeWatcher({
  arrived,
  maxFastRetries,
  restartsSinceLastFix,
  retryMs,
  silenceMs,
  watchdogMs
}: WatchdogDecision): boolean {
  if (arrived) return false
  const unproven =
    restartsSinceLastFix > 0 && restartsSinceLastFix <= maxFastRetries
  return silenceMs > (unproven ? retryMs : watchdogMs)
}

export interface SeedDecision {
  /** `goMode.progress` — null is what renders the boot card. */
  hasProgress: boolean
  /** `goMode.tracking.lastPosition?.timestamp`. */
  lastPositionMs: number | null | undefined
  /** Oldest fix still worth re-running. */
  maxAgeMs: number
  nowMs: number
}

/**
 * Whether to re-run the last known fix through the position pipeline so the
 * Go Mode screen has something to draw.
 *
 * `START_GO_MODE` sets `progress: null` (`reducers/go-mode.ts:696`), and
 * GoModeScreen renders "Starting Trip… / Acquiring GPS signal…" whenever
 * `!activeItinerary || !progress` (`GoModeScreen.tsx:230`). On a FRESH start
 * that card is honest. On a mid-trip replan it is not: the rider is already
 * moving, the app already knows where they are, and the screen goes blank
 * until the next fix happens to land.
 *
 * On 2026-08-31 the auto-applied "boarded earlier" replan re-dispatched
 * `START_GO_MODE` at 17:15:01 — and the native watcher wedged on the same
 * second. The next position did not arrive until 17:16:01. The rider spent
 * that minute looking at a boot screen on a bus platform and wrote "What's
 * going on / Why don't you answer me". The fix that had ticked at 17:15:01 was
 * sitting in the store the whole time.
 *
 * Age-gated because a stale fix is worse than the card: re-running a position
 * from the last trip would put the rider somewhere they are not.
 */
export function shouldSeedProgressFromLastFix({
  hasProgress,
  lastPositionMs,
  maxAgeMs,
  nowMs
}: SeedDecision): boolean {
  if (hasProgress) return false
  if (lastPositionMs == null) return false
  const ageMs = nowMs - lastPositionMs
  return ageMs >= 0 && ageMs <= maxAgeMs
}

export interface ReusePositionDecision {
  /** `goMode.tracking.lastPosition?.timestamp`. */
  lastPositionMs: number | null | undefined
  maxAgeMs: number
  nowMs: number
  /** `goMode.isActive` — the native stream is the one supplying fixes. */
  trackingActive: boolean
}

/**
 * Whether the planner's periodic "where is the user" refresh can be answered
 * out of Go Mode's own stream instead of waking the radio again.
 *
 * `responsive-webapp.js` arms a 30 s `getCurrentPosition` on every mobile load
 * and never clears it, so `POSITION_FETCHING`/`POSITION_RESPONSE` run for the
 * whole session — a median 31.0 s through `mtin0l9c-yieexg`, 202 of them
 * across the 104-minute 2026-08-31 mount, ride or no ride. During a trip that
 * is a second, redundant consumer of the same chip: the native watcher is
 * already streaming the rider's position at 1 Hz into `goMode.tracking`.
 *
 * So during a trip the poll is answered from the fix Go Mode already has, and
 * the radio is left alone. Outside a trip it does what it always did — the
 * planner genuinely needs a location for the search form, and nothing else is
 * asking for one.
 */
export function shouldReuseGoModePosition({
  lastPositionMs,
  maxAgeMs,
  nowMs,
  trackingActive
}: ReusePositionDecision): boolean {
  if (!trackingActive) return false
  if (lastPositionMs == null) return false
  const ageMs = nowMs - lastPositionMs
  return ageMs >= 0 && ageMs <= maxAgeMs
}
