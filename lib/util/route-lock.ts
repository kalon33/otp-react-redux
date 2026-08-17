// @ts-expect-error string-similarity ships no types
import { compareTwoStrings } from 'string-similarity'

import { getLegRouteId } from './go-mode/departure-anchor'
import { isFilterMatch } from './state'

/**
 * "Ride this route and nothing else, bike the rest."
 *
 * This OTP's plan() has no include-style route filter — `whiteListed` and
 * `preferred` route *restriction* don't exist on it, and `preferred` alone is
 * only a 900s bias. So a lock is expressed the only way the graph allows:
 * ban every OTHER route. With ~150 routes in the Twin Cities graph that's an
 * ~800-character `banned.routes` string, which OTP takes without complaint.
 */
export interface RouteLock {
  /** OTP route id, feed-prefixed: "1:18". */
  id: string
  /** What to call it in the UI: "18", "METRO Orange Line". */
  label: string
}

/** The minimum a route needs for us to lock onto it. */
export interface LockableRoute {
  id?: string
  longName?: string | null
  shortName?: string | null
  sortOrder?: number | null
}

/**
 * Bike to the route, ride it, bike from it. Naming a single route only makes
 * sense with a personal vehicle filling both ends, and pinning modes here also
 * keeps routingQuery on its single-combination path (apiV2) instead of fanning
 * out walk-access and bike-only variants of the same locked search.
 */
export const ROUTE_LOCK_MODES = [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }]

/**
 * How reluctant to pedal a locked search must be, at minimum.
 *
 * Measured against the live graph on one Bloomington -> downtown query: at low
 * bike reluctance the planner pedals almost the whole way and reduces the named
 * route to a token hop (732m of the 18 at 0.1), because pedalling is cheap next
 * to waiting.
 *
 * 5 was the original floor and is NOT enough. The itineraries that ride the
 * route properly do exist at 5, but they rank below the ones that pedal past
 * it, so they fall outside the numItineraries: 10 the app asks for and never
 * reach the rider. That makes the lock look broken only sometimes — it depends
 * on where the realtime feed has the buses at that second. Measured on the live
 * graph, same query, minutes apart: 23:26 rel=5 -> best 471m ridden (and 13.2km
 * at rel=10); 23:31 rel=5 -> 13.2km. Same at numItineraries: 20, rel=5 -> 13.2km,
 * which is what identifies it as ranking truncation rather than routing.
 *
 * 10 is the value verified to hold in the failing moment. Values between 6 and 9
 * were only ever sampled while the query was already healthy, so they are
 * untested against the condition that matters.
 */
export const ROUTE_LOCK_MIN_BIKE_RELUCTANCE = 10

/**
 * The rider's levers, adjusted so the locked route can carry the trip.
 *
 * This is the one place a lock overrides what the rider said, and only in one
 * direction: naming a route is a request to *ride* it, so a low bike reluctance
 * (which "I'll bike to the 18" reliably reads as) is raised to the floor above.
 * Nothing is lost by it — OTP still returns the bike-the-whole-way itinerary
 * alongside, and the results list keeps it.
 */
export function withRouteLockPrefs(
  prefs?: Record<string, number>
): Record<string, number> {
  return {
    ...prefs,
    bikeReluctance: Math.max(
      prefs?.bikeReluctance ?? 0,
      ROUTE_LOCK_MIN_BIKE_RELUCTANCE
    )
  }
}

/** What the rider calls this route. */
export function routeLockLabel(route: LockableRoute): string {
  return route.shortName || route.longName || route.id || ''
}

/**
 * Every route id EXCEPT the one being kept, comma-joined for `banned.routes`.
 *
 * Must be built from the full OTP route index — the graph carries more than one
 * feed (Metro Transit plus the suburban operators), and any route missing from
 * this list stays legal for the planner to use.
 */
export function buildBannedRoutes(
  routes: Record<string, LockableRoute> | undefined,
  keepId: string
): string {
  return Object.keys(routes || {})
    .filter((id) => id !== keepId)
    .join(',')
}

/**
 * Resolve what the rider typed or said ("18", "orange line") to one route.
 *
 * An exact short-name match always wins — riders name numbered routes far more
 * often than anything else, and "18" must never fuzzy-match "118". Otherwise
 * fall back to the route viewer's own matcher and, among its hits, take the
 * closest by string similarity so a multi-way match is decided the same way
 * every time. Returns null when nothing matches, which the caller must report:
 * silently planning without the lock would answer a question nobody asked.
 */
export function resolveRouteLock(
  routes: Record<string, LockableRoute> | undefined,
  text: string
): RouteLock | null {
  const query = (text || '').trim()
  if (!query) return null

  const all = Object.entries(routes || {}).map(([id, route]) => ({
    ...route,
    id: route.id || id
  }))
  const normalized = query.toLowerCase()

  const exact = all.filter(
    (route) =>
      route.shortName?.toLowerCase() === normalized ||
      route.longName?.toLowerCase() === normalized
  )
  const candidates = exact.length
    ? exact
    : all.filter(
        (route) =>
          (route.shortName && isFilterMatch(route.shortName, query)) ||
          (route.longName && isFilterMatch(route.longName, query))
      )
  if (!candidates.length) return null

  // Containing what the rider actually said beats merely looking like it:
  // "Orange Line" is METRO Orange Line, not the Orange LINK, however similar
  // those two names read to a character-bigram comparison.
  const nameScore = (name?: string | null) => {
    const lower = name?.toLowerCase() || ''
    if (!lower) return 0
    return (
      (lower.includes(normalized) ? 1 : 0) +
      compareTwoStrings(normalized, lower)
    )
  }
  const score = (route: LockableRoute) =>
    Math.max(nameScore(route.shortName), nameScore(route.longName))
  const best = candidates.reduce((winner, route) =>
    score(route) > score(winner) ? route : winner
  )
  return { id: best.id as string, label: routeLockLabel(best) }
}

/**
 * Does this itinerary actually ride the locked route? OTP answers a locked
 * search with the bike-the-whole-way option too, so the results list has to be
 * able to tell the two apart rather than presenting a bike ride as a bus trip.
 */
export function itineraryUsesRoute(
  itinerary: { legs?: Array<unknown> } | null | undefined,
  routeId: string
): boolean {
  return !!itinerary?.legs?.some(
    (leg) => getLegRouteId(leg as never) === routeId
  )
}
