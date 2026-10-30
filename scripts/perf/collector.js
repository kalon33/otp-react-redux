/**
 * In-page collector for the responsiveness harness. `installCollector` is
 * serialised with Function.prototype.toString and injected through
 * page.evaluateOnNewDocument, so it runs BEFORE any app module evaluates. It
 * must therefore be self-contained: no closure over Node-side variables, only
 * its single JSON-able `opts` argument.
 *
 * What it records into window.__perf (all times are performance.now() ms):
 *
 *   longtasks  — PerformanceObserver 'longtask' (>50 ms main-thread tasks)
 *   loafs      — 'long-animation-frame' entries with their top scripts, which
 *                is the only in-page attribution Chrome offers for a long task
 *   events     — Event Timing entries (durationThreshold 16): the browser's own
 *                input -> next-paint measurement, kept as a cross-check
 *   actions    — every Redux action, {t, type, ...a few cheap fields}. There is
 *                no store hook after createStore, so the action types come from
 *                the dev server's redux-logger (lib/main.js pushes createLogger()
 *                when NODE_ENV === 'development'): its `console.log('%c action',
 *                css, action)` line hands us the action object. `t` is when the
 *                logger printed it, i.e. AFTER reducers + the synchronous
 *                react-redux render the dispatch caused — so the gap between
 *                two consecutive actions in one task is the cost of the second.
 *   timers     — not kept wholesale; setTimeout is wrapped so each callback's
 *                synchronous duration is known, and the callbacks that advance
 *                the GPS replay (they dispatch UPDATE_SIMULATION_PROGRESS) are
 *                kept as `ticks`, with the action types they produced.
 *   taps       — tap -> visible response. A tap is armed by the driver, the
 *                real touch is sent by puppeteer, and the probe measures from
 *                the touchstart's event timestamp to the second
 *                requestAnimationFrame after the last handler-bearing event of
 *                the tap (touchend, or the click synthesised from it). Double
 *                rAF = the frame that contains the handlers' DOM changes has
 *                been produced.
 *
 * Console: by default (opts.quietConsole) console.log/info/debug/group*
 * become no-ops before the app loads. redux-logger otherwise prints prev/next
 * state for EVERY dispatch, and with puppeteer's Runtime domain attached each
 * call is serialised across CDP — a cost the phone's production bundle never
 * pays. warn/error are left alone. The originals stay on window.__perfConsole.
 */
