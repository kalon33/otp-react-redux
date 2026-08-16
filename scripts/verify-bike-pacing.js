/* eslint-disable no-console */
/**
 * Bike-pacing card verification (7/22 ride note: "how much time is left on my
 * bike ride and how much I'll have to wait at the stop … so I can know if I
 * should go Fast or slow").
 *
 * Expected behavior: while riding a BICYCLE leg toward a transit boarding, ONE
 * sticky notification (stable id 2, replaced in place — same mechanism as the
 * turn card) shows ride time left + wait at the stop. It posts once (alerting)
 * when the leg starts, stays quiet while the buffer holds, buzzes immediately
 * when the buffer collapses ("go fast"), and is cancelled when Go Mode ends.
 *
 * Harness: plan a real all-bike trip at :9967 for its genuine bike-leg
 * geometry, then append a SYNTHETIC bus leg whose startTime we control — the
 * buffer becomes deterministic instead of hostage to tonight's schedule. GPS
 * ticks drive the real handlePositionUpdate; a fake Capacitor bridge records
 * exactly what would land on the phone (and the watch, over ANCS).
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9346, lon: -93.2624, name: 'Test destination' }

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
        form.setQueryParam({
          departArrive: 'NOW',
          from,
          modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
          to
        })
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

  // Take a real bike leg, append a synthetic 535 departure timed off the
  // remaining ride from the 40% mark: ~10 min of buffer to start.
  const plan = await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const pm = await import('/lib/util/go-mode/position-matching.js')
    const searches = window.store.getState().otp.searches || {}
    const itins = Object.values(searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
    const ok = itins.filter((it) => {
      const legs = it.legs || []
      return (
        legs.length > 0 &&
        legs.every((l) => !l.transitLeg) &&
        legs.some((l) => l.mode === 'BICYCLE')
      )
    })
    if (!ok.length) return null
    ok.sort((a, b) => a.duration - b.duration)
    const base = ok[0]
    const bikeLegIndex = base.legs.findIndex((l) => l.mode === 'BICYCLE')
    const bikeLeg = base.legs[bikeLegIndex]
    const poly = pm.decodeLegGeometry(bikeLeg)
    const cum = pm.calculateCumulativeDistances(poly)
    let i = cum.findIndex((d) => d >= cum[cum.length - 1] * 0.4)
    if (i < 1) i = Math.floor(poly.length / 2)

    const now = Date.now()
    const remainingRideSecs = (bikeLeg.duration || 600) * 0.6
    const busStart = now + (remainingRideSecs + 600) * 1000 // ~10 min buffer
    const busLeg = {
      duration: 900,
      endTime: busStart + 900 * 1000,
      from: { ...bikeLeg.to, name: 'Test Station' },
      headsign: 'Test',
      intermediateStops: [],
      mode: 'BUS',
      routeShortName: '535',
      startTime: busStart,
      to: { lat: 44.95, lon: -93.25, name: 'Far Stop' },
      transitLeg: true
    }
    window.__itin = {
      ...base,
      endTime: busLeg.endTime,
      legs: [...base.legs.slice(0, bikeLegIndex + 1), busLeg]
    }
    return {
      at: { lat: poly[i][0], lon: poly[i][1] },
      busStart,
      remainingRideSecs: Math.round(remainingRideSecs)
    }
  })
  if (!plan) throw new Error('no all-bike itinerary found')
  console.log(
    `[setup] bike leg with synthetic 535 at +${Math.round(
      (plan.busStart - Date.now()) / 60000
    )} min (~${Math.round(plan.remainingRideSecs / 60)} min ride left)`
  )

  await page.setGeolocation({
    accuracy: 10,
    latitude: plan.at.lat,
    longitude: plan.at.lon
  })
  await page.evaluate(() => window.__beginGoMode(window.__itin))
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.isActive,
    { polling: 300, timeout: 20000 }
  )

  // Fake Capacitor bridge AFTER beginGoMode (its native branch reloads the
  // shell) — records every schedule/cancel the real sendPush path emits.
  await page.evaluate(() => {
    window.__pushLog = []
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        LocalNotifications: {
          cancel: (o) => {
            const list = o.notifications || []
            list.forEach((n) =>
              window.__pushLog.push({ id: n.id, kind: 'cancel' })
            )
            return Promise.resolve()
          },
          checkPermissions: () => Promise.resolve({ display: 'granted' }),
          requestPermissions: () => Promise.resolve({ display: 'granted' }),
          schedule: (o) => {
            const list = o.notifications || []
            list.forEach((n) =>
              window.__pushLog.push({
                body: n.body,
                id: n.id,
                kind: 'schedule',
                passive: n.interruptionLevel === 'passive',
                title: n.title
              })
            )
            return Promise.resolve()
          }
        }
      }
    }
  })

  const tick = (ticks) =>
    page.evaluate(async (ticks) => {
      // eslint-disable-next-line import/no-absolute-path
      const goMode = await import('/lib/actions/go-mode.js')
      const pos = window.store.getState().otp.goMode.tracking?.lastPosition
      const lat = pos.coords.latitude
      const lon = pos.coords.longitude
      for (let i = 0; i < ticks; i++) {
        await goMode.handlePositionUpdate({
          coords: {
            accuracy: 10,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            latitude: lat,
            longitude: lon,
            speed: 4
          },
          timestamp: Date.now() + i * 1000
        })(window.store.dispatch, window.store.getState)
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
    }, ticks)

  const cardLog = () =>
    page.evaluate(() => (window.__pushLog || []).filter((p) => p.id === 2))

  // (1) Riding with ~10 min of buffer: exactly one alerting post.
  await tick(6)
  const phase1 = await cardLog()
  console.log(
    `[comfortable] ${phase1.length} card write(s): ` +
      phase1.map((p) => `"${p.title}" passive=${p.passive}`).join('; ')
  )

  // (2) Collapse the buffer: pull the departure to 60s before the rider can
  // arrive (departure override, same lever the anchor uses). Expect an
  // immediate non-passive repost (negative wait) despite the 90s floor.
  await page.evaluate(async (remainingRideSecs) => {
    // eslint-disable-next-line import/no-absolute-path
    const goMode = await import('/lib/actions/go-mode.js')
    window.store.dispatch(
      goMode.setDepartureOverride(Date.now() + (remainingRideSecs - 60) * 1000)
    )
  }, plan.remainingRideSecs)
  await tick(4)
  const phase2 = (await cardLog()).slice(phase1.length)
  console.log(
    `[collapsed] ${phase2.length} card write(s): ` +
      phase2.map((p) => `"${p.title}" passive=${p.passive}`).join('; ')
  )

  // (3) End the trip: the card must be cancelled.
  await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const goMode = await import('/lib/actions/go-mode.js')
    window.store.dispatch(goMode.endGoMode())
  })
  const all = await cardLog()
  const cancels = all.filter((p) => p.kind === 'cancel')
  console.log(`[end] ${cancels.length} cancel(s) for card id 2`)

  await browser.close()

  const p1Posts = phase1.filter((p) => p.kind === 'schedule')
  if (p1Posts.length !== 1) {
    throw new Error(
      `FAIL: expected exactly 1 initial pacing post, got ${p1Posts.length}`
    )
  }
  if (p1Posts[0].passive) {
    throw new Error(
      'FAIL: the initial pacing post should alert, not be passive'
    )
  }
  // Rider-confirmed copy: ride time and projected wait, nothing else.
  if (!/^🚲 \d+ min ride · −?\d+ min wait$/u.test(p1Posts[0].title)) {
    throw new Error(`FAIL: unexpected initial title "${p1Posts[0].title}"`)
  }
  if (p1Posts[0].body) {
    throw new Error(
      `FAIL: pacing card should have no body, got "${p1Posts[0].body}"`
    )
  }
  const p2Posts = phase2.filter((p) => p.kind === 'schedule')
  if (p2Posts.length !== 1) {
    throw new Error(
      'FAIL: expected exactly 1 repost on buffer collapse, got ' +
        p2Posts.length
    )
  }
  if (p2Posts[0].passive || !/−\d+ min wait/u.test(p2Posts[0].title)) {
    throw new Error(
      'FAIL: collapse repost should buzz and show a negative wait, got ' +
        `"${p2Posts[0].title}" passive=${p2Posts[0].passive}`
    )
  }
  if (cancels.length < 1) {
    throw new Error('FAIL: ending Go Mode did not cancel the pacing card')
  }
  console.log(
    '\nPASS: one pacing card per bike leg — posts once, buzzes only when the ' +
      'buffer collapses, cancelled at trip end.'
  )
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
