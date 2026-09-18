/* eslint-disable no-console */
/**
 * Live end-to-end verification of the on-bus ranked-options fix (item 3).
 *
 * Drives the real app at :9967 (Vite dev, live OTP behind api.transit-nav.com:9966):
 *  1. finds a live Orange Line vehicle via the real OTP GraphQL API
 *  2. seeds sticky `riding` state for that trip + a destination (the exact
 *     post-fix-1 mid-ride situation) and geolocation at the bus position
 *  3. dispatches the REAL beginOnboardFlow thunk (imported via Vite module URL)
 *  4. waits for onboard.status === 'ready', asserts alightOptions is a ranked
 *     list (arrival ascending, >1 option), screenshots the UI
 *  5. clicks the SECOND option's Go button, asserts guidance starts with THAT
 *     stop as the bus leg's alight point, screenshots the result
 */
const path = require('path')

const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const API =
  process.env.OTP_API || 'https://api.transit-nav.com:9966/otp/gtfs/v1'
const OUT = process.env.OUT_DIR || __dirname
// Vite dev output is untranspiled; puppeteer's bundled Chromium is too old for
// it -- default to the system Chrome.
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

// Orange Line first, then busy local fallbacks.
const PROBE_ROUTES = ['1:904', '1:5', '1:18', '1:10', '1:2']

