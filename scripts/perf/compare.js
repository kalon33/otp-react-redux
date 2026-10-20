#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Before -> after per scenario:
 *   node scripts/perf/compare.js <baseline summary.json> <candidate summary.json>
 * A delta is candidate minus baseline; negative is better for every column.
 */
const fs = require('fs')

const [basePath, candPath] = process.argv.slice(2)
if (!basePath || !candPath) {
  console.error(
    'usage: compare.js <baseline summary.json> <candidate summary.json>'
  )
  process.exit(1)
}
const base = JSON.parse(fs.readFileSync(basePath, 'utf8'))
const cand = JSON.parse(fs.readFileSync(candPath, 'utf8'))

const metrics = [
  ['tap p50', (s) => s.taps && s.taps.p50],
  ['tap p95', (s) => s.taps && s.taps.p95],
  ['tap max', (s) => s.taps && s.taps.max],
  ['LT >50', (s) => s.longTasks && s.longTasks.n],
  ['LT >200', (s) => s.longTasks && s.longTasks.over200],
  ['LT >500', (s) => s.longTasks && s.longTasks.over500],
  ['LT max', (s) => s.longTasks && s.longTasks.maxMs],
  ['LT sum', (s) => s.longTasks && s.longTasks.sumMs],
  ['tick p50', (s) => s.goMode && s.goMode.perTickMs.p50],
  ['tick p95', (s) => s.goMode && s.goMode.perTickMs.p95],
  ['tick max', (s) => s.goMode && s.goMode.perTickMs.max],
  ['steady >200', (s) => s.goMode && s.goMode.steadyLongTasks.over200]
]

const fmt = (b, c) => {
  if (b == null && c == null) return '–'
  if (b == null || c == null) return `${b ?? '–'} -> ${c ?? '–'}`
  const d = c - b
  const pct = b ? ` (${d > 0 ? '+' : ''}${Math.round((d / b) * 100)}%)` : ''
  return `${b} -> ${c} ${d > 0 ? '+' : ''}${d}${pct}`
}

console.log(
  `### ${base.label} (CPU ${base.cpuThrottle}x) -> ${cand.label} (CPU ${cand.cpuThrottle}x)\n`
)
if (
  base.cpuThrottle !== cand.cpuThrottle ||
  base.quietConsole !== cand.quietConsole
) {
  console.log(
    '**Warning:** the two runs differ in CPU throttle or console silencing; the deltas mix configurations.\n'
  )
}
const names = Array.from(
  new Set([...Object.keys(base.scenarios), ...Object.keys(cand.scenarios)])
)
for (const name of names) {
  const b = base.scenarios[name]
  const c = cand.scenarios[name]
  if (!b || !c || b.skipped || c.skipped) {
    console.log(
      `- **${name}**: only in ${b && !b.skipped ? 'baseline' : 'candidate'}`
    )
    continue
  }
  const cells = metrics
    .map(([label, get]) => [label, get(b), get(c)])
    .filter(([, x, y]) => x != null || y != null)
    .map(([label, x, y]) => `${label} ${fmt(x, y)}`)
  console.log(`- **${name}**: ${cells.join(' · ')}`)
}
