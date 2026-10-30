/**
 * Summaries, the Markdown table and the budget gate — shared by run.js and
 * compare.js so a stored summary.json can be re-gated without a browser.
 */

// The allowance arithmetic happens at summary time (the raw tasks are not in
// summary.json), so it reads the committed budget; gate() reads the rest.
const BUDGET = require('./budget.json')

const round = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n))

function quantile(values, q) {
  const xs = values.filter((v) => v != null).sort((a, b) => a - b)
  if (!xs.length) return null
  const idx = Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)
  return xs[Math.max(0, idx)]
}

const dist = (values) => ({
  max: round(values.length ? Math.max(...values) : null),
  n: values.length,
  p50: round(quantile(values, 0.5)),
  p95: round(quantile(values, 0.95))
})

/** Actions recorded INSIDE a task window, and the nearest one before it. */
function attribute(task, actions) {
  const end = task.start + task.dur
  const inside = actions.filter((a) => a.t >= task.start && a.t <= end)
  let before = null
  for (const a of actions) {
    if (a.t < task.start) before = a
    else break
  }
  const counts = {}
  for (const a of inside) counts[a.type] = (counts[a.type] || 0) + 1
  return {
    inside: Object.entries(counts)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 4)
      .map(([type, n]) => (n > 1 ? `${type}x${n}` : type)),
    precededBy: before ? before.type : null,
    precededByMsBefore: before ? round(task.start - before.t) : null
  }
}

/** A tap's protected window: long tasks inside it are the tap's, not steady. */
const tapWindows = (taps) =>
  taps
    .filter((t) => t.start != null)
    .map((t) => [t.start - 50, (t.paintAt || t.start) + 1000])

const inWindows = (t, windows) =>
  windows.some(([a, b]) => t.start + t.dur >= a && t.start <= b)

function summariseGoMode(raw) {
  const { actions, longtasks, taps, ticks } = raw
  const windows = tapWindows(taps)
  // Per-tick work: the tick callback's synchronous time, or — when the whole
  // task went long (its promise continuations and the render they caused run
  // in the same task) — the long task that contains the tick, whichever is
  // larger. A tick under 50 ms has no long-task entry, so its sync time is a
  // lower bound on the task.
  const perTick = ticks.map((tk) => {
    const lt = longtasks.find(
      (l) => tk.start >= l.start - 1 && tk.start <= l.start + l.dur
    )
    return Math.max(tk.syncMs, lt ? lt.dur : 0)
  })
  const tickTasks = longtasks.filter((l) =>
    ticks.some((tk) => tk.start >= l.start - 1 && tk.start <= l.start + l.dur)
  )
  const steady = tickTasks.filter((l) => !inWindows(l, windows))
  const progress = actions.filter(
    (a) => a.type === 'UPDATE_SIMULATION_PROGRESS'
  )
  return {
    perTickMs: dist(perTick),
    perTickSyncMs: dist(ticks.map((t) => t.syncMs)),
    steadyLongTasks: {
      max: round(steady.length ? Math.max(...steady.map((l) => l.dur)) : 0),
      n: steady.length,
      over200: steady.filter((l) => l.dur > 200).length
    },
    ticks: ticks.length,
    ticksPerWallSecond:
      progress.length > 1
        ? Number(
            (
              (progress.length * 1000) /
              (progress[progress.length - 1].t - progress[0].t)
            ).toFixed(2)
          )
        : null
  }
}

function summariseSearch(raw) {
  const { actions, longtasks } = raw
  const after = (a, ms) =>
    longtasks.filter((l) => l.start + l.dur >= a.t - 1 && l.start <= a.t + ms)
  const responses = actions
    .filter((a) => a.type === 'ROUTING_RESPONSE')
    .map((a) => {
      const lts = after(a, 2000)
      return {
        index: a.index,
        itineraries: a.itineraries,
        longTaskMaxMs: round(
          lts.length ? Math.max(...lts.map((l) => l.dur)) : 0
        ),
        longTaskSumMs: round(lts.reduce((s, l) => s + l.dur, 0)),
        searchItineraries: a.searchItineraries,
        t: round(a.t - raw.t0)
      }
    })
  const fills = actions
    .filter((a) => a.type === 'ROUTE_ROW_TIMETABLE' && a.status !== 'pending')
    .map((a) => {
      const lts = after(a, 2000)
      return {
        key: a.key,
        longTaskMaxMs: round(
          lts.length ? Math.max(...lts.map((l) => l.dur)) : 0
        ),
        longTaskSumMs: round(lts.reduce((s, l) => s + l.dur, 0)),
        status: a.status,
        t: round(a.t - raw.t0)
      }
    })
  const variantRows = []
  actions.forEach((a, i) => {
    if (a.type !== 'ITINERARY_VARIANT_ROWS') return
    const prev = actions[i - 1]
    variantRows.push({
      gapMs: prev ? round(a.t - prev.t) : null,
      prevType: prev ? prev.type : null,
      rows: a.rows,
      t: round(a.t - raw.t0),
      variants: a.variants
    })
  })
  return {
    responses,
    routeRowTimetableFills: fills,
    variantRows
  }
}

