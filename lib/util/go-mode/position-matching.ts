import { decode } from '@mapbox/polyline'
// Aliased: matchPositionToRoute below has its own local `isTransitLeg`, a
// mode-based guess used to widen the on-route threshold. The two are not
// equivalent and reconciling them is its own change, so keep the names apart.
import { isTransitLeg as legIsTransit } from '@opentripplanner/core-utils/lib/itinerary'
import type { LatLngArray, Leg } from '@opentripplanner/types'

/**
 * Calculate distance between two lat/lng points using Haversine formula
 * @returns distance in meters
 *
 * A non-finite coordinate yields Infinity, not a number. Before 8/2 a null
 * coerced to 0 and the haversine happily returned 10,267,729m — the distance
 * from Minneapolis to null island — which read as a real (if absurd) position
 * rather than as missing data. Infinity specifically, NOT NaN: every caller
 * compares with `<` or `<=`, and NaN would silently flip all of them to false.
 * Infinity makes a coordinateless vehicle lose every comparison, which is the
 * intent.
 */
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  ) {
    return Infinity
  }
  const R = 6371000 // Earth's radius in meters
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δφ = ((lat2 - lat1) * Math.PI) / 180
  const Δλ = ((lon2 - lon1) * Math.PI) / 180

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return R * c
}

/**
 * Calculate perpendicular distance from point to line segment
 */
function perpendicularDistance(
  point: LatLngArray,
  lineStart: LatLngArray,
  lineEnd: LatLngArray
): number {
  const [px, py] = point
  const [x1, y1] = lineStart
  const [x2, y2] = lineEnd

  const A = px - x1
  const B = py - y1
  const C = x2 - x1
  const D = y2 - y1

  const dot = A * C + B * D
  const lenSq = C * C + D * D
  let param = -1

  if (lenSq !== 0) {
    param = dot / lenSq
  }

  let xx, yy

  if (param < 0) {
    xx = x1
    yy = y1
  } else if (param > 1) {
    xx = x2
    yy = y2
  } else {
    xx = x1 + param * C
    yy = y1 + param * D
  }

  return calculateDistance(px, py, xx, yy)
}

/**
 * Project point onto line segment and calculate distance along segment
 * @returns Object with distance along segment (0-1) and perpendicular distance
 */
export function projectPointOntoSegment(
  point: LatLngArray,
  lineStart: LatLngArray,
  lineEnd: LatLngArray
): { alongSegment: number; perpDistance: number } {
  const [px, py] = point
  const [x1, y1] = lineStart
  const [x2, y2] = lineEnd

  const A = px - x1
  const B = py - y1
  const C = x2 - x1
  const D = y2 - y1

  const dot = A * C + B * D
  const lenSq = C * C + D * D

  let param = 0
  if (lenSq !== 0) {
    param = Math.max(0, Math.min(1, dot / lenSq))
  }

  const perpDistance = perpendicularDistance(point, lineStart, lineEnd)

  return {
    alongSegment: param,
    perpDistance
  }
}

/**
 * Decode a leg's polyline and return array of [lat, lng] coordinates
 */
export function decodeLegGeometry(leg: Leg): LatLngArray[] {
  if (!leg.legGeometry?.points) {
    return []
  }
  return decode(leg.legGeometry.points, 5) as LatLngArray[]
}

/**
 * Calculate cumulative distances along a polyline
 * @returns Array of cumulative distances in meters
 */
export function calculateCumulativeDistances(
  polyline: LatLngArray[]
): number[] {
  const distances: number[] = [0]
  let cumulative = 0

  for (let i = 1; i < polyline.length; i++) {
    const [lat1, lon1] = polyline[i - 1]
    const [lat2, lon2] = polyline[i]
    const segmentDistance = calculateDistance(lat1, lon1, lat2, lon2)
    cumulative += segmentDistance
    distances.push(cumulative)
  }

  return distances
}

