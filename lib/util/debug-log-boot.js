/**
 * Boot-time crash telemetry — and the identity/consent primitives that the
 * ordinary debug-log stream shares with it.
 *
 * WHY THIS IS ITS OWN MODULE, AND WHY main.js IMPORTS IT FIRST.
 *
 * On 2026-09-02 the OTA bundle `2026.0902.3` white-screened the rider's iPhone
 * and the device wrote ZERO records to the sink for the whole incident —
 * `/home/rwt/otp-debug-logs/debug-2026-09-02.jsonl` has nothing from it, not
 * even the `start` session event. The white screen was diagnosed a different
 * way (a legacy `routeLock` shape thrown out of a render) and only because the
 * exact URL could be reconstructed by hand from the PREVIOUS day's log.
 *
 * The reason there was nothing to read is structural, and `debug-log.js` cannot
 * fix it from where it sits:
 *
 *   * `startDebugLog()` is a STATEMENT in `main.js`, so every one of that
 *     module's imports — the config, the store, the whole component tree — has
 *     already been evaluated before any error handler exists. A throw at module
 *     evaluation time is therefore invisible by construction.
 *   * Even once installed, the stream is BUFFERED: entries wait up to
 *     `FLUSH_INTERVAL_MS` (3 s) for the interval to come round. A rider looking
 *     at a blank screen force-quits well inside 3 s, and an iOS force-quit
 *     fires no `pagehide`, so the buffer dies with the webview.
 *
 * So this module does the two things that survive both: it is imported for its
 * side effect BEFORE anything that can throw, and it sends with
 * `navigator.sendBeacon`, which the browser completes even if the page is
 * already going away. One beacon, sent the instant the error fires, is worth
 * more than a session's worth of buffer that never leaves.
 *
 * It also owns the session id, the device id and the consent gate. Those used
 * to live in `debug-log.js`; they moved HERE rather than being copied, because
 * a boot crash written under a different session id than the ride it killed is
 * two unrelated records, and a second copy of the consent rule is a second
 * chance to get consent wrong. `debug-log.js` imports them back.
 *
 * Constraints, in the same spirit as the rest of the sink:
 *   * It must never throw into the app. Every path here swallows its own errors
 *     — a diagnostics module that breaks a boot is worse than no diagnostics.
 *   * It has no imports beyond `debug-log-entry` (pure, no side effects, no
 *     `import.meta`), so importing it first cannot itself be the thing that
 *     fails.
 *   * Consent is the same rule as the stream's: nothing is sent unless this
 *     device has opted in (or is the native shell, which defaults on).
 *   * No PII beyond what the sink already stores. localStorage is reported as
 *     KEY NAMES AND SIZES only — never values; the saved trip, the rider's
 *     places and their query history all live in there.
 */

import { createEntryIdMinter } from './debug-log-entry'

const CONSENT_KEY = 'otpDebugLog'
// A session id is minted per app start; this one names the PHONE and outlives
// them, so the ride console can ask "which ride is mine". Read (and minted)
// here rather than in debug-log.js so a crash beacon sent before that module
// evaluates still carries it.
const DEVICE_ID_KEY = 'otpDeviceId'

// A beacon body shares the browser's ~64KB sendBeacon quota, and an oversized
// beacon is refused SILENTLY (sendBeacon returns false) — which for a crash
// report means losing the one record the incident produced. Stay well under.
const MAX_BOOT_BEACON_BYTES = 60000
// A stack from a minified bundle is long and the useful part is the top.
const MAX_STACK_CHARS = 4000
// Enough to see the shape of what the boot was reading. Names and byte counts
// only — see the note above about values.
const MAX_STORAGE_KEYS = 40
const MAX_STORAGE_KEY_CHARS = 64
// A boot that throws usually throws repeatedly (React re-renders, a poller
// retries). Three beacons are enough to see the first failure and whether it
// recurred; more is uplink spent on a phone that is already in trouble.
const MAX_BOOT_ERRORS = 3

function mintSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

let sessionId = mintSessionId()
// One dense counter across BOTH paths (this module's beacons and the stream's
// buffered entries), so a gap in a session's entry ids still means real loss
// rather than "the other path minted that one".
let mintEntryId = createEntryIdMinter(sessionId)

