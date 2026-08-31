/* eslint-disable no-console */
/**
 * The app menu must be reachable FROM Go Mode:
 * (1) the hamburger renders on the live tracking screen (which is a fixed,
 *     full-screen layer over the app's own nav bar) and is actually visible —
 *     its bars are white for the dark nav bar, invisible on this white screen;
 * (2) tapping it opens the sliding pane ABOVE that layer (z-index), not behind
 *     it, and the pane's items are hit-testable;
 * (3) choosing a destination backgrounds the running trip instead of leaving
 *     the rider on a screen where nothing happens: the trip stays active, the
 *     ReturnToTripBanner appears, and the app navigates;
 * (4) the banner brings the rider back to Go Mode;
 * (5) the menu is also present on the Go Mode screens that show a back arrow
 *     (the arrow used to REPLACE the menu).
 *
 * Harness: same as verify-background-explore — drive the real app at :9967
 * with the dev hooks; the plan hits the real OTP.
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9778, lon: -93.2707, name: 'Downtown Minneapolis' }

const GO_MODE = 10
const BANNER = '.return-to-trip-banner'
const MENU_ICON = '.app-menu-icon'
const SHOTS = `${__dirname}`

// The mobile/desktop split is UA-sniffed, not viewport-based
// (responsive-webapp -> isMobile() from @opentripplanner/core-utils, which
// regex-tests navigator.userAgent). A phone-sized viewport alone still renders
// the DESKTOP layout, and this whole script asserts on mobile constructs
// (mobileScreen, .mobile-header-text, .mobile-back). Copied from
// verify-current-location.js.
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

// The Go Mode screen is a fixed, full-screen layer (FullScreenWrapper,
// z-index 1000) that carries its OWN copy of the app menu — that is the thing
// under test, and the thing 06c24415 darkened. The desktop layout ALSO renders
// DesktopNav's menu, earlier in the DOM, sitting on a dark navbar-inverse where
// white bars are correct. A bare document.querySelector('.app-menu-icon')
// returns that one, so the script spent two nights reporting a shipped, working
// feature as white-on-white. Scope every lookup to the Go Mode layer so it can
// never grab a background nav bar again, whatever layout renders.
const ICON_FINDER = `window.__goModeMenuIcon = function () {
  const layer = Array.from(document.querySelectorAll('div')).find(function (d) {
    const cs = getComputedStyle(d)
    return (
      cs.position === 'fixed' &&
      cs.zIndex === '1000' &&
      !!d.querySelector('${MENU_ICON}')
    )
  })
  return (layer || document).querySelector('${MENU_ICON}')
}`

async function main() {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox'],
    executablePath: CHROME,
    headless: 'new'
  })
  const page = await browser.newPage()
  await page.setUserAgent(IPHONE_UA)
  await page.setViewport({ height: 850, width: 393 })
  await page.evaluateOnNewDocument(ICON_FINDER)
  await browser
    .defaultBrowserContext()
    .overridePermissions(APP, ['geolocation'])
  await page.setGeolocation({
    accuracy: 10,
    latitude: FROM.lat,
    longitude: FROM.lon
  })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  page.on('dialog', (d) => d.accept())
  await page.goto(APP, { timeout: 60000, waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.store, { timeout: 30000 })

  // ---- plan a trip and start tracking it ----
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
  await page.evaluate(() => {
    const otp = window.store.getState().otp
    window.__menuItinerary = Object.values(otp.searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
      .filter((it) => (it.legs || []).some((l) => l.transitLeg))
      .sort((a, b) => a.startTime - b.startTime)[0]
  })
  await page.evaluate(() => window.__beginGoMode(window.__menuItinerary))
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
  console.log('[setup] tracking a real itinerary on the Go Mode screen')

  // ---- (1) the hamburger is there, and can be seen ----
  await page.waitForFunction(() => !!window.__goModeMenuIcon(), {
    polling: 200,
    timeout: 10000
  })
  const icon = await page.evaluate((sel) => {
    const el = window.__goModeMenuIcon()
    const box = el.getBoundingClientRect()
    const line = el.querySelector('.menu-line')
    const contrastOk = (color) => {
      const [r, g, b] = (color.match(/\d+/g) || []).map(Number)
      // Anything near-white is the dark-navbar styling bleeding through onto
      // the Go Mode screen's white background.
      return r + g + b < 600
    }
    return {
      barColor: getComputedStyle(line).borderBottomColor,
      contrastOk: contrastOk(getComputedStyle(line).borderBottomColor),
      // The rider taps the top-left corner: whatever is painted there must be
      // the button itself, not something covering it.
      hitsButton:
        document
          .elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          ?.closest(sel) !== null,
      left: Math.round(box.left),
      onScreen: box.width > 0 && box.height > 0 && box.top < 120,
      top: Math.round(box.top)
    }
  }, MENU_ICON)
  console.log(
    `[icon] at ${icon.left},${icon.top} color=${icon.barColor} ` +
      `hit-testable=${icon.hitsButton}`
  )
  if (!icon.onScreen) throw new Error('menu icon is not on the Go Mode screen')
  if (!icon.contrastOk) {
    throw new Error(`menu icon is white-on-white (${icon.barColor})`)
  }
  if (!icon.hitsButton) throw new Error('menu icon is covered by the trip UI')
  await page.screenshot({ path: `${SHOTS}/go-mode-menu-icon.png` })

  // ---- (2) the pane opens above the full-screen Go Mode layer ----
  await page.evaluate(() => window.__goModeMenuIcon().click())
  await page.waitForSelector('#app-menu', { timeout: 10000 })
  // The pane slides in over 200ms; measure it where it comes to rest.
  await new Promise((resolve) => setTimeout(resolve, 800))
  const pane = await page.evaluate(() => {
    // AppMenuItem's own className prop overwrites its "navItem" class, so the
    // links are only reliably addressable as the pane's a/button elements.
    const items = Array.from(
      document.querySelectorAll('#app-menu a, #app-menu button')
    )
    const item = items.find((el) => (el.textContent || '').trim().length > 0)
    const box = item.getBoundingClientRect()
    return {
      items: items.length,
      itemText: item.textContent.trim(),
      labels: items.map((el) => (el.textContent || '').trim()).join(' | '),
      // The Go Mode screen is position:fixed with z-index 1000; if the pane
      // lost that stacking fight the tap would land on the trip screen.
      onTop:
        document
          .elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          ?.closest('#app-menu') !== null
    }
  })
  console.log(`[pane] ${pane.items} items on top=${pane.onTop}: ${pane.labels}`)
  if (!pane.items) throw new Error('menu opened empty')
  if (!pane.onTop)
    throw new Error('menu pane rendered behind the Go Mode screen')
  await page.screenshot({ path: `${SHOTS}/go-mode-menu-open.png` })

  // ---- (3) choosing a destination backgrounds the trip ----
  const target = 'Routes'
  await page.evaluate((label) => {
    Array.from(document.querySelectorAll('#app-menu a, #app-menu button'))
      .find((el) => (el.textContent || '').trim() === label)
      .click()
  }, target)
  await page.waitForSelector(BANNER, { timeout: 10000 })
  const after = await page.evaluate((sel) => {
    const s = window.store.getState().otp
    return {
      backgrounded: s.goMode.ui.backgrounded,
      bannerText: document.querySelector(sel)?.textContent || '',
      isActive: s.goMode.isActive,
      mobileScreen: s.ui.mobileScreen,
      paneClosed: !document.querySelector('#app-menu')
    }
  }, BANNER)
  console.log(
    `[navigate] screen=${after.mobileScreen} trip active=${after.isActive} ` +
      `backgrounded=${after.backgrounded} banner="${after.bannerText}"`
  )
  if (!after.isActive) throw new Error('menu navigation ended the trip')
  if (!after.backgrounded || after.mobileScreen === GO_MODE) {
    throw new Error(
      'menu navigation left the rider stuck on the Go Mode screen'
    )
  }
  if (!after.bannerText) throw new Error('no way back to the running trip')
  await page.screenshot({ path: `${SHOTS}/go-mode-menu-navigated.png` })

  // ---- (4) the banner is the way back — on screen, not just in state ----
  await page.click(BANNER)
  await page.waitForFunction(
    (screen) => {
      const s = window.store.getState().otp
      return !s.goMode.ui.backgrounded && s.ui.mobileScreen === screen
    },
    { polling: 200, timeout: 10000 },
    GO_MODE
  )
  // The mobile shell renders a route/nearby/stop viewer AHEAD of the mobile
  // screen, so "back in Go Mode" by state can still be the route viewer on
  // screen.
  const returned = await page.evaluate(() => ({
    heading: document.querySelector('.mobile-header-text')?.textContent || '',
    mainPanelContent: window.store.getState().otp.ui.mainPanelContent,
    tripScreen: !!document.querySelector(
      'button[aria-label="Open trip overview"]'
    )
  }))
  console.log(
    `[return] banner tap -> heading "${returned.heading}", ` +
      `trip screen rendered=${returned.tripScreen}`
  )
  if (!returned.tripScreen || returned.mainPanelContent !== null) {
    throw new Error(
      `banner tap left the ${returned.heading || 'previous'} view on screen`
    )
  }

  // ---- (5) back-arrow screens keep the menu too ----
  await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const goMode = await import('/lib/actions/go-mode.ts')
    window.store.dispatch(goMode.beginOnboardFlow())
  })
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.onboard.status !== 'idle',
    { polling: 200, timeout: 15000 }
  )
  await page.waitForSelector('.mobile-back', { timeout: 10000 })
  const withBack = await page.evaluate(() => {
    const menuIcon = window.__goModeMenuIcon()
    return {
      back: !!document.querySelector('.mobile-back'),
      menu: !!menuIcon,
      // Both live in the navbar brand: the arrow must not have pushed the
      // menu off the strip.
      sameBar: !!menuIcon?.closest('.navbar-brand'),
      status: window.store.getState().otp.goMode.onboard.status
    }
  })
  console.log(
    `[onboard] status=${withBack.status} back arrow=${withBack.back} ` +
      `menu=${withBack.menu} in the same bar=${withBack.sameBar}`
  )
  if (!withBack.back || !withBack.menu || !withBack.sameBar) {
    throw new Error('the back arrow still replaces the app menu')
  }
  await page.screenshot({ path: `${SHOTS}/go-mode-menu-with-back.png` })

  await browser.close()
  console.log(
    '\nPASS: the app menu is reachable, visible and on top in Go Mode, and' +
      ' using it backgrounds the trip instead of stranding the rider'
  )
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
