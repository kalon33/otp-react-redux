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

async function main() {
  // ---- 1. live vehicle discovery (Orange Line first, then fallbacks) ----
  let picked = null
  const probe = []
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
    // Prefer a vehicle with a known next stop (mid-run, not laying over)
    const v =
      vehicles.find((x) => x.stopRelationship?.stop?.gtfsId) || vehicles[0]
    if (v) {
      picked = { route, vehicle: v }
      break
    }
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
      `SKIP: no vehicle is running on any of the ${PROBE_ROUTES.length} probe ` +
        `routes at ${now} America/Chicago. Every route resolved and the ` +
        'realtime feed answered, so vehicle discovery is healthy — there is ' +
        'simply no bus to board. Nothing was verified.'
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

  // Destination: a couple stops down the trip, then ~500m off the line — far
  // enough that different alight stops give genuinely different onward plans.
  const trip = await gql(`{ trip(id: "${vehicle.trip.gtfsId}") {
    gtfsId stoptimesForDate { scheduledDeparture serviceDay
      stop { gtfsId name lat lon } } } }`)
  const stopTimes = trip?.data?.trip?.stoptimesForDate || []
  if (stopTimes.length < 3) throw new Error('trip has too few stop times')
  // find index of the vehicle's next stop; destination ~near the last stop,
  // nudged off-line so onward legs exist.
  const nextId = vehicle.stopRelationship?.stop?.gtfsId
  let anchor = stopTimes.findIndex((st) => st.stop.gtfsId === nextId)
  if (anchor < 0) anchor = 0
  const last = stopTimes[stopTimes.length - 1].stop
  const dest = {
    lat: last.lat + 0.004, // ~450m north
    lon: last.lon + 0.004, // ~350m east
    name: 'Verification destination'
  }
  console.log(
    `[setup] anchor stop idx ${anchor}/${stopTimes.length}, dest near "${last.name}" -> ${dest.lat},${dest.lon}`
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
  await page.waitForFunction(() => !!window.store, { timeout: 30000 })

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
    return {
      alightOptions: (ob.alightOptions || []).map((o) => ({
        arrivalEpoch: o.busArrivalEpoch + (o.itinerary.duration || 0) * 1000,
        busArrivalEpoch: o.busArrivalEpoch,
        duration: o.itinerary.duration,
        legs: (o.itinerary.legs || []).map((l) => l.mode).join(','),
        stopId: o.stopId,
        // The caption the row shows and the stop a tap guides to: the planning
        // anchor (stopName) only when the built ride does not run past it.
        stopName: o.alightStopName || o.stopName,
        transfers: o.itinerary.transfers,
        walk: Math.round(o.itinerary.walkDistance || 0)
      })),
      best: ob.bestAlightStop?.stopId,
      status: ob.status
    }
  })
  console.log('[onboard]', JSON.stringify(onboard, null, 2))
  if (onboard.status !== 'ready')
    throw new Error(`onboard flow ended in status=${onboard.status}`)
  const opts = onboard.alightOptions
  if (opts.length < 2)
    throw new Error(`expected >1 ranked option, got ${opts.length}`)
  for (let i = 1; i < opts.length; i++) {
    // ranked = arrival ascending, allowing the TIE_MS tie-break reorder (180s)
    if (opts[i].arrivalEpoch < opts[i - 1].arrivalEpoch - 180000)
      throw new Error(`ranking broken at index ${i}`)
  }
  if (onboard.best !== opts[0].stopId)
    throw new Error('bestAlightStop != alightOptions[0]')
  console.log(`[assert] ${opts.length} ranked options; best==options[0] ✓`)

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
        error: `no row offered a stop other than "${defaultName}"`,
        names
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
  const reentry = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    return {
      optionCount: g.onboard.alightOptions.length,
      promptShown: g.boardingPrompt.shown,
      status: g.onboard.status,
      vehicleId: g.onboard.vehicle?.vehicleId
    }
  })
  console.log('[reentry]', JSON.stringify(reentry))
  if (reentry.status !== 'ready' || reentry.optionCount === 0)
    throw new Error('re-entry did not reach ready options')
  if (reentry.promptShown)
    throw new Error(
      're-entry re-asked which bus — the app must trust its verified vehicle'
    )

  await browser.close()
  console.log('PASS: on-bus search surfaces ranked options and honors choice')
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
