import {
  latchStopsRemaining,
  stopListSignature
} from '../../../lib/util/go-mode/next-stop'
import type { StopCountLatch } from '../../../lib/util/go-mode/next-stop'

/**
 * A leg the floor can be keyed to: `stops` intermediate stops with
 * coordinates, plus the alight stop. `orderedStopsOnLeg` counts
 * intermediates + 1, so a leg with 4 intermediates holds 5 stops.
 */
const legWith = (alight: string, stops: number) => ({
  intermediatePlaces: Array.from({ length: stops }, (_, i) => ({
    lat: 44.9 + i / 1000,
    lon: -93.3,
    name: `stop ${i}`
  })),
  to: { lat: 44.95, lon: -93.3, name: alight }
})

const ORANGE_11TH = legWith('2nd Ave S & 11th St - Stop Group F', 4)
const ORANGE_5TH = legWith('2nd Ave S & 5th St - Stop Group F', 5)

describe('util > go-mode > latchStopsRemaining', () => {
  const first = (over: any = {}) => ({
    leg: ORANGE_11TH,
    legIndex: 2,
    stopsRemaining: 7,
    trusted: true,
    ...over
  })

  it('passes the first reading through untouched', () => {
    const { next, stopsRemaining } = latchStopsRemaining(null, first())
    expect(stopsRemaining).toBe(7)
    expect(next.stopsRemaining).toBe(7)
    expect(next.legKey).toBe(stopListSignature(2, ORANGE_11TH))
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

  it('holds the floor, not the last reading, while a rise persists', () => {
    let state: StopCountLatch | null = null
    let last = 0
    for (const reading of [4, 6, 6, 6]) {
      const r = latchStopsRemaining(state, first({ stopsRemaining: reading }))
      state = r.next
      last = r.stopsRemaining
    }
    expect(last).toBe(4)
  })

  it('starts over on a new leg', () => {
    const a = latchStopsRemaining(null, first({ stopsRemaining: 1 }))
    const b = latchStopsRemaining(
      a.next,
      first({ legIndex: 3, stopsRemaining: 9 })
    )
    expect(b.stopsRemaining).toBe(9)
  })

  /**
   * 2026-09-08 11:25:54 on the Orange Line, backlog 12.10's first sighting:
   * `stopsSource` flipped gps -> vehicle for seven seconds and the count went
   * 4 (next stop I-35W & 66th) back to 5 (I-35W & 46th) — a stop un-passed —
   * then back to 4 at 11:26:01 when the source flipped back. currentLegProgress
   * was flat across the whole span (19.276 -> 19.270 -> 19.280 -> 19.273), so
   * the projection did not move: the floor restarting on a source change did.
   */
  it('holds the floor across a source flip (2026-09-08 11:25:54)', () => {
    const gps = latchStopsRemaining(null, first({ stopsRemaining: 4 }))
    const vehicle = latchStopsRemaining(gps.next, first({ stopsRemaining: 5 }))
    expect(vehicle.stopsRemaining).toBe(4)
    const back = latchStopsRemaining(vehicle.next, first({ stopsRemaining: 4 }))
    expect(back.stopsRemaining).toBe(4)
  })

  /**
   * 2026-09-15 15:44:06.753, backlog 12.10's second sighting: START_GO_MODE
   * replaced leg 0 (Knox Ave & American Blvd -> 2nd Ave S & 11th, 5 stops)
   * with a longer leg at the same index (Knox Ave & 76th -> 2nd Ave S & 5th,
   * 6 stops). The floor followed it across and pinned the new leg's honest 6
   * to 4 for 3m5s, until the mid-ride relaunch at 15:47:11.810 wiped the
   * in-memory latch and the truthful count appeared as a rise at 15:47:12.056.
   * A different stop list is a different measurement.
   */
  it('restarts the floor when a re-plan swaps the stop list (2026-09-15 15:44:06.753)', () => {
    const before = latchStopsRemaining(
      null,
      first({ leg: ORANGE_11TH, legIndex: 0, stopsRemaining: 4 })
    )
    expect(before.stopsRemaining).toBe(4)
    const after = latchStopsRemaining(
      before.next,
      first({ leg: ORANGE_5TH, legIndex: 0, stopsRemaining: 6 })
    )
    expect(after.stopsRemaining).toBe(6)
    // ...and the new list gets its own floor from there: still no un-passing.
    const wobble = latchStopsRemaining(
      after.next,
      first({ leg: ORANGE_5TH, legIndex: 0, stopsRemaining: 7 })
    )
    expect(wobble.stopsRemaining).toBe(6)
  })

  /**
   * The same rise WITHOUT a swap stays suppressed — which is what makes the
   * test above a statement about the itinerary and not a hole in the floor.
   */
  it('keeps a same-list rise suppressed', () => {
    const before = latchStopsRemaining(
      null,
      first({ leg: ORANGE_5TH, legIndex: 0, stopsRemaining: 4 })
    )
    const after = latchStopsRemaining(
      before.next,
      first({ leg: ORANGE_5TH, legIndex: 0, stopsRemaining: 6 })
    )
    expect(after.stopsRemaining).toBe(4)
  })

  /**
   * Degraded data holds the last good count rather than publishing a short
   * one: an untrusted reading is the collapsed stop list
   * (hasDegenerateStopList) or the even-spacing schedule guess, and neither is
   * evidence that the rider passed anything.
   */
  it('holds the last good count through an untrusted reading', () => {
    const good = latchStopsRemaining(null, first({ stopsRemaining: 5 }))
    const degraded = latchStopsRemaining(
      good.next,
      first({ stopsRemaining: 1, trusted: false })
    )
    expect(degraded.stopsRemaining).toBe(5)
    expect(degraded.next.stopsRemaining).toBe(5)
    // The floor is untouched, so the next trusted reading measures against it.
    const recovered = latchStopsRemaining(
      degraded.next,
      first({ stopsRemaining: 4 })
    )
    expect(recovered.stopsRemaining).toBe(4)
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

describe('util > go-mode > stopListSignature', () => {
  it('separates two legs that differ only by where they end', () => {
    expect(stopListSignature(0, ORANGE_11TH)).not.toBe(
      stopListSignature(0, ORANGE_5TH)
    )
  })

  it('is stable for the same leg at the same index', () => {
    expect(stopListSignature(0, ORANGE_5TH)).toBe(
      stopListSignature(0, legWith('2nd Ave S & 5th St - Stop Group F', 5))
    )
  })

  it('separates the same leg shape at two indexes', () => {
    expect(stopListSignature(0, ORANGE_5TH)).not.toBe(
      stopListSignature(1, ORANGE_5TH)
    )
  })
})
