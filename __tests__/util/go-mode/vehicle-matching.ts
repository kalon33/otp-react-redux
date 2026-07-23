import {
  findNearbyVehicles,
  matchUserToVehicle
} from '../../../lib/util/go-mode/vehicle-matching'
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
})

describe('findNearbyVehicles', () => {
  it('keeps tripId on nearby options (confirmVehicleSelection reads it)', () => {
    const nearby = findNearbyVehicles(44.921, -93.269, [vehicle({})], 200)
    expect(nearby).toHaveLength(1)
    expect(nearby[0].tripId).toBe('1:trip-early')
  })
})
