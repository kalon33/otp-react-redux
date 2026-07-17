/* eslint-disable no-console */
/**
 * Stuck-reroute recovery verification (7/13 ride failure): a reroute whose
 * plan fetch was killed by a WebView suspension used to pin reRoute.status at
 * 'searching' forever, silently blocking every missed-bus auto-update — the
 * rider got "Missed the bus — updating your trip" every 30 minutes while the
 * trip never changed.
 *
 * This script reproduces the EXACT zombie state, then proves recovery:
 *  1. plan a walk→bus trip, start Go Mode + GPS sim (verify-missed-bus harness)
 *  2. wedge a reroute: dispatch START_REROUTE with no fetch behind it
 *  3. time-travel past the departure — MISSED_BUS fires, but the swap is
 *     blocked by the wedged search (the 7/13 state, notification consumed)
 *  4. keep ticking: within ~90s wall clock the stuck-search watchdog clears
 *     it, and the dedup-decoupled retry applies the same-route next departure
 *     WITHOUT waiting 30 minutes for the notification to re-fire.
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9778, lon: -93.2707, name: 'Downtown Minneapolis' }

const fmt = (ms) =>
  ms == null
    ? 'n/a'
    : new Date(ms).toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: 'America/Chicago'
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

  // ---- plan a walk→bus trip through the app's own pipeline ----
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
  const chosen = await page.evaluate(() => {
    const searches = window.store.getState().otp.searches || {}
    const itins = Object.values(searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
    const ok = itins.filter((it) => {
      const legs = it.legs || []
      const firstTransit = legs.findIndex((l) => l.transitLeg)
      return (
        firstTransit > 0 &&
        legs[0].mode === 'WALK' &&
        legs.slice(0, firstTransit).every((l) => !l.transitLeg) &&
        legs[0].distance > 80
      )
    })
    if (!ok.length) return null
    ok.sort((a, b) => a.startTime - b.startTime)
    window.__stuckTestItinerary = ok[0]
    const busLeg = ok[0].legs.find((l) => l.transitLeg)
    return {
      busRoute: busLeg.routeShortName || busLeg.routeLongName,
      busStart: Number(busLeg.startTime),
      itinStart: Number(ok[0].startTime)
    }
  })
  if (!chosen) throw new Error('no walk→bus itinerary with >80m access walk')
  console.log(
    `[setup] bus ${chosen.busRoute} boards ${fmt(
      chosen.busStart
    )}, trip departs ${fmt(chosen.itinStart)}`
  )

  // ---- start Go Mode + sim ----
  await page.evaluate(() => window.__beginGoMode(window.__stuckTestItinerary))
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

  // ---- wedge a reroute exactly like a suspension-killed fetch ----
  await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const goModeActions = await import('/lib/actions/go-mode.ts')
    window.store.dispatch(
      goModeActions.startReroute({
        searchId: 'wedged-by-suspension',
        startedAtMs: Date.now()
      })
    )
  })
  const wedged = await page.evaluate(
    () => window.store.getState().otp.goMode.reRoute.status
  )
  if (wedged !== 'searching') throw new Error('failed to wedge the reroute')
  console.log('[wedge] reRoute stuck at "searching" with no fetch behind it')

  // ---- time-travel past the departure: the 7/13 zombie state ----
  const simTime = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    return g.progress?.currentTime
      ? new Date(g.progress.currentTime).getTime()
      : null
  })
  const advanceMs = chosen.busStart - (simTime || chosen.itinStart) + 300000
  await page.evaluate((ms) => {
    window.__advanceSimulatedTime(ms)
    window.__pingPosition()
  }, advanceMs)
  console.log(
    `[time-travel] sim clock ${(advanceMs / 60000).toFixed(
      1
    )} min past boarding`
  )

  // MISSED_BUS must fire...
  await page.waitForFunction(
    () =>
      window.store
        .getState()
        .otp.goMode.notifications.recentNotifications.some(
          (n) => n.type === 'MISSED_BUS'
        ),
    { polling: 300, timeout: 15000 }
  )
  // ...but the swap is blocked by the wedged search (pre-fix this was forever).
  const blocked = await page.evaluate((origStart) => {
    const g = window.store.getState().otp.goMode
    return {
      sameTrip: Number(g.activeItinerary.startTime) === origStart,
      status: g.reRoute.status
    }
  }, chosen.itinStart)
  console.log(
    `[zombie] MISSED_BUS fired; reRoute=${blocked.status}; trip unchanged=${blocked.sameTrip}`
  )

  // ---- recovery: watchdog (90s) clears the wedge, retry applies the swap ----
  const t0 = Date.now()
  const tick = setInterval(
    () => page.evaluate(() => window.__pingPosition()).catch(() => undefined),
    5000
  )
  try {
    await page.waitForFunction(
      (origStart) => {
        const g = window.store.getState().otp.goMode
        return (
          g.activeItinerary &&
          Number(g.activeItinerary.startTime) !== origStart &&
          g.notifications.recentNotifications.some(
            (n) => n.type === 'TRIP_UPDATED'
          )
        )
      },
      { polling: 500, timeout: 240000 },
      chosen.itinStart
    )
  } finally {
    clearInterval(tick)
  }
  const recoverySec = ((Date.now() - t0) / 1000).toFixed(0)

  const after = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    const busLeg = (g.activeItinerary.legs || []).find((l) => l.transitLeg)
    return {
      confirmMsg: g.notifications.recentNotifications.find(
        (n) => n.type === 'TRIP_UPDATED'
      )?.message,
      newBusRoute: busLeg?.routeShortName || busLeg?.routeLongName || 'walk',
      reRouteStatus: g.reRoute.status
    }
  })
  console.log('\n===== RESULT =====')
  console.log(`recovered in:  ${recoverySec}s wall clock (watchdog is 90s)`)
  console.log(`confirmation:  ${after.confirmMsg}`)
  console.log(`reRoute state: ${after.reRouteStatus} (expected idle)`)

  await browser.close()

  if (after.reRouteStatus !== 'idle') {
    throw new Error('reRoute state not reset after recovery')
  }
  if (after.newBusRoute !== chosen.busRoute) {
    throw new Error(
      `recovery changed the route: ${chosen.busRoute} -> ${after.newBusRoute}`
    )
  }
  if (Number(recoverySec) > 200) {
    throw new Error('recovery took longer than watchdog + retry should allow')
  }
  console.log(
    '\nPASS: wedged reroute cleared by watchdog, trip auto-updated on the SAME route without waiting for the 30-min notification re-fire'
  )
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
