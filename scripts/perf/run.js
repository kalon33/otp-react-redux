#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Responsiveness harness for the TransitNav web app — see README.md here.
 *
 *   env -u DISPLAY LABEL=main-<sha> node scripts/perf/run.js [--gate scripts/perf/budget.json]
 *   node scripts/perf/run.js --gate scripts/perf/budget.json --summary <summary.json>   (re-gate only)
 *
 * Env: APP_URL (http://127.0.0.1:9967/), CPU_THROTTLE (4), SCENARIOS (comma
 * list, default all, a repeated name runs again as `<name>~2`), OUT_DIR
 * (scripts/perf/out), LABEL (required for a run), PERF_QUIET_CONSOLE (1),
 * PERF_DPR (2), GOMODE_MAX_WALL_S (900), SEARCH_SETTLE_MAX_S (900),
 * PERF_ALLOW_FANOUT (0), PERF_DATE (YYYY-MM-DD for searches),
 * SPEEDY (1|0; default 1 when the served tree is a dev server — 75.35: sets
 * window.SC_DISABLE_SPEEDY=false before load, as the production bundle runs),
 * TRACE (1: collect a Chrome trace per scenario and report tap->paint with the
 * GPU read-back subtracted as its own figure),
 * PERF_WAIT_PROD_IDLE (1), PERF_PROD_BUSY_PATTERN, PERF_PROD_LOCK.
 *
 * One Chrome at a time: every scenario gets its own browser, closed before the
 * next starts (details continues search-1dest's page when both run).
 */
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const puppeteer = require('puppeteer')

const { installCollector } = require('./collector')
const {
  overlapMs,
  readbackSpans,
  TRACE_CATEGORIES
} = require('./trace-readback')
const { ALIASES, ORDER, SCENARIOS } = require('./scenarios')
const { gate, markdownTable, summariseScenario } = require('./stats')

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] || true : null
}

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:9967/'
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE || 4)
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, 'out')
const LABEL = process.env.LABEL
const QUIET = process.env.PERF_QUIET_CONSOLE !== '0'
const DPR = Number(process.env.PERF_DPR || 2)
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome'
const WAIT_PROD_IDLE =
  process.env.PERF_WAIT_PROD_IDLE !== '0' &&
  !argv.includes('--no-wait-for-prod-idle')
// Other processes that send plan queries to the same (production) OTP. While
// one is alive, a live-plan scenario waits; see README "one query at a time".
const BUSY_PATTERN =
  process.env.PERF_PROD_BUSY_PATTERN || '^(timeout [0-9]+ )?node capture\\.js'
const PROD_LOCK =
  process.env.PERF_PROD_LOCK || '/tmp/claude-1000/perf-prod.lock'
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const TRACE = process.env.TRACE === '1'

// ---------------------------------------------------------------- prod lock

function prodBusy() {
  const who = []
  try {
    const out = execSync(`pgrep -af '${BUSY_PATTERN}'`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    out
      .split('\n')
      .filter(Boolean)
      .filter((l) => Number(l.split(' ')[0]) !== process.pid)
      .forEach((l) => who.push(l.slice(0, 120)))
  } catch (e) {
    // pgrep exits 1 when nothing matches
  }
  try {
    const lock = JSON.parse(fs.readFileSync(PROD_LOCK, 'utf8'))
    if (lock.pid !== process.pid) {
      try {
        process.kill(lock.pid, 0)
        who.push(`lock ${PROD_LOCK} held by pid ${lock.pid} (${lock.what})`)
      } catch (e) {
        // stale lock: owner gone
      }
    }
  } catch (e) {
    // no lock file
  }
  return who
}

async function waitForProdIdle(name) {
  const maxMs = Number(process.env.PERF_WAIT_MAX_S || 3600) * 1000
  const started = Date.now()
  for (;;) {
    const who = prodBusy()
    if (!who.length) break
    if (Date.now() - started > maxMs) {
      throw new Error(`prod OTP still busy after ${maxMs / 1000}s: ${who[0]}`)
    }
    if ((Date.now() - started) % 60000 < 5000) {
      console.log(`[${name}] waiting for prod OTP to go idle: ${who[0]}`)
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(5000)
  }
  fs.mkdirSync(path.dirname(PROD_LOCK), { recursive: true })
  fs.writeFileSync(
    PROD_LOCK,
    JSON.stringify({
      pid: process.pid,
      since: Date.now(),
      what: `perf ${name}`
    })
  )
  return Date.now() - started
}

function releaseProdLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(PROD_LOCK, 'utf8'))
    if (lock.pid === process.pid) fs.unlinkSync(PROD_LOCK)
  } catch (e) {
    // nothing to release
  }
}

