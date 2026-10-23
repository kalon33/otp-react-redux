/**
 * The near-destination dwell: arrival for a rider who has stayed within
 * ARRIVAL_RADIUS_M of the door for ARRIVAL_DWELL_MS on a bike or walking
 * finish, without ever reading inside ARRIVAL_RADIUS_ACTIVE_M (backlog 12.17,
 * rider's answers 2026-10-20: Q3 "on a bike or walking last leg, wait until
 * within 40 m", Q4 "also count it once I've been within 75 m for a minute").
 *
 * Why it has to exist: the 40 m radius alone is a trip that may never
 * complete. A destination geocoded to the middle of a building, a phone that
 * reads 50 m out in the lobby, a rider who locks the bike at the kerb 60 m
 * from the pin — each of those would latch on the old 75 m rule and would now
 * track forever (see the ARRIVAL_MAX_DISTANCE_M comment in
 * progress-calculator). The minute is the answer to that, and it is never MORE
 * eager than the 75 m rule it replaces: everything it grants, 75 m granted
 * the instant the rider crossed it.
 *
 * The state is the moment the rider came within 75 m, and WHICH destination
 * that was. The destination travels with it because the itinerary can change
 * under it — a quiet re-plan, a multi-stop's next segment, a round trip's
 * return — and a minute spent near one door is not a minute spent near
 * another. It is saved with the session (like `arrivedAt`), so a relaunch at
 * the door does not start the minute again.
 *
 * Pure: the tick decides with it, and the wall-clock timer in actions/go-mode
 * re-checks with it before it fires.
 */
import {
  ARRIVAL_DWELL_MS,
  ARRIVAL_MIN_PROGRESS,
  ARRIVAL_RADIUS_M,
  isActiveFinishMode
} from './progress-calculator'

export interface NearDestination {
  /** Where the destination was when the minute started — the last leg's `to`. */
  lat: number
  lon: number
  /** Epoch ms of the first fix inside ARRIVAL_RADIUS_M. */
  sinceMs: number
}

/** Same metre-scale tolerance a re-geocode of the same place sits inside. */
const SAME_DESTINATION_DEG = 1e-5

/** The itinerary's destination, [lat, lon], or null when it has none. */
export function finalDestinationOf(
  legs:
    | Array<{ mode?: string; to?: { lat?: number; lon?: number } }>
    | null
    | undefined
): { lat: number; lon: number; mode: string | null } | null {
  if (!legs?.length) return null
  const last = legs[legs.length - 1]
  const lat = last?.to?.lat
  const lon = last?.to?.lon
  if (
    lat == null ||
    lon == null ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  )
    return null
  return { lat, lon, mode: last?.mode ?? null }
}

/**
 * Is `near` still about THIS itinerary — same destination, and still a bike or
 * walking finish? Anything else is a minute about a trip that has gone.
 */
export function nearDestinationApplies(
  near: NearDestination | null | undefined,
  legs:
    | Array<{ mode?: string; to?: { lat?: number; lon?: number } }>
    | null
    | undefined
): boolean {
  if (!near) return false
  const dest = finalDestinationOf(legs)
  if (!dest || !isActiveFinishMode(dest.mode)) return false
  return (
    Math.abs(dest.lat - near.lat) <= SAME_DESTINATION_DEG &&
    Math.abs(dest.lon - near.lon) <= SAME_DESTINATION_DEG
  )
}

/**
 * The dwell state after this fix.
 *
 * Arms on the first fix within ARRIVAL_RADIUS_M with overall progress at or
 * past ARRIVAL_MIN_PROGRESS on a bike or walking finish — the same floor the
 * distance branch of hasArrivedAtDestination uses, and for the same reason (a
 * destination that merely sits near the route early on). Keeps the original
 * `sinceMs` while that holds. Disarms on anything else: a fix beyond 75 m, an
 * unknown distance (no measurement, no minute), progress under the floor, a
 * finish that is no longer active, or a different destination.
 *
 * Returns the SAME object when nothing changed, so the caller can tell a
 * change by identity and dispatch only then.
 */
export function nextNearDestination(
  prev: NearDestination | null | undefined,
  input: {
    distanceToDestination: number | null | undefined
    legs:
      | Array<{ mode?: string; to?: { lat?: number; lon?: number } }>
      | null
      | undefined
    nowMs: number
    overallProgress: number
  }
): NearDestination | null {
  const dest = finalDestinationOf(input.legs)
  const d = input.distanceToDestination
  const inside =
    dest != null &&
    isActiveFinishMode(dest.mode) &&
    d != null &&
    Number.isFinite(d) &&
    d <= ARRIVAL_RADIUS_M &&
    input.overallProgress >= ARRIVAL_MIN_PROGRESS
  if (!inside || !dest) return null
  if (prev && nearDestinationApplies(prev, input.legs)) return prev
  return { lat: dest.lat, lon: dest.lon, sinceMs: input.nowMs }
}

/** Has the rider been near THIS destination for the whole dwell? */
export function nearDestinationDwellDone(
  near: NearDestination | null | undefined,
  legs:
    | Array<{ mode?: string; to?: { lat?: number; lon?: number } }>
    | null
    | undefined,
  nowMs: number
): boolean {
  return (
    near != null &&
    nearDestinationApplies(near, legs) &&
    nowMs - near.sinceMs >= ARRIVAL_DWELL_MS
  )
}

/**
 * Milliseconds until the dwell completes, clamped to [0, ARRIVAL_DWELL_MS] —
 * capped for the reason armAutoEndTimer caps its own delay: a device clock
 * correction can put `sinceMs` far from `Date.now()`, and an uncapped delay is
 * either a trip left open for days or, past 2^31 ms, a timeout that fires
 * immediately.
 */
export function nearDestinationDelayMs(
  near: NearDestination,
  nowMs: number
): number {
  return Math.min(
    ARRIVAL_DWELL_MS,
    Math.max(0, near.sinceMs + ARRIVAL_DWELL_MS - nowMs)
  )
}
