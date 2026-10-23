/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * T1 extras, T4, T5 and the Go Mode map's per-tick GeoJSON:
 *  - RoutePreviewOverlay per dispatch: decode + react-maplibre's deepEqual
 *  - doMergeItineraries' lodash.memoize cache: bytes retained per entry
 *  - GoModeMap routeGeoJson recompute per tick
 *  - debug-log selectBatch (O(n^2) prefix stringify) vs a linear prefix sum
 *
 * Run: scripts/perf/bench.sh results-extras.perf.ts (PERF_BENCH=1; inputs from
 * PERF_CAPTURES_DIR, PERF_FIXTURES_DIR, PERF_AUDIT_DIR — see test-utils/perf-utils.ts).
 */
import '../test-utils/mock-window-matchMedia'
import '../test-utils/mock-window-url'
import cloneDeep from 'lodash/cloneDeep'
import polyline from '@mapbox/polyline'

import {
  bench,
  itInput,
  loadJson,
  note,
  PERF_AUDIT_DIR,
  PERF_CAPTURES_DIR,
  PERF_FIXTURES_DIR
} from '../test-utils/perf-utils'
import { doMergeItineraries } from '../../lib/components/narrative/narrative-itineraries'
import { getActiveItineraries } from '../../lib/util/state'
import { getMockInitialState } from '../test-utils/mock-data/store'
import { measureEntry } from '../../lib/util/debug-log-entry'
import { mapStateToProps as previewMapStateToProps } from '../../lib/components/map/route-preview-overlay'
import { selectBatch } from '../../lib/util/debug-log-batch'

// Benchmarks take minutes and need data that CI lacks: skipped unless PERF_BENCH=1
// (scripts/perf/bench.sh sets it). A plain `yarn unit` skips this file.
const RUN = process.env.PERF_BENCH === '1'
const describeBench = RUN ? describe : describe.skip

/** react-maplibre 8.0.4 dist/index.cjs:106 deepEqual, verbatim. */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  } else if (Array.isArray(b)) return false
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false
      if (!deepEqual(a[key], b[key])) return false
    }
    return true
  }
  return false
}

/** route-preview-overlay.tsx:46-58, the render body. */
function previewGeoJson(geometries: string[]) {
  const unique = Array.from(new Set(geometries))
  return {
    features: unique
      .filter((s) => !!s)
      .map((segment) => ({
        geometry: polyline.toGeoJSON(segment),
        properties: [],
        type: 'Feature'
      })),
    type: 'FeatureCollection'
  }
}

function stateFor(capture: any, k: number) {
  const base = getMockInitialState()
  const search = cloneDeep(capture.search)
  search.response = search.response.slice(0, k)
  search.pending = 0
  base.otp.config = {
    ...base.otp.config,
    co2: capture.config.co2,
    homeTimezone: capture.config.homeTimezone,
    itinerary: capture.config.itinerary
  }
  base.otp.filter = capture.filter
  base.otp.currentQuery = capture.currentQuery
  base.otp.searches = { [capture.activeSearchId]: search }
  base.otp.activeSearchId = capture.activeSearchId
  return base
}

function stringifyDroppingCycles(value: any): string {
  const seen = new WeakSet()
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return undefined
      seen.add(v)
    }
    return v
  })
}

function getGc(): (() => void) | null {
  try {
    const v8 = jest.requireActual('v8')
    const vm = jest.requireActual('vm')
    v8.setFlagsFromString('--expose_gc')
    return vm.runInNewContext('gc')
  } catch {
    return null
  }
}

const CAPTURES = (
  process.env.PERF_CAPTURES ||
  'capture.json,capture3.json,capture4.json,capture5.json'
).split(',')

