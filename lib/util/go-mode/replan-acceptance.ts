import type { Itinerary, Leg } from '@opentripplanner/types'

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
}

export type AutoReplanVerdict =
  | { accept: true }
  | { accept: false; reason: 'arrives-later' | 'origin-behind-rider' }

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

  return { accept: true }
}
