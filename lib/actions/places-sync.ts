import { apiUrl } from '../util/api-base'
import { getDeviceId } from '../util/debug-log-boot'
import { getItem, removeItem, storeItem } from '../util/safe-storage'
import { getNativeDeviceId, getRunningBundle } from '../util/native-updates'
import { getPlacesKey } from '../util/places-key'
import {
  isEmptySnapshot,
  mergePlaces,
  parsePlacesSnapshot,
  PlacesSnapshot,
  readPlacesSnapshot,
  readPlacesState
} from '../util/places-state'
import { persistCustomPlaces, PLACES_API_PATH } from '../util/saved-places'
import { persistRouteSets } from '../util/route-sets'
import { recordSessionEvent } from '../util/debug-log'

/**
 * Backlog 28.1 — "My places keep disappearing!" (2026-09-22 21:28).
 *
 * Two halves, in the order the row asks for them:
 *
 * 1. MEASURE. One `PLACES_STATE` record on the debug sink at boot and after
 *    every places write — counts and key presence only (util/places-state) —
 *    so the next loss is attributable to a bundle, a boot or a write.
 * 2. KEEP A COPY. After a write, POST {deviceId, places, home, work} to the
 *    sidecar (debounced); at boot, GET it back and merge (mergePlaces: local
 *    wins, the server only fills). Places then survive whatever is clearing
 *    the key.
 *
 * Backlog 60.1 (cycle 31): the copy is filed under the installed app's fixed
 * key when the shell has one (util/places-key — every recorded dev-app reset
 * re-minted both device ids, orphaning a copy under either), and it carries
 * the recent places too (the only thing those resets actually took). The
 * first key-bearing launch moves the old copy over (see pull).
 *
 * FAIL CLOSED, both ways. A network error leaves local state exactly as it is.
 * And nothing is POSTed until one GET has succeeded this launch: a phone whose
 * key was wiped and whose boot GET failed would otherwise push its empty (or
 * one-new-place) list over the good server copy on the rider's next save —
 * the copy would be destroyed by the very loss it exists to undo.
 */

/**
 * Set while a local write has not been acknowledged by the server (so the
 * difference at the next boot is a delete, not a loss — see mergePlaces).
 * Written only after a successful GET, for the reason above.
 */
const PENDING_KEY = 'placesSyncPending'

/** How long a burst of edits settles before the one POST that covers it. */
export const PLACES_PUSH_DEBOUNCE_MS = 2000

let reconciled = false
let pullInFlight: Promise<boolean> | null = null
let pushTimer: ReturnType<typeof setTimeout> | null = null
let writeSeq = 0
let restoring = false
let bundleVersion: Promise<string | null> | null = null

/**
 * Where the server copy is filed. `id` is the app key when the installed app
 * has one, else the device id; `legacyId` is the device id the copy was filed
 * under before the key existed (only set when it differs from `id`), read
 * once to migrate it. NEITHER id is ever beaconed — `source` is.
 */
type SyncId = { id: string | null; legacyId: string | null; source: string }
let syncId: Promise<SyncId> | null = null

/** Test seam: module state is per-launch, and every test is a launch. */
export function resetPlacesSyncForTests(): void {
  reconciled = false
  pullInFlight = null
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = null
  writeSeq = 0
  restoring = false
  bundleVersion = null
  syncId = null
}

/** The running OTA bundle, as the `bundle` session event reports it. */
function runningBundle(): Promise<string | null> {
  if (!bundleVersion) {
    bundleVersion = getRunningBundle()
      .then((b) => b?.version ?? null)
      .catch(() => null)
  }
  return bundleVersion
}

/**
 * The key the server copy is filed under, in order:
 * 1. the installed app's fixed per-app key (60.1) — survives the resets that
 *    re-mint both ids below;
 * 2. the native updater's id, kept in the iOS Keychain, so it outlives a
 *    localStorage wipe (but not a dev-app reset — 44.1);
 * 3. the web `otpDeviceId` — the browser fallback only (it lives in the same
 *    storage as the places and is re-minted by the loss).
 */
function resolveSyncId(): Promise<SyncId> {
  if (!syncId) {
    syncId = Promise.all([
      getPlacesKey().catch(() => null),
      getNativeDeviceId().catch(() => null)
    ]).then(([appKey, nativeId]) => {
      const deviceId = nativeId || getDeviceId() || null
      if (appKey) {
        return {
          id: appKey,
          legacyId: deviceId && deviceId !== appKey ? deviceId : null,
          source: 'app-key'
        }
      }
      return {
        id: deviceId,
        legacyId: null,
        source: nativeId ? 'native' : 'web'
      }
    })
  }
  return syncId
}

/**
 * GET one server copy. null on any failure (network, non-2xx, bad JSON) —
 * which every caller treats as "not reconciled", never as "empty".
 */
async function fetchCopy(
  getState: () => any,
  id: string
): Promise<PlacesSnapshot | null> {
  const response = await fetch(
    `${placesUrl(getState)}?deviceId=${encodeURIComponent(id)}`
  )
  if (!response.ok) return null
  return parsePlacesSnapshot(await response.json())
}

/**
 * Whether recent places are tracked on this phone (the rider's opt-in, or the
 * deployment's default). An opted-out phone neither restores recents from the
 * copy nor counts the copy's recents as something to push.
 */
function tracksRecents(getState: () => any): boolean {
  return !!getState()?.user?.localUser?.storeTripHistory
}

function placesUrl(getState: () => any): string {
  return getState()?.otp?.config?.placesApiUrl || apiUrl(PLACES_API_PATH)
}

