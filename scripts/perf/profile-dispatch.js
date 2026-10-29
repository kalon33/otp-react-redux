#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * What does ONE dispatch cost on a settled results list, and where does the
 * time go? Loads a search, waits until every response and route-row timetable
 * fill has landed, then times a no-op pair that touches no search state —
 * POSITION_FETCHING then POSITION_RESPONSE (lib/actions/location.tsx; the
 * reducer only sets location.currentPosition) — three times unprofiled, then
 * once under the CDP sampling profiler (100 us). With PROFILE_FILL=1 it also
 * profiles one route-row timetable fill cycle while the list is loading: from
 * the first ROUTE_ROW_TIMETABLE 'pending' to the first fill that lands plus the
 * ITINERARY_VARIANT_ROWS it causes.
 *
 *   env -u DISPLAY PROFILE_SEARCH=multistop PROFILE_FILL=1 OUT=<dir> node scripts/perf/profile-dispatch.js
 *   env -u DISPLAY PROFILE_SEARCH=short OUT=<dir> node scripts/perf/profile-dispatch.js
 *   env -u DISPLAY PROFILE_GOMODE=gold-74-1105 OUT=<dir> node scripts/perf/profile-dispatch.js
 *   (Go Mode ticks: real-time replay, 30 s window once aboard, no taps.)
 *   env -u DISPLAY PROFILE_ROWTAP=1 PROFILE_SEARCH=multistop OUT=<dir> node scripts/perf/profile-dispatch.js
 *   (results-row tap + "View all options" back on a settled list: a cold row-0
 *   pair and a warm row-2 pair under the CPU profiler, row-1 unprofiled between
 *   them. TRACE=1 records a Chrome trace of each pair instead of a CPU profile
 *   (read it with tools/trace-top.py / trace-chain.py); SPEEDY=0|1 as run.js;
 *   PROFILE_PAYLOADS=1 also times the SET_ACTIVE_* payload stringify.)
 *   (PROFILE_SEARCH: multistop | onedest | short; SERVED_TREE records the sha.
 *   The fill cycle needs single-transit-leg rows, which the 1-dest search has
 *   and the multi-stop one did not on 2026-10-20 — use onedest for it.)
 *
 * Writes <OUT>/profile-<name>.cpuprofile (open in Chrome DevTools > Performance)
 * and <OUT>/profile-<name>.txt (wall times + top-30 self-time table).
 * CPU_THROTTLE defaults to 1 here (absolute wall times closest to a phone; the
 * dev build's own overhead is still in them). Live plans: honours the same
 * prod-idle wait and lock as run.js.
 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

if (!process.env.CPU_THROTTLE) process.env.CPU_THROTTLE = '1'

const { launch, releaseProdLock, waitForProdIdle } = require('./run')
const { TRACE_CATEGORIES } = require('./trace-readback')
const { MULTISTOP, ONE_DEST, searchUrl } = require('./scenarios')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:9967/'
const OUT = process.env.OUT || path.join(__dirname, 'out', 'profiles')
const WHICH = process.env.PROFILE_SEARCH || 'multistop'
// A short ordinary search, for contrast: Mall of America -> MSP Terminal 1.
const SHORT = {
  fromPlace: 'Mall of America Station::44.854277,-93.238877',
  mode: 'WALK,TRANSIT',
  time: '12:15',
  toPlace: 'Terminal 1-Lindbergh Station::44.880695,-93.205063'
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// A search's extra requests (ROUTING_EXTRA_REQUEST) can land well after
// pending first reaches 0; settle only after QUIET_MS without any change, and
// optionally not before PROFILE_MIN_ROWS rows are on screen.
const QUIET_MS = Number(process.env.PROFILE_QUIET_S || 30) * 1000
const MIN_ROWS = Number(process.env.PROFILE_MIN_ROWS || 0)

/** Self and total time per function (url:line), from a V8 cpuprofile. */
function topFunctions(profile, n = 30) {
  const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]))
  const parent = new Map()
  for (const nd of profile.nodes) {
    for (const c of nd.children || []) parent.set(c, nd.id)
  }
  const keyOf = (nd) => {
    const cf = nd.callFrame
    const file = (cf.url || '').replace(/^.*\/\/[^/]+/, '').replace(/\?.*$/, '')
    return `${cf.functionName || '(anonymous)'}\t${file || '(native)'}:${
      cf.lineNumber + 1
    }`
  }
  const self = new Map()
  const total = new Map()
  const { samples, timeDeltas } = profile
  for (let i = 0; i < samples.length; i++) {
    const dt = (timeDeltas[i + 1] != null ? timeDeltas[i + 1] : 0) / 1000
    const leaf = byId.get(samples[i])
    const k = keyOf(leaf)
    self.set(k, (self.get(k) || 0) + dt)
    const seen = new Set()
    for (let id = samples[i]; id != null; id = parent.get(id)) {
      const kk = keyOf(byId.get(id))
      if (seen.has(kk)) continue
      seen.add(kk)
      total.set(kk, (total.get(kk) || 0) + dt)
    }
  }
  const rows = Array.from(self.entries())
    .filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, ms]) => ({ key: k, self: ms, total: total.get(k) || ms }))
  const special = ['(idle)', '(program)', '(garbage collector)'].map((name) => {
    const k = Array.from(self.keys()).find((x) => x.startsWith(name))
    return `${name} ${k ? self.get(k).toFixed(1) : 0} ms`
  })
  return { rows, special }
}

