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
 *       auto-applies a SPLICED itinerary that keeps the rider on the boarded
 *       bus by construction (replanFromAboard → buildOnboardItinerary:
 *       leg[0].tripId === the ridden trip, boarding at one of that trip's own
 *       downstream stops) — no card, no prompt, never a different bus.
 *
 * Harness: real app at :9967 (same as verify-auto-anchor), GPS simulation
 * along the planned itinerary, plus a synthetic vehicle-positions feed that
 * pins one vehicle to the rider's position with a real *other* trip's id
 * (deterministic — no dependence on a live bus being near the rider).
 *
 * The "actual" bus must be an EARLIER one (backlog 6.27). This script used to
 * take the next same-route departure AFTER the planned trip, which alights
 * later than the plan in hand — and since 6.12 (`acceptAutoReplan`,
 * `replan-acceptance.ts`) an automatic replacement that arrives later than the
 * plan it replaces is refused, on purpose, by the rider's own standing rule.
 * Measured 2026-09-02 the synthetic bus alighted 10m34s late (08:11:42 vs
 * 08:01:08) and the run died on `Waiting failed: 240000ms exceeded` with
 * `[go-mode] auto replan (boarded-earlier) refused: arrives-later` in the page
 * console. A boarded-EARLIER test needs a bus that boards earlier and alights
 * no later; the later bus is now asserted separately, as the refusal it is.
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const API =
  process.env.OTP_API || 'https://api.transit-nav.com:9966/otp/gtfs/v1'
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
    const busOf = (it) => it.legs[it.legs.findIndex((l) => l.transitLeg)]
    ok.sort((a, b) => Number(busOf(a).startTime) - Number(busOf(b).startTime))

    // The PLANNED trip must not be the first departure of its route from its
    // boarding stop, or there is no earlier bus for the rider to have caught
    // (measured 2026-09-02: the earliest walk→bus itinerary took the very next
    // Orange Line departure, and `stoptimesForPatterns` only looks forward, so
    // the candidate search found nothing earlier and the run failed on its own
    // precondition). Boarded-EARLIER is a rider who planned a later bus, so
    // plan a later bus: take the first itinerary that has a same-route,
    // same-stop sibling leaving before it.
    const key = (it) => {
      const b = busOf(it)
      return `${b.routeId ?? b.route?.gtfsId ?? b.route?.id}|${
        b.from?.stop?.gtfsId ?? b.from?.stopId
      }`
    }
    // A sibling only counts if it is a DIFFERENT run leaving STRICTLY earlier:
    // the mode fan-out returns the same departure several times over (20
    // itineraries, a handful of distinct trips), and counting those ties chose
    // a duplicate of the first departure — the same dead end, one run later.
    const tripOf = (it) => busOf(it).trip?.gtfsId ?? busOf(it).tripId
    const withEarlierSibling = ok.filter((it, i) =>
      ok
        .slice(0, i)
        .some(
          (prev) =>
            key(prev) === key(it) &&
            tripOf(prev) !== tripOf(it) &&
            Number(busOf(prev).startTime) < Number(busOf(it).startTime)
        )
    )
    const picked = withEarlierSibling[0] || ok[0]
    window.__plannedItinerary = JSON.parse(JSON.stringify(picked))
    const legs = picked.legs
    const busIdx = legs.findIndex((l) => l.transitLeg)
    const bus = legs[busIdx]
    return {
      alightStopId: bus.to?.stop?.gtfsId,
      alightStopName: bus.to?.name,
      boardStopId: bus.from?.stop?.gtfsId,
      busIdx,
      distinctTrips: [...new Set(ok.map(tripOf))].length,
      earlierSiblings: withEarlierSibling.length,
      itineraries: ok.length,
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
  console.log(
    `[setup] chosen from ${plan.itineraries} walk→bus itineraries ` +
      `(${plan.distinctTrips} distinct runs); ` +
      `${plan.earlierSiblings} of them have an earlier same-route departure ` +
      'from the same stop' +
      (plan.earlierSiblings
        ? ' (the planned trip is one of those, so an earlier bus exists)'
        : ' — the planned trip IS the first departure, and the ' +
          'earlier-bus search below will say so')
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
  const ARRIVAL_SLACK_MS = await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const ra = await import('/lib/util/go-mode/replan-acceptance.ts')
    return ra.AUTO_REPLAN_ARRIVAL_SLACK_MS
  })

  const sameRoute = allPatterns
    .filter((p) => p.pattern.route.gtfsId === plan.routeId)
    .flatMap((p) => p.stoptimes)
    .map((st) => ({
      dep: stEpoch(st, true),
      headsign: st.trip.tripHeadsign,
      tripId: st.trip.gtfsId
    }))
    .filter((c) => c.tripId !== plan.plannedTripId && c.dep > Date.now())

  // Earliest-first among the buses that leave BEFORE the planned one — those
  // are the runs a rider can board earlier, and the ones whose alight can be
  // no later than the plan's. Closest to the planned departure first, so the
  // splice is anchored to a bus that is still near the rider.
  const earlier = sameRoute
    .filter((c) => c.dep < plan.plannedBoard)
    .sort((a, b) => b.dep - a.dep)
  const later = sameRoute
    .filter((c) => c.dep > plan.plannedBoard)
    .sort((a, b) => a.dep - b.dep)

  const alightOf = async (c) => {
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
    if (!alight) return null
    return {
      alightEpoch: stEpoch(alight, false),
      stopIds: sts.map((st) => st.stop.gtfsId)
    }
  }

  // Walk the candidates once, keeping the first that serves both stops on each
  // side of the planned departure: `other` is what the rider is pretended to
  // be on, `laterBus` is the refusal case at the end of the run.
  let other = null
  let otherAlight = null
  let otherStopIds = null
  let laterBus = null
  let laterAlight = null
  const seenTripIds = new Set()
  for (const c of [...earlier, ...later]) {
    if (seenTripIds.has(c.tripId)) continue
    seenTripIds.add(c.tripId)
    if (seenTripIds.size > 10) break
    if (other && laterBus) break
    // eslint-disable-next-line no-await-in-loop
    const info = await alightOf(c)
    if (info) {
      const arrivesLater = info.alightEpoch > plan.plannedEnd + ARRIVAL_SLACK_MS
      if (!other && !arrivesLater) {
        other = c
        otherAlight = info.alightEpoch
        // The spliced replan must board at one of THIS trip's own stops.
        otherStopIds = info.stopIds
      } else if (!laterBus && arrivesLater) {
        laterBus = c
        laterAlight = info.alightEpoch
      }
    }
    // The OTP route is public and rate-limited; don't hammer it.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  if (!other) {
    throw new Error(
      'PRECONDITION: no same-route trip serving both stops alights within ' +
        `${ARRIVAL_SLACK_MS / 1000}s of the planned ${fmt(plan.plannedEnd)} ` +
        `(checked ${seenTripIds.size} of ${sameRoute.length} candidates, ` +
        `${earlier.length} of them earlier than the planned departure). ` +
        'A boarded-EARLIER test needs an earlier bus — a later one is refused ' +
        'by acceptAutoReplan, which is the behaviour, not the bug (6.12/6.27).'
    )
  }
  console.log(
    `[setup] "actual" bus: trip ${other.tripId} "${other.headsign}" ` +
      `departs board stop ${fmt(other.dep)} (planned ${fmt(
        plan.plannedBoard
      )}), alights ${fmt(otherAlight)} ` +
      `(planned trip alights ${fmt(plan.plannedEnd)}) — ` +
      `${((plan.plannedEnd - otherAlight) / 60000).toFixed(1)} min earlier`
  )
  if (Math.abs(otherAlight - plan.plannedEnd) < 180000) {
    console.log(
      '[warn] planned and other trips alight <3 min apart — ' +
        'live-times assertion will be weak this run'
    )
  }

  // ---- start Go Mode; pin a synthetic vehicle (on the OTHER trip) to the
  // rider so vehicle matching locks onto it ----
  // Block the app's own vehicle-position fetches from here on: every live
  // response displaced the injected TEST vehicle for up to 500ms, which
  // dropped the match and reset consecutiveMatches — the boarded-earlier
  // gate's sustained-run requirement (RIDING_REBIND_MIN_CONSECUTIVE) then
  // never accumulated before the 16x sim ended. Aborting the fetch leaves the
  // injector as the only vehicle source; everything else (plans, stop times)
  // passes through untouched — the auto-replan still hits the real OTP.
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    if ((req.postData() || '').includes('vehiclePositions')) req.abort()
    else req.continue()
  })
  await page.evaluate(() => window.__beginGoMode(window.__plannedItinerary))
  await page.waitForFunction(
    () =>
      window.store.getState().otp.goMode.isActive &&
      typeof window.__startGpsSimulation === 'function',
    { polling: 300, timeout: 20000 }
  )
  await page.evaluate(
    (routeId, tripId, headsign, vehicleId) => {
      // Re-inject twice a second so a fresh record is always present (the
      // sim clock outruns any single stamp within seconds at 16x).
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
                // Feed timestamp in the SIM clock domain: simulated fixes
                // carry simulatedTimeMs in `timestamp`, and the freshness
                // gates (isVehicleRecordFresh) measure ageSec against the sim
                // clock too. A wall-clock stamp here goes "stale" within
                // seconds at 16x and blocks the boarded-earlier replan.
                seconds: Math.floor((pos.timestamp ?? Date.now()) / 1000),
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
  const after = await page.evaluate(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const rc = await import('/lib/util/go-mode/reroute-candidates.ts')
    const g = window.store.getState().otp.goMode
    const legs = g.activeItinerary?.legs || []
    const busIdx = legs.findIndex((l) => l.transitLeg)
    const bus = legs[busIdx] || {}
    const boardedRouteId = g.riding?.routeId ?? null
    return {
      busIdx,
      // The route the rider had chosen for the leg AFTER the bus, and the one
      // the applied splice actually leaves them on. An automatic update may
      // not change it (8/9 item 4).
      keepRouteId: g.reRoute?.keepRouteId ?? null,
      newBoard: Number(bus.startTime),
      newBoardStopId: bus.from?.stop?.gtfsId || bus.from?.stopId,
      newEnd: Number(bus.endTime),
      newTripId: bus.trip?.gtfsId || bus.tripId,
      onwardAfter: rc.onwardTransitRouteId(g.activeItinerary, {
        boardedRouteId
      }),
      onwardPlanned: rc.onwardTransitRouteId(window.__plannedItinerary, {
        boardedRouteId
      }),
      reRouteStatus: g.reRoute?.status
    }
  })
  console.log(
    `[replan] auto-applied splice: leg[${after.busIdx}] now trip ` +
      `${after.newTripId} boarding ${after.newBoardStopId} ` +
      `${fmt(after.newBoard)}, alight ${fmt(after.newEnd)} ` +
      `(planned trip was ${plan.plannedTripId}); ` +
      `reRoute status: ${after.reRouteStatus}`
  )
  // There used to be a "boarded-earlier surfaced a card — must auto-apply"
  // assertion here, reading `reRoute.candidates.length > 0`. eb74a9d8 deleted
  // that field (the slice now carries "only the status, never its results"), so
  // the expression had been a permanent `false` and the check could not fail —
  // it read like a policy and tested nothing, and this script has been passing
  // partly on it ever since. Nothing in lib/components reads `reRoute` at all
  // any more, so there is no Switch/Keep card left to assert the absence of.
  // The auto-apply contract is carried instead by the splice assertions below,
  // which check that the itinerary really was replaced without the rider
  // answering anything.
  // The spliced recovery contract (replanFromAboard): the new itinerary's
  // FIRST leg IS the physically-boarded bus — an aboard replan can never
  // take the rider off their line (7/29: orange line).
  if (after.busIdx !== 0) {
    throw new Error(
      `spliced itinerary must start with the bus leg (transit at index ${after.busIdx})`
    )
  }
  if (after.newTripId !== other.tripId) {
    throw new Error(
      `leg[0] is trip ${after.newTripId} — expected the boarded bus's trip ${other.tripId}`
    )
  }
  if (otherStopIds && !otherStopIds.includes(after.newBoardStopId)) {
    throw new Error(
      `boarding stop ${after.newBoardStopId} is not a downstream stop of trip ${other.tripId}`
    )
  }

  // ---- (2b): an automatic update may not change the rider's ONWARD route.
  // Whether this leg gets exercised depends on the itinerary OTP handed us —
  // say which, rather than passing quietly on a trip that never had a second
  // transit leg to lose (8/9 item 4). ----
  if (!after.onwardPlanned) {
    console.log(
      '[route-keep] not exercised: the planned trip ends on foot after the ' +
        'bus, so there is no onward route to preserve'
    )
  } else {
    console.log(
      `[route-keep] planned onward route ${after.onwardPlanned}, ` +
        `keepRouteId ${after.keepRouteId}, applied ${after.onwardAfter}`
    )
    if (after.keepRouteId !== after.onwardPlanned) {
      throw new Error(
        `reroute kept ${after.keepRouteId} — expected the onward route ${after.onwardPlanned}`
      )
    }
    if (after.onwardAfter !== after.onwardPlanned) {
      throw new Error(
        `auto-applied splice put the rider on ${after.onwardAfter} — ` +
          `they chose ${after.onwardPlanned}`
      )
    }
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

  // ---- (5): the LATER bus is REFUSED — the other half of the same rule, and
  // the reason this harness had to be rebuilt (6.12/6.27). Asserted against
  // the real gate with this run's own numbers: the same planned itinerary,
  // once with the alight of a genuinely later same-route trip, once with an
  // earlier one. ----
  const laterEnd = laterAlight ?? plan.plannedEnd + ARRIVAL_SLACK_MS + 60000
  console.log(
    `[refusal] later bus ${
      laterBus ? `trip ${laterBus.tripId}` : '(synthetic)'
    } alights ${fmt(laterEnd)} — ${(
      (laterEnd - plan.plannedEnd) /
      60000
    ).toFixed(1)} min after the plan (slack ${ARRIVAL_SLACK_MS / 1000}s)`
  )
  const verdicts = await page.evaluate(async (laterEnd) => {
    // eslint-disable-next-line import/no-absolute-path
    const ra = await import('/lib/util/go-mode/replan-acceptance.ts')
    const planned = window.__plannedItinerary
    const withEnd = (endTime) => ({
      ...planned,
      endTime,
      legs: planned.legs.map((l, i) =>
        i === planned.legs.length - 1 ? { ...l, endTime } : l
      )
    })
    return {
      earlier: ra.acceptAutoReplan(
        withEnd(Number(planned.endTime) - 60000),
        planned,
        { riding: true }
      ),
      later: ra.acceptAutoReplan(withEnd(laterEnd), planned, { riding: true })
    }
  }, laterEnd)
  if (
    verdicts.later.accept !== false ||
    verdicts.later.reason !== 'arrives-later'
  ) {
    throw new Error(
      'FAIL: an automatic replan arriving ' +
        `${((laterEnd - plan.plannedEnd) / 60000).toFixed(1)} min after the ` +
        `plan was ${JSON.stringify(verdicts.later)} — expected ` +
        "{ accept: false, reason: 'arrives-later' }"
    )
  }
  if (verdicts.earlier.accept !== true) {
    throw new Error(
      `FAIL: an automatic replan arriving a minute EARLIER was refused: ${JSON.stringify(
        verdicts.earlier
      )}`
    )
  }
  console.log(
    '[refusal] later replan refused (arrives-later), earlier one accepted'
  )

  await page.screenshot({ path: `${OUT}/boarded-earlier-after.png` })
  await page.evaluate(() => clearInterval(window.__vehicleInjector))
  await browser.close()

  console.log(
    '\nPASS: matched tripId → riding fact → live leg times → auto-replan, ' +
      'and a later bus is refused'
  )
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
