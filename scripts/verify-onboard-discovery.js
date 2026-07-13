/* eslint-disable no-console */
/**
 * Onboard-discovery verification: "which bus am I on?" must be answered from
 * the rider's POSITION (live vehicles near them, route shapes under them —
 * the transitnav sidecar's /api/onboard endpoints), not from stop proximity.
 * On the 2026-07-12 ride, discovery ran three times mid-I-35W (freeway BRT,
 * no stops within 250m) and returned zero routes.
 *
 * Asserts, at that exact dead zone:
 *   1. both sidecar endpoints are queried and the Orange Line (1:904) lands
 *      in transitIndex.nearbyRoutes (the boarding prompt's route picker);
 *   2. with the sidecar blocked, discovery still completes via the legacy
 *      stop-radius fallback (fail-open) rather than hanging.
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

// I-35W between 66th and 76th St stations — the 7/12 "no buses found" spot.
const DEAD_ZONE = { lat: 44.876, lon: -93.298 }
const DEST = { lat: 44.816546, lon: -93.30986, name: 'Test destination' }

// Interception is enabled once for the whole session (toggling it while
// requests are in flight races puppeteer's finalizeInterceptions).
const intercept = { block: false, hits: [] }

async function runDiscovery(page, blockSidecar) {
  intercept.block = blockSidecar
  intercept.hits = []
  const sidecarHits = intercept.hits

  const result = await page.evaluate(async (dest) => {
    // eslint-disable-next-line import/no-absolute-path
    const gm = await import('/lib/actions/go-mode.ts')
    // eslint-disable-next-line import/no-absolute-path
    const form = await import('/lib/actions/form.js')
    const store = window.store
    store.dispatch(form.setQueryParam({ to: dest }))
    store.dispatch(gm.endGoMode())
    await new Promise((resolve) => setTimeout(resolve, 300))
    store.dispatch(gm.beginOnboardFlow())
    // Discovery needs a GPS fix + the sidecar (or fallback) round trips.
    const t0 = Date.now()
    while (Date.now() - t0 < 30000) {
      const g = store.getState().otp.goMode
      if (
        g.onboard.status === 'awaiting-selection' ||
        g.onboard.status === 'ready' ||
        g.onboard.status === 'error'
      ) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    const g = store.getState().otp.goMode
    const routes = store.getState().otp.transitIndex?.nearbyRoutes || []
    return {
      nearbyRouteIds: routes.map((r) => r.id),
      nearbyVehicles: (g.vehicleMatch?.nearbyVehicles || []).length,
      status: g.onboard.status
    }
  }, DEST)

  return { ...result, sidecarHits }
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
    latitude: DEAD_ZONE.lat,
    longitude: DEAD_ZONE.lon
  })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    if (req.url().includes('/api/onboard/')) {
      intercept.hits.push(req.url().split('?')[0])
      if (intercept.block) return req.abort()
    }
    req.continue()
  })
  await page.goto(APP, { timeout: 60000, waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.store, { timeout: 30000 })

  // (1) Sidecar reachable: position-based discovery must surface the Orange
  // Line at a point where the 250m stop query historically found nothing.
  const withSidecar = await runDiscovery(page, false)
  console.log(
    `[sidecar] status=${withSidecar.status}, hits=[${[
      ...new Set(withSidecar.sidecarHits)
    ]
      .map((u) => u.split('/').pop())
      .join(', ')}], routes=[${withSidecar.nearbyRouteIds.join(', ')}], ` +
      `${withSidecar.nearbyVehicles} vehicle option(s)`
  )
  if (!withSidecar.sidecarHits.some((u) => u.includes('vehicles-near'))) {
    throw new Error('FAIL: vehicles-near was never queried')
  }
  if (!withSidecar.sidecarHits.some((u) => u.includes('routes-at-point'))) {
    throw new Error('FAIL: routes-at-point was never queried')
  }
  if (!withSidecar.nearbyRouteIds.includes('1:904')) {
    throw new Error(
      'FAIL: Orange Line (1:904) missing from candidates at the 7/12 dead zone'
    )
  }

  // (2) Sidecar blocked: discovery must fail open to the stop-radius path
  // and still complete (widened radius reaches the stations from mid-freeway).
  const blocked = await runDiscovery(page, true)
  console.log(
    `[blocked] status=${blocked.status}, routes=[${blocked.nearbyRouteIds.join(
      ', '
    )}]`
  )
  if (
    blocked.status !== 'awaiting-selection' &&
    blocked.status !== 'ready' &&
    blocked.status !== 'error'
  ) {
    throw new Error('FAIL: discovery hung with the sidecar unreachable')
  }

  await browser.close()
  console.log(
    '\nPASS: discovery answers from the rider position (vehicles + route ' +
      'shapes), Orange Line found mid-freeway, stop fallback fails open.'
  )
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
