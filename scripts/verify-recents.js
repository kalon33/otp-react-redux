/* eslint-disable no-console */
/**
 * Recent-destinations verification: with persistence.trackRecentByDefault, a
 * successful search must store the destination in localStorage recents (but
 * never the "(Current Location)" origin), and after a full reload — a fresh
 * session, like the rider's 10:41 app relaunch — the destination must be
 * offered back in the To-field dropdown instead of needing a retype.
 */
const path = require('path')

const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const OUT = process.env.OUT_DIR || __dirname
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = {
  category: 'CURRENT_LOCATION',
  lat: 44.816775,
  lon: -93.31033,
  name: '(Current Location)'
}
const TO = {
  lat: 44.825177,
  lon: -93.302367,
  name: 'Bloomington City Hall'
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
  await page.goto(APP, { timeout: 60000, waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.store, { timeout: 30000 })

  // Fresh rider: wipe stored state and reload so the store re-initializes.
  await page.evaluate(() => window.localStorage.clear())
  await page.goto(APP, { timeout: 60000, waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.store, { timeout: 30000 })

  const optedIn = await page.evaluate(
    () => window.store.getState().user.localUser.storeTripHistory
  )
  if (!optedIn) {
    throw new Error(
      'storeTripHistory not defaulted on — trackRecentByDefault missing from config?'
    )
  }
  console.log('[setup] storeTripHistory defaults ON (empty localStorage)')

  // ---- search Current Location -> City Hall through the app pipeline ----
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

  const stored = await page.evaluate(() => ({
    recent: JSON.parse(window.localStorage.getItem('otp.recent') || '[]'),
    recentSearches: JSON.parse(
      window.localStorage.getItem('otp.recentSearches') || '[]'
    )
  }))
  console.log(
    `[stored] recents: ${stored.recent
      .map((p) => p.name || p.address)
      .join(' | ')}`
  )
  const hasDest = stored.recent.some((p) =>
    (p.name || p.address || '').includes('Bloomington City Hall')
  )
  const hasCurrentLoc = stored.recent.some(
    (p) =>
      p.category === 'CURRENT_LOCATION' ||
      (p.name || p.address || '').includes('Current Location')
  )
  if (!hasDest) throw new Error('destination not stored in recents')
  if (hasCurrentLoc) throw new Error('current-location origin polluted recents')
  if (!stored.recentSearches.length) throw new Error('search not remembered')

  // ---- fresh session: reload, destination must be offered back ----
  await page.goto(APP, { timeout: 60000, waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.store, { timeout: 30000 })
  const recalled = await page.evaluate(() => {
    const u = window.store.getState().user.localUser
    return {
      recentPlaces: (u.recentPlaces || []).map((p) => p.name || p.address),
      storeTripHistory: u.storeTripHistory
    }
  })
  console.log(
    `[reload] recentPlaces: ${recalled.recentPlaces.join(' | ')} ` +
      `(tracking ${recalled.storeTripHistory ? 'on' : 'off'})`
  )
  if (
    !recalled.recentPlaces.some((n) =>
      (n || '').includes('Bloomington City Hall')
    )
  ) {
    throw new Error('recent destination lost across reload')
  }

  // ---- visual: the To-field dropdown lists the recent place ----
  await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const ui = await import('/lib/actions/ui.js')
    // eslint-disable-next-line import/no-absolute-path
    const { MobileScreens } = await import('/lib/actions/ui-constants.js')
    window.store.dispatch(ui.setMobileScreen(MobileScreens.SET_TO_LOCATION))
  })
  await page.waitForSelector('input', { timeout: 15000 })
  await page.focus('input')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const inMenu = await page.evaluate(() =>
    document.body.innerText.includes('Bloomington City Hall')
  )
  await page.screenshot({ path: path.join(OUT, 'recent-destinations.png') })
  console.log(
    `[dropdown] recent destination ${
      inMenu ? 'shown' : 'NOT FOUND'
    } -> recent-destinations.png`
  )

  await browser.close()
  if (!inMenu) throw new Error('recent destination not shown in the dropdown')
  console.log('\nPASS: destination remembered, origin excluded, offered back')
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
