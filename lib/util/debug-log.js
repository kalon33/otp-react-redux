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
 * - Opt-out with localStorage.otpDebugLog === '0'.
 */

const ENDPOINT = '/api/debug-log'
const FLUSH_INTERVAL_MS = 3000
const MAX_BUFFER = 400 // ring-buffer cap (entries kept if a flush keeps failing)
const MAX_BATCH = 200 // entries sent per flush
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
const FULL_CAPTURE_TYPES = new Set([
  'START_GO_MODE',
  'STOP_GO_MODE',
  'ROUTING_RESPONSE',
  'REALTIME_VEHICLE_POSITIONS_RESPONSE',
  'FIND_STOP_TIMES_FOR_STOP_RESPONSE',
  'FIND_TRIP_RESPONSE',
  // Periodic "alternatives to finish the trip" request/response pair captured
  // during recording (see captureRerouteSnapshot in actions/go-mode.ts).
  'REROUTE_SNAPSHOT'
])
// Size ceilings for the record path, chosen to survive the whole pipeline:
//   client entry  <= MAX_FULL_PAYLOAD_CHARS (200k)
//   Flask line    <= DEBUG_LOG_MAX_LINE_CHARS (256k, preferences_api.py)
//   nginx body    <= client_max_body_size (512k, otp.conf) — enforced here by
//                    byte-aware batching so a flush body never exceeds MAX_BODY_BYTES.
// A single full payload larger than the ceiling falls back to the summary stub.
const MAX_FULL_PAYLOAD_CHARS = 200000
// Keep a flush body comfortably under the 512k nginx cap even when it carries a
// full-capture payload; oversized recording flushes otherwise 413 and never drain.
const MAX_BODY_BYTES = 450000

const buffer = []
let started = false

// Cached once: is trip-recording on for this session? Recording is ON BY
// DEFAULT (this is a personal deployment and losing a real trip to a missing
// URL flag is worse than the small extra payload). Opt out with ?recordTrip=0
// or localStorage.otpRecordTrip === '0'. The actual full-capture also requires
// a Go Mode trip to be active — see isRecordingTrip().
let recordFlag = false
function readRecordFlag() {
  try {
    if (typeof window === 'undefined') return false
    if (window.localStorage?.getItem('otpRecordTrip') === '0') return false
    return new URLSearchParams(window.location.search).get('recordTrip') !== '0'
  } catch {
    return false
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

function isEnabled() {
  try {
    return (
      typeof window !== 'undefined' &&
      window.localStorage?.getItem('otpDebugLog') !== '0'
    )
  } catch {
    return true
  }
}

function push(entry) {
  if (!isEnabled()) return
  entry.t = Date.now()
  buffer.push(entry)
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
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
      // Fall through to the summary stub below for an oversized full payload.
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
    entries,
    href: typeof window !== 'undefined' ? window.location.href : undefined,
    sessionId,
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : undefined
  })
}

/**
 * Largest prefix of the buffer (<= MAX_BATCH entries) whose serialised body
 * stays under MAX_BODY_BYTES. Always returns at least one entry so a single
 * large (but already ceiling-capped) recording payload can still drain.
 */
function selectBatch() {
  const max = Math.min(buffer.length, MAX_BATCH)
  let n = 0
  while (n < max) {
    const size = buildBatch(buffer.slice(0, n + 1)).length
    if (n > 0 && size > MAX_BODY_BYTES) break
    n++
  }
  return buffer.slice(0, Math.max(1, n))
}

function flush() {
  if (!buffer.length || !isEnabled()) return
  const batch = selectBatch()
  const body = buildBatch(batch)
  fetch(ENDPOINT, {
    body,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    method: 'POST'
  })
    .then(() => {
      // Drop only what we sent; entries queued during the request stay buffered.
      buffer.splice(0, batch.length)
    })
    .catch(() => {
      // Leave entries buffered (capped by MAX_BUFFER) for the next attempt.
    })
}

function flushBeacon() {
  if (!buffer.length || !isEnabled()) return
  try {
    const body = buildBatch(selectBatch())
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        ENDPOINT,
        new Blob([body], { type: 'application/json' })
      )
    }
  } catch {
    // best-effort
  }
}

/** Start periodic flushing + flush-on-hide. Call once at app startup. */
export function startDebugLog() {
  if (started || typeof window === 'undefined' || !isEnabled()) return
  started = true
  recordFlag = readRecordFlag()
  if (recordFlag) push({ event: 'record-mode', kind: 'session' })
  installGlobalErrorCapture()
  setInterval(flush, FLUSH_INTERVAL_MS)
  window.addEventListener('pagehide', flushBeacon)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushBeacon()
  })
  push({ event: 'start', kind: 'session' })
}
