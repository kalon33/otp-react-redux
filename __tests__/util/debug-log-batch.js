import { MAX_BATCH, selectBatch } from '../../lib/util/debug-log-batch'

const build = (entries) => JSON.stringify({ entries })

describe('selectBatch', () => {
  it('returns the largest prefix under the byte cap', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      i,
      pad: 'x'.repeat(100)
    }))
    const one = build([entries[0]]).length
    // Cap sized for ~3 entries.
    const batch = selectBatch(entries, one * 3 + 10, build)
    expect(batch.length).toBeGreaterThanOrEqual(2)
    expect(batch.length).toBeLessThan(10)
    expect(build(batch).length).toBeLessThanOrEqual(one * 3 + 10)
  })

  it('always returns at least one entry, even oversized', () => {
    const entries = [{ big: 'x'.repeat(100_000) }]
    const batch = selectBatch(entries, 60_000, build)
    expect(batch).toHaveLength(1)
    // The caller (beacon path) is responsible for checking the built size.
    expect(build(batch).length).toBeGreaterThan(60_000)
  })

  it('never exceeds MAX_BATCH entries', () => {
    const entries = Array.from({ length: MAX_BATCH + 50 }, (_, i) => ({ i }))
    const batch = selectBatch(entries, Number.MAX_SAFE_INTEGER, build)
    expect(batch).toHaveLength(MAX_BATCH)
  })

  it('handles an empty buffer', () => {
    expect(selectBatch([], 1000, build)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 66.6 — selectBatch is linear. The pre-change quadratic implementation is the
// oracle: it stringified every growing prefix. The linear one must pick the
// identical batch for any buffer and cap.
// ---------------------------------------------------------------------------

// Wrapper shaped like debug-log.js buildBatch (fixed fields around entries).
const wrap = (entries) =>
  JSON.stringify({
    build: { sha: 'abc1234', stamp: '2026.1020.1' },
    deviceId: 'dev-mvfjilni-z7v6unp7',
    entries,
    href: 'capacitor://localhost#/?ui_activeSearch=9gr0kbvjv',
    sessionId: 'mvgplnrw-yvtqga',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)'
  })

function quadraticSelectBatch(entries, maxBytes, buildFn) {
  const max = Math.min(entries.length, MAX_BATCH)
  let n = 0
  while (n < max) {
    const size = buildFn(entries.slice(0, n + 1)).length
    if (n > 0 && size > maxBytes) break
    n++
  }
  return entries.slice(0, Math.max(1, n))
}

// Deterministic PRNG so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

// An entry whose JSON.stringify length is exactly `chars`.
function entryOfChars(type, chars, i) {
  const bare = JSON.stringify({ id: i, kind: 'action', pad: '', type }).length
  return {
    id: i,
    kind: 'action',
    pad: 'x'.repeat(Math.max(0, chars - bare)),
    type
  }
}

// sizeOf the way debug-log.js supplies it: a cache filled at push time.
function cachedSizeOf(entries) {
  const m = new WeakMap()
  for (const e of entries) m.set(e, JSON.stringify(e).length)
  return (e) => m.get(e)
}

describe('selectBatch linear vs quadratic oracle', () => {
  it('matches the oracle on ~200 random buffers (with and without sizeOf)', () => {
    const rand = rng(660006)
    for (let trial = 0; trial < 200; trial++) {
      const count = 1 + Math.floor(rand() * 40)
      const entries = Array.from({ length: count }, (_, i) => {
        // Mostly small, with a heavy tail up to 900k chars.
        const chars =
          rand() < 0.08
            ? 50 + Math.floor(rand() * 900_000)
            : 50 + Math.floor(rand() * 5000)
        return entryOfChars('T' + (i % 7), chars, i)
      })
      const total = wrap(entries.slice(0, MAX_BATCH)).length
      const maxBytes =
        rand() < 0.15
          ? Math.floor(rand() * 400) // below even one entry
          : Math.floor(rand() * total * 1.2)
      const want = quadraticSelectBatch(entries, maxBytes, wrap)
      expect(selectBatch(entries, maxBytes, wrap)).toEqual(want)
      expect(
        selectBatch(entries, maxBytes, wrap, cachedSizeOf(entries))
      ).toEqual(want)
    }
  })

  it('falls back to deriving a size when sizeOf has none', () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      entryOfChars('A', 500, i)
    )
    const cap = wrap(entries.slice(0, 10)).length
    expect(selectBatch(entries, cap, wrap, () => undefined)).toEqual(
      quadraticSelectBatch(entries, cap, wrap)
    )
    expect(selectBatch(entries, cap, wrap, () => undefined)).toHaveLength(10)
  })

  it('takes the first entry even when it alone exceeds the cap', () => {
    const entries = [
      entryOfChars('big', 200_000, 0),
      entryOfChars('small', 100, 1)
    ]
    expect(selectBatch(entries, 60_000, wrap)).toHaveLength(1)
    expect(selectBatch(entries, 60_000, wrap, cachedSizeOf(entries))).toEqual(
      quadraticSelectBatch(entries, 60_000, wrap)
    )
  })

  it('stops before an entry that would overflow after an oversized first', () => {
    const entries = [entryOfChars('a', 100, 0), entryOfChars('big', 90_000, 1)]
    const batch = selectBatch(entries, 60_000, wrap, cachedSizeOf(entries))
    expect(batch).toEqual([entries[0]])
  })

  it('caps at MAX_BATCH however loose the byte cap', () => {
    const entries = Array.from({ length: MAX_BATCH + 75 }, (_, i) =>
      entryOfChars('A', 60, i)
    )
    const batch = selectBatch(
      entries,
      Number.MAX_SAFE_INTEGER,
      wrap,
      cachedSizeOf(entries)
    )
    expect(batch).toHaveLength(MAX_BATCH)
  })

  it('matches the oracle on the real 10-20 Go Mode window at both caps', () => {
    // 400 consecutive kind:"action" entries of session mvgplnrw-yvtqga from
    // debug-2026-10-20.jsonl. The raw window is 2.1 MB of state payloads, so
    // the fixture keeps the REAL per-entry sizes and types only; the entries
    // here are padded to exactly those sizes (same distribution, same
    // serialised length, not the same content).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rows = require('../test-utils/mock-data/1020-mvgplnrw-action-sizes.json')
    expect(rows).toHaveLength(400)
    const entries = rows.map(([type, chars], i) => entryOfChars(type, chars, i))
    const sizeOf = cachedSizeOf(entries)
    for (const cap of [1_400_000, 60_000]) {
      for (let offset = 0; offset < entries.length; offset += 37) {
        const slice = entries.slice(offset)
        expect(selectBatch(slice, cap, wrap, sizeOf)).toEqual(
          quadraticSelectBatch(slice, cap, wrap)
        )
        expect(selectBatch(slice, cap, wrap)).toEqual(
          quadraticSelectBatch(slice, cap, wrap)
        )
      }
    }
  })

  it('reports old vs new cost on a 200-entry flush buffer', () => {
    const rows = require('../test-utils/mock-data/1020-mvgplnrw-action-sizes.json')
    const entries = rows
      .slice(0, 200)
      .map(([type, chars], i) => entryOfChars(type, chars, i))
    const sizeOf = cachedSizeOf(entries)
    const bytes = wrap(entries).length
    const time = (fn) => {
      fn() // warm
      const t0 = process.hrtime.bigint()
      const runs = 5
      for (let r = 0; r < runs; r++) fn()
      return Number(process.hrtime.bigint() - t0) / 1e6 / runs
    }
    const oldMs = time(() => quadraticSelectBatch(entries, 1_400_000, wrap))
    const newMs = time(() => selectBatch(entries, 1_400_000, wrap, sizeOf))
    // eslint-disable-next-line no-console
    console.info(
      `selectBatch 200 entries / ${bytes} chars: old ${oldMs.toFixed(
        2
      )} ms, new ${newMs.toFixed(3)} ms`
    )
    expect(newMs).toBeLessThan(oldMs)
  })
})
