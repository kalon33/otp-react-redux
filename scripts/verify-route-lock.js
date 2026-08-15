/* eslint-disable no-console */
/**
 * Route-lock verification: "bike me, but only put me on the 18."
 *
 * This OTP's plan() has no include-style route filter, so a lock is expressed
 * by banning every OTHER route in the graph. That's easy to get subtly wrong —
 * a route missed off the banned list stays legal, and the rider gets a trip on
 * a bus they didn't ask for. Probing the graph directly during design showed
 * both failure modes worth guarding: the second (suburban) feed is easy to
 * leave out, and at OTP's default bike reluctance a locked plan degenerates
 * into a token 1-minute bus hop with the rest pedalled.
 *
 * Asserts, for a real Bloomington -> downtown Minneapolis search locked to
 * Route 18:
 *   1. the outgoing plan query carries banned.routes covering every other
 *      route in the graph (both feeds) and never the locked one;
 *   2. no returned itinerary rides any transit route other than 1:18;
 *   3. at least one itinerary actually rides the 18, with a bike leg on at
 *      least one end — i.e. the lock produced the trip that was asked for,
 *      not just an empty result;
 *   4. releasing the lock clears banned.routes again.
 *
 * The bike-the-whole-way itinerary OTP also returns is expected and allowed —
 * it is kept deliberately, flagged in the UI rather than hidden.
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const LOCKED_ROUTE = '1:18'
// On Nicollet in south Minneapolis, a few blocks off the route's line so the
// access legs have to be ridden rather than walked.
const FROM = { lat: 44.885, lon: -93.295, name: 'Test origin' }
const TO = { lat: 44.978, lon: -93.25, name: 'Test destination' }
// Geography-specific to the pair above: at a sane bike reluctance this query
// rides ~6.6km of the 18, and ~0.7km at a low one.
const MIN_RIDDEN_METERS = 2000

const planQueries = []

function fail(message) {
  console.log(`FAIL: ${message}`)
  process.exitCode = 1
}

async function runSearch(page, routeId) {
  planQueries.length = 0
  await page.evaluate(
    async (from, to, lockId) => {
      // eslint-disable-next-line import/no-absolute-path
      const form = await import('/lib/actions/form.js')
      // eslint-disable-next-line import/no-absolute-path
      const routeLock = await import('/lib/actions/route-lock.ts')
      // eslint-disable-next-line import/no-absolute-path
      const api = await import('/lib/actions/api.js')
      window.store.dispatch(
        form.setQueryParam({ departArrive: 'NOW', from, to })
      )
      await window.store.dispatch(routeLock.setRouteLock(lockId))
      window.store.dispatch(api.routingQuery())
    },
    FROM,
    TO,
    routeId
  )

  await page.waitForFunction(
    () => {
      const searches = window.store.getState().otp.searches || {}
      return Object.values(searches).some((s) => s.pending === 0)
    },
    { polling: 500, timeout: 90000 }
  )

  return page.evaluate(() => {
    const searches = window.store.getState().otp.searches || {}
    const latest = Object.values(searches).pop()
    return {
      itineraries: (latest?.response || []).flatMap(
        (r) => r?.plan?.itineraries || []
      ),
      routeLock: window.store.getState().otp.currentQuery.routeLock
    }
  })
}

const transitRouteIds = (itin) =>
  (itin.legs || [])
    .filter((leg) => leg.transitLeg || leg.route)
    .map((leg) => leg.route?.id || leg.route?.gtfsId || leg.routeId)
    .filter(Boolean)

async function main() {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox'],
    executablePath: CHROME,
    headless: 'new'
  })
  const page = await browser.newPage()
  await page.setViewport({ height: 850, width: 393 })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  await page.setRequestInterception(true)
  page.on('request', (req) => {
    if (req.url().includes('/gtfs/v1') && req.method() === 'POST') {
      try {
        const body = JSON.parse(req.postData() || '{}')
        if (/query Plan/.test(body.query || ''))
          planQueries.push(body.variables)
      } catch (e) {
        // A body we can't parse isn't a plan query we can check.
      }
    }
    req.continue()
  })

  await page.goto(APP, { timeout: 60000, waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.store, { timeout: 30000 })

  // The full route index is what the banned complement is built from.
  await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const api = await import('/lib/actions/api.js')
    window.store.dispatch(api.findRoutesIfNeeded())
  })
  await page.waitForFunction(
    () =>
      Object.keys(window.store.getState().otp.transitIndex?.routes || {})
        .length > 0,
    { polling: 300, timeout: 30000 }
  )
  const allRouteIds = await page.evaluate(() =>
    Object.keys(window.store.getState().otp.transitIndex.routes)
  )
  console.log(`route index: ${allRouteIds.length} routes`)

  // --- 1. locked search --------------------------------------------------
  const locked = await runSearch(page, LOCKED_ROUTE)

  if (locked.routeLock?.id !== LOCKED_ROUTE) {
    fail(`route lock not applied (got ${JSON.stringify(locked.routeLock)})`)
  } else {
    console.log(`PASS: lock applied — "${locked.routeLock.label}"`)
  }

  if (!planQueries.length) {
    fail('no plan query was sent')
  } else {
    const banned = (planQueries[0]?.banned?.routes || '').split(',')
    const missing = allRouteIds.filter(
      (id) => id !== LOCKED_ROUTE && !banned.includes(id)
    )
    if (banned.includes(LOCKED_ROUTE)) {
      fail('the locked route is itself banned')
    } else if (missing.length) {
      fail(
        `${missing.length} route(s) left unbanned, e.g. ${missing
          .slice(0, 5)
          .join(', ')}`
      )
    } else {
      const feeds = [...new Set(banned.map((id) => id.split(':')[0]))].sort()
      console.log(
        `PASS: banned ${banned.length} routes across feed(s) ${feeds.join(
          ', '
        )}`
      )
    }
  }

  if (!locked.itineraries.length) {
    fail('the locked search returned no itineraries at all')
  }

  const strays = locked.itineraries.flatMap((itin) =>
    transitRouteIds(itin).filter((id) => id !== LOCKED_ROUTE)
  )
  if (strays.length) {
    fail(`itineraries ride other routes: ${[...new Set(strays)].join(', ')}`)
  } else {
    console.log(
      `PASS: no stray transit legs across ${locked.itineraries.length} itineraries`
    )
  }

  const ridden = locked.itineraries.filter((itin) =>
    transitRouteIds(itin).includes(LOCKED_ROUTE)
  )
  if (!ridden.length) {
    // Silence here would be the worst outcome: a "locked" search that quietly
    // returns nothing but a bike ride looks like the feature working.
    fail(`no itinerary actually rides ${LOCKED_ROUTE}`)
  } else {
    const withBike = ridden.filter((itin) =>
      (itin.legs || []).some((leg) => leg.mode === 'BICYCLE')
    )
    if (!withBike.length) {
      fail(`${LOCKED_ROUTE} is ridden, but no itinerary bikes to or from it`)
    } else {
      const example = withBike[0].legs
        .map(
          (leg) =>
            `${leg.mode}${
              leg.route ? `(${leg.route.id || leg.route.gtfsId})` : ''
            }`
        )
        .join(' -> ')
      console.log(
        `PASS: ${withBike.length}/${locked.itineraries.length} ride the route with a bike leg — ${example}`
      )
    }

    // A lock that technically boards the route for 300m and pedals the rest is
    // not the trip anyone asked for. It's what a low bike reluctance produces,
    // and "I'll bike to the 18" reads to the preferences model as exactly that
    // — hence the floor in withRouteLockPrefs. On this query the route should
    // carry kilometres, not blocks.
    const bestRidden = Math.max(
      ...ridden.map((itin) =>
        (itin.legs || [])
          .filter((leg) => transitRouteIds({ legs: [leg] }).length)
          .reduce((sum, leg) => sum + (leg.distance || 0), 0)
      )
    )
    if (bestRidden < MIN_RIDDEN_METERS) {
      fail(
        `the 18 only carries ${Math.round(
          bestRidden
        )}m at best — the lock is being pedalled past`
      )
    } else {
      console.log(
        `PASS: the route carries up to ${(bestRidden / 1000).toFixed(
          1
        )}km of the trip`
      )
    }
  }

  const bikeOnly = locked.itineraries.filter(
    (itin) => !transitRouteIds(itin).length
  )
  console.log(
    `note: ${bikeOnly.length} bike-the-whole-way itinerary(ies) returned (kept and flagged by design)`
  )

  // --- 2. releasing the lock --------------------------------------------
  const released = await runSearch(page, null)
  if (released.routeLock) {
    fail('route lock survived being cleared')
  } else if (planQueries.some((v) => v?.banned?.routes)) {
    fail('banned.routes still sent after the lock was cleared')
  } else {
    console.log('PASS: clearing the lock clears banned.routes')
  }

  await browser.close()
  console.log(
    process.exitCode
      ? '\nRoute lock verification FAILED'
      : '\nRoute lock verified'
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