export interface RouteMatchResult {
  distanceFromRoute: number
  // 0-1
  isOnRoute: boolean
  legIndex: number
  /**
   * Fix timestamp at which this projection was last ESTABLISHED — not the time
   * it was last returned. A match held by the continuity gate keeps the stamp
   * it was born with, which is what lets the gate's budget grow while a hold
   * lasts (see ContinuityGate). Stamped only when a caller supplies a gate;
   * callers that pass none get the field-for-field old result.
   */
  matchedAtMs?: number
  nearestPoint: LatLngArray
  progressAlongLeg: number
  // 0-1
  progressAlongSegment: number
  segmentIndex: number
  /**
   * Ground metres the RIDER has covered that this projection never accounted
   * for — their own displacement, less however far the projection actually
   * moved along the leg, floored at zero and carried across ticks. Near zero
   * while the projection tracks the rider; it grows only when the rider is
   * moving and the projection is not, which is the one situation in which a
   * large re-snap is owed. Set only when a caller supplies `movedSinceFixM`;
   * callers that do not get the field-for-field old result.
   */
  unaccountedPathM?: number
}

/**
 * How close two candidate projections have to be, in perpendicular metres,
 * before the choice between them stops being a measurement.
 *
 * A shape that folds back on itself puts two segments underfoot at once. The
 * strict global minimum picks between them on a sub-metre difference that is
 * pure GPS noise, and the two answers are hundreds of metres apart ALONG the
 * leg. On 2026-08-28 that produced 165 m of "progress" per second, repeatedly,
 * on a 215 m access leg with the rider's fix 0–6 m from the line (21:41:00,
 * :04, :16, :17, :20, :32; 21:43:06, :10, :12) — the rider was as on-route as
 * it is possible to be, and the projection was still inventing motion. Over
 * the whole recorded ride, MORE THAN HALF the unexplained along-leg metres
 * (5,523 of 10,123) were logged while `isOnRoute` was true, which is why no
 * amount of off-corridor suppression reaches them.
 *
 * So among candidates that are within this band of the best one — genuinely
 * equally good statements about where the rider is — prefer the one that is
 * nearest to the projection already held. This can only ever REORDER a set of
 * near-ties: a candidate that is better by more than the band still wins
 * outright, so a real correction is never blocked and nothing can be pinned
 * for longer than it takes the rider to move the width of the band.
 *
 * This generalises what used to be BACKWARD_JUMP_HYSTERESIS_M, which applied
 * the same 5 m band in the backward direction only (the 465's downtown loop,
 * 2026-08-27) and therefore let every forward flip through.
 */
export const MATCH_NEAR_TIE_M = 5

/** @deprecated Kept as the old name for the same band; prefer MATCH_NEAR_TIE_M. */
export const BACKWARD_JUMP_HYSTERESIS_M = MATCH_NEAR_TIE_M

// These corridors answer "is this match usable", nothing more. Transit shapes
// are sparse enough that a rider genuinely aboard can project 200m+ from the
// polyline, so the corridor must stay wide — but that makes isOnRoute far too
// weak to mean "plausibly aboard this vehicle". Anything deciding aboard-ness
// or off-route-ness needs its own, tighter figure (see riding.ts and
// checkRouteDeviation), derived from or reconciled with these so the matcher
// and its consumers can never disagree about the same metre.
export const MATCH_CORRIDOR_TRANSIT_M = 250
export const MATCH_CORRIDOR_ACTIVE_M = 100

/**
 * The projection may not travel faster than the rider plausibly can.
 *
 * On 2026-08-28, riding the Orange Line to the Fairgrounds and then biking, the
 * rider spent minutes at a sustained 121–133 m offset from the planned line
 * (Como Av, replanned around). A global-minimum scan has nothing to say about
 * WHEN a candidate became the nearest one, so the projection sat pinned on one
 * segment for 16–22 s and then, on a single ~14 m-accuracy fix one second after
 * the last, snapped 266 m down the leg (22:13:14Z; again 315 m at 22:15:55Z,
 * 179 m at 22:20:35Z). The same shape appears at the very start of the ride, on
 * a 215 m bike leg that folds back on itself: 165 m of "progress" in one second
 * at 21:41:04Z and 21:43:10Z, straddled by the reverse flip. That invented
 * motion is what ride-watch's two `progress-without-motion` findings fired on —
 * the rule was right and the matcher was wrong.
 *
 * BACKWARD_JUMP_HYSTERESIS_M cannot see any of this: it is a ±5 m near-tie
 * reorder, and these candidates win by more than that, most of them forward.
 *
 * So the movement a candidate implies is checked against a per-second ceiling
 * for the mode of the leg it moves along. The ceilings are deliberately far
 * above any real vehicle — this exists to reject 266 m in one second, not to
 * second-guess a bus. The Orange Line is BRT running I-35W at freeway speed
 * (~31 m/s) and Northstar tops out near 35 m/s, so transit gets 40.
 */
