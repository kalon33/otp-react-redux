import coreUtils from '@opentripplanner/core-utils'

import {
  buildBannedRoutes,
  resolveRouteLock,
  ROUTE_LOCK_MODES,
  routeLockLabel,
  withRouteLockPrefs
} from '../util/route-lock'
import { FETCH_STATUS } from '../util/constants'
import { queryIsValid } from '../util/state'
import type {
  LockableRoute,
  LockedRoute,
  RouteLock,
  RouteLockScope
} from '../util/route-lock'

import { findRoutesIfNeeded } from './api'
import { setQueryParam } from './form'

const { randId } = coreUtils.storage

/** How long to wait for the route index before giving up on a name lookup. */
const ROUTES_TIMEOUT_MS = 8000
const ROUTES_POLL_MS = 100

const routeIndex = (getState: any): Record<string, LockableRoute> =>
  getState().otp.transitIndex?.routes || {}

/**
 * The full OTP route index, fetching it first if this session hasn't yet.
 *
 * findRoutesIfNeeded dispatches without returning a promise, so readiness is
 * read off routesFetchStatus rather than awaited. Resolves to whatever is in
 * the store when the fetch lands, times out, or fails — callers must cope with
 * an empty index rather than assume one.
 */
async function fetchedRoutes(
  dispatch: any,
  getState: any
): Promise<Record<string, LockableRoute>> {
  const status = () => getState().otp.transitIndex?.routesFetchStatus
  if (status() !== FETCH_STATUS.FETCHED) {
    dispatch(findRoutesIfNeeded())
    const deadline = Date.now() + ROUTES_TIMEOUT_MS
    while (Date.now() < deadline && status() !== FETCH_STATUS.FETCHED) {
      if (status() === FETCH_STATUS.ERROR) break
      await new Promise((resolve) => setTimeout(resolve, ROUTES_POLL_MS))
    }
  }
  return routeIndex(getState)
}

/** Soft bias applied to a starting-route selection (seconds). */
const STARTING_ROUTE_PENALTY = 900

/**
 * Hold the search to a set of transit routes — or release it.
 *
 * Two shapes, because the rider asked for two different things (#45, #46):
 *
 * - `only` (the original lock, now over a set): `banned.routes` carrying every
 *   OTHER route in the graph (this OTP has no include-filter, see
 *   util/route-lock), bike+transit modes so the ends are rideable and the
 *   search stays a single plan() call, and a bike reluctance high enough that
 *   the named routes actually carry the trip.
 * - `starting`: the first vehicle only. A ban list cannot say that — banning
 *   the complement would also forbid the connections the rider left free — and
 *   the server has no first-leg argument (`startTransitStopId` is documented on
 *   the live schema as having no effect), so the query gets a soft `preferred`
 *   bias and the results list filters on the first transit leg. Nothing about
 *   the rider's modes or levers is touched: they did not say "bike the rest".
 *
 * Either way a `routeLock` bookkeeping key records what is in effect and the UI
 * reads it back. Releasing clears all of it. Re-searches immediately only when
 * the query is already valid, so naming a route before entering
 * origin/destination won't fire a doomed request.
 */
export function setRouteLock(
  routeIds?: string | string[] | null,
  scope: RouteLockScope = 'only'
) {
  return async function (dispatch: any, getState: any): Promise<void> {
    const replan = () => (queryIsValid(getState()) ? randId() : undefined)
    const wanted = (
      routeIds == null ? [] : Array.isArray(routeIds) ? routeIds : [routeIds]
    ).filter(Boolean)

    if (wanted.length === 0) {
      dispatch(
        setQueryParam(
          {
            banned: undefined,
            modes: undefined,
            preferred: undefined,
            routeLock: undefined
          },
          replan()
        )
      )
      return
    }

    const routes = await fetchedRoutes(dispatch, getState)
    // Ids the graph doesn't have would silently widen the ban (they'd be kept
    // out of the complement while matching nothing), so drop them here.
    const picked: LockedRoute[] = wanted
      .filter((id) => routes[id])
      .map((id) => ({
        id,
        label: routeLockLabel({ ...routes[id], id })
      }))
    if (picked.length === 0) return

    const lock: RouteLock = { routes: picked, scope }
    const ids = picked.map((route) => route.id)

    if (scope === 'starting') {
      // A bias, not a ban: everything after the first vehicle stays legal.
      dispatch(
        setQueryParam(
          {
            banned: undefined,
            preferred: {
              otherThanPreferredRoutesPenalty: STARTING_ROUTE_PENALTY,
              routes: ids.join(',')
            },
            routeLock: lock
          },
          replan()
        )
      )
      return
    }

    // Keep the rider's levers, but not a bike reluctance so low that the routes
    // they just named stop carrying the trip (see withRouteLockPrefs). Held on
    // the query only — it isn't persisted as a profile choice.
    const routingPreferences = withRouteLockPrefs(
      getState().otp.currentQuery?.routingPreferences
    )
    dispatch(
      setQueryParam(
        {
          banned: { routes: buildBannedRoutes(routes, ids) },
          modes: ROUTE_LOCK_MODES,
          preferred: undefined,
          routeLock: lock,
          routingPreferences
        },
        replan()
      )
    )
  }
}

/**
 * Add or remove one route from the current selection, keeping its scope.
 *
 * The panel's picker is an "add a route" dropdown plus a chip per route, so
 * every rider action is one id toggled against what is already there — never a
 * whole new set. Removing the last route releases the lock outright.
 */
export function toggleRouteLockRoute(routeId: string) {
  return async function (dispatch: any, getState: any): Promise<void> {
    const lock: RouteLock | undefined = getState().otp.currentQuery?.routeLock
    const current = (lock?.routes || []).map((route) => route.id)
    const next = current.includes(routeId)
      ? current.filter((id) => id !== routeId)
      : [...current, routeId]
    await dispatch(setRouteLock(next, lock?.scope || 'only'))
  }
}

/** Switch the selection between "only these" and "start me on these". */
export function setRouteLockScope(scope: RouteLockScope) {
  return async function (dispatch: any, getState: any): Promise<void> {
    const lock: RouteLock | undefined = getState().otp.currentQuery?.routeLock
    if (!lock) return
    await dispatch(
      setRouteLock(
        lock.routes.map((route) => route.id),
        scope
      )
    )
  }
}

/** What a plain-language route request turned into, for the UI to report. */
export interface RouteLockFromTextResult {
  /** The route we locked to, or null when the name matched nothing. */
  lock: LockedRoute | null
  /** The name the rider used, echoed back so an error can quote it. */
  routeQuery: string
}

/**
 * Lock to a route the rider named in plain language ("only the 18").
 *
 * Resolution happens here, against the live OTP route index, rather than in the
 * preferences service: the graph is the only authority on which routes exist,
 * and a model-invented id would plan a trip on a route that isn't there. An
 * unmatched name locks nothing and says so.
 */
export function applyRouteLockFromText(routeQuery: string) {
  return async function (
    dispatch: any,
    getState: any
  ): Promise<RouteLockFromTextResult> {
    const routes = await fetchedRoutes(dispatch, getState)
    const lock = resolveRouteLock(routes, routeQuery)
    if (!lock) return { lock: null, routeQuery }

    await dispatch(setRouteLock(lock.id))
    return { lock, routeQuery }
  }
}
