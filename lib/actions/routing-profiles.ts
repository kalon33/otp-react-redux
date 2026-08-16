import coreUtils from '@opentripplanner/core-utils'

import {
  DEFAULT_PROFILE_ID,
  getRoutingProfile,
  postPreferences,
  PREFERENCES_API_PATH
} from '../util/routing-profiles'
import { queryIsValid } from '../util/state'
import type { RouteLock } from '../util/route-lock'
import type { RoutingPreferences } from '../util/routing-profiles'

import { applyRouteLockFromText, setRouteLock } from './route-lock'
import { setQueryParam } from './form'

const { randId, removeItem, storeItem } = coreUtils.storage

/** Local-storage key for the rider's last-used routing profile/preferences. */
const ROUTING_PROFILE_STORAGE_KEY = 'routingProfile'

/**
 * Apply a set of routing-preference levers to the current query. They are
 * stored under currentQuery.routingPreferences (where routingQuery picks them
 * up via the post-generateOtp2Query merge) plus an optional activeProfileId for
 * the UI. An immediate re-search is triggered only when the current query is
 * already valid, so choosing a profile before entering origin/destination
 * won't fire a doomed request. Callers that follow this with another query
 * change (e.g. a route lock) pass replan: false so the rider gets one search
 * for one action instead of two.
 */
export function setRoutingPreferences(
  prefs: RoutingPreferences,
  activeProfileId?: string,
  options: { replan?: boolean } = {}
) {
  return function (dispatch: any, getState: any): void {
    const replan = options.replan !== false && queryIsValid(getState())
    dispatch(
      setQueryParam(
        { activeProfileId, routingPreferences: prefs },
        replan ? randId() : undefined
      )
    )
    // Persist so the choice survives a page reload. These keys aren't part of
    // the OTP query, so they aren't carried in the URL (see create-otp-reducer,
    // which restores them on load). Clear storage when resetting to the default
    // profile with no custom levers.
    const isDefault =
      (!activeProfileId || activeProfileId === DEFAULT_PROFILE_ID) &&
      (!prefs || Object.keys(prefs).length === 0)
    if (isDefault) {
      removeItem(ROUTING_PROFILE_STORAGE_KEY)
    } else {
      storeItem(ROUTING_PROFILE_STORAGE_KEY, {
        activeProfileId,
        routingPreferences: prefs
      })
    }
  }
}

/**
 * Reset everything the rider has customized about routing: levers, profile, and
 * any route lock. One re-search, not two — the preferences write is silenced so
 * the lock release fires it.
 */
export function clearRoutingPreferences() {
  return function (dispatch: any): void {
    dispatch(setRoutingPreferences({}, DEFAULT_PROFILE_ID, { replan: false }))
    dispatch(setRouteLock(null))
  }
}

/** Apply a named pre-built profile (no-op if the id is unknown). */
export function applyRoutingProfile(profileId: string) {
  return function (dispatch: any): void {
    const profile = getRoutingProfile(profileId)
    if (!profile) return
    dispatch(setRoutingPreferences(profile.prefs, profile.id))
  }
}

/** What a plain-language request turned into, for the search form to report. */
export interface AppliedPreferences {
  /** The route we held the search to, when the rider named one and it exists. */
  lock?: RouteLock | null
  preferences: RoutingPreferences
  /** The route name the rider used, echoed back so an error can quote it. */
  routeQuery?: string
}

/**
 * Resolve plain-language text to levers — and, if the rider asked to ride one
 * specific route, to a route lock — and apply them to the current query
 * (search-form box). Throws on failure so the caller can surface an error; the
 * current settings are left untouched in that case. A named route that matches
 * nothing in the graph applies the levers and reports lock: null rather than
 * quietly planning a trip the rider didn't ask for.
 */
export function applyPreferencesFromText(text: string) {
  return async function (
    dispatch: any,
    getState: any
  ): Promise<AppliedPreferences> {
    const url =
      getState().otp.config?.routingPreferencesApiUrl || PREFERENCES_API_PATH
    const { preferences, routeQuery } = await postPreferences(url, text)
    // With a route lock to follow, hold the re-search until it's applied: one
    // rider action should produce one search.
    dispatch(
      setRoutingPreferences(preferences, undefined, { replan: !routeQuery })
    )
    if (!routeQuery) return { preferences }
    const { lock } = await dispatch(applyRouteLockFromText(routeQuery))
    return { lock, preferences, routeQuery }
  }
}

/**
 * Resolve plain-language text to clamped levers WITHOUT applying them (used by
 * the Go Mode mid-trip re-route, which feeds the result into a re-route). Go
 * Mode does not carry route locks, so only the levers come back.
 */
export function fetchPreferencesFromText(text: string) {
  return async function (
    dispatch: any,
    getState: any
  ): Promise<RoutingPreferences> {
    const url =
      getState().otp.config?.routingPreferencesApiUrl || PREFERENCES_API_PATH
    const { preferences } = await postPreferences(url, text)
    return preferences
  }
}