export const MATCH_JUMP_CEILING_WALK_MPS = 5
export const MATCH_JUMP_CEILING_BICYCLE_MPS = 15
export const MATCH_JUMP_CEILING_TRANSIT_MPS = 40

/**
 * Added to every budget. A projection legitimately slides along the shape by
 * more than the rider moves — sparse transit polylines, a segment change at a
 * bend, a couple of metres of jitter on each of the two fixes being compared.
 * Sized under MATCH_CORRIDOR_ACTIVE_M so a single slack-only step can never
 * cover a whole corridor width, and well over any observed per-fix jitter.
 */
export const MATCH_JUMP_SLACK_M = 50

/**
 * The same slack, for callers that can say how far the rider actually moved.
 *
 * MATCH_JUMP_SLACK_M has to be generous because the only other term in the
 * budget is a MODE ceiling — 15 m/s for a bicycle — which says nothing about
 * whether this particular rider moved at all. That is precisely the hole 6.5
 * fell through twice: 2026-09-01 08:56:20, a 6.9 m fix advanced the projection
 * 0.0958 -> 0.1519 of a ~1030 m leg (~53 m) at a corner where the shape doubles
 * back, and 11:10:06, a 4.3 m fix advanced it 0.000 -> 1.000 of a 1587 m leg.
 * Both sit under 50 + 15, so the ceiling never saw either.
 *
 * With the rider's own displacement in hand the slack no longer has to stand in
 * for it, so it can be half the size and still leave a moving rider several
 * times the headroom they use.
 */
export const MATCH_JUMP_SLACK_MOVED_M = 25

/**
 * How much further than the unaccounted ground the projection may travel when
 * it finally catches up.
 *
 * Displacement is a chord and the leg is a path, so the two are not the same
 * quantity: corners, a shape that doubles back, and a sparse transit polyline
 * all let honest along-leg movement exceed the straight line between fixes.
 * Doubling it is the allowance for that.
 */
export const MATCH_PATH_FACTOR = 2

/**
 * Same figure, and the same meaning, as `FIX_ACCURACY_MAX_M` in transit-trust —
 * duplicated rather than imported because transit-trust imports THIS module and
 * the cycle is not worth a shared constants file for one number. A fix that
 * cannot place the rider inside a city block is not evidence of highway-speed
 * travel, so it is held to the walking ceiling whatever the leg's mode.
 *
 * Note this gate would NOT have caught 8/28 on its own: those fixes reported
 * 3–22 m. Accuracy is the cheap half; the continuity window is load-bearing.
 */
export const MATCH_FIX_ACCURACY_TRUSTED_M = 100

/**
 * Optional continuity evidence for `matchPositionToRoute`, same shape and same
 * contract as `TransitionGate` below: supply nothing and the search behaves
 * exactly as it did before the gate existed.
 */
export type ContinuityGate = {
  /** Reported accuracy of THIS fix in metres (position.coords.accuracy). */
  accuracyM?: number | null
  /**
   * Ground metres between the PREVIOUS fix and this one. The rider's own
   * displacement is the self-calibrating half of the budget: a bus on a
   * freeway earns its own allowance, and a rider who has not moved earns
   * none. Optional — omit it and the budget is the mode ceiling alone,
   * exactly as before.
   */
  movedSinceFixM?: number | null
  /** Timestamp of THIS fix in epoch ms (position.timestamp). */
  nowMs?: number | null
  /**
   * When the held projection was established, epoch ms. Defaults to
   * `previousMatch.matchedAtMs`, which this function stamps itself, so callers
   * threading their previous match need not track it.
   */
  previousMatchMs?: number | null
}

function jumpCeilingMps(leg: Leg | undefined, accuracyM?: number | null) {
  if (
    accuracyM != null &&
    Number.isFinite(accuracyM) &&
    accuracyM > MATCH_FIX_ACCURACY_TRUSTED_M
  ) {
    return MATCH_JUMP_CEILING_WALK_MPS
  }
  switch (leg?.mode) {
    case 'WALK':
      return MATCH_JUMP_CEILING_WALK_MPS
    case 'BICYCLE':
    case 'SCOOTER':
    case 'MICROMOBILITY':
    case 'MICROMOBILITY_RENT':
      return MATCH_JUMP_CEILING_BICYCLE_MPS
    default:
      return MATCH_JUMP_CEILING_TRANSIT_MPS
  }
}