/** Which package each Vite pre-bundled dep chunk mostly holds (see below). */
async function depIndex(urls) {
  const index = new Map()
  for (const url of urls) {
    // Vite 7's pre-bundled chunks carry no per-module comments, but each has
    // a source map whose `sources` name the packages inlined into it; a chunk
    // is labelled with the package that dominates it (react-dom's chunk is
    // ~all react-dom).
    // eslint-disable-next-line no-await-in-loop
    const map = await fetch(url.replace(/\?.*$/, '') + '.map')
      .then((r) => r.json())
      .catch(() => null)
    const counts = {}
    for (const src of (map && map.sources) || []) {
      // "../../react-dom/cjs/x.js" (relative to node_modules/.vite/deps) or
      // ".../node_modules/<pkg>/..." — the package is the first segment after
      // the last node_modules/ or after the leading ../ hops.
      const rest = src.includes('node_modules/')
        ? src.slice(src.lastIndexOf('node_modules/') + 'node_modules/'.length)
        : src.replace(/^(\.\.\/)+/, '')
      const m = /^((?:@[^/]+\/)?[^/]+)\//.exec(rest)
      if (m && m[1] !== '.pnpm') counts[m[1]] = (counts[m[1]] || 0) + 1
    }
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1])
    index.set(url, ranked.length ? ranked[0][0] : null)
  }
  return index
}

const RENDER_PKGS =
  /^(react|react-dom|react-redux|scheduler|styled-components|@opentripplanner\/|react-intl|@formatjs\/|react-transition-group)/

