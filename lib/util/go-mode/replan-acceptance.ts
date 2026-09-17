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
 * The first two checks come from ride 3 of 2026-09-01
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
 * A third came from 2026-08-31 (the 602 m token hop) and a fourth from
 * 2026-09-15 (an access leg that ends after the bus it feeds has gone) — each
 * is documented at the predicate that implements it.
 *
 * A rider who explicitly asked for a different trip is never gated: `accept`
 * runs on the automatic paths only. The one thing this file says about the
 * rider's own tap is `startOriginIsStale`, which refuses nothing — it reports
 * that a plan begins somewhere the rider is not, so the caller can re-plan
 * from where they are (backlog 12.13).
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

/**
 * How far from the rider a plan the RIDER THEMSELVES just tapped may start
 * before the trip re-plans from where they actually are.
 *
 * 2026-09-08 10:40:15, session `mtssjvee-mtc2dx` (backlog 12.13). The rider
 * had ridden the 10:25 Orange Line to I-35W & Lake St Station and, standing
 * there at 44.94830, -93.27424, tapped an itinerary out of the result list
 * they had left open since 10:25 at 66th St. `START_GO_MODE` installed it
 * whole: `legs[0].from` 44.8833656, -93.2953209 — **7,409 m behind them** —
 * `startTime` 10:25:00, a 9,199 m bike leg. The one progress tick it produced
 * read `currentLegProgress 100 / overallProgress 100 /
 * distanceToDestination 1022.6 m / status deviated`, all of it honest: the
 * rider genuinely was 7.4 km along a 9.2 km route they had never been on.
 * `AUTO_REPLAN_ORIGIN_MAX_M` guards the four auto-apply sites and the start
 * path had nothing — the four auto-applied starts that day measured 37 / 55 /
 * 42 / 0 m, so the gate works where it exists.
 *
 * Much larger than the automatic gate, for three reasons. It is not measuring
 * fetch latency but a plan the rider chose minutes ago, so the honest gaps it
 * must tolerate are wider. It has to clear GPS noise: the fix current at that
 * very tap was 113.5 m accurate (the next, a second later, 14 m). And the
 * onboard-flow origins this must never disturb are all sub-100 m. 500 m is
 * about a six-minute walk — far enough that no plan is wrongly called stale,
 * near enough that nothing like 7.4 km survives.
 */
export const START_ORIGIN_MAX_M = 500

/**
 * How far past its boarding an automatic replacement's access leg may end.
 *
 * Not zero: the two times being compared come from different clocks — the
 * access arrival is OTP's own estimate for a walk or ride it just planned, the
 * board time is the feed's departure — and a plan whose halves meet within a
 * few seconds is a tight connection, which is the rider's business and not
 * this gate's.
 *
 * Bounded from above by the ride that produced the rule. On 2026-09-15 the two
 * bad splices overran by 3m05s (09:57:07 access onto a 09:54:02 departure) and
 * by 49 s (09:54:51 onto the same departure). The smaller of those is the one
 * the tolerance has to refuse, so it sits well under 49 s; 15 s is about the
 * dwell a bus gives at a stop, which is the most a rider could actually
 * recover.
 */
export const AUTO_REPLAN_ACCESS_BOARD_SLACK_MS = 15000

export interface AutoReplanContext {
  /** Override for AUTO_REPLAN_ACCESS_BOARD_SLACK_MS. */
  accessBoardSlackMs?: number
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
      reason:
        | 'access-misses-board'
        | 'arrives-later'
        | 'origin-behind-rider'
        | 'token-transit-hop'
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
  const gap = originGapMeters(candidate, position)
  return gap != null && gap > AUTO_REPLAN_ORIGIN_MAX_M
}

/**
 * How far the rider is from the point an itinerary means to start at, in
 * metres — or null when the question does not arise.
 *
 * Null for a plan whose FIRST leg is transit: that plan starts at a stop,
 * which is where it means to start and not where the rider is standing. Null
 * too when the leg carries no coordinates. Both are "no answer", never "zero":
 * a caller must not read a missing measurement as a plan that starts underfoot.
 */
export function originGapMeters(
  itinerary: Itinerary | null | undefined,
  position: [number, number] | null | undefined
): number | null {
  if (!itinerary || !position) return null
  const leg = (itinerary.legs || [])[0] as Leg | undefined
  if (!leg || leg.transitLeg) return null
  const from = leg.from
  if (from?.lat == null || from?.lon == null) return null
  return calculateDistance(
    position[0],
    position[1],
    Number(from.lat),
    Number(from.lon)
  )
}

