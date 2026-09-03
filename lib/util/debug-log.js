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

// Session id, device id and the consent gate live in debug-log-boot.js, which
// main.js imports FIRST so a crash before this module evaluates is still
// reported — and reported under the same session id, by the same rule about
// consent. See that file's header.
import {
  applyDebugLogUrlOverride,
  bootSessionId,
  getDeviceId,
  isDiagnosticsEnabled,
  mintBootEntryId,
  setBootSessionId
} from './debug-log-boot'
import { measureEntry } from './debug-log-entry'
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
// How long a flush may be considered in flight before another is allowed. Ten
// intervals: long enough that a big body on a bad cellular link is never
// double-sent, short enough that a request lost without settling costs one
// half-minute of stream rather than the rest of the ride.
const INFLIGHT_TIMEOUT_MS = 30000
const MAX_BUFFER = 400 // ring-buffer cap (entries kept if a flush keeps failing)
// ...and a cap on what those entries WEIGH. 400 was chosen when every entry was
// capped at MAX_PAYLOAD_CHARS (4k), so the buffer could not exceed ~1.6 MB. A
// recorded trip now admits full-capture payloads up to MAX_FULL_PAYLOAD_CHARS
// (1,000,000), which makes the same 400 entries worth up to ~400 MB of JS
// strings — and iOS kills a WebView for far less. A count cap alone is
// therefore no longer a memory bound.
//
// 8 MB holds either ~8 of the largest full-capture payloads ever recorded or
// several thousand ordinary entries (real batches run ~800 bytes/entry), which
// is minutes of stalled uplink through a tunnel — the case the buffer exists
// for. Both caps apply; whichever binds first evicts from the FRONT, so this
// stays a bounded loss of the OLDEST entries rather than a crash, exactly as
// the count cap always has been.
const MAX_BUFFER_BYTES = 8000000
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
// Serialised size of each buffered entry, so the byte cap costs one measurement
// per push rather than a re-measure of the whole buffer. A WeakMap rather than
// a field on the entry: anything stored ON the entry is uploaded with it.
const entryChars = new WeakMap()
let bufferChars = 0
// Date.now() of the flush currently awaiting a response, or 0 when idle.
let inFlightSince = 0
let started = false

/**
 * Remove the oldest `n` entries, keeping the byte total honest. The one place
 * entries leave the buffer, so the total cannot drift away from its contents.
 */
function dropFromFront(n) {
  const gone = buffer.splice(0, n)
  for (const entry of gone) bufferChars -= entryChars.get(entry) || 0
  if (!buffer.length) bufferChars = 0
}

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

// Identity and consent are debug-log-boot.js's, not this module's: it is
// imported before anything that can throw, so a boot crash beacon is written
// under the SAME session id and the SAME opt-in rule as the stream that
// follows it. `isEnabled` is kept as a local alias because it is the gate on
// every path below and reads better at each of them.
const isEnabled = isDiagnosticsEnabled

/** This device's durable id, for the "open the ride console" link. */
export { getDeviceId }

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
  // Identity is minted HERE, once, at creation — never at flush time. This
  // client re-sends: flush() only splices when a fetch resolves and
  // flushBeacon never splices at all, so the same entry can reach the sink
  // several times. Carrying the id it was born with is what lets the sink
  // write the first copy and drop the rest; an id minted per POST would differ
  // on every retry and dedupe nothing. See debug-log-entry.js.
  entry.id = mintBootEntryId()
  buffer.push(entry)
  entryChars.set(entry, measureEntry(entry))
  bufferChars += entryChars.get(entry)
  if (buffer.length > MAX_BUFFER) dropFromFront(buffer.length - MAX_BUFFER)
  // Evict oldest-first until the buffer's WEIGHT is under the cap too, but
  // never empty it: one entry over the cap on its own is still worth sending
  // (it is already capped by MAX_FULL_PAYLOAD_CHARS and MAX_BODY_BYTES).
  while (bufferChars > MAX_BUFFER_BYTES && buffer.length > 1) dropFromFront(1)
}

/**
 * Record a one-off session-scoped fact (which live-update bundle is running,
 * say). Same best-effort gate as everything else here: nothing is captured
 * unless the device has opted into diagnostics.
 */
export function recordSessionEvent(event, fields) {
  push({ ...fields, event, kind: 'session' })
}

/** The id this app start is currently writing under. */
export function currentSessionId() {
  return bootSessionId()
}

/**
 * Carry on writing under a PREVIOUS app start's session id, because this load
 * is continuing that load's ride.
 *
 * A session id is minted per app start, and ride-watch keys its per-trip state
 * and its two-page-per-ride budget on it. So a ride the app re-mounts inside —
 * a webview reload, an iOS shell restart, the rider reopening the app — arrives
 * as two rides that each get half the evidence and a full page budget. The
 * 2026-08-31 18:52 session did it twice in 41 seconds.
 *
 * Called only by main.js, and only when a saved Go Mode trip was actually
 * restored (see session-persistence.resumedDebugSessionId), which is the
 * narrow case cb453726 said it wanted evidence for before persisting anything:
 * a genuine mid-trip re-mount, not two tabs interleaving.
 *
 * The entry-id minter is re-created with a per-load tag rather than simply
 * re-prefixed. Entry ids are `<prefix>-<seq base36>` with the sequence starting
 * at zero each load, and the sink DEDUPES on them: sharing a bare prefix across
 * two loads would make the second load's entries look like re-sends of the
 * first's and the sink would drop every one. The tag also preserves what the
 * dense counter is for — a gap inside one load still reads as real loss.
 */
export function adoptSessionId(priorSessionId) {
  if (
    typeof priorSessionId !== 'string' ||
    !priorSessionId ||
    priorSessionId === bootSessionId()
  ) {
    return false
  }
  // The freshly-minted id, which is unique to this load, IS the load tag.
  const loadTag = bootSessionId()
  setBootSessionId(priorSessionId, loadTag)
  recordSessionEvent('resumed-session', { loadTag, priorSessionId })
  return true
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
    deviceId: getDeviceId(),
    entries,
    href: typeof window !== 'undefined' ? window.location.href : undefined,
    sessionId: bootSessionId(),
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : undefined
  })
}

function flush() {
  if (!buffer.length || !isEnabled()) return
  // One POST at a time. Without this the interval fires again while a slow
  // upload is still in flight, re-selects the SAME unspliced prefix and sends
  // it a second time — pure duplicated uplink, and with bodies now reaching
  // 1.4 MB on cellular the window is wide. The guard expires so that a fetch
  // which never settles (WebKit has done exactly that on a backgrounded tab)
  // cannot wedge the logger for the session; a duplicate is a much smaller
  // harm than a stream that stops, and the sink dedupes it by entry id anyway.
  const now = Date.now()
  if (now - inFlightSince < INFLIGHT_TIMEOUT_MS) return
  inFlightSince = now
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
        dropFromFront(batch.length)
      })
      .catch(() => {
        // Leave entries buffered (capped by MAX_BUFFER) for the next attempt.
        // They keep their ids, so a re-send the server has already written is
        // dropped there rather than duplicating the record.
      })
      .finally(() => {
        inFlightSince = 0
      })
  } catch {
    // Leave entries buffered; never let a transport quirk break the app.
    inFlightSince = 0
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
  applyDebugLogUrlOverride()
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