/** Group of one call frame: where does this self time belong? */
function classify(cf, index) {
  const url = cf.url || ''
  const path = url.replace(/^.*\/\/[^/]+/, '').replace(/\?.*$/, '')
  if (!path) return 'other (native/GC/program)'
  if (/^\/lib\/util\/debug-log/.test(path)) return 'debug-log'
  if (/^\/lib\/components\//.test(path)) return 'react render (app components)'
  if (/^\/lib\//.test(path)) return 'app logic (lib/actions, util, reducers)'
  let pkg = index.get(url) || null
  if (!pkg) {
    const m = /\/deps\/((?:@[^_]+_)?[^.]+)\.js/.exec(path)
    pkg = m ? m[1].replace('_', '/') : path
  }
  if (/^maplibre-gl/.test(pkg)) return 'maplibre'
  if (/^(redux-logger)/.test(pkg)) return 'redux-logger (dev only)'
  if (pkg === 'scheduler') pkg = 'react-dom'
  if (RENDER_PKGS.test(pkg)) return `react render (${pkg.split('/')[0]})`
  return `other (${pkg})`
}

/** Self time per group over a profile. */
async function groupProfile(profile) {
  const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]))
  const deps = Array.from(
    new Set(
      profile.nodes
        .map((nd) => nd.callFrame.url)
        .filter((u) => /\/node_modules\/\.vite\/deps\//.test(u || ''))
    )
  )
  const index = await depIndex(deps)
  const groups = new Map()
  const { samples, timeDeltas } = profile
  for (let i = 0; i < samples.length; i++) {
    const dt = (timeDeltas[i + 1] != null ? timeDeltas[i + 1] : 0) / 1000
    const cf = byId.get(samples[i]).callFrame
    if (/^\((idle)\)/.test(cf.functionName)) continue
    const g = classify(cf, index)
    groups.set(g, (groups.get(g) || 0) + dt)
  }
  const total = Array.from(groups.values()).reduce((a, b) => a + b, 0)
  return Array.from(groups.entries())
    .sort((a, b) => b[1] - a[1])
    .map(
      ([g, ms]) =>
        `${ms.toFixed(1)} ms (${((ms / total) * 100).toFixed(1)}%)  ${g}`
    )
}

function servedSha() {
  if (!process.env.SERVED_TREE) return 'unknown (set SERVED_TREE)'
  return execSync(
    `git -C '${process.env.SERVED_TREE}' rev-parse --short HEAD`,
    {
      encoding: 'utf8'
    }
  ).trim()
}

/** The top-N table with each function's group. */
async function tableGrouped(rows, profile) {
  const deps = Array.from(
    new Set(
      profile.nodes
        .map((nd) => nd.callFrame.url)
        .filter((u) => /\/node_modules\/\.vite\/deps\//.test(u || ''))
    )
  )
  const index = await depIndex(deps)
  const byKey = new Map()
  for (const nd of profile.nodes) {
    const cf = nd.callFrame
    const file = (cf.url || '').replace(/^.*\/\/[^/]+/, '').replace(/\?.*$/, '')
    byKey.set(
      `${cf.functionName || '(anonymous)'}\t${file || '(native)'}:${
        cf.lineNumber + 1
      }`,
      cf
    )
  }
  const lines = [
    'self ms | total ms | group | function | file:line',
    '---|---|---|---|---'
  ]
  for (const r of rows) {
    const [fn, loc] = r.key.split('\t')
    const cf = byKey.get(r.key)
    const g = cf ? classify(cf, index) : '?'
    lines.push(
      `${r.self.toFixed(1)} | ${r.total.toFixed(1)} | ${g} | ${fn} | ${loc}`
    )
  }
  return lines.join('\n')
}

async function profileWindow(cdp, fn) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
  await cdp.send('Profiler.start')
  const result = await fn()
  const { profile } = await cdp.send('Profiler.stop')
  await cdp.send('Profiler.disable')
  return { profile, result }
}

const noopPair = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const t0 = performance.now()
        window.store.dispatch({
          payload: {}, // fetchingPosition({ type: setAsType }) with no setAsType
          type: 'POSITION_FETCHING'
        })
        const t1 = performance.now()
        window.store.dispatch({
          payload: {
            position: {
              coords: { accuracy: 20, latitude: 44.95, longitude: -93.26 },
              timestamp: Date.now()
            }
          },
          type: 'POSITION_RESPONSE'
        })
        const t2 = performance.now()
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            resolve({
              fetchingMs: t1 - t0,
              pairMs: t2 - t0,
              responseMs: t2 - t1,
              toPaintMs: performance.now() - t0
            })
          )
        )
      })
  )

