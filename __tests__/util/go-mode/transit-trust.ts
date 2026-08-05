import { encode } from '@mapbox/polyline'

import {
  assessRiderGpsTrust,
  findRidingVehicle,
  findVehicleById,
  findVehicleForTrip,
  isVehicleRecordFresh,
  refreshConfirmedMatch,
  shouldRebindRidingTrip,
  shouldReplanBoardedEarlier,
  stopsAheadFromNextStopId,
  vehicleProgressOnLeg
} from '../../../lib/util/go-mode/transit-trust'
import type {
  VehicleMatchResult,
  VehiclePosition
} from '../../../lib/util/go-mode/vehicle-matching'

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

  it('a record without a feed timestamp gets a null ageSec', () => {
    const record = findVehicleForTrip(
      [vehicle({ seconds: undefined as any })],
      '1:1173133',
      NOW
    )
    expect(record?.ageSec).toBeNull()
  })
})

describe('isVehicleRecordFresh', () => {
  it('accepts a young feed timestamp and rejects a stale one', () => {
    expect(
      isVehicleRecordFresh(findVehicleById([vehicle({})], '1:8140', NOW))
    ).toBe(true)
    expect(
      isVehicleRecordFresh(
        findVehicleById([vehicle({ seconds: NOW / 1000 - 300 })], '1:8140', NOW)
      )
    ).toBe(false)
  })

  it('a null ageSec passes — the live feed publishes lastUpdated: null for in-service vehicles', () => {
    // Same null policy as headsigns/accuracy: unknown data never blocks. Only
    // a record the feed KNOWS is old (the 7/29 flap) is rejected.
    expect(
      isVehicleRecordFresh(
        findVehicleById([vehicle({ seconds: undefined as any })], '1:8140', NOW)
      )
    ).toBe(true)
  })

  it('no record at all is never fresh', () => {
    expect(isVehicleRecordFresh(null)).toBe(false)
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

  it('a rider-confirmed match needs no sustained run — confirmation cannot flap', () => {
    // The confirmed-refresh path never maintains consecutiveMatches, so a
    // confirmed match sits at whatever count it was locked with; the rider's
    // explicit "I'm on this bus" must not be weaker evidence than promotion.
    expect(
      shouldReplanBoardedEarlier({
        nowMs: NOW,
        ridingLeg,
        vehicleMatchState: {
          consecutiveMatches: 0,
          match: {
            confidence: 'confirmed',
            distanceMeters: 0,
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

  it('a record with no feed timestamp still supports a legitimate replan', () => {
    // Half the live fleet reports lastUpdated: null — an unknown age must not
    // permanently block the boarded-earlier fix for riders on those buses.
    const untimestamped = findVehicleById(
      [vehicle({ seconds: undefined as any })],
      '1:8140',
      NOW
    )
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
        vehicleRecord: untimestamped
      })
    ).toBe(true)
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

describe('findRidingVehicle', () => {
  const vehicles = [
    vehicle({}),
    vehicle({ tripId: '1:1082792', vehicleId: '1:8141' })
  ]

  it('prefers the riding vehicleId over the tripId', () => {
    // tripId points at 8140 but the rider boarded the physical bus 8141 —
    // the vehicle is what they are sitting in.
    const record = findRidingVehicle(
      vehicles,
      { tripId: '1:1173133', vehicleId: '1:8141' },
      NOW
    )
    expect(record?.vehicle.vehicleId).toBe('1:8141')
    expect(record?.ageSec).toBeCloseTo(30)
  })

  it('falls back to the tripId when the vehicle id is unknown to the feed', () => {
    const record = findRidingVehicle(
      vehicles,
      { tripId: '1:1173133', vehicleId: '1:ghost' },
      NOW
    )
    expect(record?.vehicle.vehicleId).toBe('1:8140')
  })

  it('returns null with no riding fact or no feed', () => {
    expect(findRidingVehicle(vehicles, null, NOW)).toBeNull()
    expect(
      findRidingVehicle(undefined, { tripId: '1:x', vehicleId: '1:y' }, NOW)
    ).toBeNull()
  })
})

describe('refreshConfirmedMatch', () => {
  const confirmed: VehicleMatchResult = {
    confidence: 'confirmed',
    distanceMeters: 40,
    label: '8140',
    lastSeen: NOW - 60000,
    nextStopId: '1:stop-old',
    tripId: '1:1173133',
    vehicleId: '1:8140'
  }

  it('refreshes distance/lastSeen/nextStopId/tripId from the same vehicle only', () => {
    // Rider sits exactly on the vehicle's feed position.
    const refreshed = refreshConfirmedMatch(
      confirmed,
      [vehicle({}), vehicle({ tripId: '1:1082792', vehicleId: '1:8141' })],
      44.86,
      -93.28,
      NOW
    )
    expect(refreshed?.vehicleId).toBe('1:8140')
    expect(refreshed?.confidence).toBe('confirmed')
    expect(refreshed?.distanceMeters).toBeCloseTo(0)
    expect(refreshed?.lastSeen).toBe(NOW)
    expect(refreshed?.nextStopId).toBe('1:stop-66th')
    expect(refreshed?.tripId).toBe('1:1173133')
  })

  it('never re-matches: absent from the feed means null, and lastSeen ages', () => {
    // Only the OTHER bus is in the feed — a refresh must not adopt it.
    expect(
      refreshConfirmedMatch(
        confirmed,
        [vehicle({ tripId: '1:1082792', vehicleId: '1:8141' })],
        44.86,
        -93.28,
        NOW
      )
    ).toBeNull()
  })

  it('keeps the previous next-stop/trip facts when the feed record lacks them', () => {
    const refreshed = refreshConfirmedMatch(
      confirmed,
      [vehicle({ nextStopId: undefined as any, tripId: undefined })],
      44.86,
      -93.28,
      NOW
    )
    expect(refreshed?.nextStopId).toBe('1:stop-old')
    expect(refreshed?.tripId).toBe('1:1173133')
  })

  describe('the 8/2 twin-record feed', () => {
    // Metro Transit published TWO records for vehicle 1:8223 at 21:23:18 — a
    // ghost for the bus's next block trip (null island, "Orange Burnsville")
    // listed BEFORE the live one. Taking the first match copied the ghost's
    // tripId into the confirmed match every tick, which armed the
    // boarded-earlier replan and swapped the itinerary nine times in an hour.
    const ghost = vehicle({
      lat: 0,
      lon: 0,
      nextStopId: undefined as any,
      tripHeadsign: 'Orange Burnsville',
      tripId: '1:1191630',
      vehicleId: '1:8223'
    })
    const live = vehicle({
      lat: 44.8637085,
      lon: -93.3022919,
      nextStopId: '1:56828',
      tripHeadsign: 'Orange Downtown Minneapolis',
      tripId: '1:1201789',
      vehicleId: '1:8223'
    })
    const aboard: VehicleMatchResult = {
      ...confirmed,
      nextStopId: '1:56828',
      tripHeadsign: 'Orange Downtown Minneapolis',
      tripId: '1:1201789',
      vehicleId: '1:8223'
    }

    it('takes the live record even when the ghost is listed first', () => {
      const refreshed = refreshConfirmedMatch(
        aboard,
        [ghost, live],
        44.8637085,
        -93.3022919,
        NOW
      )
      expect(refreshed?.tripId).toBe('1:1201789')
      expect(refreshed?.nextStopId).toBe('1:56828')
      // Not 10,267,729 — the haversine from Minneapolis to null island.
      expect(refreshed?.distanceMeters).toBe(0)
    })

    it('returns null when only coordinateless records exist', () => {
      // "Vehicle absent" is the honest answer: lastSeen ages instead of the
      // match looking healthy at a fabricated position.
      expect(
        refreshConfirmedMatch(aboard, [ghost], 44.8637085, -93.3022919, NOW)
      ).toBeNull()
    })

    it('refreshes tripHeadsign whenever it refreshes tripId', () => {
      // The opposite-direction guard in shouldReplanBoardedEarlier compares
      // tripHeadsign against the leg. A refreshed id with a stale headsign
      // makes that guard judge confirmation-time data against a drifted id.
      const rebound = refreshConfirmedMatch(
        aboard,
        [
          vehicle({
            tripHeadsign: 'Orange Burnsville',
            tripId: '1:1191630',
            vehicleId: '1:8223'
          })
        ],
        44.86,
        -93.28,
        NOW
      )
      expect(rebound?.tripId).toBe('1:1191630')
      expect(rebound?.tripHeadsign).toBe('Orange Burnsville')
    })
  })
})

// A straight south-running transit leg, ~11km of geometry with the stops
// bunched toward the end (Orange Line shape). Latitude degrees ≈ 111km, so
// 0.005° between polyline points ≈ 555m.
const legLine: [number, number][] = []
for (let i = 0; i <= 20; i++) legLine.push([i * 0.005, 0])
const stopAt = (lat: number, name: string, stopId: string) => ({
  lat,
  lon: 0,
  name,
  stop: { gtfsId: stopId }
})
const transitLeg: any = {
  intermediatePlaces: [
    stopAt(0.02, 'Early Stop', '1:stop-early'),
    stopAt(0.085, 'Cluster A', '1:stop-a'),
    stopAt(0.09, 'Cluster B', '1:stop-b'),
    stopAt(0.095, 'Cluster C', '1:stop-c')
  ],
  legGeometry: { points: encode(legLine, 5) },
  mode: 'BUS',
  to: {
    lat: 0.1,
    lon: 0,
    name: 'Destination',
    stop: { gtfsId: '1:stop-dest' }
  },
  transitLeg: true
}

describe('vehicleProgressOnLeg', () => {
  it("reports the bus's own progress when its position lies on the leg", () => {
    const progress = vehicleProgressOnLeg(
      transitLeg,
      vehicle({ lat: 0.05, lon: 0 })
    )
    expect(progress).toBeCloseTo(0.5, 2)
  })

  it('returns null when the bus is off the leg (opposite direction, feed garbage)', () => {
    // ~11km of longitude away — far outside the 250m transit threshold.
    expect(
      vehicleProgressOnLeg(transitLeg, vehicle({ lat: 0.05, lon: 0.1 }))
    ).toBeNull()
  })
})

describe('stopsAheadFromNextStopId', () => {
  it('counts from the exact stop identity, zero geometry guesswork', () => {
    expect(stopsAheadFromNextStopId(transitLeg, '1:stop-a')).toEqual({
      nextStopName: 'Cluster A',
      stopsRemaining: 4
    })
    expect(stopsAheadFromNextStopId(transitLeg, '1:stop-dest')).toEqual({
      nextStopName: 'Destination',
      stopsRemaining: 1
    })
  })

  it('returns null for an unknown or missing next stop id', () => {
    // e.g. the bus is still upstream of the boarding stop.
    expect(stopsAheadFromNextStopId(transitLeg, '1:stop-upstream')).toBeNull()
    expect(stopsAheadFromNextStopId(transitLeg, null)).toBeNull()
  })
})

describe('assessRiderGpsTrust', () => {
  const routeMatch: any = {
    distanceFromRoute: 12,
    isOnRoute: true,
    legIndex: 1,
    nearestPoint: [0.05, 0],
    progressAlongLeg: 0.5,
    progressAlongSegment: 0.5,
    segmentIndex: 10
  }
  const sound = {
    accuracy: 10,
    anchorLegIndex: 1,
    fixAgeMs: 1000,
    routeMatch
  }

  it('trusts a fresh, accurate, on-route fix anchored to the riding leg', () => {
    expect(assessRiderGpsTrust(sound)).toBe(true)
  })

  it('null accuracy passes — platforms that omit it are not distrusted', () => {
    expect(assessRiderGpsTrust({ ...sound, accuracy: null })).toBe(true)
  })

  it('distrusts a fix matched to a different leg than the riding anchor', () => {
    expect(assessRiderGpsTrust({ ...sound, anchorLegIndex: 2 })).toBe(false)
  })

  it('distrusts an off-route fix', () => {
    expect(
      assessRiderGpsTrust({
        ...sound,
        routeMatch: { ...routeMatch, isOnRoute: false }
      })
    ).toBe(false)
    expect(assessRiderGpsTrust({ ...sound, routeMatch: null })).toBe(false)
  })

  it('distrusts a stale fix (20s on a ~1/s stream)', () => {
    expect(assessRiderGpsTrust({ ...sound, fixAgeMs: 20000 })).toBe(false)
  })

  it('distrusts a low-accuracy fix (150m)', () => {
    expect(assessRiderGpsTrust({ ...sound, accuracy: 150 })).toBe(false)
  })
})
