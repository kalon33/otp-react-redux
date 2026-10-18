import coreUtils from '@opentripplanner/core-utils'

import {
  buildBannedRoutes,
  resolveRouteLock,
  ROUTE_LOCK_MODES,
  routeLockIds,
  routeLockLabel,
  routeLockScope,
  withRouteLockPrefs
} from '../util/route-lock'
import { FETCH_STATUS } from '../util/constants'
import { queryIsValid } from '../util/state'
import { recordSessionEvent } from '../util/debug-log'
import type {
  AnyRouteLock,
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

/** Options every route-set write takes. */
export interface RouteLockWriteOptions {
  /**
   * Re-search once the set is written (default true, and only when the query
   * is already valid). Writes made inside Settings pass false: closing
   * Settings runs the search (advanced-settings-panel closePanel), so a write
   * that also searched would make one rider action cost two searches.
   */
  replan?: boolean
}

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
 * asked to (the default) and the query is already valid, so naming a route
 * before entering origin/destination won't fire a doomed request.
 *
 * Resolves to the lock written — null when it released, or when none of the
 * ids is in the graph (and then nothing is written at all).
 */
export function setRouteLock(
  routeIds?: string | string[] | null,
  scope: RouteLockScope = 'only',
  options: RouteLockWriteOptions = {}
) {
  return async function (
    dispatch: any,
    getState: any
  ): Promise<RouteLock | null> {
    const replan = () =>
      options.replan !== false && queryIsValid(getState())
        ? randId()
        : undefined
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
      return null
    }

    const routes = await fetchedRoutes(dispatch, getState)
    // Ids the graph doesn't have would silently widen the ban (they'd be kept
    // out of the complement while matching nothing), so drop them here.
    const picked: LockedRoute[] = Array.from(new Set(wanted))
      .filter((id) => routes[id])
      .map((id) => ({
        id,
        label: routeLockLabel({ ...routes[id], id })
      }))
    if (picked.length === 0) return null

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
      return lock
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
    return lock
  }
}

/** Where a whole route set came from, for the debug stream. */
export type RouteSetSource = 'sheet' | 'describe' | 'saved'

/**
 * Write a whole route set the rider chose in one go — the route sheet's Done,
 * the describe box, a saved set — and say so on the debug stream
 * (`ROUTE_SET_APPLIED {count, scope, source}`, count 0 for a release), which
 * is how a later session tells which control the rider actually used (58.2's
 * open question was answerable only from an August telemetry line).
 */
export function applyRouteSet(
  routeIds: string[],
  scope: RouteLockScope,
  source: RouteSetSource,
  options: RouteLockWriteOptions = {}
) {
  return async function (dispatch: any): Promise<RouteLock | null> {
    const lock: RouteLock | null = await dispatch(
      setRouteLock(routeIds, scope, options)
    )
    recordSessionEvent('ROUTE_SET_APPLIED', {
      count: lock?.routes.length || 0,
      scope: lock?.scope || scope,
      source
    })
    return lock
  }
}

/**
 * Add or remove one route from the current selection, keeping its scope.
 *
 * The Settings panel shows a chip per route; tapping one takes that route out
 * (and the route sheet adds them). Removing the last route releases the lock
 * outright. Reads the lock through routeLockIds, so a pre-09-02 single-route
 * lock is toggled like any other rather than silently dropped.
 */
export function toggleRouteLockRoute(
  routeId: string,
  options: RouteLockWriteOptions = {}
) {
  return async function (
    dispatch: any,
    getState: any
  ): Promise<RouteLock | null> {
    const lock: AnyRouteLock | undefined =
      getState().otp.currentQuery?.routeLock
    const current = routeLockIds(lock)
    const next = current.includes(routeId)
      ? current.filter((id) => id !== routeId)
      : [...current, routeId]
    return dispatch(setRouteLock(next, routeLockScope(lock), options))
  }
}

/** Switch the selection between "only these" and "start me on these". */
export function setRouteLockScope(
  scope: RouteLockScope,
  options: RouteLockWriteOptions = {}
) {
  return async function (
    dispatch: any,
    getState: any
  ): Promise<RouteLock | null> {
    const lock: AnyRouteLock | undefined =
      getState().otp.currentQuery?.routeLock
    const ids = routeLockIds(lock)
    if (ids.length === 0) return null
    return dispatch(setRouteLock(ids, scope, options))
  }
}

/** What a plain-language route request turned into, for the UI to report. */
export interface RouteLocksFromTextResult {
  /** The routes now held to, in the order the rider named them. */
  locks: LockedRoute[]
  /** The names that matched nothing in the graph, as the rider said them. */
  missing: string[]
}

/**
 * How typed routes meet a set already in place. The rider chose `replace`
 * (cycle 27 Q7): "only the 18 and the 21" means exactly those two, whatever
 * was picked before. `add` keeps the old routes too.
 */
export type RouteLocksFromTextMode = 'replace' | 'add'

/**
 * Hold the search to the routes the rider named in plain language ("only the
 * 18 and the 21").
 *
 * Resolution happens here, against the live OTP route index, rather than in the
 * preferences service: the graph is the only authority on which routes exist,
 * and a model-invented id would plan a trip on a route that isn't there. The
 * index is loaded once for all the names, each name is resolved on its own,
 * and the routes that did resolve are written in ONE setRouteLock — one
 * search, however many routes. Names that match nothing come back in
 * `missing` for the panel to say out loud; when none matches, nothing is
 * locked and the current set is left alone.
 */
export function applyRouteLocksFromText(
  routeQueries: string[],
  mode: RouteLocksFromTextMode = 'replace',
  options: RouteLockWriteOptions = {}
) {
  return async function (
    dispatch: any,
    getState: any
  ): Promise<RouteLocksFromTextResult> {
    const names = routeQueries.filter((name) => !!name?.trim())
    if (names.length === 0) return { locks: [], missing: [] }

    const routes = await fetchedRoutes(dispatch, getState)
    const found: LockedRoute[] = []
    const missing: string[] = []
    names.forEach((name) => {
      const lock = resolveRouteLock(routes, name)
      if (!lock) missing.push(name)
      else if (!found.some((route) => route.id === lock.id)) found.push(lock)
    })
    if (found.length === 0) return { locks: [], missing }

    const existing: AnyRouteLock | undefined =
      getState().otp.currentQuery?.routeLock
    const ids =
      mode === 'add'
        ? Array.from(
            new Set([...routeLockIds(existing), ...found.map((r) => r.id)])
          )
        : found.map((route) => route.id)
    // Typed routes always mean "ride only these": the box has no way to say
    // "start on", and keeping a stale "start on" scope from the sheet would
    // quietly answer a different question than the one just typed.
    const scope: RouteLockScope =
      mode === 'add' ? routeLockScope(existing) : 'only'
    const lock = await dispatch(applyRouteSet(ids, scope, 'describe', options))
    return { locks: lock ? found : [], missing }
  }
}