function summariseScenario(raw) {
  const { actions, longtasks, taps } = raw
  const tapMs = taps.filter((t) => t.ms != null).map((t) => t.ms)
  // 75.35: tap->paint as the app owns it. With a trace (TRACE=1) the GPU
  // read-back the phone never waits for is subtracted per tap; without
  // SPEEDY the dev-only styled-components re-parse lands on each first mount,
  // so those taps are left out of the gated figure. `taps.p50/p95/max` stay
  // the raw numbers (and the committed baselines only have these).
  const measured = taps.filter((t) => t.ms != null)
  const gpuKnown = measured.some((t) => t.readbackMs != null)
  const owned = (t) => t.ms - (t.readbackMs || 0)
  const gatedTaps = measured.filter((t) => raw.speedy || !t.firstMount)
  const gatedBasis =
    [
      gpuKnown ? 'minus GPU read-back' : null,
      raw.speedy ? null : 'first mounts excluded'
    ]
      .filter(Boolean)
      .join(', ') || 'raw'
  const sorted = longtasks.slice().sort((a, b) => b.dur - a.dur)
  const out = {
    actions: actions.length,
    errors: raw.errors || [],
    longTasks: {
      n: longtasks.length,
      over200: longtasks.filter((l) => l.dur > 200).length,
      over500: longtasks.filter((l) => l.dur > 500).length,
      sumMs: round(longtasks.reduce((s, l) => s + l.dur, 0)),
      top5: sorted.slice(0, 5).map((l) => ({
        dur: round(l.dur),
        t: round(l.start - raw.t0),
        ...attribute(l, actions)
      }))
    },
    network: raw.network ? raw.network.summary : null,
    notes: raw.notes || [],
    taps: {
      ...dist(tapMs),
      each: taps.map((t) => ({
        eventTimingMs: t.eventTimingMs != null ? round(t.eventTimingMs) : null,
        firstMount: !!t.firstMount,
        label: t.label,
        ms: round(t.ms),
        readbackMs: t.readbackMs != null ? t.readbackMs : null,
        via: t.via || null
      })),
      gated: { ...dist(gatedTaps.map(owned)), basis: gatedBasis },
      noReadback: gpuKnown ? dist(measured.map(owned)) : null,
      unmeasured: taps.filter((t) => t.ms == null).map((t) => t.label)
    },
    wallSeconds: raw.wallSeconds
  }
  if (raw.kind === 'gomode') {
    out.goMode = summariseGoMode(raw)
    out.replay = raw.replay
  }
  if (raw.kind === 'search') {
    out.search = summariseSearch(raw)
    // 75.35 (P8e): the row count belongs here, not in the scenario's name.
    const st = raw.info && raw.info.settled
    out.search.settled = st
      ? {
          domRows: st.domRows != null ? st.domRows : null,
          itineraries: st.itineraries
        }
      : null
  }
  // Long tasks over the any-task cap that the ROUTING_RESPONSE allowance may
  // excuse: one task <= maxLongTaskMs per fresh response whose search holds
  // >= minSearchItineraries rows (budget.json).
  const allow = BUDGET.routingResponseAllowance
  const bigResponses = actions.filter(
    (a) =>
      a.type === 'ROUTING_RESPONSE' &&
      (a.searchItineraries || 0) >= allow.minSearchItineraries
  )
  const used = new Set()
  const unexcused = longtasks.filter((l) => {
    if (l.dur <= BUDGET.anyLongTaskMaxMs) return false
    if (l.dur > allow.maxLongTaskMs) return true
    const r = bigResponses.find(
      (a) => !used.has(a) && a.t >= l.start - 1 && a.t <= l.start + l.dur + 2000
    )
    if (!r) return true
    used.add(r)
    return false
  })
  out.longTasks.over500Unexcused = unexcused.length
  out.longTasks.maxMs = round(sorted.length ? sorted[0].dur : 0)
  return out
}

