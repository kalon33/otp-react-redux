import { normalizeGoModeItinerary } from '../../../lib/util/go-mode/leg-merge'
import { spliceAccessOntoItinerary } from '../../../lib/util/go-mode/access-splice'

const T = 1785400000000 // base epoch for readable offsets

// The active bike → bus → walk itinerary (7/29 shape): the rider deviates on
// the bike leg; everything from the bus on must survive a splice untouched.
const bikeLeg = {
  distance: 2000,
  duration: 600,
  endTime: T + 600000,
  mode: 'BICYCLE',
  startTime: T,
  transitLeg: false
} as any
const busLeg = {
  distance: 8000,
  duration: 900,
  endTime: T + 1560000,
  from: { lat: 44.9, lon: -93.28, name: 'Knox & 76th St' },
  mode: 'BUS',
  routeId: '1:904',
  startTime: T + 660000,
  transitLeg: true
} as any
const walkLeg = {
  distance: 300,
  duration: 240,
  endTime: T + 1800000,
  mode: 'WALK',
  startTime: T + 1560000,
  transitLeg: false
} as any
const current = {
  duration: 1800,
  endTime: T + 1800000,
  legs: [bikeLeg, busLeg, walkLeg],
  startTime: T,
  transfers: 0,
  walkDistance: 2300
} as any

const accessItin = (legs: any[], startTime: number, endTime: number) =>
  ({
    duration: (endTime - startTime) / 1000,
    endTime,
    legs,
    startTime
  } as any)

describe('spliceAccessOntoItinerary', () => {
  const newBike = {
    distance: 2400,
    duration: 540,
    endTime: T + 640000,
    mode: 'BICYCLE',
    startTime: T + 100000,
    transitLeg: false
  } as any

  it('keeps the transit suffix as the SAME leg objects (no invented bus)', () => {
    const result = spliceAccessOntoItinerary(
      current,
      accessItin([newBike], T + 100000, T + 640000),
      1
    )
    expect(result.legs).toHaveLength(3)
    expect(result.legs[0]).toBe(newBike)
    // toBe, not toEqual: identity is the contract — times/stops/routes of the
    // suffix cannot have changed if the objects are the originals.
    expect(result.legs[1]).toBe(busLeg)
    expect(result.legs[2]).toBe(walkLeg)
  })

  it('recomputes only container fields: startTime, duration, walkDistance', () => {
    const result = spliceAccessOntoItinerary(
      current,
      accessItin([newBike], T + 100000, T + 640000),
      1
    )
    expect(result.startTime).toBe(T + 100000)
    expect(result.endTime).toBe(T + 1800000) // unchanged
    expect(result.duration).toBe((T + 1800000 - (T + 100000)) / 1000)
    expect((result as any).transfers).toBe(0) // suffix defines it — unchanged
    // Non-transit distance summed across the new legs: 2400 + 300.
    expect(result.walkDistance).toBe(2700)
  })

  it('leaves suffix times untouched when the rider now arrives after departure', () => {
    // Access ends AFTER the bus departs: no clamping, no later bus — the
    // itinerary shows the truth and the missed-bus machinery (measuring the
    // BUS against the stop) resolves it under its own same-route rules.
    const lateBike = { ...newBike, endTime: T + 700000, startTime: T + 160000 }
    const result = spliceAccessOntoItinerary(
      current,
      accessItin([lateBike], T + 160000, T + 700000),
      1
    )
    expect(result.legs[1]).toBe(busLeg)
    expect(result.legs[1].startTime).toBe(T + 660000)
    expect(result.endTime).toBe(T + 1800000)
  })

  it('handles an access leg count different from the original prefix', () => {
    // OTP often returns bike plans as walk → bike → walk.
    const w1 = { distance: 50, mode: 'WALK', transitLeg: false } as any
    const b = { distance: 2100, mode: 'BICYCLE', transitLeg: false } as any
    const w2 = { distance: 80, mode: 'WALK', transitLeg: false } as any
    const result = spliceAccessOntoItinerary(
      current,
      accessItin([w1, b, w2], T + 120000, T + 700000),
      1
    )
    expect(result.legs).toHaveLength(5)
    expect(result.legs.slice(0, 3)).toEqual([w1, b, w2])
    expect(result.legs[3]).toBe(busLeg)
    expect(result.legs[4]).toBe(walkLeg)
    expect(result.walkDistance).toBe(50 + 2100 + 80 + 300)
  })

  it('survives the beginGoMode normalization pass object-identical', () => {
    // beginGoMode normalizes every incoming itinerary, so it sits directly
    // downstream of this splice. Nothing here merges, so the whole object —
    // not just the legs — must come back unchanged, or the same-objects
    // promise above ("only reroute the bike leg", 7/29) is silently void.
    const spliced = spliceAccessOntoItinerary(
      current,
      accessItin(
        [{ distance: 2100, mode: 'BICYCLE', transitLeg: false } as any],
        T + 120000,
        T + 700000
      ),
      1
    )
    expect(normalizeGoModeItinerary(spliced)).toBe(spliced)
  })
})
