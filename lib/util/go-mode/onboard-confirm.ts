/**
 * ─── Is the stop the rider is confirming still ahead of them? (64.1) ────────
 *
 * The onboard preview's Confirm used to start the trip for whatever stop the
 * list offered, however long ago and wherever the bus had got to since. On
 * 2026-10-19 (session `mvfqu4i0-yd2epd`) the Gold Line list was ranked at
 * 16:34:16 with the bus at 6th St & Minnesota; the rider confirmed Minnesota at
 * 16:35:17 from ~131 m past it, the new trip's Gold leg lay wholly behind them,
 * and "Off route · 253m" was pushed 33 s after Go with the rider 4 m from the
 * bus. The feed could not have said so — every UPDATE_VEHICLE_MATCH up to the
 * Confirm still named Minnesota as the next stop, on a frame frozen at
 * 16:34:19 — only the rider's own fix did. On 2026-10-20 08:32:53 the list
 * the rider confirmed was 12.8 minutes old.
 *
 * So at Confirm the rider's fix is measured along the bus's own run, and the
 * list's age is read off `onboard.resultAtMs`. Either one past its line and
 * the Confirm re-asks the optimizer from the first stop still ahead of the
 * rider (the rider's answer, 2026-10-20 Q1 = B: "Start the trip at the best
 * stop still ahead, with a 'Trip updated' note").
 *
 * Pure: no redux, no clock of its own.
 */
import type { Itinerary } from '@opentripplanner/types'

import { builtAlightStop, onwardRouteOfItinerary } from './alight-optimizer'
import {
  decodeTripShape,
  firstStopAheadOnShape,
  metersPastOnShape
} from './geometry'
import { FIX_ACCURACY_MAX_M } from './transit-trust'
import { legTripId } from './leg-merge'

// Moved to geometry.ts so the alight optimizer can read the shape too (75.8)
// without importing this module, which imports it.
export { decodeTripShape }

/**
 * Past the chosen get-off stop by more than this, along the run, and the stop
 * is behind the rider. Well clear of a stop's own platform and of a good fix's
 * error; the 2026-10-19 rider was ~131 m past.
 */
export const ONBOARD_CONFIRM_PASSED_M = 50

/**
 * A list older than this is re-asked before it is committed. The bus covers a
 * stop or two in two minutes, and the onward plans' departure times move with
 * it. The 2026-10-19 list was 69 s old (caught by the position test, not this
 * one); the 2026-10-20 list 12.8 min.
 */
export const ONBOARD_CONFIRM_LIST_MAX_AGE_MS = 2 * 60_000

/** A fix older than this says nothing about where the rider is now. */
export const ONBOARD_CONFIRM_FIX_MAX_AGE_MS = 2 * 60_000

export interface OnboardConfirmCheck {
  /** The first stop still ahead of the rider, by trip stop id (null: unknown). */
  aheadStopId: string | null
  /** How old the list is, ms; null when it did not say. */
  listAgeMs: number | null
  /** Metres the fix is past the chosen alight stop; null when unmeasurable. */
  pastM: number | null
  /**
   * Why the Confirm must re-ask, or null to commit as chosen. 'passed' wins
   * over 'stale': it is the one that changes what happens when the re-ask
   * finds nothing (the list is shown again rather than the choice started).
   * 'stops' is never measured here: the Confirm sets it when the rider has
   * just skipped an added stop the chosen option went through (63.1), and an
   * empty re-ask then shows the list again too.
   */
  reason: 'passed' | 'stale' | 'stops' | null
}

interface FixLike {
  coords?: {
    accuracy?: number | null
    latitude?: number | null
    longitude?: number | null
  } | null
  timestamp?: number | null
}

const stopIdOf = (stop: any): string | null => stop?.id ?? stop?.gtfsId ?? null

/**
 * Should this Confirm re-ask before it commits — and if so, from where?
 *
 * `itinerary` is the trip the Confirm would start (buildOnboardItinerary's
 * output for the chosen option): its leg on the boarded trip names the stop
 * the ride is measured FROM (the anchor) and the stop it gets the rider off
 * at. A fix that is too coarse or too old is not used for "passed" — a
 * kilometre-wide fix must not move the rider's stop.
 */
