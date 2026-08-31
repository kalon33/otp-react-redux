/**
 * Remote debug-log sink for Go Mode diagnosis.
 *
 * Streams the full Redux action stream (with a compact state digest per action)
 * plus JS errors / unhandled rejections / console.error|warn to a same-origin
 * endpoint (/api/debug-log) that nginx proxies to a small Flask service, which
 * appends JSONL to disk. The point: when the rider hits a problem ("Start Trip
 * does nothing"), the exact sequence of actions that led there can be read off
 * the server directly instead of reproduced by hand.
 *
 * Design constraints:
 * - Best-effort and non-blocking: it batches and must NEVER throw into the app
 *   or block dispatch/rendering. Every public path swallows its own errors.
 * - Same-origin POST behind the site's existing auth gate; nothing secret is in
 *   the client and nothing secret is logged.
 * - Bounded: a ring buffer caps memory, big action payloads are summarised, and
 *   flushes are throttled. On page hide we flush via sendBeacon so the tail of a
 *   session isn't lost.
 * - CONSENT: browsers capture nothing unless localStorage.otpDebugLog === '1'
 *   (the app-menu "Share diagnostics" toggle or ?debugLog=1). The NATIVE shell
 *   (internal TestFlight) defaults ON when no choice is stored — every ride
 *   should be replayable — and the same toggle ('0') opts a device out.
 */

import { selectBatch } from './debug-log-batch'
import FULL_CAPTURE_TYPE_LIST from './full-capture-types.json'

// Web builds leave VITE_API_BASE_URL unset (same-origin, behind the auth
// gate). The bundled native app runs from capacitor://localhost, so its build
// sets the base to the server's absolute URL and the endpoint goes cross-origin
// (the server allows it — CORS via Flask, no auth, rate-limited).
const API_BASE =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) ||
  ''
// Stamped by CI (testflight.yml / ios-build.yml) as "1.0.<build> web:<sha>";
// absent in dev and plain web builds. Carried on every batch so a log file is
// attributable to the exact app build that produced it.
const BUILD_INFO =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_BUILD_INFO) ||
  'dev'
const ENDPOINT = `${API_BASE}/api/debug-log`
const FLUSH_INTERVAL_MS = 3000
const MAX_BUFFER = 400 // ring-buffer cap (entries kept if a flush keeps failing)
// Byte-aware batch selection lives in debug-log-batch.js (Jest can't parse
// this module's import.meta, so the testable pieces are split out).
const MAX_PAYLOAD_CHARS = 4000 // per-action payload; larger ones are summarised

