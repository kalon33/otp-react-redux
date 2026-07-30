/* eslint-disable no-console */
/**
 * Transit-trust verification: replay the real 2026-07-29 Orange Line incident
 * (session ms6m3bgy-0j7v94) and assert the trust chain holds while the rider
 * is aboard. On that ride one stale GTFS-RT position for bus 1:8140 caused:
 * a MISSED_BUS auto-replan firing while the bus was pulling in (17:27:32),
 * the vehicle matcher flapping to the OPPOSITE-direction bus 1:8141 (trip
 * 1:1082792, 847m vs 852m) across I-35W, the riding fact rebinding onto that
 * trip, two boarded-earlier auto-replans replacing the whole itinerary, and a
 * false "GET READY! Next stop is yours!" with ~5 stops left.
 *
 * Harness: unlike the schedule-simulation scripts (verify-missed-bus), this is
 * a full trip REPLAY — the recorded fixture drives GPS, the simulated clock,
 * and every OTP read (vehicle positions, stop times, reroute plans) via the
 * replay engine (window.__replayTrip). A store.subscribe recorder installed
 * before the replay captures notifications, reRoute transitions, riding
 * changes, vehicleMatch flips, itinerary swaps, and per-tick progress samples;
 * assertions run on that timeline afterwards. Run against unfixed code this
 * script fails loud on the incident chain — that is its detection power.
 *
 * ONE recorded state is reconstructed by hand (the "tracking reset", below):
 * on the real ride the 17:27:32 MISSED_BUS auto-swap re-entered START_GO_MODE
 * right as the rider boarded, wiping the (not-yet-confirmed) vehicle match and
 * restarting vehicle tracking — which is precisely why matching was still
 * LIVE at 17:28:44 when the stale feed made opposing bus 1:8141 the nearest
 * candidate. The replay engine cannot re-arm that missed-bus on its own:
 * refreshLiveLegTimes and the departure auto-anchor are disabled under replay
 * (`!isReplayActive()` — actions/go-mode.ts, "Skipped in replay"), so
 * liveLegTimes stays empty and the departed-epoch evidence never forms, and
 * the fixture's vehicle feed starts at 17:27:34 (pre-boarding polls were not
 * recorded). Without the reset, the auto-confirm that runs on the very first
 * medium-confidence match (performVehicleMatching -> confirmVehicleSelection)
 * freezes matching on 8140 and hides the flap in BOTH codebases. So once the
 * rider is aboard with a confirmed match, this script dispatches the same two
 * state effects the real swap produced — CLEAR_VEHICLE_MATCH and a fresh
 * SET_TRANSIT_LEG_ENTERED — and lets the replay run on. Everything after that
 * is the app's own behavior on recorded data.
 *
 * Asserts, for the whole replay / the aboard window:
 *   a. zero MISSED_BUS notifications (fixed-code contract; cannot fail on old
 *      code under replay — see tracking-reset note above; the old-code misfire
 *      is covered by the classifyMissedBus unit tests)
 *   b. zero autoApply reroutes (missed-bus / boarded-earlier) and zero
 *      itinerary replacements after boarding
 *   c. riding stays trip 1:1173133 / vehicle 1:8140 for the whole bus leg
 *   d. stopsRemaining starts at 4, is non-increasing, stays >1 through the
 *      first half of the leg, and hits 1 only near the end (no false GET READY)
 *   e. no sustained (>15s sim time) 'deviated' status while riding is held
 *
 * Validated against the UNFIXED code (2026-07-29): b and c FAIL with the
 * exact incident signature — riding rebinds to 1:1082792/1:8141 at 17:28:46
 * (847m vs 826m, matching telemetry) and boarded-earlier autoApply reroutes
 * replace the itinerary at 17:28:47 — while a/d/e stay green there: a needs
 * the disabled liveLegTimes machinery, and d/e are downstream of the real
 * ride's full anchor state (its cascade landed on itineraries the rider was
 * never on; the replay's swap lands on a same-stop alternative). b+c are the
 * replay-detected links of the chain; d/e guard the fixed-code contract.
 */
const fs = require('fs')
const path = require('path')

const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'
const SPEED = Number(process.env.REPLAY_SPEED || 25)
const FIXTURE_PATH = path.join(
  __dirname,
  '../lib/util/go-mode/replay/fixtures/orange-line-0729.json'
)

