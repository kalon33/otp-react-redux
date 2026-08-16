import {
  findNearbyVehicles,
  hasUsablePosition,
  matchUserToVehicle
} from '../../../lib/util/go-mode/vehicle-matching'
import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import type { VehiclePosition } from '../../../lib/util/go-mode/vehicle-matching'

// Two Orange Line vehicles on I-35W: one at the rider, one ~2 km behind.
const vehicle = (over: Partial<VehiclePosition>): VehiclePosition => ({
  heading: 0,
  label: '8148',
  lat: 44.921,
  lon: -93.269,
  nextStopId: '1:stop-46th',
  nextStopName: 'I-35W & 46th St Station',
  patternId: '1:904:0:01',
  routeId: '1:904',
  seconds: 1700000000,
  speed: 20,
  stopStatus: 'IN_TRANSIT_TO',
  tripHeadsign: 'Downtown Minneapolis',
  tripId: '1:trip-early',
  vehicleId: '1:8148',
  ...over
})

describe('matchUserToVehicle', () => {
  it('carries the matched run identity (tripId/routeId/nextStopId)', () => {
    const match = matchUserToVehicle(
      44.921,
      -93.269,
      0,
      [vehicle({})],
      '1:904',
      null
    )
    expect(match.vehicleId).toBe('1:8148')
    expect(match.confidence).toBe('high')
    // The boarded-earlier trigger compares match.tripId against the PLANNED
    // leg's trip — a match without its run identity can never prove the rider
    // caught a different bus.
    expect(match.tripId).toBe('1:trip-early')
    expect(match.routeId).toBe('1:904')
    expect(match.nextStopId).toBe('1:stop-46th')
    expect(match.tripHeadsign).toBe('Downtown Minneapolis')
  })

  it('identity follows the vehicle that actually wins the match', () => {
    const other = vehicle({
      lat: 44.939, // ~2km north, out of proximity
      tripId: '1:trip-planned',
      vehicleId: '1:8200'
    })
    const match = matchUserToVehicle(
      44.921,
      -93.269,
      0,
      [other, vehicle({})],
      '1:904',
      null
    )
    expect(match.vehicleId).toBe('1:8148')
    expect(match.tripId).toBe('1:trip-early')
  })

  it('no vehicles in range still yields an identity-free no-match', () => {
    const match = matchUserToVehicle(
      44.5,
      -93.0,
      0,
      [vehicle({})],
      '1:904',
      null
    )
    expect(match.confidence).toBe('none')
    expect(match.vehicleId).toBeNull()
    expect(match.tripId).toBeUndefined()
  })

  // The 7/29 cascade opener: the rider's own bus (8140) outran its stale feed
  // position to 852m behind, and the OPPOSITE-direction Orange Line across
  // the freeway (8141, 847m, closing) won the match by 5m. Direction and
  // incumbent stickiness must each keep 8140 on their own.
  describe('7/29 regression: stale-feed flap onto the opposing Orange Line', () => {
    // Rider southbound on I-35W at BRT speed.
    const RIDER: [number, number] = [44.921, -93.269]
    const HEADING = 179.5
    const SPEED = 17.4
    // ~853m and ~847m north of the rider (lat-only offsets).
    const own = vehicle({
      heading: 179,
      lat: RIDER[0] + 0.00766,
      tripHeadsign: 'Orange Burnsville',
      tripId: '1:1173133',
      vehicleId: '1:8140'
    })
    const opposing = vehicle({
      heading: 2,
      label: '8141',
      lat: RIDER[0] + 0.00761,
      speed: 15,
      tripHeadsign: 'Orange Downtown Minneapolis',
      tripId: '1:1082792',
      vehicleId: '1:8141'
    })
    const previous8140 = matchUserToVehicle(
      RIDER[0],
      RIDER[1],
      HEADING,
      [own],
      '1:904',
      null,
      900,
      SPEED
    )

    it("an opposite-direction vehicle never displaces the rider's bus", () => {
      const match = matchUserToVehicle(
        RIDER[0],
        RIDER[1],
        HEADING,
        [opposing, own],
        '1:904',
        previous8140,
        900,
        SPEED
      )
      expect(match.vehicleId).toBe('1:8140')
      expect(match.tripId).toBe('1:1173133')
    })

    it('an opposing candidate alone yields no match, not a wrong match', () => {
      const match = matchUserToVehicle(
        RIDER[0],
        RIDER[1],
        HEADING,
        [opposing],
        '1:904',
        null,
        900,
        SPEED
      )
      expect(match.confidence).toBe('none')
      expect(match.vehicleId).toBeNull()
    })

    it('the direction gate is inert while the rider is (near-)stationary', () => {
      const nearby = vehicle({ heading: 2, lat: RIDER[0] + 0.0002 })
      const stopped = matchUserToVehicle(
        RIDER[0],
        RIDER[1],
        HEADING,
        [nearby],
        '1:904',
        null,
        80,
        0
      )
      expect(stopped.vehicleId).toBe('1:8148')
    })

    it('the direction gate is inert while the vehicle is (near-)stationary', () => {
      // A bus dwelling at a stop reports garbage headings; never exclude it.
      const dwelling = vehicle({ heading: 2, lat: RIDER[0] + 0.0002, speed: 0 })
      const match = matchUserToVehicle(
        RIDER[0],
        RIDER[1],
        HEADING,
        [dwelling],
        '1:904',
        null,
        80,
        SPEED
      )
      expect(match.vehicleId).toBe('1:8148')
    })
  })

  describe('incumbent stickiness', () => {
    // Two same-route vehicles, headings unusable (stationary rider), so only
    // the distance margin decides. Feed distances jitter by tens of meters.
    const RIDER: [number, number] = [44.921, -93.269]
    const incumbent = vehicle({ lat: RIDER[0] + 0.00449 }) // ~500m
    const previousMatch = matchUserToVehicle(
      RIDER[0],
      RIDER[1],
      null,
      [incumbent],
      '1:904',
      null,
      900
    )

    it('a challenger 5m closer does not displace the incumbent (7/29 flap margin)', () => {
      const challenger = vehicle({
        lat: RIDER[0] + 0.00445, // ~495m
        tripId: '1:trip-other',
        vehicleId: '1:8200'
      })
      const match = matchUserToVehicle(
        RIDER[0],
        RIDER[1],
        null,
        [challenger, incumbent],
        '1:904',
        previousMatch,
        900
      )
      expect(match.vehicleId).toBe('1:8148')
    })

    it('a challenger 200m closer does switch', () => {
      const challenger = vehicle({
        lat: RIDER[0] + 0.0027, // ~300m
        tripId: '1:trip-other',
        vehicleId: '1:8200'
      })
      const match = matchUserToVehicle(
        RIDER[0],
        RIDER[1],
        null,
        [challenger, incumbent],
        '1:904',
        previousMatch,
        900
      )
      expect(match.vehicleId).toBe('1:8200')
    })
  })
})

