/* eslint-disable no-console */
/**
 * Saved-places verification: a custom named place ("Gym") saved on one
 * visit must survive a full reload (localStorage round-trip through the
 * savedPlaces key), be offered in the To-field "My places" dropdown, be
 * listed on the /places manage screen, and disappear everywhere once
 * deleted. Legacy home storage (otp.home) must keep loading alongside.
 */
const path = require('path')

const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const OUT = process.env.OUT_DIR || __dirname
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const GYM = {
  address: '456 Barbell Ave, Minneapolis, MN',
  icon: 'map-marker',
  id: 'place-verify-gym',
  lat: 44.977,
  lon: -93.265,
  name: 'Gym',
  type: 'custom'
}
const LEGACY_HOME = {
  lat: 44.816775,
  lon: -93.31033,
  name: '123 Home St, Bloomington, MN',
  type: 'home'
}

async function main() {
  const browser = await puppeteer.launch({
    // --disable-dev-shm-usage matters: without it Chrome 137's renderer
    // starves on /dev/shm here and CDP calls (Network.enable) hang.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    executablePath: CHROME,
    headless: 'new'
  })
  const page = await browser.newPage()
  // A mobile UA, because the product is the iOS app: coreUtils isMobile()
  // is UA-based, and on DESKTOP the trip-form boot machinery bounces any
  // pathname (e.g. a hard load of /places) back to '/'.
  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  )
  await page.setViewport({ height: 850, width: 393 })
  await page.goto(APP, { timeout: 60000, waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.store, { timeout: 60000 })

  // Fresh rider with a pre-existing legacy home key.
  await page.evaluate((home) => {
    window.localStorage.clear()
    window.localStorage.setItem('otp.home', JSON.stringify(home))
  }, LEGACY_HOME)
  await page.goto(APP, { timeout: 60000, waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.store, { timeout: 60000 })

  // ---- save a custom place through the app pipeline ----
  await page.evaluate(async (gym) => {
    // eslint-disable-next-line import/no-absolute-path
    const user = await import('/lib/actions/user.js')
    window.store.dispatch(user.rememberPlace({ location: gym, type: gym.type }))
  }, GYM)
  const stored = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('otp.savedPlaces') || '[]')
  )
  console.log(
    `[stored] otp.savedPlaces: ${stored.map((p) => p.name).join(' | ')}`
  )
  if (!stored.some((p) => p.id === GYM.id)) {
    throw new Error('custom place not written to otp.savedPlaces')
  }

  // ---- fresh session: reload, the place must come back ----
  await page.goto(APP, { timeout: 60000, waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.store, { timeout: 60000 })
  const recalled = await page.evaluate(() =>
    window.store.getState().user.localUser.savedLocations.map((p) => ({
      address: p.address,
      id: p.id,
      name: p.name,
      type: p.type
    }))
  )
  console.log(
    `[reload] savedLocations: ${recalled
      .map((p) => `${p.type}:${p.name || p.address}`)
      .join(' | ')}`
  )
  if (!recalled.some((p) => p.id === GYM.id && p.name === 'Gym')) {
    throw new Error('custom place lost across reload')
  }
  if (!recalled.some((p) => p.type === 'home' && p.address)) {
    throw new Error('legacy otp.home no longer loads')
  }

  // ---- the To-field dropdown offers the place under "My places" ----
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
    document.body.innerText.includes('Gym')
  )
  await page.screenshot({ path: path.join(OUT, 'saved-places-dropdown.png') })
  console.log(
    `[dropdown] saved place ${
      inMenu ? 'shown' : 'NOT FOUND'
    } -> saved-places-dropdown.png`
  )
  if (!inMenu) throw new Error('saved place not shown in the To-field dropdown')

  // ---- the /places manage screen lists it (hash router: /#/places) ----
  await page.goto(`${APP.replace(/\/$/, '')}/#/places`, {
    timeout: 60000,
    waitUntil: 'domcontentloaded'
  })
  await page.reload({ timeout: 60000, waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => document.body.innerText.includes('Saved places'),
    { timeout: 60000 }
  )
  const listed = await page.evaluate(() => document.body.innerText)
  await page.screenshot({ path: path.join(OUT, 'saved-places-manage.png') })
  if (!listed.includes('Gym')) {
    throw new Error('saved place not listed on /places')
  }
  console.log('[manage] /places lists Gym -> saved-places-manage.png')

  // ---- delete it: gone from state and storage ----
  await page.evaluate(async (gym) => {
    // eslint-disable-next-line import/no-absolute-path
    const user = await import('/lib/actions/user.js')
    window.store.dispatch(user.deleteUserPlace(gym))
  }, GYM)
  const afterDelete = await page.evaluate(() => ({
    savedLocations: window.store
      .getState()
      .user.localUser.savedLocations.map((p) => p.id),
    stored: JSON.parse(window.localStorage.getItem('otp.savedPlaces') || '[]')
  }))
  if (
    afterDelete.stored.some((p) => p.id === GYM.id) ||
    afterDelete.savedLocations.includes(GYM.id)
  ) {
    throw new Error('deleted place still present in state or storage')
  }
  console.log('[delete] place removed from state and otp.savedPlaces')

  await browser.close()
  console.log('\nPASS: saved place round-trips, is offered back, and deletes')
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
