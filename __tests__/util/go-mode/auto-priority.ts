/* globals describe, expect, it */
import {
  AUTO_LATER_ALLOWANCE_MS,
  AUTO_PRESETS,
  autoPresetVerdict,
  changesOf,
  rankAlightForPreset,
  rankForPreset,
  waitMsOf,
  walkMetersOf
} from '../../../lib/util/go-mode/auto-priority'
import {
  classifyFasterRoute,
  compareAlightOffer
} from '../../../lib/util/go-mode/faster-route'

/**
 * Backlog 65.2 (cycle 36 B1): Auto's four presets over 56.1's candidate pool.
 * The fixture sweep lives in faster-route-fixtures.ts; these pin each
 * preset's rule and tie-breaks on hand-built itineraries.
 */

const T0 = Date.UTC(2026, 9, 17, 21, 30, 0) // 16:30 CDT
const MIN = 60000
const HERE: [number, number] = [44.8227, -93.3013]

let tripSeq = 0
function street(
  mode: 'BICYCLE' | 'WALK',
  start: number,
  end: number,
  distance: number
): any {
  return {
    distance,
    duration: (end - start) / 1000,
    endTime: end,
    from: { lat: HERE[0], lon: HERE[1], name: 'Current location' },
    mode,
    startTime: start,
    to: { lat: 44.83, lon: -93.29, name: 'x' },
    transitLeg: false
  }
}
const bike = (s: number, e: number, m: number) => street('BICYCLE', s, e, m)
const walk = (s: number, e: number, m: number) => street('WALK', s, e, m)
function bus(
  route: string,
  start: number,
  end: number,
  {
    interline = false,
    stop = '1:56831',
    toStop = '1:56800',
    trip = `1:${++tripSeq}`
  } = {}
): any {
  return {
    distance: 10000,
    duration: (end - start) / 1000,
    endTime: end,
    from: { lat: 44.8255, lon: -93.2909, name: 'Stop', stop: { gtfsId: stop } },
    interlineWithPreviousLeg: interline,
    mode: 'BUS',
    route: { id: route },
    startTime: start,
    to: { lat: 44.9, lon: -93.25, name: 'Alight', stop: { gtfsId: toStop } },
    transitLeg: true,
    trip: { gtfsId: trip }
  }
}
function itin(legs: any[]): any {
  return {
    duration: (legs[legs.length - 1].endTime - legs[0].startTime) / 1000,
    endTime: legs[legs.length - 1].endTime,
    legs,
    startTime: legs[0].startTime
  }
}

// The bar: bike 2.5 km to the 904 at 16:45, ride to 17:10, bike 2 km by 17:20.
// 4.5 km of biking, no vehicle change.
const own = () =>
  itin([
    bike(T0, T0 + 12 * MIN, 2500),
    bus('1:904', T0 + 15 * MIN, T0 + 40 * MIN, { trip: '1:OWN' }),
    bike(T0 + 40 * MIN, T0 + 50 * MIN, 2000)
  ])
const bar = own()
/** Bike `bikeM` to `route`, ride to `arriveMs`. No change. */
const direct = (route: string, arriveMs: number, bikeM = 2500) =>
  itin([bike(T0, T0 + 8 * MIN, bikeM), bus(route, T0 + 10 * MIN, arriveMs)])
/** Walk to `r1`, change to `r2` after `waitMs`, arrive `arriveMs`. One change. */
const twoBus = (
  r1: string,
  r2: string,
  arriveMs: number,
  { bikeM = 0, waitMs = 2 * MIN, walkM = 300 } = {}
) =>
  itin([
    bikeM ? bike(T0, T0 + 5 * MIN, bikeM) : walk(T0, T0 + 5 * MIN, walkM),
    bus(r1, T0 + 6 * MIN, T0 + 20 * MIN),
    bus(r2, T0 + 20 * MIN + waitMs, arriveMs)
  ])

