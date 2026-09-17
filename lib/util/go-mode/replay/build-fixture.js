#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * build-fixture.js — turn a recorded Go Mode trip into a replayable fixture.
 *
 * Reads the server-side debug-log JSONL (written by the transitnav sidecar's
 * /api/debug-log sink, one entry per line), isolates a single trip session, and
 * assembles a self-contained fixture the replay harness can play back offline &
 * deterministically. See replay-engine.ts for the consumer and
 * lib/util/debug-log.js for the recording side.
 *
 * Trip recording defaults ON inside a session that has opted into diagnostics —
 * there is no flag to remember. (`?recordTrip=1` does nothing; the opt-OUT is
 * `?recordTrip=0` or localStorage.otpRecordTrip = '0'.) So a replay-critical
 * payload found stubbed (__summary / __truncated_chars) is never a missing flag.
 * It is one of three things, and the end-of-run block MEASURES which rather than
 * assuming, because assuming cost two ride reports:
 *   - __truncated_chars            the sidecar's line cap (a Flask DEPLOY to fix)
 *   - __summary over the ceiling   MAX_FULL_PAYLOAD_CHARS (raise the whole ladder)
 *   - __summary UNDER the ceiling  no cap at all: the action was dispatched
 *                                  outside a recorded trip, where every payload
 *                                  is cut to MAX_PAYLOAD_CHARS (4k)
 * Both 2026-08-27 rides were the second kind, on a 270,837-char START_GO_MODE.
 * Every stub in the 2026-09-15 day file was the THIRD kind (largest 326,260 of
 * 1,000,000) and the report still said both caps had to be raised.
 *
 * A SESSION IS NOT A RIDE. The phone keeps one session id for as long as the
 * app stays loaded, so a session routinely spans several trips and the dead
 * time between them: `mtdh67f3-0z5p24` covers both 2026-08-28 rides and the
 * three parked hours in between, seven hours end to end. Bracketing on the
 * session alone produced a 61 MB "fixture" that was a raw log dump wearing a
 * fixture's name.
 *
 * Nor is a START_GO_MODE a ride boundary on its own: `beginGoMode` re-dispatches
 * it on every itinerary swap, so a quiet access re-plan looks exactly like a
 * fresh trip, and that same session carries ELEVEN of them for two rides. But a
 * START_GO_MODE arriving while NO trip is open is a boundary, and that is what
 * splitRides cuts on — open on a start (or on RESUME_GO_MODE, the marker a
 * re-mounted ride begins with), close on STOP_GO_MODE, ignore a start while a
 * ride is already open. On the real `mtin0l9c-yieexg` that recovers the three
 * 2026-09-01 rides exactly.
 *
 * THE DEFAULT IS THE LAST RIDE, not the whole session. --since/--until landed
 * first and the default did not follow: on 2026-09-01 a wrap-up ran
 * `--session mtin0l9c-yieexg` with no window and got a 15.5 MB fixture of rides
 * 1 and 2 that silently EXCLUDED the ride being reported, which began three
 * seconds after that bracket ended — under a banner reading
 * `window: (none) .. (none)`, which reads as "everything is here". A report
 * built from the wrong ride is worse than no fixture, so the ride captured and
 * the ones skipped are now named on every run.
 *
 * Usage:
 *   node build-fixture.js --latest --label my-trip
 *   node build-fixture.js --session mqfnldc3-rcr8ch --label orange-line --out /path/foo.json
 *   node build-fixture.js --session mtin0l9c-yieexg --label ride2 --ride 2
 *   node build-fixture.js --session mtdh67f3-0z5p24 --label evening \
 *     --since 2026-08-29T01:56:44Z --until 2026-08-29T02:36:00Z
 *
 * Flags:
 *   --session <id>   session id to build (see the `session` field in the JSONL)
 *   --latest         instead of --session, pick the most recent session that
 *                    contains a START_GO_MODE (a real Go trip)
 *   --ride <n>       which ride in the session to build, 1-based (default: the
 *                    LAST one). `--ride 1` is the first.
 *   --all            one bracket spanning every ride in the session — the old
 *                    default. Use it deliberately; it is rarely what you want.
 *   --since <t>      ignore everything before this instant (epoch ms, or any
 *                    ISO 8601 date — '2026-08-29T01:56:44Z'). Applied before
 *                    rides are split, so it scopes which rides exist at all —
 *                    but NOT a floor on capture: main() reads
 *                    ONBOARD_LOOKBACK_MS earlier so an onboard flow that began
 *                    before START_GO_MODE is still reached. A caller's 60 s
 *                    lead-in no longer decides whether the flow is in.
 *   --until <t>      ...and everything after this one
 *   --label <name>   human label stored in meta.label; also the default filename
 *   --out <path>     output path (default: ./fixtures/<label>.json next to this)
 *   --logs-dir <p>   debug-log dir (default: $DEBUG_LOG_DIR or ~/otp-debug-logs)
 */

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Shared with the recorder (lib/util/debug-log.js) through JSON, the one format
// this CommonJS script and that ESM module can both read.
//
// This was a hand-kept copy that had drifted three types behind the recorder by
// 2026-08-27 (STOP_GO_MODE, REROUTE_SNAPSHOT, ONBOARD_CANDIDATE_SNAPSHOT) — and
// the drift went unnoticed because the constant was never read: stub detection
// was entirely per-type branches in the switch below. A dead list cannot drift
// visibly. It is now both shared and actually used, by the sweep in main().
const FULL_PAYLOAD_TYPES = require('../../full-capture-types.json')

