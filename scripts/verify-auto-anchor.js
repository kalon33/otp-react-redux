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

  // (2) Manual reset must lock the anchor off. Two things about WHERE and HOW
  // this now runs, both measured 2026-09-22 against main `5bbf1e0b7` (13.6):
  //
  // It runs HERE, on the anchor just measured, rather than after the overdue
  // time-travel below. That step makes the rider miss the anchored bus, the
  // missed-bus recovery installs a new plan, and START_GO_MODE nulls the
  // override by design (12.14) — so the button this step needs was gone
  // through no fault of the anchor's. Measured 12:46:08-12:46:10:
  // START_REROUTE -> AUTO_REPLAN -> START_GO_MODE, WALK,BUS,WALK became
  // BICYCLE,BUS,BICYCLE, and the step then reported `matched leg null,
  // status=null` — the 09-22 failure text exactly. That ordering is what
  // failed on 7 of the 16 runs on record before 18.1 (2026-08-29, 09-01,
  // 09-02, 09-03, 09-05, 09-10, 09-11).
  //
  // And it no longer asks for the "Back to <time> (planned)" button. Since
  // 18.1 (2026-09-18, `274b1ad89`) that control renders only when the
  // departure it would restore READS as a different clock minute from the one
  // in force (WalkingNavigation.tsx:404-418) — and with the override gone the
  // card falls back to `getSoonestCatchableMs`, which is the very departure
  // the anchor picked. Measured 2026-09-22: override 13:04:18,
  // plannedDepartureTime 13:49:21, `departureIsOverridden=true`, matched leg
  // 0, `status=on_track`, and the card's buttons were
  // [← | ▾ More | View trip & other ways] with no reset among them. That is
  // 18.1 working as designed, and it is why this script has failed on every
  // night from 09-18 to 09-22 while passing on 09-16 and 09-17.
  //
  // What the step defended is still true and still reachable: an explicit
  // rider choice outranks the anchor. So it is asserted directly — the rider
  // picks a later departure through the real UI ("▾ More" -> "Use this",
  // never a dynamic import of go-mode.ts, whose second Vite module instance
  // has a lock flag the app never reads), the plan follows that pick (23.3:
  // `[go-mode] plan follows the card (rider): leg 1 -> trip …`, which nulls
  // the override through START_GO_MODE by 12.14's rule), and the anchor must
  // then leave both the trip and the departure alone.
  const beforePick = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    const bus = (g.activeItinerary?.legs || []).find((l) => l.transitLeg)
    return {
      override: g.departureOverride ?? null,
      startTime: bus ? Number(bus.startTime) : null,
      tripId: bus?.trip?.gtfsId ?? null
    }
  })
  const expanded = await page.evaluate(() => {
    const more = Array.from(document.querySelectorAll('button')).find((b) =>
      /▾/.test(b.textContent || '')
    )
    if (!more) return false
    more.click()
    return true
  })
  if (!expanded) {
    await page.screenshot({ path: `${OUT}/auto-anchor-no-alternatives.png` })
    throw new Error(
      'no later-departures control on the card — buttons on screen: [' +
        (
          await page.evaluate(() =>
            Array.from(document.querySelectorAll('button'))
              .map((b) => (b.textContent || '').trim())
              .filter(Boolean)
          )
        ).join(' | ') +
        ']'
    )
  }
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('button')).some((b) =>
        /Use this/.test(b.textContent || '')
      ),
    { polling: 300, timeout: 10000 }
  )
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button'))
      .find((b) => /Use this/.test(b.textContent || ''))
      .click()
  })
  // The re-target is a plan fetch, so it is awaited on the plan rather than on
  // the click: the boarding leg's own trip is what has to move.
  await page.waitForFunction(
    (before) => {
      const g = window.store.getState().otp.goMode
      const bus = (g.activeItinerary?.legs || []).find((l) => l.transitLeg)
      return !!bus && Number(bus.startTime) !== before
    },
    { polling: 400, timeout: 45000 },
    beforePick.startTime
  )
  const afterPick = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    const bus = (g.activeItinerary?.legs || []).find((l) => l.transitLeg)
    return {
      override: g.departureOverride ?? null,
      startTime: bus ? Number(bus.startTime) : null,
      tripId: bus?.trip?.gtfsId ?? null
    }
  })
  console.log(
    `[rider pick] plan followed the tap: board ${fmt(
      beforePick.startTime
    )} -> ${fmt(afterPick.startTime)}, trip ${beforePick.tripId} -> ${
      afterPick.tripId
    }, override ${fmt(beforePick.override)} -> ${fmt(afterPick.override)}`
  )
  // Later than the departure IN FORCE — the anchored one the card headlines —
  // not than `legs[boardLeg].startTime`, which this harness has deliberately
  // shifted 45 min into the future and which no departure on the feed matches.
  const inForce = beforePick.override ?? beforePick.startTime
  if (afterPick.startTime <= inForce) {
    throw new Error(
      `the rider picked a LATER departure and the plan moved to ${fmt(
        afterPick.startTime
      )}, which is not later than the ${fmt(inForce)} in force`
    )
  }

  // Wait past a full throttle window with ticks flowing; the anchor must NOT
  // re-fire over the rider's explicit choice — neither by installing an
  // override of its own nor by dragging the plan back onto an earlier run.
  await new Promise((resolve) => setTimeout(resolve, 25000))
  const afterLock = await page.evaluate(() => {
    const g = window.store.getState().otp.goMode
    const bus = (g.activeItinerary?.legs || []).find((l) => l.transitLeg)
    return {
      override: g.departureOverride ?? null,
      startTime: bus ? Number(bus.startTime) : null,
      tripId: bus?.trip?.gtfsId ?? null
    }
  })
  console.log(
    `[manual-lock] 25s on: board ${fmt(afterLock.startTime)}, trip ${
      afterLock.tripId
    }, override ${fmt(afterLock.override)}`
  )
  await page.screenshot({ path: `${OUT}/auto-anchor-reset.png` })
  if (afterLock.override != null) {
    throw new Error(
      `auto-anchor re-fired over an explicit rider choice: override ${fmt(
        afterLock.override
      )}`
    )
  }
  if (afterLock.tripId !== afterPick.tripId) {
    throw new Error(
      `the trip moved off the rider's pick: ${afterPick.tripId} -> ${afterLock.tripId}`
    )
  }

  // Re-arm for the overdue step: beginGoMode clears `manualDepartureLock` and
  // `lastAutoAnchorMs` (go-mode.ts:1388-1389), so re-installing the same
  // shifted plan gives a fresh anchor to time-travel past. The rider has moved
  // only the ~45 s of simulated walking this step took, so the plan's origin is
  // still underfoot and 12.13's stale-origin recovery stays out of it.
  await page.evaluate(() => window.__beginGoMode(window.__anchorItinerary))
  // …and re-seat the rider at the start of the access walk. Without this the
  // simulated rider is wherever two and a half minutes of walking have left
  // them — at or past the boarding stop, matched to the bus leg, where there
  // is no access leg for the anchor to run on and no override ever appears
  // (measured 2026-09-22: the re-anchor wait timed out at 60 s).
  await page.evaluate(() => window.__startGpsSimulation(1))
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.progress != null,
    { polling: 300, timeout: 30000 }
  )
  await page.waitForFunction(
    () => window.store.getState().otp.goMode.departureOverride != null,
    { polling: 500, timeout: 60000 }
  )
  // The recompute can lag the override by a full walk-leg tick interval, and
  // on the SECOND anchor of a run it has been seen to take two (measured
  // 2026-09-22), so this waits longer than the first one does.
  await page.waitForFunction(
    () =>
      window.store.getState().otp.goMode.progress?.departureIsOverridden ===
      true,
    { polling: 500, timeout: 60000 }
  )
  console.log(
    `[re-anchor] override=${fmt(
      await page.evaluate(
        () => window.store.getState().otp.goMode.departureOverride
      )
    )} — anchor re-armed for the overdue step`
  )

  // (1b) The anchored bus runs late and stops reporting. Time-travel past its
  // departure: the anchor must NOT slide onto the next trip. On the 2026-07-22
  // ride it did — "Bus schedule skipped to next while I was waiting at station.
  // Showed 465 at 0135 before mine even left" — because the candidate was
  // compared against the PLANNED board time (still far later), so a jump
  // forward from the anchored bus to the next one still looked like a gain.
  // Deciding a bus is gone belongs to the missed-bus path, which keeps the
  // rider's route; the anchor may only ever move earlier.
  const anchoredBaseline = await page.evaluate(
    () => window.store.getState().otp.goMode.departureOverride
  )
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
  // `worstOverride` only ever moves UP, so on its own it cannot tell "the
  // anchor held" from "the override was dropped": a null leaves it reading the
  // baseline either way. 12.3's `departureIsUnreachable` (departure-anchor.ts
  // :158-176, c156e811) RELEASES an override the rider provably cannot reach,
  // and this loop time-travels straight past the anchored departure, so a
  // release here is a live possibility that the log has to be able to name —
  // the reset button below renders only while `progress.departureIsOverridden`
  // (WalkingNavigation.tsx, `showReset`), and a released override would take
  // it away.
  let released = false
  // A rider who stands still while their anchored bus leaves IS a missed bus,
  // and the missed-bus recovery answers it by installing a new plan —
  // START_GO_MODE, which nulls departureOverride by design (12.14). Measured
  // 2026-09-22 12:46:10: START_REROUTE -> AUTO_REPLAN -> START_GO_MODE and
  // WALK,BUS,WALK became BICYCLE,BUS,BICYCLE. That is the app working, so it
  // is logged rather than failed — and it is why the reset-button step above
  // now runs BEFORE this one instead of after it.
  let planModes = await page.evaluate(() =>
    (window.store.getState().otp.goMode.activeItinerary?.legs || [])
      .map((l) => l.mode)
      .join(',')
  )
  let swappedTo = null
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
    if (now == null) released = true
    const modes = await page.evaluate(() =>
      (window.store.getState().otp.goMode.activeItinerary?.legs || [])
        .map((l) => l.mode)
        .join(',')
    )
    if (modes !== planModes) {
      swappedTo = modes
      planModes = modes
    }
    if (now != null && now > worstOverride) worstOverride = now
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  console.log(
    `[overdue] anchored ${fmt(anchoredBaseline)}; latest override seen ` +
      `${fmt(worstOverride)} after time-travelling past it` +
      `${released ? ' (override was RELEASED at least once)' : ''}` +
      `${swappedTo ? `; plan auto-replanned to ${swappedTo}` : ''}`
  )
  if (worstOverride > anchoredBaseline + 1000) {
    throw new Error(
      `anchor skipped forward to ${fmt(
        worstOverride
      )} — it may only move earlier`
    )
  }

  await browser.close()

  console.log(
    "\nPASS: wait math auto-anchored to the real catchable bus; the rider's " +
      'own pick outranked the anchor and held; the anchor never slid forward ' +
      'onto a later run'
  )
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
