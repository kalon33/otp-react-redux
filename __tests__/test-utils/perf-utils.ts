/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Micro-benchmark helpers for the main-thread audit (gomode/perf-audit).
 * These are measurements, not assertions: each prints medians and passes.
 * Lives in test-utils/ (not perf/) so jest's testPathIgnorePatterns keeps it
 * from being collected as a spec. Run benches with scripts/perf/bench.sh.
 *
 * Inputs that are not in the repo are located by env vars:
 *   PERF_CAPTURES_DIR  store captures (capture*.json)      default /perfdata
 *   PERF_FIXTURES_DIR  Go Mode replay fixtures (*.json)    default /perffixtures
 *   PERF_AUDIT_DIR     debug-log day-file windows          default /auditdata
 * (the defaults are the mount points scripts/perf/bench.sh uses in docker).
 */
import { existsSync, readFileSync } from 'fs'
import { performance } from 'perf_hooks'

export const PERF_CAPTURES_DIR = process.env.PERF_CAPTURES_DIR || '/perfdata'
export const PERF_FIXTURES_DIR =
  process.env.PERF_FIXTURES_DIR || '/perffixtures'
export const PERF_AUDIT_DIR = process.env.PERF_AUDIT_DIR || '/auditdata'

/**
 * Runs `testFn` (pass jest's `it`) or `testFn.skip` naming the path it looked for
 * when the input is absent, so a missing capture shows up as a skipped test, not a
 * throw or a silent pass. (`it` is passed in so this file holds no test calls.)
 */
export function itInput(
  testFn: jest.It,
  inputPath: string,
  name: string,
  fn: () => void | Promise<void>
): void {
  if (existsSync(inputPath)) testFn(name, fn)
  else testFn.skip(`${name} (missing input: ${inputPath})`, fn)
}

export function loadJson(path: string): any {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** 1 warm-up + `runs` timed runs; returns the median ms. */
export function bench(
  label: string,
  fn: (i: number) => unknown,
  { runs = 7, warmup = 1 }: { runs?: number; warmup?: number } = {}
): number {
  for (let i = 0; i < warmup; i++) fn(-1 - i)
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn(i)
    times.push(performance.now() - t0)
  }
  const med = median(times)
  report(label, med, times)
  return med
}

export const lines: string[] = []
export function report(label: string, med: number, times?: number[]): void {
  const line = `${label.padEnd(64)} median ${med
    .toFixed(2)
    .padStart(9)} ms  (~${(med * 4).toFixed(0).padStart(6)} ms iPhone est.)${
    times ? `  runs=[${times.map((t) => t.toFixed(1)).join(',')}]` : ''
  }`
  lines.push(line)
  process.stdout.write(line + '\n')
}
export function note(text: string): void {
  lines.push(text)
  process.stdout.write(text + '\n')
}
