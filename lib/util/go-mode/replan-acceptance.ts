import type { Itinerary, Leg } from '@opentripplanner/types'

import {
  hasTokenTransitHop,
  signatureWithoutLastTransitLeg,
  TOKEN_TRANSIT_HOP_METERS,
  TOKEN_TRANSIT_HOP_TOLERANCE_MS,
  transitRouteSignature
} from '../itinerary'

import { calculateDistance } from './position-matching'

/**
 * The last gate before an AUTOMATIC itinerary replacement reaches the rider.
 *
 * Every auto-apply path — missed-bus (`applyAutoReroute`), boarded-earlier
 * (`replanFromAboard`), and both halves of the quiet access replan (scoped
 * splice and full-trip fallback) — ends in `beginGoMode(candidate)`. Each of
 * them had its own idea of "good enough": the same-route filter, the
 * fastest-by-duration sort, the identical-signature guard. None of them ever
 * compared the replacement with the plan it was replacing, so a plan that was
 * worse than the one in hand was accepted as readily as one that was better.
 *
 * Two things are checked here, and both come from ride 3 of 2026-09-01
 * (`ride-1048-orange-bike.json`), whose closing bike leg took three
 * replacements in 83 seconds:
 *
 * 1. **Arrival.** The three plans arrived 16:11:33, 16:12:04 and 16:15:11
 *    against an original 16:12:57 — the remaining trip getting LONGER while the
 *    rider closed on home, each swap applied with no rider action. The rider's
 *    standing rule (`feedback_no_forced_route_changes`) is that an automatic
 *    update keeps their trip; arriving later than the plan they already have is
 *    not an update, it is a downgrade.
 *
 * 2. **Origin.** The 16:09:02 replacement was planned from a fix taken 13 s
 *    earlier and applied when the rider was already 91 m past its first leg's
 *    start, riding away from it at 7.7 m/s. The projection then did the only
 *    honest thing available: it pinned to the start of a polyline the rider was
 *    never on — `progressAlongLeg` 0.0000, `segmentIndex` 0, and
 *    `distanceFromRoute` climbing 91 → 335 m until the next swap. That is the
 *    whole of the "route match not rebuilt on swap" symptom, and it is not a
 *    stale cache (the reducer nulls `routeMatch` on `START_GO_MODE`, and leg
 *    polylines are decoded fresh on every tick) — it is a plan that begins
 *    somewhere the rider has already left.
 *
 * A rider who explicitly asked for a different trip is never gated: this runs
 * on the automatic paths only.
 */

/**
 * How much later than the plan in hand an automatic replacement may arrive.
 *
 * Not zero, because a re-plan issued seconds after the last one legitimately
 * loses a few seconds to schedule granularity and to live-time jitter, and
 * refusing every such plan would freeze a trip that genuinely needs updating.
 * Not generous either: on the ride above, 60 s admits the 16:12:04 plan (+31 s,
 * and the origin check catches that one) and refuses the 16:15:11 one (+187 s),
 * which is the one that mattered.
 */
export const AUTO_REPLAN_ARRIVAL_SLACK_MS = 60000

/**
 * How far from the rider an automatic replacement's first leg may start.
 *
 * The gap is the fetch's own latency made visible: the plan is anchored to the
 * fix that was current when the request went out, and the rider keeps moving
 * while OTP answers. 75 m is roughly ten seconds of cycling and comfortably
 * over the 25 m and 18 m gaps of the two swaps on that ride that were honest
 * statements about where the rider was; the one that was not measured 91 m.
 */
export const AUTO_REPLAN_ORIGIN_MAX_M = 75

