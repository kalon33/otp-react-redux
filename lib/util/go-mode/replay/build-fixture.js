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
 * Usage:
 *   node build-fixture.js --latest --label my-trip
 *   node build-fixture.js --session mqfnldc3-rcr8ch --label orange-line --out /path/foo.json
 *
 * Flags:
 *   --session <id>   session id to build (see the `session` field in the JSONL)
 *   --latest         instead of --session, pick the most recent session that
 *                    contains a START_GO_MODE (a real Go trip)
 *   --label <name>   human label stored in meta.label; also the default filename
 *   --out <path>     output path (default: ./fixtures/<label>.json next to this)
 *   --logs-dir <p>   debug-log dir (default: $DEBUG_LOG_DIR or ~/otp-debug-logs)
 */

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

function parseArgs(argv) {
  const args = { latest: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--latest') args.latest = true
    else if (a === '--session') args.session = argv[++i]
    else if (a === '--label') args.label = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--logs-dir') args.logsDir = argv[++i]
    else {
      console.error(`Unknown argument: ${a}`)
      process.exit(1)
    }
  }
  return args
}

/** Every parsed entry from every debug-*.jsonl in the logs dir. */
function readAllEntries(logsDir) {
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
  for (const f of files) {
    const text = fs.readFileSync(path.join(logsDir, f), 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line))
      } catch {
        // skip malformed line
      }
    }
  }
  return entries
}

/** Client event time in ms; fall back to the server receive time. */
function entryMs(e) {
  if (typeof e.t === 'number') return e.t
  if (typeof e.recv === 'number') return Math.round(e.recv * 1000)
  return 0
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
  const args = parseArgs(process.argv)
  const logsDir =
    args.logsDir ||
    process.env.DEBUG_LOG_DIR ||
    path.join(os.homedir(), 'otp-debug-logs')

  const all = readAllEntries(logsDir)
  if (!all.length) {
    console.error(`No log entries found in ${logsDir}`)
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
    // Most recent session that actually contains a START_GO_MODE.
    let bestMs = -1
    for (const [s, es] of bySession) {
      const start = es.find((e) => e.type === 'START_GO_MODE')
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

  const startEvt = events.find((e) => e.type === 'START_GO_MODE')
  if (!startEvt) {
    console.error(`Session ${session} has no START_GO_MODE — not a Go trip.`)
    process.exit(1)
  }
  if (isStub(startEvt.payload) || !startEvt.payload?.itinerary) {
    console.error(
      'START_GO_MODE payload is stubbed/summarised — the itinerary is gone, ' +
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

  const stopEvt = [...events].reverse().find((e) => e.type === 'STOP_GO_MODE')
  const startMs = entryMs(startEvt)
  const endMs = stopEvt ? entryMs(stopEvt) : entryMs(events[events.length - 1])

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
    meta: {
      endMs,
      homeTimezone: itinerary.timeZone || 'America/Chicago',
      label,
      notes: '',
      recordedAt: new Date(startMs).toISOString(),
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
    if (FULL_PAYLOAD_TYPES.includes(e.type) && isStub(e.payload)) {
      noteStub(e.type)
    }
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
    'tripSnapshots'
  ]) {
    fixture[key].sort((a, b) => a.tMs - b.tMs)
  }

  const outPath = args.out || path.join(__dirname, 'fixtures', `${label}.json`)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n')

  const durS = Math.round((endMs - startMs) / 1000)
  console.log(`\nFixture written: ${outPath}`)
  console.log(`  session:          ${session}`)
  console.log(
    `  duration:         ${durS}s (${new Date(startMs).toISOString()})`
  )
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

main()
