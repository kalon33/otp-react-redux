/* eslint-disable no-console */
/**
 * Boarded-a-different-bus verification (7/22 evening trip: aboard Orange Line
 * bus 8148, sheet stuck on the PLANNED trip's times — "Times not matching /
 * when I start trip it doesn't change to bus I'm arriving for").
 *
 * The rider follows their planned itinerary, but the vehicle they're matched
 * to reports a DIFFERENT GTFS trip than the plan boarded. The tripId must
 * survive the whole chain with no rider interaction:
 *   (1) matchUserToVehicle carries the matched vehicle's tripId into
 *       goMode.vehicleMatch.match,
 *   (2) the sticky riding fact adopts the matched trip (not the planned one),
 *   (3) refreshLiveLegTimes polls the RIDDEN trip for the current leg, so the
 *       trip sheet's times are the rider's actual bus's,
 *   (4) the boarded-earlier auto-replan fires (tripMismatch path) and
 *       auto-applies a same-route itinerary — no card, no prompt.
 *
 * Harness: real app at :9967 (same as verify-auto-anchor), GPS simulation
 * along the planned itinerary, plus a synthetic vehicle-positions feed that
 * pins one vehicle to the rider's position with a real *other* trip's id
 * (deterministic — no dependence on a live bus being near the rider).
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const API = process.env.OTP_API || 'https://tre.hopto.org:9966/otp/gtfs/v1'
const OUT = process.env.OUT_DIR || __dirname
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const SIM_SPEED = 16
const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9778, lon: -93.2707, name: 'Downtown Minneapolis' }
const FAKE_VEHICLE_ID = 'TEST:8148'

const fmt = (ms) =>
  ms == null
    ? 'n/a'
    : new Date(ms).toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: 'America/Chicago'
      })

async function gql(query) {
  const res = await fetch(API, {
    body: JSON.stringify({ query }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  })
  if (!res.ok) {
    console.log(`[warn] OTP query HTTP ${res.status}`)
    return null
  }
  return res.json()
}

const LIVE = ['UPDATED', 'ADDED', 'MODIFIED']
const stEpoch = (st, dep) =>
  (st.serviceDay +
    (LIVE.includes(st.realtimeState)
      ? dep
        ? st.realtimeDeparture
        : st.realtimeArrival
      : dep
      ? st.scheduledDeparture
      : st.scheduledArrival)) *
  1000

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

  // ---- plan a walk→bus trip through the app's own pipeline ----
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

  const plan = await page.evaluate(async () => {
    // The app's own route-id extraction — legacy-converted legs vary in shape.
    // eslint-disable-next-line import/no-absolute-path
    const anchor = await import('/lib/util/go-mode/departure-anchor.ts')
    const searches = window.store.getState().otp.searches || {}
    const itins = Object.values(searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
    const ok = itins.filter((it) => {
      const legs = it.legs || []
      const firstTransit = legs.findIndex((l) => l.transitLeg)
      return (
        firstTransit >= 0 &&
        legs.slice(0, firstTransit).every((l) => !l.transitLeg)
      )
    })
    if (!ok.length) return null
    ok.sort((a, b) => a.startTime - b.startTime)
    window.__plannedItinerary = JSON.parse(JSON.stringify(ok[0]))
    const legs = ok[0].legs
    const busIdx = legs.findIndex((l) => l.transitLeg)
    const bus = legs[busIdx]
    return {
      alightStopId: bus.to?.stop?.gtfsId,
      alightStopName: bus.to?.name,
      boardStopId: bus.from?.stop?.gtfsId,
      busIdx,
      plannedBoard: Number(bus.startTime),
      plannedEnd: Number(bus.endTime),
      plannedTripId: bus.trip?.gtfsId || bus.tripId,
      routeId: anchor.getLegRouteId(bus),
      routeShortName: bus.routeShortName || bus.routeLongName
    }
  })
  if (!plan) throw new Error('no walk→bus itinerary found')
  console.log(
    `[setup] planned: ${plan.routeShortName} (route ${plan.routeId}) ` +
      `trip ${plan.plannedTripId} board ${fmt(plan.plannedBoard)} at ` +
      `${plan.boardStopId}, alight ${plan.alightStopName} ${fmt(
        plan.plannedEnd
      )}`
  )

  // ---- pick a real OTHER trip on the same route: the bus we'll pretend the
  // rider is actually on. Must serve both the board and alight stops so its
  // stop times can drive the displayed leg times. ----
  const nd = await gql(`{ stop(id: "${plan.boardStopId}") {
    stoptimesForPatterns(numberOfDepartures: 30) {
      pattern { route { gtfsId } }
      stoptimes { scheduledDeparture realtimeDeparture realtimeState serviceDay
        trip { gtfsId tripHeadsign } } } } }`)
  if (nd?.errors) {
    console.log('[warn] stop query errors:', JSON.stringify(nd.errors))
  }
  const allPatterns = nd?.data?.stop?.stoptimesForPatterns || []
  console.log(
    `[debug] board-stop patterns: ${allPatterns
      .map((p) => `${p.pattern.route.gtfsId}(${p.stoptimes.length})`)
      .join(' ')}`
  )
  const candidates = allPatterns
    .filter((p) => p.pattern.route.gtfsId === plan.routeId)
    .flatMap((p) => p.stoptimes)
    .map((st) => ({
      dep: stEpoch(st, true),
      headsign: st.trip.tripHeadsign,
      tripId: st.trip.gtfsId
    }))
    .filter((c) => c.tripId !== plan.plannedTripId && c.dep > Date.now())
    .sort((a, b) => a.dep - b.dep)

  let other = null
  let otherAlight = null
  const seenTripIds = new Set()
  for (const c of candidates) {
    if (seenTripIds.has(c.tripId)) continue
    seenTripIds.add(c.tripId)
    if (seenTripIds.size > 8) break
    const tq = await gql(`{ trip(id: "${c.tripId}") {
      stoptimesForDate { scheduledArrival realtimeArrival realtimeState
        serviceDay stop { gtfsId name } } } }`)
    if (tq?.errors) {
      console.log(
        `[warn] trip ${c.tripId} query failed:`,
        JSON.stringify(tq.errors).slice(0, 200)
      )
    }
    const sts = tq?.data?.trip?.stoptimesForDate || []
    const alight =
      sts.find((st) => st.stop.gtfsId === plan.alightStopId) ||
      sts.find((st) => st.stop.name === plan.alightStopName)
    if (alight) {
      other = c
      otherAlight = stEpoch(alight, false)
      break
    }
    // The OTP route is public and rate-limited; don't hammer it.
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  if (!other) {
    throw new Error(
      `no other same-route trip serving both stops (checked ${seenTripIds.size} of ${candidates.length} candidates)`
    )
  }
  console.log(
    `[setup] "actual" bus: trip ${other.tripId} "${other.headsign}" ` +
      `departs board stop ${fmt(other.dep)}, alights ${fmt(otherAlight)} ` +
      `(planned trip alights ${fmt(plan.plannedEnd)})`
  )
  if (Math.abs(otherAlight - plan.plannedEnd) < 180000) {
    console.log(
      '[warn] planned and other trips alight <3 min apart — ' +
        'live-times assertion will be weak this run'
    )
  }

  // ---- start Go Mode; pin a synthetic vehicle (on the OTHER trip) to the
  // rider so vehicle matching locks onto it ----
  await page.evaluate(() => window.__beginGoMode(window.__plannedItinerary))
  await page.waitForFunction(
    () =>
      window.store.getState().otp.goMode.isActive &&
      typeof window.__startGpsSimulation === 'function',
    { polling: 300, timeout: 20000 }
  )
  await page.evaluate(
    (routeId, tripId, headsign, vehicleId) => {
      // Re-inject twice a second: the app's own 15s vehicle poll overwrites
      // the route's vehicle list with the real feed.
      const inject = async () => {
        // eslint-disable-next-line import/no-absolute-path
        const api = await import('/lib/actions/api.js')
        const g = window.store.getState().otp.goMode
        const pos = g?.tracking?.lastPosition
        if (!pos || !g?.isActive) return
        window.store.dispatch(
          api.receivedVehiclePositions({
            routeId,
            vehicles: [
              {
                heading: pos.coords.heading ?? 0,
                label: '8148',
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                nextStopId: null,
                nextStopName: null,
                patternId: `${routeId}:sim`,
                routeId,
                seconds: Math.floor(Date.now() / 1000),
                speed: pos.coords.speed ?? 10,
                stopStatus: 'IN_TRANSIT_TO',
                tripHeadsign: headsign,
                tripId,
                vehicleId
              }
            ]
          })
        )
      }
      window.__vehicleInjector = setInterval(inject, 500)
      inject()
    },
    plan.routeId,
    other.tripId,
    other.headsign,
    FAKE_VEHICLE_ID
  )
  await page.evaluate((speed) => window.__startGpsSimulation(speed), SIM_SPEED)

  // ---- (1)+(2): the matched trip must reach the riding fact ----
  await page.waitForFunction(
    (vid) => {
      const g = window.store.getState().otp.goMode
      const m = g?.vehicleMatch?.match
      return (
        m?.vehicleId === vid &&
        (m.confidence === 'high' || m.confidence === 'confirmed') &&
        m.tripId != null
      )
    },
    { polling: 500, timeout: 180000 },
    FAKE_VEHICLE_ID
  )
  const match = await page.evaluate(
    () => window.store.getState().otp.goMode.vehicleMatch.match
  )
  console.log(
    `[match] ${match.vehicleId} confidence=${match.confidence} ` +
      `tripId=${match.tripId}`
  )
  if (match.tripId !== other.tripId) {
    throw new Error(
      `vehicle match carries tripId ${match.tripId}, expected ${other.tripId}`
    )
  }

  await page.waitForFunction(
    (tripId) => {
      const g = window.store.getState().otp.goMode
      return g?.riding?.tripId === tripId
    },
    { polling: 500, timeout: 180000 },
    other.tripId
  )
  const riding = await page.evaluate(
    () => window.store.getState().otp.goMode.riding
  )
  console.log(
    `[riding] legIndex=${riding.legIndex} tripId=${riding.tripId} ` +
      `(planned was ${plan.plannedTripId})`
  )

  // ---- (4): the boarded-earlier replan must fire and auto-apply ----
  await page.waitForFunction(
    () => {
      const g = window.store.getState().otp.goMode
      return (g.notifications?.recentNotifications || []).some(
        (n) => n.type === 'TRIP_UPDATED'
      )
    },
    { polling: 500, timeout: 240000 }
  )
  const after = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    const legs = g.activeItinerary?.legs || []
    const busIdx = legs.findIndex((l) => l.transitLeg)
    const bus = legs[busIdx] || {}
    return {
      busIdx,
      newBoard: Number(bus.startTime),
      newEnd: Number(bus.endTime),
      newTripId: bus.trip?.gtfsId || bus.tripId,
      rerouteCardShowing: (g.reRoute?.candidates || []).length > 0,
      reRouteStatus: g.reRoute?.status
    }
  })
  console.log(
    `[replan] auto-applied: bus leg now trip ${after.newTripId} ` +
      `board ${fmt(after.newBoard)} alight ${fmt(after.newEnd)} ` +
      `(planned board was ${fmt(plan.plannedBoard)}); ` +
      `card showing: ${after.rerouteCardShowing}`
  )
  if (after.rerouteCardShowing) {
    throw new Error('boarded-earlier surfaced a card — must auto-apply')
  }
  if (after.newBoard > plan.plannedBoard + 60 * 60000) {
    throw new Error('replan jumped to a much later departure — wrong bus')
  }

  // ---- (3): live leg times for the current leg must track the RIDDEN trip
  // (the vehicle injector keeps the rider matched to the "other" trip, so the
  // riding fact re-forms on the new itinerary too). refreshLiveLegTimes polls
  // every 20s wall and the riding re-stamp rides GPS ticks — poll until the
  // chain converges rather than sampling one instant. ----
  let live = null
  let converged = false
  const liveDeadline = Date.now() + 120000
  while (Date.now() < liveDeadline) {
    live = await page.evaluate(() => {
      const g = window.store.getState().otp.goMode
      const legs = g.activeItinerary?.legs || []
      const idx =
        g.riding?.legIndex != null && legs[g.riding.legIndex]?.transitLeg
          ? g.riding.legIndex
          : legs.findIndex((l) => l.transitLeg)
      return {
        idx,
        ridingTripId: g.riding?.tripId,
        times: g.liveLegTimes?.[idx] ?? null
      }
    })
    if (
      live.times?.alightEpoch != null &&
      Math.abs(live.times.alightEpoch - otherAlight) <= 120000
    ) {
      converged = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  console.log(
    `[live-times] leg ${live?.idx} (riding trip ${live?.ridingTripId}): ` +
      `alight ${fmt(live?.times?.alightEpoch)} — ` +
      `ridden-trip truth ${fmt(otherAlight)}, planned-trip ${fmt(
        plan.plannedEnd
      )}`
  )
  if (!converged) {
    throw new Error(
      'live leg times never anchored to the ridden trip within 120s'
    )
  }

  await page.screenshot({ path: `${OUT}/boarded-earlier-after.png` })
  await page.evaluate(() => clearInterval(window.__vehicleInjector))
  await browser.close()

  console.log(
    '\nPASS: matched tripId → riding fact → live leg times → auto-replan'
  )
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