function installCollector(opts) {
  const now = () => performance.now()
  const perf = {
    actions: [],
    events: [],
    loafs: [],
    longtasks: [],
    marks: [],
    opts,
    t0: now(),
    taps: [],
    ticks: []
  }
  window.__perf = perf

  // ---- console: silence (default) and harvest redux-logger's action line ----
  const orig = {}
  ;['log', 'info', 'debug', 'group', 'groupCollapsed', 'groupEnd'].forEach(
    (k) => {
      orig[k] = console[k] && console[k].bind(console)
    }
  )
  window.__perfConsole = orig
  let curTimer = null

  // Cheap per-type extras. Never copy payloads: some are megabytes.
  const extras = (a) => {
    const p = a.payload
    const out = {}
    try {
      switch (a.type) {
        case 'UPDATE_SIMULATION_PROGRESS':
          out.pointIndex = p && p.pointIndex
          break
        case 'ROUTE_ROW_TIMETABLE':
          out.status = p && p.status
          out.key = p && p.key
          break
        case 'ITINERARY_VARIANT_ROWS':
          out.rows = p && p.rows
          if (p && Array.isArray(p.variantCounts)) {
            out.variants = p.variantCounts.reduce((s, n) => s + n, 0)
          }
          break
        case 'ROUTING_RESPONSE': {
          const r = p && p.response
          out.itineraries =
            (r && r.plan && r.plan.itineraries && r.plan.itineraries.length) ||
            0
          out.index = p && p.index
          out.searchId = p && p.searchId
          // The whole search's row count, the budget's ">= 25 itineraries".
          const st = window.store && window.store.getState().otp
          const s = st && st.searches && st.searches[p && p.searchId]
          if (s && Array.isArray(s.response)) {
            out.searchItineraries = s.response.reduce(
              (n, resp) =>
                n +
                ((resp && resp.plan && resp.plan.itineraries
                  ? resp.plan.itineraries.length
                  : 0) || 0),
              0
            )
          }
          break
        }
        case 'ROUTING_REQUEST':
          out.searchId = p && p.searchId
          break
        default:
      }
    } catch (e) {
      out.err = String(e)
    }
    return out
  }

  const recordAction = (a) => {
    if (!a || typeof a.type !== 'string') return
    const rec = { t: now(), type: a.type, ...extras(a) }
    perf.actions.push(rec)
    if (curTimer) {
      curTimer.actions.push(a.type)
      if (a.type === 'UPDATE_SIMULATION_PROGRESS')
        curTimer.tick = rec.pointIndex
    }
  }

  const hook = (k) =>
    function (...args) {
      // redux-logger 2.x: logger.log('%c action    ', css, action) with
      // colors on, logger.log('action    ', action) without.
      if (k === 'log' && typeof args[0] === 'string') {
        if (args[0].startsWith('%c action')) recordAction(args[2])
        else if (args[0].startsWith('action ')) recordAction(args[1])
      }
      if (!opts.quietConsole && orig[k]) return orig[k](...args)
    }
  ;['log', 'info', 'debug', 'group', 'groupCollapsed', 'groupEnd'].forEach(
    (k) => {
      console[k] = hook(k)
    }
  )

  // ---- setTimeout wrapper: the GPS replay's ticks ----
  const origSetTimeout = window.setTimeout.bind(window)
  window.setTimeout = function (fn, delay, ...rest) {
    if (typeof fn !== 'function') return origSetTimeout(fn, delay, ...rest)
    const wrapped = function (...a) {
      const prev = curTimer
      const rec = { actions: [], start: now(), tick: null }
      curTimer = rec
      try {
        return fn.apply(this, a)
      } finally {
        curTimer = prev
        if (rec.tick != null) {
          perf.ticks.push({
            actions: rec.actions,
            pointIndex: rec.tick,
            start: rec.start,
            syncMs: now() - rec.start
          })
        }
      }
    }
    return origSetTimeout(wrapped, delay, ...rest)
  }

  // ---- performance observers ----
  const observe = (type, cb, extra) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(cb)).observe({
        buffered: true,
        type,
        ...(extra || {})
      })
    } catch (e) {
      perf.marks.push({ name: `observer-unsupported:${type}`, t: now() })
    }
  }
  observe('longtask', (e) =>
    perf.longtasks.push({ dur: e.duration, start: e.startTime })
  )
  observe('long-animation-frame', (e) =>
    perf.loafs.push({
      blocking: e.blockingDuration,
      dur: e.duration,
      render: e.renderStart ? e.startTime + e.duration - e.renderStart : null,
      scripts: (e.scripts || [])
        .slice()
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 3)
        .map((s) => ({
          dur: Math.round(s.duration),
          fn: s.sourceFunctionName || '',
          invoker: (s.invoker || '').slice(0, 80),
          src: (s.sourceURL || '').replace(/^.*\/\/[^/]+/, '').slice(0, 100)
        })),
      start: e.startTime
    })
  )
  const describeTarget = (el) => {
    if (!el || !el.tagName) return null
    const cls = typeof el.className === 'string' ? el.className : ''
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls.split(' ')[0] : ''}`
  }
  observe(
    'event',
    (e) =>
      perf.events.push({
        dur: e.duration,
        interactionId: e.interactionId || 0,
        name: e.name,
        procEnd: e.processingEnd,
        procStart: e.processingStart,
        start: e.startTime,
        target: describeTarget(e.target)
      }),
    { durationThreshold: 16 }
  )

  // ---- tap -> paint probe ----
  let armed = null
  const finish = (tap, from) => {
    const token = (tap.token = (tap.token || 0) + 1)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (tap.token !== token || tap.done) return
        tap.paintAt = now()
        tap.ms = tap.paintAt - tap.start
        tap.via = from
        // Give a click synthesised after touchend one more frame to show up;
        // if it does it restarts the chain and this tap is not done yet.
        requestAnimationFrame(() => {
          if (tap.token === token) tap.done = true
        })
      })
    )
  }
  const onInput = (ev) => {
    const tap = armed
    if (!tap) return
    // A gesture (map pan) is timed from its LAST touch: the response that
    // matters is the frame after the finger lifts, not the drag itself.
    if (tap.mode === 'gesture') {
      if (ev.type === 'touchend') tap.start = ev.timeStamp
    } else if (
      tap.start == null &&
      /^(touchstart|pointerdown|mousedown)$/.test(ev.type)
    ) {
      tap.start = ev.timeStamp
    }
    if (tap.start == null) return
    tap.events.push(ev.type)
    if (/^(touchend|click|pointerup)$/.test(ev.type)) finish(tap, ev.type)
  }
  ;[
    'touchstart',
    'pointerdown',
    'mousedown',
    'touchend',
    'pointerup',
    'click'
  ].forEach((type) =>
    window.addEventListener(type, onInput, { capture: true, passive: true })
  )

  perf.arm = (label, mode) => {
    armed = {
      armedAt: now(),
      done: false,
      events: [],
      label,
      mode: mode || 'tap',
      start: null
    }
    perf.taps.push(armed)
    return perf.taps.length - 1
  }
  perf.disarm = () => {
    armed = null
  }
  perf.tapState = (i) => {
    const t = perf.taps[i]
    return t ? { done: t.done, ms: t.ms, started: t.start != null } : null
  }
  // Store-driven "taps" (no DOM element to touch): run fn, then double-rAF.
  perf.tap = (label, fn) => {
    const rec = { done: false, events: ['fn'], label, start: now() }
    perf.taps.push(rec)
    try {
      fn()
    } finally {
      finish(rec, 'fn')
    }
    return perf.taps.length - 1
  }
  perf.mark = (name, extra) => perf.marks.push({ name, t: now(), ...extra })
}

module.exports = { installCollector }