/**
 * Would accepting `winner` require the rider to have covered more ground than
 * the time since `previousMatch` was established allows?
 *
 * A first match, a caller with no clock, and a fix that arrives at or before
 * the held one (a device clock that stepped backwards) are all ungated: with no
 * elapsed time there is no budget to compare against, and rejecting on that
 * basis would strand every trip on its opening fix.
 */
function exceedsJumpBudget(
  winner: RouteMatchResult,
  winnerLegDistance: number,
  previousMatch: RouteMatchResult | null | undefined,
  legs: Leg[],
  gate: ContinuityGate,
  /**
   * Ground metres the rider has covered that the projection never accounted
   * for, this fix included. Null when the caller supplies no displacement,
   * which leaves the mode-ceiling budget untouched.
   */
  riderPathM: number | null
): boolean {
  if (previousMatch == null) return false
  // Elapsed is measured from when the held projection was ESTABLISHED, not from
  // the previous fix. That is the whole convergence story: while the gate holds
  // a match the clock keeps running against it, so the budget widens every tick
  // and a rider who genuinely moved — a tunnel, a dropped signal, a real 400 m
  // correction — is re-projected within a minute instead of being pinned to a
  // stale point forever. Nothing here can hold a match indefinitely.
  const heldSinceMs = gate.previousMatchMs ?? previousMatch.matchedAtMs
  if (gate.nowMs == null || heldSinceMs == null) return false
  const elapsedSec = (gate.nowMs - heldSinceMs) / 1000
  if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) return false

  const movedM = continuityGapM(previousMatch, winner, winnerLegDistance)

  if (riderPathM == null || !Number.isFinite(riderPathM)) {
    return (
      movedM >
      MATCH_JUMP_SLACK_M +
        jumpCeilingMps(legs[winner.legIndex], gate.accuracyM) * elapsedSec
    )
  }

  // With the rider's own ground in hand the clock drops out of the budget
  // entirely, and that is the point.
  //
  // A mode ceiling is what the rider COULD have covered in the elapsed time,
  // which means it issues licence to a rider who has not moved — it only has
  // to be waited out. Replayed against ride 3's own track, the ceiling refused
  // the 1587 m snap on the tick it arrived and then admitted 1545 m of it two
  // minutes later, on a 16 m fix, purely because 15 m/s x 122 s had grown past
  // the whole leg. Session 1.4 recorded that shape in the abstract ("a rate
  // limiter defers a jump rather than removing it"); this is what the deferral
  // costs, and it is why Session 1.9 asked for the rider's own displacement in
  // its place.
  //
  // What is left is ground: what the rider has covered that the projection
  // never accounted for, plus this fix's own step. A projection that tracks
  // the rider is licensed by the step alone and never gated; one that has sat
  // still while the rider rode earns its correction at the rate they ride, and
  // one that wants to move a kilometre on a 4 m fix gets nothing.
  return movedM > MATCH_JUMP_SLACK_MOVED_M + riderPathM * MATCH_PATH_FACTOR
}

/**
 * How far the projection would have to travel to get from `previousMatch` to
 * `candidate`, in metres — the same quantity the jump budget measures, and the
 * one the near-tie rule minimises.
 *
 * Across a leg boundary progress is not comparable, so the ground the
 * projected point itself covers stands in. An access leg and the transit leg
 * after it share an endpoint, so a real transition measures ~0 m.
 */
function continuityGapM(
  previousMatch: RouteMatchResult,
  candidate: RouteMatchResult,
  candidateLegDistance: number
): number {
  return candidate.legIndex === previousMatch.legIndex
    ? Math.abs(candidate.progressAlongLeg - previousMatch.progressAlongLeg) *
        candidateLegDistance
    : calculateDistance(
        previousMatch.nearestPoint[0],
        previousMatch.nearestPoint[1],
        candidate.nearestPoint[0],
        candidate.nearestPoint[1]
      )
}