/**
 * Does the plan just installed begin somewhere the rider is not — far enough
 * that the trip should be re-planned from their actual position?
 *
 * Asked on the START path, where nothing else asks (12.13). It is deliberately
 * NOT the automatic gate: the answer here is to recover, never to refuse the
 * rider's tap, so the threshold is `START_ORIGIN_MAX_M` and a true answer is
 * an instruction to re-plan rather than a veto.
 *
 * `accuracyM` widens the threshold when the fix itself is worse than it: a
 * plan cannot be called stale by a fix that cannot locate the rider to within
 * the distance being measured. Doubling is the usual reading of a 68 %
 * accuracy radius as a bound; at the 113.5 m fix of the 09-08 tap it yields
 * 227 m, so the 500 m floor still governs and only a genuinely broken fix
 * moves the line.
 *
 * `riding` is the same escape the automatic gate keeps: aboard a vehicle, leg 0
 * is the bus the rider is sitting on and its `from` is the stop they boarded
 * at, which can be kilometres behind them by design.
 */
export function startOriginIsStale({
  accuracyM,
  itinerary,
  position,
  riding
}: {
  /** The fix's own accuracy radius in metres, when known. */
  accuracyM?: number | null
  itinerary: Itinerary | null | undefined
  /** The rider's last fix, as [lat, lon]. Null answers false. */
  position: [number, number] | null | undefined
  /** True when the rider is verifiably aboard a vehicle. */
  riding?: boolean
}): boolean {
  if (riding) return false
  const gap = originGapMeters(itinerary, position)
  if (gap == null) return false
  const floor =
    accuracyM != null && Number.isFinite(accuracyM) && accuracyM > 0
      ? Math.max(START_ORIGIN_MAX_M, accuracyM * 2)
      : START_ORIGIN_MAX_M
  return gap > floor
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
 * By how long does this itinerary's access chain overrun the boarding it feeds?
 *
 * Positive means the plan has the rider reaching the stop after the vehicle
 * has left. Null means the question does not arise: no transit leg (an
 * all-bike plan has nothing to miss), no non-transit leg before the first
 * transit one (the plan starts at a stop, so it starts where it means to), or
 * times that are not numbers.
 *
 * "Last non-transit leg before the first transit leg" is exactly what
 * `spliceAccessOntoItinerary` writes: OTP returns an access plan as
 * walk -> bike -> walk as often as a single leg, and it is the END of that
 * chain that has to meet the bus.
 */
export function accessBoardOverrunMs(
  itinerary: Itinerary | null | undefined
): number | null {
  const legs = (itinerary?.legs || []) as Leg[]
  const boardIndex = legs.findIndex((leg) => leg.transitLeg)
  if (boardIndex <= 0) return null
  const access = legs[boardIndex - 1]
  if (!access || access.transitLeg) return null
  const accessEnd = Number(access.endTime)
  const boardStart = Number(legs[boardIndex].startTime)
  if (!Number.isFinite(accessEnd) || !Number.isFinite(boardStart)) return null
  if (accessEnd <= 0 || boardStart <= 0) return null
  return accessEnd - boardStart
}

/**
 * Does this candidate hand the rider a trip they cannot physically start?
 *
 * 2026-09-15, backlog 16.2. Two spliced plans were auto-applied whose opening
 * bike leg ended after the bus it fed had gone — 09:43:37 installed a leg
 * ending 09:57:07 onto a 09:54:02 METRO Orange Line departure (3m05s), and
 * 09:49:39 repeated it at 49 s. The rider, ~345 m from that stop and walking,
 * was shown "you will miss the bus" for ten minutes and then boarded it at
 * 09:52:20.
 *
 * Nothing upstream could catch it. `spliceAccessOntoItinerary` deliberately
 * does not clamp the access end to the board time, so that the itinerary
 * states the truth rather than a fiction, and defers to the missed-bus
 * machinery — which measures the BUS against the stop and therefore cannot
 * speak until the bus has actually left. The three checks that ran here looked
 * at the unchanged suffix's `endTime` (so arrival was identical), at the first
 * leg's origin (75 m, fine), and at token hops. None of them looks INSIDE the
 * itinerary, which is where this defect lives.
 *
 * Two escapes, both meaning "refusing this is not an improvement":
 *
 * - `currentPlanIsDead` — the rider has already missed their bus and needs A
 *   plan; the same reasoning as `addsATokenHopTo`.
 * - The plan in hand already overruns its own boarding by more than the
 *   tolerance. Then the candidate is not a regression, and refusing it would
 *   pin the rider to the older infeasible plan forever.
 */
function accessMissesBoard(
  candidate: Itinerary,
  current: Itinerary | null | undefined,
  context: AutoReplanContext
): boolean {
  if (context.currentPlanIsDead) return false
  const slack = context.accessBoardSlackMs ?? AUTO_REPLAN_ACCESS_BOARD_SLACK_MS
  const overrun = accessBoardOverrunMs(candidate)
  if (overrun == null || overrun <= slack) return false
  const currentOverrun = accessBoardOverrunMs(current)
  return !(currentOverrun != null && currentOverrun > slack)
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

  // 4. Feasibility: the access chain has to end before the bus it feeds leaves.
  if (accessMissesBoard(candidate, current, context)) {
    return { accept: false, reason: 'access-misses-board' }
  }

  return { accept: true }
}
