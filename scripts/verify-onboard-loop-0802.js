/* eslint-disable no-console */
/**
 * Replay the real 2026-08-02 Orange Line ride (session msck14g3-iws2im) and
 * assert the app stops doing what it did that night. The rider boarded via the
 * onboard "I'm already on a bus" flow; over 61 minutes Go Mode replaced their
 * itinerary NINE times unasked, buzzed a high-priority "Trip updated" push
 * each time quoting an arrival already in the past, and held the red "GET
 * READY! Next stop is yours!" banner for the whole ride.
 *
 * Root cause (see the commits this script gates): Metro Transit publishes two
 * GTFS-RT records for vehicle 1:8223 — the live one on trip 1:1201789 and a
 * ghost for the bus's next block trip (1:1191630) at lat 0, lon 0.
 * refreshConfirmedMatch took the first match, so every poll copied the ghost's
 * trip id into the confirmed match and armed the boarded-earlier replan.
 * Because the trigger read match.tripId while the remedy splices from the
 * frozen riding.tripId, the replan could never satisfy itself: all nine
 * applied itineraries were byte-identical.
 *
 * Harness: identical to verify-transit-trust.js — the fixture drives GPS, the
 * simulated clock and every OTP read through window.__replayTrip, and a
 * store.subscribe recorder installed before the replay captures the timeline.
 * No hand-reconstructed state here; unlike the 7/29 script this ride needs
 * none, because the rider was already aboard when recording started.
 *
 * KNOWN LIMITATION: SET_ONBOARD_RESULT and SET_ONBOARD_TRIP were summarised at
 * capture, so the fixture starts from the already-split itinerary and cannot
 * reproduce the leg-split BUILDER bug. That half is covered by unit tests
 * built from the recorded leg shape (__tests__/util/go-mode/leg-merge.ts).
 * Everything after START_GO_MODE replays faithfully, which is what this
 * script asserts:
 *
 *   a. at most ONE itinerary swap, not nine
 *   b. no TRIP_UPDATED push quoting an arrival time already in the past
 *   c. the bus leg is ONE leg of trip 1:1201789, not two with a phantom
 *      transfer — the normalization pass runs on the replay bootstrap too
 *   d. the bus leg renders in Orange Line orange (F68B1F), not default blue
 *   e. no leg ever arrives before it departs
 *
 * Validated against the UNFIXED code (039cf691): a, c and e FAIL with the
 * exact incident signature — the confirmed match adopts ghost trip 1:1191630
 * three times at distanceMeters 10,265,526 (the haversine to null island,
 * matching the recorded telemetry), the itinerary is replaced twice while
 * aboard, the ride renders as two legs with 1 transfer, and two swaps carry
 * inverted legs. b and d PASS on the unfixed code and are contract checks
 * only, for a reason worth stating: both defects live in the builder path
 * (buildOnboardItinerary), and SET_ONBOARD_RESULT / SET_ONBOARD_TRIP were
 * summarised at capture — so this fixture cannot reach it. The builder's own
 * behavior is covered by unit tests instead (onboard-flow.ts: the
 * past-arrival clamp and the convertGraphQLResponseToLegacy flattening).
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
  '../lib/util/go-mode/replay/fixtures/orange-onboard-0802.json'
)

// Ground truth from the ride the fixture records.
const RIDDEN_TRIP = '1:1201789'
const GHOST_TRIP = '1:1191630'
const ORANGE_LINE_COLOR = 'F68B1F'
// One swap is tolerated: a single legitimate correction as the app settles
// onto the ridden trip is the designed behavior. Nine is the defect.
const MAX_ITINERARY_SWAPS = 1

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

  // The defect's own input, straight from the recording: prove the twin
  // records the whole chain hung on are actually in this fixture.
  const recordsFor = (snap) =>
    ((snap.payload && snap.payload.vehicles) || snap.vehicles || []).filter(
      (v) => v.vehicleId === '1:8223'
    )
  const twins = fixture.vehicleSnapshots.filter((s) => recordsFor(s).length > 1)
  const ghostFirst = twins.filter((s) => {
    const first = recordsFor(s)[0]
    return !first.lat || !first.lon
  })
  if (twins.length === 0) {
    throw new Error(
      'fixture carries no twin records for 1:8223 — this script would pass ' +
        'vacuously; the defect input is gone or the snapshot shape changed'
    )
  }
  console.log(
    `[setup] ${twins.length} snapshot(s) carry two records for 1:8223; ` +
      `the coordinateless ghost (${GHOST_TRIP}) is listed FIRST in ` +
      `${ghostFirst.length} of them`
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

  // ---- ship the fixture into the page (chunked: ~9MB JSON) ----
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
      matchTripIds: [],
      notifications: [],
      progressSamples: [],
      ridingChanges: []
    })
    const seenNotifs = new Set()
    let lastNotifArr = null
    let lastItin = window.store.getState().otp.goMode?.activeItinerary ?? null
    let lastProgress = null
    let lastSimMs = null
    let lastMatchTrip = 'uninit'
    let lastRidingKey = 'uninit'

    // The itinerary shape, reduced to what the assertions need. Captured at
    // every swap so a late regression can't hide behind a good first render.
    const shapeOf = (it) => ({
      busLegs: (it.legs || [])
        .filter((l) => l.transitLeg)
        .map((l) => ({
          endTime: Number(l.endTime),
          from: l.from && l.from.name,
          intermediates:
            (l.intermediatePlaces || l.intermediateStops || []).length,
          routeColor: l.routeColor || (l.route && l.route.color) || null,
          startTime: Number(l.startTime),
          to: l.to && l.to.name,
          tripId: (l.trip && l.trip.gtfsId) || l.tripId || null
        })),
      inverted: (it.legs || [])
        .filter((l) => Number(l.endTime) < Number(l.startTime))
        .map((l) => ({
          endTime: Number(l.endTime),
          mode: l.mode,
          startTime: Number(l.startTime)
        })),
      legCount: (it.legs || []).length,
      startTime: Number(it.startTime),
      transfers: it.transfers
    })

    window.store.subscribe(() => {
      const g = window.store.getState().otp.goMode
      if (!g) return
      // Only record while the replay track is playing: once
      // STOP_GPS_SIMULATION lands, getCurrentTime() reverts to WALL time (the
      // known pause trap) and stragglers would smear bogus hours onto the end.
      if (g.simulation.status !== 'running') return
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
      // Notifications — diffed by identity, because START_GO_MODE clears
      // recentNotifications and would otherwise erase the very push that the
      // swap it accompanied produced.
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
      // The sticky riding fact — bounds the aboard window the assertions use.
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
      // Which trip the confirmed match believes in — the ghost's id appearing
      // here is the original defect's fingerprint.
      const vm = g.vehicleMatch && g.vehicleMatch.match
      const key = vm ? `${vm.vehicleId}|${vm.tripId}` : 'null'
      if (key !== lastMatchTrip) {
        lastMatchTrip = key
        rec.matchTripIds.push({
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
        if (it) rec.itinerarySwaps.push({ ...shapeOf(it), t: lastSimMs })
      }
    })
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

  // The itinerary the replay bootstrap installed, before any swap: this is
  // where normalizeGoModeItinerary's merge shows up.
  const bootstrapShape = await page.evaluate(() => {
    const it = window.store.getState().otp.goMode.activeItinerary
    if (!it) return null
    return {
      legs: (it.legs || []).map((l) => ({
        endTime: Number(l.endTime),
        from: l.from && l.from.name,
        intermediates:
          (l.intermediatePlaces || l.intermediateStops || []).length,
        mode: l.mode,
        routeColor: l.routeColor || (l.route && l.route.color) || null,
        startTime: Number(l.startTime),
        to: l.to && l.to.name,
        transitLeg: !!l.transitLeg,
        tripId: (l.trip && l.trip.gtfsId) || l.tripId || null
      })),
      transfers: it.transfers
    }
  })

  const started = Date.now()
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
    `[replay] complete in ${((Date.now() - started) / 60000).toFixed(1)} min`
  )

  const rec = await page.evaluate(() => window.__rec)
  await browser.close()

  // ---- evidence timeline ----
  console.log('\n===== TIMELINE =====')
  console.log('[bootstrap itinerary]')
  for (const l of bootstrapShape ? bootstrapShape.legs : []) {
    console.log(
      `  ${l.mode.padEnd(8)} ${fmt(l.startTime)} -> ${fmt(l.endTime)}  ` +
        `${l.from} -> ${l.to}` +
        (l.transitLeg
          ? `  trip ${l.tripId} color ${l.routeColor || 'none'} ` +
            `(${l.intermediates} intermediate stops)`
          : '')
    )
  }
  console.log(`  transfers: ${bootstrapShape && bootstrapShape.transfers}`)
  for (const n of rec.notifications) {
    console.log(`  ${fmt(n.t)}  notify ${n.type}: ${n.message}`)
  }
  for (const m of rec.matchTripIds) {
    console.log(
      `  ${fmt(m.t)}  match -> ${m.vehicleId || 'none'} ${m.tripId || 'n/a'}` +
        `${m.distanceMeters != null ? ` (${m.distanceMeters}m)` : ''}`
    )
  }
  for (const s of rec.itinerarySwaps) {
    console.log(
      `  ${fmt(s.t)}  itinerary swap -> ${s.legCount} legs, ` +
        `${s.transfers} transfer(s), departs ${fmt(s.startTime)}`
    )
  }

  console.log('\n===== ASSERTIONS =====')

  // ---- the aboard window ----
  // The defect was nine swaps WHILE THE RIDER WAS ON THE BUS. After they
  // alight, this ride continues as a 50-minute bike leg on which the rider
  // genuinely deviates several times, and the quiet access replan swapping
  // the itinerary there is designed behavior (7/29: "only reroute the bike
  // leg"). Counting those would make this script assert against a fix.
  const firstRiding = rec.ridingChanges.find((r) => r.tripId)
  const aboardSamples = firstRiding
    ? rec.progressSamples.filter((p) => p.ridingHeld && p.t >= firstRiding.t)
    : []
  const aboardEnd = aboardSamples.length
    ? aboardSamples[aboardSamples.length - 1].t
    : null
  console.log(
    firstRiding
      ? `[aboard] ${fmt(firstRiding.t)} -> ${fmt(aboardEnd)} on ` +
          `${firstRiding.tripId}/${firstRiding.vehicleId}`
      : '[aboard] riding never established'
  )

  // (a) the loop itself. `t: null` is the bootstrap install, not a swap.
  const aboardSwaps = rec.itinerarySwaps.filter(
    (s) =>
      s.t != null &&
      firstRiding &&
      s.t >= firstRiding.t &&
      (aboardEnd == null || s.t <= aboardEnd)
  )
  check(
    `a. at most ${MAX_ITINERARY_SWAPS} itinerary swap while aboard, not nine`,
    !!firstRiding && aboardSwaps.length <= MAX_ITINERARY_SWAPS,
    firstRiding
      ? `${aboardSwaps.length} swap(s) aboard` +
          (aboardSwaps.length
            ? `: ${aboardSwaps.map((s) => fmt(s.t)).join(', ')}`
            : '') +
          `; ${
            rec.itinerarySwaps.filter((s) => s.t != null).length -
            aboardSwaps.length
          } after alighting (bike-leg deviation replans — designed)`
      : 'riding never established, so nothing to bound the window'
  )

  // (b) no push quoting an arrival that already happened. The message carries
  // a clock time ("arriving 9:23 PM"); compare it against the SIM clock at
  // which the push fired, which is what the rider's phone showed.
  const tripUpdated = rec.notifications.filter((n) => n.type === 'TRIP_UPDATED')
  const pastQuotes = tripUpdated.filter((n) => {
    const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(n.message || '')
    if (!m || n.t == null) return false
    const shown = new Date(n.t)
    let hour = Number(m[1]) % 12
    if (/PM/i.test(m[3])) hour += 12
    // Reconstruct the quoted instant on the same America/Chicago day.
    const local = new Date(
      new Date(n.t).toLocaleString('en-US', { timeZone: 'America/Chicago' })
    )
    local.setHours(hour, Number(m[2]), 0, 0)
    const offset = shown.getTime() - local.getTime()
    // Quoted more than a minute BEFORE the push landed.
    return offset > 60000
  })
  check(
    'b. no "Trip updated" push quoting an arrival already in the past',
    pastQuotes.length === 0,
    `${tripUpdated.length} TRIP_UPDATED push(es), ${pastQuotes.length} quoting the past` +
      (pastQuotes.length
        ? `: ${pastQuotes.map((n) => `${fmt(n.t)} "${n.message}"`).join('; ')}`
        : '')
  )

  // (c) one bus ride, one leg
  const shapes = [
    ...(bootstrapShape
      ? [
          {
            busLegs: bootstrapShape.legs
              .filter((l) => l.transitLeg)
              .map((l) => ({ ...l })),
            label: 'bootstrap',
            transfers: bootstrapShape.transfers
          }
        ]
      : []),
    ...rec.itinerarySwaps.map((s, i) => ({
      busLegs: s.busLegs,
      label: `swap ${i + 1} @ ${fmt(s.t)}`,
      transfers: s.transfers
    }))
  ]
  const splitShapes = shapes.filter((s) => {
    const ridden = s.busLegs.filter((l) => l.tripId === RIDDEN_TRIP)
    return ridden.length > 1
  })
  check(
    `c. the ${RIDDEN_TRIP} ride is ONE leg, no phantom transfer`,
    shapes.length > 0 && splitShapes.length === 0,
    splitShapes.length
      ? `${splitShapes.length} itinerary shape(s) still split it: ` +
          splitShapes
            .map(
              (s) =>
                `${s.label} (${
                  s.busLegs.filter((l) => l.tripId === RIDDEN_TRIP).length
                } legs, ${s.transfers} transfers)`
            )
            .join('; ')
      : `${shapes.length} itinerary shape(s) checked, all single-leg` +
          (shapes[0]
            ? `; transfers=${shapes[0].transfers}, junction stops kept=${
                (shapes[0].busLegs[0] || {}).intermediates
              }`
            : '')
  )

  // (d) Orange Line orange, not default blue
  const colorless = shapes.filter((s) =>
    s.busLegs.some(
      (l) =>
        l.tripId === RIDDEN_TRIP &&
        String(l.routeColor || '').toUpperCase() !== ORANGE_LINE_COLOR
    )
  )
  check(
    `d. the bus leg renders ${ORANGE_LINE_COLOR}, not default blue`,
    shapes.length > 0 && colorless.length === 0,
    colorless.length
      ? colorless
          .map(
            (s) =>
              `${s.label}: ${s.busLegs
                .map((l) => l.routeColor || 'none')
                .join(', ')}`
          )
          .join('; ')
      : `all ${shapes.length} shape(s) carry the route color`
  )

  // (e) no inverted legs anywhere
  const invertedSwaps = rec.itinerarySwaps.filter((s) => s.inverted.length)
  const invertedBootstrap = (bootstrapShape ? bootstrapShape.legs : []).filter(
    (l) => l.endTime < l.startTime
  )
  check(
    'e. no leg arrives before it departs',
    invertedSwaps.length === 0 && invertedBootstrap.length === 0,
    invertedSwaps.length || invertedBootstrap.length
      ? `${invertedBootstrap.length} in the bootstrap, ` +
          `${invertedSwaps.length} swap(s) with inverted legs`
      : 'every leg ends after it starts'
  )

  // Informational: the ghost trip must never reach the confirmed match.
  const ghostMatches = rec.matchTripIds.filter((m) => m.tripId === GHOST_TRIP)
  console.log(
    `\n[info] confirmed match adopted the ghost trip ${GHOST_TRIP} ` +
      `${ghostMatches.length} time(s)` +
      (ghostMatches.length
        ? ` — ${ghostMatches.map((m) => fmt(m.t)).join(', ')}`
        : '')
  )

  console.log('\n===== RESULT =====')
  const failed = results.filter((r) => !r.pass)
  if (failed.length) {
    console.log(
      `FAIL: ${failed.length}/${results.length} assertions failed on the 8/2 replay`
    )
    process.exit(1)
  }
  console.log(
    `PASS: all ${results.length} assertions held for the 8/2 onboard replay`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