// ---------------------------------------------------------------- served code

/**
 * Which code the dev server is serving. SERVED_TREE names the checkout the
 * server mounts; for :9967 that is the shared checkout. Vite serves the
 * working tree, so the dirty status matters as much as the sha.
 */
function servedTree() {
  const tree =
    process.env.SERVED_TREE ||
    (/:9967\b/.test(APP_URL)
      ? '/home/rwt/projects/otprr/otp-react-redux'
      : null)
  if (!tree) return { note: 'set SERVED_TREE to record the served sha' }
  const git = (args) => {
    try {
      return execSync(`git -C '${tree}' ${args}`, { encoding: 'utf8' }).trim()
    } catch (e) {
      return null
    }
  }
  const status = (git('status --short') || '')
    .split('\n')
    .filter(
      (l) => l && !/replay\/fixtures\//.test(l) && !/node_modules$/.test(l)
    )
  return { dirty: status, sha: git('rev-parse --short HEAD'), tree }
}

// 75.35 (P8f/P2b): styled-components 5.3.1 turns "speedy" (CSSOM insertRule)
// OFF in development, so every injected rule is a text-node insertBefore and
// Blink re-parses the sheet: ~0.3-1.2 s at 4x on each first mount, work the
// production bundle never does. It reads a global SC_DISABLE_SPEEDY before its
// NODE_ENV fallback, so the harness sets it to false before the app loads.
// Default: on whenever there is a served dev tree (SERVED_TREE, or :9967).
// SPEEDY=0 restores the old dev behaviour (and then first-mount taps are
// flagged so the budget can discount them, see stats.js).
let speedyCache = null
const speedyEnabled = () => {
  if (speedyCache == null) {
    if (process.env.SPEEDY === '1') speedyCache = true
    else if (process.env.SPEEDY === '0') speedyCache = false
    else speedyCache = !!servedTree().tree
  }
  return speedyCache
}
// ---------------------------------------------------------------- browser

async function launch() {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: CHROME,
    headless: true
  })
  const page = await browser.newPage()
  await page.setUserAgent(IPHONE_UA)
  await page.setViewport({
    deviceScaleFactor: DPR,
    hasTouch: true,
    height: 844,
    isMobile: true,
    width: 390
  })
  const origin = new URL(APP_URL).origin
  await browser
    .defaultBrowserContext()
    .overridePermissions(origin, ['geolocation'])
  await page.setGeolocation({
    accuracy: 10,
    latitude: 44.9778,
    longitude: -93.265
  })
  // A page whose main thread never yields (a render loop) would hang every
  // page.evaluate forever and the harness with it; bound them instead, so
  // the scenario fails with a note and the run moves on.
  const evalTimeout = Number(process.env.PERF_EVAL_TIMEOUT_S || 120) * 1000
  const evaluate = page.evaluate.bind(page)
  page.evaluate = (...args) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `page unresponsive: evaluate exceeded ${evalTimeout / 1000} s`
            )
          ),
        evalTimeout
      )
      evaluate(...args).then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        }
      )
    })
  // 75.35 (P9): the harness answers every dialog. Go Mode's exit "<-" opens a
  // window.confirm (GoModeScreen.tsx confirmStopTracking); unanswered, every
  // later CDP call blocks (66.12). Dismiss = "Cancel" = keep the trip, and
  // log it so a scenario that reaches a dialog says so.
  const dialogs = []
  page.on('dialog', (d) => {
    const rec = { message: d.message().slice(0, 160), type: d.type() }
    dialogs.push(rec)
    console.log(`  [dialog] ${rec.type} dismissed: ${rec.message}`)
    d.dismiss().catch(() => null)
  })
  if (speedyEnabled()) {
    await page.evaluateOnNewDocument(() => {
      window.SC_DISABLE_SPEEDY = false
    })
  }
  const cdp = await page.target().createCDPSession()
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE })
  // PERF_NO_COLLECTOR=1 is for diagnostics only: it proves a behaviour is
  // the app's and not the collector's (no measurements are taken).
  if (process.env.PERF_NO_COLLECTOR !== '1') {
    await page.evaluateOnNewDocument(installCollector, { quietConsole: QUIET })
  }
  return { browser, cdp, dialogs, page }
}