// How far before START_GO_MODE an onboard flow may sit and still count as the
// setup for this trip. The real gap is seconds; this is loose enough to absorb
// a rider reading the alight options for a while, tight enough that a flow the
// rider abandoned an hour earlier is not adopted.
const ONBOARD_LOOKBACK_MS = 10 * 60 * 1000

/**
 * A --since/--until value. Bare digits are epoch MILLISECONDS; anything else
 * goes to Date.parse, so ISO 8601 works ('2026-08-29T01:56:44Z'). A 10-digit
 * seconds stamp is rejected rather than quietly resolving to 1970, which would
 * hand back an empty window and look like "the ride wasn't recorded".
 */
function parseTime(value, flag) {
  if (value == null) throw new Error(`${flag} needs a value`)
  if (/^\d+$/.test(value)) {
    const ms = Number(value)
    if (ms < 1e12) {
      throw new Error(
        `${flag}: ${value} looks like epoch SECONDS; pass milliseconds or an ISO date`
      )
    }
    return ms
  }
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    throw new Error(`${flag}: cannot parse ${value} as a time`)
  }
  return ms
}

/**
 * A --ride value: 1-based and a whole number, because that is how the banner and
 * the ride reports count them ("ride 3 of 3"). A 0 here would silently build
 * ride 1 under the wrong name.
 */
