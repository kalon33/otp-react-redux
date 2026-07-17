/* eslint-disable no-console */
/**
 * Endpoint-drag verification (7/13 ride note): brushing the destination pin
 * used to re-geocode it, clear the active search, and — 12s into the 7/13
 * trip — tear down live Go Mode guidance.
 *
 * Drives the real app at :9967 with real mouse drags on the maplibre marker:
 *  1. a small (sub-30m) accidental drag is ignored — search and destination
 *     survive untouched
 *  2. while a Go Mode trip is live, ANY drag is ignored — the trip and the
 *     search survive
 *  3. after the trip ends, a deliberate long drag still moves the pin and
 *     replans (normal planner behavior preserved)
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9778, lon: -93.2707, name: 'Downtown Minneapolis' }

const getQueryTo = (page) =>
  page.evaluate(() => {
    const { currentQuery } = window.store.getState().otp
    return {
      lat: currentQuery.to?.lat,
      lon: currentQuery.to?.lon,
      name: currentQuery.to?.name
    }
  })

const getMarkerCenter = async (page, title) => {
  const box = await page.evaluate((t) => {
    const span = document.querySelector(`span[title="${t}"]`)
    const marker = span?.closest('.maplibregl-marker')
    if (!marker) return null
    const b = marker.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }, title)
  if (!box) throw new Error(`marker "${title}" not found on screen`)
  return box
}

const dragMarker = async (page, from, dx, dy) => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  await page.mouse.up()
  // give the reverse geocode + store updates time to land (or not)
  await new Promise((resolve) => setTimeout(resolve, 2500))
}

async function main() {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox'],
    executablePath: CHROME,
    headless: 'new'
  })
  const page = await browser.newPage()
  // Desktop layout: map always visible; the drag guard is screen-independent
  // (it keys on goMode.isActive, not the mobile screen).
  await page.setViewport({ height: 900, width: 1400 })
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

  // ---- plan a trip ----
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
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // ---- zoom in so a few pixels of drag is well under the 30m threshold ----
  let dest = await getMarkerCenter(page, TO.name)
  for (let i = 0; i < 5; i++) {
    await page.mouse.click(dest.x, dest.y - 80, { clickCount: 2 })
    await new Promise((resolve) => setTimeout(resolve, 900))
    dest = await getMarkerCenter(page, TO.name)
  }

  const baselineTo = await getQueryTo(page)
  const baselineSearchId = await page.evaluate(
    () => window.store.getState().otp.activeSearchId
  )
  console.log(`[setup] planned to "${baselineTo.name}", zoomed in on the pin`)

  // ---- 1. small accidental drag: ignored ----
  dest = await getMarkerCenter(page, TO.name)
  await dragMarker(page, dest, 6, 6)
  const afterSmall = await getQueryTo(page)
  const searchAfterSmall = await page.evaluate(() => {
    const s = window.store.getState().otp
    return {
      activeSearchId: s.activeSearchId,
      hasSearch: !!s.searches[s.activeSearchId]
    }
  })
  if (
    afterSmall.lat !== baselineTo.lat ||
    afterSmall.lon !== baselineTo.lon ||
    afterSmall.name !== baselineTo.name
  ) {
    throw new Error('small drag changed the destination')
  }
  if (
    !searchAfterSmall.hasSearch ||
    searchAfterSmall.activeSearchId !== baselineSearchId
  ) {
    throw new Error('small drag cleared the active search')
  }
  console.log('[1] small drag ignored — destination and search intact')

  // ---- 2. live Go Mode trip: ANY drag ignored ----
  await page.evaluate(() => {
    const searches = window.store.getState().otp.searches || {}
    const itin = Object.values(searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])[0]
    return window.__beginGoMode(itin)
  })
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.isActive,
    { polling: 300, timeout: 20000 }
  )
  const tripStart = await page.evaluate(() =>
    Number(window.store.getState().otp.goMode.activeItinerary.startTime)
  )
  dest = await getMarkerCenter(page, TO.name)
  await dragMarker(page, dest, 180, 120)
  const goModeAfter = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    return {
      isActive: g.isActive,
      startTime: g.activeItinerary ? Number(g.activeItinerary.startTime) : null
    }
  })
  const afterGoModeDrag = await getQueryTo(page)
  if (!goModeAfter.isActive || goModeAfter.startTime !== tripStart) {
    throw new Error('drag during Go Mode disturbed the live trip')
  }
  if (
    afterGoModeDrag.lat !== baselineTo.lat ||
    afterGoModeDrag.lon !== baselineTo.lon
  ) {
    throw new Error('drag during Go Mode moved the destination')
  }
  console.log('[2] long drag during live Go Mode ignored — trip untouched')

  // ---- 3. trip over: a deliberate long drag still replans ----
  await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const goModeActions = await import('/lib/actions/go-mode.ts')
    window.store.dispatch(goModeActions.endGoMode())
  })
  await page.waitForFunction(
    () => !window.store.getState().otp.goMode.isActive,
    { polling: 300, timeout: 10000 }
  )
  await page.keyboard.press('Escape')
  await new Promise((resolve) => setTimeout(resolve, 500))
  dest = await getMarkerCenter(page, TO.name)
  console.log(
    `[3] marker at (${Math.round(dest.x)}, ${Math.round(
      dest.y
    )}); dragging toward viewport center`
  )
  // Drag toward the viewport center so the pin can't leave the map or slip
  // under the results panel mid-drag.
  const toCenter = {
    dx: Math.sign(700 - dest.x) * 180,
    dy: Math.sign(450 - dest.y) * 120
  }
  await dragMarker(page, dest, toCenter.dx, toCenter.dy)
  try {
    await page.waitForFunction(
      (base) => {
        const to = window.store.getState().otp.currentQuery.to
        return to && (to.lat !== base.lat || to.lon !== base.lon)
      },
      { polling: 300, timeout: 15000 },
      baselineTo
    )
  } catch (err) {
    await page.screenshot({ path: 'scripts/endpoint-drag-step3-fail.png' })
    const dump = await page.evaluate(() => {
      const s = window.store.getState().otp
      return {
        goModeActive: s.goMode.isActive,
        popupOpen: !!document.querySelector('.maplibregl-popup'),
        to: s.currentQuery.to?.name
      }
    })
    console.log('[3-debug]', JSON.stringify(dump))
    throw err
  }
  const afterBig = await getQueryTo(page)
  console.log(
    `[3] deliberate drag replanned to "${afterBig.name}" — normal behavior preserved`
  )

  await page.screenshot({ path: 'scripts/endpoint-drag.png' })
  await browser.close()
  console.log(
    '\nPASS: accidental and mid-trip drags are inert; deliberate drags still move the pin'
  )
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