describeBench('T1 extras: preview overlay + merge memo retention', () => {
  jest.setTimeout(900000)
  beforeAll(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  CAPTURES.forEach((name) =>
    itInput(it, `${PERF_CAPTURES_DIR}/${name}`, name, () => {
      const capture = loadJson(`${PERF_CAPTURES_DIR}/${name}`)
      const n = capture.search.response.length
      const state: any = stateFor(capture, n)
      const cfg = state.otp.config.itinerary
      const itins = getActiveItineraries(state)
      const { mergedItineraries } = doMergeItineraries(
        itins,
        cfg.defaultFareType,
        cfg.mergeByRouteSignature
      )
      note(
        `\n=== ${name}: responses=${n} itineraries=${itins.length} rows=${mergedItineraries.length}`
      )

      // (1) RoutePreviewOverlay per dispatch
      const s2 = { ...state, otp: { ...state.otp, lastActionMillis: 1 } }
      const p = previewMapStateToProps(s2)
      const geoms: string[] = p.geometries || []
      note(
        `    preview: visible=${p.visible} legGeometries=${
          geoms.length
        } unique=${new Set(geoms).size} polylineChars(unique)=${Array.from(
          new Set(geoms)
        ).reduce((a, g) => a + (g?.length || 0), 0)}`
      )
      let prev = previewGeoJson(geoms)
      bench('  preview mapStateToProps (flatMap -> new array)', () =>
        previewMapStateToProps(s2)
      )
      bench(
        '  preview render: Set + polyline.toGeoJSON of every unique leg',
        () => {
          prev = previewGeoJson(geoms)
        }
      )
      const next = previewGeoJson(geoms)
      let eq = false
      bench(
        '  react-maplibre Source deepEqual(prev, next) on the new data',
        () => {
          eq = deepEqual(prev, next)
        }
      )
      note(
        `    -> equal (so no setData): ${eq}; points=${next.features.reduce(
          (a: number, f: any) => a + f.geometry.coordinates.length,
          0
        )}`
      )

      // (2) doMergeItineraries memo: one entry per new array identity
      const gc = getGc()
      const cache: any = (doMergeItineraries as any).cache
      cache.clear()
      gc?.()
      gc?.()
      const h0 = process.memoryUsage().heapUsed
      const N = 5
      const keep: any[] = []
      for (let i = 0; i < N; i++) {
        // A new array identity of the same rows, as a timetable fill produces
        // (collectItinerariesWithoutDuplicates spreads every itinerary).
        const arr = itins.map((it: any) => ({ ...it }))
        keep.push(arr)
        doMergeItineraries(arr, cfg.defaultFareType, cfg.mergeByRouteSignature)
      }
      gc?.()
      gc?.()
      const h1 = process.memoryUsage().heapUsed
      keep.length = 0
      gc?.()
      gc?.()
      const h1b = process.memoryUsage().heapUsed
      cache.clear()
      gc?.()
      gc?.()
      const h2 = process.memoryUsage().heapUsed
      const merged = doMergeItineraries(
        itins,
        cfg.defaultFareType,
        cfg.mergeByRouteSignature
      )
      const mergedJson = stringifyDroppingCycles(
        merged.mergedItineraries
      ).length
      const allJson = stringifyDroppingCycles(merged.allItineraries).length
      note(
        `    merge memo: gc=${!!gc} heap/entry while cached=${(
          (h1 - h0) /
          N /
          1e6
        ).toFixed(2)} MB; after dropping inputs but keeping cache=${(
          (h1b - h0) /
          N /
          1e6
        ).toFixed(2)} MB/entry; after cache.clear()=${((h2 - h0) / 1e6).toFixed(
          2
        )} MB total; JSON proxy merged=${(mergedJson / 1e6).toFixed(
          2
        )} MB all=${(allJson / 1e6).toFixed(2)} MB (cycle-dropped)`
      )
      cache.clear()
    })
  )
})

describeBench('Go Mode map: GoModeMap.tsx:943 routeGeoJson per tick', () => {
  const names = (
    process.env.PERF_FIXTURES_LIST ||
    'gold-1631-1019.json,orange-1655-1012.json,ride-1020-0907.json'
  ).split(',')
  names.forEach((name) =>
    itInput(it, `${PERF_FIXTURES_DIR}/${name}`, name, () => {
      const fx = loadJson(`${PERF_FIXTURES_DIR}/${name}`)
      const legs = fx.itinerary.legs
      const build = (
        riderPoint: [number, number] | null,
        ridingLegIndex: number
      ) => ({
        features: legs
          .map((leg: any, index: number) => ({ index, leg }))
          .filter(({ leg }: any) => leg.legGeometry?.points)
          .map(({ index, leg }: any) => {
            const geometry: any = polyline.toGeoJSON(leg.legGeometry.points)
            if (riderPoint && index === ridingLegIndex)
              geometry.coordinates = [riderPoint, ...geometry.coordinates]
            return {
              geometry,
              properties: { index, isActive: false },
              type: 'Feature'
            }
          }),
        type: 'FeatureCollection'
      })
      const a = build(null, -1)
      note(
        `\n=== ${name}: legs=${legs.length} points=${a.features.reduce(
          (s: number, f: any) => s + f.geometry.coordinates.length,
          0
        )}`
      )
      bench('  routeGeoJson rebuild (every leg decoded)', () => build(null, -1))
      const b = build(null, -1)
      bench('  Source deepEqual(prev, next), unchanged content', () =>
        deepEqual(a, b)
      )
    })
  )
})

describeBench('T5 debug-log selectBatch', () => {
  jest.setTimeout(900000)
  const wrapper = (entries: any[]) =>
    JSON.stringify({
      build: '1.0.123 web:abcdef012',
      deviceId: 'dev-mvfjilni-z7v6unp7',
      entries,
      href: 'capacitor://localhost#/?ui_activeSearch=4vnme5ozb&fromPlace=6th%20St',
      sessionId: 'mvfqu4i0-yd2epd',
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15'
    })
  /** The linear candidate: prefix sums of each entry's own stringify length. */
  const selectBatchLinear = (
    entries: any[],
    maxBytes: number,
    sizes: number[]
  ) => {
    const max = Math.min(entries.length, 200)
    const base = wrapper([]).length
    let total = base
    let n = 0
    while (n < max) {
      total += sizes[n] + (n > 0 ? 1 : 0)
      if (n > 0 && total > maxBytes) break
      n++
    }
    return entries.slice(0, Math.max(1, n))
  }

  ;['debuglog-window-go.json', 'debuglog-window-heavy.json'].forEach((file) =>
    itInput(it, `${PERF_AUDIT_DIR}/${file}`, file, () => {
      const entries = loadJson(`${PERF_AUDIT_DIR}/${file}`)
      const chars = entries.reduce(
        (s: number, e: any) => s + JSON.stringify(e).length,
        0
      )
      note(`\n=== ${file}: ${entries.length} entries, ${chars} chars`)
      let got: any[] = []
      bench('  selectBatch(buffer, 1.4 MB, buildBatch) [flush path]', () => {
        got = selectBatch(entries, 1400000, wrapper)
      })
      note(`    -> batch of ${got.length}`)
      bench('  selectBatch(buffer, 60 kB) [one flushBeacon slice]', () =>
        selectBatch(entries, 60000, wrapper)
      )
      bench(
        '  measureEntry for every entry (the push-time 2nd stringify)',
        () => entries.forEach((e: any) => measureEntry(e))
      )
      const sizes = entries.map((e: any) => measureEntry(e))
      let lin: any[] = []
      bench('  linear prefix-sum selection (same inputs)', () => {
        lin = selectBatchLinear(entries, 1400000, sizes)
      })
      const same1 = lin.length === got.length
      const same2 =
        selectBatchLinear(entries, 60000, sizes).length ===
        selectBatch(entries, 60000, wrapper).length
      note(
        `    -> linear picks identical batch: 1.4MB ${same1}, 60kB ${same2}; wrapper(prefix) === sum check ${
          wrapper(entries.slice(0, 50)).length ===
          wrapper([]).length +
            sizes.slice(0, 50).reduce((s: number, x: number) => s + x, 0) +
            49
        }`
      )
      note(
        `    -> selectBatch stringifies ~${
          got.length
            ? ((got.length * wrapper(got).length) / 2 / 1e6).toFixed(1)
            : 0
        } MB to pick one 1.4 MB batch`
      )
    })
  )
})
