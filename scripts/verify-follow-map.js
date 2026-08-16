/* eslint-disable no-console */
/**
 * Live follow map verification (7/29 rider request: "real time view of
 * navigation similar to Google Maps routing. It should follow dot as you are
 * moving, toggle with a button real-time follow view").
 *
 * Four things must hold:
 *   1. A new trip starts with follow ON (reducer default) and the map shows
 *      the follow button engaged (aria-pressed).
 *   2. While the GPS sim moves the rider, the camera keeps the user dot near
 *      the center of the map (the follow eases track each accepted fix).
 *   3. A real map drag disengages follow (idempotent SET, within a second),
 *      after which the dot drifts off-center while the sim keeps running —
 *      the camera stays where the rider put it.
 *   4. Tapping the follow button re-engages: state flips true and the camera
 *      eases straight back to the last fix. Zoom (wheel/pinch) does NOT
 *      disengage — Google behavior, the rider adjusts zoom while following.
 *
 * Harness: same as verify-leg-transition (real app at :9967, dev hooks).
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'
const OUT = process.env.OUT_DIR || __dirname

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9778, lon: -93.2707, name: 'Downtown Minneapolis' }

// The follow camera must keep the dot inside the central 40% of the map for
// at least this share of samples while the sim runs.
const CENTER_BOX = 0.2 // +/- 20% of the map's width/height around center
const CENTER_RATIO_MIN = 0.9

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
        form.setQueryParam({ departArrive: 'NOW', from, to })
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

  // A walk→bus itinerary, so the sim crosses an access→transit leg change.
  const chosen = await page.evaluate(() => {
    const searches = window.store.getState().otp.searches || {}
    const itins = Object.values(searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
    const ok = itins.filter((it) => {
      const legs = it.legs || []
      return legs[0]?.mode === 'WALK' && legs[1]?.transitLeg
    })
    if (!ok.length) return null
    ok.sort((a, b) => a.startTime - b.startTime)
    window.__itin = ok[0]
    return {
      busRoute: ok[0].legs[1].routeShortName || ok[0].legs[1].routeLongName
    }
  })
  if (!chosen) throw new Error('no walk→bus itinerary found')
  console.log(`[setup] walk→${chosen.busRoute} trip chosen`)

  await page.evaluate(() => window.__beginGoMode(window.__itin))
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.isActive,
    { polling: 300, timeout: 20000 }
  )

  const getFollow = () =>
    page.evaluate(() => window.store.getState().otp.goMode.ui.mapFollowUser)

  // ---- (1) default-on + engaged button ----
  if ((await getFollow()) !== true) {
    throw new Error('FAIL: mapFollowUser is not true at trip start')
  }
  await page.waitForSelector('[data-testid="go-mode-follow-toggle"]', {
    timeout: 10000
  })
  const pressed = await page.$eval(
    '[data-testid="go-mode-follow-toggle"]',
    (el) => el.getAttribute('aria-pressed')
  )
  if (pressed !== 'true') {
    throw new Error(`FAIL: follow button aria-pressed=${pressed}, want true`)
  }
  console.log('[1] follow defaults ON; button engaged')

  // Dot center offset from the map center, in fractions of the map size.
  const sampleDot = () =>
    page.evaluate(() => {
      const dot = document.querySelector('[data-testid="go-mode-user-dot"]')
      const mapEl = document.querySelector('.maplibregl-map')
      if (!dot || !mapEl) return null
      const d = dot.getBoundingClientRect()
      const m = mapEl.getBoundingClientRect()
      return {
        fx: (d.x + d.width / 2 - (m.x + m.width / 2)) / m.width,
        fy: (d.y + d.height / 2 - (m.y + m.height / 2)) / m.height,
        map: { h: m.height, w: m.width, x: m.x, y: m.y }
      }
    })
  const inCenterBox = (s) =>
    s && Math.abs(s.fx) <= CENTER_BOX && Math.abs(s.fy) <= CENTER_BOX

  // ---- (2) camera follows the moving dot ----
  await page.evaluate(() => window.__startGpsSimulation(5))
  // Let the trip-overview fitBounds + engage delay land before judging.
  await sleep(4000)
  let inBox = 0
  let total = 0
  for (let i = 0; i < 40; i++) {
    const s = await sampleDot()
    if (s) {
      total++
      if (inCenterBox(s)) inBox++
    }
    await sleep(500)
  }
  const ratio = total ? inBox / total : 0
  console.log(
    `[2] ${inBox}/${total} samples inside the central 40% box ` +
      `(${(ratio * 100).toFixed(0)}%)`
  )
  await page.screenshot({ path: `${OUT}/follow-tracking.png` })
  if (total === 0 || ratio < CENTER_RATIO_MIN) {
    throw new Error(
      `FAIL: dot centered in only ${(ratio * 100).toFixed(0)}% of samples — ` +
        'camera is not following'
    )
  }

  // ---- (3) a real drag disengages ----
  const before = await sampleDot()
  if (!before) throw new Error('FAIL: map/dot not on screen for drag')
  const cx = before.map.x + before.map.w / 2 + 60
  const cy = before.map.y + before.map.h / 2 - 80
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx - (120 * i) / steps, cy + (90 * i) / steps)
    await sleep(40)
  }
  await page.mouse.up()
  await sleep(1000)
  if ((await getFollow()) !== false) {
    throw new Error('FAIL: drag did not disengage follow within 1s')
  }
  // The sim keeps running; with the camera parked, the dot must drift away.
  let drifted = false
  for (let i = 0; i < 30 && !drifted; i++) {
    const s = await sampleDot()
    // Off-screen (querySelector still finds it at clipped coords) or outside
    // the box both count as "the camera stopped chasing".
    if (!s || !inCenterBox(s)) drifted = true
    await sleep(500)
  }
  await page.screenshot({ path: `${OUT}/follow-disengaged.png` })
  if (!drifted) {
    throw new Error(
      'FAIL: dot stayed centered after disengage — camera still following'
    )
  }
  console.log('[3] drag disengaged follow; dot drifted off-center')

  // ---- (4) the button re-engages and the camera comes back ----
  await page.click('[data-testid="go-mode-follow-toggle"]')
  await sleep(300)
  if ((await getFollow()) !== true) {
    throw new Error('FAIL: follow button did not re-engage')
  }
  let recentered = false
  for (let i = 0; i < 4 && !recentered; i++) {
    await sleep(500)
    const s = await sampleDot()
    if (inCenterBox(s)) recentered = true
  }
  await page.screenshot({ path: `${OUT}/follow-reengaged.png` })
  if (!recentered) {
    throw new Error('FAIL: dot did not return to center within 2s of re-engage')
  }
  console.log('[4] button re-engaged; camera eased back to the rider')

  // ---- (5) zoom does not disengage ----
  await page.mouse.move(
    before.map.x + before.map.w / 2,
    before.map.y + before.map.h / 2
  )
  await page.mouse.wheel({ deltaY: -240 })
  await sleep(1000)
  if ((await getFollow()) !== true) {
    throw new Error('FAIL: wheel zoom disengaged follow — it must not')
  }
  console.log('[5] zoom kept follow engaged')

  await browser.close()
  console.log(
    '\nPASS: follow defaults on, tracks the dot, drag disengages, ' +
      'button re-engages, zoom never disengages.'
  )
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
