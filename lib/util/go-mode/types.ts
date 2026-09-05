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
   */
  boardClamped?: boolean
  boardEpoch: number | null
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