// Trip-recording mode (opt-in): when the rider takes a Go Mode trip with
// recording on, a whitelist of action types is captured in FULL (bypassing the
// MAX_PAYLOAD_CHARS summary) so the trip can later be replayed offline &
// deterministically. Everything else, and every non-recording session, is
// unchanged. See lib/util/go-mode/replay/build-fixture.js for the consumer.
//
// The payloads below are exactly the inputs that drive Go Mode: the activated
// itinerary (START_GO_MODE), the itinerary/reroute plans (ROUTING_RESPONSE), the
// realtime vehicle-position series (re-fetched every ~15s, so the series falls
// out of the action stream on its own once un-truncated), and the arrival
// predictions (FIND_STOP_TIMES_FOR_STOP_RESPONSE — fetched once per stop at trip
// start, so it's a single snapshot; prediction drift is not captured).
// The list itself lives in full-capture-types.json because build-fixture.js —
// a plain CommonJS Node script that cannot import this ESM module — needs the
// identical set to know which payloads a fixture requires un-stubbed. It kept
// its own copy until 2026-08-27, by which point the copy had drifted three
// types behind (STOP_GO_MODE, REROUTE_SNAPSHOT, ONBOARD_CANDIDATE_SNAPSHOT), so
// the recorder captured payloads the fixture builder never looked for. JSON is
// the one format both sides can read, which makes that drift impossible rather
// than merely detectable.
//
// Why each type is on the list:
//   START_GO_MODE                       the activated itinerary
//   ROUTING_RESPONSE                    the itinerary / reroute plans
//   REALTIME_VEHICLE_POSITIONS_RESPONSE the vehicle series (re-fetched ~15s, so
//                                       it falls out of the stream on its own)
//   FIND_STOP_TIMES_FOR_STOP_RESPONSE   arrival predictions — one snapshot per
//                                       stop at trip start; drift not captured
//   FIND_TRIP_RESPONSE / STOP_GO_MODE   trip identity and the trip bracket
//   REROUTE_SNAPSHOT                    the periodic "alternatives to finish the
//                                       trip" pair (captureRerouteSnapshot)
//   SET_ONBOARD_TRIP / SET_ONBOARD_RESULT
//     the onboard ("I'm already on a bus") flow's two inputs — exactly what
//     buildOnboardItinerary consumes. Without them a trip entered that way
//     replays only from START_GO_MODE, which on 2026-08-02 meant the fixture
//     began at the already-split itinerary and could not reproduce the split.
//   ONBOARD_CANDIDATE_SNAPSHOT
//     the onward plans an onboard optimize ranks, one per candidate alight
//     stop. SET_ONBOARD_RESULT is the OUTPUT; this is the input it was computed
//     from. They resolve through a local promise in fetchOnboardCandidatePlan
//     and never dispatch ROUTING_RESPONSE, so nothing recorded them before —
//     which on 2026-08-09 forced the backwards-itinerary proof to be a unit
//     test rather than a replay gate.
const FULL_CAPTURE_TYPES = new Set(FULL_CAPTURE_TYPE_LIST)
// Size ceilings for the record path, chosen to survive the whole pipeline.
// They are ONE LADDER and must move together, strictly increasing:
//
//   client payload <= MAX_FULL_PAYLOAD_CHARS  (1,000,000, here)
//     < Flask line <= DEBUG_LOG_MAX_LINE_CHARS (1,179,648, transitnav/preferences_api.py)
//       < flush body <= MAX_BODY_BYTES         (1,400,000, here)
//         < nginx body <= client_max_body_size (1536k, otp-minneapolis
//                         config/nginx/otp-common.conf AND deployment/nginx/otp-common.conf)
//
// scripts/check-config-ladder.py in otp-minneapolis parses all four out of
// these real files and fails if that order ever breaks — raising one rung
// alone does not remove the loss, it relocates it one hop (the Flask cap
// swaps an over-long line for a __truncated_chars stub instead), and the
// symptom is a stubbed payload nobody notices for weeks.
//
// A single full payload larger than the ceiling falls back to the summary stub.
// Note the last rung is a hard one: a body over the nginx cap is answered 413,
// which fetch() RESOLVES, so flush() splices the batch away. Past that point an
// oversized entry is not merely stubbed — it is uploaded in full and then
// discarded at the edge. MAX_BODY_BYTES must stay under it with room for the
// batch wrapper.
//
// Sizing history, all from real rides:
//   200k was too low twice on 2026-08-27: both rides recorded a START_GO_MODE
//   of 270,837 chars (a six-leg itinerary with full geometry) and both
//   collapsed to the stub, so neither trip could be replayed and the worst Go
//   Mode bug of the day had to be diagnosed from the action stream by hand.
//   270,837 also exceeded the then-256k Flask cap, which is why that moved too.
//
//   320k was then too low on 2026-08-28. The evening ride (session
//   mtdh67f3-0z5p24, 16:40-17:44) lost 30 whitelisted payloads to the stub —
//   24 REROUTE_SNAPSHOT and 6 ONBOARD_CANDIDATE_SNAPSHOT, spanning 324,012 to
//   865,300 chars — so its reroutes could not be reproduced. 08-27 lost 54 more
//   (max 414,240). 1,000,000 is the smallest round ceiling that clears the
//   largest of them with headroom; every genuine full-capture loss observed
//   across 08-27, 08-28 and 08-29 fits under it.
//
// The cost is real and is paid by a phone on cellular: recovering those 30
// payloads adds ~13 MB of uplink to a 64-minute ride. It is bounded — the
// ceiling only applies to whitelisted types while a recorded Go Mode trip is
// active (isRecordingTrip), and record mode is opt-in. Every other action is
// still capped at MAX_PAYLOAD_CHARS (4k), so ordinary sessions are unaffected.
const MAX_FULL_PAYLOAD_CHARS = 1000000
// Keep a flush body under the nginx cap even when it carries one full-capture
// payload plus the batch wrapper; a body over that cap is 413'd and, because
// fetch() treats 413 as a resolved response, dropped rather than retried.
const MAX_BODY_BYTES = 1400000
// sendBeacon bodies share a ~64KB browser quota — a bigger beacon is silently
// dropped (returns false), losing the tail of the session. Cap well under it.
const BEACON_MAX_BODY_BYTES = 60000

const buffer = []
let started = false

