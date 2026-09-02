import coreUtils from '@opentripplanner/core-utils'

import {
  DEFAULT_PROFILE_ID,
  getRoutingProfile,
  postPreferences,
  PREFERENCES_API_PATH
} from '../util/routing-profiles'
import { getDefaultNumItineraries } from '../util/api'
import { queryIsValid } from '../util/state'
import type { LockedRoute } from '../util/route-lock'
import type { RoutingPreferences, ViaStop } from '../util/routing-profiles'

import { applyRouteLockFromText, setRouteLock } from './route-lock'
import { createGraphQLQueryAction } from './apiV2'
import { setQueryParam } from './form'

const { randId, removeItem, storeItem } = coreUtils.storage

/** Local-storage key for the rider's last-used routing profile/preferences. */
const ROUTING_PROFILE_STORAGE_KEY = 'routingProfile'

/**
 * Local-storage key for the settings panel's non-lever search options: how many
 * itineraries to ask OTP for (#47) and whether to drop the walk-access call
 * from the mode fan-out (#48). Kept apart from ROUTING_PROFILE_STORAGE_KEY
 * because that one is cleared whenever the rider returns to the default
 * profile, which would silently reset these two as well.
 */
const SEARCH_OPTIONS_STORAGE_KEY = 'searchOptions'

/** The panel's search options, as they sit on currentQuery. */
export interface SearchOptions {
  /**
   * Go Mode aims its scoped access re-plan a few minutes ahead of the bus
   * rather than as-fast-as-possible (rider ask 6.10b). Opt-in, and off by
   * default — see util/go-mode/arrive-on-time.ts for why.
   */
  arriveOnTimeAccess?: boolean
  hideWalkTransitOptions?: boolean
  /** Rider ask 4.9: one vehicle, no connections (OTP `maxTransfers: 0`). */
  noTransfers?: boolean
  numItineraries?: number
  /** Rider ask 4.9: the trip must serve this stop (OTP `via`). */
  viaStop?: ViaStop | null
}

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
 * Set one or both of the panel's search options. They ride on currentQuery so
 * routingQuery reads them with no new plumbing (numItineraries is already a
 * query param OTP takes; hideWalkTransitOptions is listed in
 * NON_OTP_QUERY_KEYS so it is stripped before the variables are sent), and they
 * are persisted separately from the profile so a "reset to Fastest" cannot take
 * them down with it. Re-searches once when the query is already valid.
 */
export function setSearchOptions(
  options: SearchOptions,
  actionOptions: { replan?: boolean } = {}
) {
  return function (dispatch: any, getState: any): void {
    const { currentQuery } = getState().otp
    const next: SearchOptions = {
      arriveOnTimeAccess: !!currentQuery.arriveOnTimeAccess,
      hideWalkTransitOptions: !!currentQuery.hideWalkTransitOptions,
      noTransfers: !!currentQuery.noTransfers,
      numItineraries: currentQuery.numItineraries,
      viaStop: currentQuery.viaStop || null,
      ...options
    }
    const replan = actionOptions.replan !== false && queryIsValid(getState())
    dispatch(setQueryParam(next, replan ? randId() : undefined))
    storeItem(SEARCH_OPTIONS_STORAGE_KEY, next)
  }
}

/**
 * Reset everything the rider has customized about routing: levers, profile,
 * route lock, and the panel's search options. One re-search, not several — the
 * writes ahead of the lock release are silenced so the release fires it.
 */
export function clearRoutingPreferences() {
  return function (dispatch: any, getState: any): void {
    dispatch(setRoutingPreferences({}, DEFAULT_PROFILE_ID, { replan: false }))
    dispatch(
      setSearchOptions(
        {
          arriveOnTimeAccess: false,
          hideWalkTransitOptions: false,
          noTransfers: false,
          numItineraries: getDefaultNumItineraries(getState().otp.config),
          viaStop: null
        },
        { replan: false }
      )
    )
    removeItem(SEARCH_OPTIONS_STORAGE_KEY)
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
  lock?: LockedRoute | null
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

/** How many stop suggestions the panel's "must pass through" field offers. */
export const VIA_STOP_SUGGESTION_LIMIT = 8

/**
 * Look up transit stops by name, for the panel's "must pass through this stop"
 * field.
 *
 * A one-off read that resolves rather than landing in the store: there is no
 * stop index in state (only the ~150-entry route index the lock picker uses),
 * and a 14,000-stop index fetched to power one text field would be a far worse
 * trade than a debounced query per keystroke-pause. `stops(name:)` is a live
 * OTP field — verified 2026-09-02, `stops(name: "Lake & Chicago")` returns the
 * two Lake & Chicago Station platforms and nothing else.
 *
 * Never rejects: an empty list is the honest answer to both "no match" and "the
 * server didn't answer", and the field says "no stops match" either way.
 */
export function lookupViaStops(name: string) {
  return async function (dispatch: any): Promise<ViaStop[]> {
    const query = (name || '').trim()
    if (query.length < 3) return []
    const payload: any = await new Promise((resolve) => {
      dispatch(
        createGraphQLQueryAction(
          'query Stops($name: String) { stops(name: $name) { gtfsId name } }',
          { name: query },
          (data: any) => () => resolve(data),
          () => () => resolve(null),
          { noThrottle: true }
        )
      )
    })
    const stops: any[] = payload?.data?.stops || []
    // One suggestion per NAME, carrying every platform id under it. The same
    // stop name appears once per direction (Lake & Chicago Station is 1:16871
    // northbound and 1:56796 southbound) and the rider is naming a place, not a
    // bay — OTP is satisfied by visiting any one of the ids listed.
    const byName = new Map<string, ViaStop>()
    stops.forEach((stop) => {
      const id = stop?.gtfsId
      const name = stop?.name
      if (!id || !name) return
      const existing = byName.get(name)
      if (existing) existing.ids.push(id)
      else byName.set(name, { ids: [id], name })
    })
    return Array.from(byName.values()).slice(0, VIA_STOP_SUGGESTION_LIMIT)
  }
}
