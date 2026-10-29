/* eslint-disable no-console */
/**
 * Scenario definitions for the responsiveness harness. Each scenario is
 * `{ kind, livePlan, run(ctx) }`:
 *
 *   kind      'search' | 'gomode' — selects the extra summary section
 *   livePlan  true when the scenario sends plan queries to the OTP the app is
 *             configured for (on :9967 that is PRODUCTION). run.js serialises
 *             those behind the prod-idle wait; replays never hit OTP (the
 *             replay engine serves every GraphQL read from the fixture, see
 *             lib/util/go-mode/replay/replay-engine.ts resolveReplayQuery).
 *   run(ctx)  drives the page; ctx is built in run.js (page, tap, pan, sleep,
 *             note, startMeasuring, ...). It must leave the page idle: no
 *             replay running, no query in flight.
 *
 * Selectors are the app's own, read from lib/components (not guessed):
 *   results row        div.option.metro-itin      (narrative/metro)
 *   back to list       button "View all options"   (mobile results header)
 *   other stops        button.same-shape-variants-toggle (metro/same-shape-variants.tsx)
 *   frequency line     .leg-frequency              (line-itin/leg-frequency-footer.tsx)
 *   ride expander      button "Ride {duration} · # stops" with aria-expanded
 *                      (line-itin/transit-leg-summary.tsx; the overhaul retired
 *                      its "(Expand details)" text). Alert and walk expanders
 *                      still end "(Expand details)" (itinerary-body package).
 *   trip sheet         [aria-label="Open trip overview"] / dialog Close (GoModeScreen, TripSheet)
 *   follow toggle      button.go-mode-follow-toggle (GoModeMap)
 *   app menu           button.app-menu-icon; "Share feedback" link (app/app-menu.tsx)
 *   faster-route card  .faster-route-offer — "Switch" / "Keep mine" (FasterRouteCard.tsx)
 *   back to trip       ReturnToTripBanner: button.return-to-trip-banner
 */

const FIXTURE_URL = (name) => `/lib/util/go-mode/replay/fixtures/${name}.json`

// ---- dates: plan for a weekday at the recorded time of day ----
function planDate(hhmm) {
  if (process.env.PERF_DATE) return process.env.PERF_DATE
  const d = new Date()
  const [h, m] = hhmm.split(':').map(Number)
  const target = new Date(d)
  target.setHours(h, m, 0, 0)
  // Today if the time is still >= 10 min ahead, else the next weekday.
  if (target.getTime() - d.getTime() < 10 * 60 * 1000) {
    do {
      target.setDate(target.getDate() + 1)
    } while (target.getDay() === 0 || target.getDay() === 6)
  }
  const p = (n) => String(n).padStart(2, '0')
  return `${target.getFullYear()}-${p(target.getMonth() + 1)}-${p(
    target.getDate()
  )}`
}

// ---- searches (from ~/otp-debug-logs/debug-2026-10-20.jsonl) ----
// 66.1: session mvgplnrw-yvtqga, search yqhoteoy6 at 08:53 — from the rider's
// position, one added stop (3322 Columbus Ave, stay 5 min), to Oakdale.
const MULTISTOP = {
  fromPlace: 'Origin::44.942713363210125,-93.2638753427805',
  intermediatePlaces:
    '3322 Columbus Avenue, Minneapolis, Central, MN::44.94245,-93.26422',
  mode: 'WALK,TRANSIT',
  stopStays: '5',
  time: '08:53',
  toPlace: '3510 Hopkins Place, Oakdale, MN::45.00028,-92.949399'
}
// An ordinary 1-destination search from the same day file (147 records).
const ONE_DEST = {
  fromPlace: '6th St & Jackson Station::44.948784,-93.090581',
  mode: 'WALK,TRANSIT',
  time: '16:31',
  toPlace: '2345 Old Shakopee Road West, Bloomington, MN::44.816546,-93.30986'
}

function searchUrl(appUrl, params) {
  const q = new URLSearchParams({
    arriveBy: 'false',
    date: planDate(params.time),
    ...params
  })
  return `${appUrl.replace(/\/?$/, '/')}#/?${q.toString()}`
}

