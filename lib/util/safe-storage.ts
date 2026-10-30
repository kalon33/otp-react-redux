/**
 * Every localStorage write in the app goes through here (backlog 75.12).
 *
 * A storage write can throw: QuotaExceededError when the WebView's store is
 * full, SecurityError when storage is blocked, and on some engines merely
 * touching `window.localStorage` throws. `coreUtils.storage.storeItem` lets all
 * of that through, and several of its callers are REDUCERS — on 2026-10-29 a
 * full store made `rememberLocalUserPlace`'s `storeItem('recent', …)` throw
 * inside the user reducer, the throw failed the whole dispatch, and the plan
 * callback that had dispatched it turned an answered search into ROUTING_ERROR
 * (chaos run C14). A device that cannot keep a copy is not a reason to lose the
 * answer.
 *
 * So a refused write never throws. The value is kept in memory for the rest of
 * this page session instead — `getItem`/`readRaw` here return it, so the app
 * reads back what it wrote — and the first refusal is reported once through the
 * reporter main.js registers (the debug-log session stream). A later write of
 * the same key that does reach storage drops the memory copy.
 *
 * The `otp.`-prefixed JSON functions are drop-in replacements for
 * `coreUtils.storage`'s, byte-for-byte compatible with what it stores, so a
 * key written by one is read by the other. The raw functions are for the keys
 * the app keeps outside that prefix (the diagnostics consent, the theme, the
 * language).
 *
 * No imports, on purpose: debug-log-boot.js uses this and is imported before
 * anything else in main.js, and debug-log.js (which the reporter calls into)
 * uses it too — reporting is injected rather than imported to keep both out of
 * a cycle and this module parseable by Jest.
 */

/** coreUtils.storage's key prefix — the two must agree. */
const STORAGE_PREFIX = 'otp'

export interface StorageWriteFailure {
  /** Length of the value that was refused, in UTF-16 code units. */
  chars: number
  /** The error's name: QuotaExceededError, SecurityError, ... */
  error: string
  key: string
}

/** Values storage refused, by full key. Newer than whatever storage holds. */
const memory = new Map<string, string>()

let reporter: ((failure: StorageWriteFailure) => void) | null = null
/** The first failure, held until a reporter is registered. */
let pendingFailure: StorageWriteFailure | null = null
let reported = false

function localStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage ?? null
  } catch {
    // Some engines throw SecurityError on the property read itself.
    return null
  }
}

function deliver(failure: StorageWriteFailure): void {
  if (!reporter) return
  reported = true
  pendingFailure = null
  try {
    reporter(failure)
  } catch {
    // Reporting is best-effort; it must not become the throw it is reporting.
  }
}

function noteFailure(key: string, value: string, err: unknown): void {
  if (reported || pendingFailure) return
  const failure: StorageWriteFailure = {
    chars: typeof value === 'string' ? value.length : 0,
    error:
      (err as { name?: string } | null)?.name || String(err ?? 'unavailable'),
    key
  }
  pendingFailure = failure
  deliver(failure)
}

/**
 * Where the first refused write is reported (once per page session). A failure
 * that happened before registration — reducers write while the store is being
 * created — is delivered on registration.
 */
export function setStorageFailureReporter(
  fn: ((failure: StorageWriteFailure) => void) | null
): void {
  reporter = fn
  if (pendingFailure && !reported) deliver(pendingFailure)
}

/**
 * Write a raw (unprefixed) key. Never throws. True when the value reached
 * localStorage; false when it is held in memory only (it will not survive a
 * reload).
 */
export function writeRaw(key: string, value: string): boolean {
  try {
    if (typeof window === 'undefined') throw new Error('no window')
    // Not localStore(): the error from the property read itself
    // (SecurityError) is the one worth reporting.
    window.localStorage.setItem(key, value)
    memory.delete(key)
    return true
  } catch (err) {
    memory.set(key, value)
    noteFailure(key, value, err)
    return false
  }
}

/** Read a raw key: a value held in memory first, then storage. Never throws. */
export function readRaw(key: string): string | null {
  if (memory.has(key)) return memory.get(key) as string
  try {
    return localStore()?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** Remove a raw key from memory and storage. Never throws. */
export function removeRaw(key: string): void {
  memory.delete(key)
  try {
    localStore()?.removeItem(key)
  } catch {
    // Nothing to remove from a store that cannot be reached.
  }
}

const prefixed = (key: string) => `${STORAGE_PREFIX}.${key}`

/**
 * `coreUtils.storage.storeItem`, minus the throw: JSON under `otp.<key>`.
 * Returns whether the value reached localStorage (see writeRaw).
 */
export function storeItem(key: string, object: unknown): boolean {
  // String() keeps coreUtils' bytes for `undefined` too ("undefined", which
  // reads back as not-found).
  return writeRaw(prefixed(key), String(JSON.stringify(object)))
}

/**
 * `coreUtils.storage.getItem`, reading through the memory copy. Same contract:
 * a falsy or unparseable value reads as `notFoundValue`.
 */
export function getItem<T = any>(key: string, notFoundValue: T | null = null): T | null {
  let itemAsString: string | null = null
  try {
    itemAsString = readRaw(prefixed(key))
    const json = JSON.parse(itemAsString as string)
    if (json) return json
    return notFoundValue
  } catch (e) {
    // Bad JSON — the same warning coreUtils gives.
    console.warn(e, itemAsString)
    return notFoundValue
  }
}

/** `coreUtils.storage.removeItem`, memory copy included. */
export function removeItem(key: string): void {
  removeRaw(prefixed(key))
}

/**
 * Whether `otp.<key>` is actually in localStorage — not the memory copy. For a
 * caller that skips unchanged writes and must notice the stored copy vanishing
 * underneath it (75.12 (b): the OS evicting WebView storage mid-trip).
 */
export function isPersisted(key: string): boolean {
  try {
    return localStore()?.getItem(prefixed(key)) != null
  } catch {
    return false
  }
}

/** Test-only: forget the memory copies and the once-only report. */
export function resetSafeStorageForTests(): void {
  memory.clear()
  reporter = null
  pendingFailure = null
  reported = false
}
