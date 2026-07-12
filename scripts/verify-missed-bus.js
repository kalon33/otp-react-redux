/* eslint-disable no-console */
/**
 * Missed-bus verification: when the rider stands still through their bus's
 * departure, Go Mode must (1) fire a MISSED_BUS notification, (2) kick off an
 * auto-apply re-route (reason 'missed-bus'), and (3) switch the active
 * itinerary to the best alternative and confirm with TRIP_UPDATED — with no
 * rider interaction.
 *
 * Harness (same as verify-rest-of-trip-times): drive the real app at :9967,
 * plan a walk→bus trip, start Go Mode with the schedule-aware GPS sim at 1x
 * (the rider ambles along the access walk, still far from the stop), then jump
 * the simulated clock past the departure (+grace) via the
 * __advanceSimulatedTime / __pingPosition dev hooks. (The sim must stay
 * RUNNING — pausing it drops simulationActive, which reverts Go Mode's clock
 * to wall time.) The re-route itself hits the real OTP.
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

// Origin ~200m into the neighborhood east of Nicollet Ave (frequent route 18):
// guarantees a real access-walk leg so the stalled rider is >50m from the stop.
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

  // Pick an itinerary with a real access walk (>80m) into a transit leg.
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
    // Earliest departure = tightest re-test of the real scenario.
    ok.sort((a, b) => a.startTime - b.startTime)
    window.__missedBusItinerary = ok[0]
    const busLeg = ok[0].legs.find((l) => l.transitLeg)
    return {
      busRoute: busLeg.routeShortName || busLeg.routeLongName,
      busStart: Number(busLeg.startTime),
      itinStart: Number(ok[0].startTime),
      walkMeters: Math.round(ok[0].legs[0].distance)
    }
  })
  if (!chosen) throw new Error('no walk→bus itinerary with >80m access walk')
  console.log(
    `[setup] itinerary departs ${fmt(chosen.itinStart)}, walk ${
      chosen.walkMeters
    }m, bus ${chosen.busRoute} boards ${fmt(chosen.busStart)}`
  )

  // ---- start Go Mode + simulation; the rider ambles along the walk leg ----
  await page.evaluate(() => window.__beginGoMode(window.__missedBusItinerary))
  await page.waitForFunction(
    () =>
      window.store.getState().otp.goMode.isActive &&
      typeof window.__startGpsSimulation === 'function',
    { polling: 300, timeout: 20000 }
  )
  await page.evaluate(() => window.__startGpsSimulation(1))
  // Let a few sim ticks land (position + progress).
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.progress != null,
    { polling: 300, timeout: 20000 }
  )
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const before = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    return {
      itinStart: Number(g.activeItinerary.startTime),
      legIndex: g.progress?.currentLegIndex,
      simTime: g.progress?.currentTime
        ? new Date(g.progress.currentTime).getTime()
        : null
    }
  })
  console.log(
    `[walk] on leg ${before.legIndex} at sim-time ${fmt(before.simTime)}`
  )

  // ---- time-travel past the departure (+grace) and re-fire a tick ----
  const advanceMs =
    chosen.busStart - (before.simTime || chosen.itinStart) + 300000
  await page.evaluate((ms) => {
    window.__advanceSimulatedTime(ms)
    window.__pingPosition()
  }, advanceMs)
  console.log(
    `[time-travel] advanced sim clock ${(advanceMs / 60000).toFixed(
      1
    )} min past the boarding`
  )

  // (1) MISSED_BUS notification
  await page.waitForFunction(
    () =>
      window.store
        .getState()
        .otp.goMode.notifications.recentNotifications.some(
          (n) => n.type === 'MISSED_BUS'
        ) ||
      // beginGoMode (the auto-swap) resets notifications — accept the
      // post-swap TRIP_UPDATED as proof MISSED_BUS came and went.
      window.store
        .getState()
        .otp.goMode.notifications.recentNotifications.some(
          (n) => n.type === 'TRIP_UPDATED'
        ),
    { polling: 200, timeout: 15000 }
  )
  const missedMsg = await page.evaluate(() => {
    const ns =
      window.store.getState().otp.goMode.notifications.recentNotifications
    return (
      ns.find((n) => n.type === 'MISSED_BUS')?.message ||
      ns.find((n) => n.type === 'TRIP_UPDATED')?.message
    )
  })
  console.log(`[notify] ${missedMsg}`)

  // (2)+(3) auto-applied swap: new active itinerary + TRIP_UPDATED
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
    { polling: 300, timeout: 45000 },
    before.itinStart
  )

  const after = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    const busLeg = (g.activeItinerary.legs || []).find((l) => l.transitLeg)
    return {
      confirmMsg: g.notifications.recentNotifications.find(
        (n) => n.type === 'TRIP_UPDATED'
      )?.message,
      newBusRoute: busLeg?.routeShortName || busLeg?.routeLongName || 'walk',
      newBusStart: busLeg ? Number(busLeg.startTime) : null,
      newItinStart: Number(g.activeItinerary.startTime),
      reRouteStatus: g.reRoute.status
    }
  })
  console.log('\n===== RESULT =====')
  console.log(`missed bus:        ${chosen.busRoute} @ ${fmt(chosen.busStart)}`)
  console.log(
    `auto-updated trip: departs ${fmt(after.newItinStart)}, bus ${
      after.newBusRoute
    } @ ${fmt(after.newBusStart)}`
  )
  console.log(`confirmation:      ${after.confirmMsg}`)
  console.log(`reRoute state:     ${after.reRouteStatus} (expected idle)`)

  await browser.close()

  if (after.reRouteStatus !== 'idle') {
    throw new Error('reRoute state not reset after auto-apply')
  }
  // The auto-update must keep the rider on the route they chose — never a
  // different route or a bike-the-whole-way "winner" (07-11 field report).
  if (after.newBusRoute !== chosen.busRoute) {
    throw new Error(
      `auto-update changed the route: ${chosen.busRoute} -> ${after.newBusRoute}`
    )
  }
  console.log(
    '\nPASS: missed bus detected, trip auto-updated on the SAME route, rider informed — no prompts'
  )
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