/** Poll until the active search has fully landed and gone quiet. */
async function waitForSearchSettled(
  ctx,
  {
    maxMs = Number(process.env.SEARCH_SETTLE_MAX_S || 900) * 1000,
    quietMs = 6000
  }
) {
  const started = Date.now()
  let last = ''
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const s = await ctx.page.evaluate(() => {
      const st = window.store && window.store.getState().otp
      const s = st && st.searches && st.searches[st.activeSearchId]
      const resultTypes = new Set([
        'ROUTING_RESPONSE',
        'ROUTE_ROW_TIMETABLE',
        'ITINERARY_VARIANT_ROWS',
        'ROUTING_ERROR'
      ])
      let lastT = 0
      const acts = window.__perf.actions
      for (let i = acts.length - 1; i >= 0; i--) {
        if (resultTypes.has(acts[i].type)) {
          lastT = acts[i].t
          break
        }
      }
      const domRows = document.querySelectorAll('div.option.metro-itin').length
      if (!s) return { domRows, idle: performance.now() - lastT, none: true }
      const tt = Object.values(s.routeRowTimetable || {}).map((e) => e.status)
      return {
        domRows,
        idle: performance.now() - lastT,
        itineraries: (s.response || []).reduce(
          (n, r) => n + ((r && r.plan && r.plan.itineraries.length) || 0),
          0
        ),
        pending: s.pending,
        responses: (s.response || []).length,
        ttDone: tt.filter((x) => x !== 'pending').length,
        ttPending: tt.filter((x) => x === 'pending').length
      }
    })
    const line = `pending=${s.pending} responses=${s.responses} itins=${
      s.itineraries
    } timetables=${s.ttDone}/${s.ttDone + s.ttPending}`
    if (line !== last) {
      console.log(
        `  [search +${((Date.now() - started) / 1000).toFixed(0)}s] ${line}`
      )
      last = line
    }
    if (!s.none && s.pending === 0 && s.ttPending === 0 && s.idle > quietMs) {
      return s
    }
    if (Date.now() - started > maxMs) {
      ctx.note(`search did not settle within ${maxMs / 1000}s (${line})`)
      return s
    }
    // eslint-disable-next-line no-await-in-loop
    await ctx.sleep(1000)
  }
}

/**
 * Cold-load the search URL: the app plans from the URL exactly as it does
 * when the rider's phone restores a search. The app's own boot is therefore
 * inside the measurement; its long tasks carry no preceding action (or
 * @@INIT/@@router) in the top-task attribution. (Booting at the root and then
 * setting the hash does not start a plan — tried, 2026-10-20.)
 */
async function openSearch(ctx, params) {
  await ctx.openApp(searchUrl(ctx.appUrl, params))
}

/** A point inside a results row that is not on one of its buttons. */
async function rowTapPoint(handle) {
  return handle.evaluate((el) => {
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    for (const dy of [18, 30, 45, 60, 80]) {
      for (const fx of [0.75, 0.5, 0.9]) {
        const x = r.left + r.width * fx
        const y = r.top + dy
        const hit = document.elementFromPoint(x, y)
        if (hit && el.contains(hit) && !hit.closest('button,a')) return { x, y }
      }
    }
    return null
  })
}

async function tapResultRows(ctx, count, prefix) {
  const picks = [0, 1, 2, 4, 6, 8, 10]
  let tapped = 0
  for (const idx of picks) {
    if (tapped >= count) break
    // eslint-disable-next-line no-await-in-loop
    const rows = await ctx.page.$$('div.option.metro-itin')
    if (idx >= rows.length) continue
    // eslint-disable-next-line no-await-in-loop
    const pt = await rowTapPoint(rows[idx])
    if (!pt) {
      ctx.note(`${prefix} row ${idx}: no button-free point to tap`)
      continue
    }
    // eslint-disable-next-line no-await-in-loop
    await ctx.sleep(300)
    // eslint-disable-next-line no-await-in-loop
    await ctx.tapAt(`${prefix}-row-${idx}`, pt.x, pt.y)
    // eslint-disable-next-line no-await-in-loop
    await ctx.sleep(1500)
    // eslint-disable-next-line no-await-in-loop
    const back = await ctx.findButton(/^View all options$/)
    if (!back) {
      ctx.note(`${prefix} row ${idx}: no "View all options" after the tap`)
      continue
    }
    // eslint-disable-next-line no-await-in-loop
    await ctx.tap(`${prefix}-back-${idx}`, back)
    // eslint-disable-next-line no-await-in-loop
    await ctx.sleep(1500)
    tapped++
  }
  return tapped
}

