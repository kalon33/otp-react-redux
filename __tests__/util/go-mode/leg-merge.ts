import { encode } from '@mapbox/polyline'

import {
  mergeAdjacentSameTripLegs,
  normalizeGoModeItinerary
} from '../../../lib/util/go-mode/leg-merge'
import { orderedStopsOnLeg } from '../../../lib/util/go-mode/next-stop'

const TRIP = '1:1201789'

// The recorded 8/2 pair: one continuous Orange Line ride from Knox Ave & 76th
// to I-35W & 46th, rendered as two legs of the SAME trip meeting at 66th St
// with a fake ~2-minute transfer and the fare counted twice. Leg A is the
// synthesized onboard leg (distance 0, route as a bare object, no routeColor);
// leg B is the planner's, carrying the fields A lacks.
const legA = (over: any = {}): any => ({
  distance: 0,
  duration: 144,
  endTime: 1785723976000,
  fareProducts: [{ id: 'fp-a', product: { id: 'rideFare' } }],
  from: {
    lat: 44.864536,
    lon: -93.302232,
    name: 'Knox Ave & 76th St Station',
    stop: { code: '56828', gtfsId: '1:56828', id: '1:56828' },
    stopId: '1:56828'
  },
  intermediatePlaces: [],
  legGeometry: {
    length: 3,
    points: encode([
      [44.864536, -93.302232],
      [44.874, -93.299],
      [44.88321, -93.295321]
    ])
  },
  mode: 'BUS',
  route: { color: 'F68B1F', id: '1:904', longName: 'METRO Orange Line' },
  startTime: 1785723831588,
  to: {
    lat: 44.88321,
    lon: -93.295321,
    name: 'I-35W & 66th St Station',
    stop: { code: '48084', gtfsId: '1:48084', id: '1:48084' },
    stopId: '1:48084'
  },
  transitLeg: true,
  trip: { gtfsId: TRIP },
  tripId: TRIP,
  ...over
})

const legB = (over: any = {}): any => ({
  distance: 5427.26,
  duration: 240,
  endTime: 1785724293000,
  fareProducts: [{ id: 'fp-b', product: { id: 'rideFare' } }],
  from: {
    lat: 44.88321,
    lon: -93.295321,
    name: 'I-35W & 66th St Station',
    stop: { code: '48084', gtfsId: '1:48084', id: 'U3RvcDoxOjQ4MDg0' },
    stopId: '1:48084'
  },
  intermediatePlaces: [],
  legGeometry: {
    length: 2,
    points: encode([
      [44.88321, -93.295321],
      [44.919902, -93.274801]
    ])
  },
  mode: 'BUS',
  realTime: true,
  route: {
    color: 'F68B1F',
    gtfsId: '1:904',
    id: '1:904',
    longName: 'METRO Orange Line',
    type: 3
  },
  routeColor: 'F68B1F',
  startTime: 1785724053000,
  to: {
    lat: 44.919902,
    lon: -93.274801,
    name: 'I-35W & 46th St Station',
    stop: { code: '53542', gtfsId: '1:53542', id: 'U3RvcDoxOjUzNTQy' },
    stopId: '1:53542'
  },
  transitLeg: true,
  trip: { gtfsId: TRIP, id: 'VHJpcDoxOjEyMDE3ODk' },
  tripId: TRIP,
  ...over
})

const bikeLeg: any = {
  distance: 5960.29,
  duration: 1426,
  endTime: 1785725719000,
  from: { lat: 44.919902, lon: -93.274801, name: 'I-35W & 46th St Station' },
  mode: 'BICYCLE',
  startTime: 1785724293000,
  to: { lat: 44.9, lon: -93.22, name: '3100 East 53rd Street' },
  transitLeg: false
}

describe('mergeAdjacentSameTripLegs — the 8/2 split ride', () => {
  const merged = mergeAdjacentSameTripLegs([legA(), legB(), bikeLeg])

  it('emits one bus leg spanning the whole ride', () => {
    expect(merged).toHaveLength(2)
    expect(merged[0].transitLeg).toBe(true)
    expect(merged[1].mode).toBe('BICYCLE')
    expect(merged[0].from.name).toBe('Knox Ave & 76th St Station')
    expect(merged[0].to.name).toBe('I-35W & 46th St Station')
    expect(merged[0].startTime).toBe(1785723831588)
    expect(merged[0].endTime).toBe(1785724293000)
    expect(merged[0].duration).toBeCloseTo((1785724293000 - 1785723831588) / 1000)
  })

  it('keeps the junction stop, so the stop counter has something to count', () => {
    // Without this the split's meeting point vanishes and the merged leg is
    // still effectively one hop — the GET READY banner's "1 stop remaining"
    // for the entire ride.
    const stops = orderedStopsOnLeg(merged[0]).map((s: any) => s.name)
    expect(stops).toEqual([
      'I-35W & 66th St Station',
      'I-35W & 46th St Station'
    ])
    const junction: any = (merged[0] as any).intermediatePlaces[0]
    expect(junction.arrivalTime).toBe(1785723976000)
    expect(junction.departureTime).toBe(1785724053000)
    expect(junction.stop.gtfsId).toBe('1:48084')
  })

  it('charges the fare once', () => {
    expect((merged[0] as any).fareProducts).toHaveLength(1)
  })

  it('recomputes distance from geometry instead of inheriting the 0', () => {
    // ~6.3 km along I-35W; the synthesized leg claimed 0.
    expect(merged[0].distance).toBeGreaterThan(5000)
    expect((merged[0] as any).legGeometry.length).toBe(5)
  })

  it("fills the synthesized leg's holes from the real one", () => {
    // Field-wise prefer-defined, a wins: the merged leg keeps A's identity
    // but gains B's routeColor, route.gtfsId/type and realTime.
    expect((merged[0] as any).routeColor).toBe('F68B1F')
    expect((merged[0] as any).route.gtfsId).toBe('1:904')
    expect((merged[0] as any).route.type).toBe(3)
    expect((merged[0] as any).route.color).toBe('F68B1F')
    expect((merged[0] as any).trip.id).toBe('VHJpcDoxOjEyMDE3ODk')
    expect((merged[0] as any).realTime).toBe(true)
  })
})

