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

/** The two built-in slots a place can be promoted into. */
export type BuiltInSlot = 'home' | 'work'

/**
 * The built-in slot a place name claims, or null.
 *
 * Riders reach "Add place" far more often than the Home row, type "Home" as
 * the nickname, and end up with a custom place sitting beside a Home slot that
 * still reads "Set your home address" (2026-09-04: "Ok also why 2 homes?").
 * Matching is trimmed and case-insensitive because that is how a rider types
 * it, not how the code stores it.
 */
export function builtInTypeForName(name?: string | null): BuiltInSlot | null {
  const normalized = typeof name === 'string' ? name.trim().toLowerCase() : ''
  if (normalized === 'home') return 'home'
  if (normalized === 'work') return 'work'
  return null
}

/**
 * Re-shapes a place into a built-in home/work entry: the slot's type and icon,
 * and name === address (the shape convertToPlace produces from the legacy
 * "otp.home"/"otp.work" keys, which is what the rest of the app reads).
 * The custom id is dropped — home and work are addressed by type everywhere.
 */
export function toBuiltInPlace(
  place: UserSavedLocation,
  slot: BuiltInSlot
): UserSavedLocation {
  const address = place.address || ''
  return {
    address,
    icon: slot === 'work' ? 'briefcase' : 'home',
    lat: place.lat,
    lon: place.lon,
    name: address,
    timestamp: place.timestamp,
    type: slot
  }
}

/**
 * One-time, idempotent migration for saved places already on the device:
 * a custom place named "Home"/"Work" is adopted into its built-in slot when
 * that slot is empty. A slot that already holds an address wins — the custom
 * row is left alone rather than silently overwriting the rider's real home.
 *
 * Idempotent because the adopted place comes back as type home/work, which
 * fills the slot on the next load and is no longer a custom place.
 */
export function adoptNamedCustomPlaces(locations: UserSavedLocation[]): {
  adopted: UserSavedLocation[]
  locations: UserSavedLocation[]
} {
  const filled = new Set<string>(
    locations
      .filter((l) => l.type === 'home' || l.type === 'work')
      .map((l) => l.type as string)
  )
  const adopted: UserSavedLocation[] = []
  const next = locations.map((place) => {
    if (!isCustomPlace(place)) return place
    const slot = builtInTypeForName(place.name)
    if (!slot || filled.has(slot)) return place
    // An addressless row is not a home; leave it as the rider left it.
    if (!place.address) return place
    filled.add(slot)
    const promoted = toBuiltInPlace(place, slot)
    adopted.push(promoted)
    return promoted
  })
  return { adopted, locations: next }
}
