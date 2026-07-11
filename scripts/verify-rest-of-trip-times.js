/* eslint-disable no-console */
/**
 * Item 4 verification: rest-of-trip times must come from the BOARDED trip
 * (its GTFS-RT stop times), not the route's next scheduled departure.
 *
 * Drives the real app on a live bus (same harness as verify-onboard-options),
 * starts guidance, lets refreshLiveLegTimes run a few cycles, then compares:
 *   - liveLegTimes[busLeg].alightEpoch  (feeds the TripSheet rest-of-trip rows)
 *   - activeItinerary busLeg.endTime    (build-time anchor)
 *   - progress.destinationArrivalTime   (header "Off at HH:MM")
 * against ground truth fetched at the same moment: the boarded trip's own
 * realtime arrival at the alight stop (trip(id: <boarded tripId>)), plus the
 * route's next-departure at that stop for contrast.
 */
const path = require('path')

const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const API = process.env.OTP_API || 'https://tre.hopto.org:9966/otp/gtfs/v1'
const OUT = process.env.OUT_DIR || __dirname
// Vite dev output is untranspiled; puppeteer's bundled Chromium is too old for
// it -- default to the system Chrome.
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'
const SETTLE_MS = 75000 // > 3 refreshLiveLegTimes cycles (<=20s each)

async function gql(query) {
  const res = await fetch(API, {
    body: JSON.stringify({ query }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  })
  return res.json()
}

const fmt = (ms) =>
  ms == null
    ? 'n/a'
    : new Date(ms).toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: 'America/Chicago'
      })

