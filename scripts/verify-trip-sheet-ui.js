/* eslint-disable no-console */
/**
 * Trip-sheet UI verification: the rest-of-trip section must be the app's OWN
 * itinerary UI, not a Go Mode re-implementation, without losing the two live
 * signals only Go Mode has.
 *
 * (1) the sheet renders the real ItineraryBody (.itin-body) with per-leg
 *     "Zoom to leg on map" controls;
 * (2) the Go Mode "right now" card survives — current leg, its remaining stops,
 *     and the live wait note;
 * (3) the trip tools (Start Over / Print / Report Issue) are NOT rendered —
 *     "Start Over" mid-ride would discard the trip being navigated;
 * (4) tapping a leg sets goMode.ui.activeLeg and collapses the sheet so the
 *     map zoom is visible; tapping the same leg again clears it;
 * (5) the expand/collapse toggle switches between list-tall and map-tall.
 *
 * Screenshots land in scripts/ for visual sign-off.
 *
 * Harness: same as verify-background-explore — drive the real app at :9967
 * with the dev hooks; the plan hits real OTP.
 */
const path = require('path')

const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const OUT = process.env.OUT_DIR || __dirname
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9778, lon: -93.2707, name: 'Downtown Minneapolis' }

const SHEET = '[role="dialog"][aria-label="Trip overview"]'

// The sheet animates its height over 300ms; let it land before measuring.
const settle = (page) =>
  page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)))

