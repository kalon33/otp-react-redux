import {
  DESTINATION_GAIN_MIN_M,
  DESTINATION_REPLAN_MOTION_MIN_M,
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

  describe('what makes a re-plan evidence at all (2026-09-09)', () => {
    // Two fixes ~25 m apart, well under the motion floor: the 09-09 rider, who
    // stood still from 09:40:47 while the app re-planned around them.
    const STOOD: [number, number] = [44.825207, -93.286268]
    const STILL_THERE: [number, number] = [44.825207, -93.28596]
    // 300 m on: the same rider ten seconds earlier, still riding.
    const RIDING: [number, number] = [44.825207, -93.282436]

    it('does not count a re-plan over a rider who has not moved', () => {
      let state = noteDestinationDistance(null, 1670)
      for (let i = 0; i < DESTINATION_STALL_REPLANS + 3; i++) {
        state = noteReplanAttempt(state, 'BICYCLE', {
          point: i === 0 ? STOOD : STILL_THERE
        })
      }
      // Only the first one, which had nothing to be measured against.
      expect(state?.replansSinceGain).toBe(1)
      expect(destinationStalled(state, 'BICYCLE')).toBe(false)
    })

    it('counts one the rider rode to', () => {
      let state = noteDestinationDistance(null, 1670)
      state = noteReplanAttempt(state, 'BICYCLE', { point: STOOD })
      state = noteReplanAttempt(state, 'BICYCLE', { point: RIDING })
      state = noteReplanAttempt(state, 'BICYCLE', { point: STOOD })
      expect(state?.replansSinceGain).toBe(DESTINATION_STALL_REPLANS)
      expect(destinationStalled(state, 'BICYCLE')).toBe(true)
    })

    it('does not count a re-plan that never came back', () => {
      // 09:41:34.878 went out, 09:41:46.878 aborted on the 12 s Go Mode
      // timeout — and was counted against the destination 11.8 s before that.
      let state = noteDestinationDistance(null, 1670)
      state = noteReplanAttempt(state, 'BICYCLE', { point: STOOD })
      state = noteReplanAttempt(state, 'BICYCLE', {
        point: RIDING,
        returned: false
      })
      state = noteReplanAttempt(state, 'BICYCLE', {
        point: STOOD,
        returned: false
      })
      expect(state?.replansSinceGain).toBe(1)
      expect(destinationStalled(state, 'BICYCLE')).toBe(false)
    })

    it('counts an answer that came back with nothing usable', () => {
      // An empty plan is an answer: the server was asked from a place the
      // rider rode to, and what came back does not get them closer. That is
      // the 08-28 Fairgrounds, and it still retires the mode.
      let state = noteDestinationDistance(null, 454)
      state = noteReplanAttempt(state, 'BICYCLE', {
        point: STOOD,
        returned: true
      })
      state = noteReplanAttempt(state, 'BICYCLE', {
        point: RIDING,
        returned: true
      })
      state = noteReplanAttempt(state, 'BICYCLE', {
        point: STOOD,
        returned: true
      })
      expect(destinationStalled(state, 'BICYCLE')).toBe(true)
    })

    it('remembers where an attempt it threw away was asked from', () => {
      let state = noteDestinationDistance(null, 1670)
      state = noteReplanAttempt(state, 'BICYCLE', { point: STOOD })
      // Rode 300 m, but the answer never came: uncounted, and yet the next
      // re-plan is measured from HERE, not from where the rider set off.
      state = noteReplanAttempt(state, 'BICYCLE', {
        point: RIDING,
        returned: false
      })
      expect(state?.lastAttemptPoint).toEqual(RIDING)
      state = noteReplanAttempt(state, 'BICYCLE', { point: RIDING })
      expect(state?.replansSinceGain).toBe(1)
    })

    it('cannot rule out an attempt whose position it does not know', () => {
      // progress-calculator can return null for either end of the
      // measurement; an unknown position is not evidence of stillness.
      let state = noteDestinationDistance(null, 454)
      for (let i = 0; i < DESTINATION_STALL_REPLANS; i++) {
        state = noteReplanAttempt(state, 'BICYCLE')
      }
      expect(destinationStalled(state, 'BICYCLE')).toBe(true)
    })

    it('keeps the floor above the scatter of a bad fix', () => {
      // 2026-09-09 09:42:33: a fix reporting 114.4 m of accuracy put a
      // stationary rider 32.4 m from where they had been a minute earlier.
      expect(DESTINATION_REPLAN_MOTION_MIN_M).toBeGreaterThan(32.4)
    })
  })
})
