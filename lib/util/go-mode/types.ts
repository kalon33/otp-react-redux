/**
 * Shared Go Mode types.
 *
 * These live here rather than in actions/go-mode.ts so that the reducer, the
 * util modules and the components can name a 12-line interface without pulling
 * a large side-effectful action module into their import graph. That import was
 * also the util layer's only upward dependency.
 *
 * Re-exported from actions/go-mode.ts for existing callers.
 */

/** Live (or schedule-fallback) times for a transit leg, keyed by leg index. */
export interface LiveLegTime {
  alightEpoch: number | null
  /** alightEpoch is a floor, not an estimate. Mirrors boardIsFloor. */
  alightIsFloor?: boolean
  /**
   * Whether alightEpoch came from the feed rather than the timetable — this is
   * the estimate, not a prediction, so it must NOT be styled live.
   */
  alightProjected?: boolean
  /** Whether alightEpoch is a live prediction (drives the pulsing icon). */
  alightRealtime?: boolean
  /**
   * Set by clampNonLiveLegTimes when it bridged a stale non-live board time
   * across the poll gap, so the bridge happens once and a departed run is not
   * projected forward on every tick. Cleared by the next refresh poll, which
   * rebuilds the entry.
   *
   * This is the LATCH, not the provenance: it says "the bridge has been spent
   * on this record", and clampNonLiveLegTimes tests it to stop the walk. What
   * the value IS is `boardIsFloor` below. Keep them apart — setting this one
   * from anywhere else would silently disarm that bridge.
   *
   * MEASURED 2026-09-15 (session mu346i5y-ng2uqc, leg 0, from the day file):
   * the latch does NOT in fact stop the walk, because "cleared by the next
   * refresh poll" happens every 20 s. Between 15:37:39 and 15:49:44 the board
   * epoch was re-raised to the current millisecond on ~30 successive polls and
   * re-clamped to the whole minute 11 times — 15:38:00, 15:39:00, 15:40:00,
   * 15:41:00, 15:42:00, 15:43:00, 15:44:00, 15:46:00, 15:47:00, 15:48:00,
   * 15:49:00, each with `boardClamped: true` and each undone 20 s later. The
   * 2026-09-04 "bridge once" promise therefore holds only within a poll
   * interval; fixing that is a separate matter from this flag. What
   * `boardIsFloor` does is make the value unusable as a wait basis either way.
   */
  boardClamped?: boolean
  boardEpoch: number | null
  /**
   * boardEpoch is a FLOOR, not a statement about when the bus leaves: a stale
   * non-live time raised to `now` (mergeLiveTimePoint) or to the current
   * minute (clampNonLiveLegTimes). The raise exists so a displayed time never
   * walks backwards, and for that it is right — but the number it produces is
   * "no earlier than this", and the bus may be minutes further out.
   *
   * So nothing may compute a WAIT from it, and nothing may publish it as the
   * board time. 2026-09-15, backlog 17.6: the rider wrote "- minute waits make
   * no sense" at 15:37:32, and leg 0's boardEpoch that ride took roughly forty
   * distinct values in thirteen minutes, of which two classes are this flag's:
   * the current millisecond on every 20 s refresh poll (mergeLiveTimePoint's
   * `Math.max(kept.epoch, nowMs)`) and the whole minute with
   * `boardClamped: true` on every minute boundary (clampNonLiveLegTimes). Both
   * sit at or barely behind `now`, so `boardEpoch − now` is always about zero.
   *
   * The row's third value is NOT this family and this flag does not cover it:
   * 15:26:00 at 15:36:33, 15:31:00 at 15:43:28 and 15:33:00 at 15:44:06 all
   * arrived with `boardRealtime: true`, one per itinerary swap — the feed's own
   * prediction for a from-stop already behind the bus. getEffectiveBoardTimeMs
   * trusts `boardRealtime` first, so that one still reaches the wait math.
   *
   * legBoard refuses to publish a floored epoch, which is what keeps these two
   * out of the trip sheet's wait arithmetic.
   */
  boardIsFloor?: boolean
  /** Mirrors alightProjected. */
  boardProjected?: boolean
  /** Whether boardEpoch is a live prediction. */
  boardRealtime?: boolean
  /** Legacy any-field-live flag; display code should use the per-field ones. */
  realtime: boolean
}

/**
 * The durable "rider is aboard this vehicle" fact. Unlike routeMatch (a
 * per-GPS-tick snapshot) and vehicleMatch (reset by each new trip/search),
 * this survives new searches and itinerary switches so the app never asks
 * the rider which bus they're on mid-ride. Cleared when the rider alights
 * (leg transition past the bus leg), Go Mode stops, or the rider stays
 * off-route long enough that the fact is evidently no longer true.
 */
export interface RidingState {
  /** Epoch ms when aboard-ness was first established. */
  boardedAt: number
  headsign: string | null
  /** Transit leg index in activeItinerary; -1 = not anchored to a leg. */
  legIndex: number
  /** Epoch ms of the first consecutive off-route tick; null while on route. */
  offRouteSince: number | null
  routeId: string | null
  routeShortName: string | null
  tripId: string | null
  vehicleId: string | null
}

/**
 * Who chose the departure currently in force (`goMode.departureOverride`).
 *
 * The value alone cannot say: an anchor pick and a rider pick are both
 * timestamps out of the same departure list. Nothing recorded it, and the gap
 * showed on a resume — `manualDepartureLock` and `session.lastAutoAnchorMs`
 * are both trip-session state, rebuilt as `false`/null by a page load, so a
 * restored override was simultaneously "not the anchor's" (it does not equal
 * `lastAutoAnchorMs`, so `evaluateDepartureAnchor` leaves it alone) and "not
 * the rider's" (no lock). A REACHABLE restored pick was therefore held as
 * though the anchor owned it, with nothing to say whether it had ever been
 * chosen (backlog 12.15; the unreachable half of the same hole is 12.3).
 *
 * Stored beside the value, saved with the session, and read back by
 * `resumeGoModeTrip` to rebuild the right one of those two facts.
 */
export type DepartureOverrideSource = 'anchor' | 'rider'