// Cached per (re)start: is trip-recording on for this session? Recording only
// applies once diagnostics itself is opted in (readRecordFlag is never
// consulted otherwise) — within an opted-in session it defaults ON, because
// the whole point of opting a device in is capturing real trips for replay
// (losing a trip to a missing URL flag is worse than the small extra payload).
// Opt out of just the full-capture with ?recordTrip=0 or
// localStorage.otpRecordTrip === '0'. The actual full-capture also requires
// a Go Mode trip to be active — see isRecordingTrip().
let recordFlag = false
function readRecordFlag() {
  try {
    if (typeof window === 'undefined') return false
    if (window.localStorage?.getItem('otpRecordTrip') === '0') return false
    return new URLSearchParams(window.location.search).get('recordTrip') !== '0'
  } catch {
    // Storage/URL access failing must not silently disable recording for an
    // opted-in device — default-ON within an opted-in session is the intent.
    return true
  }
}

/** Full-fidelity capture only while a Go Mode trip is actually active. */
function isRecordingTrip(state) {
  return recordFlag && state?.otp?.goMode?.isActive === true
}

/**
 * Whether trip-recording is opted in for this session (the flag half of
 * isRecordingTrip). Lets Go Mode gate recording-only work — e.g. the periodic
 * reroute-snapshot capture — so normal trips do no extra work.
 */
export function isTripRecordingEnabled() {
  return recordFlag
}