async function main() {
  // ---- live vehicle whose trip is actually IN PROGRESS ----
  // (a vehicle heading to layover reports its NEXT trip, which may be hours away)
  let picked = null
  const nowS = Date.now() / 1000
  outer: for (const routeId of [
    '1:904',
    '1:18',
    '1:5',
    '1:10',
    '1:2',
    '1:903'
  ]) {
    const d = await gql(`{ route(id: "${routeId}") {
      gtfsId shortName longName
      patterns { vehiclePositions {
        vehicleId lat lon trip { gtfsId tripHeadsign }
        stopRelationship { stop { gtfsId name } }
      } } } }`)
    const route = d?.data?.route
    const vehicles = (route?.patterns || []).flatMap(
      (p) => p.vehiclePositions || []
    )
    for (const v of vehicles) {
      if (!v.stopRelationship?.stop?.gtfsId) continue
      const tq = await gql(`{ trip(id: "${v.trip.gtfsId}") {
        stoptimesForDate { scheduledDeparture scheduledArrival serviceDay } } }`)
      const sts = tq?.data?.trip?.stoptimesForDate || []
      if (sts.length < 4) continue
      const first = sts[0].serviceDay + sts[0].scheduledDeparture
      const lastT =
        sts[sts.length - 1].serviceDay + sts[sts.length - 1].scheduledArrival
      // in progress with >=5 min of ride left
      if (first < nowS && lastT > nowS + 300) {
        picked = { route, vehicle: v }
        break outer
      }
    }
  }
  if (!picked) throw new Error('no live in-progress vehicles found')
  const { route, vehicle } = picked
  const tripId = vehicle.trip.gtfsId
  console.log(
    `[setup] ${vehicle.vehicleId} on ${route.shortName || route.longName} ` +
      `trip ${tripId} "${vehicle.trip.tripHeadsign}" next: ${vehicle.stopRelationship.stop.name}`
  )

  const tripQ = await gql(`{ trip(id: "${tripId}") {
    stoptimesForDate { scheduledArrival realtimeArrival realtimeState serviceDay
      stop { gtfsId name lat lon } } } }`)
  const stopTimes = tripQ?.data?.trip?.stoptimesForDate || []
  if (stopTimes.length < 3) throw new Error('too few stop times')
  const last = stopTimes[stopTimes.length - 1].stop
  const dest = { lat: last.lat + 0.004, lon: last.lon + 0.004, name: 'Dest' }

  // ---- drive the app ----
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
    latitude: vehicle.lat,
    longitude: vehicle.lon
  })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(APP, { timeout: 60000, waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.store, { timeout: 30000 })

  await page.evaluate(
    async (ride, destination) => {
      // Browser-context: Vite dev-server module URLs, not Node imports.
      // eslint-disable-next-line import/no-absolute-path
      const gm = await import('/lib/actions/go-mode.ts')
      // eslint-disable-next-line import/no-absolute-path
      const form = await import('/lib/actions/form.js')
      window.store.dispatch(form.setQueryParam({ to: destination }))
      window.store.dispatch(
        gm.setRiding({
          boardedAt: Date.now(),
          headsign: ride.headsign,
          legIndex: -1,
          offRouteSince: null,
          routeId: ride.routeId,
          routeShortName: ride.routeShortName,
          tripId: ride.tripId,
          vehicleId: ride.vehicleId
        })
      )
      window.store.dispatch(gm.beginOnboardFlow())
    },
    {
      headsign: vehicle.trip.tripHeadsign,
      routeId: route.gtfsId,
      routeShortName: route.shortName || route.longName,
      tripId,
      vehicleId: vehicle.vehicleId
    },
    dest
  )

  await page.waitForFunction(
    () => {
      const ob = window.store.getState().otp.goMode.onboard
      return ob.status === 'ready' || ob.status === 'error'
    },
    { polling: 500, timeout: 90000 }
  )
  // choose the FIRST (default) option — item 4 is about times, not choice
  const started = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent.trim() === 'Go'
    )
    if (!btn) return false
    btn.click()
    return true
  })
  if (!started) throw new Error('no Go button — onboard flow failed')
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.activeItinerary != null,
    { polling: 300, timeout: 20000 }
  )
  console.log(
    `[guidance] started; settling ${
      SETTLE_MS / 1000
    }s for live-time refresh cycles...`
  )
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

  // ---- capture app state + ground truth at the same moment ----
  const app = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    const legs = g.activeItinerary?.legs || []
    const busIdx = legs.findIndex((l) => l.transitLeg)
    const bus = legs[busIdx] || {}
    return {
      alightStopId: bus.to?.stop?.gtfsId,
      alightStopName: bus.to?.name,
      busEndTime: Number(bus.endTime),
      busIdx,
      currentLegIndex: g.progress?.currentLegIndex,
      destinationArrivalTime: g.progress?.destinationArrivalTime,
      liveLegTimes: g.liveLegTimes,
      ridingTripId: g.riding?.tripId,
      timeRemaining: g.progress?.timeRemaining
    }
  })
  const nowMs = Date.now()

  const truthQ = await gql(`{ trip(id: "${tripId}") {
    stoptimesForDate { scheduledArrival realtimeArrival realtimeState serviceDay
      stop { gtfsId } } } }`)
  const sts = truthQ?.data?.trip?.stoptimesForDate || []
  const alightSt = sts.find((st) => st.stop.gtfsId === app.alightStopId)
  if (!alightSt)
    throw new Error(`alight stop ${app.alightStopId} not in boarded trip`)
  const live = ['UPDATED', 'ADDED', 'MODIFIED'].includes(alightSt.realtimeState)
  const truthEpoch =
    (alightSt.serviceDay +
      (live ? alightSt.realtimeArrival : alightSt.scheduledArrival)) *
    1000

  // contrast: route's next departure at the alight stop (any trip)
  const nd = await gql(`{ stop(id: "${app.alightStopId}") {
    stoptimesForPatterns(numberOfDepartures: 30) {
      pattern { route { gtfsId } }
      stoptimes { scheduledDeparture realtimeDeparture realtimeState serviceDay
        trip { gtfsId } } } } }`)
  const deps = (nd?.data?.stop?.stoptimesForPatterns || [])
    .filter((p) => p.pattern.route.gtfsId === route.gtfsId)
    .flatMap((p) => p.stoptimes)
    .map((st) => ({
      epoch:
        (st.serviceDay +
          (['UPDATED', 'ADDED', 'MODIFIED'].includes(st.realtimeState)
            ? st.realtimeDeparture
            : st.scheduledDeparture)) *
        1000,
      tripId: st.trip.gtfsId
    }))
    .filter((d) => d.epoch > nowMs)
    .sort((a, b) => a.epoch - b.epoch)
  const nextDep = deps[0]
  const nextOtherTrip = deps.find((d) => d.tripId !== tripId)

  const liveAlight = app.liveLegTimes?.[app.busIdx]?.alightEpoch ?? null

  console.log('\n===== COMPARISON (all America/Chicago) =====')
  console.log(
    `boarded trip:                    ${app.ridingTripId} (${
      live ? 'LIVE RT' : 'schedule only'
    })`
  )
  console.log(
    `alight stop:                     ${app.alightStopName} (${app.alightStopId})`
  )
  console.log(`GROUND TRUTH boarded-trip arr:   ${fmt(truthEpoch)}`)
  console.log(
    `liveLegTimes alightEpoch:        ${fmt(
      liveAlight
    )}  (TripSheet rest-of-trip row)`
  )
  console.log(
    `busLeg.endTime:                  ${fmt(
      app.busEndTime
    )}  (build-time anchor)`
  )
  console.log(
    `header destinationArrivalTime:   ${fmt(
      app.destinationArrivalTime
    )}  (current leg idx ${app.currentLegIndex})`
  )
  console.log(
    `header timeRemaining:            ${Math.round(app.timeRemaining / 60)} min`
  )
  console.log(
    `route next departure @ stop:     ${fmt(nextDep?.epoch)} (trip ${
      nextDep?.tripId
    })`
  )
  console.log(
    `next OTHER-trip departure:       ${fmt(nextOtherTrip?.epoch)} (trip ${
      nextOtherTrip?.tripId
    })`
  )

  const dLive =
    liveAlight != null ? Math.abs(liveAlight - truthEpoch) / 1000 : null
  const dEnd = Math.abs(app.busEndTime - truthEpoch) / 1000
  const dHdr =
    app.destinationArrivalTime != null
      ? Math.abs(app.destinationArrivalTime - truthEpoch) / 1000
      : null
  console.log('\n===== DELTAS vs boarded-trip ground truth =====')
  console.log(
    `liveLegTimes:  ${dLive == null ? 'MISSING' : dLive.toFixed(0) + 's'}`
  )
  console.log(`busLeg.endTime: ${dEnd.toFixed(0)}s`)
  console.log(
    `header ETA:     ${
      dHdr == null ? 'n/a (not on transit leg yet)' : dHdr.toFixed(0) + 's'
    }`
  )
  if (nextOtherTrip) {
    const dOther =
      Math.abs((liveAlight ?? app.busEndTime) - nextOtherTrip.epoch) / 1000
    console.log(
      `(distance of shown time from the NEXT OTHER bus: ${dOther.toFixed(
        0
      )}s — should be large)`
    )
  }

  // ---- open the trip sheet and screenshot the rest-of-trip rows ----
  const opened = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) =>
      x.textContent.includes('View trip')
    )
    if (b) b.click()
    return !!b
  })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  await page.screenshot({ path: path.join(OUT, 'rest-of-trip-times.png') })
  console.log(
    `\n[screenshot] trip sheet ${
      opened ? 'opened' : 'NOT FOUND'
    } -> rest-of-trip-times.png`
  )

  await browser.close()

  const pass = dLive != null && dLive <= 30
  if (!pass)
    throw new Error('liveLegTimes missing or drifted >30s from boarded-trip RT')
  console.log('\nPASS: rest-of-trip times track the boarded trip')
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