/** Requests to the OTP API: what went to the server, and how many at once. */
function watchNetwork(page) {
  const reqs = []
  const byReq = new Map()
  const t0 = Date.now()
  page.on('request', (r) => {
    const url = r.url()
    if (!/\/otp\/|\/api\//.test(url)) return
    let op = null
    const body = r.postData() || ''
    const m = /query\s+(\w+)/.exec(body)
    if (m) op = m[1]
    const rec = {
      api: /\/otp\//.test(url) ? 'otp' : 'app-api',
      end: null,
      method: r.method(),
      op,
      path: url.replace(/^[a-z]+:\/\/[^/]+/, '').slice(0, 80),
      plan: /\bplan\s*\(|planConnection/.test(body),
      start: Date.now() - t0
    }
    reqs.push(rec)
    byReq.set(r, rec)
  })
  const done = (status) => (r) => {
    const rec = byReq.get(r)
    if (!rec) return
    rec.end = Date.now() - t0
    rec.status = status
    const resp = r.response && r.response()
    if (resp) rec.bytes = Number(resp.headers()['content-length']) || null
  }
  page.on('requestfinished', done('ok'))
  page.on('requestfailed', done('failed'))
  return {
    reqs,
    summary() {
      const otp = reqs.filter((r) => r.api === 'otp')
      const plans = otp.filter((r) => r.plan)
      let maxConcurrentPlans = 0
      for (const r of plans) {
        const at = plans.filter(
          (o) => o.start <= r.start && (o.end == null || o.end > r.start)
        ).length
        maxConcurrentPlans = Math.max(maxConcurrentPlans, at)
      }
      return {
        appApi: reqs.filter((r) => r.api === 'app-api').map((r) => r.path),
        maxConcurrentPlans,
        otpRequests: otp.length,
        planRequests: plans.length
      }
    }
  }
}

function makeCtx({ browser, cdp, page }, scenarioName) {
  const notes = []
  const info = {}
  const completedTaps = []
  const note = (msg) => {
    notes.push(msg)
    console.log(`  [note] ${msg}`)
  }
  const waitTap = async (i, label) => {
    const ok = await page
      .waitForFunction(
        (n) => window.__perf.tapState(n).done,
        { polling: 100, timeout: 60000 },
        i
      )
      .then(() => true)
      .catch(() => false)
    await page.evaluate(() => window.__perf.disarm())
    if (!ok) note(`tap ${label}: no paint observed within 60 s`)
    // 75.35 (P8c): keep each finished step node-side, so a scenario that
    // later hangs the page still reports the steps that completed.
    const t = await page
      .evaluate((n) => {
        const x = window.__perf.taps[n]
        return (
          x && {
            events: x.events,
            label: x.label,
            mode: x.mode,
            ms: x.ms != null ? x.ms : null,
            paintAt: x.paintAt || null,
            start: x.start,
            via: x.via || null
          }
        )
      }, i)
      .catch(() => null)
    if (t) completedTaps.push(t)
  }
  const ctx = {
    appUrl: APP_URL,
    browser,
    cdp,

    completedTaps,
    // `expanded` (true|false) additionally requires that aria-expanded value:
    // the overhauled ride expander ("Ride 18 min · 9 stops") carries its state
    // there, not in "(Expand details)" text (transit-leg-summary.tsx).
    async findButton(re, scope, expanded) {
      const h = await page.evaluateHandle(
        (src, flags, sc, ex) => {
          const rx = new RegExp(src, flags)
          const root = sc ? document.querySelector(sc) : document
          if (!root) return null
          return (
            Array.from(root.querySelectorAll('button,[role="button"]')).find(
              (b) => {
                const r = b.getBoundingClientRect()
                if (!(r.width > 0 && rx.test((b.textContent || '').trim())))
                  return false
                return (
                  ex == null || b.getAttribute('aria-expanded') === String(ex)
                )
              }
            ) || null
          )
        },
        re.source,
        re.flags,
        scope || null,
        expanded == null ? null : expanded
      )
      return h.asElement()
    },
    async findLink(re) {
      const h = await page.evaluateHandle(
        (src, flags) => {
          const rx = new RegExp(src, flags)
          return (
            Array.from(document.querySelectorAll('a,button')).find((b) => {
              const r = b.getBoundingClientRect()
              return r.width > 0 && rx.test((b.textContent || '').trim())
            }) || null
          )
        },
        re.source,
        re.flags
      )
      return h.asElement()
    },
    info,
    note,
    notes,
    async openApp(url) {
      ctx.expectedLoads = (ctx.expectedLoads || 0) + 1
      await page.goto(url, { timeout: 90000, waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => !!window.store && !!window.__perf, {
        timeout: 60000
      })
    },
    page,
    async panMap(label) {
      const canvas = await page.$('canvas.maplibregl-canvas')
      const box = canvas && (await canvas.boundingBox())
      if (!box) return label
      const x = box.x + box.width / 2
      const y = box.y + Math.min(box.height / 2, 250)
      const i = await page.evaluate(
        (l) => window.__perf.arm(l, 'gesture'),
        label
      )
      const touch = (type, px, py) =>
        cdp.send('Input.dispatchTouchEvent', {
          touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }],
          type
        })
      await touch('touchStart', x, y)
      for (let k = 1; k <= 5; k++) {
        // eslint-disable-next-line no-await-in-loop
        await touch('touchMove', x - k * 16, y - k * 8)
      }
      await touch('touchEnd')
      await waitTap(i, label)
    },
    scenarioName,
    sleep,
    async startMeasuring() {
      await page.evaluate(() => {
        window.__perf.cut = performance.now()
      })
    },
    async tap(label, handle) {
      await handle.evaluate((el) =>
        el.scrollIntoView({ block: 'center', inline: 'center' })
      )
      await sleep(250)
      const box = await handle.boundingBox()
      if (!box) {
        note(`tap ${label}: element has no box`)
        return
      }
      await ctx.tapAt(label, box.x + box.width / 2, box.y + box.height / 2)
    },
    async tapAt(label, x, y) {
      const i = await page.evaluate((l) => window.__perf.arm(l), label)
      await page.touchscreen.tap(x, y)
      await waitTap(i, label)
    }
  }
  return ctx
}

async function collect(page) {
  return page.evaluate(() => {
    const p = window.__perf
    const cut = p.cut || 0
    const end = p.endCut || Infinity
    const since = (arr, key) =>
      arr.filter((e) => e[key] >= cut && e[key] <= end)
    const ticks = since(p.ticks, 'start').map((t) => ({
      actions: t.actions.length,
      pointIndex: t.pointIndex,
      start: t.start,
      syncMs: t.syncMs,
      types: Array.from(new Set(t.actions)).join(',')
    }))
    return {
      actions: since(p.actions, 't'),
      events: since(p.events, 'start'),
      loafs: since(p.loafs, 'start')
        .sort((a, b) => b.dur - a.dur)
        .slice(0, 60),
      longtasks: since(p.longtasks, 'start'),
      marks: p.marks,
      t0: cut,
      taps: p.taps
        .filter((t) => (t.start != null ? t.start >= cut : t.armedAt >= cut))
        .map((t) => ({
          events: t.events,
          label: t.label,
          mode: t.mode,
          ms: t.ms != null ? t.ms : null,
          paintAt: t.paintAt || null,
          start: t.start,
          via: t.via || null
        })),
      ticks
    }
  })
}

function joinEventTiming(raw) {
  for (const t of raw.taps) {
    if (t.start == null) continue
    const evs = raw.events.filter(
      (e) =>
        e.start >= t.start - 2 &&
        e.start <= t.start + 1500 &&
        /pointer|touch|click/.test(e.name)
    )
    t.eventTimingMs = evs.length ? Math.max(...evs.map((e) => e.dur)) : null
  }
}

// ---------------------------------------------------------------- main

async function runScenario(name, key, session, continued) {
  const scenario = SCENARIOS[name]
  const started = Date.now()
  const load0 = os.loadavg()[0]
  const sess = session || (await launch())
  const net = watchNetwork(sess.page)
  const errors = []
  sess.page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)))
  const ctx = makeCtx(sess, key)
  // A reload nobody asked for (Vite HMR full reload after a merge, a dep
  // re-optimisation) silently resets the page under a scenario: say so.
  // 'load' fires per document, not per hash change (row taps change the hash).
  let loads = 0
  sess.page.on('load', () => {
    loads++
    if (loads > (ctx.expectedLoads || 0)) {
      ctx.note(`page loaded again (#${loads}): a reload mid-scenario`)
    }
  })
  ctx.continued = !!continued
  const contention = []
  const poll = scenario.livePlan
    ? setInterval(() => {
        const who = prodBusy()
        if (who.length)
          contention.push({ t: Date.now() - started, who: who[0] })
      }, 5000)
    : null
  // TRACE=1: a Chrome trace of the scenario, for the GPU read-back figure.
  // Search scenarios only unless TRACE_ALL=1 (a 15 min replay trace is GBs).
  let tracePath = null
  if (TRACE && (scenario.kind === 'search' || process.env.TRACE_ALL === '1')) {
    tracePath = path.join(OUT_DIR, LABEL, 'traces', `${key}.json`)
    fs.mkdirSync(path.dirname(tracePath), { recursive: true })
    await sess.page.tracing.start({
      categories: TRACE_CATEGORIES,
      path: tracePath
    })
  }
  const dialogs0 = sess.dialogs.length
  let scenarioError = null
  try {
    if (!continued) await ctx.startMeasuring().catch(() => null)
    await scenario.run(ctx)
  } catch (e) {
    scenarioError = e.message
    ctx.note(`scenario threw: ${e.message}`)
  } finally {
    if (poll) clearInterval(poll)
  }
  let readback = null
  if (tracePath) {
    try {
      const nowAtSync = await sess.page.evaluate(() => {
        console.timeStamp('perf-sync')
        return performance.now()
      })
      await sess.page.tracing.stop()
      readback = readbackSpans(tracePath, nowAtSync)
      if (readback.note) ctx.note(readback.note)
    } catch (e) {
      ctx.note(`trace read-back unavailable: ${e.message}`)
      await sess.page.tracing.stop().catch(() => null)
    }
  }
  let collectError = null
  let raw = await collect(sess.page).catch((e) => {
    collectError = e.message
    ctx.note(`collect failed: ${e.message}`)
    return null
  })
  if (!raw) {
    // 75.35 (P8c): a page that hung mid-scenario cannot be read back, but the
    // steps that finished were recorded node-side (waitTap) and the host load
    // is ours: keep both rather than dropping the scenario. long tasks, ticks
    // and actions are NOT known, so the summary says `partial` and the gate
    // fails it instead of passing a table of zeros.
    raw = {
      actions: [],
      events: [],
      loafs: [],
      longtasks: [],
      marks: [],
      partial: `collect failed: ${collectError}`,
      t0: 0,
      taps: ctx.completedTaps.map((t) => ({ ...t, eventTimingMs: null })),
      ticks: []
    }
  } else {
    joinEventTiming(raw)
  }
  if (readback && readback.spans) {
    for (const t of raw.taps) {
      if (t.start != null && t.paintAt != null) {
        t.readbackMs = Math.round(overlapMs(readback.spans, t.start, t.paintAt))
      }
    }
  }
  // First mount (75.35 P2b): the first tap of each kind of label ("results-row-0"
  // and "results-row-4" are one kind). With speedy off these carry the dev-only
  // CSS re-parse, so the budget discounts them (stats.js).
  const seenKinds = new Set()
  for (const t of raw.taps) {
    const kind = String(t.label).replace(/-?\d+/g, '')
    t.firstMount = !seenKinds.has(kind)
    seenKinds.add(kind)
  }
  Object.assign(raw, {
    dialogs: sess.dialogs.slice(dialogs0),
    errors,
    host: {
      contention: contention.slice(0, 20),
      loadavgEnd: os.loadavg()[0],
      loadavgStart: load0
    },
    info: ctx.info,
    kind: scenario.kind,
    label: LABEL,
    network: { requests: net.reqs, summary: net.summary() },
    notes: ctx.notes,
    replay: ctx.info.replay
      ? {
          finalStatus: ctx.info.replay.finalStatus,
          fixture: ctx.info.fixture && ctx.info.fixture.name,
          pointIndex: ctx.info.replay.pointIndex,
          speed: ctx.info.fixture && ctx.info.fixture.speed,
          totalPoints: ctx.info.replay.totalPoints,
          wallSeconds: ctx.info.replay.wallSeconds
        }
      : null,
    scenario: key,
    wallSeconds: Math.round((Date.now() - started) / 1000)
  })
  raw.speedy = speedyEnabled()
  raw.readbackTotalMs =
    readback && readback.totalMs != null ? readback.totalMs : null
  const summary = summariseScenario(raw)
  summary.host = raw.host
  summary.speedy = raw.speedy
  const ownDialogs = sess.dialogs.slice(dialogs0)
  if (ownDialogs.length) {
    summary.dialogs = ownDialogs
    summary.notes.push(
      `${ownDialogs.length} dialog(s) dismissed by the harness: ${ownDialogs
        .map((d) => `${d.type} "${d.message.slice(0, 60)}"`)
        .join('; ')}`
    )
  }
  if (raw.partial) summary.partial = raw.partial
  if (scenarioError) summary.scenarioError = scenarioError
  if (contention.length) {
    summary.notes.push(
      `another plan-query process was alive during ${contention.length} of the 5 s polls: ${contention[0].who}`
    )
  }
  return { raw, sess, summary }
}

