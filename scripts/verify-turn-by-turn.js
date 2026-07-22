/* eslint-disable no-console */
/**
 * Turn-by-turn verification for access (walk/bike) legs.
 *
 * Before this, `getWalkingInstruction` was a stub: it ignored `leg.steps` and
 * answered every question with "Continue to {destination}", so the rider got no
 * turns at all and `checkUpcomingTurn` could only ever fire once, 10-50m from
 * the end of the leg. The required behavior: real cues off OTP's steps, timed
 * so a cyclist can act on them, and — because a paired Garmin gets ONE
 * vibration policy for the whole app — only a minority promoted to TURN_ALERT,
 * the type that actually reaches the wrist.
 *
 * Harness: drive the real app at :9967, plan a trip, pick an all-bike
 * itinerary, start Go Mode, then walk the rider along the bike leg's own
 * polyline via handlePositionUpdate, recording every notification the real
 * store emits.
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9346, lon: -93.2624, name: 'Test destination' }

// Sample the leg at this many evenly spaced points from start to finish.
const SAMPLES = Number(process.env.SAMPLES || 60)

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

  // Pick an all-access itinerary with a bike leg and pre-compute the cue list
  // the engine derives from it, plus evenly spaced positions along its line.
  const plan = await page.evaluate(async (samples) => {
    // eslint-disable-next-line import/no-absolute-path
    const pm = await import('/lib/util/go-mode/position-matching.js')
    // eslint-disable-next-line import/no-absolute-path
    const tbt = await import('/lib/util/go-mode/turn-by-turn.js')
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
    const leg = ok[0].legs[bikeLegIndex]
    const poly = pm.decodeLegGeometry(leg)
    const cum = pm.calculateCumulativeDistances(poly)
    const total = cum[cum.length - 1]

    // Walk the polyline, emitting a point at each fraction of total distance.
    // INTERPOLATE within the segment rather than snapping to the nearest
    // vertex: OTP polylines have long vertex-free straights, and snapping makes
    // the rider teleport from one vertex to the next, skipping right over the
    // approach window of any turn that sits mid-segment.
    const points = []
    for (let s = 0; s < samples; s++) {
      const target = (total * s) / (samples - 1)
      let i = cum.findIndex((d) => d >= target)
      if (i < 0) i = poly.length - 1
      if (i === 0) {
        points.push({ lat: poly[0][0], lon: poly[0][1] })
        continue
      }
      const span = cum[i] - cum[i - 1]
      const t = span > 0 ? (target - cum[i - 1]) / span : 0
      points.push({
        lat: poly[i - 1][0] + t * (poly[i][0] - poly[i - 1][0]),
        lon: poly[i - 1][1] + t * (poly[i][1] - poly[i - 1][1])
      })
    }

    return {
      cues: tbt.buildStepIndex(leg).map((c) => ({
        instruction: c.instruction,
        offsetMeters: Math.round(c.offsetMeters),
        significant: c.significant
      })),
      legMeters: Math.round(total),
      points,
      stepCount: (leg.steps || []).length
    }
  }, SAMPLES)

  if (!plan) throw new Error('no all-bike itinerary found')

  await page.setGeolocation({
    accuracy: 10,
    latitude: plan.points[0].lat,
    longitude: plan.points[0].lon
  })

  await page.evaluate(() => window.__beginGoMode(window.__itin))
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.isActive,
    { polling: 300, timeout: 20000 }
  )

  // Only now inject a fake Capacitor bridge, so the real sendPush/cancelPush
  // path runs during the ride and records what would land on the phone (and
  // thus the watch over ANCS). Injecting AFTER beginGoMode keeps that call on
  // its browser path (its native branch reloads the shell). Only
  // LocalNotifications is provided, so hasNativeGps() stays false and the
  // manually-driven GPS path is untouched.
  await page.evaluate(() => {
    window.__pushLog = []
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
                body: n.body,
                id: n.id,
                kind: 'schedule',
                passive: n.interruptionLevel === 'passive',
                title: n.title
              })
            )
            return Promise.resolve()
          }
        }
      }
    }
  })

  // Ride the leg, capturing every notification the real reducer chain emits.
  const seen = await page.evaluate(async (points) => {
    // eslint-disable-next-line import/no-absolute-path
    const goMode = await import('/lib/actions/go-mode.js')
    const emitted = []
    const spy = (action) => {
      if (typeof action === 'function') return window.store.dispatch(action)
      if (action?.type === 'ADD_NOTIFICATION') {
        emitted.push({
          message: action.payload.message,
          title: action.payload.title,
          type: action.payload.type
        })
      }
      return window.store.dispatch(action)
    }
    const getState = () => window.store.getState()

    for (let i = 0; i < points.length; i++) {
      const position = {
        coords: {
          accuracy: 10,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          latitude: points[i].lat,
          longitude: points[i].lon,
          speed: 5
        },
        timestamp: Date.now() + i * 4000
      }
      await goMode.handlePositionUpdate(position)(spy, getState)
    }
    return emitted
  }, plan.points)

  // What actually went to the phone/watch via the native bridge.
  const pushLog = await page.evaluate(() => window.__pushLog || [])

  // ---- Report -------------------------------------------------------------
  const turns = seen.filter(
    (n) => n.type === 'UPCOMING_TURN' || n.type === 'TURN_ALERT'
  )
  const alerts = seen.filter((n) => n.type === 'TURN_ALERT')

  console.log(
    `\nbike leg: ${plan.legMeters}m, ${plan.stepCount} OTP steps -> ${plan.cues.length} cues`
  )
  plan.cues.forEach((c) =>
    console.log(
      `  @${String(c.offsetMeters).padStart(5)}m  ${
        c.significant ? '[BUZZ]' : '      '
      } ${c.instruction}`
    )
  )
  console.log(`\nnotifications emitted over ${SAMPLES} ticks:`)
  turns.forEach((n) =>
    console.log(
      `  ${n.type === 'TURN_ALERT' ? '[BUZZ]' : '      '} ${n.title} — ${
        n.message
      }`
    )
  )

  const failures = []

  // Cues must be announced in the order they occur along the leg. Anything else
  // means the rider was sent back to a corner they already rode through.
  const order = turns
    .map((n) => plan.cues.findIndex((c) => c.instruction === n.title))
    .filter((i) => i >= 0)
  for (let i = 1; i < order.length; i++) {
    if (order[i] < order[i - 1]) {
      failures.push(
        `cue order regressed: "${turns[i].title}" announced after "${
          turns[i - 1].title
        }"`
      )
      break
    }
  }
  // Every turn the engine flagged as buzz-worthy should have had its chance.
  const announced = new Set(turns.map((n) => n.title))
  const missed = plan.cues.filter(
    (c) => c.significant && !announced.has(c.instruction)
  )
  if (missed.length > 1) {
    failures.push(
      `significant turns never announced: ${missed
        .map((c) => c.instruction)
        .join(', ')}`
    )
  }

  if (!plan.cues.length) {
    failures.push('engine derived no cues from a leg that has OTP steps')
  }
  if (!turns.length) {
    failures.push('no turn notifications fired across the whole leg')
  }
  if (turns.some((n) => /^Continue to /.test(n.title))) {
    failures.push('a cue fell back to the old "Continue to X" stub text')
  }
  // The whole point of the two tiers: most turns must NOT reach the wrist.
  if (turns.length > 2 && alerts.length >= turns.length) {
    failures.push(
      `every turn was promoted to TURN_ALERT (${alerts.length}/${turns.length}) — the wrist would buzz constantly`
    )
  }

  // ---- Sticky per-turn card (the watch-facing notification) ---------------
  // TURN_CARD_NOTIFICATION_ID is 1 (native-notify.ts).
  const stickyWrites = pushLog.filter(
    (p) => p.kind === 'schedule' && p.id === 1
  )
  const stickyCancels = pushLog.filter((p) => p.kind === 'cancel' && p.id === 1)

  console.log('\nsticky card writes (id=1, passive), in order:')
  stickyWrites.forEach((w) =>
    console.log(`  "${w.title}"${w.body ? ` / ${w.body}` : ''}`)
  )
  console.log(`sticky cancels: ${stickyCancels.length}`)

  if (!stickyWrites.length) {
    failures.push('the sticky turn card never posted')
  }
  // One write per turn, not one per GPS tick: the card must be sticky, and on a
  // limited watch churn is the whole failure mode we are guarding against.
  if (stickyWrites.length > plan.cues.length + 1) {
    failures.push(
      `sticky card wrote ${stickyWrites.length}x for ${plan.cues.length} cues — churning, not sticky`
    )
  }
  // Consecutive writes must be different turns — never the same card re-posted.
  for (let i = 1; i < stickyWrites.length; i++) {
    if (stickyWrites[i].title === stickyWrites[i - 1].title) {
      failures.push(
        `sticky card re-posted the same turn: "${stickyWrites[i].title}"`
      )
      break
    }
  }
  // Instruction-only: no distance on the card (it lives on the phone screen).
  // Match distance UNITS, not bare digits — "42nd Street" is a street name.
  const distanceRe = /\d+(\.\d+)?\s*(ft|mi|feet|miles?)\b/i
  const withDistance = stickyWrites.find(
    (w) => distanceRe.test(w.title) || distanceRe.test(w.body || '')
  )
  if (withDistance) {
    failures.push(
      `sticky card carried a distance: "${withDistance.title} / ${withDistance.body}"`
    )
  }
  // Every sticky write must be silent — the buzz is TURN_ALERT's job.
  if (stickyWrites.some((w) => !w.passive)) {
    failures.push(
      'a sticky card write was not passive — it would buzz the wrist'
    )
  }
  // The card must clear once the rider is past every turn (here: end of leg).
  if (!stickyCancels.length) {
    failures.push(
      'the sticky card was never cancelled — it would linger post-turn'
    )
  }

  console.log(
    `\n${turns.length} turn cues, ${alerts.length} of them buzzing the watch`
  )
  console.log(
    `${stickyWrites.length} sticky card writes for ${plan.cues.length} cues, ${stickyCancels.length} cancel(s)`
  )
  if (failures.length) {
    failures.forEach((f) => console.log(`FAIL: ${f}`))
  } else {
    console.log('PASS')
  }

  await browser.close()
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
