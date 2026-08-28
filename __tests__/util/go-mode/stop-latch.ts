import { latchStopsRemaining } from '../../../lib/util/go-mode/next-stop'
import type { StopCountLatch } from '../../../lib/util/go-mode/next-stop'

describe('util > go-mode > latchStopsRemaining', () => {
  const first = (over: any = {}) => ({
    legIndex: 2,
    source: 'gps',
    stopsRemaining: 7,
    ...over
  })

  it('passes the first reading through untouched', () => {
    const { next, stopsRemaining } = latchStopsRemaining(null, first())
    expect(stopsRemaining).toBe(7)
    expect(next).toEqual({ legIndex: 2, source: 'gps', stopsRemaining: 7 })
  })

  it('lets the count fall as stops are passed', () => {
    const a = latchStopsRemaining(null, first())
    const b = latchStopsRemaining(a.next, first({ stopsRemaining: 6 }))
    expect(b.stopsRemaining).toBe(6)
  })

  // 2026-08-27 14:21:33 on the Gold Line: the snapper was perfectly stable —
  // progressAlongLeg 0.2158 and segment 71 identical across the flip — and the
  // count still read 7 (Earl St), then 8 (Mounds Blvd), then 7 again. The
  // counter re-decides "passed" from proximity every tick, so no amount of
  // snapper hysteresis can fix this one.
  it('never un-passes a stop', () => {
    const a = latchStopsRemaining(null, first({ stopsRemaining: 7 }))
    const b = latchStopsRemaining(a.next, first({ stopsRemaining: 8 }))
    expect(b.stopsRemaining).toBe(7)
    const c = latchStopsRemaining(b.next, first({ stopsRemaining: 7 }))
    expect(c.stopsRemaining).toBe(7)
  })

  it('starts over on a new leg', () => {
    const a = latchStopsRemaining(null, first({ stopsRemaining: 1 }))
    const b = latchStopsRemaining(
      a.next,
      first({ legIndex: 3, stopsRemaining: 9 })
    )
    expect(b.stopsRemaining).toBe(9)
  })

  // A vehicle-derived count and a GPS-derived one are not measuring the same
  // thing, so pinning a new source to the old source's floor would be a
  // category error — it would silently cap a more trustworthy count.
  it('starts over when the source changes', () => {
    const a = latchStopsRemaining(null, first({ stopsRemaining: 2 }))
    const b = latchStopsRemaining(
      a.next,
      first({ source: 'vehicle', stopsRemaining: 6 })
    )
    expect(b.stopsRemaining).toBe(6)
    expect(b.next.source).toBe('vehicle')
  })

  it('holds the floor across a stationary run', () => {
    let state: StopCountLatch | null = null
    let last = 0
    for (const reading of [5, 5, 6, 5, 6, 6, 4]) {
      const r = latchStopsRemaining(state, first({ stopsRemaining: reading }))
      state = r.next
      last = r.stopsRemaining
    }
    expect(last).toBe(4)
  })
})