describe('findNearbyVehicles', () => {
  it('keeps tripId on nearby options (confirmVehicleSelection reads it)', () => {
    const nearby = findNearbyVehicles(44.921, -93.269, [vehicle({})], 200)
    expect(nearby).toHaveLength(1)
    expect(nearby[0].tripId).toBe('1:trip-early')
  })

  it('never surfaces a coordinateless ghost as a nearby option', () => {
    // Infinity from calculateDistance is what does this: the ghost loses every
    // `<=` comparison instead of scoring a 10,000km "distance".
    const nearby = findNearbyVehicles(
      44.921,
      -93.269,
      [vehicle({ lat: 0, lon: 0, vehicleId: '1:8223-ghost' }), vehicle({})],
      200
    )
    expect(nearby.map((v) => v.vehicleId)).toEqual(['1:8148'])
  })
})

describe('hasUsablePosition', () => {
  it('rejects the 8/2 null-island ghost and keeps the live record', () => {
    expect(hasUsablePosition(vehicle({ lat: 0, lon: 0 }))).toBe(false)
    expect(hasUsablePosition({ lat: 44.86, lon: null })).toBe(false)
    expect(hasUsablePosition(null)).toBe(false)
    expect(hasUsablePosition(vehicle({}))).toBe(true)
  })
})

describe('calculateDistance', () => {
  it('returns Infinity, not a plausible number, for missing coordinates', () => {
    // A null coerced to 0 used to produce 10,267,729m — Minneapolis to null
    // island — which reads as a real position rather than as missing data.
    expect(calculateDistance(44.86, -93.28, null as any, null as any)).toBe(
      Infinity
    )
    expect(
      calculateDistance(44.86, -93.28, undefined as any, -93.28)
    ).toBe(Infinity)
    // A genuine 0/0 coordinate is still arithmetic, not an error — the
    // hasUsablePosition filter is what rejects null island.
    expect(calculateDistance(0, 0, 0, 0)).toBe(0)
  })
})