function searchScenario(params, { rows = 5 } = {}) {
  return {
    kind: 'search',
    livePlan: true,
    async run(ctx) {
      await openSearch(ctx, params)
      const settled = await waitForSearchSettled(ctx, {})
      ctx.info.settled = settled
      await tapResultRows(ctx, rows, 'results')
    }
  }
}

// ---- details: the first itinerary's own controls ----
const details = {
  continues: 'search-1dest',
  kind: 'search',
  livePlan: true,
  async run(ctx) {
    if (!ctx.continued) {
      await openSearch(ctx, ONE_DEST)
      await waitForSearchSettled(ctx, {})
    }
    ctx.startMeasuring()
    const rows = await ctx.page.$$('div.option.metro-itin')
    if (!rows.length) {
      ctx.note('details: no result rows')
      return
    }
    const pt = await rowTapPoint(rows[0])
    await ctx.tapAt('details-open-row-0', pt.x, pt.y)
    await ctx.sleep(2000)
    // "Other stops" sends one plan query PER candidate stop, all at once
    // (12 concurrent at production OTP on 2026-10-20). That breaks the
    // one-query-at-a-time rule, so it is opt-in.
    const fanout = process.env.PERF_ALLOW_FANOUT === '1'
    if (!fanout) {
      ctx.note(
        'details-other-stops skipped: it fans out ~12 concurrent plan queries (PERF_ALLOW_FANOUT=1 to include)'
      )
    }
    // 75.35 (P8a): the ride expander is found by its aria-expanded state, not
    // by the retired "(Expand details)" / "(Collapse|Hide) details" text.
    const RIDE = /^Ride\b/
    const steps = [
      ...(fanout
        ? [
            ['details-other-stops', 'button.same-shape-variants-toggle'],
            ['details-other-stops-close', 'button.same-shape-variants-toggle']
          ]
        : []),
      ['details-frequency-line', '.leg-frequency'],
      ['details-ride-expander', RIDE, false],
      ['details-alert-expander', /alerts?\(Expand details\)$/],
      ['details-walk-expander', /^\d+ min\(Expand details\)$/],
      ['details-stop-list-collapse', RIDE, true]
    ]
    for (const [label, sel, expanded] of steps) {
      // eslint-disable-next-line no-await-in-loop
      const h =
        typeof sel === 'string'
          ? await ctx.page.$(sel)
          : await ctx.findButton(sel, null, expanded)
      if (!h) {
        // 75.35 P8a hid a harness/app selector mismatch behind this note; a
        // missing ride expander or collapse is that, unless the itinerary has
        // no transit leg.
        ctx.note(
          `${label}: not present on this itinerary${
            expanded != null ? ' (aria-expanded=' + expanded + ')' : ''
          }`
        )
        continue
      }
      // eslint-disable-next-line no-await-in-loop
      await ctx.tap(label, h)
      // eslint-disable-next-line no-await-in-loop
      await ctx.sleep(1500)
    }
    const back = await ctx.findButton(/^View all options$/)
    if (back) await ctx.tap('details-back', back)
    else ctx.note('details: no "View all options" button')
    await ctx.sleep(1500)
  }
}

// ---- Go Mode replays ----

/** The rotating "something real" taps made every ~3 s during a replay. */
const ROTATION = [
  async (ctx) => {
    const h = await ctx.page.$('[aria-label="Open trip overview"]')
    return h ? ctx.tap('sheet-open', h) : 'sheet-open'
  },
  async (ctx) => {
    const h = await ctx.page.$('[role="dialog"] button[aria-label="Close"]')
    return h ? ctx.tap('sheet-close', h) : 'sheet-close'
  },
  async (ctx) => ctx.panMap('map-pan'),
  async (ctx) => {
    const h = await ctx.page.$('button.go-mode-follow-toggle')
    return h ? ctx.tap('follow-toggle', h) : 'follow-toggle'
  },
  async (ctx) => {
    const h = await ctx.page.$('button.app-menu-icon')
    return h ? ctx.tap('menu-open', h) : 'menu-open'
  },
  async (ctx) => {
    // Close the menu again with the same icon (now "Close Menu").
    const h = await ctx.page.$('button.app-menu-icon[aria-label="Close Menu"]')
    return h ? ctx.tap('menu-close', h) : 'menu-close'
  }
]

