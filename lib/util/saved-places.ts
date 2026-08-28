import coreUtils from '@opentripplanner/core-utils'

import { UserSavedLocation } from '../components/user/types'

const { getItem, storeItem } = coreUtils.storage

/**
 * The single localStorage key (under the "otp." prefix applied by
 * coreUtils.storage) holding ALL of the rider's custom named places
 * (Gym, Mom's house, ...) as one array. Home and Work keep their legacy
 * per-type keys ("otp.home"/"otp.work") and never appear in this one.
 *
 * This module is the only place that reads or writes the key, so a
 * server-backed sync can be added later without touching callers:
 * a thunk (patterned on lib/actions/routing-profiles.ts, never the
 * reducer) would debounce-POST { deviceId: getDeviceId(), places } to
 * config.placesApiUrl || PLACES_API_PATH and merge a GET by id at boot.
 */
export const SAVED_PLACES_KEY = 'savedPlaces'

/**
 * Future sync endpoint on the Flask prefs-api (same-origin, proxied by
 * nginx), mirroring PREFERENCES_API_PATH in ./routing-profiles.ts.
 * Not called yet — documented here so the seam has an address.
 */
export const PLACES_API_PATH = '/api/places'

/** Place types with dedicated storage or config provenance. */
const BUILT_IN_TYPES = ['home', 'work', 'suggested']

/** Whether a place belongs in the savedPlaces key (i.e. is rider-created). */
export function isCustomPlace(place?: UserSavedLocation | null): boolean {
  return !!place && !BUILT_IN_TYPES.includes(place.type || '')
}

/** Reads the rider's custom places, dropping malformed entries. */
export function loadCustomPlaces(): UserSavedLocation[] {
  const places = getItem(SAVED_PLACES_KEY, [])
  if (!Array.isArray(places)) return []
  return places.filter(
    (p) => p && p.id && typeof p.lat === 'number' && typeof p.lon === 'number'
  )
}

/**
 * Persists the custom subset of the given places (callers can pass the whole
 * savedLocations array — home/work/suggested entries are filtered out here
 * so they never leak into the savedPlaces key).
 */
export function persistCustomPlaces(places: UserSavedLocation[]): void {
  storeItem(SAVED_PLACES_KEY, places.filter(isCustomPlace))
}
