import type { Itinerary } from '@opentripplanner/types'

/**
 * Street modes that need a vehicle the rider has to have with them. Walking
 * needs nothing, and transit modes are the route rule's business (keepRouteId),
 * not this one's.
 */
const VEHICLE_MODES = new Set(['BICYCLE', 'CAR', 'SCOOTER'])

type PlanMode = { mode: string; qualifier?: string }

/**
 * The mode set for an AUTOMATIC re-plan of `itinerary`: the search's modes,
 * less every vehicle mode the itinerary does not already use.
 *
 * Backlog 75.15 (chaos C4, 2026-10-29): a missed-bus auto-update for a rider
 * WALKING 244 m to the 18 at Nicollet & 46th installed "bike 21 min (5.3 km) to
 * Franklin Ave for the 12:21 18". The route was kept (keepRouteId 1:18); the
 * mode was not, because every Go Mode background plan takes its modes from the
 * search (`getBasePlanParts` -> `currentQuery.modes` or the enabled mode
 * buttons), and the default buttons are "Transit, Bike" — so OTP was free to
 * answer a walk trip with bike access. The rider's rule is that an automatic
 * update keeps the route AND the mode they chose; another mode only ever
 * comes from the explicit reroute button. So a walk + transit trip re-plans
 * walk + transit, and bike stays in the set only when the trip already has a
 * bike leg (the rider has the bike with them).
 *
 * Only removes. A vehicle mode the itinerary uses but the search no longer
 * offers is not put back: that is a search the rider changed, and widening it
 * is not an automatic update's call either. An empty result (a bike-only
 * search behind a walk-only trip) falls back to walking, never to nothing,
 * which OTP would read as its own defaults.
 */
export function inheritItineraryModes<M extends PlanMode>(
  modes: M[] | null | undefined,
  itinerary: Itinerary | null | undefined
): M[] | PlanMode[] | null | undefined {
  const legs = itinerary?.legs
  if (!Array.isArray(modes) || !Array.isArray(legs) || legs.length === 0) {
    return modes
  }
  const used = new Set(legs.map((leg) => leg?.mode))
  const kept = modes.filter(
    (m) => !(m && VEHICLE_MODES.has(m.mode) && !used.has(m.mode))
  )
  if (kept.length === modes.length) return modes
  return kept.length > 0 ? kept : [{ mode: 'WALK' }]
}
