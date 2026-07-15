/* eslint-disable no-console */
/**
 * Arrival verification. On the 2026-07-12 ride, reaching the destination fired
 * TRIP_COMPLETE three times (the deviation flood evicted its dedup id), Off
 * Route notifications kept firing after arrival, and the rider was left
 * staring at a search screen they never asked for. Required behavior: the
 * first completed tick marks arrivedAt and emits exactly one TRIP_COMPLETE;
 * later ticks are quiet (no notifications, no reroutes); Go Mode stays up
 * showing an arrival card until the rider taps Done, which exits to the home
 * screen.
 */
const path = require('path')

const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const OUT = process.env.OUT_DIR || __dirname
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9346, lon: -93.2624, name: 'Test destination' }

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
          modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
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

  // Any all-access itinerary; the rider "arrives" by standing at the very end
  // of its final leg.
  const dest = await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const pm = await import('/lib/util/go-mode/position-matching.js')
    const searches = window.store.getState().otp.searches || {}
    const itins = Object.values(searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
    const ok = itins.filter((it) => (it.legs || []).every((l) => !l.transitLeg))
    if (!ok.length) return null
    ok.sort((a, b) => a.duration - b.duration)
    window.__itin = ok[0]
    const lastLeg = ok[0].legs[ok[0].legs.length - 1]
    const poly = pm.decodeLegGeometry(lastLeg)
    const [lat, lon] = poly[poly.length - 1]
    return { lat, lon }
  })
  if (!dest) throw new Error('no all-access itinerary found')

  await page.setGeolocation({
    accuracy: 10,
    latitude: dest.lat,
    longitude: dest.lon
  })
  await page.evaluate(() => window.__beginGoMode(window.__itin))
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.isActive,
    { polling: 300, timeout: 20000 }
  )

  // Stand at the destination for 10 ticks, then 10 more from a spot ~350m off
  // the planned line (rider wandered after arriving — must stay quiet).
  const tick = (at, ticks) =>
    page.evaluate(
      async (at, ticks) => {
        // eslint-disable-next-line import/no-absolute-path
        const goMode = await import('/lib/actions/go-mode.js')
        const seen = []
        const spy = (action) => {
          if (typeof action === 'function') return window.store.dispatch(action)
          if (action?.type) seen.push(action)
          return window.store.dispatch(action)
        }
        const getState = () => window.store.getState()
        for (let i = 0; i < ticks; i++) {
          goMode.handlePositionUpdate({
            coords: {
              accuracy: 10,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              latitude: at.lat,
              longitude: at.lon,
              speed: 0
            },
            timestamp: Date.now() + i * 1000
          })(spy, getState)
          await new Promise((resolve) => setTimeout(resolve, 120))
        }
        const g = getState().otp.goMode
        return {
          arrivedAt: g.arrivedAt,
          notifications: seen
            .filter((a) => a.type === 'ADD_NOTIFICATION')
            .map((a) => a.payload?.type),
          reroutes: seen.filter((a) => a.type === 'START_REROUTE').length,
          tripCompletes: (g.notifications?.recentNotifications || []).filter(
            (n) => n.type === 'TRIP_COMPLETE'
          ).length
        }
      },
      at,
      ticks
    )

  const atDest = await tick(dest, 10)
  console.log(
    `[arrive] 10 ticks at the destination: arrivedAt=${
      atDest.arrivedAt ? 'set' : 'NOT SET'
    }, TRIP_COMPLETE x${atDest.tripCompletes}, ` +
      `notifications during: [${atDest.notifications.join(', ')}]`
  )

  const wander = await tick({ lat: dest.lat + 0.005, lon: dest.lon }, 10)
  console.log(
    '[wander] 10 ticks 350m+ off the line after arrival: ' +
      `notifications: [${wander.notifications.join(', ')}], ` +
      `reroutes: ${wander.reroutes}, TRIP_COMPLETE x${wander.tripCompletes}`
  )

  // The arrival card is up on the Go Mode screen.
  const ui = await page.evaluate(() => ({
    cardShown: document.body.innerText.includes("You've arrived"),
    screen: window.store.getState().otp.ui?.mobileScreen
  }))
  await page.screenshot({ path: path.join(OUT, 'arrival-card.png') })
  console.log(
    `[ui] screen=${ui.screen}, arrival card ${
      ui.cardShown ? 'shown' : 'NOT FOUND'
    } -> arrival-card.png`
  )

  // Done exits Go Mode and lands on the home screen — not a results list.
  const doneClicked = await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Done'
    )
    if (!button) return false
    button.click()
    return true
  })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const afterDone = await page.evaluate(() => ({
    isActive: window.store.getState().otp.goMode.isActive,
    screen: window.store.getState().otp.ui?.mobileScreen
  }))
  console.log(
    `[done] clicked=${doneClicked}; Go Mode active=${afterDone.isActive}, ` +
      `screen=${afterDone.screen}`
  )

  await browser.close()

  if (!atDest.arrivedAt) throw new Error('FAIL: arrivedAt never set')
  if (atDest.tripCompletes !== 1) {
    throw new Error(`FAIL: TRIP_COMPLETE fired ${atDest.tripCompletes}x`)
  }
  if (wander.notifications.length > 0 || wander.reroutes > 0) {
    throw new Error(
      `FAIL: post-arrival ticks fired [${wander.notifications.join(', ')}] ` +
        `and ${wander.reroutes} reroute(s) — arrival must quiesce`
    )
  }
  if (wander.tripCompletes !== 1) {
    throw new Error(
      `FAIL: TRIP_COMPLETE count became ${wander.tripCompletes} after arrival`
    )
  }
  if (ui.screen !== 10 || !ui.cardShown) {
    throw new Error('FAIL: arrival card not shown on the Go Mode screen')
  }
  if (!doneClicked || afterDone.isActive || afterDone.screen === 8) {
    throw new Error(
      'FAIL: Done must end Go Mode and land on the home screen, not results'
    )
  }
  console.log(
    '\nPASS: one TRIP_COMPLETE, quiet after arrival, card until Done, home on exit.'
  )
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