const listState = (page) =>
  page.evaluate(() => {
    const st = window.store.getState().otp
    const s = st.searches[st.activeSearchId]
    const tt = s ? Object.values(s.routeRowTimetable || {}) : []
    return {
      domRows: document.querySelectorAll('div.option.metro-itin').length,
      itineraries: s
        ? (s.response || []).reduce(
            (n, r) => n + ((r && r.plan && r.plan.itineraries.length) || 0),
            0
          )
        : 0,
      pending: s ? s.pending : null,
      ttPending: tt.filter((e) => e.status === 'pending').length,
      ttTotal: tt.length
    }
  })

const fmt = (o) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(1) : v}`)
    .join(' ')

/**
 * PROFILE_GOMODE=<fixture>: replay it at PROFILE_SPEED (default 1, real time,
 * so ticks never queue), wait until the trip is aboard a transit leg, then
 * sample PROFILE_SECONDS (30) of ticks with no taps.
 */
async function profileGoMode(fixture) {
  const speed = Number(process.env.PROFILE_SPEED || 1)
  const seconds = Number(process.env.PROFILE_SECONDS || 30)
  const name = 'gomode-ticks'
  const { browser, cdp, page } = await launch()
  try {
    await page.goto(APP_URL, { timeout: 90000, waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => typeof window.__replayTrip === 'function' && !!window.__perf,
      { timeout: 60000 }
    )
    await page.evaluate(
      async (url, sp) => {
        const fx = await window.__loadFixture(url)
        window.__replayTrip(fx, { speedMultiplier: sp })
      },
      `/lib/util/go-mode/replay/fixtures/${fixture}.json`,
      speed
    )
    await page.waitForFunction(
      () => {
        const g = window.store.getState().otp.goMode
        const it = g.activeItinerary
        const leg = it && g.progress && it.legs[g.progress.currentLegIndex]
        return (
          g.simulation.status === 'running' &&
          (!!g.riding || (leg && leg.transitLeg))
        )
      },
      { polling: 500, timeout: 600000 }
    )
    await sleep(3000)
    const t0 = await page.evaluate(() => performance.now())
    const { profile } = await profileWindow(cdp, () => sleep(seconds * 1000))
    const win = await page.evaluate((from) => {
      const g = window.store.getState().otp.goMode
      const ticks = window.__perf.ticks.filter((t) => t.start >= from)
      const lts = window.__perf.longtasks.filter((l) => l.start >= from)
      return {
        aboard: !!g.riding,
        legIndex: g.progress && g.progress.currentLegIndex,
        longTasks: lts.map((l) => Math.round(l.dur)),
        syncMs: ticks.map((t) => t.syncMs),
        types: ticks
          .slice(0, 3)
          .map((t) => Array.from(new Set(t.actions)).join(','))
      }
    }, t0)
    await page.evaluate(() => window.__stopReplay && window.__stopReplay())
    fs.writeFileSync(
      path.join(OUT, `profile-${name}.cpuprofile`),
      JSON.stringify(profile)
    )
    const sorted = win.syncMs.slice().sort((a, b) => a - b)
    const q = (x) =>
      sorted.length
        ? sorted[
            Math.min(sorted.length - 1, Math.ceil(x * sorted.length) - 1)
          ].toFixed(1)
        : 'n/a'
    const top = topFunctions(profile)
    const txt = [
      `# ${name} — ${fixture} at ${speed}x, ${seconds} s window, CPU throttle ${
        process.env.CPU_THROTTLE
      }x — ${APP_URL} — served ${servedSha()}`,
      `aboard=${win.aboard} leg=${win.legIndex}; ${
        sorted.length
      } ticks in window; per-tick sync ms p50 ${q(0.5)} p95 ${q(0.95)} max ${q(
        1
      )}`,
      `tick action types (first ticks): ${win.types.join(' | ')}`,
      `long tasks in window (ms): ${win.longTasks.join(', ') || 'none'}`,
      '',
      'Self time by group (idle excluded):',
      ...(await groupProfile(profile)).map((l) => `  ${l}`),
      '',
      top.special.join(' · '),
      '',
      await tableGrouped(top.rows, profile)
    ].join('\n')
    fs.writeFileSync(path.join(OUT, `profile-${name}.txt`), txt)
    console.log(txt)
  } finally {
    await browser.close()
  }
}

// ---- PROFILE_ROWTAP: one results-row tap and its back (75.35 P8b; 66.11) ----

async function rowTapPoint(page, idx) {
  const rows = await page.$$('div.option.metro-itin')
  if (idx >= rows.length) return null
  return rows[idx].evaluate((el) => {
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    for (const dy of [18, 30, 45, 60, 80]) {
      for (const fx of [0.75, 0.5, 0.9]) {
        const x = r.left + r.width * fx
        const y = r.top + dy
        const hit = document.elementFromPoint(x, y)
        if (hit && el.contains(hit) && !hit.closest('button,a')) return { x, y }
      }
    }
    return null
  })
}

const backPoint = (page) =>
  page.evaluate(() => {
    const b = Array.from(
      document.querySelectorAll('button,[role="button"]')
    ).find(
      (x) =>
        x.getBoundingClientRect().width > 0 &&
        /^View all options$/.test((x.textContent || '').trim())
    )
    if (!b) return null
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })

/** One measured tap: arm the probe, touch, wait for paint, then let the tail land. */
async function tapMeasured(page, label, pt, tailMs) {
  const t0 = await page.evaluate(() => performance.now())
  const i = await page.evaluate((l) => window.__perf.arm(l), label)
  await page.touchscreen.tap(pt.x, pt.y)
  await page.waitForFunction(
    (n) => window.__perf.tapState(n).done,
    {
      polling: 100,
      timeout: 120000
    },
    i
  )
  await page.evaluate(() => window.__perf.disarm())
  await sleep(tailMs)
  return page.evaluate(
    (from, n) => {
      const p = window.__perf
      const tap = p.taps[n]
      const acts = p.actions.filter((a) => a.t >= from)
      const lts = p.longtasks.filter((l) => l.start + l.dur >= from)
      return {
        actions: acts.map((a) => `${Math.round(a.t - tap.start)} ${a.type}`),
        longTasks: lts.map((l) => ({
          dur: Math.round(l.dur),
          inside: acts
            .filter((a) => a.t >= l.start && a.t <= l.start + l.dur)
            .map((a) => a.type),
          start: Math.round(l.start - tap.start)
        })),
        ms: Math.round(tap.ms),
        via: tap.via
      }
    },
    t0,
    i
  )
}

async function profileRowTap() {
  const trace = process.env.TRACE === '1'
  const params = { multistop: MULTISTOP, onedest: ONE_DEST }[WHICH]
  if (!params) throw new Error('PROFILE_SEARCH must be multistop|onedest')
  await waitForProdIdle(`profile rowtap ${WHICH}`)
  const { browser, cdp, page } = await launch()
  const rep = [
    `# rowtap-${WHICH} — ${new Date().toISOString()} — CPU throttle ${
      process.env.CPU_THROTTLE
    }x — ${APP_URL} — served ${servedSha()} — speedy ${
      process.env.SPEEDY || 'default'
    }`
  ]
  let traceN = 0
  // A CPU profile of the window, or (TRACE=1) a Chrome trace file instead.
  const profiled = async (fn) => {
    if (trace) {
      await page.tracing.start({
        categories: TRACE_CATEGORIES,
        path: path.join(OUT, `trace-rowtap-${WHICH}-${++traceN}.json`)
      })
      const result = await fn()
      await page.tracing.stop()
      return { profile: null, result }
    }
    return profileWindow(cdp, fn)
  }
  if (process.env.PROFILE_PAYLOADS === '1') {
    // Size + stringify cost of every SET_ACTIVE_ITINERARY / SET_ACTIVE_LEG
    // payload, read from redux-logger's action line (after the collector's hook).
    await page.evaluateOnNewDocument(() => {
      window.__payloads = []
      const prev = console.log
      console.log = function (...a) {
        try {
          const act =
            typeof a[0] === 'string' && a[0].startsWith('%c action')
              ? a[2]
              : null
          if (
            act &&
            /^(SET_ACTIVE_ITINERARY|SET_ACTIVE_LEG|SET_VISIBLE_ITINERARY|LEG_FREQUENCY)$/.test(
              act.type
            )
          ) {
            const t0 = performance.now()
            let len
            try {
              len = JSON.stringify(act.payload).length
            } catch (e) {
              len = 'cyclic'
            }
            window.__payloads.push({
              chars: len,
              ms: +(performance.now() - t0).toFixed(2),
              type: act.type
            })
          }
        } catch (e) {
          // diagnostics only
        }
        return prev.apply(this, a)
      }
    })
  }
  try {
    await page.goto(searchUrl(APP_URL, params), {
      timeout: 90000,
      waitUntil: 'domcontentloaded'
    })
    await page.waitForFunction(() => !!window.store && !!window.__perf, {
      timeout: 60000
    })
    const started = Date.now()
    let last = ''
    let quietSince = Date.now()
    let st
    while (Date.now() - started < 1200000) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(2000)
      // eslint-disable-next-line no-await-in-loop
      st = await listState(page)
      const now = JSON.stringify(st)
      if (now !== last) {
        console.log(
          `  [settle +${Math.round((Date.now() - started) / 1000)}s] ${now}`
        )
        last = now
        quietSince = Date.now()
      }
      if (
        st.pending === 0 &&
        st.ttPending === 0 &&
        st.domRows >= Math.max(1, MIN_ROWS) &&
        Date.now() - quietSince > QUIET_MS
      )
        break
    }
    releaseProdLock()
    rep.push(
      `settled list after ${Math.round((Date.now() - started) / 1000)} s: ${fmt(
        st
      )}`
    )
    const saveProfile = (kind, label, a) => {
      if (a.profile) {
        fs.writeFileSync(
          path.join(OUT, `profile-${kind}-${WHICH}-${label}.cpuprofile`),
          JSON.stringify(a.profile)
        )
      }
    }
    const pair = async (label, idx) => {
      const pt = await rowTapPoint(page, idx)
      if (!pt) {
        rep.push(`${label}: no tap point`)
        return
      }
      await sleep(2000)
      const a = await profiled(() => tapMeasured(page, `row-${idx}`, pt, 1500))
      saveProfile('rowtap', label, a)
      rep.push(
        '',
        `PROFILED ${label} (row ${idx}): tap->paint ${a.result.ms} ms via ${a.result.via}`,
        `  long tasks: ${JSON.stringify(a.result.longTasks)}`,
        '  actions (ms from touchstart):',
        ...a.result.actions.map((x) => `    ${x}`)
      )
      const bp = await backPoint(page)
      if (!bp) {
        rep.push('no back button')
        return
      }
      await sleep(2000)
      const b = await profiled(() => tapMeasured(page, `back-${idx}`, bp, 1500))
      saveProfile('rowback', label, b)
      rep.push(
        '',
        `PROFILED back of ${label}: tap->paint ${b.result.ms} ms via ${b.result.via}`,
        `  long tasks: ${JSON.stringify(b.result.longTasks)}`,
        '  actions (ms from touchstart):',
        ...b.result.actions.map((x) => `    ${x}`)
      )
    }
    // 1) the session's first details mount (cold), then its back
    await pair('cold', 0)
    // 2) row 1 unprofiled, as the harness's second tap
    {
      const pt = await rowTapPoint(page, 1)
      await sleep(1500)
      const r = await tapMeasured(page, 'row-1', pt, 1500)
      rep.push(
        '',
        `unprofiled row-1: tap->paint ${r.ms} ms via ${
          r.via
        }; long tasks ${JSON.stringify(r.longTasks)}`
      )
      const bp = await backPoint(page)
      await sleep(1500)
      const b = await tapMeasured(page, 'back-1', bp, 1500)
      rep.push(
        `unprofiled back-1: tap->paint ${b.ms} ms; long tasks ${JSON.stringify(
          b.longTasks
        )}`
      )
    }
    // 3) a warm details mount, for contrast with the cold one
    await pair('warm', 2)
    if (process.env.PROFILE_PAYLOADS === '1') {
      const pl = await page.evaluate(() => window.__payloads)
      rep.push(
        '',
        'payloads (type chars stringify-ms, in order):',
        ...pl.map((p) => `  ${p.type} ${p.chars} ${p.ms}`)
      )
    }
    const css = await page.evaluate(() => ({
      cssChars: Array.from(document.querySelectorAll('style')).reduce(
        (n, x) => n + (x.textContent || '').length,
        0
      ),
      cssomRules: Array.from(document.styleSheets).reduce((n, sh) => {
        try {
          return n + sh.cssRules.length
        } catch (e) {
          return n
        }
      }, 0),
      styleTags: document.querySelectorAll('style').length
    }))
    rep.push(`stylesheets at end: ${JSON.stringify(css)}`)
    fs.writeFileSync(
      path.join(OUT, `rowtap-${WHICH}${trace ? '-trace' : ''}.txt`),
      rep.join('\n')
    )
    console.log(rep.join('\n'))
  } finally {
    releaseProdLock()
    await browser.close()
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  if (process.env.PROFILE_ROWTAP) return profileRowTap()
  if (process.env.PROFILE_GOMODE)
    return profileGoMode(process.env.PROFILE_GOMODE)
  const params = { multistop: MULTISTOP, onedest: ONE_DEST, short: SHORT }[
    WHICH
  ]
  if (!params) throw new Error('PROFILE_SEARCH must be multistop|onedest|short')
  const name = `noop-dispatch-${WHICH}`
  const served = servedSha()
  await waitForProdIdle(`profile ${WHICH}`)
  const { browser, cdp, page } = await launch()
  const report = [
    `# ${name} — ${new Date().toISOString()} — CPU throttle ${
      process.env.CPU_THROTTLE
    }x — ${APP_URL}`
  ]
  try {
    await page.goto(searchUrl(APP_URL, params), {
      timeout: 90000,
      waitUntil: 'domcontentloaded'
    })
    await page.waitForFunction(() => !!window.store && !!window.__perf, {
      timeout: 60000
    })

    // ---- optional: one fill cycle, profiled while the list loads ----
    const fillSeen =
      process.env.PROFILE_FILL === '1' &&
      (await page
        .waitForFunction(
          () =>
            window.__perf.actions.some(
              (a) => a.type === 'ROUTE_ROW_TIMETABLE' && a.status === 'pending'
            ),
          { polling: 500, timeout: 240000 }
        )
        .then(() => true)
        .catch(() => {
          report.push('fill cycle: no ROUTE_ROW_TIMETABLE fill within 240 s')
          return false
        }))
    if (fillSeen) {
      await page.waitForFunction(
        () =>
          window.__perf.actions.some(
            (a) => a.type === 'ROUTE_ROW_TIMETABLE' && a.status === 'pending'
          ),
        { polling: 200, timeout: 600000 }
      )
      const before = await listState(page)
      const { profile, result } = await profileWindow(cdp, async () => {
        const startIdx = await page.evaluate(() => window.__perf.actions.length)
        await page.waitForFunction(
          (from) => {
            const acts = window.__perf.actions.slice(from)
            const done = acts.findIndex(
              (a) => a.type === 'ROUTE_ROW_TIMETABLE' && a.status !== 'pending'
            )
            return (
              done >= 0 &&
              acts.slice(done).some((a) => a.type === 'ITINERARY_VARIANT_ROWS')
            )
          },
          { polling: 200, timeout: 600000 },
          startIdx
        )
        return page.evaluate((from) => {
          const acts = window.__perf.actions.slice(from)
          const t0 = acts.length ? acts[0].t : 0
          const lts = window.__perf.longtasks.filter((l) => l.start >= t0)
          return {
            actions: acts.map(
              (a) =>
                `${Math.round(a.t - t0)} ${a.type}${
                  a.status ? ':' + a.status : ''
                }${a.rows != null ? ' rows=' + a.rows : ''}`
            ),
            longTasks: lts.map((l) => Math.round(l.dur))
          }
        }, startIdx)
      })
      const after = await listState(page)
      const fillName = `fill-cycle-${WHICH}`
      fs.writeFileSync(
        path.join(OUT, `profile-${fillName}.cpuprofile`),
        JSON.stringify(profile)
      )
      const top = topFunctions(profile)
      const txt = [
        `# ${fillName} — CPU throttle ${process.env.CPU_THROTTLE}x — ${APP_URL} — served ${served}`,
        `list before: ${fmt(before)}`,
        `list after:  ${fmt(after)}`,
        `long tasks in window (ms): ${result.longTasks.join(', ')}`,
        'actions in window (ms from first):',
        ...result.actions.slice(0, 60).map((a) => `  ${a}`),
        '',
        'Self time by group (idle excluded):',
        ...(await groupProfile(profile)).map((l) => `  ${l}`),
        '',
        top.special.join(' · '),
        '',
        await tableGrouped(top.rows, profile)
      ].join('\n')
      fs.writeFileSync(path.join(OUT, `profile-${fillName}.txt`), txt)
      console.log(txt)
    }

    // ---- settle ----
    const started = Date.now()
    let st = await listState(page)
    let quietSince = Date.now()
    let last = JSON.stringify(st)
    while (Date.now() - started < 1200000) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(2000)
      // eslint-disable-next-line no-await-in-loop
      st = await listState(page)
      const now = JSON.stringify(st)
      if (now !== last) {
        console.log(`  [settle] ${fmt(st)}`)
        last = now
        quietSince = Date.now()
      }
      if (
        st.pending === 0 &&
        st.ttPending === 0 &&
        st.domRows >= MIN_ROWS &&
        Date.now() - quietSince > QUIET_MS
      )
        break
    }
    report.push(`settled list: ${fmt(st)}`)
    releaseProdLock()

    // ---- the no-op dispatch: 3 unprofiled, 1 profiled ----
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(1500)
      // eslint-disable-next-line no-await-in-loop
      const r = await noopPair(page)
      report.push(`unprofiled #${i + 1}: ${fmt(r)}`)
    }
    await sleep(1500)
    const { profile, result } = await profileWindow(cdp, () => noopPair(page))
    report.push(`profiled:      ${fmt(result)}`)
    fs.writeFileSync(
      path.join(OUT, `profile-${name}.cpuprofile`),
      JSON.stringify(profile)
    )
    const top = topFunctions(profile)
    report.push(
      '',
      'Self time by group (idle excluded):',
      ...(await groupProfile(profile)).map((l) => `  ${l}`),
      '',
      top.special.join(' · '),
      '',
      await tableGrouped(top.rows, profile)
    )
    fs.writeFileSync(path.join(OUT, `profile-${name}.txt`), report.join('\n'))
    console.log(report.join('\n'))
  } finally {
    releaseProdLock()
    await browser.close()
  }
}

/** `--regroup <file.cpuprofile>`: re-print groups + top-30 of a saved profile. */
async function regroup(file) {
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'))
  const top = topFunctions(profile)
  console.log(
    [
      'Self time by group (idle excluded):',
      ...(await groupProfile(profile)).map((l) => `  ${l}`),
      '',
      top.special.join(' · '),
      '',
      await tableGrouped(top.rows, profile)
    ].join('\n')
  )
}

const regroupAt = process.argv.indexOf('--regroup')
;(regroupAt >= 0 ? regroup(process.argv[regroupAt + 1]) : main()).catch(
  (err) => {
    releaseProdLock()
    console.error(err)
    process.exit(1)
  }
)
