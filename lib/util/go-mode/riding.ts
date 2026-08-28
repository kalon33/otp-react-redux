import type { Leg } from '@opentripplanner/types'

import { shouldRebindRidingTrip } from './transit-trust'
import type { RidingState } from './types'
import type { RouteMatchResult } from './position-matching'
import type { VehicleMatchResult } from './vehicle-matching'

/**
 * Deciding the sticky "riding" fact, as a pure function.
 *
 * This logic used to live inline in handlePositionUpdate, the one part of Go
 * Mode with no test coverage at all — which is where every riding bug of
 * 2026-08-27 lived. Extracting it follows the same shape the rest of this
 * module already uses (a pure evaluator, with the caller owning dispatch).
 */

/** How much progress along a transit leg counts as being aboard it. */
export const RIDING_MIN_PROGRESS = 0.05

/**
 * GPS alone may only ESTABLISH riding within this distance of the leg's shape.
 *
 * The matcher's transit corridor is 250m because sparse polylines demand it —
 * but that is a statement about the match being usable, not about the rider
 * being on a bus. On 2026-08-27 a rider biking a street 248m from a parallel
 * bus route crossed RIDING_MIN_PROGRESS and was declared aboard, which armed a
 * boarded-earlier auto-replan that threw away the bike leg they were actually
 * on. A trusted vehicle match is exempt: it is direct evidence, and it is what
 * keeps the boarded-earlier rescue working. Retention is also exempt — a rider
 * already established keeps the wide corridor, so an urban canyon does not
 * shed the fact (only the sustained off-route timer does).
 */
export const RIDING_ESTABLISH_MAX_DISTANCE_M = 100

/**
 * Rider ground speed that corroborates "I am on a moving vehicle" when nothing
 * else does. Deliberately above a brisk walk and below traffic speed: the point
 * is only to separate a rider standing at a kerb from one being carried.
 */
export const RIDING_ESTABLISH_MIN_SPEED_MPS = 3

export type RidingDecision =
  | { kind: 'none' }
  | { kind: 'set'; riding: RidingState }
  | { kind: 'markOffRoute'; riding: RidingState }
  | { kind: 'clear' }

export interface RidingDecisionInput {
  /** The leg the matcher currently favours. */
  matchedLeg: Leg | null | undefined
  nowMs: number
  /** ms the rider must be off-route before the fact is dropped. */
  offRouteClearMs: number
  prevRiding: RidingState | null
  /** The rider's own GPS ground speed, when the fix carries one. */
  riderSpeedMps: number | null
  routeMatch: RouteMatchResult
  vehicleMatch: {
    consecutiveMatches?: number
    match?: VehicleMatchResult | null
  } | null
}

function legRouteId(leg: any): string | null {
  return leg?.routeId ?? leg?.route?.gtfsId ?? leg?.route?.id ?? null
}

function legTripId(leg: any): string | null {
  return leg?.trip?.gtfsId ?? leg?.tripId ?? null
}

