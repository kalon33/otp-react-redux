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

const buffer = []
let started = false

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

function summarisePayload(action) {
  try {
    const json = JSON.stringify(action.payload)
    if (json === undefined) return undefined
    if (json.length <= MAX_PAYLOAD_CHARS) return action.payload
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
        push({
          kind: 'action',
          payload: summarisePayload(action),
          state: digest(store.getState()),
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

function flush() {
  if (!buffer.length || !isEnabled()) return
  const batch = buffer.slice(0, MAX_BATCH)
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
    const body = buildBatch(buffer.slice(0, MAX_BATCH))
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
  installGlobalErrorCapture()
  setInterval(flush, FLUSH_INTERVAL_MS)
  window.addEventListener('pagehide', flushBeacon)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushBeacon()
  })
  push({ event: 'start', kind: 'session' })
}
