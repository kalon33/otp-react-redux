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
// 75.35 (P8e): `multistop-28` was renamed `multistop` (the name claimed a row
// count that is 15 on the desktop OTP and 31 on production). A baseline taken
// under the old name is read as the new one.
const ALIASES = {
  'multistop-28': 'multistop',
  'multistop-28~2': 'multistop~2'
}
const renamed = (o) =>
  Object.fromEntries(
    Object.entries(o.scenarios).map(([k, v]) => [ALIASES[k] || k, v])
  )

const base = JSON.parse(fs.readFileSync(basePath, 'utf8'))
const cand = JSON.parse(fs.readFileSync(candPath, 'utf8'))
base.scenarios = renamed(base)
cand.scenarios = renamed(cand)

const metrics = [
  ['tap p50', (s) => s.taps && s.taps.p50],
  ['tap p95', (s) => s.taps && s.taps.p95],
  ['tap max', (s) => s.taps && s.taps.max],
  ['tap p95 gated', (s) => s.taps && s.taps.gated && s.taps.gated.p95],
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
  base.quietConsole !== cand.quietConsole ||
  !!base.speedy !== !!cand.speedy
) {
  console.log(
    `**Warning:** the two runs differ in CPU throttle, console silencing or SPEEDY (${!!base.speedy} -> ${!!cand.speedy}); the deltas mix configurations.\n`
  )
}
const names = Array.from(
  new Set([...Object.keys(base.scenarios), ...Object.keys(cand.scenarios)])
)
for (const name of names) {
  const b = base.scenarios[name]
  const c = cand.scenarios[name]
  // A scenario is "present" when it has a usable summary. Say which side has
  // it (or neither/skipped), instead of defaulting to "candidate" when the
  // candidate lacks it (75.35 P8d).
  const has = (x) => !!x && !x.skipped
  if (!has(b) || !has(c)) {
    const where = has(b) ? 'baseline' : has(c) ? 'candidate' : 'neither'
    const why = []
    if (b && b.skipped) why.push(`baseline skipped: ${b.skipped}`)
    if (c && c.skipped) why.push(`candidate skipped: ${c.skipped}`)
    if (!b) why.push('absent from baseline')
    if (!c) why.push('absent from candidate')
    console.log(
      `- **${name}**: only in ${where}${
        why.length ? ` (${why.join('; ')})` : ''
      }`
    )
    continue
  }
  const partial = [b.partial && 'baseline', c.partial && 'candidate']
    .filter(Boolean)
    .join(' and ')
  const cells = metrics
    .map(([label, get]) => [label, get(b), get(c)])
    .filter(([, x, y]) => x != null || y != null)
    .map(([label, x, y]) => `${label} ${fmt(x, y)}`)
  console.log(
    `- **${name}**: ${cells.join(' · ')}${
      partial
        ? ` · **PARTIAL in ${partial}: long-task columns are not comparable**`
        : ''
    }`
  )
}
