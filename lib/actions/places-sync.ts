import coreUtils from '@opentripplanner/core-utils'

import { apiUrl } from '../util/api-base'
import { getDeviceId } from '../util/debug-log-boot'
import { getNativeDeviceId, getRunningBundle } from '../util/native-updates'
import {
  mergePlaces,
  parsePlacesSnapshot,
  readPlacesSnapshot,
  readPlacesState
} from '../util/places-state'
import { persistCustomPlaces, PLACES_API_PATH } from '../util/saved-places'
import { recordSessionEvent } from '../util/debug-log'

const { getItem, removeItem, storeItem } = coreUtils.storage

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
let syncId: Promise<{ id: string | null; source: string }> | null = null

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
 * The key the server copy is filed under. The native updater's id is kept
 * natively (iOS Keychain), so it outlives a localStorage wipe; the web
 * `otpDeviceId` is in the same storage as the places and would be re-minted
 * by the loss, orphaning the copy. The web id is the browser fallback only.
 */
function resolveSyncId(): Promise<{ id: string | null; source: string }> {
  if (!syncId) {
    syncId = getNativeDeviceId()
      .catch(() => null)
      .then((nativeId) =>
        nativeId
          ? { id: nativeId, source: 'native' }
          : { id: getDeviceId() || null, source: 'web' }
      )
  }
  return syncId
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
      const { id } = await resolveSyncId()
      if (!id) return false
      const response = await fetch(
        `${placesUrl(getState)}?deviceId=${encodeURIComponent(id)}`
      )
      if (!response.ok) return false
      const server = parsePlacesSnapshot(await response.json())
      // Read local only now, after the last await, so nothing the rider does
      // can land between this read and the write below.
      const local = readPlacesSnapshot()
      const pending = getItem(PENDING_KEY) === true
      const { aheadOfServer, merged, restored } = mergePlaces(
        local,
        server,
        pending
      )
      if (restored.places > 0 || restored.home || restored.work) {
        persistCustomPlaces(merged.places)
        if (restored.home) storeItem('home', merged.home)
        if (restored.work) storeItem('work', merged.work)
        restoring = true
        try {
          dispatch({ type: 'RESTORE_LOCAL_USER_PLACES' })
        } finally {
          restoring = false
        }
        emitPlacesState('restore', { restored })
      }
      reconciled = true
      if (aheadOfServer) push(getState)
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
 * After any change to the rider's places (main.js watches the user slice).
 * `places` is false for a recents-only change: beaconed, but recents are not
 * part of the server copy.
 */
export function notePlacesWrite({ places }: { places: boolean }) {
  return function (dispatch: any, getState: () => any): void {
    // The restore's own dispatch is reported by the 'restore' beacon and is
    // not a rider write.
    if (restoring) return
    emitPlacesState('write')
    if (!places) return
    if (!reconciled) {
      // The boot GET failed (or has not answered yet): try again now, and
      // push only once it has succeeded — never over a copy we have not read.
      pull(dispatch, getState).then((ok) => ok && markWritten(getState))
      return
    }
    markWritten(getState)
  }
}