export interface AutoReplanContext {
  /**
   * Set when the current plan is already unachievable, so there is no arrival
   * to defend: the rider missed the bus it was built around. Origin is still
   * checked.
   */
  currentPlanIsDead?: boolean
  /** The rider's last fix, as [lat, lon]. Null skips the origin check. */
  position?: [number, number] | null
  /**
   * True when the rider is verifiably aboard a vehicle. An aboard replan's
   * first leg IS the bus they are sitting on, whose `from` is the stop they
   * boarded at and can be kilometres behind them — the origin check has
   * nothing to say about it.
   */
  riding?: boolean
  /** Override for TOKEN_TRANSIT_HOP_METERS (config itinerary.tokenTransitHopMeters). */
  tokenHopMaxMeters?: number
  /** Override for TOKEN_TRANSIT_HOP_TOLERANCE_MS. */
  tokenHopToleranceMs?: number
}

export type AutoReplanVerdict =
  | { accept: true }
  | {
      accept: false
      reason: 'arrives-later' | 'origin-behind-rider' | 'token-transit-hop'
    }

function arrivalMs(itinerary: Itinerary | null | undefined): number | null {
  const end = Number(itinerary?.endTime)
  return Number.isFinite(end) && end > 0 ? end : null
}

/**
 * Does this replacement begin somewhere the rider has already left?
 *
 * Only asked of a plan whose first leg is the rider's own legs or wheels: a
 * plan that starts on a transit leg starts at a stop, which is where the plan
 * means it to start and not where the rider is standing.
 */
function originIsBehindRider(
  candidate: Itinerary,
  position: [number, number]
): boolean {
  const leg = (candidate.legs || [])[0] as Leg | undefined
  if (!leg || leg.transitLeg) return false
  const from = leg.from
  if (from?.lat == null || from?.lon == null) return false
  return (
    calculateDistance(
      position[0],
      position[1],
      Number(from.lat),
      Number(from.lon)
    ) > AUTO_REPLAN_ORIGIN_MAX_M
  )
}

/**
 * The route id of an itinerary's FIRST transit leg, read the way
 * pickSameRouteReroute (util/state) reads it — same accessor, so "boards the
 * route the rider chose" means the same thing on both sides of the swap.
 */
function firstTransitRouteId(itinerary: Itinerary): string | null {
  const leg = transitLegs(itinerary)[0] as any
  return leg?.route?.gtfsId || leg?.route?.id || leg?.routeId || null
}

/** The itinerary's transit legs, in order. Null-tolerant: an auto-replan
 * candidate can arrive with no legs at all. */
function transitLegs(itinerary: Itinerary): Leg[] {
  return (itinerary.legs || []).filter((leg) => leg.transitLeg)
}

/**
 * Is `other` the same journey as `itinerary` minus its closing token hop, and
 * does it land soon enough to be the better answer?
 */
function isHopFreeSiblingOf(
  other: Itinerary,
  itinerary: Itinerary,
  toleranceMs: number
): boolean {
  if (other === itinerary) return false
  if (
    transitRouteSignature(other) !== signatureWithoutLastTransitLeg(itinerary)
  )
    return false
  const otherEnd = Number(other.endTime)
  const end = Number(itinerary.endTime)
  if (!Number.isFinite(otherEnd) || !Number.isFinite(end)) return false
  return otherEnd <= end + toleranceMs
}

/**
 * The reroute half of the 602 m bus leg.
 *
 * `demoteTokenTransitHops` (util/itinerary) reorders what the rider is SHOWN.
 * It has nothing to say about an automatic swap, and the leg the rider caught
 * on 2026-08-31 — board 98th St Gate C, ride the 539 **602 m** to 98th &
 * Dupont, then cycle 1743 m home — survived four replans precisely there:
 * `keepRouteId` pins the route they chose, the picker takes the earliest
 * departure on it, and nothing ever asked whether the leg being kept was worth
 * keeping. The same OTP response carried `Orange Line > bike 3970 m`, the same
 * trip minus the hop, arriving 3m05s later.
 *
 * So: given the candidate a picker chose and the pool it chose from, hand back
 * the hop-free version of that journey when the pool contains one. Never a
 * different trip — same transit shape minus the final hop, arriving within
 * `toleranceMs`. `requireRouteId` keeps the rider's route: a sibling that does
 * not board it is not offered, so an itinerary whose token hop IS its only
 * transit leg is left exactly as it was rather than silently downgraded to
 * biking the whole way.
 */
