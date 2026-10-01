import type { LatLngArray, Leg } from '@opentripplanner/types'

import {
  calculateDistance,
  TRANSIT_BOARD_ACCESS_DONE,
  TRANSIT_BOARD_ARRIVED_MAX_SPEED_MPS,
  TRANSIT_BOARD_PAST_STOP_M,
  TRANSIT_BOARD_STOP_RADIUS_M
} from './position-matching'
import { findVehicleForTrip, isVehicleRecordFresh } from './transit-trust'
import { hasUsablePosition } from './vehicle-matching'
import type { VehiclePosition } from './vehicle-matching'

/**
 * The platform wait, as one fact the whole app reads.
 *
 * The trip steps onto a transit leg before the bus leaves — it has to, because
 * `advanceToLeg` is the only place `startVehicleTracking` runs for a mid-trip
 * transit leg (13.1) — so for the whole wait the rider is standing still on a
 * leg the app has already entered. Two surfaces had to be told that separately
 * and a third was never told at all:
 *
 *  - the current-leg card said "On Bus #", counted stops and offered "I got
 *    off here" (13.9, shipped 2026-09-17 on `gomode/card-truth`);
 *  - the backgrounded banner said "On trip · Next stop X" (13.9's unbuilt
 *    half, which is why `isWaitingForDeparture` below is exported rather than
 *    left inline in TransitProgress);
 *  - and `determineTripStatus` scored the wait as falling behind (18.6).
 *
 * The first two ask the same question — "is the rider on the bus yet?" — and
 * now ask it through one predicate. The third asks a different one, "is the
 * rider standing at the boarding stop?", and has its own below.
 */

/**
 * Is the rider waiting for this leg's bus rather than riding it?
 *
 * The gate is a POSITIVE fact, not the absence of one: before the bus's own
 * departure time nobody can be riding it. Past that time the caller keeps its
 * old wording even without a riding fact, so a rider genuinely aboard a bus
 * the feed never confirmed is never told they are waiting.
 *
 * Extracted verbatim from TransitProgress (13.9) so the banner cannot grow a
 * second, drifting copy of it.
 */
export function isWaitingForDeparture({
  aboard,
  departureMs,
  leg,
  nowMs
}: {
  /** The riding fact places the rider on THIS leg. */
  aboard: boolean
  /**
   * The leg's board time, live preferred (`legBoard`). A FLOORED epoch (17.6)
   * is "no earlier than this" rather than a prediction — still a fact that the
   * departure has not happened, so it gates but must not be printed as a time.
   */
  departureMs: number | null | undefined
  leg: Leg | null | undefined
  nowMs: number
}): boolean {
  return (
    !aboard &&
    !!leg?.transitLeg &&
    departureMs != null &&
    Number.isFinite(departureMs) &&
    nowMs < departureMs
  )
}

/**
 * The transit leg the rider is either waiting for or standing on: the current
 * leg when it is a transit leg, else the next one when THAT is. -1 when the
 * rider is nowhere near a boarding.
 */
export function boardingLegIndex(
  legs: Leg[] | undefined,
  currentLegIndex: number
): number {
  if (!legs?.length) return -1
  if (legs[currentLegIndex]?.transitLeg) return currentLegIndex
  if (legs[currentLegIndex + 1]?.transitLeg) return currentLegIndex + 1
  return -1
}

