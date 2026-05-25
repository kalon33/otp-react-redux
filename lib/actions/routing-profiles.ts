import coreUtils from '@opentripplanner/core-utils'

import { getRoutingProfile } from '../util/routing-profiles'
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
