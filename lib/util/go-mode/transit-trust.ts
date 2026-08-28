import type { Leg } from '@opentripplanner/types'

import { calculateDistance, matchPositionToRoute } from './position-matching'
import { hasUsablePosition } from './vehicle-matching'
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

// Past this separation a "confirmed" match is no longer describing the bus the
// rider is on. Feed lag on freeway BRT can genuinely put the published position
// several hundred metres from the rider, and MAX_ADJUSTED_RADIUS_METERS (2500,
// vehicle-matching.ts) is already the widest the matcher will reach for a
// moving rider — so anything beyond that is not lag, it is a different vehicle
// or a ride that ended. Demotes to 'medium'; never drops.
export const CONFIRMED_MATCH_MAX_SEPARATION_M = 2500

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
  // Prefer a record that actually carries a position — one vehicleId can have
  // several, and the coordinateless ghost is often first (see 8/2 note on
  // refreshConfirmedMatch). Falling back to any record keeps this honest about
  // presence when the feed publishes nothing better.
  const forVehicle = vehicles.filter((v) => v.vehicleId === vehicleId)
  const vehicle = forVehicle.find(hasUsablePosition) ?? forVehicle[0]
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
 * Is a confirmed vehicle match still evidence that the rider is ABOARD?
 *
 * A confirmed match is the rider's own assertion and outlives a lot on purpose
 * — STOP_GO_MODE keeps it, session restore keeps it — but it does not outlive
 * getting off. 8/9 19:29:13: the rider alighted at 19:27:43, and 90 s later the
 * onboard flow read the surviving match for trip 1:1085482 as proof they were
 * still on it and put them back on that bus. Alighting from a trip disproves a
 * match for that same trip (by trip OR by vehicle: a match re-anchored to the
 * bus's next block trip is the same physical bus they stepped off).
 *
 * Deliberately NOT a distance or motion test. On 8/9 the bus was 118 m away and
 * closing — 19 s later it was 4 m away — so proximity would have blocked a bus
 * the rider may well have been boarding. What they had stopped doing is riding
 * THAT trip; what they might do next is the rider's to say.
 */
export function matchProvesAboard(
  match: { tripId?: string | null; vehicleId?: string | null } | null,
  alightedFrom: { tripId?: string | null; vehicleId?: string | null } | null
): boolean {
  if (!match?.tripId) return false
  if (!alightedFrom) return true
  if (alightedFrom.tripId != null && alightedFrom.tripId === match.tripId) {
    return false
  }
  return !(
    alightedFrom.vehicleId != null && alightedFrom.vehicleId === match.vehicleId
  )
}

/**
 * Refresh a user/auto-confirmed vehicle match from the feed record of the SAME
 * vehicle — never re-match. Before 7/29 a confirmed match froze whole: its
 * lastSeen/nextStopId stayed at confirmation time for the rest of the ride, so
 * staleness was invisible and nextStopId was useless as a progress source.
 * Null when the vehicle is absent from the feed — the caller dispatches
 * nothing and lastSeen ages honestly.
 *
 * One vehicleId can have MORE THAN ONE record: on 8/2 Metro Transit published
 * a coordinateless ghost for 1:8223's next block trip alongside the live one,
 * and taking the first match copied the ghost's tripId into the confirmed
 * match every tick — which armed the boarded-earlier replan forever. So pick
 * deliberately: a record that says where the bus is, and among those the one
 * still serving the trip we already believed.
 */
export function refreshConfirmedMatch(
  previousMatch: VehicleMatchResult,
  vehicles: VehiclePosition[] | null | undefined,
  riderLat: number,
  riderLon: number,
  nowMs: number
): VehicleMatchResult | null {
  if (!vehicles || previousMatch.vehicleId == null) return null
  const forVehicle = vehicles.filter(
    (v) => v.vehicleId === previousMatch.vehicleId && hasUsablePosition(v)
  )
  if (forVehicle.length === 0) return null
  const vehicle =
    forVehicle.find((v) => v.tripId === previousMatch.tripId) ?? forVehicle[0]
  const distanceMeters = Math.round(
    calculateDistance(riderLat, riderLon, vehicle.lat, vehicle.lon)
  )

  // A confirmed match is still the rider's own assertion, and a large distance
  // is still information rather than grounds to DROP it — that principle is
  // load-bearing and earned (the 8/2 ghost record). What was wrong was the
  // second half of the old reasoning: "VEHICLE_MATCH_FRESH_MS already handles
  // staleness" could never be true while lastSeen was stamped `nowMs` on every
  // successful refresh. A match the feed keeps publishing could not age out at
  // any distance, so on 2026-08-27 a "confirmed" match followed bus 1:1786
  // away from the rider at exactly rider speed, out to 13,322 m and across the
  // vehicle's rollover onto its next trip, with no mechanism able to end it.
  //
  // So: age honestly (below), and beyond a plainly impossible separation
  // DEMOTE rather than drop. Demotion just returns the match to the normal
  // matcher, which re-evaluates from scratch and can re-promote immediately if
  // the rider really is aboard — so a single bad reading is self-correcting and
  // the rider's assertion is never silently discarded.
  const implausiblyFar = distanceMeters > CONFIRMED_MATCH_MAX_SEPARATION_M

  // The feed's own observation time, not the moment we happened to poll. Falls
  // back to nowMs when the record carries no usable timestamp, so a feed
  // without `seconds` behaves exactly as before instead of reading as ancient.
  const observedMs =
    typeof vehicle.seconds === 'number' && Number.isFinite(vehicle.seconds)
      ? Math.min(nowMs, vehicle.seconds * 1000)
      : nowMs

  return {
    ...previousMatch,
    ...(implausiblyFar ? { confidence: 'medium' as const } : {}),
    // Sub-metre precision on a GTFS-RT position is noise; this value is only
    // ever displayed or threshold-compared.
    distanceMeters,
    lastSeen: observedMs,
    nextStopId: vehicle.nextStopId ?? previousMatch.nextStopId,
    // Headsign travels WITH the trip id. shouldReplanBoardedEarlier's
    // opposite-direction guard compares tripHeadsign against the leg; before
    // 8/2 the id was refreshed and the headsign was not, so the guard passed
    // on confirmation-time data while the id underneath had drifted.
    ...(vehicle.tripId != null && vehicle.tripId !== previousMatch.tripId
      ? {
          tripHeadsign: vehicle.tripHeadsign ?? null,
          tripId: vehicle.tripId
        }
      : { tripId: vehicle.tripId ?? previousMatch.tripId })
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
  ridingTripId,
  vehicleMatchState,
  vehicleRecord
}: {
  nowMs: number
  ridingLeg: Leg
  /** The sticky riding fact's trip — the identity replanFromAboard will
   * actually build its splice from. See the trigger/remedy note below. */
  ridingTripId?: string | null
  vehicleMatchState: {
    consecutiveMatches?: number
    match?: VehicleMatchResult | null
  } | null
  vehicleRecord: VehicleRecordLookup | null
}): boolean {
  const plannedTripId =
    (ridingLeg as any)?.trip?.gtfsId || (ridingLeg as any)?.tripId
  const matched = vehicleMatchState?.match
  // 'confirmed' needs no sustained run: match promotion never produces it —
  // only an explicit rider confirmation or the riding lock in beginGoMode
  // does, and refreshConfirmedMatch never re-matches — so a flap cannot reach
  // it. It also CANNOT satisfy a run: the confirmed-refresh dispatch doesn't
  // maintain consecutiveMatches, so requiring one made this gate unreachable
  // exactly when the rider had already told us which bus they're on.
  const sustained =
    matched?.confidence === 'confirmed' ||
    (vehicleMatchState?.consecutiveMatches ?? 0) >=
      RIDING_REBIND_MIN_CONSECUTIVE
  const tripMismatch =
    (matched?.confidence === 'confirmed' || matched?.confidence === 'high') &&
    matched?.tripId != null &&
    plannedTripId != null &&
    matched.tripId !== plannedTripId &&
    // Gate on the identity the REMEDY will use, not just the one the trigger
    // sees. replanFromAboard splices from riding.tripId, which is frozen once
    // a vehicle is confirmed (shouldRebindRidingTrip is dead-gated on
    // consecutiveMatches), while match.tripId is rewritten every poll. On 8/2
    // that mismatch made the replan unable to ever satisfy its own trigger —
    // all nine applied itineraries were byte-identical — so no cooldown could
    // have terminated it. With this conjunct the loop is self-terminating by
    // construction: after a successful splice legs[busLeg].tripId ===
    // riding.tripId, so the trigger is false on the next tick.
    ridingTripId != null &&
    ridingTripId !== plannedTripId &&
    sustained &&
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