/**
 * Is the rider standing at the boarding stop, not yet gone anywhere?
 *
 * Backlog 18.6. `determineTripStatus` compares SPATIAL progress against a
 * purely time-based expected curve, and a rider at the stop cannot make
 * spatial progress: on 2026-09-21 the `behind` at I-35W & Lake St was just how
 * long they had been standing there. There is no wait term in the curve, so
 * any wait longer than 5 % of the itinerary duration reads `behind`.
 *
 * The decision taken in the plan (2026-09-21) is that the wait is neither
 * ahead nor behind: a late bus is the BUS's delay, which the rider already
 * gets as `DELAY_ALERT`, and is not charged to them.
 *
 * ## Why this is spatial and not `legBoard`-in-the-future
 *
 * The row proposed gating on "the bus has not departed (`legBoard`, live
 * preferred, still ahead)". Measured against the ride it cannot carry the
 * wait: on `0921-1646-orange-missedbus` the live board epoch for leg 1 tracked
 * the late bus honestly (17:05:49 -> 17:07:36 across 16:57:07-17:04:22) and
 * then FELL BACK to a stale 17:03:00 from 17:04:42 onward, while the bus did
 * not arrive until 17:08:18. A `now < legBoard` gate would have released at
 * 17:04:42 and handed the rider back the `behind` for the last three minutes
 * of a wait they were doing nothing wrong in.
 *
 * What is true the whole time is spatial, and it is the same measurement
 * `hasReachedBoardingStop` already makes for the leg transition (13.1): the
 * rider is at the stop, and has not moved off it. Same radius, same
 * arrived-speed, same past-the-stop distance — one metre-count for "the rider
 * is at this stop", not three.
 */
export function waitingAtBoardingStop({
  aboardBeforeLeg,
  currentLegIndex,
  legs,
  progressAlongLeg,
  riderPosition,
  riderSpeedMps,
  ridingLegIndex
}: {
  /**
   * `aboardBeforeLegStart` (22.1) — the rider is verifiably aboard this leg's
   * bus and has not yet reached the stop the leg is anchored at. It is a
   * statement that they are RIDING, so it ends the wait: on 2026-09-21 ride 2
   * a rider on the 8228 sat 2.58 km north of 66th St with the projection
   * pinned to the leg's first vertex, which is exactly the shape the
   * transit-leg branch below otherwise reads as standing at the kerb.
   */
  aboardBeforeLeg?: boolean
  currentLegIndex: number
  legs: Leg[] | undefined
  /** 0-1 along the CURRENT leg — routeMatch.progressAlongLeg. */
  progressAlongLeg: number
  riderPosition?: LatLngArray | null
  riderSpeedMps?: number | null
  /** goMode.riding?.legIndex — the evidenced fact that the rider is aboard. */
  ridingLegIndex?: number | null
}): boolean {
  const boardIdx = boardingLegIndex(legs, currentLegIndex)
  if (boardIdx < 0) return false
  if (aboardBeforeLeg) return false
  // Aboard is aboard. The riding fact is the stronger one and ends the wait
  // whatever the geometry says, exactly as it does in shouldTransitionToNextLeg.
  if (ridingLegIndex != null && ridingLegIndex === boardIdx) return false

  const boardingLeg = (legs as Leg[])[boardIdx]

  if (boardIdx === currentLegIndex) {
    // Already ON the transit leg. Reaching it is itself the proof the rider got
    // to the stop — 13.1's gate is what let the trip step here — so the only
    // remaining question is whether they have LEFT it. Metres down the line,
    // not a radius: it survives the GPS scatter a stationary phone produces at
    // a busway platform (14-181 m from the stop node across the 16:57-17:08
    // wait on 0921-1646-orange-missedbus, with leg progress pinned at 0.0 %).
    const legDistanceM = Number((boardingLeg as any)?.distance)
    if (
      Number.isFinite(legDistanceM) &&
      Math.max(0, progressAlongLeg) * legDistanceM >= TRANSIT_BOARD_PAST_STOP_M
    ) {
      return false
    }
    return true
  }

  // Still on the ACCESS leg. Only positive evidence that the rider has arrived
  // at the stop counts — running the access leg out, or standing within the
  // stop radius at less than walking pace. A rider still travelling toward the
  // stop IS behind, and keeps saying so: on 0921-1605-465-wrongdir the rider
  // was 394 m out at 39 % of the bike leg and the row does not ask for that to
  // be silenced.
  if (progressAlongLeg >= TRANSIT_BOARD_ACCESS_DONE) return true

  const stop: any = (boardingLeg as any)?.from
  if (
    !riderPosition ||
    stop?.lat == null ||
    stop?.lon == null ||
    !Number.isFinite(Number(stop.lat)) ||
    !Number.isFinite(Number(stop.lon))
  ) {
    return false
  }
  const distanceToStopM = calculateDistance(
    riderPosition[0],
    riderPosition[1],
    Number(stop.lat),
    Number(stop.lon)
  )
  if (distanceToStopM > TRANSIT_BOARD_STOP_RADIUS_M) return false
  // A speed the platform never reported is not evidence of travel.
  return !(
    riderSpeedMps != null &&
    Number.isFinite(riderSpeedMps) &&
    riderSpeedMps > TRANSIT_BOARD_ARRIVED_MAX_SPEED_MPS
  )
}