/** Loose headsign agreement — either side may be absent or differently cased. */
function headsignsAgree(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Is there enough evidence to assert, for the FIRST time on this trip, that the
 * rider is aboard a run that is not the one they planned?
 *
 * shouldRebindRidingTrip deliberately waves through first establishment — all
 * of its hysteresis protects *re*binds. That left the very first SET_RIDING,
 * the one that anchors everything downstream, completely unchecked. On
 * 2026-08-27 that is how a rider standing still at 6th St S was bound to the
 * INBOUND 94 (trip 1:1184013, headsign "Express / I-94 / Downtown Mpls") when
 * their leg was the outbound run (trip 1:1177858, "Downtown St Paul"). Because
 * classifyMissedBus opens with `if (riding) return null`, that one assertion
 * disabled missed-bus detection for the whole ten-minute wait.
 *
 * Claiming a DIFFERENT run than planned is a real claim — the rider may well
 * have caught an earlier bus — so it is allowed, but it now has to be
 * corroborated by something: the same headsign (an earlier run of the same
 * service), or the rider actually being carried somewhere.
 */
export function firstEstablishmentIsCorroborated(input: {
  matchedLeg: Leg | null | undefined
  riderSpeedMps: number | null
  ridingTripId: string | null
  vehicleMatch: VehicleMatchResult | null | undefined
  vehicleTrusted: boolean
}): boolean {
  const {
    matchedLeg,
    riderSpeedMps,
    ridingTripId,
    vehicleMatch,
    vehicleTrusted
  } = input
  const plannedTripId = legTripId(matchedLeg)

  // Riding the run we planned needs no extra proof; this is the normal case.
  if (!plannedTripId || !ridingTripId || ridingTripId === plannedTripId) {
    return true
  }

  if (!vehicleTrusted) return false

  const headsignAgrees = headsignsAgree(
    vehicleMatch?.tripHeadsign,
    (matchedLeg as any)?.headsign
  )
  const beingCarried =
    riderSpeedMps != null && riderSpeedMps > RIDING_ESTABLISH_MIN_SPEED_MPS

  return headsignAgrees || beingCarried
}

/**
 * Establish, refresh, mark off-route, or drop the riding fact for this tick.
 */
export function decideRiding(input: RidingDecisionInput): RidingDecision {
  const {
    matchedLeg,
    nowMs,
    offRouteClearMs,
    prevRiding,
    riderSpeedMps,
    routeMatch,
    vehicleMatch
  } = input

  const onTransit = routeMatch.isOnRoute && !!(matchedLeg as any)?.transitLeg
  if (!onTransit) {
    if (!prevRiding) return { kind: 'none' }
    if (prevRiding.offRouteSince == null) {
      return {
        kind: 'markOffRoute',
        riding: { ...prevRiding, offRouteSince: nowMs }
      }
    }
    return nowMs - prevRiding.offRouteSince > offRouteClearMs
      ? { kind: 'clear' }
      : { kind: 'none' }
  }

  const match = vehicleMatch?.match ?? null
  const vehicleTrusted =
    match?.confidence === 'confirmed' || match?.confidence === 'high'
  // A fact already held keeps the matcher's wide corridor — refreshes and the
  // offRouteSince reset must not pause just because the rider projects far
  // from a sparse shape. Only a NEW claim of aboard-ness from GPS alone has to
  // meet the tight distance.
  const gpsPlausiblyAboard =
    routeMatch.progressAlongLeg >= RIDING_MIN_PROGRESS &&
    (prevRiding != null ||
      routeMatch.distanceFromRoute <= RIDING_ESTABLISH_MAX_DISTANCE_M)
  const aboard = vehicleTrusted || gpsPlausiblyAboard
  if (!aboard) return { kind: 'none' }

  // The trip the rider is ACTUALLY on: a trusted vehicle match knows its
  // GTFS-RT trip, which outranks the planned leg's — the rider may have caught
  // an earlier run of the same route, and the boarded-earlier replan, next-stop
  // anchoring and live leg times all key off this id.
  const ridingTripId =
    (vehicleTrusted ? match?.tripId : null) ||
    legTripId(matchedLeg) ||
    prevRiding?.tripId ||
    null

  const isFirstEstablishment = !prevRiding || prevRiding.tripId == null
  if (
    isFirstEstablishment &&
    !firstEstablishmentIsCorroborated({
      matchedLeg,
      riderSpeedMps,
      ridingTripId,
      vehicleMatch: match,
      vehicleTrusted
    })
  ) {
    return { kind: 'none' }
  }

  // Rebind hysteresis: rewriting riding.tripId to a DIFFERENT trip arms the
  // boarded-earlier replan, so it needs sustained consistent evidence. On 7/29
  // a two-tick stale-feed flap onto the opposite-direction Orange Line rebound
  // the ride and cascaded into auto-replans. When a rebind is disallowed,
  // refreshes (legIndex change, offRouteSince clear) still go out with the
  // EXISTING trip/vehicle.
  const rebindAllowed = shouldRebindRidingTrip(
    prevRiding,
    ridingTripId,
    (matchedLeg as any) ?? null,
    vehicleMatch
  )
  const nextTripId = rebindAllowed ? ridingTripId : prevRiding?.tripId ?? null
  const nextVehicleId = rebindAllowed
    ? match?.vehicleId ?? prevRiding?.vehicleId ?? null
    : prevRiding?.vehicleId ?? null

  const changed =
    !prevRiding ||
    prevRiding.legIndex !== routeMatch.legIndex ||
    prevRiding.tripId !== nextTripId ||
    prevRiding.offRouteSince != null
  if (!changed) return { kind: 'none' }

  return {
    kind: 'set',
    riding: {
      boardedAt: prevRiding?.boardedAt ?? nowMs,
      headsign: (matchedLeg as any)?.headsign ?? null,
      legIndex: routeMatch.legIndex,
      offRouteSince: null,
      routeId: legRouteId(matchedLeg),
      routeShortName:
        (matchedLeg as any)?.routeShortName ??
        (matchedLeg as any)?.route?.shortName ??
        null,
      tripId: nextTripId,
      vehicleId: nextVehicleId
    }
  }
}
