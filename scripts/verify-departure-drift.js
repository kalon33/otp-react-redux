/* eslint-disable no-console */
/**
 * Departure-drift verification (8/11 ask: "if I'm enroute to or waiting on a
 * bus arrival time, track if there are any jumps … then send a notification of
 * the change and an update of how fast you need to move on the next leg").
 *
 * Expected behavior: while travelling toward a boarding, the live GTFS-realtime
 * prediction for that bus is watched against the estimate in force when the
 * boarding became current. Nothing is said on first sight. When it moves ≥2 min
 * a single DEPARTURE_CHANGED alert goes to the phone (and so to the wrist)
 * carrying BOTH the change and the pace line, and the sticky pacing card
 * silently re-posts the new numbers. Further movement re-alerts only in 2-min
 * steps from the figure the rider was last given.
 *
 * Harness: the same one verify-bike-pacing.js uses — plan a real all-bike trip
 * at :9967 for its genuine geometry, append a SYNTHETIC bus leg so the numbers
 * are deterministic rather than hostage to tonight's schedule, and drive GPS
 * through the real handlePositionUpdate. The live prediction is injected with
 * setLiveLegTimes, standing in for refreshLiveLegTimes' GTFS-RT poll (which
 * finds nothing for a synthetic trip id and would otherwise clear the record,
 * hence the re-injection before every tick). A fake Capacitor bridge records
 * exactly what would land on the phone.
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9346, lon: -93.2624, name: 'Test destination' }

const TRIP_ID = '1:drift-test'

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

  // A real bike leg plus a synthetic bus timed to leave ~10 min after the rider
  // can reach the stop, so the approach starts comfortable and every later
  // number is a consequence of the prediction we move.
  const plan = await page.evaluate(async (tripId) => {
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
    const busStart = now + (remainingRideSecs + 600) * 1000
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
      transitLeg: true,
      trip: { gtfsId: tripId }
    }
    window.__itin = {
      ...base,
      endTime: busLeg.endTime,
      legs: [...base.legs.slice(0, bikeLegIndex + 1), busLeg]
    }
    return {
      at: { lat: poly[i][0], lon: poly[i][1] },
      boardLegIndex: bikeLegIndex + 1,
      busStart,
      remainingRideSecs: Math.round(remainingRideSecs)
    }
  }, TRIP_ID)
  if (!plan) throw new Error('no all-bike itinerary found')
  console.log(
    `[setup] bike leg + synthetic 535 at +${Math.round(
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
    {
      polling: 300,
      timeout: 20000
    }
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

  /**
   * Run `ticks` GPS updates with the boarding predicted at `boardEpoch`.
   * The prediction is re-asserted before each tick because the 20 s
   * refreshLiveLegTimes poll finds no trip for a synthetic id and clears it.
   */
  const tick = (ticks, boardEpoch, boardLegIndex) =>
    page.evaluate(
      async (ticks, boardEpoch, boardLegIndex) => {
        // eslint-disable-next-line import/no-absolute-path
        const goMode = await import('/lib/actions/go-mode.js')
        const pos = window.store.getState().otp.goMode.tracking?.lastPosition
        const lat = pos.coords.latitude
        const lon = pos.coords.longitude
        for (let i = 0; i < ticks; i++) {
          window.store.dispatch(
            goMode.setLiveLegTimes({
              [boardLegIndex]: {
                alightEpoch: boardEpoch + 900000,
                alightRealtime: true,
                boardEpoch,
                boardRealtime: true,
                realtime: true
              }
            })
          )
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
      },
      ticks,
      boardEpoch,
      boardLegIndex
    )

  const pushLog = () => page.evaluate(() => window.__pushLog || [])
  const isDrift = (p) => p.kind === 'schedule' && /now \d/u.test(p.title || '')
  const isCard = (p) => p.id === 2

  const { boardLegIndex, busStart } = plan

  // (1) The bus is where it was said to be: baseline captured, nothing said.
  await tick(4, busStart, boardLegIndex)
  const phase1 = await pushLog()
  console.log(
    `[on time] ${phase1.filter(isDrift).length} drift alert(s), ` +
      `${phase1.filter(isCard).length} card write(s)`
  )

  // (2) The bus slips 6 minutes. One alert, carrying the change AND the pace.
  await tick(3, busStart + 6 * 60000, boardLegIndex)
  const phase2 = (await pushLog()).slice(phase1.length)
  console.log(
    `[+6 min] ${phase2.filter(isDrift).length} drift alert(s): ` +
      phase2
        .filter(isDrift)
        .map((p) => `"${p.title}" / "${p.body}"`)
        .join('; ')
  )

  // (3) One more minute of slip is the same story — silence.
  await tick(3, busStart + 7 * 60000, boardLegIndex)
  const phase3 = (await pushLog()).slice(phase1.length + phase2.length)
  console.log(`[+7 min] ${phase3.filter(isDrift).length} drift alert(s)`)

  // (4) Two more minutes past what the rider was told: it re-alerts, quoting
  // total drift from the ORIGINAL estimate, not the increment.
  await tick(3, busStart + 8 * 60000, boardLegIndex)
  const phase4 = (await pushLog()).slice(
    phase1.length + phase2.length + phase3.length
  )
  console.log(
    `[+8 min] ${phase4.filter(isDrift).length} drift alert(s): ` +
      phase4
        .filter(isDrift)
        .map((p) => `"${p.title}" / "${p.body}"`)
        .join('; ')
  )

  // Tidy up. Ending Go Mode tears down the native GPS session, which can
  // collect the evaluate's own promise before it resolves; every figure this
  // script asserts on is already captured, so a teardown hiccup must not be
  // reported as a behavioral failure. Card cancellation at trip end is
  // verify-bike-pacing.js's assertion, not this one's.
  await page
    .evaluate(async () => {
      // eslint-disable-next-line import/no-absolute-path
      const goMode = await import('/lib/actions/go-mode.js')
      window.store.dispatch(goMode.endGoMode())
    })
    .catch((e) => console.log(`[teardown] ${e.message}`))
  await browser.close()

  const fail = (msg) => {
    throw new Error(`FAIL: ${msg}`)
  }

  if (phase1.filter(isDrift).length !== 0) {
    fail(
      'alerted on first sight of the boarding — there is nothing to diverge from yet'
    )
  }
  const first = phase2.filter(isDrift)
  if (first.length !== 1) {
    fail(`expected exactly 1 alert on the 6-min slip, got ${first.length}`)
  }
  if (!/6 min later than first estimated/u.test(first[0].body || '')) {
    fail(`alert did not quote the drift: "${first[0].body}"`)
  }
  if (
    !/(hurry|pick up the pace|take your time)/u.test(first[0].body || '') ||
    !/min (slack|short) at the stop/u.test(first[0].body || '')
  ) {
    fail(`alert carried no pace guidance: "${first[0].body}"`)
  }
  // The card must keep pace with the new numbers, silently.
  const cardWrites = phase2.filter(isCard).filter((p) => p.kind === 'schedule')
  if (cardWrites.length && cardWrites.some((p) => !p.passive)) {
    fail('the pacing card buzzed on a drift update; the alert owns that buzz')
  }
  if (phase3.filter(isDrift).length !== 0) {
    fail('re-alerted 1 min after the last figure — the step is 2 min')
  }
  const second = phase4.filter(isDrift)
  if (second.length !== 1) {
    fail(`expected exactly 1 re-alert at +8 min, got ${second.length}`)
  }
  if (!/8 min later than first estimated/u.test(second[0].body || '')) {
    fail(`re-alert quoted an increment, not total drift: "${second[0].body}"`)
  }

  console.log(
    '\nPASS: silent on first sight, one alert per 2 min of movement, each ' +
      'quoting total drift from the original estimate plus how hard to push.'
  )
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
