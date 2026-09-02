/* eslint-disable no-console */
/**
 * Leg-transition verification. A rider waiting at the boarding stop sits at
 * ~100% of the access leg for as long as the bus takes to show up, and the
 * route match — rebuilt from raw GPS every tick — keeps pointing at the leg
 * they're standing on. Two things must hold:
 *
 *   1. Waiting advances nothing. Standing on the curb is not boarding, and the
 *      transition is side-effectful (it restarts the position watcher and
 *      vehicle tracking, and clears the anchored departure). On the 2026-07-12
 *      trip it fired 56 times in 50s at I-35W & 46th St Station, which locked
 *      navigation up.
 *   2. Boarding still advances the leg, exactly once. Position matching only
 *      ever searches forward, so a leg advance is unrecoverable — it must take
 *      real evidence (the match itself moving onto the transit leg).
 *
 * Harness: drive the real app at :9967, plan a walk→bus trip, start Go Mode,
 * then invoke the handlePositionUpdate thunk directly with a fixed position —
 * first at the end of the access leg, then out along the bus's own geometry —
 * calling it with our own dispatch so every action it emits is counted while
 * real state still advances through the real store.
 *
 * PRECONDITION, and the reason this script used to fail for reasons that had
 * nothing to do with it (backlog 6.26): assertion (2) is gated by the board
 * window, `nowMs >= boardEpoch - TRANSIT_BOARD_EARLY_MS`
 * (`position-matching.ts:725`, five minutes). Whether the earliest walk→bus
 * itinerary the live graph happens to return is inside that window is a fact
 * about Metro Transit's timetable at the moment of the run, not about the code
 * — measured 2026-09-02, a bus 9.9 min out produced no transition and one 2.5
 * min out produced the expected single transition, with board-gate's own two
 * new conditions (`isOnRoute`, `distanceFromRoute`) true in both. So the script
 * now PICKS a boardable itinerary: it prefers one whose bus is naturally inside
 * the window, and otherwise shifts the chosen itinerary's clock so it is —
 * then asserts the precondition explicitly, before the assertion it exists for.
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

    // Choose an itinerary the board window will actually admit, and say which
    // way it was obtained. Preference order:
    //   1. a bus already inside [now, now + TRANSIT_BOARD_EARLY_MS) — the real
    //      thing, no harness intervention at all;
    //   2. otherwise the earliest, with every leg time shifted by a constant
    //      so its bus boards half a window from now. Shifting the plan's clock
    //      is the harness's own business (the rider is teleported onto the bus
    //      route anyway); shifting it by a CONSTANT keeps every leg duration,
    //      ordering and geometry exactly as the graph produced them.
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
    window.__itin = picked
    const busLeg = picked.legs[1]
    const boardLeadMs = boardOf(picked) - Date.now()

    // Stand on the access leg's own polyline, a few metres short of the stop:
    // that's the rider waiting to board, and it is what keeps the route match
    // pinned to leg 0 at >=98% (the condition seen on the real trip). Sitting
    // exactly on the stop can instead match the transit leg at 0%.
    const poly = pm.decodeLegGeometry(picked.legs[0])
    const cum = pm.calculateCumulativeDistances(poly)
    const target = cum[cum.length - 1] * 0.99
    let i = cum.findIndex((d) => d >= target)
    if (i < 1) i = poly.length - 1
    const [lat, lon] = poly[i]

    // ...and then the bus actually comes: a point well along the transit leg's
    // own geometry, which is the evidence that must still advance the leg.
    const busPoly = pm.decodeLegGeometry(busLeg)
    const busCum = pm.calculateCumulativeDistances(busPoly)
    let j = busCum.findIndex((d) => d >= busCum[busCum.length - 1] * 0.25)
    if (j < 1) j = Math.floor(busPoly.length / 2)
    const [busLat, busLon] = busPoly[j]

    return {
      boardEarlyMs: EARLY,
      boardLeadMs,
      boardMaxDistanceM: pm.TRANSIT_BOARD_MAX_DISTANCE_M,
      busRoute: busLeg.routeShortName || busLeg.routeLongName,
      candidates: ok.length,
      rideAt: { lat: busLat, lon: busLon },
      shiftedByMs,
      stop: busLeg.from?.name,
      waitAt: { lat, lon }
    }
  })
  if (!chosen) throw new Error('no walk→bus itinerary found')
  console.log(
    `[setup] walk to ${chosen.stop}, board ${chosen.busRoute}; rider will wait at the stop`
  )
  console.log(
    `[setup] ${chosen.candidates} walk→bus itinerar${
      chosen.candidates === 1 ? 'y' : 'ies'
    }; bus boards in ${(chosen.boardLeadMs / 60000).toFixed(1)} min ` +
      `(window ${(chosen.boardEarlyMs / 60000).toFixed(0)} min)` +
      (chosen.shiftedByMs
        ? `, clock shifted ${(chosen.shiftedByMs / 60000).toFixed(1)} min ` +
          'because no natural departure was inside it'
        : ', taken as the graph returned it')
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

  // Feed the thunk a fixed position for N ticks and count what it dispatches.
  const tick = (at, ticks) =>
    page.evaluate(
      async (at, ticks) => {
        // eslint-disable-next-line import/no-absolute-path
        const goMode = await import('/lib/actions/go-mode.js')
        const seen = []
        // Call the thunk with our own dispatch so we observe every action it
        // emits, while real state still advances through the real store.
        const transitionedTo = []
        const getStateForSpy = () => window.store.getState()
        const spy = (action) => {
          // Follow thunks with the spy itself: the leg advance is a thunk
          // (advanceToLeg), and handing it to the real store dispatch would
          // hide every action it emits — including the TRANSITION_LEG this
          // test exists to count.
          if (typeof action === 'function') return action(spy, getStateForSpy)
          if (action?.type) seen.push(action.type)
          if (action?.type === 'TRANSITION_LEG') {
            transitionedTo.push(action.payload.legIndex)
          }
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
              latitude: at.lat,
              longitude: at.lon,
              speed: 0
            },
            timestamp: Date.now() + i * 1000
          }
          goMode.handlePositionUpdate(position)(spy, getState)
          await new Promise((resolve) => setTimeout(resolve, 120))
        }

        const g = getState().otp.goMode
        // The three inputs shouldTransitionToNextLeg actually judges, read
        // back at the same moment, so a refusal names its own reason instead
        // of surfacing as "expected exactly one, to leg 1".
        const gateLegIndex = g.routeMatch?.legIndex
        const gateLeg = g.activeItinerary?.legs?.[gateLegIndex]
        return {
          gate: {
            boardEpoch: Number(
              g.liveLegTimes?.[gateLegIndex]?.boardEpoch ?? gateLeg?.startTime
            ),
            distanceFromRoute: g.routeMatch?.distanceFromRoute,
            isOnRoute: !!g.routeMatch?.isOnRoute,
            isRiding: g.riding?.legIndex === gateLegIndex,
            nowMs: Date.now()
          },
          itineraryStart: Number(g.activeItinerary?.startTime),
          legTransitions: seen.filter((t) => t === 'TRANSITION_LEG').length,
          matchedLeg: g.routeMatch?.legIndex,
          notable: seen.filter((t) =>
            ['ADD_NOTIFICATION', 'START_GO_MODE', 'START_REROUTE'].includes(t)
          ),
          progressAlongLeg: g.routeMatch?.progressAlongLeg,
          trackingIntervalUpdates: seen.filter(
            (t) => t === 'UPDATE_TRACKING_INTERVAL'
          ).length,
          transitionedTo
        }
      },
      at,
      ticks
    )

  // (1) The rider reaches the stop and waits for the bus. No storm, no advance:
  // standing on the curb is not boarding.
  const waiting = await tick(chosen.waitAt, TICKS)
  console.log(
    `[wait] ${TICKS} ticks standing at the stop ` +
      `(matched leg ${waiting.matchedLeg}, ${(
        waiting.progressAlongLeg * 100
      ).toFixed(1)}% along it)`
  )
  console.log(`  TRANSITION_LEG dispatches:      ${waiting.legTransitions}`)
  console.log(
    `  UPDATE_TRACKING_INTERVAL:       ${waiting.trackingIntervalUpdates}`
  )

  // (2) The bus comes and they board: the leg must still advance, exactly once.
  await page.setGeolocation({
    accuracy: 10,
    latitude: chosen.rideAt.lat,
    longitude: chosen.rideAt.lon
  })
  const riding = await tick(chosen.rideAt, TICKS)
  console.log(
    `[ride] ${TICKS} ticks aboard the ${chosen.busRoute} ` +
      `(matched leg ${riding.matchedLeg})`
  )
  console.log(
    `  TRANSITION_LEG dispatches:      ${riding.legTransitions} ` +
      `-> leg(s) [${riding.transitionedTo.join(', ')}]`
  )
  // Teleporting onto the middle of the bus route before the bus is due reads as
  // a deviation, so Go Mode may re-plan and reset to leg 0 right after the
  // transition. That's the reroute logic doing its job — assert on the
  // transition the ride produced, not on state a re-plan is entitled to reset.
  console.log(
    `  itinerary ${
      riding.itineraryStart === waiting.itineraryStart
        ? 'unchanged'
        : 'swapped by a re-plan (harness artifact)'
    }`
  )

  await browser.close()

  if (waiting.progressAlongLeg < 0.98) {
    throw new Error(
      `test setup is not exercising the bug: rider is only ${(
        waiting.progressAlongLeg * 100
      ).toFixed(1)}% along the access leg, needs >=98%`
    )
  }
  if (waiting.legTransitions > 0) {
    throw new Error(
      `FAIL: ${waiting.legTransitions} leg transition(s) fired while the rider ` +
        'stood at the stop — waiting is not boarding'
    )
  }
  // The precondition, asserted before the assertion that depends on it. Each
  // of these three is a way for the transition to be refused that says nothing
  // about leg advance — and the board window is the one that made this script
  // red on `b3273adb` (backlog 6.26).
  const gate = riding.gate
  const boardLead = gate.boardEpoch - gate.nowMs
  console.log(
    `  gate: isOnRoute=${gate.isOnRoute} ` +
      `distanceFromRoute=${
        gate.distanceFromRoute == null
          ? 'n/a'
          : `${gate.distanceFromRoute.toFixed(0)}m`
      } board in ${(boardLead / 60000).toFixed(1)} min` +
      (gate.isRiding ? ' (riding — outranks the clock)' : '')
  )
  if (!gate.isRiding) {
    if (!gate.isOnRoute) {
      throw new Error(
        'PRECONDITION: the ride position did not match the bus leg ' +
          '(isOnRoute false) — the transition gate refuses on position, not ' +
          'on leg order'
      )
    }
    if (gate.distanceFromRoute > chosen.boardMaxDistanceM) {
      throw new Error(
        `PRECONDITION: ride position is ${gate.distanceFromRoute.toFixed(
          0
        )} m from the bus shape, over TRANSIT_BOARD_MAX_DISTANCE_M ` +
          `(${chosen.boardMaxDistanceM} m)`
      )
    }
    if (boardLead >= chosen.boardEarlyMs) {
      throw new Error(
        `PRECONDITION: the bus boards in ${(boardLead / 60000).toFixed(
          1
        )} min, outside the ${(chosen.boardEarlyMs / 60000).toFixed(
          0
        )} min board window — the gate refuses on the clock. The itinerary ` +
          'picker was supposed to prevent this; re-check the clock shift.'
      )
    }
  }
  if (riding.transitionedTo.length !== 1 || riding.transitionedTo[0] !== 1) {
    throw new Error(
      'FAIL: boarding the bus transitioned to leg(s) ' +
        `[${riding.transitionedTo.join(', ')}] — expected exactly one, to leg 1`
    )
  }
  console.log(
    '\nPASS: waiting at the stop advances nothing; boarding advances the leg once.'
  )
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
