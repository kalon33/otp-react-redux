/* eslint-disable no-console */
/**
 * Stuck-reroute recovery verification (7/13 ride failure): a reroute whose
 * plan fetch was killed by a WebView suspension used to pin reRoute.status at
 * 'searching' forever, silently blocking every missed-bus auto-update — the
 * rider got "Missed the bus — updating your trip" every 30 minutes while the
 * trip never changed.
 *
 * This script reproduces the EXACT zombie state, then proves recovery:
 *  1. plan a walk→bus trip, start Go Mode + GPS sim (verify-missed-bus harness)
 *  2. wedge a reroute: dispatch START_REROUTE with no fetch behind it
 *  3. time-travel past the departure — MISSED_BUS fires, but the swap is
 *     blocked by the wedged search (the 7/13 state, notification consumed)
 *  4. keep ticking: within ~90s wall clock the stuck-search watchdog clears
 *     it, and the dedup-decoupled retry applies the same-route next departure
 *     WITHOUT waiting 30 minutes for the notification to re-fire.
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

// Test-only (backlog 41.4): pin the bus the script picks by its short name,
// e.g. STUCK_ROUTE=18, so a measurement can land on a local bus at an hour
// when the earliest walk->bus option would be the Orange Line.
const ROUTE_PIN = process.env.STUCK_ROUTE || null
// Test-only companion: route ids the setup plan may not use (OTP's
// `banned.routes`, comma-separated GTFS ids, e.g. STUCK_BAN=1:904 to keep the
// Orange Line out so a local bus is offered at all).
const ROUTE_BAN = process.env.STUCK_BAN || null

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9778, lon: -93.2707, name: 'Downtown Minneapolis' }

const fmt = (ms) =>
  ms == null
    ? 'n/a'
    : new Date(ms).toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: 'America/Chicago'
      })

// Exit code for "the thing under test could not be exercised, and that is not a
// defect". nightly-verify.sh maps it to SKIP; anything else is still a failure.
// Same convention as verify-onboard-options.js.
const EXIT_SKIP = 75

function skip(reason) {
  console.log(`SKIP: ${reason}`)
  process.exit(EXIT_SKIP)
}

// ---- the trace (backlog 41.4) ----
// What the app did between the wedge and the end of the run, printed on PASS
// and FAIL alike, so a slow or missing recovery says WHICH path it took rather
// than only that a wait expired. Actions are read from redux-logger's
// `action` line (the dev server always installs it, lib/main.js) — recording-
// only types such as PLAN_RETARGET change no state, so a store subscriber can
// never see them. Plan swaps and notifications come from a store subscriber.
const TRACE_TYPES = [
  'PLAN_RETARGET',
  'HELD_RUN_VERDICT',
  'HELD_RUN_LATER_STOP',
  'START_REROUTE',
  'SET_REROUTE_RESULT',
  'CLEAR_REROUTE',
  'REPLAN_ORIGIN_WAIT',
  'AUTO_REPLAN',
  'START_GO_MODE'
]

function installTrace(types) {
  window.__srbTrace = []
  window.__srbOn = false
  const want = new Set(types)
  const boardOf = (it) => {
    const leg = (it?.legs || []).find((l) => l.transitLeg)
    if (!leg) return null
    return {
      route: leg.routeShortName || leg.routeLongName || null,
      routeId: leg.route?.gtfsId || leg.route?.id || leg.routeId || null,
      start: Number(leg.startTime),
      trip: leg.trip?.gtfsId || leg.tripId || null
    }
  }
  window.__srbBoardOf = boardOf
  const summarise = (a) => {
    const p = a.payload
    switch (a.type) {
      case 'PLAN_RETARGET':
      case 'HELD_RUN_VERDICT':
      case 'HELD_RUN_LATER_STOP':
      case 'REPLAN_ORIGIN_WAIT':
      case 'AUTO_REPLAN':
        try {
          return JSON.stringify(p).slice(0, 400)
        } catch {
          return '?'
        }
      case 'START_REROUTE':
        try {
          return JSON.stringify(p).slice(0, 300)
        } catch {
          return `searchId=${p?.searchId}`
        }
      case 'SET_REROUTE_RESULT': {
        if (p == null) return 'null'
        const list = Array.isArray(p) ? p : [p]
        const runs = list.map((it) => {
          const b = boardOf(it)
          return b
            ? `${b.route}[${b.routeId}]/${b.trip}@${new Date(b.start)
                .toTimeString()
                .slice(0, 8)}`
            : 'no-transit'
        })
        return `${Array.isArray(p) ? 'list' : 'single'}(${
          list.length
        }) ${runs.join(', ')}`
      }
      case 'START_GO_MODE': {
        const it = p?.itinerary || p
        return JSON.stringify(boardOf(it))
      }
      default:
        return ''
    }
  }
  const origLog = console.log
  console.log = function (...args) {
    const head = typeof args[0] === 'string' ? args[0] : ''
    if (head === '%c action    ' || head === 'action    ') {
      const a = head.startsWith('%c') ? args[2] : args[1]
      if (window.__srbOn && a && want.has(a.type)) {
        window.__srbTrace.push({
          detail: summarise(a),
          t: Date.now(),
          type: a.type
        })
      }
      return undefined
    }
    // Drop redux-logger's prev/next state dumps: every tick would otherwise
    // ship the whole store over the devtools protocol.
    if (/^%c (prev|next) state/.test(head)) return undefined
    return origLog.apply(this, args)
  }
}

// Store-side half of the trace: each activeItinerary swap (board run + its
// start), each new notification, and each reRoute.status change.
function installStoreWatch() {
  const boardOf = window.__srbBoardOf
  let lastItin = null
  let lastStatus = null
  let lastLive = null
  let lastLiveSig = null
  const seenNotes = new Set()
  window.store.subscribe(() => {
    if (!window.__srbOn) return
    const g = window.store.getState().otp.goMode
    if (g.activeItinerary !== lastItin) {
      lastItin = g.activeItinerary
      window.__srbTrace.push({
        detail: JSON.stringify({
          board: boardOf(g.activeItinerary),
          start: Number(g.activeItinerary?.startTime)
        }),
        t: Date.now(),
        type: 'itinerary'
      })
    }
    // The board leg's live time as the app holds it (what a miss is judged
    // against): one line per change, so a flip of boardRealtime/boardIsFloor
    // after the clock jump -- which turns a definitive miss ambiguous -- shows.
    if (g.liveLegTimes !== lastLive) {
      lastLive = g.liveLegTimes
      const idx = (g.activeItinerary?.legs || []).findIndex((l) => l.transitLeg)
      const lt = g.liveLegTimes?.[idx]
      const sig = JSON.stringify({
        epoch: lt?.boardEpoch ?? null,
        floor: !!lt?.boardIsFloor,
        rt: !!(lt?.boardRealtime ?? lt?.realtime)
      })
      if (sig !== lastLiveSig) {
        lastLiveSig = sig
        window.__srbTrace.push({
          detail: `${sig} (board leg ${idx})`,
          t: Date.now(),
          type: 'liveLegTimes'
        })
      }
    }
    const status = g.reRoute?.status
    if (status !== lastStatus) {
      lastStatus = status
      window.__srbTrace.push({ detail: status, t: Date.now(), type: 'reRoute' })
    }
    // Keyed, not counted: the list is capped and newest-first.
    for (const n of g.notifications?.recentNotifications || []) {
      const key = n.id || `${n.type}|${n.timestamp}|${n.message}`
      if (seenNotes.has(key)) continue
      seenNotes.add(key)
      window.__srbTrace.push({
        detail: String(n.message || '').slice(0, 120),
        t: Date.now(),
        type: `notify:${n.type}`
      })
    }
  })
}

let tracePage = null
let traceZeroMs = null
async function printTrace() {
  if (!tracePage) return
  let trace = []
  try {
    trace = await tracePage.evaluate(() => window.__srbTrace || [])
  } catch (e) {
    console.log(`[trace] unreadable: ${e.message}`)
    return
  }
  const zero = traceZeroMs ?? trace[0]?.t ?? 0
  console.log(
    `\n===== TRACE (${trace.length} entries, s relative to MISSED_BUS) =====`
  )
  for (const e of trace) {
    const rel = ((e.t - zero) / 1000).toFixed(1).padStart(7)
    console.log(`${rel}s  ${e.type.padEnd(22)} ${e.detail}`)
  }
}

async function main() {
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
    latitude: FROM.lat,
    longitude: FROM.lon
  })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.evaluateOnNewDocument(installTrace, TRACE_TYPES)
  tracePage = page
  await page.goto(APP, { timeout: 60000, waitUntil: 'networkidle2' })
  // 60s, not 30s: this is the FIRST wait in every script and it is a Vite dev
  // server transforming the module graph, not the product. Two runs on
  // 2026-09-17 died here -- 30s after a `docker restart otp-frontend-dev`, with
  // a cold transform cache -- and reported it as the script's failure. A red
  // row that means "the dev server was still warming up" is the kind that
  // taught everyone to stop reading this suite (backlog 13.6). If this wait is
  // what times out, the app at :9967 never booted: `docker restart
  // otp-frontend-dev` (a full `yarn jest` or `ship_web.sh` clobbers its
  // tmp/config.yml).
  await page.waitForFunction(() => !!window.store, { timeout: 60000 })
  await page.evaluate(installStoreWatch)

  // ---- plan a walk→bus trip through the app's own pipeline ----
  await page.evaluate(
    async (from, to, ban) => {
      // eslint-disable-next-line import/no-absolute-path
      const form = await import('/lib/actions/form.js')
      // eslint-disable-next-line import/no-absolute-path
      const api = await import('/lib/actions/api.js')
      window.store.dispatch(
        form.setQueryParam({
          departArrive: 'NOW',
          from,
          to,
          ...(ban ? { banned: { routes: ban } } : {})
        })
      )
      window.store.dispatch(api.routingQuery())
    },
    FROM,
    TO,
    ROUTE_BAN
  )
  // Five of the eleven red rows on the 2026-09-17 nightly were this one wait
  // expiring, reported as the bare line "waiting for function failed: timeout
  // 60000ms exceeded" (backlog 13.6). A plan that never comes back is the
  // backend, not this script: 17.8 measured the Linode behind
  // api.transit-nav.com going intermittently unresponsive under the
  // cap-10000 searches the app now sends, and the nightly's 05:00 CDT slot is
  // the same hour as the OTP log's `AStar Search timeout` bursts. So tell the
  // two apart rather than calling both a failure -- still PENDING after 60s
  // means nothing answered (SKIP); SETTLED with no itineraries is an answer
  // from the planner, and that is a real red row.
  const planned = await page
    .waitForFunction(
      () => {
        const searches = window.store.getState().otp.searches || {}
        return Object.values(searches).some(
          (s) =>
            s.pending === 0 &&
            (s.response || []).some((r) => r?.plan?.itineraries?.length > 0)
        )
      },
      { polling: 500, timeout: 60000 }
    )
    .then(() => true)
    .catch(() => false)
  if (!planned) {
    const searches = await page.evaluate(() =>
      Object.values(window.store.getState().otp.searches || {}).map((s) => ({
        itineraries: (s.response || []).flatMap(
          (r) => r?.plan?.itineraries || []
        ).length,
        pending: s.pending
      }))
    )
    const stillPending = searches.some((s) => s.pending !== 0)
    if (stillPending || searches.length === 0) {
      skip(
        'no plan came back within 60s and the search is still in flight ' +
          `(${JSON.stringify(searches)}) — the OTP behind ` +
          'api.transit-nav.com did not answer, so nothing was verified'
      )
    }
    throw new Error(
      'the planner settled with no itineraries for this pair: ' +
        JSON.stringify(searches)
    )
  }
  const chosen = await page.evaluate((routePin) => {
    const searches = window.store.getState().otp.searches || {}
    const itins = Object.values(searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
    const ok = itins.filter((it) => {
      const legs = it.legs || []
      const firstTransit = legs.findIndex((l) => l.transitLeg)
      return (
        firstTransit > 0 &&
        legs[0].mode === 'WALK' &&
        legs.slice(0, firstTransit).every((l) => !l.transitLeg) &&
        legs[0].distance > 80
      )
    })
    const routeOf = (it) => {
      const l = it.legs.find((x) => x.transitLeg)
      return l.routeShortName || l.routeLongName
    }
    const offered = ok.map(routeOf)
    const pool = routePin
      ? ok.filter((it) => String(routeOf(it)) === String(routePin))
      : ok
    if (!pool.length) return { offered, pinMissed: true }
    pool.sort((a, b) => a.startTime - b.startTime)
    window.__stuckTestItinerary = pool[0]
    const busLeg = pool[0].legs.find((l) => l.transitLeg)
    return {
      busRoute: busLeg.routeShortName || busLeg.routeLongName,
      busStart: Number(busLeg.startTime),
      busTrip: busLeg.trip?.gtfsId || busLeg.tripId || null,
      itinStart: Number(pool[0].startTime),
      offered
    }
  }, ROUTE_PIN)
  if (!chosen) throw new Error('no walk→bus itinerary with >80m access walk')
  if (chosen.pinMissed) {
    skip(
      `STUCK_ROUTE=${ROUTE_PIN} pinned, but the plan offered only ` +
        JSON.stringify(chosen.offered)
    )
  }
  console.log(
    `[setup] walk->bus options: ${JSON.stringify(chosen.offered)}` +
      (ROUTE_PIN ? ` (pinned ${ROUTE_PIN})` : '')
  )
  console.log(
    `[setup] bus ${chosen.busRoute} (${chosen.busTrip}) boards ${fmt(
      chosen.busStart
    )}, trip departs ${fmt(chosen.itinStart)}`
  )

  // The trace starts here, before Go Mode, so the first plan is its first line.
  await page.evaluate(() => {
    window.__srbOn = true
  })

  // ---- start Go Mode + sim ----
  await page.evaluate(() => window.__beginGoMode(window.__stuckTestItinerary))
  await page.waitForFunction(
    () =>
      window.store.getState().otp.goMode.isActive &&
      typeof window.__startGpsSimulation === 'function',
    { polling: 300, timeout: 20000 }
  )
  await page.evaluate(() => window.__startGpsSimulation(1))
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.progress != null,
    { polling: 300, timeout: 20000 }
  )

  // ---- wedge a reroute exactly like a suspension-killed fetch ----
  await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const goModeActions = await import('/lib/actions/go-mode.ts')
    window.store.dispatch(
      goModeActions.startReroute({
        searchId: 'wedged-by-suspension',
        startedAtMs: Date.now()
      })
    )
  })
  const wedged = await page.evaluate(
    () => window.store.getState().otp.goMode.reRoute.status
  )
  if (wedged !== 'searching') throw new Error('failed to wedge the reroute')
  console.log('[wedge] reRoute stuck at "searching" with no fetch behind it')

  // ---- time-travel past the departure: the 7/13 zombie state ----
  const simTime = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    return g.progress?.currentTime
      ? new Date(g.progress.currentTime).getTime()
      : null
  })
  // Wait past the bus's LIVE departure, not its scheduled one (rider, 41.4 Q3=A).
  // The app judges a miss against getEffectiveBoardTimeMs: the feed's
  // goMode.liveLegTimes[boardLeg].boardEpoch when boardRealtime, else the
  // scheduled leg.startTime. A late bus has boardEpoch > startTime, so a jump
  // to scheduled+5min lands BEFORE live+grace and the miss is ambiguous
  // (autoApply false, never applied). Jump past whichever is later.
  const live = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    const legs = g.activeItinerary?.legs || []
    const idx = legs.findIndex((l) => l.transitLeg)
    const lt = g.liveLegTimes?.[idx]
    return {
      boardEpoch: lt?.boardEpoch ?? null,
      boardIsFloor: !!lt?.boardIsFloor,
      boardRealtime: !!(lt?.boardRealtime ?? lt?.realtime)
    }
  })
  const liveBoardMs =
    live.boardRealtime && live.boardEpoch != null && !live.boardIsFloor
      ? Number(live.boardEpoch)
      : null
  const targetBoardMs = Math.max(chosen.busStart, liveBoardMs ?? 0)
  console.log(
    `[live] feed boardRealtime=${live.boardRealtime} boardEpoch=${fmt(
      live.boardEpoch
    )} scheduled=${fmt(chosen.busStart)} -> ` +
      (liveBoardMs != null && liveBoardMs > chosen.busStart
        ? `bus is ${((liveBoardMs - chosen.busStart) / 60000).toFixed(
            1
          )} min LATE, jumping past ${fmt(liveBoardMs)}`
        : 'on time (or no live time), jumping past the scheduled time')
  )
  const advanceMs = targetBoardMs - (simTime || chosen.itinStart) + 300000
  await page.evaluate((ms) => {
    window.__advanceSimulatedTime(ms)
    window.__pingPosition()
  }, advanceMs)
  console.log(
    `[time-travel] sim clock ${(advanceMs / 60000).toFixed(
      1
    )} min past boarding`
  )

  // MISSED_BUS must fire...
  await page.waitForFunction(
    () =>
      window.store
        .getState()
        .otp.goMode.notifications.recentNotifications.some(
          (n) => n.type === 'MISSED_BUS'
        ),
    { polling: 300, timeout: 15000 }
  )
  // ...but the swap is blocked by the wedged search (pre-fix this was forever).
  const blocked = await page.evaluate((origStart) => {
    const g = window.store.getState().otp.goMode
    return {
      sameTrip: Number(g.activeItinerary.startTime) === origStart,
      status: g.reRoute.status
    }
  }, chosen.itinStart)
  traceZeroMs = await page.evaluate(() => {
    const e = (window.__srbTrace || []).find(
      (x) => x.type === 'notify:MISSED_BUS'
    )
    return e ? e.t : Date.now()
  })
  console.log(
    `[zombie] MISSED_BUS fired; reRoute=${blocked.status}; trip unchanged=${blocked.sameTrip}`
  )

  // ---- recovery: watchdog (90s) clears the wedge, retry applies the swap ----
  // Two settled outcomes are a pass: the same-route swap (TRIP_UPDATED), or --
  // when the replan holds no run of the kept route, i.e. a local bus where OTP
  // answers Orange/bike -- a `found` choices card the app deliberately does not
  // apply (rider, 41.4 Q2=B: "showing the choices is enough"). A wedge is still
  // a failure: no result, a `searching` that outlives the watchdog, or a
  // null/empty result (`none`) that is never retried all run out the deadline.
  const t0 = Date.now()
  const tick = setInterval(
    () => page.evaluate(() => window.__pingPosition()).catch(() => undefined),
    5000
  )
  const readSettled = (origStart, keptRoute) => {
    const g = window.store.getState().otp.goMode
    const swapped =
      g.activeItinerary &&
      Number(g.activeItinerary.startTime) !== origStart &&
      g.notifications.recentNotifications.some((n) => n.type === 'TRIP_UPDATED')
    const cands = g.reRoute.candidates || []
    const routeOf = (it) => {
      const l = (it.legs || []).find((x) => x.transitLeg)
      return l ? String(l.routeShortName || l.routeLongName) : null
    }
    return {
      choices:
        !swapped &&
        g.reRoute.status === 'found' &&
        !g.reRoute.autoApply &&
        cands.length > 0 &&
        Number(g.activeItinerary.startTime) === origStart,
      keptInList: cands.some((it) => routeOf(it) === String(keptRoute)),
      offered: cands.map(routeOf),
      status: g.reRoute.status,
      swapped: !!swapped
    }
  }
  let outcome = null
  let choicesInfo = null
  let choicesSince = 0
  try {
    const deadline = Date.now() + 240000
    while (Date.now() < deadline) {
      const r = await page.evaluate(
        readSettled,
        chosen.itinStart,
        chosen.busRoute
      )
      if (r.swapped) {
        outcome = 'swap'
        break
      }
      if (r.choices && !r.keptInList) {
        // Hold it 8s: a card that is still being replaced is not settled.
        choicesSince = choicesSince || Date.now()
        choicesInfo = r
        if (Date.now() - choicesSince >= 8000) {
          outcome = 'choices'
          break
        }
      } else {
        choicesSince = 0
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  } finally {
    clearInterval(tick)
  }
  if (!outcome) {
    const r = await page
      .evaluate(readSettled, chosen.itinStart, chosen.busRoute)
      .catch(() => ({}))
    throw new Error(
      `no recovery within 240s (wedge not cleared, or empty/null result never retried): ${JSON.stringify(
        r
      )}`
    )
  }
  const recoverySec = ((Date.now() - t0) / 1000).toFixed(0)

  const after = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    const busLeg = (g.activeItinerary.legs || []).find((l) => l.transitLeg)
    return {
      confirmMsg: g.notifications.recentNotifications.find(
        (n) => n.type === 'TRIP_UPDATED'
      )?.message,
      newBusRoute: busLeg?.routeShortName || busLeg?.routeLongName || 'walk',
      reRouteStatus: g.reRoute.status
    }
  })
  await printTrace()
  console.log('\n===== RESULT =====')
  console.log(`outcome:       ${outcome}`)
  console.log(`recovered in:  ${recoverySec}s wall clock (watchdog is 90s)`)
  if (outcome === 'choices') {
    console.log(
      `choices card:  status=${after.reRouteStatus}, offered ${JSON.stringify(
        choicesInfo.offered
      )}, kept route ${chosen.busRoute} not among them`
    )
  } else {
    console.log(`confirmation:  ${after.confirmMsg}`)
    console.log(`reRoute state: ${after.reRouteStatus} (expected idle)`)
  }

  await browser.close()

  if (Number(recoverySec) > 200) {
    throw new Error('recovery took longer than watchdog + retry should allow')
  }
  if (outcome === 'choices') {
    console.log(
      `\nPASS (choices shown — kept route not in replan, rider-confirmed behaviour 41.4 Q2=B): wedge cleared by watchdog, missed ${
        chosen.busRoute
      } replanned to ${JSON.stringify(
        choicesInfo.offered
      )} and shown as choices, not applied`
    )
    return
  }
  if (after.reRouteStatus !== 'idle') {
    throw new Error('reRoute state not reset after recovery')
  }
  if (after.newBusRoute !== chosen.busRoute) {
    throw new Error(
      `recovery changed the route: ${chosen.busRoute} -> ${after.newBusRoute}`
    )
  }
  console.log(
    '\nPASS: wedged reroute cleared by watchdog, trip auto-updated on the SAME route without waiting for the 30-min notification re-fire'
  )
}

main().catch(async (e) => {
  await printTrace()
  // e.stack, not e.message: a puppeteer waitForFunction timeout says only
  // "waiting for function failed: timeout 60000ms exceeded" and names neither
  // the wait that failed nor its line. Six of the eleven red rows on
  // 2026-09-17 were that one line and nothing else, which is much of why this
  // suite's output stopped being read (backlog 13.6). The stack names the wait.
  console.error('FAIL:', e.stack || e.message)
  process.exit(1)
})