/** The id this app start is writing under. */
export function bootSessionId() {
  return sessionId
}

/** The next stable per-entry id for this app start. See debug-log-entry.js. */
export function mintBootEntryId() {
  return mintEntryId()
}

/**
 * Continue writing under a previous app start's session id (a ride the app
 * re-mounted inside). The load tag keeps the two loads' entry ids distinct so
 * the sink's dedupe does not mistake the second load for a re-send of the
 * first. See debug-log.js adoptSessionId, which is the only caller.
 */
export function setBootSessionId(priorSessionId, loadTag) {
  sessionId = priorSessionId
  mintEntryId = createEntryIdMinter(priorSessionId, loadTag)
}

function readDeviceId() {
  try {
    if (typeof window === 'undefined') return undefined
    const existing = window.localStorage?.getItem(DEVICE_ID_KEY)
    if (existing) return existing
    const minted = `dev-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`
    window.localStorage?.setItem(DEVICE_ID_KEY, minted)
    return minted
  } catch {
    // Private mode, storage disabled: the console falls back to its
    // single-rider path, which is what it did before this existed.
    return undefined
  }
}

const deviceId = readDeviceId()

/** This device's durable id, for the "open the ride console" link. */
export function getDeviceId() {
  return deviceId
}

/**
 * Whether this device has opted into sharing diagnostics.
 *
 * Browsers are opt-in (the app-menu "Share diagnostics" toggle, or
 * `?debugLog=1`). The NATIVE shell defaults ON when no choice is stored — a
 * ride that goes unrecorded cannot be replayed, and the 2026-07-22 evening ride
 * was lost to an un-flipped toggle — and the same toggle ('0') opts out.
 */
export function isDiagnosticsEnabled() {
  try {
    if (typeof window === 'undefined') return false
    const stored = window.localStorage?.getItem(CONSENT_KEY)
    if (stored === '1') return true
    if (stored === '0') return false
    return !!window.Capacitor?.isNativePlatform?.()
  } catch {
    // Storage unavailable → no consent recorded → stay off.
    return false
  }
}

/**
 * `?debugLog=1` / `?debugLog=0` persists the choice, so the dev harness and web
 * testers can opt a browser in without hunting for the menu toggle.
 *
 * Applied HERE, at first import, rather than only in `startDebugLog()`: a boot
 * that crashes never reaches that call, and the whole point of opening the app
 * with `?debugLog=1` is usually to catch exactly that boot.
 */
export function applyDebugLogUrlOverride() {
  try {
    const v = new URLSearchParams(window.location.search).get('debugLog')
    if (v === '1' || v === '0') window.localStorage?.setItem(CONSENT_KEY, v)
  } catch {
    // best-effort
  }
}

// --- boot crash capture ------------------------------------------------------

const bootAt = Date.now()

let config = null
let installed = false
let sealed = false
let bootErrorsSent = 0
let brokeDuringBoot = false
let bundleVersion = null

/**
 * Record which live-update bundle is running, so a crash report names the
 * bundle that produced it. Set asynchronously (the plugin call is a promise),
 * so a crash in the first tick may legitimately have no bundle — that absence
 * is itself informative and is left as `undefined` rather than guessed at.
 */
export function noteBundleVersion(version) {
  if (typeof version === 'string' && version) bundleVersion = version
}

/**
 * Did anything raise a window `error` / `unhandledrejection` since boot?
 *
 * This is the reader `confirmBundleHealthyWhenStable` uses instead of
 * installing a second pair of listeners: these were armed at the FIRST import,
 * so they also see the errors thrown between module evaluation and the moment
 * the health gate is armed — a window that the gate's own listeners are blind
 * to, and one that contains `render()`.
 */
export function bootBroke() {
  return brokeDuringBoot
}

/**
 * Stop treating errors as boot failures: the bundle has been confirmed healthy,
 * so anything from here on is an ordinary in-app error and the buffered stream
 * (which is running by now) is the right place for it. Beacons are expensive on
 * a phone and there is no page-death race left to win.
 */
export function sealBootCrashCapture() {
  sealed = true
}

