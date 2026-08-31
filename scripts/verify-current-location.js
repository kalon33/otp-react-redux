/* eslint-disable no-console */
/**
 * Current-location origin verification (07-11 ride note): the From field must
 * (1) auto-populate as "(Current Location)" on mobile without any tap,
 * (2) KEEP that label — no reverse-geocoded street name ("Queen Av S…"), and
 * (3) plan each search from the freshest GPS fix, not the coords captured
 *     when the field was set.
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

const P1 = { latitude: 44.816775, longitude: -93.31033 }
// ~500m north — the rider moved between searches
const P2 = { latitude: 44.8213, longitude: -93.31033 }
const TO = { lat: 44.825177, lon: -93.302367, name: 'Bloomington City Hall' }

async function main() {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox'],
    executablePath: CHROME,
    headless: 'new'
  })
  const page = await browser.newPage()
  await page.setUserAgent(IPHONE_UA)
  await page.setViewport({ height: 850, width: 393 })
  await browser
    .defaultBrowserContext()
    .overridePermissions(APP, ['geolocation'])
  await page.setGeolocation({ accuracy: 10, ...P1 })
  await page.goto(APP, { timeout: 60000, waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.store, { timeout: 30000 })

  // (1)+(2) auto-populated, stable label. The old reverse-geocode overwrite
  // landed within a second of the auto-populate — wait it out, then assert.
  await page.waitForFunction(
    () => window.store.getState().otp.currentQuery.from != null,
    { polling: 300, timeout: 30000 }
  )
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const from1 = await page.evaluate(
    () => window.store.getState().otp.currentQuery.from
  )
  console.log(
    `[auto-populate] from = "${from1.name}" (${from1.lat.toFixed(
      6
    )}, ${from1.lon.toFixed(6)}) category=${from1.category}`
  )
  if (from1.category !== 'CURRENT_LOCATION') {
    throw new Error('origin lost its CURRENT_LOCATION category')
  }
  if (!/current location/i.test(from1.name)) {
    throw new Error(`origin label is "${from1.name}", not "(Current Location)"`)
  }
  if (Math.abs(from1.lat - P1.latitude) > 0.0005) {
    throw new Error('origin coords do not match the GPS fix')
  }

  // First search through the real submit path (the search button).
  await page.evaluate(async (to) => {
    // eslint-disable-next-line import/no-absolute-path
    const form = await import('/lib/actions/form.js')
    window.store.dispatch(form.setQueryParam({ to }))
  }, TO)
  // The submit control is BatchSettings' PlanTripButton, id="plan-trip"
  // (lib/components/form/batch-settings.tsx). It lives on the SEARCH_FORM
  // screen, and a fresh mobile load starts on WELCOME_SCREEN — so getting there
  // is part of pressing it.
  //
  // This used to guess: 'button[aria-label="Search"], .search-button,
  // button.search' (none of which exist in this app), then fall back to "the
  // last <button> containing an <svg> wider than 40px" and return true
  // regardless of which button that turned out to be. So it clicked the wrong
  // control, the `if (!(await clickSearch())) throw` guard never fired, and the
  // run died 60 s later in the wait below with nothing pointing at the cause —
  // the identical ~66 s duration on 8/28, 8/29, 8/30 and 8/31.
  const clickSearch = async () => {
    await page.evaluate(async () => {
      // eslint-disable-next-line import/no-absolute-path
      const ui = await import('/lib/actions/ui.js')
      // eslint-disable-next-line import/no-absolute-path
      const { MobileScreens } = await import('/lib/actions/ui-constants.js')
      window.store.dispatch(ui.setMobileScreen(MobileScreens.SEARCH_FORM))
    })
    await page.waitForSelector('#plan-trip', { timeout: 15000 })
    await page.click('#plan-trip')
  }
  await clickSearch()
  await page.waitForFunction(
    () => {
      const searches = window.store.getState().otp.searches || {}
      return Object.values(searches).some((s) => s.pending === 0)
    },
    { polling: 500, timeout: 60000 }
  )
  console.log('[search 1] planned from the initial fix')

  // (3) rider moves ~500m; next search must use the new fix.
  await page.setGeolocation({ accuracy: 10, ...P2 })
  await page.evaluate(async () => {
    // The app polls GPS every 30s (responsive-webapp); poke it now so the
    // test doesn't idle half a minute.
    // eslint-disable-next-line import/no-absolute-path
    const loc = await import('/lib/actions/location.tsx')
    window.store.dispatch(
      loc.getCurrentPosition({ formatMessage: (m) => m.id })
    )
  })
  await page.waitForFunction(
    (lat) => {
      const pos = window.store.getState().otp.location.currentPosition
      return pos?.coords && Math.abs(pos.coords.latitude - lat) < 0.0005
    },
    { polling: 300, timeout: 20000 },
    P2.latitude
  )
  // clickSearch takes the rider back to the search form itself.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await clickSearch()
  await page.waitForFunction(
    (lat) => {
      const from = window.store.getState().otp.currentQuery.from
      return from && Math.abs(from.lat - lat) < 0.0005
    },
    { polling: 300, timeout: 20000 },
    P2.latitude
  )
  const from2 = await page.evaluate(
    () => window.store.getState().otp.currentQuery.from
  )
  console.log(
    `[search 2] from = "${from2.name}" (${from2.lat.toFixed(
      6
    )}, ${from2.lon.toFixed(6)})`
  )
  if (!/current location/i.test(from2.name)) {
    throw new Error('label changed after coord refresh')
  }
  const movedMeters = Math.abs(from2.lat - from1.lat) * 111000
  console.log(
    `[moved] origin advanced ~${Math.round(movedMeters)}m with the rider`
  )
  if (movedMeters < 300) {
    throw new Error('second search did not use the fresh GPS fix')
  }

  await browser.close()
  console.log(
    '\nPASS: origin auto-populates, label stays "(Current Location)", coords follow the rider'
  )
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