async function gql(query) {
  const res = await fetch(API, {
    body: JSON.stringify({ query }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  })
  return res.json()
}

// Exit code for "the thing under test could not be exercised, and that is not a
// defect". nightly-verify.sh maps it to SKIP; anything else is still a failure.
const EXIT_SKIP = 75

// The picked bus must have a RIDE left in it. This script's whole subject is
// "where do you want to get off this bus", and the answers ARE downstream
// stops: with one stop to go there is nothing to rank. On 2026-09-17 the picker
// took the first Orange Line vehicle carrying a known next stop, that vehicle
// was at stop 11 of 12, and `beginOnboardFlow` settled `status: 'error'` with
// zero options — a red row, four runs running, for a bus that was simply almost
// home. verify-rest-of-trip-times.js already screens for this ("in progress
// with >=5 min of ride left"); this is the same screen counted in stops.
const MIN_DOWNSTREAM_STOPS = 4

async function main() {
  // ---- 1. live vehicle discovery (Orange Line first, then fallbacks) ----
  let picked = null
  const probe = []
  const tooLate = []
  for (const routeId of PROBE_ROUTES) {
    const d = await gql(`{ route(id: "${routeId}") {
      gtfsId shortName longName
      patterns { vehiclePositions {
        vehicleId lat lon heading speed
        trip { gtfsId tripHeadsign }
        stopRelationship { status stop { gtfsId name } }
      } } } }`)
    // Separate "the feed is empty" from "discovery is broken". These used to
    // land on the same ambiguous 'no live vehicles found on any probe route',
    // which is why the 2026-08-31 05:00 run read as a regression when the
    // network was simply not running yet.
    if (d?.errors?.length) {
      throw new Error(
        `OTP rejected the vehicle query for ${routeId}: ` +
          `${d.errors[0].message} — vehicle discovery is broken, not idle`
      )
    }
    const route = d?.data?.route
    if (!route) {
      throw new Error(
        `probe route ${routeId} is not in the graph — vehicle discovery is ` +
          'broken, not idle'
      )
    }
    const vehicles = (route?.patterns || []).flatMap(
      (p) => p.vehiclePositions || []
    )
    probe.push(`${routeId}=${vehicles.length}`)
    // A known next stop means mid-run rather than laying over, and it is also
    // the anchor everything downstream is measured from — so a vehicle without
    // one is no use here even as a fallback (it used to be `|| vehicles[0]`,
    // which put the anchor at index 0 and is the shape backlog 15.5 filed).
    for (const v of vehicles) {
      const nextId = v.stopRelationship?.stop?.gtfsId
      if (!nextId) continue
      const t = await gql(`{ trip(id: "${v.trip.gtfsId}") {
        gtfsId stoptimesForDate { scheduledDeparture serviceDay
          stop { gtfsId name lat lon } } } }`)
      const sts = t?.data?.trip?.stoptimesForDate || []
      const at = sts.findIndex((st) => st.stop.gtfsId === nextId)
      if (at < 0) continue
      const remaining = sts.length - 1 - at
      if (remaining < MIN_DOWNSTREAM_STOPS) {
        tooLate.push(`${v.vehicleId}@${at}/${sts.length - 1}`)
        continue
      }
      picked = { anchor: at, route, stopTimes: sts, vehicle: v }
      break
    }
    if (picked) break
  }
  if (!picked) {
    // Every probe route resolved in the graph and answered a vehiclePositions
    // query; they just had nothing on them. This suite runs at 05:00, before
    // most of the network is out of the garage.
    const now = new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/Chicago'
    })
    console.log(`[probe] vehicles per route: ${probe.join(', ')}`)
    console.log(
      `SKIP: no vehicle on any of the ${PROBE_ROUTES.length} probe routes has ` +
        `${MIN_DOWNSTREAM_STOPS}+ stops still ahead of it at ${now} ` +
        'America/Chicago. Every route resolved and the realtime feed ' +
        'answered, so vehicle discovery is healthy — there is simply no bus ' +
        'with a ride left in it to get off of. Nothing was verified.' +
        (tooLate.length
          ? ` Too near the end of their runs: ${tooLate.join(', ')}.`
          : '')
    )
    process.exit(EXIT_SKIP)
  }
  console.log(`[probe] vehicles per route: ${probe.join(', ')}`)
  const { route, vehicle } = picked
  console.log(
    `[setup] live vehicle ${vehicle.vehicleId} on ${
      route.shortName || route.longName
    } trip ${vehicle.trip.gtfsId} "${vehicle.trip.tripHeadsign}" @ ${
      vehicle.lat
    },${vehicle.lon} next: ${vehicle.stopRelationship?.stop?.name}`
  )

  // Destination: near the trip's last stop, nudged ~500m off the line — far
  // enough that different alight stops give genuinely different onward plans.
  // The stop times and the anchor index came back with the vehicle, from the
  // same query that screened it for remaining stops; fetching them twice let
  // the two disagree about which stop the bus was heading to.
  const { anchor, stopTimes } = picked
  const last = stopTimes[stopTimes.length - 1].stop
  const dest = {
    lat: last.lat + 0.004, // ~450m north
    lon: last.lon + 0.004, // ~350m east
    name: 'Verification destination'
  }
  console.log(
    `[setup] anchor stop idx ${anchor}/${stopTimes.length - 1} ` +
      `(${stopTimes.length - 1 - anchor} stop(s) still ahead), dest near ` +
      `"${last.name}" -> ${dest.lat},${dest.lon}`
  )

  // ---- 2. drive the app ----
  const browser = await puppeteer.launch({
    // --disable-gpu is not cosmetic here: this host runs a real X session, and
    // headless Chrome crashed on launch with "Protocol error
    // (Target.setAutoAttach): Target closed" on 3 of 4 attempts without it and
    // 0 of 7 with it (2026-09-02). --disable-dev-shm-usage is the usual
    // companion; /dev/shm is roomy on this box but the pair is what was
    // measured.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    executablePath: CHROME,
    headless: 'new'
  })
  const page = await browser.newPage()
  await page.setViewport({ height: 850, width: 393 }) // phone-ish -> mobile layout
  const ctx = browser.defaultBrowserContext()
  await ctx.overridePermissions(APP, ['geolocation'])
  await page.setGeolocation({
    accuracy: 10,
    latitude: vehicle.lat,
    longitude: vehicle.lon
  })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

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

  // ---- 3. seed state + real beginOnboardFlow ----
  const seed = await page.evaluate(
    async (rideInfo, destination) => {
      // Browser-context: Vite dev-server module URLs, not Node imports.
      // eslint-disable-next-line import/no-absolute-path
      const gm = await import('/lib/actions/go-mode.ts')
      // eslint-disable-next-line import/no-absolute-path
      const form = await import('/lib/actions/form.js')
      const store = window.store
      // destination for the onward plans
      store.dispatch(form.setQueryParam({ to: destination }))
      // sticky riding fact (what fix 1 maintains mid-ride)
      store.dispatch(
        gm.setRiding({
          boardedAt: Date.now(),
          headsign: rideInfo.headsign,
          legIndex: -1,
          offRouteSince: null,
          routeId: rideInfo.routeId,
          routeShortName: rideInfo.routeShortName,
          tripId: rideInfo.tripId,
          vehicleId: rideInfo.vehicleId
        })
      )
      // the real entry point the "I'm on the bus" button uses
      store.dispatch(gm.beginOnboardFlow())
      return {
        riding: store.getState().otp.goMode.riding,
        to: store.getState().otp.currentQuery.to
      }
    },
    {
      headsign: vehicle.trip.tripHeadsign,
      routeId: route.gtfsId,
      routeShortName: route.shortName || route.longName,
      tripId: vehicle.trip.gtfsId,
      vehicleId: vehicle.vehicleId
    },
    dest
  )
  console.log('[seed]', JSON.stringify(seed))

  // ---- 4. wait for ranked options ----
  await page.waitForFunction(
    () => {
      const ob = window.store.getState().otp.goMode.onboard
      return ob.status === 'ready' || ob.status === 'error'
    },
    { polling: 500, timeout: 90000 }
  )
  const onboard = await page.evaluate(() => {
    const ob = window.store.getState().otp.goMode.onboard
    // The score the app actually ranks on — scoreAlightOption
    // (lib/util/go-mode/alight-optimizer.ts:679-692), mirrored here rather than
    // imported because the ranked list in state is stripped of it.
    //
    // This script used to assert ascending `busArrivalEpoch + duration`, and
    // that sum is precisely the formula backlog 15.9 filed as WRONG: a plan
    // that departs long after the bus reaches the stop is scored from its own
    // start, so the sum understates its arrival by the whole platform wait (up
    // to 49 min in one recorded set). 15.9's fix ranks on the itinerary's real
    // endTime, so the old proxy now disagrees with the ranking by design and
    // reported "ranking broken at index 1" on a correctly ranked list.
    const scoreOf = (o) => {
      const viaDuration = o.busArrivalEpoch + (o.itinerary.duration || 0) * 1000
      const end = Number(o.itinerary.endTime)
      if (!Number.isFinite(end)) return viaDuration
      if (o.arrivalIsFloor) return end
      return Math.max(end, viaDuration)
    }
    return {
      alightOptions: (ob.alightOptions || []).map((o) => ({
        arrivalEpoch: scoreOf(o),
        arrivalIsFloor: !!o.arrivalIsFloor,
        busArrivalEpoch: o.busArrivalEpoch,
        duration: o.itinerary.duration,
        endTime: Number(o.itinerary.endTime),
        legs: (o.itinerary.legs || []).map((l) => l.mode).join(','),
        stopId: o.stopId,
        // The caption the row shows and the stop a tap guides to: the planning
        // anchor (stopName) only when the built ride does not run past it.
        stopName: o.alightStopName || o.stopName,
        transfers: o.itinerary.transfers,
        walk: Math.round(o.itinerary.walkDistance || 0)
      })),
      answeredCandidates: ob.answeredCandidates,
      best: ob.bestAlightStop?.stopId,
      candidates: (ob.candidates || []).length,
      failedCandidates: ob.failedCandidates,
      pendingCandidates: ob.pendingCandidates,
      status: ob.status
    }
  })
  console.log('[onboard]', JSON.stringify(onboard, null, 2))
  // Every candidate's onward plan errored or timed out => the OTP behind
  // api.transit-nav.com could not answer, and there was nothing for the ranker
  // to rank. That is not a ranking defect and 17.3 is why it can be told apart:
  // `failedCandidates` counts candidates that settled with no plan at all,
  // separately from `pendingCandidates`. Measured 2026-09-17: two consecutive
  // runs on the same vehicle and the same tree, one PASS in 22s and one
  // `status: 'error'` in 8s — the candidate fan-out is five real plan queries
  // against a box that 17.8 showed goes intermittently unresponsive. A partial
  // answer still FAILS below: some candidates answering and the list still
  // coming back empty IS a defect.
  if (
    onboard.status !== 'ready' &&
    onboard.candidates > 0 &&
    onboard.failedCandidates === onboard.candidates
  ) {
    console.log(
      `SKIP: all ${onboard.candidates} candidate onward plans failed at the ` +
        `backend (status=${onboard.status}, answered=` +
        `${onboard.answeredCandidates}, pending=${onboard.pendingCandidates}), ` +
        'so the ranker was never given anything to rank. Nothing was verified.'
    )
    await browser.close()
    process.exit(EXIT_SKIP)
  }
  if (onboard.status !== 'ready')
    throw new Error(
      `onboard flow ended in status=${onboard.status} ` +
        `(candidates=${onboard.candidates}, answered=` +
        `${onboard.answeredCandidates}, failed=${onboard.failedCandidates}, ` +
        `pending=${onboard.pendingCandidates})`
    )
  const opts = onboard.alightOptions
  if (opts.length < 2)
    throw new Error(`expected >1 ranked option, got ${opts.length}`)
  // rankAlightOptions does three things in order, and only the first is a sort:
  //   1. sort by scoreOf, with the TIE_MS (180s) tie-break on transfers/walk;
  //   2. demoteTokenTransitHopsBy — a STABLE PARTITION (hop-free options keep
  //      their order, token-hop ones move behind them keeping theirs), so the
  //      result is two ascending runs concatenated, not one;
  //   3. if keepRouteId held no slot, the LAST entry is replaced by the rider's
  //      own route however late it arrives.
  // So the invariant is "ascending, with at most one downward reset", plus a
  // free pass for the final entry. Asserting strict ascending over the whole
  // list asserts something the app never promised.
  const drops = []
  for (let i = 1; i < opts.length - 1; i++) {
    if (opts[i].arrivalEpoch < opts[i - 1].arrivalEpoch - 180000) drops.push(i)
  }
  if (drops.length > 1) {
    const show = (o) =>
      `${o.stopName} score=${new Date(o.arrivalEpoch).toISOString()}`
    throw new Error(
      `ranking broken: ${drops.length} downward steps (at ${drops.join(
        ', '
      )}), and the token-hop partition can only produce one — ` +
        opts.map(show).join(' | ')
    )
  }
  if (onboard.best !== opts[0].stopId)
    throw new Error('bestAlightStop != alightOptions[0]')
  console.log(
    `[assert] ${opts.length} ranked options; best==options[0]; ` +
      `${drops.length} partition reset(s) ✓`
  )

  await new Promise((resolve) => setTimeout(resolve, 800)) // let the list paint
  await page.screenshot({
    path: path.join(OUT, 'onboard-options-list.png')
  })

  // ---- 5. choose the SECOND ROW via the real UI (itinerary-list rows) ----
  //
  // Two things about this row list changed with `gomode/onboard-ui` (3.7), and
  // both used to break this block (6.42):
  //
  //  1. Rows are NOT alightOptions 1:1 any more. `groupAlightOptionsByRoute`
  //     stacks options riding the same chain of routes into one row and
  //     reorders them (5 options → 3 rows on a typical run), so `opts[1]` is
  //     not what row 2 shows. The row states its own stop in an "Off at X"
  //     label (OnboardItineraryList.tsx), so read the target off the row and
  //     match it back to an option by NAME rather than by index.
  //  2. The tap target moved. `onClickCapture` sits on an inner <div> rather
  //     than on `li.result`, so the variants drill-down can live outside it —
  //     a synthetic click on the `li` never reaches the handler and the run
  //     just times out waiting for guidance to start.
  const defaultStopName = opts.find((o) => o.stopId === onboard.best)?.stopName
  const chosen = await page.evaluate((defaultName) => {
    const rows = [...document.querySelectorAll('li.result')]
    if (rows.length < 2) return { error: `only ${rows.length} row(s) rendered` }
    // The label is its own leaf <div> ("Off at {stop}", OnboardItineraryList).
    // Match leaves only: every ancestor's textContent starts with it too, and
    // the outermost one carries the whole itinerary body with it.
    const nameOf = (row) => {
      const label = [...row.querySelectorAll('*')]
        .filter((el) => el.children.length === 0)
        .map((el) => (el.textContent || '').trim())
        .find((t) => /^Off at\s+\S/.test(t))
      return label ? label.replace(/^Off at\s+/, '') : null
    }
    const names = rows.map(nameOf)
    // Take the first row offering a stop OTHER than the one the app would pick
    // on its own — the whole point of this block is that a non-default choice
    // is honoured, and after grouping that stop is not reliably row 2.
    const pick = names.findIndex((n) => n && n !== defaultName)
    if (pick < 0) {
      return {
        names,
        // Not a defect and not drift: whether any alight stop other than the
        // default is on offer depends on where the destination sits relative
        // to the route. This script places it at the anchor stop's own
        // coordinates, and when the graph then folds every option onto that
        // one station (2026-09-17 05:00: three options, all "Burnsville Heart
        // of the City Station") there is no non-default choice to honour, so
        // there is nothing for step 5 to verify. Reported as a SKIP rather
        // than a red row.
        skip: `every row offers the default stop "${defaultName}"`
      }
    }
    // The inner div carrying onClickCapture is the row's first element child;
    // the variants drill-down deliberately sits outside it, so a click on the
    // `li` itself (what this script used to do) reaches no handler at all.
    const tapTarget = rows[pick].firstElementChild
    if (!tapTarget) return { error: `row ${pick + 1} has no tap target`, names }
    tapTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return { names, pick, rowCount: rows.length, stopName: names[pick] }
  }, defaultStopName)
  if (chosen.skip) {
    console.log(
      `[rows] ${chosen.names.join(' | ')}\n` +
        `SKIP: ${chosen.skip}. Steps 1-4 (discovery, ranking, best==row 1) all ` +
        'passed; step 5 needs a non-default stop to tap and the graph offered ' +
        'none for this destination.'
    )
    await browser.close()
    process.exit(EXIT_SKIP)
  }
  if (chosen.error)
    throw new Error(`could not choose an onboard row: ${chosen.error}`)
  const target = opts.find((o) => o.stopName === chosen.stopName)
  if (!target)
    throw new Error(
      `row ${chosen.pick + 1} shows "${chosen.stopName}", which is not one ` +
        `of the ranked options (${opts.map((o) => o.stopName).join(' | ')})`
    )
  console.log(
    `[click] ${chosen.rowCount} row(s) from ${opts.length} option(s): ` +
      `${chosen.names.join(' | ')} — chose row ${chosen.pick + 1} ` +
      `"${chosen.stopName}" (default was "${defaultStopName}")`
  )

  // ---- 5b. the PREVIEW screen, then Confirm ----
  //
  // Since `gomode/onboard-preview` (66fd9ce32, 2026-09-17, backlog 17.1) a row
  // tap PREVIEWS the option instead of committing the trip: it dispatches
  // OPEN_ONBOARD_PREVIEW and renders OnboardAlightPreview for that one option,
  // where `Confirm this stop` commits and `Back to options` returns to the
  // SAME list without a re-plan. The rider asked for this twice; the old flow
  // destroyed `onboard.alightOptions` just for looking. So the tap alone can
  // no longer start guidance, and this script must now walk the preview.
  //
  // Verify both halves while we are here, because "Back keeps the list" is the
  // whole point of the change: Back must return to the untouched options, and
  // only then does Confirm commit.
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.onboard.preview?.option != null,
    { polling: 200, timeout: 20000 }
  )
  const preview = await page.evaluate(() => {
    const ob = window.store.getState().otp.goMode.onboard
    return {
      control: ob.preview.control,
      optionCount: (ob.alightOptions || []).length,
      rendered: !!document.querySelector('[data-testid="onboard-preview"]'),
      stopId: ob.preview.option.stopId,
      stopName: ob.preview.option.alightStopName || ob.preview.option.stopName
    }
  })
  if (!preview.rendered)
    throw new Error(
      'preview is open in state but OnboardAlightPreview did not render'
    )
  if (preview.stopName !== chosen.stopName)
    throw new Error(
      `preview shows "${preview.stopName}" but row ${chosen.pick + 1} said ` +
        `"${chosen.stopName}"`
    )
  console.log(
    `[preview] control=${preview.control} "${preview.stopName}"; ` +
      `${preview.optionCount} option(s) still held`
  )

  // Back to options: the list must survive, and no trip may have started.
  await page.evaluate(() => {
    document
      .querySelector('[data-testid="onboard-preview-back"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.onboard.preview == null,
    { polling: 200, timeout: 10000 }
  )
  const afterBack = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    return {
      optionCount: (g.onboard.alightOptions || []).length,
      rows: document.querySelectorAll('li.result').length,
      started: g.activeItinerary != null
    }
  })
  if (afterBack.started)
    throw new Error('Back to options started the trip — only Confirm may')
  if (afterBack.optionCount !== opts.length)
    throw new Error(
      `Back to options cost the list: ${opts.length} options before, ` +
        `${afterBack.optionCount} after (the rider asked twice for this not to happen)`
    )
  console.log(
    `[preview] Back kept all ${afterBack.optionCount} option(s) and ` +
      `${afterBack.rows} row(s), no trip started ✓`
  )

  // ...then tap the same row again and Confirm for real.
  await page.evaluate((pick) => {
    const rows = [...document.querySelectorAll('li.result')]
    rows[pick].firstElementChild.dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    )
  }, chosen.pick)
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.onboard.preview?.option != null,
    { polling: 200, timeout: 20000 }
  )
  await page.evaluate(() => {
    document
      .querySelector('[data-testid="onboard-preview-confirm"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  await page.waitForFunction(
    () => {
      const g = window.store.getState().otp.goMode
      return g.activeItinerary != null && g.onboard.status === 'idle'
    },
    { polling: 300, timeout: 20000 }
  )
  const after = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    const busLeg = (g.activeItinerary.legs || []).find((l) => l.transitLeg)
    return {
      alightStop: busLeg?.to?.stop?.gtfsId,
      alightStopName: busLeg?.to?.name,
      isActive: g.isActive,
      legs: (g.activeItinerary.legs || []).map((l) => l.mode).join(','),
      onboardStatus: g.onboard.status
    }
  })
  console.log('[after]', JSON.stringify(after))
  // Assert on the stop the ROW promised, not on an option index: several
  // options can share a stop name (grouping stacks them), so the row's own
  // caption is the only thing the rider actually chose.
  if (after.alightStopName !== chosen.stopName)
    throw new Error(
      `guidance alight stop "${after.alightStopName}" != chosen ` +
        `"${chosen.stopName}" — rows were [${chosen.names.join(' | ')}], ` +
        `row ${chosen.pick + 1} was tapped, and guidance came back with ` +
        `legs ${after.legs} alighting at ${after.alightStop}`
    )
  if (after.alightStop === onboard.best)
    throw new Error(
      `guidance started on the DEFAULT stop ${onboard.best} — the rider's ` +
        'non-default choice was not honoured'
    )
  if (!after.isActive) throw new Error('go mode not active after confirm')
  console.log(
    `[assert] guidance started for the CHOSEN (non-default) stop "${after.alightStopName}" ✓`
  )

  await new Promise((resolve) => setTimeout(resolve, 1200))
  await page.screenshot({
    path: path.join(OUT, 'onboard-guidance-started.png')
  })

  // ---- 6. exit and immediately re-enter (7/12 regression) ----
  // Backing out of Go Mode and reopening "I'm on the bus" seconds later must
  // go straight back to the schedule/optimize path with no "which bus?"
  // prompt: being aboard is a physical fact the app already verified.
  await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const gm = await import('/lib/actions/go-mode.ts')
    window.store.dispatch(gm.endGoMode())
    window.store.dispatch(gm.beginOnboardFlow())
  })
  await page
    .waitForFunction(
      () => {
        const ob = window.store.getState().otp.goMode.onboard
        return ob.status === 'ready' || ob.status === 'error'
      },
      { polling: 500, timeout: 90000 }
    )
    .catch(async () => {
      const stuck = await page.evaluate(() => {
        const g = window.store.getState().otp.goMode
        return {
          isActive: g.isActive,
          riding: g.riding,
          status: g.onboard.status,
          vehicle: g.onboard.vehicle
        }
      })
      throw new Error(`re-entry stuck: ${JSON.stringify(stuck)}`)
    })
  // Everything a status=='error' re-entry needs to be diagnosed from the log
  // alone: what the flow still believed it was aboard, where it was planning
  // TO, and how the candidate fan-out settled. Without these the failure reads
  // as a bare "did not reach ready options" and tells the next reader nothing.
  const reentry = await page.evaluate(() => {
    const otp = window.store.getState().otp
    const g = otp.goMode
    return {
      answeredCandidates: g.onboard.answeredCandidates,
      candidates: (g.onboard.candidates || []).length,
      failedCandidates: g.onboard.failedCandidates,
      onboardTripId: g.onboard.trip?.id ?? g.onboard.trip?.gtfsId ?? null,
      optionCount: g.onboard.alightOptions.length,
      pendingCandidates: g.onboard.pendingCandidates,
      promptShown: g.boardingPrompt.shown,
      queryTo: otp.currentQuery?.to?.name ?? null,
      ridingTripId: g.riding?.tripId ?? null,
      status: g.onboard.status,
      vehicleId: g.onboard.vehicle?.vehicleId
    }
  })
  console.log('[reentry]', JSON.stringify(reentry))
  if (reentry.status !== 'ready' || reentry.optionCount === 0)
    throw new Error(
      're-entry did not reach ready options: ' + JSON.stringify(reentry)
    )
  if (reentry.promptShown)
    throw new Error(
      're-entry re-asked which bus — the app must trust its verified vehicle'
    )

  await browser.close()
  console.log('PASS: on-bus search surfaces ranked options and honors choice')
}

main().catch((e) => {
  // e.stack, not e.message: a puppeteer waitForFunction timeout says only
  // "waiting for function failed: timeout 60000ms exceeded" and names neither
  // the wait that failed nor its line. Six of the eleven red rows on
  // 2026-09-17 were that one line and nothing else, which is much of why this
  // suite's output stopped being read (backlog 13.6). The stack names the wait.
  console.error('FAIL:', e.stack || e.message)
  process.exit(1)
})
