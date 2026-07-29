import {
  findVehicleById,
  findVehicleForTrip,
  shouldRebindRidingTrip,
  shouldReplanBoardedEarlier
} from '../../../lib/util/go-mode/transit-trust'
import type { VehiclePosition } from '../../../lib/util/go-mode/vehicle-matching'

const NOW = 1785364000000 // within the 7/29 incident window

const vehicle = (over: Partial<VehiclePosition>): VehiclePosition => ({
  heading: 179,
  label: '8140',
  lat: 44.86,
  lon: -93.28,
  nextStopId: '1:stop-66th',
  nextStopName: 'I-35W & 66th St Station',
  patternId: '1:904:1:01',
  routeId: '1:904',
  seconds: NOW / 1000 - 30, // fresh: 30s old
  speed: 25,
  stopStatus: 'IN_TRANSIT_TO',
  tripHeadsign: 'Orange Burnsville',
  tripId: '1:1173133',
  vehicleId: '1:8140',
  ...over
})

describe('vehicle record lookup', () => {
  const vehicles = [
    vehicle({}),
    vehicle({ tripId: '1:1082792', vehicleId: '1:8141' })
  ]

  it('finds the vehicle serving a trip and computes ageSec from `seconds`', () => {
    const record = findVehicleForTrip(vehicles, '1:1082792', NOW)
    expect(record?.vehicle.vehicleId).toBe('1:8141')
    expect(record?.ageSec).toBeCloseTo(30)
  })

  it('finds a vehicle by id', () => {
    expect(findVehicleById(vehicles, '1:8140', NOW)?.vehicle.tripId).toBe(
      '1:1173133'
    )
  })

  it('returns null for unknown ids, empty feeds, and missing keys', () => {
    expect(findVehicleForTrip(vehicles, '1:nope', NOW)).toBeNull()
    expect(findVehicleForTrip(undefined, '1:1173133', NOW)).toBeNull()
    expect(findVehicleForTrip(vehicles, null, NOW)).toBeNull()
    expect(findVehicleById(vehicles, null, NOW)).toBeNull()
  })

  it('a record without a feed timestamp gets a null ageSec (never fresh)', () => {
    const record = findVehicleForTrip(
      [vehicle({ seconds: undefined as any })],
      '1:1173133',
      NOW
    )
    expect(record?.ageSec).toBeNull()
  })
})

describe('shouldRebindRidingTrip', () => {
  const riding = { headsign: 'Orange Burnsville', tripId: '1:1173133' }
  const matchedLeg = { headsign: 'Orange Burnsville' }
  const matchState = (
    consecutiveMatches: number,
    tripHeadsign: string | null
  ) => ({ consecutiveMatches, match: { tripHeadsign } })

  it('allows first establishment (no riding fact / no tripId held)', () => {
    expect(
      shouldRebindRidingTrip(null, '1:1173133', matchedLeg, matchState(1, null))
    ).toBe(true)
    expect(
      shouldRebindRidingTrip(
        { headsign: null, tripId: null },
        '1:1173133',
        matchedLeg,
        matchState(1, null)
      )
    ).toBe(true)
  })

  it('always allows a same-trip refresh', () => {
    expect(
      shouldRebindRidingTrip(
        riding,
        '1:1173133',
        matchedLeg,
        matchState(0, null)
      )
    ).toBe(true)
  })

  it('blocks a rebind off a flap (7/29: two consecutive matches rebound the ride)', () => {
    expect(
      shouldRebindRidingTrip(
        riding,
        '1:1082792',
        matchedLeg,
        matchState(2, 'Orange Burnsville')
      )
    ).toBe(false)
  })

  it('allows a sustained rebind with a consistent headsign', () => {
    expect(
      shouldRebindRidingTrip(
        riding,
        '1:trip-earlier-run',
        matchedLeg,
        matchState(8, 'Orange Burnsville')
      )
    ).toBe(true)
  })

  it('blocks even a sustained rebind onto an opposing headsign', () => {
    expect(
      shouldRebindRidingTrip(
        riding,
        '1:1082792',
        matchedLeg,
        matchState(8, 'Orange Downtown Minneapolis')
      )
    ).toBe(false)
  })

  it('lets consecutive matches alone decide when headsigns are unknown', () => {
    const anonymous = { headsign: null, tripId: '1:1173133' }
    expect(
      shouldRebindRidingTrip(anonymous, '1:other', null, matchState(8, null))
    ).toBe(true)
    expect(
      shouldRebindRidingTrip(anonymous, '1:other', null, matchState(7, null))
    ).toBe(false)
  })
})

describe('shouldReplanBoardedEarlier', () => {
  // Aboard the Orange Line southbound; the planned trip departed 5 min ago,
  // so the time-based aboard-before-planned proof is quiet.
  const ridingLeg: any = {
    headsign: 'Orange Burnsville',
    mode: 'BUS',
    startTime: NOW - 300000,
    transitLeg: true,
    trip: { gtfsId: '1:1173133' }
  }
  const freshRecord = findVehicleById([vehicle({})], '1:8140', NOW)
  const staleRecord = findVehicleById(
    [vehicle({ seconds: NOW / 1000 - 300 })],
    '1:8140',
    NOW
  )

  it('the 7/29 signature never fires: flap-promoted opposite-direction match', () => {
    expect(
      shouldReplanBoardedEarlier({
        nowMs: NOW,
        ridingLeg,
        vehicleMatchState: {
          consecutiveMatches: 2,
          match: {
            confidence: 'high',
            distanceMeters: 847,
            label: '8141',
            lastSeen: NOW,
            tripHeadsign: 'Orange Downtown Minneapolis',
            tripId: '1:1082792',
            vehicleId: '1:8141'
          }
        },
        vehicleRecord: freshRecord
      })
    ).toBe(false)
  })

  it('a legitimate earlier run still fires: same headsign, sustained, fresh record', () => {
    expect(
      shouldReplanBoardedEarlier({
        nowMs: NOW,
        ridingLeg,
        vehicleMatchState: {
          consecutiveMatches: 8,
          match: {
            confidence: 'high',
            distanceMeters: 40,
            label: '8140',
            lastSeen: NOW,
            tripHeadsign: 'Orange Burnsville',
            tripId: '1:trip-earlier-run',
            vehicleId: '1:8140'
          }
        },
        vehicleRecord: freshRecord
      })
    ).toBe(true)
  })

  it('a stale feed record is not evidence — no replan', () => {
    expect(
      shouldReplanBoardedEarlier({
        nowMs: NOW,
        ridingLeg,
        vehicleMatchState: {
          consecutiveMatches: 8,
          match: {
            confidence: 'high',
            distanceMeters: 40,
            label: '8140',
            lastSeen: NOW,
            tripHeadsign: 'Orange Burnsville',
            tripId: '1:trip-earlier-run',
            vehicleId: '1:8140'
          }
        },
        vehicleRecord: staleRecord
      })
    ).toBe(false)
  })

  it('being aboard well before the planned bus could exist still proves an earlier run', () => {
    expect(
      shouldReplanBoardedEarlier({
        nowMs: NOW,
        ridingLeg: { ...ridingLeg, startTime: NOW + 300000 },
        vehicleMatchState: null,
        vehicleRecord: null
      })
    ).toBe(true)
  })
})
