import { epochMs, epochMsOr } from '../../../lib/util/go-mode/time'

/**
 * Trap #5, pinned: itinerary times are `number | string`, and the `Number(x)`
 * idiom this helper replaces returns NaN for every ISO-8601 form OTP emits.
 * The cases below are the ones that reach us from real plan responses.
 */
describe('util > go-mode > time', () => {
  it('passes epoch milliseconds through unchanged', () => {
    expect(epochMs(1769616000000)).toBe(1769616000000)
    expect(epochMs(0)).toBe(0)
  })

  it('parses the ISO forms OTP returns — where Number() gives NaN', () => {
    const cases = [
      '2026-01-28T10:00:00Z',
      '2026-01-28T10:00:00.000Z',
      '2026-01-28T10:00:00-06:00'
    ]
    cases.forEach((iso) => {
      expect(Number.isNaN(Number(iso))).toBe(true) // the old idiom
      expect(epochMs(iso)).toBe(new Date(iso).getTime()) // the new one
      expect(Number.isFinite(epochMs(iso))).toBe(true)
    })
  })

  it('parses a local ISO string with no zone designator', () => {
    // The exact string in HANDOFF trap #5.
    expect(Number.isNaN(Number('2026-01-28T10:00:00'))).toBe(true)
    expect(Number.isFinite(epochMs('2026-01-28T10:00:00'))).toBe(true)
  })

  it('reports absent and unparseable times as NaN rather than 0', () => {
    expect(Number.isNaN(epochMs(null))).toBe(true)
    expect(Number.isNaN(epochMs(undefined))).toBe(true)
    expect(Number.isNaN(epochMs('not a time'))).toBe(true)
  })

  it('falls back only when the time is unusable', () => {
    expect(epochMsOr(null, 7)).toBe(7)
    expect(epochMsOr('nonsense', 7)).toBe(7)
    expect(epochMsOr(0, 7)).toBe(0)
    expect(epochMsOr('2026-01-28T10:00:00Z', 7)).toBe(
      new Date('2026-01-28T10:00:00Z').getTime()
    )
  })
})
