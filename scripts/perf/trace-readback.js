/* eslint-disable no-console */
/**
 * GPU read-back time inside a Chrome trace (75.35 P3).
 *
 * Headless Chrome rasterises WebGL with SwiftShader. When the map canvas is
 * resized (the results list does that, maplibre `_resizeCanvas`) the commit
 * calls GLES2::ReadPixels and the main thread blocks in
 * CommandBufferProxyImpl::WaitForGetOffset until the software GPU process has
 * drained its command buffer: 808 / 879 ms of an 827 / 895 ms long task on the
 * 2026-10-28 trace (multistop "View all options" back). A phone's GPU does not
 * do that, so a tap's tap->paint with this wait taken out is the figure that
 * speaks for the app. run.js reports both.
 *
 *   readbackSpans(tracePath, pageNowAtSync) -> [[startMs, endMs], ...] in
 *   performance.now() time of the document that was live at the sync point
 *   (console.timeStamp('perf-sync') emitted while tracing, with the matching
 *   performance.now() read in the same evaluate).
 */
const fs = require('fs')

const WAIT = 'CommandBufferProxyImpl::WaitForGetOffset'
const MAX_BYTES = 450 * 1024 * 1024

function readbackSpans(tracePath, pageNowAtSync) {
  const size = fs.statSync(tracePath).size
  if (size > MAX_BYTES) {
    return {
      note: `trace ${Math.round(
        size / 1e6
      )} MB is too large to parse; no read-back figure`
    }
  }
  const d = JSON.parse(fs.readFileSync(tracePath, 'utf8'))
  const ev = Array.isArray(d) ? d : d.traceEvents
  const names = new Map()
  for (const e of ev) {
    if (e.ph === 'M' && e.name === 'thread_name') {
      names.set(`${e.pid}:${e.tid}`, e.args.name)
    }
  }
  const sync = ev.find(
    (e) =>
      e.name === 'TimeStamp' &&
      e.args &&
      e.args.data &&
      e.args.data.message === 'perf-sync'
  )
  if (!sync)
    return { note: 'trace has no perf-sync TimeStamp; no read-back figure' }
  // The renderer main thread that did the work: most events among CrRendererMain.
  const count = new Map()
  for (const e of ev) {
    const k = `${e.pid}:${e.tid}`
    if (names.get(k) === 'CrRendererMain') count.set(k, (count.get(k) || 0) + 1)
  }
  const main = Array.from(count.entries()).sort((a, b) => b[1] - a[1])[0]
  if (!main) return { note: 'trace has no CrRendererMain thread' }
  const spans = []
  const open = []
  for (const e of ev) {
    if (`${e.pid}:${e.tid}` !== main[0] || e.name !== WAIT) continue
    if (e.ph === 'X' && e.dur != null) spans.push([e.ts, e.ts + e.dur])
    else if (e.ph === 'B') open.push(e.ts)
    else if (e.ph === 'E' && open.length) spans.push([open.pop(), e.ts])
  }
  const toPage = (ts) => (ts - sync.ts) / 1000 + pageNowAtSync
  return {
    spans: spans.map(([a, b]) => [toPage(a), toPage(b)]),
    totalMs: Math.round(spans.reduce((s, [a, b]) => s + (b - a), 0) / 1000)
  }
}

/** Milliseconds of [from, to] covered by the spans (spans are disjoint on one thread). */
function overlapMs(spans, from, to) {
  let sum = 0
  for (const [a, b] of spans) {
    const lo = Math.max(a, from)
    const hi = Math.min(b, to)
    if (hi > lo) sum += hi - lo
  }
  return sum
}

module.exports = {
  overlapMs,
  readbackSpans,
  TRACE_CATEGORIES: [
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'toplevel',
    'v8.execute',
    'blink',
    'blink.user_timing',
    'cc',
    'gpu',
    'viz',
    'disabled-by-default-devtools.timeline.frame'
  ]
}
