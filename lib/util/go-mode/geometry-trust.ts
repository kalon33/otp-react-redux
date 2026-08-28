import type { Leg } from '@opentripplanner/types'

import { decodeLegGeometry } from './position-matching'

/**
 * Is a route match trustworthy, or was it computed blind?
 *
 * matchPositionToRoute silently skips any leg whose polyline decodes to fewer
 * than two points and matches whatever geometry remains. That is the right
 * call inside the matcher — a null match reads to callers as "no geometry" —
 * but it means a transit leg with missing geometry makes the match a lie about
 * WHERE the rider is: on 2026-08-27 the onboard flow synthesized a bus leg
 * with empty geometry (the trip fetch was failing with "Load failed"), the
 * matcher pinned the rider to the egress leg ~100m away, and five ticks of
 * frozen progress ended in a bogus "121m from route" push and a 16-point
 * progress jump — all of which self-corrected the instant the trip data
 * landed.
 *
 * So the caller assesses the match before acting on it: a match that had to
 * see THROUGH a transit leg with unusable geometry (anything in
 * [currentLegIndex … matchLegIndex]) is provisional. Walk and bike legs are
 * exempt — a zero-length transfer walk legitimately decodes to nothing, and
 * skipping it is correct, not blindness.
 *
 * Pure and geometry-derived, per the module idiom; the caller owns what to do
 * about a provisional match (hold the previous one and let the live-times
 * poll repair the geometry — see REPAIR_LEG_GEOMETRY).
 */

export interface MatchTrust {
  provisional: boolean
  reason: 'unsettled-geometry' | null
  /** Transit leg indexes in the match window whose geometry is unusable. */
  unsettledLegIndexes: number[]
}

/** A leg's polyline is usable for matching: it decodes to >= 2 points. */
export function legGeometryUsable(leg: Leg | null | undefined): boolean {
  if (!leg) return false
  return decodeLegGeometry(leg).length >= 2
}

export function assessMatchTrust(
  legs: Leg[],
  currentLegIndex: number,
  matchLegIndex: number
): MatchTrust {
  const from = Math.max(0, Math.min(currentLegIndex, matchLegIndex))
  const to = Math.min(legs.length - 1, Math.max(currentLegIndex, matchLegIndex))
  const unsettledLegIndexes: number[] = []
  for (let i = from; i <= to; i++) {
    const leg: any = legs[i]
    if (leg?.transitLeg && !legGeometryUsable(leg)) {
      unsettledLegIndexes.push(i)
    }
  }
  return unsettledLegIndexes.length
    ? { provisional: true, reason: 'unsettled-geometry', unsettledLegIndexes }
    : { provisional: false, reason: null, unsettledLegIndexes }
}
