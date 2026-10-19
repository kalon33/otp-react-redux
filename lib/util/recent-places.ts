import { calculateDistance } from './go-mode/position-matching'
import { UserSavedLocation } from '../components/user/types'

/**
 * Two recent places within this many metres are the same place. The recents
 * list exists so the rider can tap a destination they used before; a second
 * row five metres from the first is never the thing they wanted.
 */
export const RECENT_PLACE_MATCH_METERS = 5

/**
 * How many recent places the phone keeps (the reducer's sortAndTrim, and the
 * union with the server copy in places-state.ts — backlog 60.1).
 */
export const MAX_RECENT_STORAGE = 5

/** Case- and whitespace-insensitive address key. */
export function normalizeRecentAddress(value?: string | null): string {
  return (value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Whether two recent places are the same destination: within
 * RECENT_PLACE_MATCH_METERS, or carrying the same address text.
 *
 * Coordinates alone are not enough — the same place geocoded twice (once from
 * the search field, once from a saved place) can land a few metres apart —
 * and address alone is not enough either, because a map-tapped point has no
 * address at all.
 */
export function isSameRecentPlace(
  a?: UserSavedLocation | null,
  b?: UserSavedLocation | null
): boolean {
  if (!a || !b) return false
  if (
    calculateDistance(
      a.lat as number,
      a.lon as number,
      b.lat as number,
      b.lon as number
    ) <= RECENT_PLACE_MATCH_METERS
  ) {
    return true
  }
  const addressA = normalizeRecentAddress(a.address || a.name)
  const addressB = normalizeRecentAddress(b.address || b.name)
  return !!addressA && addressA === addressB
}

/**
 * Folds a repeat visit into the recent the rider already has: the newer
 * address/name/coordinates and timestamp win, but the id does not change.
 * A fresh id on every plan would break "forget this place" (which matches by
 * id) and churn the React keys of the list for no rider-visible gain.
 */
export function mergeRecentPlace(
  existing: UserSavedLocation,
  incoming: UserSavedLocation
): UserSavedLocation {
  return {
    ...existing,
    ...incoming,
    id: existing.id || incoming.id
  }
}
