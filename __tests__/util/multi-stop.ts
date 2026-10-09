/* globals describe, expect, it */
import coreUtils from '@opentripplanner/core-utils'
import qs from 'qs'

import {
  applyRoutingPreferences,
  planConstraintVariables
} from '../../lib/util/routing-profiles'
import {
  buildMultiStopPlan,
  hasNextSegment,
  itineraryDistanceM,
  itineraryStopNames,
  markStopLegs,
  normalizeIntermediatePlacesParam,
  pickNextSegment,
  queryStops,
  segmentStreetMode,
  splitAtStops,
  stitchSegments,
  viaVisitLocations
} from '../../lib/util/multi-stop'

/**
 * Backlog 43.1 — the rider's "Big update: look at adding multiple stops"
 * (2026-10-08 14:56:52), answered the same day: "Just want overall trip stats.
 * Then go mode does each leg at a time".
 *
 * The probe this file's itinerary is cut from, run against production OTP on
 * 2026-10-08 (home → Perennial Cycle → Micro Center, 2026-10-09 10:00,
 * WALK+TRANSIT, `via: [{visit: {label "Perennial Cycle", coordinate
 * 44.941584,-93.298483, minimumWaitTime "PT0S"}}]`): the first itinerary
 * 10:02→11:44 walked "Hennepin & 33rd St Station → Perennial Cycle (44.94158,
 * -93.29848)" (leg 6, 10:58:00–10:59:26) and then "Perennial Cycle (…) →
 * Lyndale Ave S & 33rd St W" (leg 7). OTP marks the visit only by that split.
 */

const HOME = { lat: 44.8168, lon: -93.3101, name: 'Home' }
const PERENNIAL = { lat: 44.941584, lon: -93.298483, name: 'Perennial Cycle' }
const MICRO_CENTER = { lat: 44.9396, lon: -93.3466, name: 'Micro Center' }

const T = (hhmmss: string) => new Date(`2026-10-09T${hhmmss}-05:00`).getTime()

const leg = (
  mode: string,
  start: string,
  end: string,
  from: any,
  to: any,
  distance: number,
  extra: any = {}
) => ({
  distance,
  duration: (T(end) - T(start)) / 1000,
  endTime: T(end),
  from,
  mode,
  startTime: T(start),
  to,
  transitLeg: mode === 'BUS',
  ...extra
})

const OTP_LABEL = {
  lat: 44.941584,
  lon: -93.298483,
  name: 'Perennial Cycle (44.94158, -93.29848)'
}
const HENNEPIN_33 = {
  lat: 44.942607,
  lon: -93.298437,
  name: 'Hennepin & 33rd St Station'
}
const LYNDALE_33 = {
  lat: 44.942741,
  lon: -93.288055,
  name: 'Lyndale Ave S & 33rd St W'
}

/** Probe A's first itinerary, cut to the legs around the visit. */
const probeItinerary = (): any => ({
  duration: 6104,
  endTime: T('11:44:00'),
  legs: [
    leg('WALK', '10:02:16', '10:03:00', HOME, HENNEPIN_33, 53),
    leg('BUS', '10:45:00', '10:58:00', HENNEPIN_33, HENNEPIN_33, 4284, {
      route: { id: '1:904' }
    }),
    leg('WALK', '10:58:00', '10:59:26', HENNEPIN_33, OTP_LABEL, 114),
    leg('WALK', '10:59:26', '11:11:38', OTP_LABEL, LYNDALE_33, 963),
    leg('BUS', '11:16:00', '11:29:00', LYNDALE_33, LYNDALE_33, 5263, {
      route: { id: '1:38' }
    }),
    leg('WALK', '11:29:00', '11:44:00', LYNDALE_33, MICRO_CENTER, 1139)
  ],
  startTime: T('10:02:16'),
  walkDistance: 2269
})

