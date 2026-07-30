/* eslint-disable no-console */
/**
 * "Locating your bus…" must not spin forever.
 *
 * On the 2026-07-22 ride the rider was aboard MVTA route 465 — an agency whose
 * GTFS-RT vehicle feed was not wired into OTP at all — so every vehicle-position
 * poll came back empty and the header promised "Locating your bus..." for the
 * whole trip. (The feed is wired up now; this guards the general case of a
 * route with no live vehicles, e.g. an agency that publishes none or a feed
 * that is down.)
 *
 * Required behavior: while the rider is on a transit leg whose route reports no
 * vehicles, vehicleMatch.emptyPolls climbs; once it reaches
 * NO_LIVE_VEHICLE_POLLS the header stops saying "Locating" and admits there is
 * no live data. A poll that DOES return vehicles resets the counter.
 */
const path = require('path')

const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const OUT = process.env.OUT_DIR || __dirname
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9788, lon: -93.2699, name: 'Test destination' }

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
  await page.goto(APP, { timeout: 60000, waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.store, { timeout: 30000 })

  await page.evaluate(
    async (from, to) => {
      // eslint-disable-next-line import/no-absolute-path
      const form = await import('/lib/actions/form.js')
      // eslint-disable-next-line import/no-absolute-path
      const api = await import('/lib/actions/api.js')
      window.store.dispatch(
        form.setQueryParam({
          departArrive: 'NOW',
          from,
          modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
          to
        })
      )
      window.store.dispatch(api.routingQuery())
    },
    FROM,
    TO
  )
  await page.waitForFunction(
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

  // Put the rider midway along the first transit leg, so TransitProgress is
  // the card on screen.
  const aboard = await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const pm = await import('/lib/util/go-mode/position-matching.js')
    const searches = window.store.getState().otp.searches || {}
    const itins = Object.values(searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
    const withTransit = itins.filter((it) =>
      (it.legs || []).some((l) => l.transitLeg)
    )
    if (!withTransit.length) return null
    const itin = withTransit[0]
    const legIndex = itin.legs.findIndex((l) => l.transitLeg)
    const leg = itin.legs[legIndex]
    // Shift the whole itinerary back so the transit leg is already underway.
    // Before its scheduled start the header has a different (correct) message
    // — "Bus not broadcasting yet" — which would mask what we're testing.
    const shift = leg.startTime - (Date.now() - 5 * 60 * 1000)
    itin.startTime -= shift
    itin.endTime -= shift
    itin.legs.forEach((l) => {
      l.startTime -= shift
      l.endTime -= shift
    })
    const poly = pm.decodeLegGeometry(leg)
    const [lat, lon] = poly[Math.floor(poly.length / 2)]
    window.__itin = itin
    const route = leg.route
    return {
      lat,
      lon,
      routeId: typeof route === 'object' ? route?.id : leg.routeId,
      routeName: leg.routeShortName || route?.shortName
    }
  })
  if (!aboard) throw new Error('no transit itinerary found')
  console.log('riding route', aboard.routeName, aboard.routeId)

  await page.setGeolocation({
    accuracy: 10,
    latitude: aboard.lat,
    longitude: aboard.lon
  })
  await page.evaluate(() => window.__beginGoMode(window.__itin))
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.isActive,
    {
      polling: 300,
      timeout: 20000
    }
  )

  // Feed the rider's position in so the transit leg becomes the active card.
  await page.evaluate(async (at) => {
    // eslint-disable-next-line import/no-absolute-path
    const goMode = await import('/lib/actions/go-mode.js')
    const dispatch = (a) => window.store.dispatch(a)
    const getState = () => window.store.getState()
    for (let i = 0; i < 3; i++) {
      goMode.handlePositionUpdate({
        coords: {
          accuracy: 10,
          altitude: null,
          altitudeAccuracy: null,
          heading: 0,
          latitude: at.lat,
          longitude: at.lon,
          speed: 8
        },
        timestamp: Date.now() + i * 1000
      })(dispatch, getState)
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }, aboard)

  // Poll vehicle matching against a route with no vehicles in the index. Read
  // the header text after each poll.
  const trace = await page.evaluate(async (routeId) => {
    // eslint-disable-next-line import/no-absolute-path
    const goMode = await import('/lib/actions/go-mode.js')
    const dispatch = (a) => window.store.dispatch(a)
    const getState = () => window.store.getState()
    // Guarantee the "no live vehicles" condition regardless of what the real
    // feed happens to be doing while this test runs. The one-time version of
    // this raced the app's own 15s vehicle poll: a live response landing
    // mid-loop refilled the index with real vehicles (Orange Line broadcasts
    // in the evening) and the counter was then CORRECTLY reset by the
    // non-empty-poll path — so re-assert emptiness before every poll.
    const emptyTheFeed = () => {
      const idx = getState().otp.transitIndex?.routes || {}
      if (idx[routeId]) idx[routeId].vehicles = []
    }
    emptyTheFeed()
    // Zero the counter first — the real 15s poller has been running since Go
    // Mode started, so emptyPolls is whatever it is by now.
    window.store.dispatch({
      payload: { emptyPolls: 0 },
      type: 'UPDATE_VEHICLE_MATCH'
    })
    const out = []
    for (let i = 0; i < 8; i++) {
      emptyTheFeed()
      goMode.performVehicleMatching(routeId)(dispatch, getState)
      await new Promise((resolve) => setTimeout(resolve, 60))
      const g = getState().otp.goMode
      out.push({
        emptyPolls: g.vehicleMatch.emptyPolls,
        header: document.body.innerText.match(
          /Locating your bus\.\.\.|No live bus data — tracking by GPS|Bus not broadcasting yet[^\n]*/
        )?.[0]
      })
    }
    return out
  }, aboard.routeId)

  trace.forEach((t, i) =>
    console.log(`poll ${i + 1}: emptyPolls=${t.emptyPolls} header=${t.header}`)
  )

  const shot = path.join(OUT, 'no-live-vehicle-data.png')
  await page.screenshot({ path: shot })
  console.log('screenshot ->', shot)

  const last = trace[trace.length - 1]
  const problems = []
  // What this script owns is the counter reaching the UI through the real
  // store — the goMode reducer delegation is easy to get silently wrong.
  // Which string renders at which count is asserted in
  // __tests__/components/go-mode/transit-progress.js, where the leg times are
  // not being re-anchored to the next real departure underneath us.
  // ">= 8" not "=== 8": the app's own 15s poller can land an extra empty poll
  // inside the loop window, which only accumulates further.
  if (last.emptyPolls < 8) {
    problems.push(`emptyPolls should reach 8, got ${last.emptyPolls}`)
  }

  // A poll that finds a vehicle must reset the counter.
  const afterReset = await page.evaluate(async (routeId) => {
    // eslint-disable-next-line import/no-absolute-path
    const goMode = await import('/lib/actions/go-mode.js')
    const getState = () => window.store.getState()
    const pos = getState().otp.goMode.tracking.lastPosition.coords
    const idx = getState().otp.transitIndex.routes
    if (!idx[routeId]) idx[routeId] = {}
    idx[routeId].vehicles = [
      {
        heading: 0,
        label: '9999',
        lat: pos.latitude,
        lon: pos.longitude,
        patternId: routeId,
        routeId,
        seconds: Math.floor(Date.now() / 1000),
        speed: 8,
        stopStatus: 'IN_TRANSIT_TO',
        vehicleId: '9999'
      }
    ]
    goMode.performVehicleMatching(routeId)(
      (a) => window.store.dispatch(a),
      getState
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
    return getState().otp.goMode.vehicleMatch.emptyPolls
  }, aboard.routeId)
  console.log('emptyPolls after a successful poll:', afterReset)
  if (afterReset !== 0) {
    problems.push(`a successful poll must reset emptyPolls, got ${afterReset}`)
  }

  await browser.close()
  if (problems.length) {
    problems.forEach((p) => console.log('FAIL:', p))
    process.exit(1)
  }
  console.log('PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