function parseRide(value) {
  if (value == null) throw new Error('--ride needs a value')
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--ride: ${value} is not a ride number (1-based)`)
  }
  return n
}

/** Throws on anything malformed; main() turns that into a message + exit 1. */
function parseArgs(argv) {
  const args = {
    all: false,
    latest: false,
    ride: null,
    sinceMs: -Infinity,
    untilMs: Infinity
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--latest') args.latest = true
    else if (a === '--all') args.all = true
    else if (a === '--ride') args.ride = parseRide(argv[++i])
    else if (a === '--session') args.session = argv[++i]
    else if (a === '--label') args.label = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--logs-dir') args.logsDir = argv[++i]
    else if (a === '--since') args.sinceMs = parseTime(argv[++i], '--since')
    else if (a === '--until') args.untilMs = parseTime(argv[++i], '--until')
    else throw new Error(`Unknown argument: ${a}`)
  }
  if (args.sinceMs > args.untilMs) {
    throw new Error('--since is after --until: that window is empty')
  }
  if (args.all && args.ride != null) {
    throw new Error('--all and --ride ask for different things; pick one')
  }
  return args
}

/** Client event time in ms; fall back to the server receive time. */
function entryMs(e) {
  if (typeof e.t === 'number') return e.t
  if (typeof e.recv === 'number') return Math.round(e.recv * 1000)
  return 0
}

/**
 * Cut a session's events into RIDES.
 *
 * The rule is "was a trip open when this arrived", which is the only thing that
 * separates a fresh ride from the itinerary swaps `beginGoMode` re-dispatches
 * START_GO_MODE for. Openers are START_GO_MODE and RESUME_GO_MODE (a ride the
 * app re-mounted inside, which has no START of its own); the closer is
 * STOP_GO_MODE; a ride still open at the end of the log closes on the last
 * entry, because a ride whose stream simply stopped is still a ride.
 *
 * Verified against `mtin0l9c-yieexg`, 2026-09-01: 8 START_GO_MODE and 3
 * STOP_GO_MODE resolve to exactly the three rides the reports describe —
 * 13:26:27→14:48:47, 15:29:35→15:48:47, 15:48:50→16:18:54.
 *
 * @param events one session's entries, ascending by time
 * @returns [{ startEvt, startMs, endMs, endEvt }], in order
 */
function splitRides(events) {
  const rides = []
  let open = null
  for (const e of events) {
    if (e.type === 'START_GO_MODE' || e.type === 'RESUME_GO_MODE') {
      if (!open) open = { startEvt: e, startMs: entryMs(e) }
    } else if (e.type === 'STOP_GO_MODE' && open) {
      rides.push({ ...open, endEvt: e, endMs: entryMs(e) })
      open = null
    }
  }
  if (open) {
    const last = events[events.length - 1]
    rides.push({ ...open, endEvt: null, endMs: entryMs(last) })
  }
  return rides
}

/**
 * The debug-log client re-POSTs a batch whose delivery it could not confirm, so
 * the JSONL carries records that are byte-identical — including the action's
 * own `t` and any notification id — and differ ONLY in the sidecar's `recv`
 * stamp. Measured 2026-08-31 at 3.1–3.5% of every 08-27..08-29 file.
 *
 * Un-deduplicated they reach the fixture: the same GPS fix twice in gpsTrack,
 * the same vehicle/trip snapshot twice, so the track a replay drives is not the
 * track the ride produced. Keying on the whole record minus `recv` is what
 * makes this safe — two genuinely distinct events cannot agree on the session,
 * the millisecond AND the entire payload.
 */
function dedupeKey(entry) {
  const rest = { ...entry }
  delete rest.recv
  return crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex')
}

/**
 * Every parsed entry from every debug-*.jsonl in the logs dir, de-duplicated,
 * and — when a window is given — only the entries inside it.
 *
 * The window is applied HERE rather than after grouping so a seven-hour session
 * never has to be held in memory to build forty minutes of it.
 *
 * `sinceMs` is a plain read floor and this function has no opinion about the
 * onboard flow. main() is what knows the difference: it passes a floor
 * ONBOARD_LOOKBACK_MS below the user's --since and then re-applies --since
 * itself for ride splitting, so the reach-back has entries to reach. Until
 * 2026-09-17 the floor here WAS --since, and the reach-back could not escape
 * it — which is why the 2026-09-15 15:56 ride, whose onboard flow began 2m17s
 * before START_GO_MODE, had to be rebuilt by hand with --since three minutes
 * early.
 */
function readAllEntries(logsDir, sinceMs = -Infinity, untilMs = Infinity) {
  let files
  try {
    files = fs
      .readdirSync(logsDir)
      .filter((f) => /^debug-.*\.jsonl$/.test(f))
      .sort()
  } catch (e) {
    console.error(`Cannot read logs dir ${logsDir}: ${e.message}`)
    process.exit(1)
  }
  const entries = []
  const seen = new Set()
  let duplicates = 0
  for (const f of files) {
    const text = fs.readFileSync(path.join(logsDir, f), 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue // skip malformed line
      }
      const t = entryMs(entry)
      if (t < sinceMs || t > untilMs) continue
      const key = dedupeKey(entry)
      if (seen.has(key)) {
        duplicates++
        continue
      }
      seen.add(key)
      entries.push(entry)
    }
  }
  return { duplicates, entries }
}

/**
 * The recorder's own marker for a payload it REPLACED, or null for a payload it
 * did not touch. This is the only evidence of a capture loss that exists.
 *
 * __truncated_chars is the sidecar's marker (preferences_api.py replaces an
 * over-long line with a stub carrying it). The docstring above has always
 * claimed this was detected; it wasn't, so a payload lost to the Flask line cap
 * read as intact and produced a silently wrong fixture.
 *
 * A payload that is simply ABSENT carries no marker and is not a loss — see
 * isStub.
 */
function stubMarker(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (payload.__summary) return '__summary'
  if (payload.__truncated_chars) return '__truncated_chars'
  if (payload.__unserialisable) return '__unserialisable'
  return null
}

/**
 * "This entry has no payload this builder can use" — either the recorder
 * replaced it (stubMarker) or the action never carried one. Consumers need both
 * cases to skip; only the first is a capture loss, which is why noteStub asks
 * stubMarker rather than this.
 */
function isStub(payload) {
  return payload == null || !!stubMarker(payload)
}

/**
 * MAX_FULL_PAYLOAD_CHARS, read out of the recorder's source the way
 * __tests__/util/debug-log-ladder.js reads it — this CommonJS script cannot
 * import that ESM module. It is what lets the stub report SAY whether a
 * summarised payload was actually over the ceiling instead of assuming it was:
 * on 2026-09-15 every stub in the day file was well UNDER it (largest 326,260
 * of 1,000,000), so raising the caps would have changed nothing, and the ride
 * report nevertheless said both caps had to be raised.
 */
function fullPayloadCeiling() {
  try {
    const src = fs.readFileSync(
      path.join(__dirname, '../../debug-log.js'),
      'utf8'
    )
    const m = src.match(/^const MAX_FULL_PAYLOAD_CHARS = (\d+)\b/m)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/** Collect route ids from an itinerary's transit legs (defensive on shape). */
function routeIdsFromItinerary(itin) {
  const ids = new Set()
  for (const leg of itin?.legs || []) {
    if (!leg || !leg.transitLeg) continue
    const id = leg.routeId || leg.route?.gtfsId || leg.route?.id
    if (id) ids.add(id)
  }
  return [...ids]
}

function main() {
  let args
  try {
    args = parseArgs(process.argv)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  const logsDir =
    args.logsDir ||
    process.env.DEBUG_LOG_DIR ||
    path.join(os.homedir(), 'otp-debug-logs')

  // --since is a SCOPE bound — it decides which rides exist — but it was also,
  // until 2026-09-17, a hard READ bound, and that made the onboard reach-back
  // below unreachable in practice. Every caller passes `startMs - 60000` (the
  // ride-watch wrap-up does), and an onboard flow routinely begins minutes
  // before START_GO_MODE: 2m17s on the 2026-09-15 15:56 ride, whose two
  // SET_ONBOARD_RESULT sets — the entire evidence base of that report — a 60 s
  // reach-back excludes outright. It had to be rebuilt by hand with an explicit
  // 3-minute --since. So read ONBOARD_LOOKBACK_MS earlier than asked and let
  // the reach-back spend it; nothing else may see those entries.
  const readSinceMs =
    args.sinceMs > -Infinity ? args.sinceMs - ONBOARD_LOOKBACK_MS : -Infinity
  const { duplicates, entries: allWithLeadIn } = readAllEntries(
    logsDir,
    readSinceMs,
    args.untilMs
  )
  const all = allWithLeadIn.filter((e) => entryMs(e) >= args.sinceMs)
  if (!all.length) {
    console.error(
      `No log entries found in ${logsDir}` +
        (args.sinceMs > -Infinity || args.untilMs < Infinity
          ? ' inside the --since/--until window'
          : '')
    )
    process.exit(1)
  }

  // Group by session. Twice: the scoped stream, which is what --latest and the
  // ride split see, and the stream with the lead-in, which only the onboard
  // reach-back and the capture bracket it sets may read.
  const bySession = new Map()
  for (const e of all) {
    const s = e.session || 'unknown'
    if (!bySession.has(s)) bySession.set(s, [])
    bySession.get(s).push(e)
  }
  const leadInBySession = new Map()
  for (const e of allWithLeadIn) {
    const s = e.session || 'unknown'
    if (!leadInBySession.has(s)) leadInBySession.set(s, [])
    leadInBySession.get(s).push(e)
  }

  // Resolve which session to build.
  let session = args.session
  if (!session) {
    if (!args.latest) {
      console.error('Specify --session <id> or --latest')
      process.exit(1)
    }
    // Most recent session that actually contains a trip start — a resumed
    // ride's RESUME_GO_MODE counts, or --latest would skip the very sessions
    // that most need building (the 2026-08-31 18:52 mount had no START at all).
    let bestMs = -1
    for (const [s, es] of bySession) {
      const start = es.find(
        (e) => e.type === 'START_GO_MODE' || e.type === 'RESUME_GO_MODE'
      )
      if (start && entryMs(start) > bestMs) {
        bestMs = entryMs(start)
        session = s
      }
    }
    if (!session) {
      console.error('No session with a START_GO_MODE was found.')
      process.exit(1)
    }
    console.log(`--latest resolved to session ${session}`)
  }

  const events = (bySession.get(session) || [])
    .slice()
    .sort((a, b) => entryMs(a) - entryMs(b))
  // The same session including the pre---since lead-in. Only the onboard
  // reach-back and the capture bracket read this; ride splitting must not, or
  // --since would stop scoping which rides exist.
  const eventsWithLeadIn = (leadInBySession.get(session) || [])
    .slice()
    .sort((a, b) => entryMs(a) - entryMs(b))
  if (!events.length) {
    console.error(`No entries for session ${session}`)
    process.exit(1)
  }

  // Which RIDE of this session to build. The default is the last one: a session
  // outlives its rides, and the ride you want is almost always the one that just
  // ended (see the header, and 2026-09-01's wrap-up, which got rides 1+2 of 3).
  const rides = splitRides(events)
  if (!rides.length) {
    console.error(
      `Session ${session} has no START_GO_MODE or RESUME_GO_MODE — not a Go trip.`
    )
    process.exit(1)
  }
  if (args.ride != null && args.ride > rides.length) {
    console.error(
      `--ride ${args.ride}: session ${session} has ${rides.length} ride(s)` +
        (args.sinceMs > -Infinity || args.untilMs < Infinity
          ? ' inside the --since/--until window'
          : '')
    )
    process.exit(1)
  }
  const rideIndex = args.all ? 0 : (args.ride ?? rides.length) - 1
  const ride = rides[rideIndex]
  const startEvt = ride.startEvt
  // --all restores the pre-2026-09-02 bracket: the FIRST ride's start to the
  // LAST ride's end, parked hours and all.
  const rideEndMs = args.all ? rides[rides.length - 1].endMs : ride.endMs
  if (isStub(startEvt.payload) || !startEvt.payload?.itinerary) {
    console.error(
      `${startEvt.type} payload is ${
        stubMarker(startEvt.payload) || 'absent'
      } — the itinerary is gone, ` +
        'so no replayable fixture can be built.\n' +
        'Recording defaults ON for an opted-in session, so this is not a ' +
        'missing flag. Which cap,\nif any, depends on the marker — and a ' +
        '__summary whose `chars` is UNDER\nMAX_FULL_PAYLOAD_CHARS ' +
        `(${fullPayloadCeiling() ?? '?'}) hit no cap at all; it was recorded ` +
        'outside a\nrecorded trip, at MAX_PAYLOAD_CHARS (4k):\n' +
        '  __summary over the ceiling -> MAX_FULL_PAYLOAD_CHARS (lib/util/debug-log.js)\n' +
        '  __truncated_chars          -> DEBUG_LOG_MAX_LINE_CHARS (preferences_api.py)\n' +
        'Raise only the one the marker names, and then raise the whole ladder ' +
        'with it — the\nclient ceiling must stay below the sidecar line cap, ' +
        'which must stay below the nginx\nbody cap ' +
        '(otp-minneapolis/scripts/check-config-ladder.py checks all four).'
    )
    process.exit(1)
  }

  const startMs = ride.startMs
  const endMs = rideEndMs

  // A trip entered through the onboard ("I'm already on a bus") flow is SET UP
  // before START_GO_MODE — on 2026-08-02 the boarded trip and the alight
  // options landed 32s and 26s earlier. Bracketing strictly from START_GO_MODE
  // therefore threw away the builder's own inputs and the fixture began at the
  // already-split itinerary those inputs produced, which is why that ride's
  // leg split could never be reproduced from it. Reach back to the flow's
  // start when one immediately precedes the trip.
  const onboardEvt = [...eventsWithLeadIn]
    .reverse()
    .find(
      (e) =>
        e.type === 'BEGIN_ONBOARD_FLOW' &&
        entryMs(e) < startMs &&
        startMs - entryMs(e) <= ONBOARD_LOOKBACK_MS
    )
  const captureFromMs = onboardEvt ? entryMs(onboardEvt) : startMs

  // Only entries within the trip bracket (plus the onboard setup, if any).
  const inTrip = eventsWithLeadIn.filter((e) => {
    const t = entryMs(e)
    return t >= captureFromMs && t <= endMs
  })

  const itinerary = startEvt.payload.itinerary
  const label = args.label || `trip-${session}`

  const fixture = {
    gpsTrack: [],
    itinerary,
    // Every itinerary Go Mode swapped in AFTER the trip started — the sheet the
    // rider was actually looking at from that moment. `beginGoMode` re-dispatches
    // START_GO_MODE for each one (a quiet access re-plan, an applied reroute), and
    // until 2026-08-31 the builder kept only the first and dropped the rest, so a
    // fixture could not evidence a defect whose whole symptom is the replacement
    // sheet. The 8/28 evening ride swapped in three whose bike leg ends after the
    // bus it feeds has departed. Excludes the trip's own itinerary, which is
    // `fixture.itinerary`.
    itinerarySwaps: [],
    meta: {
      endMs,
      homeTimezone: itinerary.timeZone || 'America/Chicago',
      label,
      notes: '',
      recordedAt: new Date(startMs).toISOString(),

      resumed: startEvt.type === 'RESUME_GO_MODE',
      // Which ride of the session this is, so a fixture on disk can be checked
      // against the ride report that cites it. `resumed` says the ride began
      // with a RESUME_GO_MODE — the app picked a trip back up rather than
      // starting one — which changes what the opening state means.
      ride: args.all ? null : rideIndex + 1,
      rideCount: rides.length,
      routeIds: routeIdsFromItinerary(itinerary),
      session,
      startMs
    },
    // Present and empty for a normally-planned trip; populated when the rider
    // entered through the onboard flow.
    onboard: { result: null, trip: null },
    // One entry per candidate alight stop per optimize: the onward plan the
    // ranking was actually computed from. Keyed by stopId, because five
    // simultaneous plans differ only by where they depart from.
    onboardCandidatePlans: [],
    // One entry per quiet access re-plan fetch (2026-09-15, backlog 13.8).
    // Same action type and same isolated fetch as the optimizer's plans above,
    // but a DIFFERENT series: a quiet re-plan has no candidate alight stop, so
    // it carries no `stopId`, and the optimizer replay reads every entry of
    // onboardCandidatePlans as one of its own (see
    // __tests__/util/go-mode/same-route-relay-0913.ts, which maps the whole
    // array into rankAlightOptions input). Mixing them would silently feed the
    // ranker plans it never ranked. Told apart by `request.reason`.
    quietReplanPlans: [],
    rerouteSnapshots: [],
    routingResponses: [],
    schemaVersion: 1,
    stopTimeSnapshots: [],
    tripSnapshots: [],
    vehicleSnapshots: []
  }

  // type -> the losses recorded for it, each with the recorder's marker and,
  // where the marker carries one, the size of what was thrown away. Sizes are
  // the whole point: a __summary UNDER the ceiling did not hit the ceiling.
  const stubbed = new Map()
  // The sweep above and the per-type branch below both see the same entry, and
  // the report now counts losses rather than collecting a Set of type names, so
  // one loss would otherwise be reported twice.
  const noted = new WeakSet()
  const noteStub = (e) => {
    if (noted.has(e)) return
    const marker = stubMarker(e.payload)
    // A payload that is merely ABSENT is a SHAPE, not a capture loss, and
    // reporting it as one is how the 2026-09-15 15:34 ride was written up as
    // unreplayable. `setOnboardResult(null)` is dispatched deliberately from
    // three places in lib/actions/go-mode.ts to CLEAR the option list, and that
    // ride has one such entry (20:46:14.352Z, 881 bytes) among four
    // SET_ONBOARD_RESULTs — the other three carry their five options in full,
    // 124,321-128,613 chars. The builder reported the type as stubbed, the
    // report concluded the ranking bugs could not be replayed at all, and the
    // fixture on disk had the options the whole time. STOP_GO_MODE had the same
    // shape and used to need a special case here; now nothing does.
    if (!marker) return
    noted.add(e)
    const hits = stubbed.get(e.type) || []
    hits.push({
      chars:
        typeof e.payload.chars === 'number'
          ? e.payload.chars
          : typeof e.payload.__truncated_chars === 'number'
          ? e.payload.__truncated_chars
          : null,
      marker,
      tMs: entryMs(e)
    })
    stubbed.set(e.type, hits)
  }

  // Sweep every whitelisted type, not just the ones with a case below. The
  // per-type branches only notice a stub for payloads this builder actively
  // consumes, so a captured type with no branch — STOP_GO_MODE today — could be
  // lost to a size cap and reported as nothing at all. (Most branches also
  // happen to catch a stub via their "expected field missing" test, which is
  // why this gap stayed hidden.) Reading the shared list here is also what
  // keeps it honest: it was a dead constant until 2026-08-27, and a list
  // nothing reads cannot visibly drift.
  for (const e of inTrip) {
    if (!FULL_PAYLOAD_TYPES.includes(e.type)) continue
    // Only an explicit recorder marker (__summary / __truncated_chars /
    // __unserialisable) counts, which noteStub enforces: a null payload is a
    // normal shape for STOP_GO_MODE (createAction with no payload) and for
    // SET_ONBOARD_RESULT (the deliberate "clear the options" dispatch), and
    // both were reported as losses before. First seen 2026-08-28, when the
    // first fully-recorded trip was reported as stubbed by the very sweep added
    // to catch silent losses; again on 2026-09-15 (see noteStub).
    noteStub(e)
  }

  for (const e of inTrip) {
    const tMs = entryMs(e)
    switch (e.type) {
      case 'UPDATE_POSITION': {
        const c = e.payload?.coords
        if (!c) break
        fixture.gpsTrack.push({
          accuracy: c.accuracy ?? null,
          heading: c.heading ?? null,
          lat: c.latitude,
          lon: c.longitude,
          speed: c.speed ?? null,
          tMs: e.payload.timestamp || tMs
        })
        break
      }
      case 'START_GO_MODE': {
        if (e === startEvt) break // the trip's own itinerary, stored above
        if (isStub(e.payload) || !e.payload.itinerary) {
          noteStub(e)
          break
        }
        fixture.itinerarySwaps.push({ itinerary: e.payload.itinerary, tMs })
        break
      }
      case 'REALTIME_VEHICLE_POSITIONS_RESPONSE': {
        if (isStub(e.payload)) {
          noteStub(e)
          break
        }
        fixture.vehicleSnapshots.push({
          payload: e.payload,
          routeId: e.payload.routeId,
          tMs
        })
        break
      }
      case 'FIND_STOP_TIMES_FOR_STOP_RESPONSE': {
        if (isStub(e.payload)) {
          noteStub(e)
          break
        }
        fixture.stopTimeSnapshots.push({
          payload: e.payload,
          stopId: e.payload.gtfsId,
          tMs
        })
        break
      }
      case 'ROUTING_RESPONSE': {
        if (isStub(e.payload)) {
          noteStub(e)
          break
        }
        fixture.routingResponses.push({
          payload: e.payload,
          searchId: e.payload.searchId,
          tMs
        })
        break
      }
      case 'ONBOARD_CANDIDATE_SNAPSHOT': {
        if (isStub(e.payload) || !e.payload.response) {
          noteStub(e)
          break
        }
        const reason = e.payload.request?.reason
        // A tagged record is a quiet access re-plan, not an alight candidate.
        // It has no stopId and must not reach the optimizer's series.
        if (reason && String(reason).startsWith('quiet-replan')) {
          fixture.quietReplanPlans.push({
            reason,
            request: e.payload.request,
            response: e.payload.response,
            tMs: e.payload.tMs || tMs
          })
          break
        }
        fixture.onboardCandidatePlans.push({
          request: e.payload.request,
          response: e.payload.response,
          stopId: e.payload.request?.stopId,
          tMs: e.payload.tMs || tMs
        })
        break
      }
      case 'REROUTE_SNAPSHOT': {
        if (isStub(e.payload) || !e.payload.response) {
          noteStub(e)
          break
        }
        fixture.rerouteSnapshots.push({
          request: e.payload.request,
          response: e.payload.response,
          tMs: e.payload.tMs || tMs
        })
        break
      }
      case 'FIND_TRIP_RESPONSE': {
        if (isStub(e.payload)) {
          noteStub(e)
          break
        }
        fixture.tripSnapshots.push({
          payload: e.payload,
          tMs,
          tripId: e.payload.id || e.payload.gtfsId
        })
        break
      }
      // The onboard flow's inputs, kept as the LAST of each: the rider can
      // back out and re-pick a vehicle, and what matters is the pair the trip
      // was actually built from. Together these are what buildOnboardItinerary
      // consumes, so a unit test can drive the real builder with the real ride.
      case 'SET_ONBOARD_TRIP': {
        if (isStub(e.payload)) {
          noteStub(e)
          break
        }
        fixture.onboard.trip = { payload: e.payload, tMs }
        break
      }
      case 'SET_ONBOARD_RESULT': {
        if (isStub(e.payload)) {
          noteStub(e)
          break
        }
        fixture.onboard.result = { payload: e.payload, tMs }
        break
      }
      default:
        break
    }
  }

  // Sort each series by time (they're already ordered, but be safe).
  for (const key of [
    'gpsTrack',
    'vehicleSnapshots',
    'stopTimeSnapshots',
    'routingResponses',
    'rerouteSnapshots',
    'onboardCandidatePlans',
    'quietReplanPlans',
    'tripSnapshots',
    'itinerarySwaps'
  ]) {
    fixture[key].sort((a, b) => a.tMs - b.tMs)
  }

  // Carry the capture losses INTO the fixture. The console warning is seen once,
  // by whoever ran the build; the fixture is read weeks later by someone asking
  // why a replay disagrees with the ride. Empty object = nothing was replaced.
  fixture.meta.stubbed = Object.fromEntries(
    [...stubbed].map(([type, hits]) => [
      type,
      {
        count: hits.length,
        markers: [...new Set(hits.map((h) => h.marker))],
        maxChars: hits.reduce((m, h) => Math.max(m, h.chars || 0), 0) || null
      }
    ])
  )

  const outPath = args.out || path.join(__dirname, 'fixtures', `${label}.json`)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n')

  const durS = Math.round((endMs - startMs) / 1000)
  const sizeMb = (fs.statSync(outPath).size / 1e6).toFixed(1)
  console.log(`\nFixture written: ${outPath} (${sizeMb} MB)`)
  console.log(`  session:          ${session}`)
  // Which ride this is, and — the part that was missing — which rides it is
  // NOT. `window: (none) .. (none)` said nothing about the two rides silently
  // left out on 2026-09-01; a fixture that does not name what it excluded
  // cannot be checked against the ride it is meant to evidence.
  console.log(
    `  ride:             ${
      args.all
        ? `ALL ${rides.length} (--all: one bracket across every ride)`
        : `${rideIndex + 1} of ${rides.length}${
            args.ride == null ? ' (default: the last ride)' : ''
          }${startEvt.type === 'RESUME_GO_MODE' ? ' — a RESUMED ride' : ''}`
    }`
  )
  if (!args.all && rides.length > 1) {
    for (let i = 0; i < rides.length; i++) {
      if (i === rideIndex) continue
      console.log(
        `    skipped ride ${i + 1}:  ${new Date(
          rides[i].startMs
        ).toISOString()} -> ${new Date(rides[i].endMs).toISOString()}` +
          `  (--ride ${i + 1} to build it)`
      )
    }
  }
  console.log(
    `  duration:         ${durS}s (${new Date(startMs).toISOString()} -> ` +
      `${new Date(endMs).toISOString()})`
  )
  console.log(
    `  window:           ${
      args.sinceMs > -Infinity ? new Date(args.sinceMs).toISOString() : '(none)'
    } .. ${
      args.untilMs < Infinity ? new Date(args.untilMs).toISOString() : '(none)'
    }`
  )
  console.log(`  duplicates dropped: ${duplicates} re-POSTed records`)
  console.log(`  itinerarySwaps:   ${fixture.itinerarySwaps.length}`)
  console.log(
    `  routeIds:         ${fixture.meta.routeIds.join(', ') || '(none)'}`
  )
  console.log(`  gpsTrack:         ${fixture.gpsTrack.length} fixes`)
  console.log(`  vehicleSnapshots: ${fixture.vehicleSnapshots.length}`)
  console.log(`  stopTimeSnapshots:${fixture.stopTimeSnapshots.length}`)
  console.log(`  routingResponses: ${fixture.routingResponses.length}`)
  console.log(`  rerouteSnapshots: ${fixture.rerouteSnapshots.length}`)
  console.log(
    `  candidatePlans:   ${fixture.onboardCandidatePlans.length}` +
      (fixture.onboard.result && !fixture.onboardCandidatePlans.length
        ? '  <- ranked options recorded but not the plans they ranked;' +
          ' this ride predates ONBOARD_CANDIDATE_SNAPSHOT'
        : '')
  )
  console.log(
    `  quietReplanPlans: ${fixture.quietReplanPlans.length}` +
      (fixture.itinerarySwaps.length && !fixture.quietReplanPlans.length
        ? '  <- swaps recorded but not the plans behind them;' +
          ' this ride predates the quiet-replan snapshot'
        : '')
  )
  console.log(`  tripSnapshots:    ${fixture.tripSnapshots.length}`)
  // What the FIXTURE holds, not where the flow happened to start. This line
  // keyed on `onboardEvt` — a BEGIN_ONBOARD_FLOW *before* START_GO_MODE — until
  // 2026-09-17, so a mid-trip onboard flow (the rider taps "I'm on the bus"
  // while Go Mode is already running: the whole of the 2026-09-15 15:34 ride)
  // read as `(not an onboard trip)` while fixture.onboard carried the trip and
  // its five ranked options. The ride report took the banner at its word and
  // called the onboard path unreplayable from that fixture.
  console.log(
    `  onboard flow:     ${
      !fixture.onboard.trip && !fixture.onboard.result
        ? '(not an onboard trip)'
        : `${fixture.onboard.trip ? 'trip' : 'trip MISSING'} + ${
            fixture.onboard.result ? 'options' : 'options MISSING'
          } (options at ${
            fixture.onboard.result
              ? new Date(fixture.onboard.result.tMs).toISOString()
              : 'n/a'
          }, ${
            onboardEvt
              ? `flow began ${Math.round(
                  (startMs - entryMs(onboardEvt)) / 1000
                )}s BEFORE the trip; reached back to ${new Date(
                  captureFromMs
                ).toISOString()}`
              : 'flow ran mid-trip'
          })`
    }`
  )
  console.log(
    `  stubbed payloads: ${
      stubbed.size
        ? `${[...stubbed.keys()].join(', ')}  <- see the block below`
        : 'none'
    }`
  )

  if (!fixture.gpsTrack.length) {
    console.warn(
      '\n⚠  No GPS fixes captured — replay has nothing to drive the trip.'
    )
  }

  // LAST, and loud. A single ⚠ line in the middle of a twenty-line banner is
  // how 2026-08-27's two unreplayable rides went unnoticed for days.
  if (stubbed.size) {
    const ceiling = fullPayloadCeiling()
    const hits = [...stubbed.values()].flat()
    const sized = hits.filter((h) => h.chars != null)
    const rule = '='.repeat(74)
    const lines = []
    for (const [type, typeHits] of stubbed) {
      const chars = typeHits.map((h) => h.chars).filter((c) => c != null)
      lines.push(
        `  ${type}: ${typeHits.length} of them, ` +
          `${[...new Set(typeHits.map((h) => h.marker))].join(' + ')}` +
          (chars.length
            ? `, ${Math.min(...chars).toLocaleString('en-US')}..${Math.max(
                ...chars
              ).toLocaleString('en-US')} chars discarded`
            : '') +
          `, first at ${new Date(
            Math.min(...typeHits.map((h) => h.tMs))
          ).toISOString()}`
      )
    }
    // Say WHICH cap, or say that no cap was involved. Guessing "it's a size
    // cap" is what put "raise MAX_FULL_PAYLOAD_CHARS and
    // DEBUG_LOG_MAX_LINE_CHARS together" into the 2026-09-15 ride report for a
    // day file whose largest stub was 326,260 chars against a 1,000,000
    // ceiling — a fix that would have been wholly inert.
    // __summary ONLY: a __truncated_chars is the sidecar's cap, and its size is
    // over the client ceiling by construction (that is what the ladder means),
    // so counting it here would blame the client for the sidecar's loss.
    const overCeiling = sized.filter(
      (h) => h.marker === '__summary' && ceiling != null && h.chars > ceiling
    )
    const truncated = hits.filter((h) => h.marker === '__truncated_chars')
    const were = (n) => (n === 1 ? 'was' : 'were')
    const diagnosis = []
    if (truncated.length) {
      diagnosis.push(
        `  ${truncated.length} hit the SIDECAR's line cap (__truncated_chars).` +
          ' Raise DEBUG_LOG_MAX_LINE_CHARS in\n' +
          '  transitnav/preferences_api.py together with the rest of the ladder' +
          ' (that is a Flask\n  sidecar DEPLOY, not an OTA), and re-check with' +
          ' otp-minneapolis/scripts/check-config-ladder.py.'
      )
    }
    if (overCeiling.length) {
      diagnosis.push(
        `  ${overCeiling.length} ${were(
          overCeiling.length
        )} over the recorder's ceiling ` +
          `(MAX_FULL_PAYLOAD_CHARS = ${ceiling.toLocaleString('en-US')}), ` +
          'largest\n' +
          `  ${Math.max(...overCeiling.map((h) => h.chars)).toLocaleString(
            'en-US'
          )}. Raise all four rungs of the ladder together — ` +
          'client < sidecar line <\n  flush body < nginx body — and re-check with ' +
          'otp-minneapolis/scripts/check-config-ladder.py.'
      )
    }
    const underCeiling = sized.filter(
      (h) => h.marker === '__summary' && ceiling != null && h.chars <= ceiling
    )
    if (underCeiling.length) {
      diagnosis.push(
        `  ${underCeiling.length} ${were(
          underCeiling.length
        )} summarised WELL UNDER the ceiling ` +
          `(largest ${Math.max(
            ...underCeiling.map((h) => h.chars)
          ).toLocaleString('en-US')} of ` +
          `${ceiling.toLocaleString(
            'en-US'
          )}), so NO SIZE CAP IS INVOLVED and\n` +
          '  raising the caps would change nothing. Full capture only applies ' +
          'while a RECORDED\n  Go Mode trip is open (isRecordingTrip in ' +
          'lib/util/debug-log.js); outside one every\n  payload is cut to ' +
          'MAX_PAYLOAD_CHARS (4k). These were dispatched outside the trip — ' +
          'trip\n  planning before Go Mode started, typically — or the type is ' +
          'not on\n  lib/util/full-capture-types.json.'
      )
    }
    if (!diagnosis.length) {
      diagnosis.push(
        '  No size is recorded on these markers, so the cause is not visible ' +
          'from the log\n  alone. Check the browser console from the ride for ' +
          "the recorder's own warning."
      )
    }
    console.warn(
      `\n${rule}\n` +
        `!!  ${hits.length} REPLAY-CRITICAL PAYLOAD${
          hits.length === 1 ? ' WAS' : 'S WERE'
        } REPLACED BY A STUB — THIS FIXTURE IS INCOMPLETE\n${rule}\n` +
        lines.join('\n') +
        '\n' +
        diagnosis.join('\n') +
        `\n  Recorded in the fixture as meta.stubbed, so a later reader sees it too.\n${rule}`
    )
  }
}

// Required as a module by __tests__/util/go-mode/build-fixture-window.js, which
// drives the window and de-duplication rules against a synthetic log dir rather
// than a 60 MB recording. Only main() has side effects.
if (require.main === module) main()

module.exports = {
  dedupeKey,
  parseArgs,
  parseTime,
  readAllEntries,
  splitRides
}