const shot = (page, name) =>
  page.screenshot({ path: path.join(OUT, name) }).then(() => {
    console.log(`  wrote ${name}`)
  })

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

  // ---- plan a trip, start Go Mode + sim ----
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
    () =>
      Object.values(window.store.getState().otp.searches || {}).some(
        (s) =>
          s.pending === 0 &&
          (s.response || []).some((r) => r?.plan?.itineraries?.length > 0)
      ),
    { polling: 500, timeout: 60000 }
  )
  const legCount = await page.evaluate(() => {
    const itin = Object.values(window.store.getState().otp.searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
      .filter((it) => (it.legs || []).some((l) => l.transitLeg))
      .sort((a, b) => a.startTime - b.startTime)[0]
    window.__sheetItinerary = itin
    return itin.legs.length
  })
  console.log(`[setup] itinerary with ${legCount} legs`)

  await page.evaluate(() => window.__beginGoMode(window.__sheetItinerary))
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

  // ---- open the sheet ----
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button'))
      .find((b) => (b.textContent || '').includes('View trip'))
      .click()
  })
  await page.waitForSelector(SHEET, { timeout: 10000 })

  // ---- (1)(2)(3) content ----
  const content = await page.evaluate((sel) => {
    const sheet = document.querySelector(sel)
    const text = sheet.innerText
    return {
      hasItinBody: !!sheet.querySelector('.itin-body'),
      // The Go Mode "right now" card is the first child after the section
      // title and is the only thing carrying the current-leg accent border.
      hasRightNow: Array.from(sheet.querySelectorAll('div')).some(
        (d) => getComputedStyle(d).borderLeftWidth === '3px'
      ),

      hasStartOver: /start over/i.test(text),
      hasWait: /min wait/.test(text),
      rawMessageIds: (text.match(/components\.[A-Za-z.]+/g) || []).slice(0, 3),
      zoomButtons: Array.from(sheet.querySelectorAll('button')).filter((b) =>
        /zoom to leg/i.test(b.textContent || '')
      ).length
    }
  }, SHEET)
  console.log(
    `[content] itin-body=${content.hasItinBody} zoom-buttons=${content.zoomButtons} ` +
      `right-now-card=${content.hasRightNow} wait-note=${content.hasWait} ` +
      `start-over=${content.hasStartOver}`
  )
  if (!content.hasRightNow) {
    throw new Error('the Go Mode "right now" current-leg card is missing')
  }
  if (!content.hasItinBody) {
    throw new Error('sheet did not render the app itinerary body')
  }
  if (!content.zoomButtons) throw new Error('no per-leg zoom controls rendered')
  if (content.hasStartOver) {
    throw new Error('trip tools leaked into the sheet ("Start Over" mid-trip)')
  }
  if (content.rawMessageIds.length) {
    throw new Error(
      `untranslated message ids in the sheet: ${content.rawMessageIds.join(
        ', '
      )}`
    )
  }
  await shot(page, 'trip-sheet-expanded.png')

  // ---- (4) tap a leg -> activeLeg set + sheet collapses ----
  await page.evaluate((sel) => {
    document
      .querySelector(sel)
      .querySelectorAll('button')
      .forEach((b) => {
        if (!window.__zoomed && /zoom to leg/i.test(b.textContent || '')) {
          window.__zoomed = true
          b.click()
        }
      })
  }, SHEET)
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.ui.activeLeg !== null,
    { polling: 200, timeout: 10000 }
  )
  await settle(page)
  const zoomed = await page.evaluate((sel) => {
    const sheet = document.querySelector(sel)
    return {
      activeLeg: window.store.getState().otp.goMode.ui.activeLeg,
      // The sheet must have shrunk so the map (and its zoom) is visible.
      heightRatio: sheet.getBoundingClientRect().height / window.innerHeight,
      maxHeight: getComputedStyle(sheet).maxHeight,
      // The dimming overlay must be gone or the map can't be tapped.
      overlayGone: !document.querySelector('.go-mode-sheet-overlay')
    }
  }, SHEET)
  console.log(
    `[zoom] activeLeg=${zoomed.activeLeg}, sheet now ` +
      `${Math.round(zoomed.heightRatio * 100)}% of the viewport ` +
      `(max-height ${zoomed.maxHeight}), overlay gone=${zoomed.overlayGone}`
  )
  if (zoomed.heightRatio > 0.55) {
    throw new Error('sheet did not collapse to reveal the zoomed map')
  }
  if (!zoomed.overlayGone) {
    throw new Error('dimming overlay still covers the map when collapsed')
  }
  await shot(page, 'trip-sheet-collapsed-zoom.png')

  // ---- (4b) selecting a DIFFERENT leg moves the map camera ----
  // This dev instance renders no basemap, so assert the camera via maplibre's
  // own projection: the user marker's screen transform only changes if the
  // map actually panned/zoomed.
  const camera = await page.evaluate(async (sel) => {
    const marker = () =>
      document.querySelector('.maplibregl-marker')?.style.transform || null
    const zooms = () =>
      Array.from(document.querySelectorAll(`${sel} button`)).filter((b) =>
        /zoom to leg/i.test(b.textContent || '')
      )
    const first = marker()
    const buttons = zooms()
    // Jump to the LAST leg, which is nowhere near the first.
    buttons[buttons.length - 1]?.click()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    return { first, last: marker() }
  }, SHEET)
  console.log(
    `[camera] marker moved on leg change: ${camera.first !== camera.last}`
  )
  if (!camera.first || camera.first === camera.last) {
    throw new Error('selecting a different leg did not move the map camera')
  }
  // Put the selection back on the first leg for the toggle check below.
  await page.evaluate((sel) => {
    Array.from(document.querySelectorAll(`${sel} button`))
      .filter((b) => /zoom to leg/i.test(b.textContent || ''))[0]
      ?.click()
  }, SHEET)
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.ui.activeLeg === 0,
    { polling: 200, timeout: 10000 }
  )

  // Tapping the same leg again clears the selection.
  await page.evaluate(
    (sel, idx) => {
      const btns = Array.from(
        document.querySelector(sel).querySelectorAll('button')
      ).filter((b) => /zoom to leg/i.test(b.textContent || ''))
      btns[idx]?.click()
    },
    SHEET,
    0
  )
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.ui.activeLeg === null,
    { polling: 200, timeout: 10000 }
  )
  console.log('[zoom] tapping the same leg again cleared the selection')

  // ---- (5) expand toggle ----
  const toggled = await page.evaluate((sel) => {
    const sheet = document.querySelector(sel)
    const before = sheet.getBoundingClientRect().height
    Array.from(sheet.querySelectorAll('button'))
      .find((b) => /show results|expand map/i.test(b.textContent || ''))
      .click()
    return { before }
  }, SHEET)
  await settle(page)
  const after = await page.evaluate(
    (sel) => document.querySelector(sel).getBoundingClientRect().height,
    SHEET
  )
  console.log(
    `[toggle] sheet height ${Math.round(toggled.before)} -> ${Math.round(
      after
    )}`
  )
  if (Math.abs(after - toggled.before) < 40) {
    throw new Error('expand/collapse toggle did not change the sheet height')
  }

  await browser.close()
  console.log(
    '\nPASS: real itinerary body in the sheet, live "right now" card kept,' +
      ' no trip tools, leg zoom moves the camera, expand toggle working'
  )
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
