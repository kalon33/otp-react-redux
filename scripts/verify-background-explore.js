/* eslint-disable no-console */
/**
 * Backgrounded-trip / alternate-route exploration verification:
 * (1) a mid-trip re-route must be fully ISOLATED from the planner — same
 *     activeSearchId, same searches map, byte-identical currentQuery.from/to
 *     after it settles;
 * (2) backgroundGoMode drops the rider into the normal planner with the
 *     ReturnToTripBanner visible (live text), while the trip keeps running;
 * (3) tapping the banner returns to the Go Mode screen;
 * (4) 'Switch to this trip' on a planner itinerary (with confirm) adopts it
 *     and foregrounds Go Mode;
 * (5) a reload while backgrounded resumes backgrounded — banner back, Go Mode
 *     screen NOT forced.
 *
 * Harness (same as verify-missed-bus): drive the real app at :9967 with the
 * dev hooks; the plan/re-route hit the real OTP.
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9778, lon: -93.2707, name: 'Downtown Minneapolis' }

const GO_MODE = 10
const BANNER = '.return-to-trip-banner'

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
  // 'Switch to this trip' confirms via window.confirm — accept it.
  page.on('dialog', (d) => d.accept())
  await page.goto(APP, { timeout: 60000, waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.store, { timeout: 30000 })

  // ---- plan a trip through the app's own pipeline ----
  await page.evaluate(
    async (from, to) => {
      // Browser-context: Vite dev-server module URLs, not Node imports.
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

  const planned = await page.evaluate(() => {
    const otp = window.store.getState().otp
    const itins = Object.values(otp.searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
      .filter((it) => (it.legs || []).some((l) => l.transitLeg))
      .sort((a, b) => a.startTime - b.startTime)
    window.__bgExploreItinerary = itins[0]
    return {
      activeSearchId: otp.activeSearchId,
      from: JSON.stringify(otp.currentQuery.from),
      itinCount: itins.length,
      searchIds: Object.keys(otp.searches).sort().join(','),
      to: JSON.stringify(otp.currentQuery.to)
    }
  })
  if (!planned.itinCount) throw new Error('no transit itinerary planned')
  console.log(
    `[setup] ${planned.itinCount} transit itineraries; activeSearchId=${planned.activeSearchId}`
  )

  // ---- start Go Mode + sim ----
  await page.evaluate(() => window.__beginGoMode(window.__bgExploreItinerary))
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

  // ---- (1) explicit re-route: planner state must not move ----
  await page.evaluate(() => window.__reRoute())
  await page.waitForFunction(
    () => {
      const s = window.store.getState().otp.goMode.reRoute.status
      return s === 'found' || s === 'none' || s === 'error'
    },
    { polling: 300, timeout: 60000 }
  )
  const afterReroute = await page.evaluate(() => {
    const otp = window.store.getState().otp
    return {
      activeSearchId: otp.activeSearchId,
      candidates: otp.goMode.reRoute.candidates.length,
      from: JSON.stringify(otp.currentQuery.from),
      searchIds: Object.keys(otp.searches).sort().join(','),
      status: otp.goMode.reRoute.status,
      to: JSON.stringify(otp.currentQuery.to)
    }
  })
  console.log(
    `[reroute] settled '${afterReroute.status}' with ${afterReroute.candidates} candidate(s)`
  )
  if (afterReroute.status !== 'found' || afterReroute.candidates < 1) {
    throw new Error(
      `re-route did not find alternatives (${afterReroute.status})`
    )
  }
  for (const key of ['activeSearchId', 'searchIds', 'from', 'to']) {
    if (afterReroute[key] !== planned[key]) {
      throw new Error(
        `re-route leaked into planner state: ${key} ${planned[key]} -> ${afterReroute[key]}`
      )
    }
  }
  console.log('[reroute] planner state untouched (searchId/searches/query)')

  // ---- (2) background the trip: planner + banner ----
  await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const goMode = await import('/lib/actions/go-mode.ts')
    window.store.dispatch(goMode.backgroundGoMode())
  })
  await page.waitForSelector(BANNER, { timeout: 10000 })
  const bg = await page.evaluate((sel) => {
    const s = window.store.getState().otp
    return {
      backgrounded: s.goMode.ui.backgrounded,
      bannerText: document.querySelector(sel)?.textContent || '',
      isActive: s.goMode.isActive,
      mobileScreen: s.ui.mobileScreen
    }
  }, BANNER)
  if (!bg.backgrounded || !bg.isActive || bg.mobileScreen === GO_MODE) {
    throw new Error(`backgrounding failed: ${JSON.stringify(bg)}`)
  }
  if (!bg.bannerText) throw new Error('banner rendered without text')
  console.log(
    `[background] planner screen=${bg.mobileScreen}, trip still active, banner: "${bg.bannerText}"`
  )

  // ---- (3) tap the banner -> back to Go Mode ----
  await page.click(BANNER)
  await page.waitForFunction(
    (screen) => {
      const s = window.store.getState().otp
      return !s.goMode.ui.backgrounded && s.ui.mobileScreen === screen
    },
    { polling: 200, timeout: 10000 },
    GO_MODE
  )
  console.log('[return] banner tap restored the Go Mode screen')

  // ---- (4) background again and adopt an alternate from the planner ----
  await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const goMode = await import('/lib/actions/go-mode.ts')
    window.store.dispatch(goMode.backgroundGoMode())
  })
  await page.waitForSelector(BANNER, { timeout: 10000 })
  // Different itineraries can share a startTime, so assert the swap by
  // reference: beginGoMode always installs the clicked results-list object.
  await page.evaluate(() => {
    window.__preSwitchItin = window.store.getState().otp.goMode.activeItinerary
  })
  // Expand a DIFFERENT itinerary in the results list, then hit its
  // switch button (the Start button relabeled while a trip is active).
  const clicked = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.option.metro-itin'))
    if (rows.length < 2) return { expanded: false, rows: rows.length }
    rows[1].querySelector('.itin-wrapper')?.click()
    return { expanded: true, rows: rows.length }
  })
  if (!clicked.expanded) {
    throw new Error(`results list not browsable (${clicked.rows} rows)`)
  }
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('button')).some((b) =>
        (b.textContent || '').includes('Switch to this trip')
      ),
    { polling: 300, timeout: 15000 }
  )
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button'))
      .find((b) => (b.textContent || '').includes('Switch to this trip'))
      .click()
  })
  await page.waitForFunction(
    (screen) => {
      const s = window.store.getState().otp
      return (
        s.goMode.isActive &&
        !s.goMode.ui.backgrounded &&
        s.ui.mobileScreen === screen &&
        s.goMode.activeItinerary !== window.__preSwitchItin
      )
    },
    { polling: 300, timeout: 20000 },
    GO_MODE
  )
  console.log(
    '[switch] alternate adopted after confirm; Go Mode foregrounded on the new itinerary'
  )

  // ---- (5) reload while backgrounded -> resumes backgrounded ----
  await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const goMode = await import('/lib/actions/go-mode.ts')
    window.store.dispatch(goMode.backgroundGoMode())
  })
  await page.waitForSelector(BANNER, { timeout: 10000 })
  await page.reload({ timeout: 60000, waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.store, { timeout: 30000 })
  await page.waitForSelector(BANNER, { timeout: 15000 })
  const reloaded = await page.evaluate((sel) => {
    const s = window.store.getState().otp
    return {
      backgrounded: s.goMode.ui.backgrounded,
      bannerText: document.querySelector(sel)?.textContent || '',
      isActive: s.goMode.isActive,
      mobileScreen: s.ui.mobileScreen
    }
  }, BANNER)
  if (
    !reloaded.isActive ||
    !reloaded.backgrounded ||
    reloaded.mobileScreen === GO_MODE
  ) {
    throw new Error(`reload broke backgrounding: ${JSON.stringify(reloaded)}`)
  }
  console.log(
    `[reload] trip resumed backgrounded; banner: "${reloaded.bannerText}"`
  )

  await browser.close()
  console.log(
    '\nPASS: isolated re-route, background + banner round-trip, explicit switch, reload-resume'
  )
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
