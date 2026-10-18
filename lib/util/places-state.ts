import coreUtils from '@opentripplanner/core-utils'

import { UserSavedLocation } from '../components/user/types'

import {
  isCustomPlace,
  loadCustomPlaces,
  SAVED_PLACES_KEY
} from './saved-places'
import { loadRouteSets, parseRouteSets, RouteSet } from './route-sets'

const { getItem } = coreUtils.storage

/**
 * Backlog 28.1 — what the phone holds, and how a server copy merges back in.
 *
 * Pure helpers over localStorage, split from the thunk (actions/places-sync)
 * so both halves are testable without a store: the measurement (the
 * PLACES_STATE beacon's counts) and the merge rules.
 */

/** The four keys a rider's places live in, without coreUtils' "otp." prefix. */
export const PLACES_STORAGE_KEYS = [SAVED_PLACES_KEY, 'home', 'work', 'recent']

/**
 * What PLACES_STATE reports. COUNTS AND KEY PRESENCE ONLY — never a name, an
 * address or a coordinate: the debug sink is telemetry, and where a rider
 * lives is not.
 */
export interface PlacesState {
  /**
   * Entries in the savedPlaces key that loadCustomPlaces() throws away (no id
   * or non-numeric lat/lon). Non-zero means the next persist erases them for
   * good — which would be a loss mechanism of its own.
   */
  dropped: number
  home: boolean
  /** Which of otp.savedPlaces / otp.home / otp.work / otp.recent exist. */
  keys: string[]
  recent: number
  /** Custom places the app will actually load. */
  saved: number
  work: boolean
}

function rawLength(key: string): number {
  const value = getItem(key, [])
  return Array.isArray(value) ? value.length : 0
}

/** Reads the counts the beacon carries. Never throws. */
export function readPlacesState(): PlacesState {
  try {
    const saved = loadCustomPlaces().length
    return {
      dropped: Math.max(0, rawLength(SAVED_PLACES_KEY) - saved),
      home: !!getItem('home'),
      keys: PLACES_STORAGE_KEYS.map((k) => `otp.${k}`).filter(
        (k) => window.localStorage.getItem(k) !== null
      ),
      recent: rawLength('recent'),
      saved,
      work: !!getItem('work')
    }
  } catch {
    return {
      dropped: 0,
      home: false,
      keys: [],
      recent: 0,
      saved: 0,
      work: false
    }
  }
}

/**
 * What is synced: the custom list plus the two legacy slots (not recents),
 * and the saved route sets (58.2, cycle 27 Q6 = B: "phone plus a server
 * backup with your places").
 *
 * `routeSets` is absent — not [] — when a server answer has no such key: a
 * sidecar older than 58.2 knows nothing about sets, and its silence must not
 * read as "this device has none".
 */
export interface PlacesSnapshot {
  home: UserSavedLocation | null
  places: UserSavedLocation[]
  routeSets?: RouteSet[]
  work: UserSavedLocation | null
}

/**
 * A custom place the app can load: an id and numeric coordinates (what
 * loadCustomPlaces keeps), and not a home/work/suggested entry (which
 * persistCustomPlaces would refuse).
 */
function isLoadablePlace(p: any): p is UserSavedLocation {
  return (
    !!p &&
    isCustomPlace(p) &&
    typeof p === 'object' &&
    typeof p.id === 'string' &&
    !!p.id &&
    typeof p.lat === 'number' &&
    typeof p.lon === 'number'
  )
}

/** A home/work entry worth writing back: coordinates at least. */
function isSlotLocation(p: any): p is UserSavedLocation {
  return (
    !!p &&
    typeof p === 'object' &&
    typeof p.lat === 'number' &&
    typeof p.lon === 'number'
  )
}

/** The synced keys as this phone holds them right now. */
export function readPlacesSnapshot(): PlacesSnapshot {
  return {
    home: getItem('home') as UserSavedLocation | null,
    places: loadCustomPlaces(),
    routeSets: loadRouteSets(),
    work: getItem('work') as UserSavedLocation | null
  }
}

