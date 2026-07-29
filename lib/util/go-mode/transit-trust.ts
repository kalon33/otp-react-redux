import type { Leg } from '@opentripplanner/types'

import type { VehicleMatchResult, VehiclePosition } from './vehicle-matching'

/**
 * Trust gates for the transit portion of a live trip.
 *
 * On the 7/29 ride a stale GTFS-RT position let the opposite-direction Orange
 * Line hijack the vehicle match for two ticks; the riding fact rebound onto
 * the wrong trip and the boarded-earlier auto-replan cascaded the rider onto
 * itineraries they weren't on. Every predicate here exists to make sure that
 * chain needs sustained, mutually consistent, FRESH evidence before any
 * aboard-state fact is rewritten or an auto-replan fires. All pure — the
 * callers in actions/go-mode.ts supply state.
 */

// A GTFS-RT vehicle record whose feed timestamp (`seconds`) is older than
// this is not evidence — the 7/29 flap was driven entirely by a position the
// bus had outrun.
export const VEHICLE_RECORD_STALE_SEC = 120

// "The bus is verifiably still at/near the boarding stop" — same scale as the
// transit on-route threshold (position-matching.ts), measured on the
// VEHICLE's position, never the rider's.
export const VEHICLE_AT_BOARD_STOP_M = 250

// How many consecutive 1/s vehicle matches must agree before the sticky
// riding.tripId may rebind to a different trip. Today's promotion needs only
// 2 — exactly what the 7/29 flap survived. Eight is still fast for a real
// correction (~8s) and beyond any flap a stale feed has produced.
export const RIDING_REBIND_MIN_CONSECUTIVE = 8

// You can't be aboard a bus that hasn't left yet: riding this much before the
// planned board time proves the rider caught an earlier departure.
export const EARLY_BOARD_MIN_MS = 120000

/** A live vehicle record plus how old its feed timestamp is. */
export interface VehicleRecordLookup {
  /** Seconds since the feed last updated this vehicle; null when the record
   * carries no usable timestamp (never treated as fresh). */
  ageSec: number | null
  vehicle: VehiclePosition
}

function toRecord(
  vehicle: VehiclePosition,
  nowMs: number
): VehicleRecordLookup {
  const seconds = vehicle.seconds
  return {
    ageSec:
      typeof seconds === 'number' && Number.isFinite(seconds)
        ? nowMs / 1000 - seconds
        : null,
    vehicle
  }
}

/** The live record of the vehicle serving a given GTFS trip, if any. */
export function findVehicleForTrip(
  vehicles: VehiclePosition[] | null | undefined,
  tripId: string | null | undefined,
  nowMs: number
): VehicleRecordLookup | null {
  if (!vehicles || tripId == null) return null
  const vehicle = vehicles.find((v) => v.tripId === tripId)
  return vehicle ? toRecord(vehicle, nowMs) : null
}

/** The live record for a specific vehicle id, if the feed has one. */
export function findVehicleById(
  vehicles: VehiclePosition[] | null | undefined,
  vehicleId: string | null | undefined,
  nowMs: number
): VehicleRecordLookup | null {
  if (!vehicles || vehicleId == null) return null
  const vehicle = vehicles.find((v) => v.vehicleId === vehicleId)
  return vehicle ? toRecord(vehicle, nowMs) : null
}

/** Fresh enough to count as evidence about where the bus is right now. */
export function isVehicleRecordFresh(
  record: VehicleRecordLookup | null
): boolean {
  return (
    record != null &&
    record.ageSec != null &&
    record.ageSec <= VEHICLE_RECORD_STALE_SEC
  )
}

/**
 * Headsign consistency, tolerant of missing data: equal (trimmed,
 * case-insensitive) when both sides are known; a null on either side passes —
 * never block a decision on data a feed simply doesn't publish.
 */
function headsignsConsistent(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (a == null || b == null) return true
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * May the sticky riding.tripId be (re)written to `candidateTripId`?
 *
 * Establishing the fact and refreshing it on the same trip stay instant; a
 * REBIND — declaring the rider is on a different bus than we thought — needs
 * a sustained run of consecutive matches AND a headsign consistent with the
 * ride. On 7/29 two ticks of a stale-feed mismatch ("Orange Downtown
 * Minneapolis" vs the ride's "Orange Burnsville") rewrote riding.tripId and
 * armed the boarded-earlier replan; this blocks that twice over.
 */
export function shouldRebindRidingTrip(
  riding: { headsign: string | null; tripId: string | null } | null,
  candidateTripId: string | null,
  matchedLeg: { headsign?: string | null } | null,
  vehicleMatchState: {
    consecutiveMatches?: number
    match?: { tripHeadsign?: string | null } | null
  } | null
): boolean {
  // First establishment — nothing held yet to protect.
  if (!riding || riding.tripId == null) return true
  // Same trip: a refresh (legIndex change, offRouteSince clear), never gated.
  if (candidateTripId === riding.tripId) return true
  if (
    (vehicleMatchState?.consecutiveMatches ?? 0) < RIDING_REBIND_MIN_CONSECUTIVE
  ) {
    return false
  }
  return headsignsConsistent(
    vehicleMatchState?.match?.tripHeadsign ?? null,
    riding.headsign ?? matchedLeg?.headsign ?? null
  )
}

/**
 * Should the boarded-earlier auto-replan fire for the leg the rider is on?
 *
 * The legitimate case — the rider caught an earlier run of the same route —
 * still fires: a sustained trusted match on a different trip with the same
 * headsign and a fresh feed record, or simply being aboard before the planned
 * bus could exist. What can no longer fire is the 7/29 signature: a
 * flap-promoted match on an opposite-direction vehicle whose own feed record
 * was the stale thing that caused the flap. Defense in depth behind the
 * rebind hysteresis — this is the trigger that actually replaces the
 * itinerary. Attempt/rate-limit bookkeeping stays with the caller.
 */
export function shouldReplanBoardedEarlier({
  nowMs,
  ridingLeg,
  vehicleMatchState,
  vehicleRecord
}: {
  nowMs: number
  ridingLeg: Leg
  vehicleMatchState: {
    consecutiveMatches?: number
    match?: VehicleMatchResult | null
  } | null
  vehicleRecord: VehicleRecordLookup | null
}): boolean {
  const plannedTripId =
    (ridingLeg as any)?.trip?.gtfsId || (ridingLeg as any)?.tripId
  const matched = vehicleMatchState?.match
  const tripMismatch =
    (matched?.confidence === 'confirmed' || matched?.confidence === 'high') &&
    matched?.tripId != null &&
    plannedTripId != null &&
    matched.tripId !== plannedTripId &&
    (vehicleMatchState?.consecutiveMatches ?? 0) >=
      RIDING_REBIND_MIN_CONSECUTIVE &&
    // An opposite-direction same-route vehicle can never be "the earlier bus
    // you boarded".
    headsignsConsistent(
      matched?.tripHeadsign ?? null,
      (ridingLeg as any)?.headsign ?? null
    ) &&
    isVehicleRecordFresh(vehicleRecord)
  const aboardBeforePlanned =
    nowMs < Number(ridingLeg.startTime) - EARLY_BOARD_MIN_MS
  return tripMismatch || aboardBeforePlanned
}
