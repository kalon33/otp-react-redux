/* eslint-disable no-console */
/**
 * Leg-transition verification: a rider waiting at the boarding stop sits at
 * ~100% of the access leg for as long as the bus takes to show up. The route
 * match is recomputed from raw GPS every tick and keeps pointing at the leg
 * they're standing on, so "should I transition?" stays true the whole time.
 *
 * The transition is side-effectful — it restarts the position watcher, restarts
 * vehicle tracking, and clears the anchored departure — so it must fire ONCE
 * per leg, not once per GPS tick. (Observed on the 2026-07-12 trip: 56
 * TRANSITION_LEG dispatches in 50s while standing at I-35W & 46th St Station.)
 *
 * Harness: drive the real app at :9967, plan a walk→bus trip, start Go Mode,
 * then invoke the handlePositionUpdate thunk directly with a fixed position at
 * the end of the access leg — calling it with our own dispatch so every action
 * it emits is counted while still hitting the real store.
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9778, lon: -93.2707, name: 'Downtown Minneapolis' }

const TICKS = 15

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

  // A walk→bus itinerary: leg 0 is the access walk the rider finishes early.
  const chosen = await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const pm = await import('/lib/util/go-mode/position-matching.js')
    const searches = window.store.getState().otp.searches || {}
    const itins = Object.values(searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
    const ok = itins.filter((it) => {
      const legs = it.legs || []
      return legs[0]?.mode === 'WALK' && legs[1]?.transitLeg
    })
    if (!ok.length) return null
    ok.sort((a, b) => a.startTime - b.startTime)
    window.__itin = ok[0]
    const busLeg = ok[0].legs[1]

    // Stand on the access leg's own polyline, a few metres short of the stop:
    // that's the rider waiting to board, and it is what keeps the route match
    // pinned to leg 0 at >=98% (the condition seen on the real trip). Sitting
    // exactly on the stop can instead match the transit leg at 0%.
    const poly = pm.decodeLegGeometry(ok[0].legs[0])
    const cum = pm.calculateCumulativeDistances(poly)
    const target = cum[cum.length - 1] * 0.99
    let i = cum.findIndex((d) => d >= target)
    if (i < 1) i = poly.length - 1
    const [lat, lon] = poly[i]
    return {
      busRoute: busLeg.routeShortName || busLeg.routeLongName,
      stop: busLeg.from?.name,
      waitAt: { lat, lon }
    }
  })
  if (!chosen) throw new Error('no walk→bus itinerary found')
  console.log(
    `[setup] walk to ${chosen.stop}, board ${chosen.busRoute}; rider will wait at the stop`
  )

  // Pin the real position watcher to the same spot, so the live GPS ticks agree
  // with the synthetic ones instead of yanking the match back to the origin.
  await page.setGeolocation({
    accuracy: 10,
    latitude: chosen.waitAt.lat,
    longitude: chosen.waitAt.lon
  })

  await page.evaluate(() => window.__beginGoMode(window.__itin))
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.isActive,
    { polling: 300, timeout: 20000 }
  )

  // Rider arrives at the stop and stands still for TICKS GPS updates.
  const result = await page.evaluate(
    async (waitAt, ticks) => {
      // eslint-disable-next-line import/no-absolute-path
      const goMode = await import('/lib/actions/go-mode.js')
      const seen = []
      // Call the thunk with our own dispatch so we observe every action it
      // emits, while real state still advances through the real store.
      const spy = (action) => {
        if (typeof action === 'function') return window.store.dispatch(action)
        if (action?.type) seen.push(action.type)
        return window.store.dispatch(action)
      }
      const getState = () => window.store.getState()

      for (let i = 0; i < ticks; i++) {
        const position = {
          coords: {
            accuracy: 10,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            latitude: waitAt.lat,
            longitude: waitAt.lon,
            speed: 0
          },
          timestamp: Date.now() + i * 1000
        }
        goMode.handlePositionUpdate(position)(spy, getState)
        await new Promise((resolve) => setTimeout(resolve, 120))
      }

      const g = getState().otp.goMode
      return {
        legTransitions: seen.filter((t) => t === 'TRANSITION_LEG').length,
        matchedLeg: g.routeMatch?.legIndex,
        progressAlongLeg: g.routeMatch?.progressAlongLeg,
        trackingIntervalUpdates: seen.filter(
          (t) => t === 'UPDATE_TRACKING_INTERVAL'
        ).length
      }
    },
    chosen.waitAt,
    TICKS
  )

  console.log(
    `[wait] ${TICKS} GPS ticks standing at the stop ` +
      `(matched leg ${result.matchedLeg}, ${(
        result.progressAlongLeg * 100
      ).toFixed(1)}% along it)`
  )
  console.log(`  TRANSITION_LEG dispatches:      ${result.legTransitions}`)
  console.log(
    `  UPDATE_TRACKING_INTERVAL:       ${result.trackingIntervalUpdates}`
  )

  await browser.close()

  if (result.progressAlongLeg < 0.98) {
    throw new Error(
      `test setup is not exercising the bug: rider is only ${(
        result.progressAlongLeg * 100
      ).toFixed(1)}% along the access leg, needs >=98%`
    )
  }
  if (result.legTransitions > 1) {
    throw new Error(
      `FAIL: leg transition re-fired ${result.legTransitions}x while the rider ` +
        'stood still — expected at most 1 per leg'
    )
  }
  console.log('\nPASS: the transition ran at most once while the rider waited.')
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
