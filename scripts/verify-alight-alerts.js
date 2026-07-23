/* eslint-disable no-console */
/**
 * Alight-alert verification (2026-07-22 ride note: "Bus notification a little
 * too trigger happy. 3-4 buzzes before actually needing to exit makes it easy
 * to ignore the critical one to get off… wow this is legitimately insane how
 * many notifications I'm getting for last stop").
 *
 * The old triggers fired on a LEVEL — `stopsRemaining === 2` and `=== 1` — with
 * a 60 s dedup window, and stopsRemaining sits at 1 for the whole final
 * inter-stop segment, so "prepare to exit" re-fired every minute and each one
 * buzzed the phone. They are now two time-based edges, one firing per leg.
 *
 * The cadence itself is pinned by the unit test (a whole simulated approach
 * yields exactly [APPROACH_STOP, ARRIVING_STOP]) — the dedup clock is
 * Date.now(), so reproducing repeats end-to-end would need minutes of real wall
 * time, during which Go Mode's own recovery logic legitimately replans the trip.
 * What this script verifies is the half the unit test cannot: that the ACTION
 * layer feeds those checks a sane alight context off real OTP data —
 *
 *   1. mid-ride, far from the exit: no alight alert at all;
 *   2. just short of the exit stop: the door alert, exactly once, naming the
 *      stop — and not repeated by the ticks that follow.
 *
 * Harness: same as verify-leg-transition — real app at :9967, real plan,
 * handlePositionUpdate invoked directly with a fixed position.
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9778, lon: -93.2707, name: 'Downtown Minneapolis' }

const ALIGHT_TYPES = ['APPROACH_STOP', 'ARRIVING_STOP']

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

  // A transit leg that is NOT the last leg: parking at the very end of the
  // final leg trips the arrival short-circuit, which quiesces notifications
  // and would make this pass for the wrong reason.
  const chosen = await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const pm = await import('/lib/util/go-mode/position-matching.js')
    const searches = window.store.getState().otp.searches || {}
    const itins = Object.values(searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
    const ok = itins.filter((it) => {
      const legs = it.legs || []
      const t = legs.findIndex((l) => l.transitLeg)
      return t > 0 && t < legs.length - 1
    })
    if (!ok.length) return null
    ok.sort((a, b) => a.startTime - b.startTime)
    window.__alightItinerary = ok[0]
    const legIndex = ok[0].legs.findIndex((l) => l.transitLeg)
    const busLeg = ok[0].legs[legIndex]

    const poly = pm.decodeLegGeometry(busLeg)
    const cum = pm.calculateCumulativeDistances(poly)
    const at = (fraction) => {
      const target = cum[cum.length - 1] * fraction
      let i = cum.findIndex((d) => d >= target)
      if (i < 1) i = poly.length - 1
      return { lat: poly[i][0], lon: poly[i][1] }
    }

    return {
      alightStop: busLeg.to?.name,
      busRoute: busLeg.routeShortName || busLeg.routeLongName,
      legIndex,
      // Mid-ride, and then a few seconds from the door.
      midRide: at(0.35),
      nearExit: at(0.97),
      rideMinutes: Math.round(
        (Number(busLeg.endTime) - Number(busLeg.startTime)) / 60000
      )
    }
  })
  if (!chosen) throw new Error('no itinerary with a transit leg before the end')
  console.log(
    `[setup] ${chosen.busRoute} (leg ${chosen.legIndex}), ${chosen.rideMinutes} min ride, exit at ${chosen.alightStop}`
  )

  // Fire N ticks at a fixed position and report the alight alerts they raise.
  // Go Mode is restarted for each position so the two cases are independent
  // (notification state, riding fact and leg guard all reset with the trip).
  const runAt = async (at, ticks) => {
    await page.setGeolocation({
      accuracy: 10,
      latitude: at.lat,
      longitude: at.lon
    })
    await page.evaluate(() => window.__endGoMode && window.__endGoMode())
    await page.evaluate(() => window.__beginGoMode(window.__alightItinerary))
    await page.waitForFunction(
      () => window.store.getState().otp.goMode.isActive,
      { polling: 300, timeout: 20000 }
    )
    return page.evaluate(
      async (at, ticks) => {
        // eslint-disable-next-line import/no-absolute-path
        const goMode = await import('/lib/actions/go-mode.js')
        const emitted = []
        const spy = (action) => {
          if (typeof action === 'function') return window.store.dispatch(action)
          if (action?.type === 'ADD_NOTIFICATION') emitted.push(action.payload)
          return window.store.dispatch(action)
        }
        const getState = () => window.store.getState()

        for (let i = 0; i < ticks; i++) {
          goMode.handlePositionUpdate({
            coords: {
              accuracy: 10,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              latitude: at.lat,
              longitude: at.lon,
              speed: 8
            },
            timestamp: Date.now()
          })(spy, getState)
          await new Promise((resolve) => setTimeout(resolve, 400))
        }

        const g = getState().otp.goMode
        const legIndex = g.routeMatch?.legIndex
        const leg = g.activeItinerary?.legs?.[legIndex]
        return {
          alightAlerts: emitted
            .filter((n) => ['APPROACH_STOP', 'ARRIVING_STOP'].includes(n.type))
            .map((n) => ({ message: n.message, type: n.type })),
          exitStop: leg?.to?.name,
          legIndex,
          legProgress: g.routeMatch?.progressAlongLeg,
          onTransitLeg: !!leg?.transitLeg
        }
      },
      at,
      ticks
    )
  }

  const mid = await runAt(chosen.midRide, 6)
  console.log(
    `[mid-ride] leg ${mid.legIndex} at ${((mid.legProgress ?? 0) * 100).toFixed(
      0
    )}%: ${mid.alightAlerts.length} alight alert(s)`
  )

  const exit = await runAt(chosen.nearExit, 10)
  console.log(
    `[at exit] leg ${exit.legIndex} at ${(
      (exit.legProgress ?? 0) * 100
    ).toFixed(0)}%: ${exit.alightAlerts.length} alight alert(s)`
  )
  exit.alightAlerts.forEach((n) => console.log(`  ${n.type}: ${n.message}`))

  await browser.close()

  // Teleporting onto a bus that hasn't departed reads (correctly) as boarding a
  // trip that can't exist, so Go Mode may auto-update the itinerary underneath
  // the test — the leg INDEX is therefore not stable. What must hold is that
  // the rider is on a transit leg heading for the same exit stop.
  if (!exit.onTransitLeg) {
    throw new Error(
      `test setup is not exercising the bug: matched leg ${exit.legIndex} is not a transit leg`
    )
  }
  if (exit.exitStop !== chosen.alightStop) {
    throw new Error(
      `test setup drifted: heading for "${exit.exitStop}", expected "${chosen.alightStop}"`
    )
  }
  if (mid.alightAlerts.length > 0) {
    throw new Error(
      `FAIL: ${mid.alightAlerts.length} alight alert(s) mid-ride, ` +
        `${chosen.rideMinutes} min from the exit — nothing is due yet`
    )
  }
  const doorAlerts = exit.alightAlerts.filter((n) => n.type === 'ARRIVING_STOP')
  if (doorAlerts.length !== 1) {
    throw new Error(
      `FAIL: ${doorAlerts.length} door alert(s) at the exit stop — expected exactly one`
    )
  }
  if (!doorAlerts[0].message.includes(chosen.alightStop)) {
    throw new Error(
      `FAIL: door alert does not name the exit stop: "${doorAlerts[0].message}"`
    )
  }
  if (exit.alightAlerts.length > ALIGHT_TYPES.length) {
    throw new Error(
      `FAIL: ${exit.alightAlerts.length} alight alerts at the exit — the rider gets at most two`
    )
  }
  console.log(
    '\nPASS: silence mid-ride; exactly one door alert at the exit stop, naming it.'
  )
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
