import type { Itinerary } from '@opentripplanner/types'

import { itinerarySignature } from './reroute-candidates'

/**
 * Whether a live-times refresh that read the plan with signature `startSig`
 * may still write into the store (backlog 72.1).
 *
 * refreshLiveLegTimes awaits one trip query per transit leg and stores its
 * results by leg INDEX. On 2026-10-26 12:14 a plan swap landed while the first
 * plan's queries were in flight, and their answers — the 12:53 D Line's times
 * — were written onto the second plan's legs: "32 min late" for an on-time bus.
 *
 * Compared by signature (trip ids, routes, stop names), not object identity:
 * REPAIR_LEG_GEOMETRY replaces the itinerary object mid-refresh without
 * changing the plan, and that refresh must still publish. Not a trip-id check
 * on the stored times either — those deliberately carry `riding.tripId` when
 * the rider is aboard an earlier bus than the plan's.
 */
export function liveTimesPlanStillCurrent(
  goMode:
    | { activeItinerary?: Itinerary | null; isActive?: boolean }
    | null
    | undefined,
  startSig: string
): boolean {
  if (!goMode?.isActive || !goMode.activeItinerary) return false
  return itinerarySignature(goMode.activeItinerary) === startSig
}
