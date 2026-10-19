import coreUtils from '@opentripplanner/core-utils'

import { routeLockIds, routeLockScope } from './route-lock'
import type { AnyRouteLock, LockedRoute, RouteLockScope } from './route-lock'

const { getItem, storeItem } = coreUtils.storage

/**
 * Saved route sets (backlog 58.2, cycle 27 Q3 = B): "Commute" = the 18, the 21
 * and the Orange Line, ridden only. The rider names a set once in the route
 * sheet and brings it back with one tap.
 *
 * Pure helpers plus the one reader and the one writer of the storage key.
 * Nothing else in the app touches `otp.routeSets`: the user reducer writes it
 * through persistRouteSets, and the places backup (Q6 = B, util/places-state)
 * reads it through loadRouteSets.
 *
 * The stored list is read back on every launch and comes back from the
 * server, so it is never trusted: loadRouteSets/parseRouteSets drop anything
 * that is not a well-formed set and NEVER throw — a throw at boot is a blank
 * app, not a missing chip.
 */

/** localStorage key, without coreUtils' "otp." prefix. */
export const ROUTE_SETS_KEY = 'routeSets'

/** Caps. The sidecar (transitnav places_api.py) holds itself to the same. */
export const MAX_ROUTE_SETS = 20
export const MAX_ROUTES_PER_SET = 30
export const MAX_SET_NAME_CHARS = 40
const MAX_ROUTE_ID_CHARS = 100
const MAX_ROUTE_LABEL_CHARS = 40

export interface RouteSet {
  /** Stable across renames and replacements. */
  id: string
  /** What the rider called it: "Commute". Unique, ignoring case. */
  name: string
  /** In the order the rider picked them; labels as they were when saved. */
  routes: LockedRoute[]
  /** Epoch ms of the last save (a replacement or rename moves it). */
  savedAt: number
  scope: RouteLockScope
}

/** The part of a set the rider supplies when saving. */
export interface RouteSetDraft {
  name: string
  routes: LockedRoute[]
  scope: RouteLockScope
}

/**
 * Why a write was refused — the UI says each one back.
 *
 * - `noName`: the name is blank once trimmed.
 * - `noRoutes`: nothing to save.
 * - `exists`: another set has this name; saving over it needs `replace`
 *   ("Replace Commute?").
 * - `full`: MAX_ROUTE_SETS already saved.
 * - `missing`: no set with that id.
 */
export type RouteSetError =
  | 'noName'
  | 'noRoutes'
  | 'exists'
  | 'full'
  | 'missing'

export type RouteSetWrite =
  | { ok: true; replaced: boolean; set: RouteSet; sets: RouteSet[] }
  | { error: RouteSetError; existing?: RouteSet; ok: false }

/** A name as it is stored: trimmed, inner runs of space collapsed, ≤40. */
export function cleanSetName(name: unknown): string {
  if (typeof name !== 'string') return ''
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_SET_NAME_CHARS).trim()
}

const sameName = (a: string, b: string) =>
  a.toLocaleLowerCase() === b.toLocaleLowerCase()

/** The set called `name`, ignoring case, if any. */
export function findSetByName(
  sets: RouteSet[],
  name: string
): RouteSet | undefined {
  const wanted = cleanSetName(name)
  if (!wanted) return undefined
  return sets.find((set) => sameName(set.name, wanted))
}

function cleanRoutes(raw: unknown): LockedRoute[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: LockedRoute[] = []
  for (const route of raw) {
    if (out.length >= MAX_ROUTES_PER_SET) break
    if (!route || typeof route !== 'object') continue
    const id = typeof route.id === 'string' ? route.id.trim() : ''
    if (!id || id.length > MAX_ROUTE_ID_CHARS || seen.has(id)) continue
    seen.add(id)
    const label =
      typeof route.label === 'string' && route.label.trim()
        ? route.label.trim().slice(0, MAX_ROUTE_LABEL_CHARS)
        : id
    out.push({ id, label })
  }
  return out
}

/** One stored set, or null when it is not one. Never throws. */
function parseRouteSet(raw: any): RouteSet | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const name = cleanSetName(raw.name)
  if (!id || id.length > 64 || !name) return null
  if (raw.scope !== 'only' && raw.scope !== 'starting') return null
  const routes = cleanRoutes(raw.routes)
  if (routes.length === 0) return null
  const savedAt =
    typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt)
      ? raw.savedAt
      : 0
  return { id, name, routes, savedAt, scope: raw.scope }
}

/**
 * A list as it arrives (storage, server) → the sets the app will use:
 * malformed entries dropped, ids and names unique (first wins), at most
 * MAX_ROUTE_SETS. Anything that is not a list is []. Never throws.
 */
