/* eslint-disable no-console */
/**
 * The `?goModeDemo=1` card gallery must actually render.
 *
 * It is the only way a Go Mode card gets reviewed or screenshotted without a
 * live ride, and it was dead from 2026-09-02 to 2026-09-04 without anything
 * noticing: 3.7's onboard grouping (`7dc13053`) started reading
 * `itinerary.legs` off each alight option, GoModeDemo's fixture had none, and
 * `transitRouteSignature` threw. Nothing wraps GoModeDemo in an error boundary,
 * so the page went blank entirely — the h1 assertion below is what catches that
 * (verified 2026-09-04 against the unfixed tree on :9967: this script exits 1).
 * Nothing else in this suite loads that URL. Backlog 8.12.
 *
 * Cheapest possible check, and deliberately so: load the page, assert zero
 * page errors, and assert the frames that used to disappear are present. No
 * OTP query, no GPS simulation, no store hooks — the gallery is static by
 * design, which is why it is worth a few seconds every night.
 *
 * Unlike the replay scripts this one is content-blind about the CARDS: it
 * checks that the onboard list produced rows and a stacked drill-down (the
 * shape the fixture is built to exercise), not what any card says. Card copy
 * has its own jest coverage; what has no other guard is "the page loads".
 */
const path = require('path')

const puppeteer = require('puppeteer')

const APP = process.env.APP_URL || 'http://localhost:9967/'
const OUT = process.env.OUT_DIR || __dirname
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'

async function main() {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    executablePath: CHROME,
    headless: 'new'
  })
  const page = await browser.newPage()
  await page.setViewport({ height: 1200, width: 460 })

  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  const url = `${APP.replace(/\/$/, '')}/?goModeDemo=1`
  await page.goto(url, { timeout: 60000, waitUntil: 'networkidle2' })
  // 60s, not 30: on a dev server whose vite dep cache is cold the first load
  // optimizes ~180 deps and reloads, which took ~40s measured 2026-09-04.
  await page.waitForSelector('h1', { timeout: 60000 })
  // The gallery mounts everything synchronously; this is slack for the
  // ItineraryBody subtrees, not a poll.
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const seen = await page.evaluate(() => ({
    // Any message id that reached the DOM as an id is a missing entry in the
    // gallery's own IntlProvider (it does not load the app catalogue).
    rawIds: Array.from(
      new Set(
        (
          document.body.innerText.match(/components\.[A-Za-z]+\.[A-Za-z]+/g) ||
          []
        ).filter((id) => !id.startsWith('components.StopTimeCell'))
      )
    ),

    // The onboard options list, and the same-shape drill-down it folds into.
    rows: document.querySelectorAll('li.result').length,

    // Frame titles are plain divs; the page's whole text is enough.
    text: document.body.innerText,

    toggles: document.querySelectorAll('button.same-shape-variants-toggle')
      .length
  }))

  const problems = []
  if (pageErrors.length) {
    problems.push(`page errors: ${pageErrors.join(' | ')}`)
  }
  // The page heading, the frame that crashed, and the last frame after it.
  const requiredFrames = [
    'Go Mode — card gallery',
    'Alight recommendation, LIVE',
    'Trip sheet (overview + search from here)'
  ]
  requiredFrames.forEach((title) => {
    if (!seen.text.includes(title)) problems.push(`missing frame: ${title}`)
  })
  // Two alight frames (LIVE + SCHEDULED) x two rows each: the 21-only option,
  // and the two 21 > 6 options stacked behind one drill-down.
  if (seen.rows !== 4) {
    problems.push(`expected 4 onboard option rows, got ${seen.rows}`)
  }
  if (seen.toggles !== 2) {
    problems.push(`expected 2 same-shape drill-downs, got ${seen.toggles}`)
  }
  if (seen.rawIds.length) {
    problems.push(
      `untranslated message ids on screen: ${seen.rawIds.join(', ')}`
    )
  }

  await page.screenshot({
    fullPage: true,
    path: path.join(OUT, 'demo-gallery.png')
  })
  await browser.close()

  if (problems.length) {
    problems.forEach((p) => console.log('FAIL:', p))
    process.exit(1)
  }
  console.log(`PASS — ${seen.rows} onboard rows, ${seen.toggles} drill-downs`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
