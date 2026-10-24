/* globals describe, expect, it */
import coreUtils from '@opentripplanner/core-utils'
import qs from 'qs'

import {
  applyRoutingPreferences,
  planConstraintVariables
} from '../../lib/util/routing-profiles'
import {
  applyStopStays,
  buildMultiStopPlan,
  canonicalStopStays,
  hasNextSegment,
  itineraryDistanceM,
  itineraryStopNames,
  itineraryStopTimes,
  markStopLegs,
  normalizeIntermediatePlacesParam,
  parseStopStaysParam,
  pickNextSegment,
  queryStops,
  queryStopStays,
  segmentStreetMode,
  splitAtStops,
  stitchSegments,
  stopStaysParam,
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
      // planConnection: query-gen wraps every via entry as {visit: v}, so
      // planConstraintVariables emits the visit bodies themselves.
      expect(out.via).toEqual([
        ...viaVisitLocations([PERENNIAL, MICRO_CENTER]).map(
          (v: any) => v.visit
        ),
        { stopLocationIds: ['1:56796'] }
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

  describe('the transit chain keeps scheduled times (52.1)', () => {
    // Segment 1 arrives at the stop 10:25; the next bus out leaves 10:33, so
    // the rider waits 8 minutes there. Shifting it back would put the rider
    // on a bus that does not run then.
    const a: any = {
      legs: [
        leg('WALK', '10:00:00', '10:05:00', HOME, { name: 'Stop A' }, 300),
        leg('BUS', '10:08:00', '10:25:00', { name: 'Stop A' }, PERENNIAL, 5000)
      ],
      startTime: T('10:00:00'),
      waitingTime: 180
    }
    const b: any = {
      legs: [leg('BUS', '10:33:00', '10:50:00', PERENNIAL, MICRO_CENTER, 4000)],
      startTime: T('10:33:00'),
      waitingTime: 0
    }

    it('leaves every leg at its scheduled time', () => {
      const stitched = stitchSegments([a, b], { keepTimes: true }) as any
      expect(stitched.legs.map((l: any) => l.startTime)).toEqual([
        T('10:00:00'),
        T('10:08:00'),
        T('10:33:00')
      ])
      expect(stitched.startTime).toBe(T('10:00:00'))
      expect(stitched.endTime).toBe(T('10:50:00'))
      expect(stitched.duration).toBe(50 * 60)
    })

    it('counts the gap at the stop as waiting', () => {
      const stitched = stitchSegments([a, b], { keepTimes: true }) as any
      // 3 min inside segment 1, 8 min at the stop.
      expect(stitched.waitingTime).toBe(11 * 60)
      expect(stitched.transfers).toBe(1)
    })

    it('marks the same joins as the street chain', () => {
      expect(
        (stitchSegments([a, b], { keepTimes: true }) as any).stopLegIndexes
      ).toEqual((stitchSegments([a, b]) as any).stopLegIndexes)
      expect(
        (stitchSegments([a, b], { keepTimes: true }) as any).stopLegIndexes
      ).toEqual([1])
    })

    it('still gives up when a segment has no answer', () => {
      expect(stitchSegments([a, null], { keepTimes: true })).toBeNull()
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

/**
 * Backlog 58.3 — the rider's 10-16 note "add a time of arrival to intermediate
 * stops … And a dwell time"; answers 10-18: the stops the rider adds, a
 * separate stay for each, times on the card and in the step list.
 *
 * Measured against production OTP 2026-10-18 (home → Perennial Cycle → Micro
 * Center, 2026-10-20 10:00, WALK+TRANSIT, `minimumWaitTime: "PT20M"`): the
 * first itinerary reached the stop 10:59:26 (walk 10:58:00–10:59:26), walked
 * on to Lagoon & Hennepin Station at once (10:59:26–11:11:16), waited for the
 * 11:34 bus to Lake & France (–11:40) and walked to Micro Center by 12:10:40;
 * waitingTime 1722 s. The stay was in the bus wait, not at the stop.
 */
describe('util > multi-stop > a stay at each stop (58.3)', () => {
  const LAGOON = {
    lat: 44.949308,
    lon: -93.29851,
    name: 'Lagoon & Hennepin Station'
  }
  const LAKE_FRANCE = {
    lat: 44.948131,
    lon: -93.328168,
    name: 'Lake & France Station'
  }
  const measured = (): any => ({
    duration: 7704,
    endTime: T('12:10:40'),
    legs: [
      leg('WALK', '10:02:16', '10:03:00', HOME, HENNEPIN_33, 53),
      leg('BUS', '10:45:00', '10:58:00', HENNEPIN_33, HENNEPIN_33, 4284, {
        route: { id: '1:6' }
      }),
      leg('WALK', '10:58:00', '10:59:26', HENNEPIN_33, OTP_LABEL, 114),
      leg('WALK', '10:59:26', '11:11:16', OTP_LABEL, LAGOON, 900),
      leg('BUS', '11:34:00', '11:40:00', LAGOON, LAKE_FRANCE, 2500, {
        route: { id: '1:21' }
      }),
      leg('WALK', '11:40:00', '12:10:40', LAKE_FRANCE, MICRO_CENTER, 2300)
    ],
    startTime: T('10:02:16'),
    waitingTime: 1722
  })

  describe('the request', () => {
    it('sends each stop with its own stay, PT0S where there is none', () => {
      expect(
        viaVisitLocations([PERENNIAL, MICRO_CENTER], [20, 0]).map(
          (v) => v.visit.minimumWaitTime
        )
      ).toEqual(['PT20M', 'PT0S'])
    })

    it('keeps PT0S for every stop when no stays are given (43.1 unchanged)', () => {
      expect(
        viaVisitLocations([PERENNIAL, MICRO_CENTER]).map(
          (v) => v.visit.minimumWaitTime
        )
      ).toEqual(['PT0S', 'PT0S'])
    })

    it('reads the stays off the query, one per stop, clamped', () => {
      const query = {
        intermediatePlaces: [PERENNIAL, {}, MICRO_CENTER],
        stopStays: [15, -3]
      }
      // The `{}` placeholder is not a stop, so the stays line up with the two
      // real ones; a negative stay is none.
      expect(queryStopStays(query)).toEqual([15, 0])
      expect(queryStopStays({ intermediatePlaces: [PERENNIAL] })).toEqual([0])
      expect(
        queryStopStays({ intermediatePlaces: [PERENNIAL], stopStays: [9999] })
      ).toEqual([720])
    })

    it('puts the stays in the plan variables, never the raw key', () => {
      const query = {
        intermediatePlaces: [PERENNIAL],
        stopStays: [20]
      }
      const vars: any = planConstraintVariables(query as any)
      expect(vars.via[0].minimumWaitTime).toBe('PT20M')
      expect(
        applyRoutingPreferences({ ...query, fromPlace: 'x' }).stopStays
      ).toBeUndefined()
    })
  })

  describe('the URL', () => {
    it('writes the stays as one parameter and reads them back', () => {
      expect(stopStaysParam([20, 0, 15])).toBe('20,0,15')
      expect(parseStopStaysParam('20,0,15')).toEqual([20, 0, 15])
      // qs + planParamsToQuery turn a lone "20" into the number 20.
      expect(parseStopStaysParam(20)).toEqual([20])
    })

    it('writes nothing for no stays, and "none" is always []', () => {
      expect(stopStaysParam([0, 0])).toBeUndefined()
      expect(stopStaysParam(undefined)).toBeUndefined()
      expect(parseStopStaysParam(undefined)).toEqual([])
      expect(canonicalStopStays([0, 0])).toEqual([])
      expect(canonicalStopStays([0, 20, 0])).toEqual([0, 20])
    })
  })

  describe('the results', () => {
    it('moves the walk away from the stop to after the stay, before the bus', () => {
      const marked: any = markStopLegs(measured(), [PERENNIAL], [20])
      expect(marked.stopLegIndexes).toEqual([2])
      expect(marked.stopStayMinutes).toEqual([20])
      // Arrival untouched; the walk on starts 20 min later and still makes
      // the 11:34 bus (ends 11:31:16).
      expect(marked.legs[2].endTime).toBe(T('10:59:26'))
      expect(marked.legs[3].startTime).toBe(T('11:19:26'))
      expect(marked.legs[3].endTime).toBe(T('11:31:16'))
      expect(marked.legs[4].startTime).toBe(T('11:34:00'))
      expect(marked.endTime).toBe(T('12:10:40'))
      // The 20 minutes are the stay now, not waiting for a bus.
      expect(marked.waitingTime).toBe(1722 - 1200)
    })

    it('gives each stop its arrival and leave time, with the stay asked for', () => {
      const marked = markStopLegs(measured(), [PERENNIAL], [20])
      expect(itineraryStopTimes(marked)).toEqual([
        {
          arrivalTime: T('10:59:26'),
          leaveTime: T('11:19:26'),
          name: 'Perennial Cycle',
          stayMinutes: 20
        }
      ])
      // The step list's row for the stop sees the arrival on its own leg.
      expect((marked.legs[3].from as any).riderStop).toEqual({
        arrivalTime: T('10:59:26'),
        stayMinutes: 20
      })
    })

    it('without a stay, arrival and leave are the same and no leg moves', () => {
      const plain = measured()
      const marked: any = markStopLegs(plain, [PERENNIAL])
      expect(marked.legs[3].startTime).toBe(plain.legs[3].startTime)
      expect(marked.waitingTime).toBe(1722)
      const [times] = itineraryStopTimes(marked)
      expect(times.arrivalTime).toBe(times.leaveTime)
      expect(times.stayMinutes).toBe(0)
    })

    it('never moves the walk past the bus', () => {
      // 30 min asked, 22:44 free before the 11:34 bus: the walk ends at the
      // bus, and the plan leaves the stop as late as it can.
      const marked: any = markStopLegs(measured(), [PERENNIAL], [30])
      expect(marked.legs[3].endTime).toBe(T('11:34:00'))
      expect(marked.legs[3].startTime).toBe(T('11:22:10'))
    })

    it('leaves a stop with no bus after it alone', () => {
      const it0: any = measured()
      // Walk the rest of the way: no bus to take the wait from.
      it0.legs = [
        ...it0.legs.slice(0, 3),
        leg('WALK', '10:59:26', '11:40:00', OTP_LABEL, MICRO_CENTER, 3000)
      ]
      const marked: any = markStopLegs(it0, [PERENNIAL], [20])
      expect(marked.legs[3].startTime).toBe(T('10:59:26'))
      expect(marked.stopStayMinutes).toEqual([20])
    })

    it('counts a gap already at the stop (the chain leaves one)', () => {
      const it0: any = measured()
      it0.legs[3] = leg('WALK', '11:19:26', '11:31:16', OTP_LABEL, LAGOON, 900)
      const input = { ...it0, stopLegIndexes: [2] }
      const out: any = applyStopStays(input, [20])
      expect(out).toBe(input)
      expect(out.legs[3].startTime).toBe(T('11:19:26'))
    })

    it('names the right stop when OTP skipped the one before it', () => {
      const marked: any = markStopLegs(
        measured(),
        [{ lat: 45.1, lon: -93.1, name: 'Elsewhere' }, PERENNIAL],
        [5, 20]
      )
      expect(marked.legs[2].to.name).toBe('Perennial Cycle')
      expect(marked.stopStayMinutes).toEqual([20])
    })

    it('Go Mode splits a stayed itinerary with the next segment leaving after the stay', () => {
      const plan = buildMultiStopPlan(
        markStopLegs(measured(), [PERENNIAL], [20])
      )
      expect(plan?.segments[0].endTime).toBe(T('10:59:26'))
      expect(plan?.segments[1].startTime).toBe(T('11:19:26'))
      expect((plan?.segments[1] as any).stopStayMinutes).toBeUndefined()
    })
  })

  describe('the chain', () => {
    const a: any = {
      legs: [leg('BICYCLE', '10:00:00', '10:20:00', HOME, PERENNIAL, 5000)],
      startTime: T('10:00:00')
    }
    const b: any = {
      legs: [
        leg('BICYCLE', '10:40:00', '11:00:00', PERENNIAL, MICRO_CENTER, 4000)
      ],
      startTime: T('10:40:00')
    }

    it('street-only: the next segment starts once the stay is over', () => {
      const stitched: any = stitchSegments([a, b], { stays: [20] })
      expect(stitched.legs[0].endTime).toBe(T('10:20:00'))
      expect(stitched.legs[1].startTime).toBe(T('10:40:00'))
      expect(stitched.endTime).toBe(T('11:00:00'))
      expect(stitched.duration).toBe(60 * 60)
      // Marking it does not add the stay a second time.
      const marked: any = markStopLegs(stitched, [PERENNIAL], [20])
      expect(marked.legs[1].startTime).toBe(T('10:40:00'))
      expect(itineraryStopTimes(marked)[0]).toMatchObject({
        arrivalTime: T('10:20:00'),
        leaveTime: T('10:40:00')
      })
    })

    it('transit (keepTimes): the stay is not counted as waiting', () => {
      const bus: any = {
        legs: [
          leg('BUS', '10:43:00', '11:00:00', PERENNIAL, MICRO_CENTER, 4000)
        ],
        startTime: T('10:43:00'),
        waitingTime: 0
      }
      const stitched: any = stitchSegments([a, bus], {
        keepTimes: true,
        stays: [20]
      })
      // 23 min between arrival and the bus, 20 of them the stay.
      expect(stitched.waitingTime).toBe(3 * 60)
      expect(stitched.legs[1].startTime).toBe(T('10:43:00'))
    })
  })
})
