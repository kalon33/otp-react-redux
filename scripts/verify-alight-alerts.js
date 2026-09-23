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

// Exit code for "the thing under test could not be exercised, and that is not a
// defect". nightly-verify.sh maps it to SKIP; anything else is still a failure.
// Same convention as verify-onboard-options.js.
//
// The two checks below marked "test setup" are preconditions, and the comment
// above them has always said so: teleporting onto a bus that has not departed
// reads as boarding a trip that cannot exist, so Go Mode may auto-update the
// itinerary underneath the test and the match may never reach a transit leg.
// When it does not, the three real assertions are vacuous -- "no alight alert
// while standing at the stop" is trivially true of a rider the app does not
// think is going anywhere. Measured 2026-09-17: PASS in 23s, then this same
// precondition 90 minutes later on the same tree. It is a fact about which
// departure the live graph returned, so it reports as a SKIP. (backlog 13.6)
const EXIT_SKIP = 75

function skip(reason) {
  console.log(`SKIP: ${reason}`)
  process.exit(EXIT_SKIP)
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
    latitude: FROM.lat,
    longitude: FROM.lon
  })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(APP, { timeout: 60000, waitUntil: 'networkidle2' })
  // 60s, not 30s: this is the FIRST wait in every script and it is a Vite dev
  // server transforming the module graph, not the product. Two runs on
  // 2026-09-17 died here -- 30s after a `docker restart otp-frontend-dev`, with
  // a cold transform cache -- and reported it as the script's failure. A red
  // row that means "the dev server was still warming up" is the kind that
  // taught everyone to stop reading this suite (backlog 13.6). If this wait is
  // what times out, the app at :9967 never booted: `docker restart
  // otp-frontend-dev` (a full `yarn jest` or `ship_web.sh` clobbers its
  // tmp/config.yml).
  await page.waitForFunction(() => !!window.store, { timeout: 60000 })

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
    // `i < 0` (not found), never `i < 1`: at(0) is the boarding stop, and the
    // old guard turned it into the LAST point of the shape — the exit stop.
    // That put the rider at their own door on the first tick of the ride and
    // spent the single ARRIVING_STOP alert there, 11 min from the alight time
    // (measured 2026-09-22: `leg=1 prog=1.00 legProg=100 liveAlight=660s`).
    // Harmless while every caller asked for a fraction well inside the leg;
    // not harmless now that the rider boards at the stop and rides.
    const at = (fraction) => {
      const target = cum[cum.length - 1] * fraction
      let i = cum.findIndex((d) => d >= target)
      if (i < 0) i = poly.length - 1
      return { lat: poly[i][0], lon: poly[i][1] }
    }

    // The rider RIDES: a path of fixes along the bus's own shape, rather than
    // a teleport to a point kilometres along it. The route matcher's jump
    // budget (position-matching.ts:478-558) licenses a projection by the
    // ground the rider provably covered — 50 m across a leg boundary plus
    // twice their own step — so a rider who moved 0 m cannot buy 3 km of it,
    // and the match stays pinned to the access leg. That is the
    // "matched leg 0 is not a transit leg" SKIP this script has reported on
    // most nights since 09-01 (17.29).
    const path = (from, to, steps) => {
      const out = []
      for (let k = 0; k < steps; k++) {
        out.push(at(from + ((to - from) * k) / Math.max(1, steps - 1)))
      }
      return out
    }

    return {
      alightEpoch: Number(busLeg.endTime),
      alightStop: busLeg.to?.name,
      boardEpoch: Number(busLeg.startTime),
      boardStop: busLeg.from?.name,
      busRoute: busLeg.routeShortName || busLeg.routeLongName,
      legIndex,
      // Board at the stop and ride to a third of the way along, then ride the
      // rest of the way to the door.
      midRide: path(0, 0.35, 8),
      nearExit: path(0.35, 0.97, 8),
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
  /**
   * `path` is one fix per tick. `live` is the live board/alight record to
   * re-assert before every tick, and it is the other half of making this
   * script RUN (17.29): the board gate prefers the LIVE board time over the
   * plan's (`boardEpoch ?? targetLeg.startTime`,
   * position-matching.ts:994-998), and `liveLegTimes` is filled from the real
   * trip fetch, which knows nothing of the clock shift this harness applies.
   * On every run that needed a shift the gate therefore saw a bus 10-20 min
   * out and refused the transition. Re-asserted each tick because
   * refreshLiveLegTimes' 20 s poll overwrites it — the same thing
   * verify-departure-drift.js does with its synthetic boarding.
   */
  const runAt = async (path, ticks, live) => {
    await page.setGeolocation({
      accuracy: 10,
      latitude: path[0].lat,
      longitude: path[0].lon
    })
    return page.evaluate(
      async (path, ticks, live) => {
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
          const at = path[Math.min(i, path.length - 1)]
          // Keyed on the CURRENT itinerary's transit leg, not on the index the
          // plan had when the script started: an auto-update can renumber the
          // legs underneath the test (it already does), and a live record
          // written to a stale index is a record about the wrong leg.
          const legsNow = getState().otp.goMode.activeItinerary?.legs || []
          const tIdx = legsNow.findIndex((l) => l.transitLeg)
          if (tIdx >= 0) {
            window.store.dispatch(
              goMode.setLiveLegTimes({
                [tIdx]: {
                  alightEpoch: live.alightEpoch,
                  alightRealtime: true,
                  boardEpoch: live.aboard
                    ? Date.now() - 30000
                    : live.boardEpoch,
                  boardRealtime: true,
                  realtime: true
                }
              })
            )
          }
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
      path,
      ticks,
      live
    )
  }

  // (0) Waiting at the boarding stop. Nothing about the exit is due here, and
  //     this is the stretch that earns the riding fact the ride phases need.
  const live = {
    alightEpoch: chosen.alightEpoch,
    boardEpoch: chosen.boardEpoch,
    legIndex: chosen.legIndex
  }
  const waiting = await runAt([chosen.waitAt], 15, live)
  console.log(
    `[at stop] leg ${waiting.legIndex} at ${(
      (waiting.legProgress ?? 0) * 100
    ).toFixed(0)}%: ${waiting.alightAlerts.length} alight alert(s)`
  )

  // Once the rider is aboard, the bus has LEFT: the live board time is in the
  // past, which is what it is on a real ride and what keeps the
  // boarded-earlier machinery from re-planning the trip out from under the
  // test.
  const aboard = { ...live, aboard: true }
  const mid = await runAt(chosen.midRide, chosen.midRide.length, aboard)
  console.log(
    `[mid-ride] leg ${mid.legIndex} at ${((mid.legProgress ?? 0) * 100).toFixed(
      0
    )}%: ${mid.alightAlerts.length} alight alert(s)`
  )
  mid.alightAlerts.forEach((n) => console.log(`  ${n.type}: ${n.message}`))

  const exit = await runAt(chosen.nearExit, chosen.nearExit.length, aboard)
  console.log(
    `[at exit] leg ${exit.legIndex} at ${(
      (exit.legProgress ?? 0) * 100
    ).toFixed(0)}%: ${exit.alightAlerts.length} alight alert(s)` +
      ` (transit=${exit.onTransitLeg}, exit stop "${exit.exitStop}")`
  )
  exit.alightAlerts.forEach((n) => console.log(`  ${n.type}: ${n.message}`))

  await browser.close()

  // Teleporting onto a bus that hasn't departed reads (correctly) as boarding a
  // trip that can't exist, so Go Mode may auto-update the itinerary underneath
  // the test — the leg INDEX is therefore not stable. What must hold is that
  // the rider is on a transit leg heading for the same exit stop.
  if (!exit.onTransitLeg) {
    skip(
      `the match never reached a transit leg (matched leg ${exit.legIndex}), ` +
        'so the rider was never aboard and the alight assertions below would ' +
        'be vacuous'
    )
  }
  if (exit.exitStop !== chosen.alightStop) {
    skip(
      `the itinerary drifted under the test: heading for "${exit.exitStop}", ` +
        `expected "${chosen.alightStop}"`
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
  // e.stack, not e.message: a puppeteer waitForFunction timeout says only
  // "waiting for function failed: timeout 60000ms exceeded" and names neither
  // the wait that failed nor its line. Six of the eleven red rows on
  // 2026-09-17 were that one line and nothing else, which is much of why this
  // suite's output stopped being read (backlog 13.6). The stack names the wait.
  console.error(e.stack || e.message)
  process.exit(1)
})
