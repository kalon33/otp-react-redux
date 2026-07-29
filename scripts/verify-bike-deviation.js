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
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9346, lon: -93.2624, name: 'Test destination' }

const TICKS = 12

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
        const spy = (action) => {
          if (typeof action === 'function') return window.store.dispatch(action)
          if (action?.type) seen.push(action.type)
          if (
            action?.type === 'ADD_NOTIFICATION' &&
            action.payload?.type === 'ROUTE_DEVIATION'
          ) {
            deviations.push(action.payload.id)
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
          )
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

  await browser.close()

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
  console.log(
    '\nPASS: off-route biking quietly re-plans in place (even after a ' +
      'settled-empty reroute), one deduped notification, single-tick GPS ' +
      'glitches ignored, no search screen, no recents pollution.'
  )
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
