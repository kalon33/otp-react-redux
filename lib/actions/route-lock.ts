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
import type { LockableRoute, RouteLock } from '../util/route-lock'

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

/**
 * Hold the search to one transit route, biking both ends — or release it.
 *
 * The lock is three query params at once: `banned.routes` carrying every other
 * route in the graph (this OTP has no include-filter, see util/route-lock),
 * bike+transit modes so the ends are rideable and the search stays a single
 * plan() call, and a `routeLock` bookkeeping key the UI reads back. Releasing
 * clears all three. Re-searches immediately only when the query is already
 * valid, so locking a route before entering origin/destination won't fire a
 * doomed request.
 */
export function setRouteLock(routeId?: string | null) {
  return async function (dispatch: any, getState: any): Promise<void> {
    const replan = () => (queryIsValid(getState()) ? randId() : undefined)

    if (!routeId) {
      dispatch(
        setQueryParam(
          { banned: undefined, modes: undefined, routeLock: undefined },
          replan()
        )
      )
      return
    }

    const routes = await fetchedRoutes(dispatch, getState)
    const route = routes[routeId]
    if (!route) return

    const lock: RouteLock = {
      id: routeId,
      label: routeLockLabel({ ...route, id: routeId })
    }
    // Keep the rider's levers, but not a bike reluctance so low that the route
    // they just named stops carrying the trip (see withRouteLockPrefs). Held on
    // the query only — it isn't persisted as a profile choice.
    const routingPreferences = withRouteLockPrefs(
      getState().otp.currentQuery?.routingPreferences
    )
    dispatch(
      setQueryParam(
        {
          banned: { routes: buildBannedRoutes(routes, routeId) },
          modes: ROUTE_LOCK_MODES,
          routeLock: lock,
          routingPreferences
        },
        replan()
      )
    )
  }
}

/** What a plain-language route request turned into, for the UI to report. */
export interface RouteLockFromTextResult {
  /** The route we locked to, or null when the name matched nothing. */
  lock: RouteLock | null
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
