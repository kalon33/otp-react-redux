import {
  ARRIVAL_DWELL_MS,
  ARRIVAL_MIN_PROGRESS,
  ARRIVAL_RADIUS_M
} from '../../../lib/util/go-mode/progress-calculator'
import {
  finalDestinationOf,
  nearDestinationApplies,
  nearDestinationDelayMs,
  nearDestinationDwellDone,
  nextNearDestination
} from '../../../lib/util/go-mode/arrival-dwell'

/**
 * The near-destination dwell (12.17, rider's Q4 = A, 2026-10-20: "Also count
 * it once I've been within 75 m for a minute"). The pure half — the tick and
 * the wall-clock timer in actions/go-mode both decide with these; the replay
 * of the 10-19 ride is arrival-radius-1657.ts.
 */

const DOOR = { lat: 44.79, lon: -93.33 }
const bikeLegs = (to = DOOR, mode = 'BICYCLE') => [
  { mode: 'BUS', to: { lat: 44.8, lon: -93.29 } },
  { mode, to }
]
const T = 1_792_450_146_000

const at = (
  prev: any,
  distanceToDestination: number | null,
  nowMs: number,
  overallProgress = 99,
  legs: any = bikeLegs()
) =>
  nextNearDestination(prev, {
    distanceToDestination,
    legs,
    nowMs,
    overallProgress
  })

describe('util > go-mode > arrival-dwell (12.17)', () => {
  it('arms on the first fix within 75 m past the progress floor', () => {
    const near = at(null, 72.4, T)
    expect(near).toEqual({ lat: DOOR.lat, lon: DOOR.lon, sinceMs: T })
    expect(at(null, ARRIVAL_RADIUS_M, T)).not.toBeNull()
  })

  it('does not arm outside 75 m, under the floor, or with no measurement', () => {
    expect(at(null, ARRIVAL_RADIUS_M + 0.1, T)).toBeNull()
    expect(at(null, 50, T, ARRIVAL_MIN_PROGRESS - 0.1)).toBeNull()
    expect(at(null, null, T)).toBeNull()
    expect(at(null, NaN, T)).toBeNull()
  })

  it('does not arm on a bus or rail finish — 75 m arrives there already', () => {
    expect(at(null, 50, T, 99, bikeLegs(DOOR, 'BUS'))).toBeNull()
    expect(at(null, 50, T, 99, bikeLegs(DOOR, 'WALK'))).not.toBeNull()
  })

  it('keeps the original start while the rider stays inside (same object)', () => {
    const first = at(null, 72.4, T)
    const later = at(first, 60, T + 30_000)
    expect(later).toBe(first)
    expect(later?.sinceMs).toBe(T)
  })

  it('a fix beyond 75 m disarms it, and the next minute starts over', () => {
    const first = at(null, 72.4, T)
    expect(at(first, 78.2, T + 10_000)).toBeNull()
    expect(at(null, 70, T + 20_000)?.sinceMs).toBe(T + 20_000)
  })

  it('a different destination is a different minute', () => {
    const first = at(null, 72.4, T)
    const moved = bikeLegs({ lat: DOOR.lat + 0.01, lon: DOOR.lon })
    expect(nearDestinationApplies(first, moved)).toBe(false)
    expect(nearDestinationApplies(first, bikeLegs())).toBe(true)
    // Re-armed from now against the new door, never inheriting the old start.
    expect(at(first, 50, T + 30_000, 99, moved)?.sinceMs).toBe(T + 30_000)
    expect(nearDestinationDwellDone(first, moved, T + ARRIVAL_DWELL_MS)).toBe(
      false
    )
  })

  it('a finish that is no longer a bike or walk does not apply', () => {
    const first = at(null, 72.4, T)
    expect(nearDestinationApplies(first, bikeLegs(DOOR, 'BUS'))).toBe(false)
  })

  it('is done at exactly one minute, not before', () => {
    const near = at(null, 72.4, T)
    expect(ARRIVAL_DWELL_MS).toBe(60_000)
    expect(nearDestinationDwellDone(near, bikeLegs(), T + 59_999)).toBe(false)
    expect(nearDestinationDwellDone(near, bikeLegs(), T + 60_000)).toBe(true)
    expect(nearDestinationDwellDone(null, bikeLegs(), T + 60_000)).toBe(false)
  })

  it("the timer's delay is what is left of the minute, clamped", () => {
    const near = { ...DOOR, sinceMs: T }
    expect(nearDestinationDelayMs(near, T)).toBe(60_000)
    expect(nearDestinationDelayMs(near, T + 40_000)).toBe(20_000)
    expect(nearDestinationDelayMs(near, T + 5 * 60_000)).toBe(0)
    // A clock stepped backwards cannot make it longer than the minute.
    expect(nearDestinationDelayMs(near, T - 3_600_000)).toBe(60_000)
  })

  it('reads the destination off the last leg', () => {
    expect(finalDestinationOf(bikeLegs())).toEqual({
      ...DOOR,
      mode: 'BICYCLE'
    })
    expect(finalDestinationOf([])).toBeNull()
    expect(finalDestinationOf([{ mode: 'WALK', to: {} }])).toBeNull()
  })
})
