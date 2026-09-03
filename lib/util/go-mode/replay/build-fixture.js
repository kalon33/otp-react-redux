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
 * `?recordTrip=0` or localStorage.otpRecordTrip = '0'.) So when this script
 * finds replay-critical payloads stubbed (__summary / __truncated_chars), the
 * cause is almost always SIZE, not a missing flag: a payload over the recorder's
 * MAX_FULL_PAYLOAD_CHARS, or a line over the sidecar's DEBUG_LOG_MAX_LINE_CHARS.
 * Both 2026-08-27 rides failed exactly that way on a 270,837-char START_GO_MODE.
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
 *                    rides are split, so it scopes which rides exist at all.
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
 * never has to be held in memory to build forty minutes of it. It is also what
 * scopes every downstream decision at once: the trip is the first START_GO_MODE
 * inside the window, the end is the last STOP_GO_MODE inside it, and the
 * onboard-flow reach-back below cannot escape it. Set --since a minute early if
 * a ride was entered through the onboard flow.
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

function isStub(payload) {
  return (
    payload == null ||
    (typeof payload === 'object' &&
      // __truncated_chars is the sidecar's marker (preferences_api.py replaces
      // an over-long line with a stub carrying it). The docstring above has
      // always claimed this was detected; it wasn't, so a payload lost to the
      // Flask line cap read as intact and produced a silently wrong fixture.
      (payload.__summary ||
        payload.__unserialisable ||
        payload.__truncated_chars))
  )
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

  const { duplicates, entries: all } = readAllEntries(
    logsDir,
    args.sinceMs,
    args.untilMs
  )
  if (!all.length) {
    console.error(
      `No log entries found in ${logsDir}` +
        (args.sinceMs > -Infinity || args.untilMs < Infinity
          ? ' inside the --since/--until window'
          : '')
    )
    process.exit(1)
  }

  // Group by session.
  const bySession = new Map()
  for (const e of all) {
    const s = e.session || 'unknown'
    if (!bySession.has(s)) bySession.set(s, [])
    bySession.get(s).push(e)
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
      `${startEvt.type} payload is stubbed/summarised — the itinerary is gone, ` +
        'so no replayable fixture can be built.\n' +
        'Recording defaults ON for an opted-in session, so the usual cause is ' +
        'a SIZE cap, not a missing flag:\n' +
        '  __summary         -> over MAX_FULL_PAYLOAD_CHARS (lib/util/debug-log.js)\n' +
        '  __truncated_chars -> over DEBUG_LOG_MAX_LINE_CHARS (preferences_api.py)\n' +
        'Raise them together — the client ceiling must stay below the sidecar ' +
        'line cap, which must stay below the nginx body cap.'
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
  const onboardEvt = [...events]
    .reverse()
    .find(
      (e) =>
        e.type === 'BEGIN_ONBOARD_FLOW' &&
        entryMs(e) < startMs &&
        startMs - entryMs(e) <= ONBOARD_LOOKBACK_MS
    )
  const captureFromMs = onboardEvt ? entryMs(onboardEvt) : startMs

  // Only entries within the trip bracket (plus the onboard setup, if any).
  const inTrip = events.filter((e) => {
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
    rerouteSnapshots: [],
    routingResponses: [],
    schemaVersion: 1,
    stopTimeSnapshots: [],
    tripSnapshots: [],
    vehicleSnapshots: []
  }

  const stubbed = new Set()
  const noteStub = (type) => stubbed.add(type)

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
    // STOP_GO_MODE is createAction(STOP_GO_MODE) — the action never carries a
    // payload, so null is its normal shape, not a capture loss. It stays on
    // the allowlist for the trip bracket; only an explicit recorder marker
    // (__summary/__truncated_chars) on it would mean something was replaced.
    // First seen 2026-08-28, when the first fully-recorded trip was reported
    // as stubbed by the very sweep added to catch silent losses.
    if (e.type === 'STOP_GO_MODE' && e.payload == null) continue
    if (isStub(e.payload)) noteStub(e.type)
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
          noteStub(e.type)
          break
        }
        fixture.itinerarySwaps.push({ itinerary: e.payload.itinerary, tMs })
        break
      }
      case 'REALTIME_VEHICLE_POSITIONS_RESPONSE': {
        if (isStub(e.payload)) {
          noteStub(e.type)
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
          noteStub(e.type)
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
          noteStub(e.type)
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
          noteStub(e.type)
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
          noteStub(e.type)
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
          noteStub(e.type)
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
          noteStub(e.type)
          break
        }
        fixture.onboard.trip = { payload: e.payload, tMs }
        break
      }
      case 'SET_ONBOARD_RESULT': {
        if (isStub(e.payload)) {
          noteStub(e.type)
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
    'tripSnapshots',
    'itinerarySwaps'
  ]) {
    fixture[key].sort((a, b) => a.tMs - b.tMs)
  }

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
  console.log(`  tripSnapshots:    ${fixture.tripSnapshots.length}`)
  console.log(
    `  onboard flow:     ${
      onboardEvt
        ? `${fixture.onboard.trip ? 'trip' : 'trip MISSING'} + ${
            fixture.onboard.result ? 'options' : 'options MISSING'
          } (captured from ${new Date(captureFromMs).toISOString()})`
        : '(not an onboard trip)'
    }`
  )

  if (stubbed.size) {
    console.warn(
      `\n⚠  Some replay-critical payloads were stubbed: ${[...stubbed].join(
        ', '
      )}.\n` +
        '   Replay of those aspects (vehicle matching / reroute / arrivals) ' +
        'will be incomplete.\n' +
        '   Recording defaults ON, so this is almost certainly a SIZE cap, not ' +
        'a missing flag:\n' +
        '     __summary          -> over MAX_FULL_PAYLOAD_CHARS (lib/util/debug-log.js)\n' +
        '     __truncated_chars  -> over DEBUG_LOG_MAX_LINE_CHARS (preferences_api.py)\n' +
        '   Both must be raised together; check the browser console during the ' +
        "ride for the\n   recorder's own over-ceiling warning."
    )
  }
  if (!fixture.gpsTrack.length) {
    console.warn(
      '\n⚠  No GPS fixes captured — replay has nothing to drive the trip.'
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
