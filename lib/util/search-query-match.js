import isEqual from 'lodash.isequal'

import { canonicalStopStays, queryStops } from './multi-stop'

/**
 * Does a query still ask for the search the app already holds? Two callers
 * share this so they cannot drift apart:
 *
 * - urlSearchAlreadyPlanned (actions/form.js): a URL read back on a remount
 *   (the feedback return, 23.4 / 70.2) against the settled search.
 * - the mobile search form's "Back to results" (70.1): the form's query
 *   against the active search the Edit button kept.
 */

/**
 * A URL place is only `name::lat,lon` (core-utils formatPlace), so the place
 * parsed back out of it is `{name, lat, lon}`; the place the form planned
 * from carries more — `category: 'CURRENT_LOCATION'` from
 * setLocationToCurrent (actions/map.js), a recent place's
 * address/icon/id/timestamp/type. Whole-object equality therefore failed on
 * the FIRST return of every search planned from the form: on 2026-09-30
 * 17:08:33 (muomy26h-g1zujp) leaving /feedback re-ran the 16:46 search, a
 * 1,244,124-char response, and renumbered the list under the live trip
 * (backlog 23.4 / 37.1). Compare what the URL can carry: the point and its
 * label. 1e-7° is ~1 cm, well under any float round-trip of the URL.
 */
const PLACE_EPSILON_DEG = 1e-7
export function samePlace(stored, other) {
  if (!stored || !other) return !stored && !other
  const close = (a, b) =>
    Number.isFinite(Number(a)) &&
    Number.isFinite(Number(b)) &&
    Math.abs(Number(a) - Number(b)) < PLACE_EPSILON_DEG
  return (
    close(stored.lat, other.lat) &&
    close(stored.lon, other.lon) &&
    (stored.name || '') === (other.name || '')
  )
}

/**
 * Leave-now and depart-at are the same request to OTP for the same date and
 * minute, and the URL cannot say "now": `arriveBy=false` parses to DEPART
 * (core-utils query.js), while a leave-now search stores NOW. On 2026-10-20
 * 16:04:23 (session mvh5pg8t-ypn5ph) that one key re-ran settled search
 * lj157viok on the way back from the feedback screen — 3 OTP calls, the
 * list 20 -> 8 rows (backlog 70.2). ARRIVE stays distinct. A missing value
 * is NOW, the reducer's default.
 */
function departKind(value) {
  return value === 'NOW' || value === 'DEPART' || value == null
    ? 'DEPART'
    : value
}
export function sameDepartArrive(a, b) {
  return departKind(a) === departKind(b)
}

/** One query key, compared the way a URL round-trip can preserve it. */
export function sameQueryValue(key, stored, other) {
  switch (key) {
    case 'from':
    case 'to':
      return samePlace(stored, other)
    case 'stopStays':
      // A search planned before stays existed has none; "none" is `[]`.
      return isEqual(canonicalStopStays(stored), canonicalStopStays(other))
    case 'departArrive':
      return sameDepartArrive(stored, other)
    default:
      return isEqual(stored, other)
  }
}

/**
 * True when every key `urlQuery` carries matches the stored query. The stored
 * query is a superset of what a URL carries (a clone of currentQuery taken at
 * ROUTING_REQUEST), so only the URL's own keys are compared. date and time
 * are compared exactly: a DEPART at another minute is another search.
 */
export function storedQueryMatchesUrl(stored, urlQuery) {
  if (!stored || !urlQuery) return false
  return Object.keys(urlQuery).every((key) =>
    sameQueryValue(key, stored[key], urlQuery[key])
  )
}

/**
 * True when the search form still asks for the search the app holds — what
 * "Back to results" means (70.1). The keys a rider can change on the form:
 * the places and stops (with their stays), the mode, the routing preferences
 * and depart/arrive. date and time unless both are leave-now: a leave-now
 * form moves its clock forward on its own (updateQueryTimeIfLeavingNow),
 * which is not the rider asking for anything new.
 */
export function formQueryMatchesSearch(form, stored) {
  if (!form || !stored) return false
  if (!samePlace(stored.from, form.from) || !samePlace(stored.to, form.to)) {
    return false
  }
  const stops = queryStops(form)
  const storedStops = queryStops(stored)
  if (
    stops.length !== storedStops.length ||
    stops.some((stop, i) => !samePlace(storedStops[i], stop))
  ) {
    return false
  }
  for (const key of ['stopStays', 'mode', 'routingPreferences']) {
    if (!sameQueryValue(key, stored[key], form[key])) return false
  }
  if (!sameDepartArrive(stored.departArrive, form.departArrive)) return false
  const isNow = (q) => (q.departArrive || 'NOW') === 'NOW'
  if (isNow(form) && isNow(stored)) return true
  return stored.date === form.date && stored.time === form.time
}
