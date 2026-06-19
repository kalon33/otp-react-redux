import coreUtils from '@opentripplanner/core-utils'

import {
  DEFAULT_PROFILE_ID,
  getRoutingProfile,
  postPreferences,
  PREFERENCES_API_PATH
} from '../util/routing-profiles'
import { queryIsValid } from '../util/state'
import type { RoutingPreferences } from '../util/routing-profiles'

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
 * won't fire a doomed request.
 */
export function setRoutingPreferences(
  prefs: RoutingPreferences,
  activeProfileId?: string
) {
  return function (dispatch: any, getState: any): void {
    const replan = queryIsValid(getState())
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

/** Apply a named pre-built profile (no-op if the id is unknown). */
export function applyRoutingProfile(profileId: string) {
  return function (dispatch: any): void {
    const profile = getRoutingProfile(profileId)
    if (!profile) return
    dispatch(setRoutingPreferences(profile.prefs, profile.id))
  }
}

/**
 * Resolve plain-language text to levers and apply them to the current query
 * (search-form box). Throws on failure so the caller can surface an error; the
 * current settings are left untouched in that case.
 */
export function applyPreferencesFromText(text: string) {
  return async function (
    dispatch: any,
    getState: any
  ): Promise<RoutingPreferences> {
    const url =
      getState().otp.config?.routingPreferencesApiUrl || PREFERENCES_API_PATH
    const prefs = await postPreferences(url, text)
    dispatch(setRoutingPreferences(prefs))
    return prefs
  }
}

/**
 * Resolve plain-language text to clamped levers WITHOUT applying them (used by
 * the Go Mode mid-trip re-route, which feeds the result into a re-route).
 */
export function fetchPreferencesFromText(text: string) {
  return function (dispatch: any, getState: any): Promise<RoutingPreferences> {
    const url =
      getState().otp.config?.routingPreferencesApiUrl || PREFERENCES_API_PATH
    return postPreferences(url, text)
  }
}