async function startReplay(ctx, fixture, speed) {
  await ctx.openApp(ctx.appUrl)
  await ctx.page.waitForFunction(
    () => typeof window.__replayTrip === 'function',
    { timeout: 60000 }
  )
  const meta = await ctx.page.evaluate(async (url) => {
    const fx = await window.__loadFixture(url)
    window.__perfFixture = fx
    return {
      endMs: fx.meta.endMs,
      fixes: fx.gpsTrack.length,
      label: fx.meta.label,
      startMs: fx.meta.startMs
    }
  }, FIXTURE_URL(fixture))
  ctx.info.fixture = { name: fixture, speed, ...meta }
  ctx.startMeasuring()
  await ctx.page.evaluate((s) => {
    window.__perf.mark('replay-start')
    window.__replayTrip(window.__perfFixture, { speedMultiplier: s })
  }, speed)
  await ctx.page
    .waitForFunction(
      () => window.store.getState().otp.goMode.simulation.status === 'running',
      { polling: 200, timeout: 30000 }
    )
    .catch(() => ctx.note('replay never reached status running'))
}

/** One sample of the replay's own progress + the Go Mode facts we care about. */
const sampleGoMode = (ctx) =>
  ctx.page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    return {
      arrived: g.arrivedAt != null,
      fasterRoute: g.fasterRoute ? g.fasterRoute.kind || 'offer' : null,
      isActive: g.isActive,
      legIndex: g.progress ? g.progress.currentLegIndex : null,
      onboardAlightOptions: ((g.onboard && g.onboard.alightOptions) || [])
        .length,
      onboardCandidates: ((g.onboard && g.onboard.candidates) || []).length,
      pointIndex: g.simulation.pointIndex,
      reRoute: g.reRoute ? g.reRoute.status : null,
      simTime:
        g.progress && g.progress.currentTime
          ? new Date(g.progress.currentTime).getTime()
          : null,
      status: g.simulation.status,
      t: performance.now(),
      totalPoints: g.simulation.totalPoints
    }
  })

async function driveReplay(ctx, { onSample, tapEveryMs = 3000 } = {}) {
  const maxMs = Number(process.env.GOMODE_MAX_WALL_S || 900) * 1000
  const started = Date.now()
  let nextTap = Date.now() + tapEveryMs
  let rot = 0
  let lastLog = 0
  const samples = []
  let s = null
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    s = await sampleGoMode(ctx)
    samples.push(s)
    if (s.status !== 'running') break
    // A replay whose track stops advancing is a stalled REPLAY (or a reloaded
    // page), not a slow tick: record it and stop rather than burn the cap.
    const back = samples[samples.length - 61]
    if (back && back.pointIndex === s.pointIndex) {
      ctx.note(`replay stalled at ${s.pointIndex}/${s.totalPoints} for 60 s`)
      break
    }
    if (Date.now() - lastLog > 20000) {
      console.log(
        `  [replay +${((Date.now() - started) / 1000).toFixed(0)}s] ${
          s.pointIndex
        }/${s.totalPoints} leg ${s.legIndex} reRoute=${s.reRoute} faster=${
          s.fasterRoute
        }`
      )
      lastLog = Date.now()
    }
    if (Date.now() - started > maxMs) {
      ctx.note(`replay capped at ${maxMs / 1000}s wall`)
      break
    }
    // eslint-disable-next-line no-await-in-loop
    if (onSample) await onSample(s)
    if (Date.now() >= nextTap) {
      // eslint-disable-next-line no-await-in-loop
      const r = await ROTATION[rot % ROTATION.length](ctx)
      if (typeof r === 'string') ctx.note(`rotation ${r}: target absent`)
      rot++
      nextTap = Date.now() + tapEveryMs
    }
    // eslint-disable-next-line no-await-in-loop
    await ctx.sleep(1000)
  }
  // The simulation slice resets pointIndex/totalPoints when the track ends,
  // so read progress from the last RUNNING sample and from the
  // UPDATE_SIMULATION_PROGRESS actions the collector saw.
  const lastRunning = samples.filter((x) => x.status === 'running').pop() || s
  const maxPoint = await ctx.page.evaluate(() =>
    window.__perf.actions.reduce(
      (m, a) =>
        a.type === 'UPDATE_SIMULATION_PROGRESS' ? Math.max(m, a.pointIndex) : m,
      0
    )
  )
  const endedByItself = s.status !== 'running'
  const finished = endedByItself && maxPoint >= lastRunning.totalPoints
  ctx.info.replay = {
    finalStatus: finished
      ? 'finished'
      : endedByItself
      ? `stopped-early(${s.status})`
      : 'capped',
    pointIndex: maxPoint,
    samples: samples.map((x) => ({ ...x, t: Math.round(x.t) })),
    totalPoints: lastRunning.totalPoints,
    wallSeconds: Math.round((Date.now() - started) / 1000)
  }
  // Measurement ends here: the teardown below (__stopReplay -> endGoMode) is
  // the harness's, not the app's, and must not land in the numbers.
  await ctx.page.evaluate(() => {
    window.__perf.endCut = performance.now()
  })
  // Leave the page idle: stop the replay (also ends Go Mode, disarms replay).
  await ctx.page.evaluate(() => window.__stopReplay && window.__stopReplay())
  await ctx.sleep(500)
}