export function matchPositionToRoute(
  currentPosition: LatLngArray,
  legs: Leg[],
  currentLegIndex = 0,
  /**
   * Last tick's match, used only to break near-ties on a shape that doubles
   * back on itself. Optional: without it the behaviour is exactly the old
   * global-minimum search.
   */
  previousMatch?: RouteMatchResult | null,
  /**
   * Fix time and accuracy, used to reject a projection that would have to
   * teleport. Optional: without it the behaviour is exactly the old search.
   */
  gate?: ContinuityGate
): RouteMatchResult | null {
  let bestMatch: RouteMatchResult | null = null
  let minDistance = Infinity
  // Length of the leg the winner was measured on, so a progress delta can be
  // turned back into metres without decoding again.
  let bestLegDistance = 0
  // Every candidate within MATCH_NEAR_TIE_M of the running best, so the
  // continuity preference below has a set to choose from. Only collected when
  // there is a previous match to be continuous with; with none, the search is
  // the plain global minimum it always was, allocation included.
  const nearTies: Array<{ legDistance: number; match: RouteMatchResult }> = []

  // Search current leg and next 2 legs for best match
  const legsToSearch = Math.min(3, legs.length - currentLegIndex)

  for (let legOffset = 0; legOffset < legsToSearch; legOffset++) {
    const legIndex = currentLegIndex + legOffset
    const leg = legs[legIndex]
    const polyline = decodeLegGeometry(leg)

    if (polyline.length < 2) continue

    const cumulativeDistances = calculateCumulativeDistances(polyline)
    const totalLegDistance = cumulativeDistances[cumulativeDistances.length - 1]

    for (let i = 0; i < polyline.length - 1; i++) {
      const start = polyline[i]
      const end = polyline[i + 1]

      const projection = projectPointOntoSegment(currentPosition, start, end)
      const perpDistance = projection.perpDistance

      const isNearTie =
        previousMatch != null && perpDistance <= minDistance + MATCH_NEAR_TIE_M
      if (perpDistance < minDistance || isNearTie) {
        // Calculate progress along this segment
        const segmentStartDistance = cumulativeDistances[i]
        const segmentEndDistance = cumulativeDistances[i + 1]
        const segmentLength = segmentEndDistance - segmentStartDistance
        const distanceAlongSegment = segmentLength * projection.alongSegment
        const totalDistanceAlongLeg =
          segmentStartDistance + distanceAlongSegment

        // Calculate nearest point on segment
        const [x1, y1] = start
        const [x2, y2] = end
        const t = projection.alongSegment
        const nearestPoint: LatLngArray = [
          x1 + t * (x2 - x1),
          y1 + t * (y2 - y1)
        ]

        // Use wider threshold for transit legs (sparser polylines)
        const isTransitLeg = leg.mode !== 'WALK' && leg.mode !== 'BICYCLE'
        const onRouteThreshold = isTransitLeg
          ? MATCH_CORRIDOR_TRANSIT_M
          : MATCH_CORRIDOR_ACTIVE_M

        const progressAlongLeg =
          totalLegDistance > 0 ? totalDistanceAlongLeg / totalLegDistance : 0

        const candidate: RouteMatchResult = {
          distanceFromRoute: perpDistance,
          isOnRoute: perpDistance < onRouteThreshold,
          legIndex,
          nearestPoint,
          progressAlongLeg,
          progressAlongSegment: projection.alongSegment,
          segmentIndex: i
        }

        if (perpDistance < minDistance) {
          minDistance = perpDistance
          bestMatch = candidate
          bestLegDistance = totalLegDistance
          // The band moved with the new best; anything it no longer covers is
          // not a tie any more.
          for (let k = nearTies.length - 1; k >= 0; k--) {
            if (
              nearTies[k].match.distanceFromRoute >
              minDistance + MATCH_NEAR_TIE_M
            ) {
              nearTies.splice(k, 1)
            }
          }
        }
        if (previousMatch != null) {
          nearTies.push({ legDistance: totalLegDistance, match: candidate })
        }
      }
    }
  }

  let winner = bestMatch
  let winnerLegDistance = bestLegDistance
  // Prefer continuity among equals. Never a null: the set always contains the
  // global minimum itself, so this can reorder preferences and nothing else. A
  // null here would read to callers as "no geometry", which is a far worse
  // answer than any projection.
  if (previousMatch != null && winner != null && nearTies.length > 1) {
    let bestGap = Infinity
    for (const tie of nearTies) {
      if (tie.match.distanceFromRoute > minDistance + MATCH_NEAR_TIE_M) continue
      const gap = continuityGapM(previousMatch, tie.match, tie.legDistance)
      if (gap < bestGap) {
        bestGap = gap
        winner = tie.match
        winnerLegDistance = tie.legDistance
      }
    }
  }
  if (!gate || !winner) return winner

  // Ground the rider has covered that the projection has not: the running
  // total carried on the held match, plus this fix's own step.
  const stepM = gate.movedSinceFixM
  const hasStep = stepM != null && Number.isFinite(stepM) && stepM >= 0
  const unaccountedM = hasStep
    ? (previousMatch?.unaccountedPathM ?? 0) + (stepM as number)
    : null

  // Held verbatim, stamp included: the previous projection is still the best
  // statement about where the rider is, and re-stamping it would reset the
  // budget and pin the rider for good. The path accumulator is the one thing
  // that does advance — it is the evidence that will eventually release the
  // hold, not part of the projection.
  if (
    exceedsJumpBudget(
      winner,
      winnerLegDistance,
      previousMatch,
      legs,
      gate,
      unaccountedM
    )
  ) {
    const held = previousMatch as RouteMatchResult
    return unaccountedM == null
      ? held
      : { ...held, unaccountedPathM: unaccountedM }
  }

  // Accepted: whatever ground the projection just covered along the leg is
  // ground it has now accounted for. A projection tracking the rider settles
  // at zero; one that is accepted every tick but barely moves keeps the
  // remainder, which is what stops a stuck-but-locally-best projection from
  // resetting its own evidence and pinning the rider for good.
  const accountedM =
    unaccountedM == null || previousMatch == null
      ? 0
      : Math.max(
          0,
          unaccountedM -
            continuityGapM(previousMatch, winner, winnerLegDistance)
        )
  const accepted = hasStep
    ? { ...winner, unaccountedPathM: accountedM }
    : winner
  return gate.nowMs == null
    ? accepted
    : { ...accepted, matchedAtMs: gate.nowMs }
}