// Ground truth from the ride the fixture records.
const BOARDED = {
  tripId: '1:1173133',
  vehicleId: '1:8140'
}
const WRONG = {
  tripId: '1:1082792',
  vehicleId: '1:8141'
}
const INITIAL_STOPS_REMAINING = 4
// 'near the end' for the GET READY / stopsRemaining===1 check: last 30% of
// the aboard window (gentle — the real last-stop segment is ~the last 20%).
const NEAR_END_FRACTION = 0.7
const DEVIATED_SUSTAINED_MS = 15000

const fmt = (ms) =>
  ms == null
    ? 'n/a'
    : new Date(ms).toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: 'America/Chicago'
      })

const results = []
function check(name, pass, detail) {
  results.push({ detail, name, pass })
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`
  )
}

async function main() {
  const fixtureJson = fs.readFileSync(FIXTURE_PATH, 'utf8')
  const fixture = JSON.parse(fixtureJson)
  console.log(
    `[setup] fixture ${fixture.meta.label}: ${fixture.gpsTrack.length} fixes ` +
      `${fmt(fixture.meta.startMs)} -> ${fmt(fixture.meta.endMs)}, ` +
      `${fixture.vehicleSnapshots.length} vehicle snapshots, replay ${SPEED}x`
  )

  const browser = await puppeteer.launch({
    args: ['--no-sandbox'],
    executablePath: CHROME,
    headless: 'new'
  })
  const page = await browser.newPage()
  await page.setViewport({ height: 850, width: 393 })
  await browser
    .defaultBrowserContext()
    .overridePermissions(APP, ['geolocation'])
  await page.setGeolocation({
    accuracy: 10,
    latitude: fixture.gpsTrack[0].lat,
    longitude: fixture.gpsTrack[0].lon
  })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  if (process.env.DEBUG) {
    page.on('console', (m) => console.log('[page]', m.text()))
  }
  await page.goto(APP, { timeout: 60000, waitUntil: 'networkidle2' })
  await page.waitForFunction(
    () => !!window.store && typeof window.__replayTrip === 'function',
    { timeout: 30000 }
  )

  // ---- ship the fixture into the page (chunked: ~12MB JSON) ----
  await page.evaluate(() => {
    window.__fxParts = []
  })
  const CHUNK = 2 * 1024 * 1024
  for (let i = 0; i < fixtureJson.length; i += CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate((part) => {
      window.__fxParts.push(part)
    }, fixtureJson.slice(i, i + CHUNK))
  }
  await page.evaluate(() => {
    window.__fixture = JSON.parse(window.__fxParts.join(''))
    delete window.__fxParts
  })

  // ---- install the timeline recorder BEFORE the replay starts ----
  await page.evaluate(() => {
    const rec = (window.__rec = {
      itinerarySwaps: [],
      notifications: [],
      progressSamples: [],
      reroutes: [],
      ridingChanges: [],
      vehicleMatches: []
    })
    const seenNotifs = new Set()
    let lastNotifArr = null
    let lastReRoute = null
    let lastRidingKey = 'uninit'
    let lastItin = window.store.getState().otp.goMode?.activeItinerary ?? null
    let lastProgress = null
    let lastSimMs = null
    let lastVmKey = 'uninit'
    window.store.subscribe(() => {
      const g = window.store.getState().otp.goMode
      if (!g) return
      // Only record while the replay track is actually playing: once
      // STOP_GPS_SIMULATION lands, getCurrentTime() reverts to WALL time (the
      // known pause trap) and any straggler ticks would smear hours of bogus
      // wall-clock "delay" noise onto the end of the aboard window.
      if (g.simulation.status !== 'running') return
      // Per-tick progress sample (the sim clock rides along in currentTime).
      const p = g.progress
      if (p && p.currentTime) {
        const t = new Date(p.currentTime).getTime()
        lastSimMs = t
        if (p !== lastProgress) {
          lastProgress = p
          rec.progressSamples.push({
            legIndex: p.currentLegIndex,
            ridingHeld: !!g.riding,
            status: p.status,
            stopsRemaining: p.stopsRemaining ?? null,
            t
          })
        }
      }
      // Notifications — diffed by identity because START_GO_MODE (an
      // auto-applied swap) clears recentNotifications; we must not lose the
      // MISSED_BUS that caused the very swap that erased it.
      const arr = g.notifications && g.notifications.recentNotifications
      if (arr && arr !== lastNotifArr) {
        lastNotifArr = arr
        for (const n of arr) {
          const key = `${n.id}|${n.type}|${n.message}`
          if (!seenNotifs.has(key)) {
            seenNotifs.add(key)
            rec.notifications.push({
              message: n.message,
              t: lastSimMs,
              type: n.type
            })
          }
        }
      }
      // reRoute status transitions (searching/found/... with reason+autoApply)
      const rr = g.reRoute
      if (rr && rr !== lastReRoute) {
        const prevStatus = lastReRoute ? lastReRoute.status : 'idle'
        lastReRoute = rr
        if (rr.status !== prevStatus) {
          rec.reroutes.push({
            autoApply: !!rr.autoApply,
            reason: rr.reason,
            status: rr.status,
            t: lastSimMs
          })
        }
      }
      // riding fact changes (tripId/vehicleId/legIndex only — offRouteSince
      // ticks are noise)
      const r = g.riding
      const rKey = r ? `${r.tripId}|${r.vehicleId}|${r.legIndex}` : 'null'
      if (rKey !== lastRidingKey) {
        lastRidingKey = rKey
        rec.ridingChanges.push({
          legIndex: r ? r.legIndex : null,
          t: lastSimMs,
          tripId: r ? r.tripId : null,
          vehicleId: r ? r.vehicleId : null
        })
      }
      // vehicle-match transitions — the raw signal riding rebinds key off;
      // evidence for WHICH bus the matcher believed in, and when
      const vm = g.vehicleMatch && g.vehicleMatch.match
      const vmKey = vm
        ? `${vm.vehicleId}|${vm.tripId}|${vm.confidence}`
        : 'null'
      if (vmKey !== lastVmKey) {
        lastVmKey = vmKey
        rec.vehicleMatches.push({
          confidence: vm ? vm.confidence : null,
          distanceMeters: vm ? vm.distanceMeters : null,
          t: lastSimMs,
          tripId: vm ? vm.tripId : null,
          vehicleId: vm ? vm.vehicleId : null
        })
      }
      // whole-itinerary replacements (START_GO_MODE re-entry)
      const it = g.activeItinerary
      if (it !== lastItin) {
        lastItin = it
        if (it) {
          rec.itinerarySwaps.push({
            startTime: Number(it.startTime),
            t: lastSimMs
          })
        }
      }
    })

    // Tracking reset — reconstructs the one recorded state the replay engine
    // cannot produce itself (see file header): the real missed-bus auto-swap
    // wiped the vehicle match and restarted vehicle tracking right as the
    // rider boarded, leaving matching LIVE for the 17:28:44 stale-feed window.
    // Fire once, as soon as the rider is aboard with a confirmed match (the
    // auto-confirm lands within a tick of riding in both codebases).
    const trigger = setInterval(() => {
      const g = window.store.getState().otp.goMode
      if (!g || !g.riding) return
      const vm = g.vehicleMatch && g.vehicleMatch.match
      if (!vm || vm.confidence !== 'confirmed') return
      clearInterval(trigger)
      const simNow =
        g.progress && g.progress.currentTime
          ? new Date(g.progress.currentTime).getTime()
          : null
      window.store.dispatch({ type: 'CLEAR_VEHICLE_MATCH' })
      window.store.dispatch({
        payload: simNow,
        type: 'SET_TRANSIT_LEG_ENTERED'
      })
      rec.trackingReset = { t: simNow }
    }, 40)
  })

  // ---- run the replay ----
  await page.evaluate(
    (speed) =>
      window.__replayTrip(window.__fixture, { speedMultiplier: speed }),
    SPEED
  )
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.simulation.status === 'running',
    { polling: 200, timeout: 20000 }
  )
  console.log('[replay] running')

  const started = Date.now()
  // 3560 fixes floor at 50ms/tick ≈ 3 min; give it 15.
  const deadline = started + 15 * 60 * 1000
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const s = await page.evaluate(() => {
      const g = window.store.getState().otp.goMode
      return {
        pointIndex: g.simulation.pointIndex,
        simTime: g.progress?.currentTime
          ? new Date(g.progress.currentTime).getTime()
          : null,
        status: g.simulation.status,
        totalPoints: g.simulation.totalPoints
      }
    })
    if (s.status !== 'running') break
    console.log(
      `[replay] ${s.pointIndex}/${s.totalPoints} sim-time ${fmt(s.simTime)}`
    )
    if (Date.now() > deadline) throw new Error('replay did not finish in 15min')
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 15000))
  }
  console.log(
    `[replay] complete in ${((Date.now() - started) / 60000).toFixed(
      1
    )} min wall`
  )

  const rec = await page.evaluate(() => window.__rec)
  await browser.close()

  // ---- reconstruct the aboard window ----
  const firstRiding = rec.ridingChanges.find((r) => r.tripId)
  if (!firstRiding) {
    check('riding fact established during replay', false, 'riding never set')
    throw new Error(
      'riding never established — replay did not reproduce boarding'
    )
  }
  const aboardSamples = rec.progressSamples.filter(
    (p) => p.ridingHeld && p.t >= firstRiding.t
  )
  const aboardEnd = aboardSamples.length
    ? aboardSamples[aboardSamples.length - 1].t
    : firstRiding.t
  console.log(
    `\n[aboard] riding established ${fmt(firstRiding.t)} on ` +
      `${firstRiding.tripId}/${firstRiding.vehicleId}, held until ${fmt(
        aboardEnd
      )}`
  )

  // ---- evidence timeline ----
  console.log('\n===== TIMELINE =====')
  if (rec.trackingReset) {
    console.log(
      `  ${fmt(rec.trackingReset.t)}  [script] tracking reset (replays the ` +
        'recorded missed-bus swap state — see header)'
    )
  } else {
    console.log('  [script] tracking reset never fired (no confirmed match)')
  }
  for (const n of rec.notifications) {
    console.log(`  ${fmt(n.t)}  notify ${n.type}: ${n.message}`)
  }
  for (const e of rec.reroutes) {
    console.log(
      `  ${fmt(e.t)}  reroute -> ${e.status}` +
        `${e.reason ? ` (${e.reason})` : ''}${
          e.autoApply ? ' [autoApply]' : ''
        }`
    )
  }
  for (const r of rec.ridingChanges) {
    console.log(
      `  ${fmt(r.t)}  riding -> ${r.tripId || 'null'}/${
        r.vehicleId || 'null'
      } leg ${r.legIndex}`
    )
  }
  for (const s of rec.itinerarySwaps) {
    console.log(`  ${fmt(s.t)}  itinerary -> departs ${fmt(s.startTime)}`)
  }
  for (const v of rec.vehicleMatches) {
    console.log(
      `  ${fmt(v.t)}  vehicleMatch -> ${v.vehicleId || 'none'}` +
        `${v.tripId ? ` ${v.tripId}` : ''} (${v.confidence || 'n/a'}` +
        `${v.distanceMeters != null ? `, ${v.distanceMeters}m` : ''})`
    )
  }

  console.log('\n===== ASSERTIONS =====')

  // (a) zero MISSED_BUS notifications across the whole replay
  const missed = rec.notifications.filter((n) => n.type === 'MISSED_BUS')
  check(
    'a. no MISSED_BUS notification for a bus the rider caught',
    missed.length === 0,
    missed.length
      ? missed.map((n) => `${fmt(n.t)} "${n.message}"`).join('; ')
      : 'none fired'
  )

  // (b) zero autoApply reroutes + zero itinerary replacements after boarding
  const autoReplans = rec.reroutes.filter(
    (e) =>
      e.status === 'searching' &&
      e.autoApply &&
      ['boarded-earlier', 'missed-bus'].includes(e.reason) &&
      e.t >= firstRiding.t
  )
  const swapsAboard = rec.itinerarySwaps.filter((s) => s.t >= firstRiding.t)
  check(
    'b. no autoApply replans / itinerary swaps once aboard',
    autoReplans.length === 0 && swapsAboard.length === 0,
    `${autoReplans.length} autoApply reroute(s) [${autoReplans
      .map((e) => `${fmt(e.t)} ${e.reason}`)
      .join(', ')}], ${swapsAboard.length} itinerary swap(s)`
  )

  // (c) riding identity stays on the boarded bus for the whole leg
  const rebinds = rec.ridingChanges.filter(
    (r) =>
      r.t > firstRiding.t &&
      r.tripId &&
      (r.tripId !== BOARDED.tripId || r.vehicleId !== BOARDED.vehicleId)
  )
  const midLegClears = rec.ridingChanges.filter(
    (r) =>
      r.t > firstRiding.t &&
      !r.tripId &&
      r.t < firstRiding.t + (aboardEnd - firstRiding.t) * 0.9
  )
  check(
    `c. riding stays ${BOARDED.tripId}/${BOARDED.vehicleId} while aboard`,
    firstRiding.tripId === BOARDED.tripId &&
      firstRiding.vehicleId === BOARDED.vehicleId &&
      rebinds.length === 0,
    rebinds.length
      ? `rebound to ${rebinds
          .map((r) => `${r.tripId}/${r.vehicleId} @ ${fmt(r.t)}`)
          .join(', ')}` +
          (rebinds.some((r) => r.tripId === WRONG.tripId)
            ? ' — the OPPOSING bus across I-35W'
            : '')
      : `boarded ${firstRiding.tripId}/${firstRiding.vehicleId}` +
          (midLegClears.length
            ? ` (note: ${midLegClears.length} mid-leg riding clear(s))`
            : '')
  )

  // (d) stopsRemaining: starts at 4, non-increasing, >1 in the first half,
  //     ===1 only near the end
  const stopSamples = aboardSamples.filter((p) => p.stopsRemaining != null)
  const windowLen = aboardEnd - firstRiding.t
  const midpoint = firstRiding.t + windowLen / 2
  const nearEnd = firstRiding.t + windowLen * NEAR_END_FRACTION
  let nonIncreasing = true
  let increaseAt = null
  for (let i = 1; i < stopSamples.length; i++) {
    if (stopSamples[i].stopsRemaining > stopSamples[i - 1].stopsRemaining) {
      nonIncreasing = false
      increaseAt = stopSamples[i]
      break
    }
  }
  const firstHalfCollapse = stopSamples.find(
    (p) => p.t < midpoint && p.stopsRemaining <= 1
  )
  const earlyGetReady = stopSamples.find(
    (p) => p.stopsRemaining === 1 && p.t < nearEnd
  )
  const firstStops = stopSamples.length ? stopSamples[0].stopsRemaining : null
  check(
    `d. stopsRemaining starts at ${INITIAL_STOPS_REMAINING}, non-increasing, GET READY only near the end`,
    stopSamples.length > 0 &&
      firstStops === INITIAL_STOPS_REMAINING &&
      nonIncreasing &&
      !firstHalfCollapse &&
      !earlyGetReady,
    [
      `first=${firstStops}`,
      nonIncreasing
        ? 'non-increasing'
        : `INCREASES to ${increaseAt.stopsRemaining} @ ${fmt(increaseAt.t)}`,
      firstHalfCollapse
        ? `collapses to ${firstHalfCollapse.stopsRemaining} @ ${fmt(
            firstHalfCollapse.t
          )} (first half!)`
        : 'first half >1',
      earlyGetReady
        ? `stopsRemaining=1 @ ${fmt(earlyGetReady.t)} (before ${fmt(nearEnd)})`
        : 'reaches 1 only near the end'
    ].join(', ')
  )

  // (e) no sustained deviated status while riding is held
  let worstRun = 0
  let worstRunAt = null
  let runStart = null
  for (const p of aboardSamples) {
    if (p.status === 'deviated') {
      if (runStart == null) runStart = p.t
      const len = p.t - runStart
      if (len > worstRun) {
        worstRun = len
        worstRunAt = runStart
      }
    } else {
      runStart = null
    }
  }
  check(
    `e. no 'deviated' streak >${DEVIATED_SUSTAINED_MS / 1000}s while aboard`,
    worstRun <= DEVIATED_SUSTAINED_MS,
    worstRun
      ? `longest deviated streak ${(worstRun / 1000).toFixed(
          0
        )}s starting ${fmt(worstRunAt)}`
      : 'never deviated while aboard'
  )

  // ---- summary ----
  const failed = results.filter((r) => !r.pass)
  console.log('\n===== RESULT =====')
  if (failed.length) {
    console.log(
      `FAIL: ${failed.length}/${results.length} assertions failed — ` +
        failed.map((f) => f.name.slice(0, 1)).join(', ')
    )
    process.exit(1)
  }
  console.log(
    `PASS: all ${results.length} transit-trust assertions held for the 7/29 replay`
  )
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