function goModeScenario(fixture, { speed = 10 } = {}) {
  return {
    fixture,
    kind: 'gomode',
    livePlan: false,
    async run(ctx) {
      await startReplay(ctx, fixture, speed)
      await driveReplay(ctx)
    }
  }
}

// ---- reroute: tap the faster-route offer when it appears ----
// 75.35 (P8g): NO replay can produce the offer today. The replay start path
// never arms the aboard route check (`aboardRouteCheck`, findings-replay R2:
// 0 FASTER_ROUTE_OFFER / 0 ABOARD_CHECK_VERDICT in every fixture checked), and
// a rider swap (itinerarySwaps) is not replayed. So this is, in effect, two
// more plain replays; its `offer-switch` / `offer-keep` taps are exercised
// only if a future fixture or engine change makes the offer appear. The
// summary says so (ctx.info.noOfferPossible) instead of reading as a reroute
// test.
function rerouteScenario(fixtures, { speed = 10 } = {}) {
  return {
    fixture: fixtures[0],
    kind: 'gomode',
    livePlan: false,
    async run(ctx) {
      const tried = []
      for (const fixture of fixtures) {
        tried.push(fixture)
        // eslint-disable-next-line no-await-in-loop
        await startReplay(ctx, fixture, speed)
        let offers = 0
        // eslint-disable-next-line no-await-in-loop
        await driveReplay(ctx, {
          onSample: async (s) => {
            if (!s.fasterRoute) return
            const btn = await ctx.findButton(
              offers === 0 ? /^Switch$/ : /^Keep mine$/,
              '.faster-route-offer'
            )
            if (!btn) return
            await ctx.tap(offers === 0 ? 'offer-switch' : 'offer-keep', btn)
            offers++
          }
        })
        ctx.info.offersTapped = offers
        ctx.info.fixturesTried = tried
        ctx.info.noOfferPossible = offers === 0
        if (offers > 0) return
        // The next fixture's openApp loads a fresh document, so this one's
        // measurements are discarded with it; the note is what survives.
        ctx.note(
          `${fixture}: no faster-route offer appeared during the replay (none is reachable: the replay start path never arms the aboard route check, findings-replay R2)`
        )
      }
    }
  }
}

