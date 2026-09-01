/* eslint-disable no-console */
/**
 * Bike-deviation verification. On the 2026-07-12 ride, biking a different way
 * than the planned bike leg produced an "Off Route" notification once per
 * second for 5+ minutes AND kicked off a real reroute search, whose active
 * search made the mobile shell yank the rider from Go Mode onto a fresh
 * results screen ("when I arrived it's just showing me a new search I didn't
 * ask for"). The required behavior (rider-confirmed): car-GPS style — quietly
 * re-plan the access path from the rider's position and swap it in while
 * STAYING in Go Mode, with the deviation notification deduped to one per 120s.
 *
 * Harness: drive the real app at :9967, plan a trip, pick an all-bike
 * itinerary, start Go Mode, then invoke handlePositionUpdate directly —
 * first on the bike leg's own polyline, then well off it — counting every
 * action it dispatches while real state advances through the real store.
 *
 * Two 7/22-ride regressions are pinned here too: the whole run starts from a
 * seeded settled-empty reroute (status 'none'), which used to permanently
 * disable every later deviation response; and a single-tick 5km GPS glitch
 * must produce no deviation activity at all (the real ride showed "5836m from
 * route" for a moment while riding the bus dead on its line).
 *
 * Phase 2 (7/29 ride): a bike ACCESS leg into a transit suffix. Deviating on
 * the bike leg must re-plan ONLY the access chain — the boarding stop, its
 * departure time and every downstream leg stay byte-identical ("only reroute
 * the bike leg, don't switch my bus routes") — and no MISSED_BUS may fire
 * during the deviation ticks while the bus hasn't departed.
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9346, lon: -93.2624, name: 'Test destination' }
// Phase 2 needs a trip long enough that OTP returns bike-access + transit
// itineraries — downtown from the same origin.
const TO2 = { lat: 44.9778, lon: -93.2698, name: 'Phase 2 destination' }

const TICKS = 12

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
          // The phone's mode set (transit_bike_bicycle) — direct bike
          // itineraries only come back when BICYCLE is requested.
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

  // Pick an all-access itinerary with a bike leg, and compute two positions:
  // one ON the bike leg's polyline (~40% along), one pushed ~350m sideways off
  // that point (the rider going their own way).
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
        legs.length > 0 &&
        legs.every((l) => !l.transitLeg) &&
        legs.some((l) => l.mode === 'BICYCLE')
      )
    })
    if (!ok.length) return null
    ok.sort((a, b) => a.duration - b.duration)
    window.__itin = ok[0]
    const bikeLegIndex = ok[0].legs.findIndex((l) => l.mode === 'BICYCLE')
    const poly = pm.decodeLegGeometry(ok[0].legs[bikeLegIndex])
    const cum = pm.calculateCumulativeDistances(poly)
    let i = cum.findIndex((d) => d >= cum[cum.length - 1] * 0.4)
    if (i < 1) i = Math.floor(poly.length / 2)
    const [lat, lon] = poly[i]
    return {
      // ~555m north of the point; ~355m from the nearest segment of this
      // route's actual line (it bends) — safely past the 200m threshold.
      offAt: { lat: lat + 0.005, lon },
      onAt: { lat, lon }
    }
  })
  if (!chosen) throw new Error('no all-bike itinerary found')

  await page.setGeolocation({
    accuracy: 10,
    latitude: chosen.onAt.lat,
    longitude: chosen.onAt.lon
  })
  await page.evaluate(() => window.__beginGoMode(window.__itin))
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.isActive,
    { polling: 300, timeout: 20000 }
  )

  // Seed a settled-empty reroute attempt (status 'none') before anything else:
  // on 7/22 one dud auto-update earlier in the ride left this status behind
  // and every later deviation was ignored. The phases below must all work
  // FROM this state.
  await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const goMode = await import('/lib/actions/go-mode.js')
    window.store.dispatch(goMode.setRerouteResult(null))
  })
  const seededStatus = await page.evaluate(
    () => window.store.getState().otp.goMode.reRoute?.status
  )
  console.log(`[seed] reRoute.status = '${seededStatus}' (settled empty)`)
  if (seededStatus !== 'none') {
    throw new Error('FAIL: could not seed the settled-empty reroute status')
  }

  const snapshot = () =>
    page.evaluate(() => {
      const s = window.store.getState()
      return {
        itineraryOriginLat: s.otp.goMode.activeItinerary?.legs?.[0]?.from?.lat,
        itineraryStart: Number(s.otp.goMode.activeItinerary?.startTime),
        mobileScreen: s.otp.ui?.mobileScreen,
        recentCurrentLocation: (s.user?.localUser?.recentPlaces || []).filter(
          (p) => /current location/i.test(p.name || '')
        ).length,
        searchCount: Object.keys(s.otp.searches || {}).length
      }
    })

  const tick = (at, ticks) =>
    page.evaluate(
      async (at, ticks) => {
        // eslint-disable-next-line import/no-absolute-path
        const goMode = await import('/lib/actions/go-mode.js')
        const seen = []
        const deviations = []
        const missed = []
        const spy = (action) => {
          if (typeof action === 'function') return window.store.dispatch(action)
          if (action?.type) seen.push(action.type)
          if (
            action?.type === 'ADD_NOTIFICATION' &&
            action.payload?.type === 'ROUTE_DEVIATION'
          ) {
            deviations.push(action.payload.id)
          }
          if (
            action?.type === 'ADD_NOTIFICATION' &&
            action.payload?.type === 'MISSED_BUS'
          ) {
            missed.push(action.payload.id)
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
              speed: 4
            },
            timestamp: Date.now() + i * 1000
          }
          goMode.handlePositionUpdate(position)(spy, getState)
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
        return {
          deviationCount: deviations.length,
          forbidden: seen.filter((t) =>
            [
              'START_REROUTE',
              'SET_QUERY_PARAM',
              'ROUTING_REQUEST',
              'CLEAR_ACTIVE_SEARCH',
              'SET_MOBILE_SCREEN'
            ].includes(t)
          ),
          missedCount: missed.length
        }
      },
      at,
      ticks
    )

  const before = await snapshot()
  console.log(
    `[setup] all-bike itinerary active, screen=${before.mobileScreen}, ` +
      `${before.searchCount} search(es) in state`
  )

  // (1) Riding the planned line: nothing should fire.
  const onRoute = await tick(chosen.onAt, 5)
  console.log(
    `[on-route] 5 ticks on the bike leg: ${onRoute.deviationCount} deviation ` +
      `notification(s), forbidden actions: [${onRoute.forbidden.join(', ')}]`
  )

  // (1b) A single wild GPS fix ~5km away (urban multipath — 5836m mid-ride on
  // 7/22): one tick must not fire a deviation or replan; deviation handling
  // needs the distance to persist across two consecutive ticks.
  const glitchAt = { lat: chosen.onAt.lat + 0.045, lon: chosen.onAt.lon }
  const glitch = await tick(glitchAt, 1)
  const glitchRecover = await tick(chosen.onAt, 3)
  console.log(
    '[glitch] 1 tick 5km off + 3 ticks back on: ' +
      `${glitch.deviationCount + glitchRecover.deviationCount} deviation ` +
      `notification(s), forbidden: [${glitch.forbidden
        .concat(glitchRecover.forbidden)
        .join(', ')}]`
  )

  // (2) The rider goes their own way, ~355m off the planned line.
  await page.setGeolocation({
    accuracy: 10,
    latitude: chosen.offAt.lat,
    longitude: chosen.offAt.lon
  })
  const offRoute = await tick(chosen.offAt, TICKS)
  console.log(
    `[off-route] ${TICKS} ticks off the planned line: ` +
      `${offRoute.deviationCount} deviation notification(s), ` +
      `forbidden actions: [${offRoute.forbidden.join(', ')}]`
  )

  // [gomode/turn-timing ADDENDUM] While still off the line (before the quiet
  // replan lands), deviated ticks must be turn-silent. Kept as one separate
  // block — this call plus the function at the end of the file — so the merge
  // with gomode/reroute-scope's changes to this script stays mechanical.
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  await verifyTurnSilenceWhileDeviated(page, chosen.offAt)

  // Give the quiet replan's isolated plan request time to land: the swap is
  // visible as the active itinerary's origin moving to the rider's position.
  // (startTime is NOT a usable signal — OTP rounds departures to the minute.)
  await page
    .waitForFunction(
      (riderLat) => {
        const g = window.store.getState().otp.goMode
        const originLat = g.activeItinerary?.legs?.[0]?.from?.lat
        return g.isActive && Math.abs((originLat ?? 0) - riderLat) < 0.005
      },
      { polling: 500, timeout: 20000 },
      chosen.offAt.lat
    )
    .catch(() => null) // timeout -> assertions below report the failure
  const after = await snapshot()

  const swapped =
    Math.abs((after.itineraryOriginLat ?? 0) - chosen.offAt.lat) < 0.005 &&
    after.itineraryOriginLat !== before.itineraryOriginLat
  console.log(
    `[after] screen=${after.mobileScreen}, ${after.searchCount} search(es), ` +
      `itinerary ${
        swapped ? 'quietly re-planned from the rider' : 'UNCHANGED'
      }, ` +
      `"Current location" recents: ${after.recentCurrentLocation}`
  )

  if (onRoute.deviationCount > 0 || onRoute.forbidden.length > 0) {
    throw new Error('FAIL: on-route riding produced deviation activity')
  }
  if (glitch.deviationCount + glitchRecover.deviationCount > 0) {
    throw new Error(
      'FAIL: a single-tick GPS glitch fired a deviation notification'
    )
  }
  if (glitch.forbidden.length + glitchRecover.forbidden.length > 0) {
    throw new Error('FAIL: a single-tick GPS glitch triggered search machinery')
  }
  if (offRoute.deviationCount > 1) {
    throw new Error(
      `FAIL: ${offRoute.deviationCount} Off Route notifications in ${TICKS} ` +
        'ticks — dedup is not holding'
    )
  }
  if (offRoute.forbidden.length > 0) {
    throw new Error(
      `FAIL: deviation triggered visible search machinery: [${offRoute.forbidden.join(
        ', '
      )}]`
    )
  }
  if (after.mobileScreen !== before.mobileScreen) {
    throw new Error(
      `FAIL: mobile screen changed ${before.mobileScreen} -> ${after.mobileScreen}`
    )
  }
  if (after.searchCount !== before.searchCount) {
    throw new Error(
      `FAIL: deviation created ${after.searchCount - before.searchCount} new ` +
        'active search(es)'
    )
  }
  if (!swapped) {
    throw new Error(
      'FAIL: itinerary was not quietly re-planned from the rider position'
    )
  }
  if (after.recentCurrentLocation > 0) {
    throw new Error('FAIL: the replan leaked a "Current location" recent place')
  }
  // The banner used to claim "one deduped notification". Since 74ebaf49 the
  // Off Route card is withheld outright when a quiet replan is imminent — which
  // it always is here — so this phase now legitimately sees zero, and the
  // assertions above only ever bounded the count from ABOVE. Say what was
  // actually checked.
  console.log(
    '\nPASS: off-route biking quietly re-plans in place (even after a ' +
      `settled-empty reroute), ${offRoute.deviationCount} deviation ` +
      'notification(s) (never more than one), single-tick GPS glitches ' +
      'ignored, no search screen, no recents pollution, and deviated ticks ' +
      'stayed turn-silent (frozen wrist card).'
  )

  // ------------------------------------------------------------------------
  // Phase 2 (7/29): bike access leg + transit suffix. The deviation replan
  // must be scoped to the access chain — same boarding stop, same departure,
  // every downstream leg untouched — and must not trip MISSED_BUS while the
  // bus hasn't departed.
  console.log('\n[phase2] bike access + transit suffix')

  // End phase 1's trip before planning phase 2's.
  //
  // Phase 1's trip stays live otherwise, and its GPS watch can deliver one more
  // fix at phase 1's position AFTER phase 2's beginGoMode. matchPositionToRoute
  // only ever searches FORWARD from goMode.routeMatch.legIndex, so a single
  // stale fix that lands nearer phase 2's BUS leg latches the anchor there for
  // the whole phase: the trip "starts" on leg 1, and the access-leg replan
  // under test then correctly refuses to run, because
  // shouldQuietReplanAccessLeg rejects a transit leg by design. That is what
  // 'phase 2 itinerary was not quietly re-planned' was really reporting — a
  // harness that never put the rider on the bike leg — and, before that, what
  // 'does not start at the rider position' was reporting too. A clean page at
  // the same coordinates on the same itinerary starts on leg 0 at 0 m.
  await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const goMode = await import('/lib/actions/go-mode.js')
    window.store.dispatch(goMode.endGoMode())
  })
  await page.waitForFunction(
    () => !window.store.getState().otp.goMode.isActive,
    { polling: 200, timeout: 10000 }
  )

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
    TO2
  )

  // Wait until some search returns a bike-access + transit itinerary.
  await page.waitForFunction(
    () => {
      const searches = window.store.getState().otp.searches || {}
      return Object.values(searches)
        .flatMap((s) => s.response || [])
        .flatMap((r) => r?.plan?.itineraries || [])
        .some((it) => {
          const legs = it.legs || []
          const t = legs.findIndex((l) => l.transitLeg)
          return t > 0 && legs.slice(0, t).some((l) => l.mode === 'BICYCLE')
        })
    },
    { polling: 500, timeout: 60000 }
  )

  // Pick the itinerary, record the transit-suffix contract (boarding stop id,
  // its departure, and a signature of every downstream leg), and compute
  // on/off positions on the bike access leg like phase 1.
  const chosen2 = await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const pm = await import('/lib/util/go-mode/position-matching.js')
    const searches = window.store.getState().otp.searches || {}
    const itins = Object.values(searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
    const ok = itins.filter((it) => {
      const legs = it.legs || []
      const t = legs.findIndex((l) => l.transitLeg)
      return t > 0 && legs.slice(0, t).some((l) => l.mode === 'BICYCLE')
    })
    if (!ok.length) return null
    ok.sort((a, b) => a.duration - b.duration)
    const itin = ok[0]
    window.__itin2 = itin
    // The suffix contract: identity can't cross the page boundary, so compare
    // signatures (route/stop ids and times pin everything that matters).
    window.__legSig = (l) => ({
      endTime: Number(l.endTime),
      fromStop: l.from?.stop?.gtfsId || null,
      mode: l.mode,
      routeId: (l.route && l.route.id) || l.routeId || null,
      startTime: Number(l.startTime),
      toStop: l.to?.stop?.gtfsId || null
    })
    const boardLegIndex = itin.legs.findIndex((l) => l.transitLeg)
    const bikeLegIndex = itin.legs.findIndex((l) => l.mode === 'BICYCLE')
    const poly = pm.decodeLegGeometry(itin.legs[bikeLegIndex])
    const cum = pm.calculateCumulativeDistances(poly)
    let i = cum.findIndex((d) => d >= cum[cum.length - 1] * 0.4)
    if (i < 1) i = Math.floor(poly.length / 2)
    const [lat, lon] = poly[i]
    return {
      boardStartTime: Number(itin.legs[boardLegIndex].startTime),
      boardStopId: itin.legs[boardLegIndex].from?.stop?.gtfsId || null,
      downstream: itin.legs.slice(boardLegIndex).map(window.__legSig),
      offAt: { lat: lat + 0.005, lon },
      onAt: { lat, lon }
    }
  })
  if (!chosen2) {
    throw new Error('FAIL: no bike-access + transit itinerary for phase 2')
  }

  await page.setGeolocation({
    accuracy: 10,
    latitude: chosen2.onAt.lat,
    longitude: chosen2.onAt.lon
  })
  // Refresh the browser's cached fix to the position just set.
  // startGoModeTracking's getCurrentPosition carries maximumAge: 5000, so
  // without this it serves the reading cached during phase 1 — about a
  // kilometre from phase 2's origin — roughly 300 ms after the trip starts.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        navigator.geolocation.getCurrentPosition(resolve, resolve, {
          maximumAge: 0,
          timeout: 5000
        })
      )
  )

  await page.evaluate(async (at) => {
    // eslint-disable-next-line import/no-absolute-path
    const goMode = await import('/lib/actions/go-mode.js')
    // Same dispatch window.__beginGoMode makes; done here so the first fix can
    // be landed in the same task as START_GO_MODE.
    window.store.dispatch(goMode.beginGoMode(window.__itin2))
    // Whichever fix arrives FIRST decides this phase.
    //
    // START_GO_MODE nulls routeMatch, so the first position update anchors the
    // matcher — and matchPositionToRoute only ever searches FORWARD from
    // goMode.routeMatch.legIndex. It does not null tracking.lastPosition, and
    // startGoModeTracking's getCurrentPosition carries maximumAge: 5000, so
    // what actually landed first here was phase 1's position (44.92871,
    // -93.27405 — phase 1's own offAt, ~1 km away). That sits 307 m from
    // phase 2's BUS leg and anchors the rider onto it for the whole phase,
    // where shouldQuietReplanAccessLeg refuses to run for exactly the right
    // reason. No later fix at onAt can undo it: the search is forward-only.
    //
    // A clean page at these coordinates on this itinerary starts on leg 0 at
    // 0 m, so there is nothing wrong with the app here — the phase just has to
    // say where the rider is before asserting about them.
    goMode.handlePositionUpdate({
      coords: {
        accuracy: 10,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        latitude: at.lat,
        longitude: at.lon,
        speed: 4
      },
      timestamp: Date.now()
    })(window.store.dispatch, () => window.store.getState())
  }, chosen2.onAt)
  await page.waitForFunction(
    () => {
      const g = window.store.getState().otp.goMode
      // Same object reference: __beginGoMode stores the itinerary as-is.
      return g.isActive && g.activeItinerary === window.__itin2
    },
    { polling: 300, timeout: 20000 }
  )
  // Everything below asserts about a deviation off the BIKE ACCESS leg, so
  // establish that the trip really is on one before asserting anything. Left
  // unchecked, this phase reported the access-leg replan as broken when the
  // rider had simply been anchored onto the bus leg, where that replan is
  // supposed to refuse.
  const startLeg = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    const legs = g.activeItinerary?.legs || []
    const i = g.routeMatch?.legIndex ?? g.progress?.currentLegIndex ?? 0
    return {
      distance: g.routeMatch?.distanceFromRoute ?? null,
      index: i,
      mode: legs[i]?.mode ?? null,
      transit: !!legs[i]?.transitLeg
    }
  })
  console.log(
    `[phase2 setup] boarding ${chosen2.boardStopId} at ` +
      `${new Date(chosen2.boardStartTime).toISOString()}, ` +
      `${chosen2.downstream.length} suffix leg(s); rider on leg ` +
      `${startLeg.index} (${startLeg.mode}) ` +
      `${Math.round(startLeg.distance ?? -1)}m from it`
  )
  if (startLeg.transit || startLeg.mode !== 'BICYCLE') {
    throw new Error(
      `FAIL: phase 2 setup put the rider on leg ${startLeg.index} ` +
        `(${startLeg.mode}), not the bike access leg — the access-leg replan ` +
        'this phase tests would refuse to run there for the right reason'
    )
  }

  // Phase 1's quiet replan armed the 60s wall-clock throttle
  // (QUIET_REPLAN_MIN_INTERVAL_MS) — wait it out so phase 2's deviation can
  // replan on its first ROUTE_DEVIATION rather than the 120s dedup retry.
  await sleep(61000)

  await page.setGeolocation({
    accuracy: 10,
    latitude: chosen2.offAt.lat,
    longitude: chosen2.offAt.lon
  })
  const offRoute2 = await tick(chosen2.offAt, TICKS)
  console.log(
    `[phase2 off-route] ${TICKS} ticks off the bike access leg: ` +
      `${offRoute2.deviationCount} deviation notification(s), ` +
      `${offRoute2.missedCount} MISSED_BUS, ` +
      `forbidden actions: [${offRoute2.forbidden.join(', ')}]`
  )

  // The scoped replan lands as a whole-itinerary swap (new object) whose
  // suffix must be byte-identical — wait for the swap, then check the suffix.
  await page
    .waitForFunction(
      () => {
        const g = window.store.getState().otp.goMode
        return g.isActive && g.activeItinerary !== window.__itin2
      },
      { polling: 500, timeout: 20000 }
    )
    .catch(() => null) // timeout -> assertions below report the failure
  const after2 = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    const legs = g.activeItinerary?.legs || []
    const boardLegIndex = legs.findIndex((l) => l.transitLeg)
    return {
      boardStartTime:
        boardLegIndex >= 0 ? Number(legs[boardLegIndex].startTime) : null,
      boardStopId:
        boardLegIndex >= 0
          ? legs[boardLegIndex].from?.stop?.gtfsId || null
          : null,
      downstream:
        boardLegIndex >= 0
          ? legs.slice(boardLegIndex).map(window.__legSig)
          : [],
      mobileScreen: window.store.getState().otp.ui?.mobileScreen,
      originLat: legs[0]?.from?.lat,
      swapped: g.activeItinerary !== window.__itin2
    }
  })

  await browser.close()

  if (offRoute2.forbidden.length > 0) {
    throw new Error(
      `FAIL: phase 2 deviation triggered visible search machinery: [${offRoute2.forbidden.join(
        ', '
      )}]`
    )
  }
  if (offRoute2.missedCount > 0) {
    throw new Error(
      'FAIL: phase 2 deviation fired MISSED_BUS while the bus had not departed'
    )
  }
  if (offRoute2.deviationCount > 1) {
    throw new Error(
      `FAIL: ${offRoute2.deviationCount} Off Route notifications in phase 2 — ` +
        'dedup is not holding'
    )
  }
  if (after2.mobileScreen !== after.mobileScreen) {
    throw new Error(
      `FAIL: phase 2 changed the screen ${after.mobileScreen} -> ${after2.mobileScreen}`
    )
  }
  if (!after2.swapped) {
    throw new Error(
      'FAIL: phase 2 itinerary was not quietly re-planned from the rider position'
    )
  }
  if (Math.abs((after2.originLat ?? 0) - chosen2.offAt.lat) >= 0.005) {
    throw new Error(
      'FAIL: phase 2 replanned itinerary does not start at the rider position'
    )
  }
  // The complaint-1 contract: the replan touched ONLY the access chain.
  if (
    after2.boardStopId !== chosen2.boardStopId ||
    after2.boardStartTime !== chosen2.boardStartTime
  ) {
    throw new Error(
      `FAIL: phase 2 moved the boarding — ${chosen2.boardStopId} @ ` +
        `${chosen2.boardStartTime} -> ${after2.boardStopId} @ ` +
        `${after2.boardStartTime}`
    )
  }
  if (
    JSON.stringify(after2.downstream) !== JSON.stringify(chosen2.downstream)
  ) {
    throw new Error(
      'FAIL: phase 2 changed a downstream leg — the transit suffix must be untouched'
    )
  }
  console.log(
    '\nPASS phase 2: bike-leg deviation re-planned the access chain only — ' +
      'same boarding stop and departure, all downstream legs untouched, no ' +
      'MISSED_BUS during deviation, still on GO_MODE.'
  )
}

// ============================================================================
// [gomode/turn-timing ADDENDUM] — one self-contained block, merge as a unit.
//
// 7/29: "The bike turn notification announces turns after you take them." Off
// the planned line the nearest-point projection is a fiction, so deviated
// ticks must produce NO turn guidance: no UPCOMING_TURN / TURN_ALERT
// notifications, no sticky turn-card (id 1) writes — and no id 1 cancels
// either. The card FREEZES while deviated (a 100 m-threshold flap must not
// churn cancel→repost on the wrist); boarding and trip end still clear it.
//
// The rejoin-side guarantees (2-tick announcement hold, no swept-cue burst)
// are pinned offline on real 7/29 data in
// __tests__/util/go-mode/turn-honesty-0729.ts — not re-asserted here, where
// the quiet replan may legitimately swap the itinerary mid-phase.
// ============================================================================
async function verifyTurnSilenceWhileDeviated(page, offAt) {
  // Fake Capacitor bridge (same pattern as verify-turn-by-turn.js, injected
  // long after beginGoMode) so the real sendPush/cancelPush path records
  // sticky-card traffic instead of no-opping in the browser.
  await page.evaluate(() => {
    window.__pushLog = []
    if (!window.Capacitor) {
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
                  id: n.id,
                  kind: 'schedule',
                  title: n.title
                })
              )
              return Promise.resolve()
            }
          }
        }
      }
    }
  })

  // Let the previous phase's quiet replan settle before measuring anything.
  // If it lands mid-block instead, the itinerary-swap guard below breaks out
  // after a single tick and the block asserts nothing at all. Waiting makes the
  // starting point the same either way. A run where no replan comes still
  // proceeds: the rider is then genuinely off the ORIGINAL line, which is an
  // equally valid deviated window.
  await page
    .waitForFunction(
      (riderLat) => {
        const g = window.store.getState().otp.goMode
        const originLat = g.activeItinerary?.legs?.[0]?.from?.lat
        return g.isActive && Math.abs((originLat ?? 0) - riderLat) < 0.005
      },
      { polling: 300, timeout: 20000 },
      offAt.lat
    )
    .catch(() => null)

  // Deviate from whatever route is live RIGHT NOW, rather than reusing the
  // caller's off-route point.
  //
  // Since 94a69bba/74ebaf49 moved the quiet-replan decision ahead of the
  // notification pass, the replan the previous phase provoked has normally
  // already landed by the time this block runs: the itinerary now starts AT the
  // rider, so `chosen.offAt` is ON the new line (routeMatch.distanceFromRoute
  // ~2 m, isOnRoute true). The `activeItinerary !== startItinerary` guard below
  // cannot notice — it samples startItinerary after the swap, so it never
  // trips. The block was asserting turn-silence about a rider who was not
  // deviated at all: it passed when the fresh route happened to have no cue in
  // range and failed when it did (1 turn notification on three of four runs at
  // 8534746f, with no product change between them). That is the flake, and a
  // vacuous pass is no better than the false failure.
  //
  // A second ~555 m hop off the CURRENT line puts the rider genuinely off
  // route, and QUIET_REPLAN_MIN_COOLDOWN_MS (25 s, deviation.ts) is far longer
  // than this block, so no replan can rescue them mid-assertion.
  const deviateAt = await page.evaluate((at) => {
    const origin =
      window.store.getState().otp.goMode.activeItinerary?.legs?.[0]?.from
    const base = origin?.lat != null ? origin : at
    return { lat: base.lat + 0.005, lon: base.lon }
  }, offAt)
  await page.setGeolocation({
    accuracy: 10,
    latitude: deviateAt.lat,
    longitude: deviateAt.lon
  })

  const result = await page.evaluate(async (at) => {
    // eslint-disable-next-line import/no-absolute-path
    const goMode = await import('/lib/actions/go-mode.js')
    const startItinerary = window.store.getState().otp.goMode.activeItinerary
    let turnNotifications = 0
    let ticksCounted = 0
    let deviatedTicks = 0
    let swapped = false
    const spy = (action) => {
      if (typeof action === 'function') return window.store.dispatch(action)
      if (
        action?.type === 'ADD_NOTIFICATION' &&
        (action.payload?.type === 'UPCOMING_TURN' ||
          action.payload?.type === 'TURN_ALERT')
      ) {
        turnNotifications += 1
      }
      return window.store.dispatch(action)
    }
    const getState = () => window.store.getState()
    for (let i = 0; i < 6; i++) {
      // Stop counting once the quiet replan swaps the itinerary: a fresh leg
      // from the rider's own position puts them back ON route, where turn
      // guidance is legitimate again.
      if (getState().otp.goMode.activeItinerary !== startItinerary) {
        swapped = true
        break
      }
      const position = {
        coords: {
          accuracy: 10,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          latitude: at.lat,
          longitude: at.lon,
          speed: 4
        },
        timestamp: Date.now() + i * 1000
      }
      goMode.handlePositionUpdate(position)(spy, getState)
      ticksCounted += 1
      // Only ticks the app itself judged off-route can carry this assertion.
      // (The deviation smoother takes the smaller of this tick's and last
      // tick's distance, so the first tick after the hop still reads on-route —
      // by design, and correctly not counted.)
      if (getState().otp.goMode.routeMatch?.isOnRoute === false) {
        deviatedTicks += 1
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    const pushLog = window.__pushLog || []
    return {
      deviatedTicks,
      stickyCancels: pushLog.filter((p) => p.kind === 'cancel' && p.id === 1)
        .length,
      stickyWrites: pushLog.filter((p) => p.kind === 'schedule' && p.id === 1)
        .length,
      swapped,
      ticksCounted,
      turnNotifications
    }
  }, deviateAt)

  console.log(
    `[turn-silence] ${result.deviatedTicks} of ${result.ticksCounted} ` +
      'tick(s) off route' +
      `${result.swapped ? ' (stopped at quiet-replan swap)' : ''}: ` +
      `${result.turnNotifications} turn notification(s), ` +
      `${result.stickyWrites} sticky-card write(s), ` +
      `${result.stickyCancels} sticky-card cancel(s)`
  )
  // Say so rather than passing on an assertion that never ran. This block used
  // to report a clean PASS when every tick was on-route.
  if (result.deviatedTicks === 0) {
    throw new Error(
      'FAIL: no off-route tick was produced, so turn-silence was never ' +
        'exercised — the assertion would have passed vacuously'
    )
  }
  if (result.turnNotifications > 0) {
    throw new Error(
      `FAIL: ${result.turnNotifications} turn notification(s) fired while ` +
        'deviated — off-route projections must announce nothing'
    )
  }
  if (result.stickyWrites > 0) {
    throw new Error(
      `FAIL: ${result.stickyWrites} sticky turn-card write(s) while deviated`
    )
  }
  if (result.stickyCancels > 0) {
    throw new Error(
      `FAIL: ${result.stickyCancels} sticky turn-card cancel(s) while ` +
        'deviated — the card must freeze, not churn'
    )
  }

  // Put the rider back where the caller left them: the phases after this one
  // assert on the itinerary origin sitting at `offAt`, and this block's extra
  // hop must not leak into that.
  await page.setGeolocation({
    accuracy: 10,
    latitude: offAt.lat,
    longitude: offAt.lon
  })
}
// ========================== [end ADDENDUM] ==================================

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