export function parseRouteSets(raw: unknown): RouteSet[] {
  try {
    if (!Array.isArray(raw)) return []
    const out: RouteSet[] = []
    for (const entry of raw) {
      if (out.length >= MAX_ROUTE_SETS) break
      let parsed: RouteSet | null = null
      try {
        parsed = parseRouteSet(entry)
      } catch {
        // One hostile entry costs that entry, not the list.
      }
      const set = parsed
      if (!set) continue
      if (out.some((s) => s.id === set.id || sameName(s.name, set.name))) {
        continue
      }
      out.push(set)
    }
    return out
  } catch {
    return []
  }
}

/** The saved sets on this phone. Never throws. */
export function loadRouteSets(): RouteSet[] {
  try {
    return parseRouteSets(getItem(ROUTE_SETS_KEY, []))
  } catch {
    return []
  }
}

/** The ONE writer of `otp.routeSets`. A refused write is not fatal. */
export function persistRouteSets(sets: RouteSet[]): void {
  try {
    storeItem(ROUTE_SETS_KEY, sets)
  } catch {
    // Storage full or blocked: state still holds the sets for this launch.
  }
}

/** A fresh set id. */
export function newRouteSetId(): string {
  return `set-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

/**
 * Save a set. A new name goes to the front of the list; a name already taken
 * is refused with `exists` unless `replace` — then that set takes the new
 * routes and scope in place, keeping its id and its spot.
 */
export function upsertRouteSet(
  sets: RouteSet[],
  draft: RouteSetDraft,
  {
    id = newRouteSetId(),
    now = Date.now(),
    replace = false
  }: { id?: string; now?: number; replace?: boolean } = {}
): RouteSetWrite {
  const name = cleanSetName(draft.name)
  if (!name) return { error: 'noName', ok: false }
  const routes = cleanRoutes(draft.routes)
  if (routes.length === 0) return { error: 'noRoutes', ok: false }
  const scope: RouteLockScope = draft.scope === 'starting' ? 'starting' : 'only'
  const existing = findSetByName(sets, name)
  if (existing) {
    if (!replace) return { error: 'exists', existing, ok: false }
    // The rider may have retyped "commute" — keep the name they just typed.
    const set: RouteSet = { ...existing, name, routes, savedAt: now, scope }
    return {
      ok: true,
      replaced: true,
      set,
      sets: sets.map((s) => (s.id === existing.id ? set : s))
    }
  }
  if (sets.length >= MAX_ROUTE_SETS) return { error: 'full', ok: false }
  const set: RouteSet = { id, name, routes, savedAt: now, scope }
  return { ok: true, replaced: false, set, sets: [set, ...sets] }
}

/** Rename a set. A name another set has is refused (`exists`). */
export function renameRouteSet(
  sets: RouteSet[],
  setId: string,
  name: string,
  now: number = Date.now()
): RouteSetWrite {
  const target = sets.find((s) => s.id === setId)
  if (!target) return { error: 'missing', ok: false }
  const clean = cleanSetName(name)
  if (!clean) return { error: 'noName', ok: false }
  const clash = findSetByName(sets, clean)
  if (clash && clash.id !== setId) {
    return { error: 'exists', existing: clash, ok: false }
  }
  const set: RouteSet = { ...target, name: clean, savedAt: now }
  return {
    ok: true,
    replaced: false,
    set,
    sets: sets.map((s) => (s.id === setId ? set : s))
  }
}

/** The list without that set (the same list when there is none). */
export function deleteRouteSet(sets: RouteSet[], setId: string): RouteSet[] {
  return sets.some((s) => s.id === setId)
    ? sets.filter((s) => s.id !== setId)
    : sets
}

/**
 * The saved set the lock on the query IS — the same route ids in any order
 * and the same scope — so the summary can say "Only: Commute (18, 21,
 * Orange)" instead of three chips.
 */
export function matchSavedSet(
  lock: AnyRouteLock | null | undefined,
  sets: RouteSet[] | null | undefined
): RouteSet | undefined {
  const ids = routeLockIds(lock)
  if (ids.length === 0 || !sets?.length) return undefined
  const wanted = new Set(ids)
  const scope = routeLockScope(lock)
  return sets.find(
    (set) =>
      set.scope === scope &&
      set.routes.length === wanted.size &&
      set.routes.every((route) => wanted.has(route.id))
  )
}

/** A set's routes split by whether the graph still has them. */
export function splitRunningRoutes(
  set: RouteSet,
  graphRoutes: Record<string, unknown> | null | undefined
): { missing: LockedRoute[]; running: LockedRoute[] } {
  // No index yet (still loading, or the fetch failed): say nothing is missing
  // rather than call every route of the set "not running".
  if (!graphRoutes || Object.keys(graphRoutes).length === 0) {
    return { missing: [], running: set.routes }
  }
  const running: LockedRoute[] = []
  const missing: LockedRoute[] = []
  set.routes.forEach((route) =>
    (graphRoutes[route.id] ? running : missing).push(route)
  )
  return { missing, running }
}

/** The route labels of a set in one phrase: "18, 21, Orange". */
export function routeSetLabels(set: RouteSet): string {
  return set.routes.map((route) => route.label).join(', ')
}