// ---- back-feedback: background the trip, then return to it ----
// 75.35 (P9): the old step 2 tapped button[aria-label="Back"], the Go Mode
// card's CardBackButton (TransitProgress.tsx, onClick=onExit) -> handleExit
// (GoModeScreen.tsx) -> window.confirm "stop tracking?". That control ENDS the
// trip, not backgrounds it: unanswered it froze every CDP call (66.12), and
// dismissed the next step found no return banner. The real ways out of a
// running trip are the app menu's links (app-menu.tsx _handleNavigate calls
// backgroundGoMode) and the way back is the ReturnToTripBanner. Both cycles
// below use only those. run.js answers any dialog (dismiss) and logs it; this
// scenario then asserts the trip is still active and no dialog fired.
const backFeedback = {
  fixture: 'gold-74-1105',
  kind: 'gomode',
  livePlan: false,
  async run(ctx) {
    await startReplay(ctx, 'gold-74-1105', 4)
    await ctx.sleep(4000)
    // Each step is bounded: a page that stops yielding would otherwise hang
    // puppeteer's element calls (page.$, boundingBox) with no timeout.
    const step = async (label, find) => {
      console.log(`  [step] ${label}`)
      const run = async () => {
        const h = await find()
        if (!h) {
          ctx.note(`${label}: target absent`)
          return false
        }
        await ctx.tap(label, h)
        await ctx.sleep(2500)
        return true
      }
      let timer
      const limit = new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: page unresponsive for 120 s`)),
          120000
        )
      })
      try {
        return await Promise.race([run(), limit])
      } finally {
        clearTimeout(timer)
      }
    }
    // The banner's copy changed in the overhaul ("On trip · Next stop ..."),
    // so find it by its class, not by "tap to return" text.
    const banner = () => ctx.page.$('button.return-to-trip-banner')
    const goModeActive = () =>
      ctx.page.evaluate(() => window.store.getState().otp.goMode.isActive)
    // 1. app menu -> Share feedback (backgrounds the trip) -> the banner back.
    await step('menu-open', () => ctx.page.$('button.app-menu-icon'))
    await step('menu-share-feedback', () => ctx.findLink(/^Share feedback$/))
    // The feedback screen (user/feedback-screen.tsx) sits in AppFrame, which
    // has NO back control — only the nav's app menu — and shows the banner.
    await step('return-to-trip-banner-from-feedback', banner)
    // 2. app menu -> Plan Trip (backgrounds the trip) -> the banner back.
    await step('planner-menu-open', () => ctx.page.$('button.app-menu-icon'))
    await step('planner-menu-plan-trip', () =>
      ctx.page.$('a.app-menu-trip-planner-link')
    )
    await step('return-to-trip-banner', banner)
    if (!(await goModeActive())) {
      ctx.note(
        'the trip ended during the scenario: Go Mode is no longer active'
      )
    }
    ctx.info.backgroundedActions = await ctx.page.evaluate(
      () =>
        window.__perf.actions.filter((a) =>
          /SET_GO_MODE_BACKGROUNDED|ROUTING_REQUEST|@@router\/LOCATION_CHANGE/.test(
            a.type
          )
        ).length
    )
    await driveReplay(ctx, { tapEveryMs: 1e9 })
  }
}

const SCENARIOS = {
  'back-feedback': backFeedback,
  details,
  'gomode-465-wrongdir-0921': goModeScenario('0921-1605-465-wrongdir'),
  'gomode-gold-74-1105': goModeScenario('gold-74-1105'),
  // A 1.7-minute ride: 4x gives it ~25 s of wall time and a handful of taps.
  'gomode-green-onboard-1135': goModeScenario('green-line-onboard-1135', {
    speed: 4
  }),
  'gomode-orange-bike-1008': goModeScenario('1008-0916-orange-bike'),
  // 75.35 (P8e): was `multistop-28`. The row count is the OTP's, not the
  // scenario's (15 itineraries on the desktop OTP, 31 on production on
  // 2026-10-20); the settled count is recorded in the summary instead.
  multistop: searchScenario(MULTISTOP),
  reroute: rerouteScenario([
    '0921-1646-orange-missedbus',
    'ride-1019-0844-aboard-offer'
  ]),
  'search-1dest': searchScenario(ONE_DEST)
}

// Run order when SCENARIOS is not given: details continues search-1dest's page.
const ORDER = [
  'multistop',
  'search-1dest',
  'details',
  'gomode-orange-bike-1008',
  'gomode-gold-74-1105',
  'gomode-465-wrongdir-0921',
  'gomode-green-onboard-1135',
  'reroute',
  'back-feedback'
]

// Old names still accepted on the command line (SCENARIOS=multistop-28).
const ALIASES = { 'multistop-28': 'multistop' }

module.exports = {
  ALIASES,
  MULTISTOP,
  ONE_DEST,
  ORDER,
  planDate,
  SCENARIOS,
  searchUrl
}