/** Evaluate a summary.json against budget.json; returns failure strings. */
function gate(summary, budget) {
  const fails = []
  for (const [name, s] of Object.entries(summary.scenarios || {})) {
    if (s.skipped) continue
    if (s.partial) {
      fails.push(
        `${name}: partial run (${s.partial}); long tasks, ticks and actions were not recorded`
      )
    }
    // 75.35: gate the figure the app owns (gated), not the raw one, when the
    // run recorded it; older summaries only have taps.p95.
    const tapP95 =
      s.taps && s.taps.gated ? s.taps.gated.p95 : s.taps && s.taps.p95
    const tapBasis = s.taps && s.taps.gated ? s.taps.gated.basis : 'raw'
    if (tapP95 != null && tapP95 > budget.tapToPaintP95Ms) {
      fails.push(
        `${name}: tap->paint p95 ${tapP95} ms (${tapBasis}) > ${budget.tapToPaintP95Ms}`
      )
    }
    if (s.goMode) {
      if (s.goMode.steadyLongTasks.max > budget.goModeSteadyLongTaskMaxMs) {
        fails.push(
          `${name}: steady Go Mode long task ${s.goMode.steadyLongTasks.max} ms > ${budget.goModeSteadyLongTaskMaxMs} (${s.goMode.steadyLongTasks.over200} over)`
        )
      }
      if (s.goMode.perTickMs.p95 > budget.perTickWorkP95Ms) {
        fails.push(
          `${name}: per-tick work p95 ${s.goMode.perTickMs.p95} ms > ${budget.perTickWorkP95Ms}`
        )
      }
    }
    if (s.longTasks.over500Unexcused > 0) {
      fails.push(
        `${name}: ${s.longTasks.over500Unexcused} long task(s) > ${budget.anyLongTaskMaxMs} ms outside the ROUTING_RESPONSE allowance (max ${s.longTasks.maxMs} ms)`
      )
    }
  }
  return fails
}

const cell = (v) => (v == null ? '–' : String(v))

function markdownTable(summary) {
  const lines = []
  lines.push(
    `### ${summary.label} — CPU throttle ${summary.cpuThrottle}x, ${summary.appUrl}`
  )
  lines.push('')
  lines.push(
    '| scenario | taps | tap->paint p50 / p95 / max ms | gated p95 ms (basis) | GPU read-back ms | long tasks >50 / >200 / >500 | per-tick p50 / p95 / max ms | steady GM >200 | replay |'
  )
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const [name, s] of Object.entries(summary.scenarios)) {
    if (s.skipped) {
      lines.push(`| ${name} | skipped: ${s.skipped} | | | | | | | |`)
      continue
    }
    const gm = s.goMode
    const st = s.search && s.search.settled
    const label = `${name}${s.partial ? ' (PARTIAL)' : ''}${
      st ? ` (${st.itineraries} itineraries / ${cell(st.domRows)} rows)` : ''
    }`
    const rb = s.taps.each.filter((t) => t.readbackMs != null)
    lines.push(
      `| ${label} | ${s.taps.n} | ${cell(s.taps.p50)} / ${cell(
        s.taps.p95
      )} / ${cell(s.taps.max)} | ${
        s.taps.gated ? `${cell(s.taps.gated.p95)} (${s.taps.gated.basis})` : '–'
      } | ${rb.length ? rb.reduce((n, t) => n + t.readbackMs, 0) : '–'} | ${
        s.longTasks.n
      } / ${s.longTasks.over200} / ${s.longTasks.over500} | ${
        gm
          ? `${cell(gm.perTickMs.p50)} / ${cell(gm.perTickMs.p95)} / ${cell(
              gm.perTickMs.max
            )}`
          : ''
      } | ${gm ? gm.steadyLongTasks.over200 : ''} | ${
        s.replay
          ? `${s.replay.finalStatus} ${s.replay.pointIndex}/${s.replay.totalPoints}`
          : ''
      } |`
    )
  }
  lines.push('')
  lines.push(
    'Top 5 long tasks per scenario (ms @ t, actions inside | preceded by):'
  )
  lines.push('')
  for (const [name, s] of Object.entries(summary.scenarios)) {
    if (s.skipped) continue
    lines.push(
      `- **${name}**: ` +
        (s.longTasks.top5
          .map(
            (l) =>
              `${l.dur} @${(l.t / 1000).toFixed(1)}s [${
                l.inside.join(', ') || '—'
              } | ${l.precededBy || '—'}]`
          )
          .join('; ') || 'none')
    )
  }
  return lines.join('\n')
}

module.exports = {
  dist,
  gate,
  markdownTable,
  quantile,
  round,
  summariseScenario
}