function storageInventory() {
  try {
    const ls = window.localStorage
    if (!ls) return undefined
    const out = []
    const count = Math.min(ls.length, MAX_STORAGE_KEYS)
    for (let i = 0; i < count; i++) {
      const key = ls.key(i)
      if (key == null) continue
      // NAME AND SIZE ONLY. The saved Go Mode trip, the rider's places and
      // their recent queries all live in here; the diagnosis needs to know
      // which of them the boot was reading and how big it was, never what it
      // said.
      out.push({
        k: key.slice(0, MAX_STORAGE_KEY_CHARS),
        n: ls.getItem(key)?.length ?? 0
      })
    }
    return out
  } catch {
    return undefined
  }
}

function buildBody(entries) {
  return JSON.stringify({
    build: config?.build,
    deviceId,
    entries,
    href: typeof window !== 'undefined' ? window.location?.href : undefined,
    sessionId,
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : undefined
  })
}

/**
 * Send one entry to the sink RIGHT NOW, by beacon, and say whether the browser
 * took it.
 *
 * `sendBeacon` rather than `fetch`: the browser owns the request from here, so
 * it still completes after the page is torn down. That is the entire point —
 * the case this exists for is a rider force-quitting a blank app.
 *
 * The batch envelope is deliberately the same shape `debug-log.js` sends
 * (build / deviceId / entries / href / sessionId / ua), so the server handler
 * needs no change at all: `/api/debug-log` already parses `text/plain` bodies
 * (`force=True`, for exactly this beacon path) and writes whatever keys an
 * entry carries.
 */
export function sendBootBeacon(entry) {
  try {
    if (!config) return false
    if (!isDiagnosticsEnabled()) return false
    if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false
    const full = { ...entry, id: mintBootEntryId(), t: Date.now() }
    let body = buildBody([full])
    if (body.length > MAX_BOOT_BEACON_BYTES) {
      // Shed the optional bulk rather than lose the record: the inventory is
      // context, the message and the top of the stack are the report.
      delete full.storage
      if (typeof full.stack === 'string') full.stack = full.stack.slice(0, 1000)
      body = buildBody([full])
    }
    if (body.length > MAX_BOOT_BEACON_BYTES) return false
    return !!navigator.sendBeacon(
      config.endpoint,
      // text/plain, not application/json: a beacon cannot preflight, and
      // text/plain is the only type allowed cross-origin — which the native
      // app, running from capacitor://localhost, always is.
      new Blob([body], { type: 'text/plain' })
    )
  } catch {
    // best-effort, always
    return false
  }
}

/** A one-off session-scoped fact that must not wait for the 3 s flush. */
export function sendBootSessionEvent(event, fields) {
  return sendBootBeacon({ ...fields, event, kind: 'session' })
}

function captureBootError(kind, fields) {
  brokeDuringBoot = true
  if (sealed || bootErrorsSent >= MAX_BOOT_ERRORS) return
  bootErrorsSent++
  sendBootBeacon({
    ...fields,
    bundle: bundleVersion ?? undefined,
    kind,
    sinceBootMs: Date.now() - bootAt,
    stack:
      typeof fields.stack === 'string'
        ? fields.stack.slice(0, MAX_STACK_CHARS)
        : undefined,
    storage: storageInventory()
  })
}

/**
 * Arm the boot crash path. Called for its side effect by
 * `debug-log-boot-install.js`, which `main.js` imports before anything else.
 *
 * `endpoint` and `build` are arguments rather than read from `import.meta`
 * here, so this module stays parseable by Jest (see debug-log-batch.js for the
 * same split, and the same reason).
 */
export function installBootCrashCapture(options) {
  if (typeof window === 'undefined') return
  if (installed) return
  installed = true
  config = { build: options?.build, endpoint: options?.endpoint }
  applyDebugLogUrlOverride()
  window.addEventListener('error', (e) => {
    captureBootError('boot-error', {
      col: e?.colno,
      line: e?.lineno,
      message: e?.message,
      source: e?.filename,
      stack: e?.error?.stack
    })
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e?.reason
    captureBootError('boot-rejection', {
      message: r?.message || String(r),
      stack: r?.stack
    })
  })
}