describe('util > multi-stop (43.1)', () => {
  describe('the stops a query carries', () => {
    it('keeps real places, in order, and drops placeholders', () => {
      expect(
        queryStops({ intermediatePlaces: [PERENNIAL, {}, null, MICRO_CENTER] })
      ).toEqual([PERENNIAL, MICRO_CENTER])
    })

    it('has none for an ordinary query', () => {
      expect(queryStops({ intermediatePlaces: [] })).toEqual([])
      expect(queryStops({})).toEqual([])
    })
  })

  describe('the plan request', () => {
    it('visits each stop, in order, with no stay', () => {
      expect(viaVisitLocations([PERENNIAL])).toEqual([
        {
          visit: {
            coordinate: { latitude: 44.941584, longitude: -93.298483 },
            label: 'Perennial Cycle',
            minimumWaitTime: 'PT0S'
          }
        }
      ])
    })

    it('rides on planConstraintVariables, ahead of a pass-through stop', () => {
      const out = planConstraintVariables({
        intermediatePlaces: [PERENNIAL, MICRO_CENTER],
        viaStop: { ids: ['1:56796'], name: 'Lake & Chicago' } as any
      })
      expect(out.via).toEqual([
        ...viaVisitLocations([PERENNIAL, MICRO_CENTER]),
        { passThrough: { stopLocationIds: ['1:56796'] } }
      ])
    })

    it('sends no via for an ordinary search', () => {
      expect(planConstraintVariables({ intermediatePlaces: [] })).toEqual({})
    })

    it('never sends the raw intermediatePlaces array as a plan() argument', () => {
      expect(
        applyRoutingPreferences({ intermediatePlaces: [PERENNIAL], x: 1 })
      ).toEqual({ x: 1 })
    })
  })

  describe('the query/URL round trip', () => {
    const roundTrip = (stops: any[]) => {
      const query = {
        date: '2026-10-09',
        departArrive: 'DEPART',
        from: HOME,
        intermediatePlaces: stops,
        mode: 'WALK,TRANSIT',
        routingType: 'ITINERARY',
        time: '10:00',
        to: MICRO_CENTER
      }
      // What updateOtpUrlParams writes (core-utils' getRoutingParams, then
      // combineQueryParams' qs `repeat` format) and what parseUrlQueryString
      // reads back (qs.parse, then planParamsToQuery).
      const params = coreUtils.query.getRoutingParams({}, query, true)
      const url = qs.stringify(params, { arrayFormat: 'repeat' })
      const parsed = qs.parse(url)
      return {
        query: coreUtils.query.planParamsToQuery(
          normalizeIntermediatePlacesParam(parsed)
        ),
        url
      }
    }

    it('carries one stop through the URL and back', () => {
      const { query, url } = roundTrip([PERENNIAL])
      expect(url).toContain(
        `intermediatePlaces=${encodeURIComponent(
          'Perennial Cycle::44.941584,-93.298483'
        )}`
      )
      expect(queryStops(query)).toEqual([PERENNIAL])
    })

    it('carries two stops through the URL and back, in order', () => {
      const { query } = roundTrip([PERENNIAL, MICRO_CENTER])
      expect(queryStops(query)).toEqual([PERENNIAL, MICRO_CENTER])
    })

    it('a single stop off the URL would throw in core-utils without the normalizer', () => {
      expect(() =>
        coreUtils.query.planParamsToQuery({
          intermediatePlaces: 'Perennial Cycle::44.941584,-93.298483'
        })
      ).toThrow()
    })

    it('writes nothing to the URL when there are no stops', () => {
      expect(roundTrip([]).url).not.toContain('intermediatePlaces')
    })
  })

  describe('the results', () => {
    it("finds the visit, puts the rider's label on it and records it", () => {
      const marked = markStopLegs(probeItinerary(), [PERENNIAL])
      expect(marked.stopLegIndexes).toEqual([2])
      expect(marked.legs[2].to.name).toBe('Perennial Cycle')
      expect(marked.legs[3].from.name).toBe('Perennial Cycle')
      expect(itineraryStopNames(marked)).toEqual(['Perennial Cycle'])
    })

    it('adds up the whole trip', () => {
      // 53 + 4284 + 114 + 963 + 5263 + 1139
      expect(itineraryDistanceM(probeItinerary())).toBe(11816)
    })

    it('leaves an itinerary that never reached the stop unmarked', () => {
      const plain = probeItinerary()
      const marked = markStopLegs(plain, [
        { lat: 45.1, lon: -93.1, name: 'Elsewhere' }
      ])
      expect(marked).toBe(plain)
      expect(itineraryStopNames(marked)).toEqual([])
    })

    it('never takes the final leg for a stop (that one is the destination)', () => {
      const marked = markStopLegs(probeItinerary(), [MICRO_CENTER])
      expect(marked.stopLegIndexes).toBeUndefined()
    })
  })

  describe('Go Mode one segment at a time', () => {
    it('splits at the stop, each piece with its own totals', () => {
      const segments = splitAtStops(markStopLegs(probeItinerary(), [PERENNIAL]))
      expect(segments).toHaveLength(2)
      expect(segments[0].legs).toHaveLength(3)
      expect(segments[0].endTime).toBe(T('10:59:26'))
      expect(segments[0].duration).toBe((T('10:59:26') - T('10:02:16')) / 1000)
      expect(segments[1].startTime).toBe(T('10:59:26'))
      expect(segments[1].endTime).toBe(T('11:44:00'))
      expect(segments[1].walkDistance).toBe(963 + 1139)
      expect((segments[0] as any).stopLegIndexes).toBeUndefined()
    })

    it('builds the plan for a multi-stop itinerary and nothing for a plain one', () => {
      const plan = buildMultiStopPlan(
        markStopLegs(probeItinerary(), [PERENNIAL])
      )
      expect(plan?.index).toBe(0)
      expect(plan?.stopNames).toEqual(['Perennial Cycle', 'Micro Center'])
      expect(hasNextSegment(plan)).toBe(true)
      expect(hasNextSegment(plan && { ...plan, index: 1 })).toBe(false)
      expect(buildMultiStopPlan(probeItinerary())).toBeNull()
    })
  })

  describe('the street-only chain', () => {
    it('stitches segments end to start and marks the joins', () => {
      const a: any = {
        legs: [leg('BICYCLE', '10:00:00', '10:20:00', HOME, PERENNIAL, 5000)],
        startTime: T('10:00:00')
      }
      // Planned to depart at 10:20 but OTP answered from 10:21.
      const b: any = {
        legs: [
          leg('BICYCLE', '10:21:00', '10:41:00', PERENNIAL, MICRO_CENTER, 4000)
        ],
        startTime: T('10:21:00')
      }
      const stitched = stitchSegments([a, b]) as any
      expect(stitched.stopLegIndexes).toEqual([0])
      expect(stitched.legs[1].startTime).toBe(T('10:20:00'))
      expect(stitched.endTime).toBe(T('10:40:00'))
      expect(stitched.duration).toBe(40 * 60)
      expect(itineraryDistanceM(stitched)).toBe(9000)
    })

    it('gives up when a segment has no answer', () => {
      expect(stitchSegments([null, null])).toBeNull()
    })
  })
})

