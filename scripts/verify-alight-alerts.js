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
 *
 * The rider is put ON the bus the way the product now requires. 99001e54
 * (2026-09-02, "go mode: board a bus on evidence, not on being near one",
 * backlog 6.1/6.3/4.4) made GPS alone establish riding only AFTER the rider has
 * waited at the leg's boarding stop, and put the matcher's leg nomination
 * through the transition gate before it is stored. Teleporting straight onto
 * the middle of the bus leg — what this script used to do, restarting Go Mode
 * once per sample position — therefore stopped advancing the leg at all, and
 * from 2026-09-03 every nightly run died on this script's own precondition
 * ("matched leg 0 is not a transit leg"). It is one continuous trip now: stand
 * at the boarding stop, then ride, which is also what makes "at most one door
 * alert per leg" a real assertion rather than one reset between samples.
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

  // A walk access leg into a transit leg that is NOT the last leg: the walk is
  // where the rider waits for the bus (the boarding evidence 6.1 now requires),
  // and parking at the very end of the FINAL leg would trip the arrival
  // short-circuit, which quiesces notifications and would make this pass for
  // the wrong reason.
  const chosen = await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const pm = await import('/lib/util/go-mode/position-matching.js')
    const searches = window.store.getState().otp.searches || {}
    const itins = Object.values(searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
    const ok = itins.filter((it) => {
      const legs = it.legs || []
      return (
        legs[0]?.mode === 'WALK' &&
        legs[1]?.transitLeg &&
        legs.length > 2 &&
        (legs[1].steps || legs[1].legGeometry) != null
      )
    })
    if (!ok.length) return null
    ok.sort((a, b) => a.startTime - b.startTime)

    // Same clock treatment as verify-leg-transition: prefer a bus already
    // inside the board window, else shift every leg time by one CONSTANT so it
    // is, which leaves every duration, ordering and geometry exactly as the
    // graph produced them. Without it the board gate refuses a bus that is
    // three quarters of an hour away and the rider never gets on.
    const EARLY = pm.TRANSIT_BOARD_EARLY_MS
    const now = Date.now()
    const boardOf = (it) => Number(it.legs[1].startTime)
    const natural = ok.find((it) => {
      const lead = boardOf(it) - now
      return lead < EARLY && lead > -EARLY
    })
    let picked = natural || ok[0]
    let shiftedByMs = 0
    if (!natural) {
      shiftedByMs = now + EARLY / 2 - boardOf(picked)
      const shift = (v) =>
        Number.isFinite(Number(v)) ? Number(v) + shiftedByMs : v
      picked = {
        ...picked,
        endTime: shift(picked.endTime),
        legs: picked.legs.map((l) => ({
          ...l,
          endTime: shift(l.endTime),
          startTime: shift(l.startTime)
        })),
        startTime: shift(picked.startTime)
      }
    }
    window.__alightItinerary = picked

    const legIndex = 1
    const busLeg = picked.legs[legIndex]

    // Where the rider waits: on the access leg's own polyline, a few metres
    // short of the stop. Sitting exactly on the stop can instead match the
    // transit leg at 0%, which is not waiting.
    const walkPoly = pm.decodeLegGeometry(picked.legs[0])
    const walkCum = pm.calculateCumulativeDistances(walkPoly)
    let w = walkCum.findIndex((d) => d >= walkCum[walkCum.length - 1] * 0.99)
    if (w < 1) w = walkPoly.length - 1

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
      boardStop: busLeg.from?.name,
      busRoute: busLeg.routeShortName || busLeg.routeLongName,
      legIndex,
      // Mid-ride, and then a few seconds from the door.
      midRide: at(0.35),
      nearExit: at(0.97),
      rideMinutes: Math.round(
        (Number(busLeg.endTime) - Number(busLeg.startTime)) / 60000
      ),
      shiftedByMs,
      waitAt: { lat: walkPoly[w][0], lon: walkPoly[w][1] }
    }
  })
  if (!chosen) throw new Error('no walk→bus itinerary with a leg after the bus')
  console.log(
    `[setup] ${chosen.busRoute} (leg ${chosen.legIndex}), ${chosen.rideMinutes} min ride, ` +
      `board at ${chosen.boardStop}, exit at ${chosen.alightStop}` +
      (chosen.shiftedByMs
        ? ` (clock shifted ${(chosen.shiftedByMs / 60000).toFixed(
            1
          )} min: no natural departure was inside the board window)`
        : '')
  )

  // ONE trip, walked through in order: wait at the stop, ride, reach the door.
  // Go Mode is NOT restarted between positions any more — a restart would drop
  // the riding fact this trip had to earn (6.3: "a Go Mode restart no longer
  // resumes a riding fact that never named one"), and the rider would be back
  // on the access leg for every sample.
  await page.setGeolocation({
    accuracy: 10,
    latitude: chosen.waitAt.lat,
    longitude: chosen.waitAt.lon
  })
  await page.evaluate(() => window.__endGoMode && window.__endGoMode())
  await page.evaluate(() => window.__beginGoMode(window.__alightItinerary))
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.isActive,
    {
      polling: 300,
      timeout: 20000
    }
  )

  // Fire N ticks at a fixed position and report the alight alerts they raise.
  const runAt = async (at, ticks) => {
    await page.setGeolocation({
      accuracy: 10,
      latitude: at.lat,
      longitude: at.lon
    })
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

  // (0) Waiting at the boarding stop. Nothing about the exit is due here, and
  //     this is the stretch that earns the riding fact the ride phases need.
  const waiting = await runAt(chosen.waitAt, 15)
  console.log(
    `[at stop] leg ${waiting.legIndex} at ${(
      (waiting.legProgress ?? 0) * 100
    ).toFixed(0)}%: ${waiting.alightAlerts.length} alight alert(s)`
  )

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
  if (waiting.alightAlerts.length > 0) {
    throw new Error(
      `FAIL: ${waiting.alightAlerts.length} alight alert(s) while the rider ` +
        'was still standing at the boarding stop'
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