export function onboardConfirmRecheck(input: {
  itinerary: Itinerary | null | undefined
  lastPosition: FixLike | null | undefined
  nowMs: number
  resultAtMs: number | null | undefined
  trip: any
}): OnboardConfirmCheck {
  const { itinerary, lastPosition, nowMs, resultAtMs, trip } = input
  const listAgeMs =
    typeof resultAtMs === 'number' && Number.isFinite(resultAtMs)
      ? nowMs - resultAtMs
      : null
  const stale = listAgeMs != null && listAgeMs > ONBOARD_CONFIRM_LIST_MAX_AGE_MS

  const tripId = trip?.id ?? trip?.gtfsId ?? null
  const stopTimes: any[] = trip?.stopTimes || []
  const stops = stopTimes.map((st) => st?.stop ?? null)
  const shape = decodeTripShape(trip)
  const lat = lastPosition?.coords?.latitude
  const lon = lastPosition?.coords?.longitude
  const accuracy = lastPosition?.coords?.accuracy
  const fixAgeMs =
    typeof lastPosition?.timestamp === 'number'
      ? nowMs - lastPosition.timestamp
      : null
  const fixUsable =
    lat != null &&
    lon != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    (accuracy == null ||
      !Number.isFinite(accuracy) ||
      accuracy <= FIX_ACCURACY_MAX_M) &&
    (fixAgeMs == null || fixAgeMs <= ONBOARD_CONFIRM_FIX_MAX_AGE_MS)
  const point: [number, number] | null = fixUsable
    ? [lat as number, lon as number]
    : null

  // The leg the rider is riding, as the Confirm would build it.
  const busLeg: any = (itinerary?.legs || []).find(
    (l: any) => l?.transitLeg && tripId != null && legTripId(l) === tripId
  )
  const anchorStopId =
    busLeg?.from?.stop?.gtfsId ?? busLeg?.from?.stopId ?? null
  const anchorIdx = anchorStopId
    ? stops.findIndex((s) => stopIdOf(s) === anchorStopId)
    : -1
  const alight = builtAlightStop(itinerary, tripId)
  const alightIdx = alight
    ? stops.findIndex(
        (s, i) => i >= Math.max(0, anchorIdx) && stopIdOf(s) === alight.stopId
      )
    : -1

  const pastM =
    point && shape && alightIdx >= 0
      ? metersPastOnShape(shape, {
          anchorIndex: Math.max(0, anchorIdx),
          point,
          stopIndex: alightIdx,
          stops
        })
      : null
  const passed = pastM != null && pastM > ONBOARD_CONFIRM_PASSED_M

  const aheadIdx =
    point && shape
      ? firstStopAheadOnShape(shape, stops, point, {
          fromStopIndex: Math.max(0, anchorIdx)
        })
      : null
  const aheadStopId = aheadIdx != null ? stopIdOf(stops[aheadIdx]) : null

  return {
    aheadStopId,
    listAgeMs,
    pastM,
    reason: passed ? 'passed' : stale ? 'stale' : null
  }
}

interface AlightOptionLike {
  alightStopId?: string | null
  itinerary?: Itinerary | null
  stopId: string
}

const onwardRoute = (o: AlightOptionLike | null | undefined): string | null =>
  o?.itinerary ? onwardRouteOfItinerary(o.itinerary) : null

const alightOf = (o: AlightOptionLike): string => o.alightStopId ?? o.stopId

/**
 * From the re-asked list, the option the Confirm starts — the rider's order:
 * the stop they chose if it is still offered (on their onward route when it
 * can be), else the same onward route from another stop, else the list's top.
 * Null when the re-ask came back empty.
 */
export function pickRecheckedAlight<T extends AlightOptionLike>(
  ranked: T[] | null | undefined,
  chosen: AlightOptionLike
): T | null {
  const list = ranked || []
  if (!list.length) return null
  const route = onwardRoute(chosen)
  const atChosen = list.filter(
    (o) => o.stopId === chosen.stopId || alightOf(o) === alightOf(chosen)
  )
  const sameRoute = (os: T[]) =>
    route ? os.find((o) => onwardRoute(o) === route) ?? null : null
  return sameRoute(atChosen) || atChosen[0] || sameRoute(list) || list[0]
}

/**
 * Did the re-check change what the rider confirmed — the stop they get off at
 * or the route they ride on from it? Only then is there a "Trip updated" to
 * tell them; the same stop and route starting from a fresher list is just the
 * Confirm they asked for.
 */
export function recheckChangedTrip(
  picked: AlightOptionLike,
  chosen: AlightOptionLike
): boolean {
  return (
    alightOf(picked) !== alightOf(chosen) ||
    onwardRoute(picked) !== onwardRoute(chosen)
  )
}