describe('util > multi-stop > pickNextSegment (43.1)', () => {
  const bus = (route: string, start: string) =>
    leg('BUS', start, '11:30:00', HOME, MICRO_CENTER, 5000, {
      route: { id: route }
    })
  const it1 = (legs: any[]): any => ({ legs, startTime: legs[0].startTime })

  it('keeps the same routes in the same order', () => {
    const stored = it1([bus('1:38', '11:00:00')])
    const later = it1([bus('1:38', '11:20:00')])
    const other = it1([bus('1:6', '11:05:00')])
    expect(pickNextSegment([other, later], stored)).toBe(later)
    expect(pickNextSegment([other], stored)).toBeNull()
  })

  it('a bike segment stays a bike segment', () => {
    const stored = it1([
      leg('BICYCLE', '11:00:00', '11:20:00', HOME, PERENNIAL, 4000)
    ])
    const walk = it1([
      leg('WALK', '11:00:00', '12:00:00', HOME, PERENNIAL, 4000)
    ])
    const bike = it1([
      leg('BICYCLE', '11:05:00', '11:25:00', HOME, PERENNIAL, 4000)
    ])
    expect(segmentStreetMode(stored)).toBe('BICYCLE')
    expect(pickNextSegment([walk], stored)).toBeNull()
    expect(pickNextSegment([walk, bike], stored)).toBe(bike)
  })

  it('has no street mode for a transit segment', () => {
    expect(segmentStreetMode(it1([bus('1:38', '11:00:00')]))).toBeNull()
  })
})