/**
 * What the platform-wait card can truthfully say about the bus itself.
 *
 * Backlog 26.4. On 2026-09-22 08:21:57 the card read "Waiting at I-35W & 98th
 * St Station · 8:24 AM / Locating your bus..." while the tick was polling that
 * very trip's vehicle every 16 s and holding its position 6 km up the line.
 * "Locating" is the RIDER-proximity matcher's state (`goMode.vehicleMatch`),
 * and on the platform it is `none` by construction: the bus is not near the
 * rider yet, and should not be. The wait has its own fact — the planned trip's
 * own record in the route's vehicle feed, found by trip id, the same record
 * the missed-bus classifier and the board-time rules read (`findVehicleForTrip`
 * in the tick) — and this is that fact, reduced to what the card prints.
 *
 * Returns null when there is no fresh, positioned record for the trip: the
 * bus is not broadcasting (yet), which the caller says in those words.
 */
export interface WaitingBusStatus {
  /** Straight-line metres from the bus to the boarding stop, when both known. */
  distanceM: number | null
  /** Raw feed label (or vehicle id); the caller formats it for display. */
  label: string
  /** The bus's own run places it past the boarding stop. */
  passed: boolean
  /**
   * Stops the bus still has to make before the boarding stop, counting the
   * boarding stop: 1 = the boarding stop is its next stop, 0 = it is standing
   * at the boarding stop. Null when the trip's
   * stop order or the bus's next stop is unknown, or it is already past.
   */
  stopsAway: number | null
}

export function waitingBusStatus({
  boardStopId,
  boardStopLatLon,
  nowMs,
  record,
  tripStopIds
}: {
  boardStopId: string | null | undefined
  boardStopLatLon: { lat?: number | null; lon?: number | null } | null
  nowMs: number
  /** The trip's vehicle as the feed last published it, or null. */
  record: VehiclePosition | null | undefined
  /** tripStopIdsInOrder(transitIndex.trips[tripId]) */
  tripStopIds: string[] | null
}): WaitingBusStatus | null {
  if (!record || !hasUsablePosition(record)) return null
  const lookup = findVehicleForTrip([record], record.tripId, nowMs)
  if (!isVehicleRecordFresh(lookup)) return null
  const label = record.label || record.vehicleId
  if (!label) return null

  const distanceM =
    boardStopLatLon?.lat != null && boardStopLatLon?.lon != null
      ? calculateDistance(
          record.lat,
          record.lon,
          boardStopLatLon.lat,
          boardStopLatLon.lon
        )
      : null

  let stopsAway: number | null = null
  let passed = false
  if (tripStopIds?.length && boardStopId && record.nextStopId) {
    const boardIdx = tripStopIds.indexOf(boardStopId)
    const nextIdx = tripStopIds.indexOf(record.nextStopId)
    if (boardIdx !== -1 && nextIdx !== -1) {
      // GTFS-RT names the stop a bus is STOPPED_AT as its "next" stop, so a
      // bus standing at the boarding stop is 0 away, not 1.
      const atNext =
        String(record.stopStatus ?? '').toUpperCase() === 'STOPPED_AT'
      if (nextIdx > boardIdx) passed = true
      else stopsAway = boardIdx - nextIdx + (atNext ? 0 : 1)
    }
  }
  return { distanceM, label, passed, stopsAway }
}