function report(summary, gatePath) {
  const budget = JSON.parse(fs.readFileSync(gatePath, 'utf8'))
  const fails = gate(summary, budget)
  console.log(`\n=== GATE (${gatePath}) ===`)
  if (!fails.length) {
    console.log('PASS: every scenario within budget')
    return 0
  }
  fails.forEach((f) => console.log(`FAIL  ${f}`))
  return 2
}

async function main() {
  const gatePath = flag('--gate')
  const summaryOnly = flag('--summary')
  if (summaryOnly) {
    const summary = JSON.parse(fs.readFileSync(summaryOnly, 'utf8'))
    console.log(markdownTable(summary))
    if (gatePath) process.exit(report(summary, gatePath))
    return
  }
  if (!LABEL) throw new Error('LABEL is required (e.g. LABEL=main-e36dee995)')
  const requested = (process.env.SCENARIOS || ORDER.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ALIASES[s] || s)
  for (const n of requested) {
    if (!SCENARIOS[n]) throw new Error(`unknown scenario ${n}`)
  }
  const dir = path.join(OUT_DIR, LABEL)
  fs.mkdirSync(dir, { recursive: true })
  const summaryPath = path.join(dir, 'summary.json')
  const summary = fs.existsSync(summaryPath)
    ? JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    : { scenarios: {} }
  Object.assign(summary, {
    appUrl: APP_URL,
    chrome: CHROME,
    cpuThrottle: CPU_THROTTLE,
    dpr: DPR,
    label: LABEL,
    quietConsole: QUIET,
    served: servedTree(),
    speedy: speedyEnabled(),
    trace: TRACE,
    updated: new Date().toISOString()
  })

  const seen = {}
  let carry = null // a page details can continue on
  for (let i = 0; i < requested.length; i++) {
    const name = requested[i]
    seen[name] = (seen[name] || 0) + 1
    const key = seen[name] > 1 ? `${name}~${seen[name]}` : name
    const scenario = SCENARIOS[name]
    const continues =
      carry && scenario.continues === carry.name ? carry.sess : null
    if (carry && !continues) {
      await carry.sess.browser.close()
      carry = null
    }
    console.log(
      `\n=== ${key} (${scenario.kind}${
        continues ? ', continuing ' + carry.name : ''
      }) ===`
    )
    let waited = 0
    if (scenario.livePlan && WAIT_PROD_IDLE) waited = await waitForProdIdle(key)
    let result
    try {
      result = await runScenario(name, key, continues, !!continues)
    } finally {
      if (scenario.livePlan) releaseProdLock()
    }
    if (continues) carry = null
    if (waited > 5000)
      result.summary.notes.push(
        `waited ${Math.round(waited / 1000)} s for prod OTP to go idle`
      )
    if (result.raw) {
      fs.writeFileSync(
        path.join(dir, `${key}.json`),
        JSON.stringify(result.raw)
      )
    }
    summary.scenarios[key] = result.summary
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
    // Keep this browser only if the NEXT scenario continues on its page.
    const next = SCENARIOS[requested[i + 1]]
    if (next && next.continues === name) {
      carry = { name, sess: result.sess }
    } else {
      await result.sess.browser.close()
    }
  }
  if (carry) await carry.sess.browser.close()
  console.log('\n' + markdownTable(summary))
  console.log(`\nwrote ${summaryPath}`)
  if (gatePath) process.exit(report(summary, gatePath))
}

module.exports = { launch, releaseProdLock, waitForProdIdle }

if (require.main === module) {
  // puppeteer's own SIGTERM handler closes the browser but leaves this loop
  // running into the next scenario; exit instead.
  const onSignal = () => {
    releaseProdLock()
    process.exit(130)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  main().catch((err) => {
    releaseProdLock()
    console.error(err)
    process.exit(1)
  })
}
