import coreUtils from '@opentripplanner/core-utils'

import { UserSavedLocation } from '../components/user/types'

import {
  isCustomPlace,
  loadCustomPlaces,
  SAVED_PLACES_KEY
} from './saved-places'
import { isSameRecentPlace, MAX_RECENT_STORAGE } from './recent-places'
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
 * A recent place as the `otp.recent` key stores it (the reducer writes the
 * legacy LocationField shape, convertToLegacyLocation).
 */
export interface StoredRecentPlace {
  icon?: string
  id?: string
  lat: number
  lon: number
  name?: string
  timestamp?: number
  type?: string
}

/**
 * What is synced: the custom list plus the two legacy slots, the saved route
 * sets (58.2, cycle 27 Q6 = B: "phone plus a server backup with your
 * places"), and the recent places (60.1 — the only thing the 10-08 and 10-19
 * dev-app resets actually took).
 *
 * `routeSets` / `recent` are absent — not [] — when a server answer has no
 * such key: a sidecar older than 58.2 / 60.1 knows nothing about them, and
 * its silence must not read as "this device has none".
 */
export interface PlacesSnapshot {
  home: UserSavedLocation | null
  places: UserSavedLocation[]
  recent?: StoredRecentPlace[]
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

const RECENT_FIELDS = ['icon', 'id', 'lat', 'lon', 'name', 'timestamp', 'type']

/**
 * Recent places worth keeping: numeric coordinates at least, and only the
 * fields the stored shape has (nothing else from a server answer is written
 * back into localStorage).
 */
export function parseRecentPlaces(value: unknown): StoredRecentPlace[] {
  if (!Array.isArray(value)) return []
  return value.filter(isSlotLocation).map((entry: any) => {
    const clean: Record<string, unknown> = {}
    RECENT_FIELDS.forEach((field) => {
      if (entry[field] !== undefined && entry[field] !== null) {
        clean[field] = entry[field]
      }
    })
    return clean as unknown as StoredRecentPlace
  })
}

/** The synced keys as this phone holds them right now. */
export function readPlacesSnapshot(): PlacesSnapshot {
  return {
    home: getItem('home') as UserSavedLocation | null,
    places: loadCustomPlaces(),
    recent: parseRecentPlaces(getItem('recent', [])),
    routeSets: loadRouteSets(),
    work: getItem('work') as UserSavedLocation | null
  }
}

/** Whether a copy holds nothing at all (the app-key migration's trigger). */
export function isEmptySnapshot(snapshot: PlacesSnapshot): boolean {
  return (
    !snapshot.home &&
    !snapshot.work &&
    snapshot.places.length === 0 &&
    !snapshot.recent?.length &&
    !snapshot.routeSets?.length
  )
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
  // Only a server that sent the key has said anything about sets / recents.
  if (data && typeof data === 'object' && 'routeSets' in data) {
    snapshot.routeSets = parseRouteSets(data.routeSets)
  }
  if (data && typeof data === 'object' && 'recent' in data) {
    snapshot.recent = parseRecentPlaces(data.recent)
  }
  return snapshot
}

/**
 * Recents, local first then the server's, as one list: an entry the
 * reducer's own rule calls the same place (isSameRecentPlace — ~5 m or the
 * same address) keeps the LOCAL copy; newest first; capped at
 * MAX_RECENT_STORAGE. A union, not local-wins-the-list: the first recent a
 * freshly reset app records must not block the restore of the other four.
 */
export function mergeRecentPlaces(
  local: StoredRecentPlace[],
  server: StoredRecentPlace[]
): StoredRecentPlace[] {
  const union = [...local]
  server.forEach((entry) => {
    if (!union.some((kept) => isSameRecentPlace(kept as any, entry as any))) {
      union.push(entry)
    }
  })
  // Array.prototype.sort is stable: equal (or missing) timestamps keep local
  // ahead of server.
  return union
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (b.entry.timestamp || 0) - (a.entry.timestamp || 0) || a.index - b.index
    )
    .slice(0, MAX_RECENT_STORAGE)
    .map(({ entry }) => entry)
}

export interface PlacesMerge {
  /** Whether the server lacks something the merged result holds (push it). */
  aheadOfServer: boolean
  merged: PlacesSnapshot
  /**
   * What came BACK from the server, as counts (for the beacon). `routeSets`
   * / `recent` only when the server gave back at least one of them.
   */
  restored: {
    home: boolean
    places: number
    recent?: number
    routeSets?: number
    work: boolean
  }
}

/**
 * Without the keys the server's answer lacks — what a server that predates
 * sets (58.2) or recents (60.1) can be compared on.
 */
function comparableTo(
  merged: PlacesSnapshot,
  server: PlacesSnapshot
): PlacesSnapshot {
  const comparable = { ...merged }
  if (!server.routeSets) delete comparable.routeSets
  if (!server.recent) delete comparable.recent
  return comparable
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
 * - Recent places (60.1) are a UNION (mergeRecentPlaces), not a fill: the
 *   reset app's first new recent must not hide the four on the server. Same
 *   absent-key rule as sets for an old server.
 */
export function mergePlaces(
  local: PlacesSnapshot,
  server: PlacesSnapshot,
  localAuthoritative = false
): PlacesMerge {
  const hasSets = !!local.routeSets || !!server.routeSets
  const hasRecent = !!local.recent || !!server.recent
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
  let recentFromServer = 0
  if (hasRecent) {
    const localRecent = local.recent || []
    const recent = mergeRecentPlaces(localRecent, server.recent || [])
    recentFromServer = recent.filter((r) => !localRecent.includes(r)).length
    merged.recent = recent
  }
  // Push only when the server would not already hold the merged result
  // (a place added or edited here). A spurious difference in key order
  // costs one redundant POST, never a loss. An old server holds no sets
  // (or recents) and never will, so it is compared without them.
  const comparable = comparableTo(merged, server)
  return {
    aheadOfServer: JSON.stringify(comparable) !== JSON.stringify(server),
    merged,
    restored: {
      home: !local.home && !!server.home,
      places: fromServer.length,
      ...(recentFromServer > 0 ? { recent: recentFromServer } : {}),
      ...(setsFromServer > 0 ? { routeSets: setsFromServer } : {}),
      work: !local.work && !!server.work
    }
  }
}