const sessionId = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`

// A session id is minted per app start. The ride console needs something that
// outlives them: it is a bookmark on the rider's own phone, opened between
// trips, and it cannot know which run of the app is current. This id is minted
// once per device and kept, so the server can answer "which ride belongs to
// this console" — without it, /api/ride-status can only serve whoever wrote
// last, which with two riders out is the other one.
//
// Not a credential and not personal: a random string that names a phone to a
// server that is already receiving that phone's trip telemetry.
const DEVICE_ID_KEY = 'otpDeviceId'

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

function isEnabled() {
  try {
    if (typeof window === 'undefined') return false
    const stored = window.localStorage?.getItem('otpDebugLog')
    if (stored === '1') return true
    if (stored === '0') return false
    // No stored choice: the native (internal TestFlight) build defaults ON —
    // a ride that goes unrecorded can't be replayed, and the 7/22 evening ride
    // was lost to an un-flipped toggle. The menu toggle remains as the
    // opt-out. Browsers stay opt-in.
    return !!window.Capacitor?.isNativePlatform?.()
  } catch {
    // Storage unavailable → no consent recorded → stay off.
    return false
  }
}

// ?debugLog=1 / ?debugLog=0 persists the choice, so the dev harness and web
// testers can opt a browser in without hunting for the menu toggle. (The
// native app has no URL bar — it uses the app-menu toggle.)
function applyUrlOverride() {
  try {
    const v = new URLSearchParams(window.location.search).get('debugLog')
    if (v === '1' || v === '0') window.localStorage?.setItem('otpDebugLog', v)
  } catch {
    // best-effort
  }
}

/** Whether this device has opted into sharing diagnostics (for toggle UIs). */
const NOTICE_KEY = 'otpDebugLogNoticeSeen'

/**
 * Whether to tell this rider, once, that their trips are being recorded.
 *
 * The native build defaults diagnostics ON (see isEnabled) because an
 * unrecorded ride cannot be replayed, and that default is worth keeping. But it
 * was decided when the only phone running this build was the author's. Anyone
 * else installing it would have their GPS trace streamed to someone else's
 * server having never been asked — a default nobody consented to is a different
 * thing from a default they declined to change.
 *
 * So: keep the default, and say so plainly the first time. Only shown where the
 * default actually applies — a rider who has already chosen either way has
 * answered the question, and browsers are opt-in so there is nothing to
 * disclose.
 */
export function shouldShowDiagnosticsNotice() {
  try {
    if (typeof window === 'undefined') return false
    if (!window.Capacitor?.isNativePlatform?.()) return false
    if (window.localStorage?.getItem('otpDebugLog') != null) return false
    return window.localStorage?.getItem(NOTICE_KEY) !== '1'
  } catch {
    return false
  }
}

/** Record that the notice has been shown, so it never appears again. */
export function acknowledgeDiagnosticsNotice() {
  try {
    window.localStorage?.setItem(NOTICE_KEY, '1')
  } catch {
    // Storage unavailable: showing it again is a smaller harm than crashing.
  }
}

export function isDebugLogEnabled() {
  return isEnabled()
}

/** The CI-stamped build identifier ("1.0.<n> web:<sha>"), or "dev". */
export function getBuildInfo() {
  return BUILD_INFO
}

function push(entry) {
  if (!isEnabled()) return
  entry.t = Date.now()
  buffer.push(entry)
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
}

/**
 * Record a one-off session-scoped fact (which live-update bundle is running,
 * say). Same best-effort gate as everything else here: nothing is captured
 * unless the device has opted into diagnostics.
 */
export function recordSessionEvent(event, fields) {
  push({ ...fields, event, kind: 'session' })
}

/**
 * A small, cheap state digest recorded alongside every action — enough to follow
 * Go Mode / search / navigation flow without dumping the whole store each time.
 */
function digest(state) {
  try {
    const otp = state?.otp || {}
    const g = otp.goMode || {}
    return {
      go: g.isActive
        ? {
            err: g.tracking?.error || undefined,
            leg: g.progress?.currentLegIndex,
            on: true,
            onboard: g.onboard?.status,
            reroute: g.reRoute?.status
          }
        : false,
      itinView: otp.ui?.itineraryView,
      screen: otp.ui?.mobileScreen,
      search: otp.activeSearchId
    }
  } catch {
    return undefined
  }
}

/**
 * JSON-stringify with circular references dropped. Real itineraries can carry
 * cycles (enriched leg/route back-references); a plain JSON.stringify throws
 * and used to reduce a replay-critical payload (e.g. START_GO_MODE's whole
 * itinerary) to `__unserialisable` — silently breaking record/replay for that
 * trip. Dropping only the cyclic edges keeps everything replay needs.
 */
function stringifyDroppingCycles(value) {
  const seen = new WeakSet()
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object') {
      if (seen.has(val)) return undefined
      seen.add(val)
    }
    return val
  })
}

function summarisePayload(action, full) {
  try {
    // Error payloads (e.g. *_ERROR actions) otherwise JSON.stringify to "{}",
    // hiding the very message needed to diagnose the failure.
    if (action.payload instanceof Error) {
      return {
        __error: true,
        message: action.payload.message,
        name: action.payload.name,
        stack: action.payload.stack
      }
    }
    let payload = action.payload
    let json
    try {
      json = JSON.stringify(payload)
    } catch {
      // Cyclic payload — retry with cycles dropped and record THAT version, so
      // the entry stays fully usable instead of collapsing to a stub.
      json = stringifyDroppingCycles(payload)
      payload = JSON.parse(json)
    }
    if (json === undefined) return undefined
    // Trip recording: keep the whole payload for whitelisted types, capped only
    // by the per-entry body ceiling so one giant action can't wedge a flush.
    if (full) {
      if (json.length <= MAX_FULL_PAYLOAD_CHARS) return payload
      // Fall through to the summary stub below for an oversized full payload —
      // but say so now. Silently stubbing a whitelisted type is how two rides
      // on 2026-08-27 became unreplayable without anyone noticing until
      // build-fixture.js refused, days later. The ride is the only moment this
      // is still cheap to fix.
      // eslint-disable-next-line no-console
      console.warn(
        `[debug-log] ${action.type} payload is ${json.length} chars, over the ` +
          `${MAX_FULL_PAYLOAD_CHARS} full-capture ceiling — recorded as a stub, ` +
          'so this trip will NOT be replayable.'
      )
    } else if (json.length <= MAX_PAYLOAD_CHARS) {
      return payload
    }
    // Too big (e.g. a routing response full of itineraries): keep a shape hint.
    const p = action.payload
    return {
      __summary: true,
      chars: json.length,
      keys: p && typeof p === 'object' ? Object.keys(p).slice(0, 20) : undefined
    }
  } catch {
    return { __unserialisable: true }
  }
}

/** Redux middleware: record every dispatched (plain) action + state digest. */
export function createDebugLogMiddleware() {
  return (store) => (next) => (action) => {
    const result = next(action)
    try {
      if (action && typeof action.type === 'string') {
        const state = store.getState()
        // Full-fidelity capture only for whitelisted types during a recorded trip.
        const full =
          FULL_CAPTURE_TYPES.has(action.type) && isRecordingTrip(state)
        push({
          kind: 'action',
          payload: summarisePayload(action, full),
          state: digest(state),
          type: action.type
        })
      }
    } catch {
      // never let logging break dispatch
    }
    return result
  }
}

function serialiseArg(a) {
  if (a instanceof Error)
    return { message: a.message, name: a.name, stack: a.stack }
  if (typeof a === 'string') return a.slice(0, 2000)
  try {
    return JSON.parse(JSON.stringify(a))
  } catch {
    return String(a).slice(0, 2000)
  }
}

/** Hook global error sources + console.error/warn into the same stream. */
export function installGlobalErrorCapture() {
  if (typeof window === 'undefined') return
  window.addEventListener('error', (e) => {
    push({
      col: e.colno,
      kind: 'error',
      line: e.lineno,
      message: e.message,
      source: e.filename,
      stack: e.error?.stack
    })
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    push({
      kind: 'rejection',
      message: r?.message || String(r),
      stack: r?.stack
    })
  })
  ;['error', 'warn'].forEach((level) => {
    const orig = console[level].bind(console)
    console[level] = (...args) => {
      push({ args: args.map(serialiseArg), kind: 'console', level })
      orig(...args)
    }
  })
}

function buildBatch(entries) {
  return JSON.stringify({
    build: BUILD_INFO,
    deviceId,
    entries,
    href: typeof window !== 'undefined' ? window.location.href : undefined,
    sessionId,
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : undefined
  })
}

function flush() {
  if (!buffer.length || !isEnabled()) return
  const batch = selectBatch(buffer, MAX_BODY_BYTES, buildBatch)
  const body = buildBatch(batch)
  // No `keepalive`: WebKit hard-caps keepalive bodies at ~64KB and a bigger
  // body makes fetch() throw SYNCHRONOUSLY — which once wedged this logger
  // for a whole session (the throw escaped the .catch, the buffer never
  // drained, and every retry re-threw). The interval flush runs while the
  // app is alive, so keepalive buys nothing; page-hide is flushBeacon's job.
  // The try/catch is belt-and-braces so no future foot-gun can wedge it again.
  try {
    fetch(ENDPOINT, {
      body,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    })
      .then(() => {
        // Drop only what we sent; entries queued during the request stay buffered.
        buffer.splice(0, batch.length)
      })
      .catch(() => {
        // Leave entries buffered (capped by MAX_BUFFER) for the next attempt.
      })
  } catch {
    // Leave entries buffered; never let a transport quirk break the app.
  }
}

function flushBeacon() {
  if (!buffer.length || !isEnabled() || !navigator.sendBeacon) return
  try {
    // Drain in <=60KB slices (the beacon quota is ~64KB — bigger beacons are
    // dropped silently). A single entry too big even alone (a full recording
    // payload can be ~200KB) is skipped: it stays buffered and goes out via
    // the normal fetch flush if the app resumes. Never splice the buffer —
    // beacons don't confirm delivery, so resend-on-resume stays the rule.
    let offset = 0
    for (let i = 0; i < 4 && offset < buffer.length; i++) {
      const batch = selectBatch(
        buffer.slice(offset),
        BEACON_MAX_BODY_BYTES,
        buildBatch
      )
      const body = buildBatch(batch)
      if (body.length > BEACON_MAX_BODY_BYTES) {
        offset += 1
        continue
      }
      // text/plain, not application/json: beacons can't preflight, and
      // text/plain is the only type allowed cross-origin (the native app's
      // case). The body is still JSON — the server parses it regardless.
      const ok = navigator.sendBeacon(
        ENDPOINT,
        new Blob([body], { type: 'text/plain' })
      )
      if (!ok) break
      offset += batch.length
    }
  } catch {
    // best-effort
  }
}

/**
 * Start periodic flushing + flush-on-hide. Called at app startup (a no-op for
 * devices that haven't opted in) and again by setDebugLogEnabled(true), which
 * is what actually starts the stream the first time a device opts in.
 */
export function startDebugLog() {
  if (typeof window === 'undefined') return
  applyUrlOverride()
  if (!isEnabled()) return
  // Re-enabled mid-session: capture resumes via the isEnabled() gates; just
  // refresh the recording flag rather than double-installing listeners.
  recordFlag = readRecordFlag()
  if (started) return
  started = true
  if (recordFlag) push({ event: 'record-mode', kind: 'session' })
  installGlobalErrorCapture()
  setInterval(flush, FLUSH_INTERVAL_MS)
  window.addEventListener('pagehide', flushBeacon)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushBeacon()
  })
  push({ event: 'start', kind: 'session' })
}

/**
 * Record the user's diagnostics choice and apply it immediately: enabling
 * starts (or resumes) the stream in-place, disabling stops capture at the
 * next push (already-buffered entries are simply never sent).
 */
export function setDebugLogEnabled(enabled) {
  try {
    window.localStorage?.setItem('otpDebugLog', enabled ? '1' : '0')
  } catch {
    // Can't persist the choice → isEnabled() stays false, nothing streams.
  }
  if (enabled) startDebugLog()
}
