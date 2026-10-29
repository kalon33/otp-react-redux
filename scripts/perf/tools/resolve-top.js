/* eslint-disable prettier/prettier */
/* eslint-disable no-console */
// Top-N self-time functions of a .cpuprofile, each resolved through the dev
// server's source maps to the ORIGINAL file:line (app modules: the module's
// inline map; pre-bundled deps: node_modules/.vite/deps/<chunk>.js.map).
//   NODE_PATH=<shared node_modules> APP_URL=http://127.0.0.1:9991 node scripts/perf/tools/resolve-top.js <file.cpuprofile> [N]
//   (needs the dev server up and source-map-js, which is in the app's node_modules)
const fs = require('fs')

const { SourceMapConsumer } = require('source-map-js')
const [file, nArg] = process.argv.slice(2)
const N = Number(nArg || 10)
const profile = JSON.parse(fs.readFileSync(file, 'utf8'))
const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]))
const parent = new Map()
for (const nd of profile.nodes)
  for (const c of nd.children || []) parent.set(c, nd.id)
const key = (cf) =>
  `${cf.functionName || '(anonymous)'}|${cf.url}|${cf.lineNumber}|${
    cf.columnNumber
  }`
const self = new Map()
const total = new Map()
const cfOf = new Map()
let all = 0
for (let i = 0; i < profile.samples.length; i++) {
  const dt = (profile.timeDeltas[i + 1] || 0) / 1000
  const leaf = byId.get(profile.samples[i])
  const k = key(leaf.callFrame)
  cfOf.set(k, leaf.callFrame)
  self.set(k, (self.get(k) || 0) + dt)
  if (!/^\((idle)\)/.test(leaf.callFrame.functionName)) all += dt
  const seen = new Set()
  for (let id = profile.samples[i]; id != null; id = parent.get(id)) {
    const cf = byId.get(id).callFrame
    const kk = key(cf)
    if (seen.has(kk)) continue
    seen.add(kk)
    cfOf.set(kk, cf)
    total.set(kk, (total.get(kk) || 0) + dt)
  }
}
const cache = new Map()
async function consumerFor(url) {
  const bare = url.replace(/\?.*$/, '')
  if (cache.has(bare)) return cache.get(bare)
  let c = null
  try {
    if (/\/node_modules\/\.vite\/deps\//.test(bare)) {
      const m = await fetch(bare + '.map').then((r) => r.json())
      c = new SourceMapConsumer(m)
    } else {
      const src = await fetch(url).then((r) => r.text())
      const mm =
        /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/m.exec(
          src
        )
      if (mm)
        c = new SourceMapConsumer(
          JSON.parse(Buffer.from(mm[1], 'base64').toString('utf8'))
        )
    }
  } catch (e) {
    c = null
  }
  cache.set(bare, c)
  return c
}
(async () => {
  const rows = Array.from(self.entries())
    .filter(([k]) => !/^\((idle|program|garbage collector)\)\|/.test(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, N)
  console.log(
    `non-idle sampled time ${all.toFixed(1)} ms; (program) ${(
      self.get(
        Array.from(self.keys()).find((k) => k.startsWith('(program)|')) || 0
      ) || 0
    ).toFixed(1)} ms; (garbage collector) ${(
      self.get(
        Array.from(self.keys()).find((k) =>
          k.startsWith('(garbage collector)|')
        ) || 0
      ) || 0
    ).toFixed(1)} ms`
  )
  console.log(
    'self ms | total ms | function | served file:line | original file:line'
  )
  for (const [k, ms] of rows) {
    const cf = cfOf.get(k)
    const served = (cf.url || '(native)')
      .replace(/^.*\/\/[^/]+/, '')
      .replace(/\?.*$/, '')
    let orig = ''
    if (cf.url && /^https?:/.test(cf.url)) {
      const c = await consumerFor(cf.url)
      if (c) {
        const p = c.originalPositionFor({
          column: cf.columnNumber,
          line: cf.lineNumber + 1
        })
        if (p && p.source)
          orig = `${p.source
            .replace(/^.*node_modules\//, 'node_modules/')
            .replace(/^(\.\.\/)+/, '')}:${p.line}${
            p.name ? ' (' + p.name + ')' : ''
          }`
      }
    }
    console.log(
      `${ms.toFixed(1)} | ${(total.get(k) || ms).toFixed(1)} | ${
        cf.functionName || '(anonymous)'
      } | ${served}:${cf.lineNumber + 1} | ${orig || '–'}`
    )
  }
})()