async function emitPlacesState(
  trigger: string,
  extra?: Record<string, unknown>
): Promise<void> {
  try {
    const [bundle, { source }] = await Promise.all([
      runningBundle(),
      resolveSyncId()
    ])
    recordSessionEvent('PLACES_STATE', {
      ...readPlacesState(),
      bundle,
      idSource: source,
      trigger,
      ...extra
    })
  } catch {
    // Telemetry never breaks the app.
  }
}

async function push(getState: () => any): Promise<void> {
  if (!reconciled) return
  const seq = writeSeq
  try {
    const { id } = await resolveSyncId()
    if (!id) return
    const response = await fetch(placesUrl(getState), {
      body: JSON.stringify({ deviceId: id, ...readPlacesSnapshot() }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    })
    // Only a write the server has now seen clears the flag; a write that
    // landed while this POST was in flight has its own push coming.
    if (response.ok && seq === writeSeq) removeItem(PENDING_KEY)
  } catch {
    // Offline: the flag stays set and the next write (or launch) retries.
  }
}

function schedulePush(getState: () => any): void {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    push(getState)
  }, PLACES_PUSH_DEBOUNCE_MS)
}

/** A places write this launch, now safe to push: flag it and schedule. */
function markWritten(getState: () => any): void {
  writeSeq += 1
  try {
    storeItem(PENDING_KEY, true)
  } catch {
    // Storage refused: the push below still carries the write.
  }
  schedulePush(getState)
}

/**
 * GET the server copy and merge it in. Resolves true once this launch is
 * reconciled with the server; false (state untouched) on any failure.
 */
function pull(dispatch: any, getState: () => any): Promise<boolean> {
  if (reconciled) return Promise.resolve(true)
  if (pullInFlight) return pullInFlight
  pullInFlight = (async () => {
    try {
      const { id, legacyId } = await resolveSyncId()
      if (!id) return false
      let server = await fetchCopy(getState, id)
      if (!server) return false
      // One-time move to the app key (60.1): while the copy under the key is
      // empty, the copy under the old device id is read and merged in, and
      // the result is pushed under the key below. No flag: once the key's
      // copy holds anything this never runs again; a failed read of the old
      // copy fails the whole pull (the next write or launch retries), so the
      // key's copy is never seeded from a phone that has not seen the old one.
      let migrated = false
      if (legacyId && isEmptySnapshot(server)) {
        const legacy = await fetchCopy(getState, legacyId)
        if (!legacy) return false
        if (!isEmptySnapshot(legacy)) {
          server = legacy
          migrated = true
        }
      }
      if (!tracksRecents(getState)) {
        server = { ...server }
        delete server.recent
      }
      // Read local only now, after the last await, so nothing the rider does
      // can land between this read and the write below.
      const local = readPlacesSnapshot()
      const pending = getItem(PENDING_KEY) === true
      const { aheadOfServer, merged, restored } = mergePlaces(
        local,
        server,
        pending
      )
      const restoredSets = (restored.routeSets || 0) > 0
      const restoredRecent = (restored.recent || 0) > 0
      if (
        restored.places > 0 ||
        restored.home ||
        restored.work ||
        restoredSets ||
        restoredRecent
      ) {
        persistCustomPlaces(merged.places)
        if (restored.home) storeItem('home', merged.home)
        if (restored.work) storeItem('work', merged.work)
        if (restoredSets) persistRouteSets(merged.routeSets || [])
        if (restoredRecent) storeItem('recent', merged.recent || [])
        restoring = true
        try {
          dispatch({ type: 'RESTORE_LOCAL_USER_PLACES' })
        } finally {
          restoring = false
        }
        emitPlacesState('restore', { restored })
      }
      reconciled = true
      // A migrated copy is not yet under the key, whatever the comparison
      // with the old copy says.
      if (aheadOfServer || migrated) push(getState)
      return true
    } catch {
      return false
    } finally {
      pullInFlight = null
    }
  })()
  return pullInFlight
}

/**
 * At boot, once the store exists: the boot beacon, then the restore.
 */
export function startPlacesSync() {
  return async function (dispatch: any, getState: () => any): Promise<void> {
    await emitPlacesState('boot')
    await pull(dispatch, getState)
  }
}

/**
 * After any change to the rider's places (main.js watches the user slice):
 * saved places, saved route sets (58.2) and — since 60.1 — recent places all
 * ride in the same copy, so every write is beaconed and pushed.
 */
export function notePlacesWrite() {
  return function (dispatch: any, getState: () => any): void {
    // The restore's own dispatch is reported by the 'restore' beacon and is
    // not a rider write.
    if (restoring) return
    emitPlacesState('write')
    if (!reconciled) {
      // The boot GET failed (or has not answered yet): try again now, and
      // push only once it has succeeded — never over a copy we have not read.
      pull(dispatch, getState).then((ok) => ok && markWritten(getState))
      return
    }
    markWritten(getState)
  }
}

/**
 * main.js's watcher: every change to the rider's places — a save, an edit, a
 * delete, a recent, a saved route set — is beaconed and copied to the server
 * (recents too since 60.1). Watched from outside the reducer, which must stay
 * pure of network; the user slice's arrays are replaced on every write
 * (immutability-helper), so a reference check is the whole test.
 */
export function watchPlacesWrites(store: {
  dispatch: (action: any) => any
  getState: () => any
  subscribe: (listener: () => void) => () => void
}): () => void {
  const slice = () => store.getState().user?.localUser || {}
  let last = slice()
  return store.subscribe(() => {
    const now = slice()
    if (
      now.savedLocations === last.savedLocations &&
      now.recentPlaces === last.recentPlaces &&
      now.routeSets === last.routeSets
    ) {
      return
    }
    last = now
    store.dispatch(notePlacesWrite())
  })
}
