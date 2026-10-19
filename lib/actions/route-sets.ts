import {
  newRouteSetId,
  renameRouteSet as renameInList,
  RouteSet,
  RouteSetWrite,
  splitRunningRoutes,
  upsertRouteSet
} from '../util/route-sets'
import { recordSessionEvent } from '../util/debug-log'
import { routeLockLabel } from '../util/route-lock'
import type {
  LockableRoute,
  LockedRoute,
  RouteLock,
  RouteLockScope
} from '../util/route-lock'

import {
  applyRouteSet,
  fetchedRoutes,
  RouteLockWriteOptions
} from './route-lock'

/**
 * Saved route sets (58.2, cycle 27 Q3 = B) — the thunks.
 *
 * The user reducer holds the list and persists it (SAVE/RENAME/DELETE_ROUTE_SET);
 * these mint the id and the time, run the same pure check first so the UI can
 * say why a write was refused ("Replace Commute?", "20 sets saved"), and put a
 * saved set back on the query through route-lock's applyRouteSet — so a saved
 * set is searched exactly like one ticked in the sheet, and reported as
 * `ROUTE_SET_APPLIED {source: 'saved'}`.
 */

const savedSets = (getState: any): RouteSet[] =>
  getState().user?.localUser?.routeSets || []

const indexRoutes = (getState: any): Record<string, LockableRoute> =>
  getState().otp?.transitIndex?.routes || {}

/**
 * The rider's picks as {id, label}: the label the route index gives now (what
 * the sheet showed), else the label the lock on the query carries, else the id.
 */
function labelled(getState: any, routeIds: string[]): LockedRoute[] {
  const routes = indexRoutes(getState)
  const onQuery: LockedRoute[] =
    getState().otp?.currentQuery?.routeLock?.routes || []
  return Array.from(new Set(routeIds.filter(Boolean))).map((id) => {
    const route = routes[id]
    if (route && (route.shortName || route.longName)) {
      return { id, label: routeLockLabel({ ...route, id }) }
    }
    const known = Array.isArray(onQuery)
      ? onQuery.find((r) => r?.id === id)
      : undefined
    return { id, label: known?.label || id }
  })
}

/**
 * Save the picked routes under a name. Refused with `exists` when another set
 * already has the name — the sheet then asks "Replace Commute?" and calls
 * again with `replace: true`.
 */
export function saveRouteSet(
  name: string,
  routeIds: string[],
  scope: RouteLockScope,
  { replace = false }: { replace?: boolean } = {}
) {
  return function (dispatch: any, getState: any): RouteSetWrite {
    const draft = { name, routes: labelled(getState, routeIds), scope }
    const id = newRouteSetId()
    const now = Date.now()
    const result = upsertRouteSet(savedSets(getState), draft, {
      id,
      now,
      replace
    })
    if (!result.ok) return result
    dispatch({
      payload: { draft, id, now, replace },
      type: 'SAVE_ROUTE_SET'
    })
    recordSessionEvent('ROUTE_SET_SAVED', {
      count: result.set.routes.length,
      replaced: result.replaced,
      scope: result.set.scope,
      sets: result.sets.length
    })
    return result
  }
}

/** Rename a saved set. Refused with `exists` if another set has the name. */
export function renameRouteSet(setId: string, name: string) {
  return function (dispatch: any, getState: any): RouteSetWrite {
    const now = Date.now()
    const result = renameInList(savedSets(getState), setId, name, now)
    if (result.ok) {
      dispatch({
        payload: { id: setId, name, now },
        type: 'RENAME_ROUTE_SET'
      })
    }
    return result
  }
}

/** Forget a saved set. */
export function deleteRouteSet(setId: string) {
  return function (dispatch: any): void {
    dispatch({ payload: { id: setId }, type: 'DELETE_ROUTE_SET' })
  }
}

/** What putting a saved set back on the query did. */
export interface SavedSetApplyResult {
  /** The lock now on the query, or null when nothing was written. */
  lock: RouteLock | null
  /** The set's routes the graph no longer has, left out of the lock. */
  missing: LockedRoute[]
}

/**
 * Put a saved set back on the query: its routes AND its scope, replacing
 * whatever set is in place. Routes the graph no longer has are left out and
 * returned in `missing` for the UI to name ("Route 99 in Commute isn't
 * running"); when none is left, nothing is written. `replan: false` inside
 * Settings — closing Settings runs the one search.
 */
export function applySavedRouteSet(
  setId: string,
  options: RouteLockWriteOptions = {}
) {
  return async function (
    dispatch: any,
    getState: any
  ): Promise<SavedSetApplyResult> {
    const set = savedSets(getState).find((s) => s.id === setId)
    if (!set) return { lock: null, missing: [] }
    const routes = await fetchedRoutes(dispatch, getState)
    const { missing, running } = splitRunningRoutes(set, routes)
    if (running.length === 0) return { lock: null, missing }
    const lock: RouteLock | null = await dispatch(
      applyRouteSet(
        running.map((route) => route.id),
        set.scope,
        'saved',
        options
      )
    )
    return { lock, missing }
  }
}
