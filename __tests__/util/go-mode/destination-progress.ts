import {
  DESTINATION_GAIN_MIN_M,
  DESTINATION_STALL_REPLANS,
  destinationStalled,
  noteDestinationDistance,
  noteReplanAttempt
} from '../../../lib/util/go-mode/destination-progress'
import type { DestinationProgressState } from '../../../lib/util/go-mode/destination-progress'

/** Three re-plans into a destination the graph does not reach. */
const stalledAt = (metres: number): DestinationProgressState | null => {
  let state = noteDestinationDistance(null, metres)
  for (let i = 0; i < DESTINATION_STALL_REPLANS; i++) {
    state = noteReplanAttempt(state, 'BICYCLE')
  }
  return state
}

describe('util > go-mode > destination progress across re-plans', () => {
  it('has nothing to say before a distance has been measured', () => {
    expect(noteDestinationDistance(null, null)).toBeNull()
    expect(noteDestinationDistance(null, undefined)).toBeNull()
    expect(noteDestinationDistance(null, Infinity)).toBeNull()
    // And re-plans are not counted against a distance nobody measured — a
    // destination with no coordinates must not retire its own re-planning.
    let unmeasured = null
    for (let i = 0; i < DESTINATION_STALL_REPLANS + 3; i++) {
      unmeasured = noteReplanAttempt(unmeasured, 'BICYCLE')
    }
    expect(unmeasured).toBeNull()
    expect(destinationStalled(unmeasured, 'BICYCLE')).toBe(false)
  })

  it('remembers the closest the rider has come', () => {
    let state = noteDestinationDistance(null, 900)
    state = noteDestinationDistance(state, 600)
    expect(state?.bestDistanceM).toBe(600)
    // Moving away again does not move the best.
    state = noteDestinationDistance(state, 1200)
    expect(state?.bestDistanceM).toBe(600)
  })

  it('treats GPS scatter as no gain at all', () => {
    // The 8/28 afternoon's 454 m floor wandered by tens of metres for half an
    // hour without the rider getting anywhere.
    let state = noteDestinationDistance(null, 454)
    state = noteDestinationDistance(state, 454 - (DESTINATION_GAIN_MIN_M - 1))
    expect(state?.bestDistanceM).toBe(454)
  })

  it('retires a mode after three re-plans that got nowhere', () => {
    // 2026-08-28: 32 minutes of re-planning into the State Fairgrounds
    // interior, never inside 454 m.
    let state = noteDestinationDistance(null, 454)
    state = noteReplanAttempt(state, 'BICYCLE')
    expect(destinationStalled(state, 'BICYCLE')).toBe(false)
    state = noteReplanAttempt(state, 'BICYCLE')
    expect(destinationStalled(state, 'BICYCLE')).toBe(false)
    state = noteReplanAttempt(state, 'BICYCLE')
    expect(destinationStalled(state, 'BICYCLE')).toBe(true)
  })

  it('retires only the mode that failed', () => {
    const state = stalledAt(454)
    expect(destinationStalled(state, 'BICYCLE')).toBe(true)
    expect(destinationStalled(state, 'WALK')).toBe(false)
  })

  it('gives the machinery back the moment the rider starts closing again', () => {
    let state = stalledAt(454)
    expect(destinationStalled(state, 'BICYCLE')).toBe(true)
    state = noteDestinationDistance(state, 454 - DESTINATION_GAIN_MIN_M)
    expect(destinationStalled(state, 'BICYCLE')).toBe(false)
    expect(state?.replansSinceGain).toBe(0)
  })

  it('does not un-stall on scatter', () => {
    let state = stalledAt(454)
    state = noteDestinationDistance(state, 420)
    expect(destinationStalled(state, 'BICYCLE')).toBe(true)
  })
})
