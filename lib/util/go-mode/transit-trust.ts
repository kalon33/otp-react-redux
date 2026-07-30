import type { Leg } from '@opentripplanner/types'

import { calculateDistance, matchPositionToRoute } from './position-matching'
import { orderedStopsOnLeg } from './next-stop'
import type { RouteMatchResult } from './position-matching'
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

// A GPS fix older than this can't vouch for where the rider is NOW. Native
// cadence is ~1/s and the browser transit poll is 10s — 15s tolerates one
// missed poll before the fix stops driving stop counts.
export const FIX_STALE_MS = 15000

// Fixes worse than this still draw the blue dot, they just don't drive stop
// counts — below the walk on-route threshold, so a fix this bad couldn't even
// prove the rider is on a sidewalk.
export const FIX_ACCURACY_MAX_M = 100

// The badge says "On/Tracking Bus" only while the match's lastSeen is younger
// than this (same scale as RIDING_OFFROUTE_CLEAR_MS). On 7/29 a confirmed
// match froze at its confirmation-time record and looked healthy for the rest
// of the ride.
export const VEHICLE_MATCH_FRESH_MS = 90000

/** A live vehicle record plus how old its feed timestamp is. */
export interface VehicleRecordLookup {
  /** Seconds since the feed last updated this vehicle; null when the record
   * carries no usable timestamp (unknown age — treated like the null
   * headsign/accuracy cases: it can't prove freshness, but it never blocks). */
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

/** Fresh enough to count as evidence about where the bus is right now.
 * A null ageSec passes: Metro Transit's live feed returns lastUpdated: null
 * for a good share of in-service vehicles, so "no timestamp" is normal, not
 * suspect — same policy as null headsigns/accuracy (never block a decision on
 * data a feed simply doesn't publish). The 7/29 flap carried a KNOWN-stale
 * timestamp, which this still rejects. */
export function isVehicleRecordFresh(
  record: VehicleRecordLookup | null
): boolean {
  return (
    record != null &&
    (record.ageSec == null || record.ageSec <= VEHICLE_RECORD_STALE_SEC)
  )
}

/**
 * The live record of the bus the rider is on, per the sticky riding fact:
 * vehicle id first (the physical bus is what the rider boarded), trip id as
 * the fallback when confirmation never captured a vehicle. Callers pass the
 * feed for riding.routeId — pure, so replay serves recorded snapshots.
 */
export function findRidingVehicle(
  vehicles: VehiclePosition[] | null | undefined,
  riding: { tripId: string | null; vehicleId: string | null } | null,
  nowMs: number
): VehicleRecordLookup | null {
  if (!riding) return null
  return (
    findVehicleById(vehicles, riding.vehicleId, nowMs) ??
    findVehicleForTrip(vehicles, riding.tripId, nowMs)
  )
}

/**
 * Refresh a user/auto-confirmed vehicle match from the feed record of the SAME
 * vehicle — never re-match. Before 7/29 a confirmed match froze whole: its
 * lastSeen/nextStopId stayed at confirmation time for the rest of the ride, so
 * staleness was invisible and nextStopId was useless as a progress source.
 * Null when the vehicle is absent from the feed — the caller dispatches
 * nothing and lastSeen ages honestly.
 */
export function refreshConfirmedMatch(
  previousMatch: VehicleMatchResult,
  vehicles: VehiclePosition[] | null | undefined,
  riderLat: number,
  riderLon: number,
  nowMs: number
): VehicleMatchResult | null {
  if (!vehicles || previousMatch.vehicleId == null) return null
  const vehicle = vehicles.find((v) => v.vehicleId === previousMatch.vehicleId)
  if (!vehicle) return null
  return {
    ...previousMatch,
    distanceMeters: calculateDistance(
      riderLat,
      riderLon,
      vehicle.lat,
      vehicle.lon
    ),
    lastSeen: nowMs,
    nextStopId: vehicle.nextStopId ?? previousMatch.nextStopId,
    tripId: vehicle.tripId ?? previousMatch.tripId
  }
}

/**
 * The BUS's own progress along the leg it serves — the rider is wherever
 * their bus is, however bad their phone's fix. Projects the vehicle's feed
 * position onto the single leg's geometry; the transit on-route threshold
 * applies, so a position that doesn't lie on the leg (wrong direction, feed
 * garbage) yields null rather than a bogus fraction. A lagging feed
 * under-reports progress, which over-counts stops remaining — conservative by
 * construction.
 */
export function vehicleProgressOnLeg(
  leg: Leg,
  vehicle: VehiclePosition
): number | null {
  if (vehicle?.lat == null || vehicle?.lon == null) return null
  const match = matchPositionToRoute([vehicle.lat, vehicle.lon], [leg], 0)
  return match?.isOnRoute ? match.progressAlongLeg : null
}

/**
 * Stop count from the feed's own "next stop" fact: exact stop identity on the
 * leg's ordered stop list, zero geometry guesswork. Null when the id is
 * unknown or off this leg (e.g. the bus is still upstream of the boarding
 * stop) — callers fall back to other sources.
 */
export function stopsAheadFromNextStopId(
  leg: Leg,
  nextStopId: string | null | undefined
): { nextStopName: string; stopsRemaining: number } | null {
  if (nextStopId == null) return null
  const ordered = orderedStopsOnLeg(leg)
  const idx = ordered.findIndex((s) => s.stopId === nextStopId)
  if (idx === -1) return null
  return {
    nextStopName: ordered[idx].name,
    stopsRemaining: ordered.length - idx
  }
}

/**
 * Is the rider's own GPS sound enough to drive stop counting? The same rule
 * getNextStopOnRide already applies (match anchored to the leg the rider is
 * on, and on-route), extended with fix staleness and accuracy: a 20s-old or
 * 150m-accurate fix still draws the map dot, but "N stops remaining" from it
 * is a guess. Null accuracy passes — don't distrust data a platform simply
 * doesn't report.
 */
export function assessRiderGpsTrust({
  accuracy,
  anchorLegIndex,
  fixAgeMs,
  routeMatch
}: {
  accuracy: number | null | undefined
  anchorLegIndex: number
  fixAgeMs: number
  routeMatch: RouteMatchResult | null
}): boolean {
  return (
    routeMatch != null &&
    routeMatch.legIndex === anchorLegIndex &&
    routeMatch.isOnRoute &&
    fixAgeMs < FIX_STALE_MS &&
    (accuracy == null || accuracy <= FIX_ACCURACY_MAX_M)
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
