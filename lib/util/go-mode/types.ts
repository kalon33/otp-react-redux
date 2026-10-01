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
  boardEpoch: number | null
  /**
   * boardEpoch is a FLOOR, not a statement about when the bus leaves: a stale
   * non-live time whose moment has gone (mergeLiveTimePoint / markStaleLegTimes
   * both say so once it falls behind the displayed minute). The number is "no
   * earlier than this", and the bus may be minutes further out.
   *
   * So nothing may compute a WAIT from it, and nothing may publish it as the
   * board time. 2026-09-15, backlog 17.6: the rider wrote "- minute waits make
   * no sense" at 15:37:32, and leg 0's boardEpoch that ride took roughly forty
   * distinct values in thirteen minutes.
   *
   * DERIVED, never latched (backlog 17.19, 2026-09-22). Two of those forty
   * classes were this flag's, and both were manufactured by the code that set
   * it: the current millisecond on every 20 s refresh poll (mergeLiveTimePoint's
   * `Math.max(kept.epoch, nowMs)`, 35 dispatches 15:37:39-15:49:00) and the
   * whole minute on every minute boundary, carrying a `boardClamped` latch that
   * the next poll rebuilt away — set and undone eleven times in twelve minutes.
   * Neither raises the epoch now; the flag is recomputed from the clock on every
   * call, and `boardClamped` is gone. A 725-second reconstruction of that
   * cadence: 12 re-latches and 123 now-valued epochs before, 0 and 0 after.
   *
   * The row's third value is NOT this family and this flag does not cover it:
   * 15:26:00 at 15:36:33, 15:31:00 at 15:43:28 and 15:33:00 at 15:44:06 all
   * arrived with `boardRealtime: true`, one per itinerary swap — the feed's own
   * prediction for a from-stop already behind the bus. Re-measured 2026-09-22
   * (backlog 17.18): all three landed while the riding fact stood, so they
   * never reached the wait math; the class that did was leg 1's 15:35:00, four
   * dispatches 15:35:15-15:36:17. `realtimeBoardIsSpent` (board-departure.ts)
   * is what demotes one of those to this flag when the bus's own record says it
   * has not reached the stop.
   *
   * legBoard refuses to publish a floored epoch, which is what keeps every one
   * of these out of the trip sheet's wait arithmetic.
   */
  boardIsFloor?: boolean
  /** Mirrors alightProjected. */
  boardProjected?: boolean
  /** Whether boardEpoch is a live prediction. */
  boardRealtime?: boolean
  /**
   * WHICH of OTP's two live answers boardEpoch came from — the trip query
   * (`trip.stoptimesForDate`, the tick's only source until 2026-09-21) or the
   * boarding stop's own poll (`stop.stoptimesForPatterns`, what the pacing
   * card reads). They can disagree while BOTH claim `realtimeState: UPDATED`:
   * on 2026-09-21 08:26:24 the trip query gave the schedule (08:26:00) for a
   * bus the stop query had at 08:31:27 (+5m27s), and the board time was
   * published `boardRealtime: true` at the scheduled moment for 17 ticks
   * (backlog 21.1). The stop-level live value now wins, and this says so.
   *
   * Recorded, not acted on: display code should keep reading `boardRealtime`.
   * Undefined on a record whose provenance is unknown (an older persisted
   * session, or a value neither source produced).
   */
  boardSource?: 'stop' | 'trip'
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