export function pickHopFreeSibling<T extends Itinerary>(
  chosen: T | null | undefined,
  alternatives: T[] | null | undefined,
  {
    maxHopMeters = TOKEN_TRANSIT_HOP_METERS,
    requireRouteId = null,
    toleranceMs = TOKEN_TRANSIT_HOP_TOLERANCE_MS
  }: {
    maxHopMeters?: number
    requireRouteId?: string | null
    toleranceMs?: number
  } = {}
): T | null {
  if (!chosen) return chosen ?? null
  if (!hasTokenTransitHop(chosen, maxHopMeters)) return chosen
  const siblings = (alternatives || []).filter(
    (other) =>
      isHopFreeSiblingOf(other, chosen, toleranceMs) &&
      (!requireRouteId || firstTransitRouteId(other) === requireRouteId)
  )
  if (!siblings.length) return chosen
  // Earliest arrival among them — the same metric the demotion uses to decide
  // the hop bought the rider nothing.
  return siblings.reduce((best, other) =>
    Number(other.endTime) < Number(best.endTime) ? other : best
  )
}

/**
 * Would applying this candidate ADD a token hop to the trip the rider already
 * has — the same journey, plus a closing bus leg that buys them nothing?
 *
 * The 08-31 hop arrived three minutes EARLIER than its hop-free sibling, so
 * acceptAutoReplan's arrival check waves it straight through: arriving sooner
 * is exactly what a 602 m ride between two bike legs buys, and it is not worth
 * having.
 *
 * Answers false when the current plan is dead — a rider who has missed their
 * bus needs A plan, and refusing this one leaves them with none.
 */
function addsATokenHopTo(
  candidate: Itinerary,
  current: Itinerary | null | undefined,
  context: AutoReplanContext
): boolean {
  if (context.currentPlanIsDead || !current) return false
  return (
    hasTokenTransitHop(
      candidate,
      context.tokenHopMaxMeters ?? TOKEN_TRANSIT_HOP_METERS
    ) &&
    isHopFreeSiblingOf(
      current,
      candidate,
      context.tokenHopToleranceMs ?? TOKEN_TRANSIT_HOP_TOLERANCE_MS
    )
  )
}

/**
 * May this automatic replacement be applied?
 *
 * Deliberately fails OPEN on missing data — no arrival on either side, no
 * position, no legs — because the alternative is a trip that can never be
 * updated. Every rejection names itself so the caller can log it and so the
 * retry bookkeeping (`setRerouteResult(null)` / the quiet-replan miss streak)
 * stays honest about why nothing changed.
 */
export function acceptAutoReplan(
  candidate: Itinerary | null | undefined,
  current: Itinerary | null | undefined,
  context: AutoReplanContext = {}
): AutoReplanVerdict {
  if (!candidate) return { accept: true }

  // 1. Arrival: never trade the plan in hand for a later one.
  const candidateArrival = arrivalMs(candidate)
  const currentArrival = arrivalMs(current)
  if (
    !context.currentPlanIsDead &&
    candidateArrival != null &&
    currentArrival != null &&
    candidateArrival > currentArrival + AUTO_REPLAN_ARRIVAL_SLACK_MS
  ) {
    return { accept: false, reason: 'arrives-later' }
  }

  // 2. Origin: the plan has to start where the rider actually is.
  if (
    !context.riding &&
    context.position &&
    originIsBehindRider(candidate, context.position)
  ) {
    return { accept: false, reason: 'origin-behind-rider' }
  }

  // 3. Token hop: never swap the plan in hand for the same journey PLUS a
  // pointless closing bus leg.
  if (addsATokenHopTo(candidate, current, context)) {
    return { accept: false, reason: 'token-transit-hop' }
  }

  return { accept: true }
}
