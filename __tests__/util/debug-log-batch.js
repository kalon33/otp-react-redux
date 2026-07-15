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
