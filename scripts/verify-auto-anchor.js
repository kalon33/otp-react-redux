/* eslint-disable no-console */
/**
 * Auto-anchor verification (07-11 field report: "board 5:27 PM · 68 min wait"
 * while the header showed the live 4:27 bus).
 *
 * Recreates the failure exactly: plan a real walk→bus trip, then shift its
 * transit legs +45 min before activating — the rider is now walking toward a
 * boarding whose PLANNED time is far later than the route's real next
 * departure. Go Mode must, with no rider interaction:
 *   (1) auto-set goMode.departureOverride to the soonest catchable REAL
 *       departure (from the re-polled stop times), so the wait math and the
 *       header agree, and
 *   (2) keep a manual "Reset to planned" (selectDeparture(null)) locked —
 *       the anchor must not re-fire over an explicit rider choice.
 *
 * Harness: same as verify-missed-bus (real app at :9967, dev hooks).
 */
const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'
const OUT = process.env.OUT_DIR || __dirname

const SHIFT_MS = 45 * 60000
const FROM = { lat: 44.9205, lon: -93.276, name: 'Test origin' }
const TO = { lat: 44.9778, lon: -93.2707, name: 'Downtown Minneapolis' }

const fmt = (ms) =>
  ms == null
    ? 'n/a'
    : new Date(ms).toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: 'America/Chicago'
      })

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

  // Pick a walk→bus itinerary and shift its transit legs +45 min: the planned
  // board is now far later than the route's real next departure.
  const chosen = await page.evaluate((shiftMs) => {
    const searches = window.store.getState().otp.searches || {}
    const itins = Object.values(searches)
      .flatMap((s) => s.response || [])
      .flatMap((r) => r?.plan?.itineraries || [])
    const ok = itins.filter((it) => {
      const legs = it.legs || []
      const firstTransit = legs.findIndex((l) => l.transitLeg)
      return (
        firstTransit > 0 &&
        legs[0].mode === 'WALK' &&
        legs.slice(0, firstTransit).every((l) => !l.transitLeg) &&
        legs[0].distance > 80
      )
    })
    if (!ok.length) return null
    ok.sort((a, b) => a.startTime - b.startTime)
    const shifted = JSON.parse(JSON.stringify(ok[0]))
    shifted.legs.forEach((l) => {
      if (l.transitLeg) {
        l.startTime = Number(l.startTime) + shiftMs
        l.endTime = Number(l.endTime) + shiftMs
      }
    })
    shifted.endTime = Number(shifted.endTime) + shiftMs
    window.__anchorItinerary = shifted
    const busLeg = shifted.legs.find((l) => l.transitLeg)
    return {
      boardStopId: busLeg.from?.stop?.gtfsId,
      busRoute: busLeg.routeShortName || busLeg.routeLongName,
      plannedBoard: Number(busLeg.startTime)
    }
  }, SHIFT_MS)
  if (!chosen) throw new Error('no walk→bus itinerary with >80m access walk')
  console.log(
    `[setup] shifted itinerary: bus ${chosen.busRoute} planned board ${fmt(
      chosen.plannedBoard
    )} (real next departures are ~45 min earlier)`
  )

  // ---- start Go Mode + GPS sim on the access walk ----
  await page.evaluate(() => window.__beginGoMode(window.__anchorItinerary))
  await page.waitForFunction(
    () =>
      window.store.getState().otp.goMode.isActive &&
      typeof window.__startGpsSimulation === 'function',
    { polling: 300, timeout: 20000 }
  )
  await page.evaluate(() => window.__startGpsSimulation(1))
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.progress != null,
    { polling: 300, timeout: 20000 }
  )

  // (1) The anchor must fire within one throttle window (~20s + margin), and
  // the NEXT tick's progress must pick it up (departureIsOverridden flips).
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.departureOverride != null,
    { polling: 500, timeout: 45000 }
  )
  // Walk-leg tracking ticks ~15-20s apart, so the recompute can lag the
  // override by a full interval.
  await page.waitForFunction(
    () =>
      window.store.getState().otp.goMode.progress?.departureIsOverridden ===
      true,
    { polling: 500, timeout: 30000 }
  )
  const anchored = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    return {
      overridden: g.progress?.departureIsOverridden,
      override: g.departureOverride,
      waitTimeAtStop: g.progress?.waitTimeAtStop
    }
  })
  const gainMin = (chosen.plannedBoard - anchored.override) / 60000
  console.log(
    `[anchor] departureOverride=${fmt(anchored.override)} ` +
      `(${gainMin.toFixed(1)} min before planned), ` +
      `waitTimeAtStop=${Math.round(anchored.waitTimeAtStop / 60)} min, ` +
      `departureIsOverridden=${anchored.overridden}`
  )
  await page.screenshot({ path: `${OUT}/auto-anchor-after.png` })
  if (!(anchored.override < chosen.plannedBoard - 120000)) {
    throw new Error('override is not meaningfully earlier than planned board')
  }
  if (anchored.override < Date.now() - 60000) {
    throw new Error('override anchored to a departure in the past')
  }
  // The 68-min symptom: wait computed against the planned (late) board. With
  // the anchor, the wait must reflect the anchored bus instead (< the shift).
  if (anchored.waitTimeAtStop == null || anchored.waitTimeAtStop > 40 * 60) {
    throw new Error(
      `waitTimeAtStop still looks anchored to the planned board (${Math.round(
        (anchored.waitTimeAtStop || 0) / 60
      )} min)`
    )
  }

  // (1b) The anchored bus runs late and stops reporting. Time-travel past its
  // departure: the anchor must NOT slide onto the next trip. On the 2026-07-22
  // ride it did — "Bus schedule skipped to next while I was waiting at station.
  // Showed 465 at 0135 before mine even left" — because the candidate was
  // compared against the PLANNED board time (still far later), so a jump
  // forward from the anchored bus to the next one still looked like a gain.
  // Deciding a bus is gone belongs to the missed-bus path, which keeps the
  // rider's route; the anchor may only ever move earlier.
  const anchoredBaseline = anchored.override
  await page.evaluate((target) => {
    const g = window.store.getState().otp.goMode
    const simNow = g.progress?.currentTime
      ? new Date(g.progress.currentTime).getTime()
      : Date.now()
    // 30 s past the anchored departure: inside the overdue grace, the bus is
    // simply late.
    window.__advanceSimulatedTime(target - simNow + 30000)
    window.__pingPosition()
  }, anchoredBaseline)

  let worstOverride = anchoredBaseline
  for (let i = 0; i < 15; i++) {
    // Halfway through, push well past the grace as well — a bus that really is
    // gone still must not be quietly swapped for a later one by the anchor.
    if (i === 7) {
      await page.evaluate(() => {
        window.__advanceSimulatedTime(240000)
        window.__pingPosition()
      })
    }
    const now = await page.evaluate(
      () => window.store.getState().otp.goMode.departureOverride
    )
    if (now != null && now > worstOverride) worstOverride = now
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  console.log(
    `[overdue] anchored ${fmt(anchoredBaseline)}; latest override seen ` +
      `${fmt(worstOverride)} after time-travelling past it`
  )
  if (worstOverride > anchoredBaseline + 1000) {
    throw new Error(
      `anchor skipped forward to ${fmt(
        worstOverride
      )} — it may only move earlier`
    )
  }

  // (2) Manual reset must lock the anchor off. Click the REAL "Reset to
  // planned" button — a dynamic import of go-mode.ts would create a second
  // Vite module instance whose lock flag the app never reads.
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Reset to planned')
    )
    if (!btn) return false
    btn.click()
    return true
  })
  if (!clicked) throw new Error('Reset to planned button not found in the UI')
  // Wait past a full throttle window with ticks flowing; the anchor must NOT
  // re-fire over the rider's explicit reset.
  await new Promise((resolve) => setTimeout(resolve, 25000))
  const afterReset = await page.evaluate(
    () => window.store.getState().otp.goMode.departureOverride
  )
  console.log(`[manual-lock] override after reset + 25s: ${afterReset}`)
  await page.screenshot({ path: `${OUT}/auto-anchor-reset.png` })

  await browser.close()

  if (afterReset != null) {
    throw new Error('auto-anchor re-fired over an explicit rider reset')
  }
  console.log(
    '\nPASS: wait math auto-anchored to the real catchable bus; manual reset respected'
  )
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