describe('util > go-mode > auto-priority', () => {
  describe('metrics', () => {
    it('changes = transit legs − 1; a stay-seated interline is not a change', () => {
      expect(changesOf(bar)).toBe(0)
      expect(changesOf(twoBus('1:5', '1:7', T0 + 40 * MIN))).toBe(1)
      expect(
        changesOf(
          itin([
            bus('1:5', T0, T0 + 10 * MIN),
            bus('1:7', T0 + 10 * MIN, T0 + 20 * MIN, { interline: true })
          ])
        )
      ).toBe(0)
      expect(changesOf(itin([bike(T0, T0 + 30 * MIN, 9000)]))).toBe(0)
      expect(changesOf(null)).toBe(0)
    })
    it('waiting = the gap before each transit leg; walking = walk metres', () => {
      // walk ends +5, bus 1 at +6 (1 min), bus 2 at +20 + 4 (4 min)
      const it = twoBus('1:5', '1:7', T0 + 40 * MIN, { waitMs: 4 * MIN })
      expect(waitMsOf(it)).toBe(5 * MIN)
      expect(waitMsOf(bar)).toBe(3 * MIN)
      expect(walkMetersOf(it)).toBe(300)
      expect(walkMetersOf(bar)).toBe(0)
    })
  })

  describe('rankForPreset', () => {
    it('Stay on my route never picks a different route', () => {
      const r = rankForPreset(
        [direct('1:5', T0 + 30 * MIN)],
        bar,
        'stayOnRoute'
      )
      expect(r.pick).toBeNull()
      expect(r.why).toBe('stay-on-route')
    })
    it('no candidates → no-candidate for every switching preset', () => {
      for (const p of AUTO_PRESETS.filter((x) => x !== 'stayOnRoute')) {
        expect(rankForPreset([], bar, p).why).toBe('no-candidate')
      }
    })

    describe('Fastest (56.1 verbatim)', () => {
      it('≥ 3 min earlier switches; 2.5 min earlier does not', () => {
        const fast = direct('1:5', T0 + 47 * MIN)
        expect(rankForPreset([fast], bar, 'fastest').pick?.itinerary).toBe(fast)
        const near = direct('1:5', T0 + 47.5 * MIN)
        expect(rankForPreset([near], bar, 'fastest').why).toBe('not-better')
      })
      it('±2 min with ≥ 1 km less biking switches; a route only simpler does not', () => {
        const lessBike = direct('1:5', T0 + 51 * MIN, 1000)
        expect(rankForPreset([lessBike], bar, 'fastest').pick?.itinerary).toBe(
          lessBike
        )
        const simpler = direct('1:5', T0 + 51 * MIN, 4000)
        expect(rankForPreset([simpler], bar, 'fastest').why).toBe('not-better')
      })
      it('a faster pick beats a less-biking one, whatever the biking', () => {
        const faster = direct('1:5', T0 + 44 * MIN, 4500)
        const lessBike = direct('1:7', T0 + 50 * MIN, 0)
        const r = rankForPreset([lessBike, faster], bar, 'fastest')
        expect(r.pick?.itinerary).toBe(faster)
        expect(r.ranked.map((s) => s.itinerary)).toEqual([faster, lessBike])
      })
      it('ties: biggest saving → fewer changes → less waiting → answer order', () => {
        const oneChange = twoBus('1:5', '1:7', T0 + 44 * MIN)
        const noChange = direct('1:9', T0 + 44 * MIN)
        expect(
          rankForPreset([oneChange, noChange], bar, 'fastest').pick?.itinerary
        ).toBe(noChange)
        const longWait = twoBus('1:5', '1:7', T0 + 44 * MIN, {
          waitMs: 6 * MIN
        })
        const shortWait = twoBus('1:5', '1:8', T0 + 44 * MIN, { waitMs: MIN })
        expect(
          rankForPreset([longWait, shortWait], bar, 'fastest').pick?.itinerary
        ).toBe(shortWait)
        const a = direct('1:5', T0 + 44 * MIN)
        const b = direct('1:6', T0 + 44 * MIN)
        expect(rankForPreset([a, b], bar, 'fastest').pick?.itinerary).toBe(a)
      })
      it('among less-biking picks, the fewest bike metres wins (56.1)', () => {
        const some = direct('1:5', T0 + 49 * MIN, 2000)
        const least = direct('1:7', T0 + 51 * MIN, 500)
        expect(
          rankForPreset([some, least], bar, 'fastest').pick?.itinerary
        ).toBe(least)
      })
    })

    describe('Least biking', () => {
      it('≥ 1 km less biking within the allowance switches; beyond it does not', () => {
        expect(AUTO_LATER_ALLOWANCE_MS).toBe(2 * MIN)
        const inBand = direct('1:5', T0 + 52 * MIN, 1000)
        expect(rankForPreset([inBand], bar, 'leastBike').pick?.itinerary).toBe(
          inBand
        )
        const late = direct('1:5', T0 + 53 * MIN, 1000)
        expect(rankForPreset([late], bar, 'leastBike').why).toBe('not-better')
        // the plan's original +5 min, still selectable for measurement
        expect(
          rankForPreset([late], bar, 'leastBike', { allowanceMs: 5 * MIN }).pick
            ?.itinerary
        ).toBe(late)
      })
      it('no more biking and ≥ 3 min earlier switches', () => {
        const sameBike = direct('1:5', T0 + 46 * MIN, 4500)
        expect(
          rankForPreset([sameBike], bar, 'leastBike').pick?.itinerary
        ).toBe(sameBike)
      })
      it('never for a faster route that bikes more', () => {
        const fasterMoreBike = direct('1:5', T0 + 30 * MIN, 4600)
        expect(rankForPreset([fasterMoreBike], bar, 'leastBike').why).toBe(
          'not-better'
        )
        expect(
          rankForPreset([fasterMoreBike], bar, 'fastest').pick
        ).not.toBeNull()
      })
      it('less than 1 km less biking is not enough on its own', () => {
        const little = direct('1:5', T0 + 50 * MIN, 3600)
        expect(rankForPreset([little], bar, 'leastBike').why).toBe('not-better')
      })
      it('ties: fewest bike metres → arrival → fewer changes', () => {
        const fastBiky = direct('1:5', T0 + 44 * MIN, 3000)
        const slowLean = direct('1:7', T0 + 51 * MIN, 500)
        expect(
          rankForPreset([fastBiky, slowLean], bar, 'leastBike').pick?.itinerary
        ).toBe(slowLean)
        const early = direct('1:8', T0 + 49 * MIN, 500)
        expect(
          rankForPreset([slowLean, early], bar, 'leastBike').pick?.itinerary
        ).toBe(early)
        const changes = twoBus('1:5', '1:6', T0 + 49 * MIN, { bikeM: 500 })
        expect(
          rankForPreset([changes, early], bar, 'leastBike').pick?.itinerary
        ).toBe(early)
      })
    })

    describe('Simplest', () => {
      // A bar with one change: walk, 5 then 7, by 17:20.
      const twoBar = twoBus('1:5', '1:7', T0 + 50 * MIN, { waitMs: 3 * MIN })
      it('fewer changes within the allowance switches; beyond it does not', () => {
        const oneSeat = direct('1:904', T0 + 52 * MIN)
        expect(
          rankForPreset([oneSeat], twoBar, 'simplest').pick?.itinerary
        ).toBe(oneSeat)
        const late = direct('1:904', T0 + 53 * MIN)
        expect(rankForPreset([late], twoBar, 'simplest').why).toBe('not-better')
      })
      it('same changes and ≥ 3 min earlier switches; 2 min earlier does not', () => {
        const fast = twoBus('1:6', '1:8', T0 + 46 * MIN)
        expect(rankForPreset([fast], twoBar, 'simplest').pick?.itinerary).toBe(
          fast
        )
        const near = twoBus('1:6', '1:8', T0 + 48 * MIN)
        expect(rankForPreset([near], twoBar, 'simplest').why).toBe('not-better')
      })
      it('never for a faster route with more changes', () => {
        const fasterMore = twoBus('1:5', '1:7', T0 + 30 * MIN)
        expect(rankForPreset([fasterMore], bar, 'simplest').why).toBe(
          'not-better'
        )
      })
      it('ties: fewer changes → less waiting → arrival → walking', () => {
        const fastOneChange = twoBus('1:6', '1:8', T0 + 40 * MIN)
        const slowNoChange = direct('1:904', T0 + 51 * MIN)
        expect(
          rankForPreset([fastOneChange, slowNoChange], twoBar, 'simplest').pick
            ?.itinerary
        ).toBe(slowNoChange)
        const waitLong = twoBus('1:6', '1:8', T0 + 44 * MIN, {
          waitMs: 6 * MIN
        })
        const waitShort = twoBus('1:6', '1:9', T0 + 46 * MIN, { waitMs: MIN })
        expect(
          rankForPreset([waitLong, waitShort], twoBar, 'simplest').pick
            ?.itinerary
        ).toBe(waitShort)
        const later = twoBus('1:6', '1:8', T0 + 46 * MIN, { walkM: 100 })
        const earlier = twoBus('1:6', '1:9', T0 + 45 * MIN, { walkM: 900 })
        expect(
          rankForPreset([later, earlier], twoBar, 'simplest').pick?.itinerary
        ).toBe(earlier)
        const farWalk = twoBus('1:6', '1:8', T0 + 45 * MIN, { walkM: 900 })
        const nearWalk = twoBus('1:6', '1:9', T0 + 45 * MIN, { walkM: 100 })
        expect(
          rankForPreset([farWalk, nearWalk], twoBar, 'simplest').pick?.itinerary
        ).toBe(nearWalk)
      })
    })
  })

  describe('autoPresetVerdict (56.1 pool and bar)', () => {
    const base = { current: bar, nowMs: T0, position: HERE }
    it('Fastest picks exactly what classifyFasterRoute offers', () => {
      const fast = direct('1:5', T0 + 44 * MIN)
      const lean = direct('1:7', T0 + 50 * MIN, 500)
      const input = { ...base, answer: [own(), lean, fast] }
      const v = classifyFasterRoute(input)
      const a = autoPresetVerdict(input, 'fastest')
      expect(v.why).toBe('offer')
      expect(a.pick?.itinerary).toBe(v.candidate)
      expect(a.pool?.bar).toBe(v.baseline)
      // ...and Least biking takes the lean one off the same pool.
      expect(autoPresetVerdict(input, 'leastBike').pick?.itinerary).toBe(lean)
    })
    it('Stay on my route: no pick even when Fastest has one', () => {
      const input = { ...base, answer: [own(), direct('1:5', T0 + 30 * MIN)] }
      expect(autoPresetVerdict(input, 'fastest').pick).not.toBeNull()
      const s = autoPresetVerdict(input, 'stayOnRoute')
      expect(s.pick).toBeNull()
      expect(s.why).toBe('stay-on-route')
    })
    it('the early verdicts carry through: aboard, no baseline', () => {
      const answer = [own(), direct('1:5', T0 + 30 * MIN)]
      const aboard = autoPresetVerdict(
        { ...base, answer, riding: true },
        'simplest'
      )
      expect(aboard.early?.why).toBe('aboard')
      expect(aboard.pick).toBeNull()
      const noBase = autoPresetVerdict(
        { ...base, answer: [direct('1:5', T0 + 30 * MIN)] },
        'leastBike'
      )
      expect(noBase.early?.why).toBe('no-baseline')
    })
    it("the rider's own next bus with a new tail is never a switch", () => {
      const sameBus = itin([
        bike(T0, T0 + 12 * MIN, 2500),
        bus('1:904', T0 + 15 * MIN, T0 + 30 * MIN, { trip: '1:OWN' }),
        bus('1:5', T0 + 31 * MIN, T0 + 40 * MIN)
      ])
      const a = autoPresetVerdict(
        { ...base, answer: [own(), sameBus] },
        'fastest'
      )
      expect(a.pick).toBeNull()
      expect(a.blocked['same-bus']).toBe(1)
    })
  })

  describe('rankAlightForPreset (aboard)', () => {
    // Aboard: the bus reaches P at 16:54; the plan boards the 904 there at
    // 16:55 and bikes 2 km in by 17:20.
    const P = '1:P'
    const onward = (
      stopId: string,
      legs: any[]
    ): { busArrivalEpoch: number; itin: any; stopId: string } => ({
      busArrivalEpoch: legs[0].startTime - MIN,
      itin: itin(legs),
      stopId
    })
    const planned = onward(P, [
      bus('1:904', T0 + 25 * MIN, T0 + 40 * MIN, { stop: P, trip: '1:ON' }),
      bike(T0 + 40 * MIN, T0 + 50 * MIN, 2000)
    ])
    // Same route from another stop, 6 min sooner, same biking.
    const q = onward('1:Q', [
      bus('1:904', T0 + 23 * MIN, T0 + 34 * MIN, {
        stop: '1:Q',
        trip: '1:ON2'
      }),
      bike(T0 + 34 * MIN, T0 + 44 * MIN, 2000)
    ])
    // Bike the rest from R: no vehicle at all, 1 min later, 4 km of biking.
    const r = onward('1:R', [bike(T0 + 25 * MIN, T0 + 51 * MIN, 4000)])
    // Another route from S with a walk: no biking, 1 min later.
    const s = onward('1:S', [
      walk(T0 + 24 * MIN, T0 + 26 * MIN, 150),
      bus('1:7', T0 + 27 * MIN, T0 + 51 * MIN, { stop: '1:S' })
    ])
    const results = [planned, q, r, s].map((o) => ({
      busArrivalEpoch: o.busArrivalEpoch,
      itineraries: [o.itin],
      realtime: true,
      stopId: o.stopId,
      stopName: o.stopId
    }))
    const input = {
      plannedOnward: {
        boardMs: T0 + 25 * MIN,
        boardStopId: P,
        routeId: '1:904',
        tripId: '1:ON'
      },
      plannedOnwardTripId: '1:ON',
      plannedStopId: P,
      results
    }
    it('Fastest is compareAlightOffer unchanged', () => {
      const v = compareAlightOffer(input)
      const a = rankAlightForPreset(input, 'fastest')
      expect(v.why).toBe('offer')
      expect(a.fastest).toEqual(v)
      expect(a.pick?.option.stopId).toBe('1:Q')
    })
    it('Stay on my route takes only the planned route from another stop', () => {
      expect(
        rankAlightForPreset(input, 'stayOnRoute').pick?.option.stopId
      ).toBe('1:Q')
      const withoutQ = {
        ...input,
        results: results.filter((x) => x !== results[1])
      }
      expect(rankAlightForPreset(withoutQ, 'stayOnRoute').pick).toBeNull()
    })
    it('Least biking takes the no-bike option; Simplest the no-vehicle one', () => {
      expect(rankAlightForPreset(input, 'leastBike').pick?.option.stopId).toBe(
        '1:S'
      )
      expect(rankAlightForPreset(input, 'simplest').pick?.option.stopId).toBe(
        '1:R'
      )
    })
    it('no baseline when the planned onward is missing', () => {
      const lost = { ...input, results: results.slice(1) }
      expect(rankAlightForPreset(lost, 'leastBike').why).toBe('no-baseline')
    })
  })
})