describe('mergeAdjacentSameTripLegs — what must NOT merge', () => {
  const cases: Array<[string, any, any]> = [
    ['different trips', legA(), legB({ trip: { gtfsId: '1:other' }, tripId: '1:other' })],
    ['no trip id at all', legA({ trip: null, tripId: null }), legB({ trip: null, tripId: null })],
    [
      'non-contiguous (a loop route serving the trip twice)',
      legA(),
      legB({
        from: {
          lat: 44.95,
          lon: -93.27,
          name: 'Elsewhere',
          stop: { gtfsId: '1:99999', id: '1:99999' }
        }
      })
    ],
    ['out of order', legA(), legB({ startTime: 1785723000000 })],
    ['one of them is not transit', legA(), { ...bikeLeg, tripId: TRIP }]
  ]
  it.each(cases)('%s', (_name, a, b) => {
    const legs = [a, b]
    const out = mergeAdjacentSameTripLegs(legs)
    expect(out).toHaveLength(2)
    // Nothing merged means the SAME array back — spliceAccessOntoItinerary
    // promises its suffix legs are the same objects.
    expect(out).toBe(legs)
  })

  it('handles empty and missing input', () => {
    expect(mergeAdjacentSameTripLegs([])).toEqual([])
    expect(mergeAdjacentSameTripLegs(null)).toEqual([])
    expect(mergeAdjacentSameTripLegs(undefined)).toEqual([])
  })

  it('collapses a run of three same-trip legs into one', () => {
    const mid = legB({
      endTime: 1785724100000,
      to: {
        lat: 44.9,
        lon: -93.29,
        name: 'I-35W & Lake St Station',
        stop: { gtfsId: '1:51234', id: '1:51234' },
        stopId: '1:51234'
      }
    })
    const last = legB({
      from: {
        lat: 44.9,
        lon: -93.29,
        name: 'I-35W & Lake St Station',
        stop: { gtfsId: '1:51234', id: '1:51234' },
        stopId: '1:51234'
      },
      startTime: 1785724150000
    })
    const out = mergeAdjacentSameTripLegs([legA(), mid, last])
    expect(out).toHaveLength(1)
    expect(orderedStopsOnLeg(out[0]).map((s: any) => s.name)).toEqual([
      'I-35W & 66th St Station',
      'I-35W & Lake St Station',
      'I-35W & 46th St Station'
    ])
  })
})

describe('normalizeGoModeItinerary', () => {
  const itinerary = (legs: any[]): any => ({
    duration: 1888,
    endTime: 1785725719000,
    legs,
    startTime: 1785723831588,
    transfers: 1,
    transitTime: 384,
    waitingTime: 77
  })

  it('drops the phantom transfer the split invented', () => {
    const out: any = normalizeGoModeItinerary(
      itinerary([legA(), legB(), bikeLeg])
    )
    expect(out.legs).toHaveLength(2)
    // User-visible in the trip sheet and itinerary summary — and correct.
    expect(out.transfers).toBe(0)
    // The trip still begins and ends when it did.
    expect(out.startTime).toBe(1785723831588)
    expect(out.endTime).toBe(1785725719000)
  })

  it('recomputes transitTime/waitingTime only when they were already there', () => {
    const withOut: any = normalizeGoModeItinerary({
      ...itinerary([legA(), legB(), bikeLeg]),
      transitTime: undefined,
      waitingTime: undefined
    })
    expect(withOut.transitTime).toBeUndefined()
    expect(withOut.waitingTime).toBeUndefined()

    const withThem: any = normalizeGoModeItinerary(
      itinerary([legA(), legB(), bikeLeg])
    )
    expect(withThem.transitTime).toBeCloseTo(
      (1785724293000 - 1785723831588) / 1000
    )
    expect(withThem.waitingTime).toBeGreaterThanOrEqual(0)
  })

  it('returns the input REFERENCE when nothing merges', () => {
    // The tripwire for spliceAccessOntoItinerary's same-objects promise: this
    // sits downstream of it in beginGoMode, and a gratuitous copy would break
    // the 7/29 "only reroute the bike leg" fix.
    const clean = itinerary([legA(), bikeLeg])
    expect(normalizeGoModeItinerary(clean)).toBe(clean)
    expect(normalizeGoModeItinerary(null)).toBeNull()
    expect(normalizeGoModeItinerary({ legs: [] } as any)).toEqual({ legs: [] })
  })
})