/**
 * Check if the rider has moved on to a later leg.
 *
 * The only evidence taken is the match itself: their position is now nearest to
 * a leg further along the itinerary. Being near the *end* of the current leg is
 * deliberately not enough — waiting at a boarding stop parks you at ~100% of the
 * access leg for as long as the bus takes to arrive, which would advance a rider
 * standing on the curb onto the bus. (Matching only ever searches forward, so
 * that advance is unrecoverable.) Actual boarding is established by the riding
 * state, which wants a vehicle match or real progress along the transit leg.
 *
 * Index order alone is still not enough, because an access leg and the transit
 * leg that follows it SHARE an endpoint: a rider waiting at the boarding stop
 * sits on both polylines at once, so the matcher can honestly return the
 * transit leg while the bus is still hours away. On 2026-08-27 Go Mode started
 * on a trip whose 465 boarded at 20:17Z, and 82ms later — at 18:19Z, with the
 * rider standing at the stop — advanced onto that leg and pushed "Walk to 6th
 * St S & 2nd Ave", a stop 17km away. Since matching only ever searches forward,
 * that advance is unrecoverable without a re-plan.
 *
 * So a transit leg additionally has to be plausibly boardable: the rider is
 * already riding it, or its board time is at hand.
 */
export const TRANSIT_BOARD_EARLY_MS = 5 * 60 * 1000

export type TransitionGate = {
  /** Live board epoch for the target leg, when one is known. */
  boardEpoch?: number | null
  /** True when the riding state already places the rider on the target leg. */
  isRiding?: boolean
  nowMs?: number
  /** The leg the match wants to move to — itinerary.legs[match.legIndex]. */
  targetLeg?: Leg
}
export function shouldTransitionToNextLeg(
  match: RouteMatchResult,
  currentLegIndex: number,
  gate?: TransitionGate
): boolean {
  if (match.legIndex <= currentLegIndex) return false
  if (!gate) return true

  const { boardEpoch, isRiding, nowMs, targetLeg } = gate

  // Aboard is aboard: the riding state is the stronger fact and outranks the
  // clock, which is what lets a rider who caught an earlier run move on.
  if (isRiding) return true

  // Callers that supply no clock or no leg keep the old index-order behaviour.
  if (!targetLeg || nowMs == null) return true
  if (!legIsTransit(targetLeg)) return true

  // Prefer the live board time; a bus running late should not pull the rider
  // onto its leg on the strength of the plan alone.
  const board = Number(boardEpoch ?? targetLeg.startTime)
  if (!Number.isFinite(board)) return true

  return nowMs >= board - TRANSIT_BOARD_EARLY_MS
}
