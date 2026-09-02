// @ts-expect-error string-similarity ships no types
import { compareTwoStrings } from 'string-similarity'

import { getLegRouteId } from './go-mode/departure-anchor'
import { isFilterMatch } from './state'

/**
 * "Ride these routes and nothing else, bike the rest" — or "start me on one of
 * these and then do what you like".
 *
 * This OTP's plan() has no include-style route filter — `whiteListed` and
 * `preferred` route *restriction* don't exist on it, and `preferred` alone is
 * only a 900s bias. So a whole-trip lock is expressed the only way the graph
 * allows: ban every OTHER route. With ~150 routes in the Twin Cities graph
 * that's an ~800-character `banned.routes` string, which OTP takes without
 * complaint, and banning the complement of a SET costs exactly the same as
 * banning the complement of one (rider ask #46).
 *
 * A *starting* route (rider ask #45) is a different shape and a ban list cannot
 * express it: the rider wants the first vehicle pinned and everything after it
 * free, so banning the complement would also forbid the connections they just
 * said were fine. Nothing on this server expresses it either — `startTransitStopId`
 * is documented on the live schema as "has currently no effect", and there is no
 * first-leg route argument — so it is a soft `preferred` bias on the query plus
 * a post-filter over the results (see `itineraryStartsOnRoute`).
 */

/** One route the rider named. */
export interface LockedRoute {
  /** OTP route id, feed-prefixed: "1:18". */
  id: string
  /** What to call it in the UI: "18", "METRO Orange Line". */
  label: string
}

/**
 * How a named route constrains the trip.
 *
 * - `only`: ride nothing but these routes, bike the rest (the original lock).
 * - `starting`: the FIRST transit leg must be one of these; the rest is free.
 */
export type RouteLockScope = 'only' | 'starting'

/** The rider's route selection as it sits on `currentQuery.routeLock`. */
export interface RouteLock {
  routes: LockedRoute[]
  scope: RouteLockScope
}

/** The ids in a lock, in the order the rider picked them. */
export function routeLockIds(lock?: RouteLock | null): string[] {
  return (lock?.routes || []).map((route) => route.id).filter(Boolean)
}

/** The labels in a lock, for copy that has to name them in one breath. */
export function routeLockLabels(lock?: RouteLock | null): string[] {
  return (lock?.routes || []).map((route) => route.label)
}

/**
 * The lock's routes as one comma-joined phrase ("18, METRO Orange Line").
 * Used where a message takes a single {route} value; the chips render one
 * chip per route instead.
 */
export function routeLockText(lock?: RouteLock | null): string {
  return routeLockLabels(lock).join(', ')
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
 * Every route id EXCEPT the ones being kept, comma-joined for `banned.routes`.
 *
 * Must be built from the full OTP route index — the graph carries more than one
 * feed (Metro Transit plus the suburban operators), and any route missing from
 * this list stays legal for the planner to use.
 *
 * Takes one id or a set of them. Keeping a set is the whole of rider ask #46:
 * the complement is still one string and OTP still takes it, so "only the 18
 * and the Orange Line" costs the same query as "only the 18". Passing an empty
 * set would ban the entire graph, which is never what anyone meant, so it
 * returns '' (no ban) instead.
 */
export function buildBannedRoutes(
  routes: Record<string, LockableRoute> | undefined,
  keep: string | string[]
): string {
  const kept = new Set((Array.isArray(keep) ? keep : [keep]).filter(Boolean))
  if (kept.size === 0) return ''
  return Object.keys(routes || {})
    .filter((id) => !kept.has(id))
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
): LockedRoute | null {
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
 * Does this itinerary actually ride one of the locked routes? OTP answers a
 * locked search with the bike-the-whole-way option too, so the results list has
 * to be able to tell the two apart rather than presenting a bike ride as a bus
 * trip. Takes one id or a set of them.
 */
export function itineraryUsesRoute(
  itinerary: { legs?: Array<unknown> } | null | undefined,
  route: string | string[]
): boolean {
  const wanted = new Set(
    (Array.isArray(route) ? route : [route]).filter(Boolean)
  )
  if (wanted.size === 0) return false
  return !!itinerary?.legs?.some((leg) => {
    const id = getLegRouteId(leg as never)
    return !!id && wanted.has(id)
  })
}

/**
 * The route the itinerary's FIRST transit leg rides, or null when it never
 * boards anything (a bike-the-whole-way answer).
 *
 * "First" is leg order, not the order OTP happened to return: legs come back in
 * travel order and `getLegRouteId` is null for every street leg, so the first
 * non-null one is the vehicle the rider boards first.
 */
export function firstTransitRouteId(
  itinerary: { legs?: Array<unknown> } | null | undefined
): string | null {
  for (const leg of itinerary?.legs || []) {
    const id = getLegRouteId(leg as never)
    if (id) return id
  }
  return null
}

/**
 * Rider ask #45: "use as starting route", not "use only this route".
 *
 * True when the first vehicle the itinerary boards is one of the named routes.
 * A trip that boards nothing at all is NOT a match — the rider asked to start
 * on a bus, and a bike-the-whole-way answer starts on no bus.
 */
export function itineraryStartsOnRoute(
  itinerary: { legs?: Array<unknown> } | null | undefined,
  route: string | string[]
): boolean {
  const wanted = new Set(
    (Array.isArray(route) ? route : [route]).filter(Boolean)
  )
  if (wanted.size === 0) return false
  const first = firstTransitRouteId(itinerary)
  return !!first && wanted.has(first)
}

/**
 * Does this itinerary satisfy the lock, whichever shape it is?
 *
 * The one place the two scopes are told apart, so the results list and any
 * future consumer cannot drift on what "complies" means.
 */
export function itineraryMatchesLock(
  itinerary: { legs?: Array<unknown> } | null | undefined,
  lock?: RouteLock | null
): boolean {
  const ids = routeLockIds(lock)
  if (ids.length === 0) return true
  return lock?.scope === 'starting'
    ? itineraryStartsOnRoute(itinerary, ids)
    : itineraryUsesRoute(itinerary, ids)
}

/**
 * Order (or narrow) a results list to honour the rider's named routes.
 *
 * Two different treatments, because the two asks are different:
 *
 * - `only` (#46): a stable PARTITION — compliant trips first, the rest kept
 *   below and labelled in the row. OTP answers a locked search with the
 *   bike-the-whole-way option too, and sometimes that really is the better
 *   trip, so nothing is thrown away.
 * - `starting` (#45): a FILTER, because "my route is one row in forty" is the
 *   complaint. It only ever narrows, and if the constraint would empty the list
 *   the original list is returned untouched — a truthful list whose rows each
 *   say "doesn't start on X" beats a blank screen.
 *
 * Returns the input array itself when there is no lock, so callers can use the
 * result unconditionally.
 */
export function applyRouteLockToItineraries<
  T extends { legs?: Array<unknown> }
>(itineraries: T[], lock?: RouteLock | null): T[] {
  if (routeLockIds(lock).length === 0) return itineraries
  const matches = (itinerary: T) => itineraryMatchesLock(itinerary, lock)
  const kept = itineraries.filter(matches)
  if (lock?.scope === 'starting') {
    return kept.length > 0 ? kept : itineraries
  }
  return [...kept, ...itineraries.filter((itin) => !matches(itin))]
}
