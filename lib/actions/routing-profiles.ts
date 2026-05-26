import coreUtils from '@opentripplanner/core-utils'

import { clampPreferences, getRoutingProfile } from '../util/routing-profiles'
import { queryIsValid } from '../util/state'
import type { RoutingPreferences } from '../util/routing-profiles'

import { setQueryParam } from './form'

const { randId } = coreUtils.storage

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

/** Path of the login-gated preferences endpoint (same origin, proxied by nginx). */
export const PREFERENCES_API_PATH = '/api/preferences'

/**
 * Send a plain-language description to the preferences endpoint and apply the
 * routing levers it returns. The endpoint is gated by the same nginx Basic Auth
 * as the rest of the app, so this same-origin fetch carries the credential
 * automatically. Returned levers are re-clamped client-side (defense in depth)
 * before being applied. Throws on failure so the caller can surface an error;
 * the current settings are left untouched in that case.
 */
export function applyPreferencesFromText(text: string) {
  return async function (
    dispatch: any,
    getState: any
  ): Promise<RoutingPreferences> {
    const config = getState().otp.config
    const url = config?.routingPreferencesApiUrl || PREFERENCES_API_PATH
    const response = await fetch(url, {
      body: JSON.stringify({ text }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    })
    if (!response.ok) {
      throw new Error(`Preferences API returned ${response.status}`)
    }
    const data = await response.json()
    const prefs = clampPreferences(data?.preferences)
    if (Object.keys(prefs).length === 0) {
      throw new Error('No usable preferences returned')
    }
    dispatch(setRoutingPreferences(prefs))
    return prefs
  }
}
