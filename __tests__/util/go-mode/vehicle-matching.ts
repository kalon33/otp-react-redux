import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import {
  findNearbyVehicles,
  hasUsablePosition,
  matchUserToVehicle,
  ridingVehicleReachable,
  vehicleFrameKey
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

    // 2026-08-27: the rider stood at 6th St S & 2nd Ave at 0.0-0.3 m/s waiting
    // for the outbound 94. The heading gate above cannot help at that speed, so
    // the INBOUND run 117m away won the match, SET_RIDING bound them to it, and
    // classifyMissedBus's `if (riding) return null` then suppressed missed-bus
    // detection for the whole ten-minute wait. GTFS direction_id is a fact
    // about the trip rather than about motion, so it still holds at a
    // standstill.
    describe('the direction_id gate (works at a standstill)', () => {
      it('excludes the opposite-direction run when the rider is not moving', () => {
        const inbound = vehicle({
          directionId: 1,
          lat: RIDER[0] + 0.001,
          speed: 0,
          tripId: '1:1184013',
          vehicleId: '1:1786'
        })
        const match = matchUserToVehicle(
          RIDER[0],
          RIDER[1],
          HEADING,
          [inbound],
          '1:904',
          null,
          900,
          0.2,
          0 // the rider's own leg runs direction 0
        )
        expect(match.confidence).toBe('none')
        expect(match.vehicleId).toBeNull()
      })

      it('keeps the same-direction run', () => {
        const outbound = vehicle({ directionId: 0, speed: 0 })
        const match = matchUserToVehicle(
          RIDER[0],
          RIDER[1],
          HEADING,
          [outbound],
          '1:904',
          null,
          900,
          0.2,
          0
        )
        expect(match.vehicleId).toBe('1:8148')
      })

      it('prefers the same-direction run over a closer opposing one', () => {
        const closerInbound = vehicle({
          directionId: 1,
          lat: RIDER[0] + 0.0001,
          vehicleId: '1:wrong'
        })
        const fartherOutbound = vehicle({
          directionId: 0,
          lat: RIDER[0] + 0.002,
          vehicleId: '1:right'
        })
        const match = matchUserToVehicle(
          RIDER[0],
          RIDER[1],
          HEADING,
          [closerInbound, fartherOutbound],
          '1:904',
          null,
          900,
          0.2,
          0
        )
        expect(match.vehicleId).toBe('1:right')
      })

      it('stays inert when either side declares no direction', () => {
        // Records predating the API mapper fix carry no directionId, and a feed
        // may omit it — neither should start excluding candidates.
        const noDirection = vehicle({ speed: 0 })
        expect(
          matchUserToVehicle(
            RIDER[0],
            RIDER[1],
            HEADING,
            [noDirection],
            '1:904',
            null,
            900,
            0.2,
            0
          ).vehicleId
        ).toBe('1:8148')

        const hasDirection = vehicle({ directionId: 1, speed: 0 })
        expect(
          matchUserToVehicle(
            RIDER[0],
            RIDER[1],
            HEADING,
            [hasDirection],
            '1:904',
            null,
            900,
            0.2,
            null // no expected direction known
          ).vehicleId
        ).toBe('1:8148')
      })

      it('compares direction ids across string/number shapes', () => {
        const inbound = vehicle({ directionId: '1', speed: 0 })
        const match = matchUserToVehicle(
          RIDER[0],
          RIDER[1],
          HEADING,
          [inbound],
          '1:904',
          null,
          900,
          0.2,
          0
        )
        expect(match.vehicleId).toBeNull()
      })
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

describe('riding vehicle hold (35.1, 12.11 — 2026-09-28)', () => {
  // Metres due south of the rider, as latitude (haversine R = 6,371 km).
  const M_PER_DEG = 111194.9
  const RIDER: [number, number] = [44.83, -93.29]
  const south = (m: number) => RIDER[0] - m / M_PER_DEG
  const NOW_S = 1790634168 // 2026-09-28 17:22:48 CDT
  const nowMs = NOW_S * 1000

  // The rider's bus: last frame 46 s old, stamped at 25 m/s heading south,
  // 650 m north of the rider — the projection runs 25 x 46 = 1,150 m, i.e.
  // ~500 m PAST a rider who braked into the station.
  const riddenFrame = vehicle({
    heading: 180,
    label: '8220',
    lat: south(-650),
    lon: RIDER[1],
    seconds: NOW_S - 46,
    speed: 25,
    tripHeadsign: 'ORANGE Burnsville',
    tripId: '1:1273254',
    vehicleId: '1:8220'
  })
  // The stopped bus at the station ahead: 304 m, frame at a standstill.
  const stopped = vehicle({
    heading: null as any,
    label: '8151',
    lat: south(304),
    lon: RIDER[1],
    seconds: NOW_S - 50,
    speed: 0,
    tripHeadsign: 'ORANGE Burnsville',
    tripId: '1:1273216',
    vehicleId: '1:8151'
  })
  const previousMatch = {
    confidence: 'high' as const,
    distanceMeters: 53,
    heading: 156,
    label: '8220',
    lastSeen: nowMs - 1000,
    tripId: '1:1273254',
    vehicleId: '1:8220'
  }
  const run = (vehicles: VehiclePosition[], ridingVehicleId: string | null) =>
    matchUserToVehicle(
      RIDER[0],
      RIDER[1],
      180,
      vehicles,
      '1:904',
      previousMatch,
      80,
      6.6,
      null,
      { nowMs, ridingVehicleId }
    )

  it('an overshooting projection no longer hands the match to a stopped bus', () => {
    // Without the riding vehicle: 304 m beats ~500 m by more than 150 m — the
    // 17:22:48 switch.
    expect(run([riddenFrame, stopped], null).vehicleId).toBe('1:8151')
    // Riding 8220: ranked by its corridor, which the rider is on.
    const held = run([riddenFrame, stopped], '1:8220')
    expect(held.vehicleId).toBe('1:8220')
    expect(held.confidence).toBe('high')
  })

  it('a challenger that is really closer than the whole corridor still wins', () => {
    // The ridden bus 2 km up the road with a fresh frame heading north (away):
    // not reachable, not on the corridor — the rider is on the other bus.
    const gone = vehicle({
      ...riddenFrame,
      heading: 0,
      lat: south(-2000),
      seconds: NOW_S - 10
    })
    const atRider = vehicle({ ...stopped, lat: south(10) })
    expect(run([gone, atRider], '1:8220').vehicleId).toBe('1:8151')
  })

  it('a heading-null, speed-0 frame of the ridden bus stays in range', () => {
    // 17:16:28's shape: frame 49 s old at a standstill, rider 400 m on and
    // stationary. The fallback radius is 80 m; the bus could be 1,550 m on.
    const standstill = vehicle({
      ...riddenFrame,
      heading: null as any,
      lat: south(-400),
      seconds: NOW_S - 49,
      speed: 0
    })
    const stationary = (ridingVehicleId: string | null) =>
      matchUserToVehicle(
        RIDER[0],
        RIDER[1],
        null,
        [standstill],
        '1:904',
        previousMatch,
        80,
        0,
        null,
        { nowMs, ridingVehicleId }
      )
    expect(stationary(null).confidence).toBe('none')
    const held = stationary('1:8220')
    expect(held.vehicleId).toBe('1:8220')
    // The last usable heading rides along for the next heading-less frame.
    expect(held.heading).toBe(156)
  })

  it('holds only the ridden bus, and only while it could still be carrying the rider', () => {
    const standstill = vehicle({
      ...riddenFrame,
      heading: null as any,
      lat: south(-400),
      seconds: NOW_S - 49,
      speed: 0
    })
    // Any other vehicle in that position is not held.
    expect(run([standstill], '1:9999').confidence).toBe('none')
    // A FRESH frame 1 km away: 80 + 20 x 30 = 680 m of reach — gone.
    expect(
      ridingVehicleReachable(
        RIDER[0],
        RIDER[1],
        { lat: south(-1000), lon: RIDER[1], seconds: NOW_S - 20 },
        80,
        nowMs
      )
    ).toBe(false)
    expect(
      ridingVehicleReachable(
        RIDER[0],
        RIDER[1],
        { lat: south(-600), lon: RIDER[1], seconds: NOW_S - 20 },
        80,
        nowMs
      )
    ).toBe(true)
    // No timestamp, or past the correctable age: no reach claimed.
    expect(
      ridingVehicleReachable(
        RIDER[0],
        RIDER[1],
        { lat: south(-100), lon: RIDER[1], seconds: 0 },
        80,
        nowMs
      )
    ).toBe(false)
    expect(
      ridingVehicleReachable(
        RIDER[0],
        RIDER[1],
        { lat: south(-100), lon: RIDER[1], seconds: NOW_S - 121 },
        80,
        nowMs
      )
    ).toBe(false)
  })

  it('nothing changes before riding is set', () => {
    const a = matchUserToVehicle(
      RIDER[0],
      RIDER[1],
      180,
      [riddenFrame, stopped],
      '1:904',
      previousMatch,
      80,
      6.6,
      null,
      { nowMs }
    )
    expect(a).toEqual(run([riddenFrame, stopped], null))
  })

  it('names the feed frame each tick was scored against', () => {
    expect(vehicleFrameKey(riddenFrame)).toBe(`t${NOW_S - 46}`)
    expect(run([riddenFrame, stopped], '1:8220').frameKey).toBe(
      `t${NOW_S - 46}`
    )
    // No timestamp (the 7/29 feed): the position identifies the frame.
    expect(
      vehicleFrameKey({ lat: 44.9, lon: -93.2, seconds: null as any })
    ).toBe('p44.9,-93.2')
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
    expect(calculateDistance(44.86, -93.28, undefined as any, -93.28)).toBe(
      Infinity
    )
    // A genuine 0/0 coordinate is still arithmetic, not an error — the
    // hasUsablePosition filter is what rejects null island.
    expect(calculateDistance(0, 0, 0, 0)).toBe(0)
  })
})