/** Server JSON → a snapshot, dropping anything malformed. */
export function parsePlacesSnapshot(data: any): PlacesSnapshot {
  const snapshot: PlacesSnapshot = {
    home: isSlotLocation(data?.home) ? data.home : null,
    places: Array.isArray(data?.places)
      ? data.places.filter(isLoadablePlace)
      : [],
    work: isSlotLocation(data?.work) ? data.work : null
  }
  // Only a server that sent the key has said anything about sets.
  if (data && typeof data === 'object' && 'routeSets' in data) {
    snapshot.routeSets = parseRouteSets(data.routeSets)
  }
  return snapshot
}

export interface PlacesMerge {
  /** Whether the server lacks something the merged result holds (push it). */
  aheadOfServer: boolean
  merged: PlacesSnapshot
  /**
   * What came BACK from the server, as counts (for the beacon). `routeSets`
   * only when the server gave back at least one saved set.
   */
  restored: { home: boolean; places: number; routeSets?: number; work: boolean }
}

/** Without the sets — what a server that predates them can be compared on. */
function withoutSets(snapshot: PlacesSnapshot): PlacesSnapshot {
  const { routeSets, ...rest } = snapshot // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest
}

/**
 * Merge the server copy into what the phone holds.
 *
 * - Local wins. A place present on both sides (by id) keeps the local copy;
 *   a home/work present locally keeps the local one.
 * - The server FILLS: a custom place only the server has is appended, and an
 *   empty home/work slot takes the server's. An empty or missing savedPlaces
 *   key therefore comes back whole — that is the restore.
 * - Never the other way: nothing the server says removes or replaces a local
 *   entry, so a non-empty local list is never overwritten by the server's.
 * - `localAuthoritative` (a local write that the server has not yet
 *   acknowledged) disables the fill entirely: the difference is then a delete
 *   the server has not heard about, and filling it would resurrect the place.
 * - Saved route sets follow the same rules, by id: a set only the server has
 *   is appended (up to the 20-set cap), a set on both keeps the local copy.
 *   A server answer with no `routeSets` key (a sidecar older than 58.2) fills
 *   nothing and is not counted as behind on sets — the phone's sets are
 *   simply kept.
 */
export function mergePlaces(
  local: PlacesSnapshot,
  server: PlacesSnapshot,
  localAuthoritative = false
): PlacesMerge {
  const hasSets = !!local.routeSets || !!server.routeSets
  if (localAuthoritative) {
    return {
      aheadOfServer: true,
      merged: local,
      restored: { home: false, places: 0, work: false }
    }
  }
  const localIds = new Set(local.places.map((p) => p.id))
  const fromServer = server.places.filter((p) => !localIds.has(p.id))
  const home = local.home || server.home
  const work = local.work || server.work
  const merged: PlacesSnapshot = {
    home,
    places: [...local.places, ...fromServer],
    work
  }
  let setsFromServer = 0
  if (hasSets) {
    const localSets = local.routeSets || []
    // parseRouteSets re-applies the caps and the unique-name rule to the
    // union: a server set whose name a local set already took is dropped,
    // never renamed or merged into it.
    const union = parseRouteSets([...localSets, ...(server.routeSets || [])])
    setsFromServer = union.length - localSets.length
    merged.routeSets = union
  }
  // Push only when the server would not already hold the merged result
  // (a place added or edited here). A spurious difference in key order
  // costs one redundant POST, never a loss. An old server holds no sets
  // and never will, so it is compared on places alone.
  const comparable = server.routeSets ? merged : withoutSets(merged)
  return {
    aheadOfServer: JSON.stringify(comparable) !== JSON.stringify(server),
    merged,
    restored: {
      home: !local.home && !!server.home,
      places: fromServer.length,
      ...(setsFromServer > 0 ? { routeSets: setsFromServer } : {}),
      work: !local.work && !!server.work
    }
  }
}
