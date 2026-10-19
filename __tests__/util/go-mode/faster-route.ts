/* globals describe, expect, it */
import {
  arrivalAtBikeSpeed,
  bikeMetersOf,
  bikeSpeedOf,
  classifyFasterRoute,
  compareAlightOffer,
  EMPTY_FASTER_ROUTE_LATCH,
  findBaseline,
  latchAllows,
  latchRecordOffer,
  remainingTransitLegs,
  routeSetOf
} from '../../../lib/util/go-mode/faster-route'

/**
 * Backlog 56.1 (cycle 25 B1): the pure faster-route decision. The fixture
 * measurement lives in faster-route-fixtures.ts; these pin the rules.
 */

const T0 = Date.UTC(2026, 9, 17, 21, 30, 0) // 16:30 CDT
const MIN = 60000
const HERE: [number, number] = [44.8227, -93.3013]

let tripSeq = 0
function bike(start: number, end: number, distance: number, from = HERE): any {
  return {
    distance,
    duration: (end - start) / 1000,
    endTime: end,
    from: { lat: from[0], lon: from[1], name: 'Current location' },
    mode: 'BICYCLE',
    startTime: start,
    to: { lat: 44.83, lon: -93.29, name: 'x' },
    transitLeg: false
  }
}
function bus(
  route: string,
  start: number,
  end: number,
  { stop = '1:56831', trip = `1:${++tripSeq}`, toStop = '1:56800' } = {}
): any {
  return {
    distance: 10000,
    duration: (end - start) / 1000,
    endTime: end,
    from: { lat: 44.8255, lon: -93.2909, name: 'Stop', stop: { gtfsId: stop } },
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

// The rider's plan: bike 10 min to the Orange Line (trip 1:OWN at 16:45),
// ride to 17:10, bike 2 km home by 17:20.
const own = (offsetMs = 0, closingBikeM = 2000) =>
  itin([
    bike(T0, T0 + 12 * MIN, 2500),
    bus('1:904', T0 + 15 * MIN, T0 + 40 * MIN, { trip: '1:OWN' }),
    bike(T0 + 40 * MIN, T0 + 50 * MIN + offsetMs, closingBikeM)
  ])
const held = own()
const other = (route: string, arriveMs: number, bikeM = 2500, extra = {}) =>
  itin([
    bike(T0, T0 + 8 * MIN, bikeM),
    bus(route, T0 + 10 * MIN, arriveMs, extra)
  ])
const base = { current: held, nowMs: T0, position: HERE }

describe('util > go-mode > faster-route', () => {
  describe('helpers', () => {
    it('route set: sorted transit routes, bike-only is the empty set', () => {
      expect(routeSetOf(other('1:5', T0 + 30 * MIN))).toBe('1:5')
      expect(
        routeSetOf(
          itin([
            bus('1:904', T0, T0 + MIN),
            bus('1:539', T0 + MIN, T0 + 2 * MIN)
          ])
        )
      ).toBe('1:539+1:904')
      expect(routeSetOf(itin([bike(T0, T0 + MIN, 300)]))).toBe('')
    })
    it('bike metres, pace and re-timed arrival', () => {
      const it0 = own()
      expect(bikeMetersOf(it0)).toBe(4500)
      expect(bikeSpeedOf(it0)).toBeCloseTo(4500 / (22 * 60), 3)
      // Closing 2000 m at 4 m/s = 500 s instead of 600 s: 100 s earlier.
      expect(arrivalAtBikeSpeed(it0, 4)).toBe(it0.endTime - 100000)
      // Street-only: re-timed whole from its start.
      expect(arrivalAtBikeSpeed(itin([bike(T0, T0 + 10 * MIN, 3000)]), 5)).toBe(
        T0 + 600000
      )
    })
    it('remaining transit legs by index or by time', () => {
      expect(remainingTransitLegs(held, T0).length).toBe(1)
      expect(remainingTransitLegs(held, T0 + 41 * MIN).length).toBe(0)
      expect(remainingTransitLegs(held, T0 + 41 * MIN, 1).length).toBe(1)
    })
  })

  describe('baseline comes from the same answer', () => {
    it('own trips first, then the own next trip, else none', () => {
      const rem = remainingTransitLegs(held, T0)
      const mine = own(2 * MIN)
      expect(findBaseline([other('1:5', T0), mine], rem)?.source).toBe(
        'own-trips'
      )
      const nextOnly = itin([
        bike(T0, T0 + 12 * MIN, 2500),
        bus('1:904', T0 + 15 * MIN, T0 + 40 * MIN, { trip: '1:OWN' }),
        bus('1:539', T0 + 42 * MIN, T0 + 48 * MIN)
      ])
      const two = itin([
        bike(T0, T0 + 12 * MIN, 2500),
        bus('1:904', T0 + 15 * MIN, T0 + 40 * MIN, { trip: '1:OWN' }),
        bus('1:539', T0 + 42 * MIN, T0 + 48 * MIN, { trip: '1:ONWARD' })
      ])
      const remTwo = remainingTransitLegs(two, T0)
      expect(findBaseline([nextOnly], remTwo)?.source).toBe('own-next-trip')
      expect(findBaseline([other('1:5', T0)], rem)).toBeNull()
    })
    it('never compares against the held plan’s own endTime', () => {
      // The answer times the rider's own bus 6 min later than the card did
      // (observed pace); a route arriving 4 min before the CARD is not faster.
      const v = classifyFasterRoute({
        ...base,
        answer: [own(6 * MIN), other('1:5', held.endTime - 4 * MIN)]
      })
      expect(v.why).toBe('offer') // 10 min before the SAME-answer own trip
      const none = classifyFasterRoute({
        ...base,
        answer: [other('1:5', held.endTime - 4 * MIN)]
      })
      expect(none.why).toBe('no-baseline')
    })
  })

  describe('classifyFasterRoute', () => {
    it('faster: a different route ≥ 3 min earlier', () => {
      const v = classifyFasterRoute({
        ...base,
        answer: [own(), other('1:5', held.endTime - 3 * MIN)]
      })
      expect(v.kind).toBe('faster')
      expect(v.savingMs).toBe(3 * MIN)
      expect(v.routeSet).toBe('1:5')
      expect(v.baselineSource).toBe('own-trips')
    })
    it('2m59s is not an offer', () => {
      const v = classifyFasterRoute({
        ...base,
        answer: [own(), other('1:5', held.endTime - 3 * MIN + 1000)]
      })
      expect(v.kind).toBeNull()
      expect(v.why).toBe('not-better')
    })
    it('bike all the way counts as a different route (rider Q5)', () => {
      const v = classifyFasterRoute({
        ...base,
        answer: [own(), itin([bike(T0, held.endTime - 5 * MIN, 12000)])]
      })
      expect(v.kind).toBe('faster')
      expect(v.routeSet).toBe('')
    })
    it('less bike: within ±2 min with ≥ 1 km less biking', () => {
      const less = other('1:5', held.endTime + 2 * MIN, 3500)
      const v = classifyFasterRoute({ ...base, answer: [own(), less] })
      expect(v.kind).toBe('lessBike')
      expect(v.bikeSavedM).toBe(1000)
      expect(v.savingMs).toBe(-2 * MIN)
      const late = other('1:5', held.endTime + 2 * MIN + 1000, 1000)
      expect(classifyFasterRoute({ ...base, answer: [own(), late] }).kind).toBe(
        null
      )
      const notEnough = other('1:5', held.endTime, 3501)
      expect(
        classifyFasterRoute({ ...base, answer: [own(), notEnough] }).kind
      ).toBe(null)
    })
    it('faster wins when both apply', () => {
      const v = classifyFasterRoute({
        ...base,
        answer: [
          own(),
          other('1:5', held.endTime, 500),
          other('1:7', held.endTime - 4 * MIN, 4000)
        ]
      })
      expect(v.kind).toBe('faster')
      expect(v.routeSet).toBe('1:7')
    })
    it('the rider’s own route is never offered; its earlier run raises the bar', () => {
      const earlierOwnRoute = other('1:904', held.endTime - 10 * MIN)
      const v = classifyFasterRoute({
        ...base,
        answer: [own(), earlierOwnRoute, other('1:5', held.endTime - 8 * MIN)]
      })
      // 465 vs "your Orange Line, sooner": only 2 min better — no offer.
      expect(v.kind).toBeNull()
      expect(v.baselineSource).toBe('own-route-earlier-run')
      const beats = classifyFasterRoute({
        ...base,
        answer: [own(), earlierOwnRoute, other('1:5', held.endTime - 14 * MIN)]
      })
      expect(beats.kind).toBe('faster')
      expect(beats.savingMs).toBe(4 * MIN)
    })
    it('own bus with a different tail is the aboard offer’s job; a feeder is not', () => {
      const tail = itin([
        bike(T0, T0 + 12 * MIN, 2500),
        bus('1:904', T0 + 15 * MIN, T0 + 40 * MIN, { trip: '1:OWN' }),
        bus('1:546', T0 + 41 * MIN, T0 + 44 * MIN)
      ])
      const v = classifyFasterRoute({ ...base, answer: [own(), tail] })
      expect(v.why).toBe('same-bus')
      const feeder = itin([
        bike(T0, T0 + 2 * MIN, 300),
        bus('1:539', T0 + 3 * MIN, T0 + 12 * MIN),
        bus('1:904', T0 + 15 * MIN, T0 + 40 * MIN, { trip: '1:OWN' }),
        bike(T0 + 40 * MIN, T0 + 51 * MIN, 2000)
      ])
      const f = classifyFasterRoute({ ...base, answer: [own(), feeder] })
      expect(f.kind).toBe('lessBike')
      expect(f.bikeSavedM).toBe(2200)
    })
    it('a saving that only exists at the observed pace is no offer', () => {
      // The answer rides the closing 2 km at 2 m/s (16.7 min); at the plan's
      // 4 m/s it is 8.3 min, and the 5-min "saving" disappears.
      const slow = own(6.7 * MIN)
      const v = classifyFasterRoute({
        ...base,
        answer: [slow, other('1:5', slow.endTime - 5 * MIN)],
        referenceBikeSpeedMps: 4
      })
      expect(v.kind).toBeNull()
      expect(v.bestRawSavingMs).toBe(5 * MIN)
      const without = classifyFasterRoute({
        ...base,
        answer: [slow, other('1:5', slow.endTime - 5 * MIN)]
      })
      expect(without.kind).toBe('faster')
    })
    it('not catchable: the candidate starts where the rider is not', () => {
      const away = itin([
        bike(T0, T0 + 8 * MIN, 2500, [44.8247, -93.3013]), // ~220 m north
        bus('1:5', T0 + 10 * MIN, held.endTime - 6 * MIN)
      ])
      const v = classifyFasterRoute({ ...base, answer: [own(), away] })
      expect(v.why).toBe('not-catchable')
      expect(v.rejected).toEqual(['origin-behind-rider'])
    })
    it('not catchable: its access reaches the board after the bus leaves', () => {
      const late = itin([
        bike(T0, T0 + 11 * MIN, 2500),
        bus('1:5', T0 + 10 * MIN, held.endTime - 6 * MIN)
      ])
      const v = classifyFasterRoute({ ...base, answer: [own(), late] })
      expect(v.why).toBe('not-catchable')
      expect(v.rejected).toEqual(['access-misses-board'])
    })
    describe('plan-dead suppression', () => {
      const answer = [own(), other('1:5', held.endTime - 10 * MIN)]
      it('missed-bus recovery running', () => {
        const v = classifyFasterRoute({
          ...base,
          answer,
          missedBusRecoveryActive: true
        })
        expect(v.why).toBe('plan-dead')
        expect(v.planDead).toBe('missed-bus-recovery')
      })
      it('the planned board time (live when the card has one) has passed', () => {
        const v = classifyFasterRoute({
          ...base,
          answer,
          liveBoardEpochMs: T0 - 2 * MIN,
          liveBoardTripId: '1:OWN'
        })
        expect(v.planDead).toBe('board-time-passed')
      })
      it('the answer reaches the rider’s bus only further down the line', () => {
        const chase = itin([
          bike(T0, T0 + 20 * MIN, 6000),
          bus('1:904', T0 + 20 * MIN, T0 + 40 * MIN, {
            stop: '1:56828',
            trip: '1:OWN'
          }),
          bike(T0 + 40 * MIN, T0 + 50 * MIN, 2000)
        ])
        const v = classifyFasterRoute({
          ...base,
          answer: [chase, other('1:5', held.endTime - 10 * MIN)]
        })
        expect(v.planDead).toBe('board-stop-unreachable')
        expect(v.kind).toBeNull()
      })
    })
    it('no question to put: aboard, or no transit left', () => {
      expect(
        classifyFasterRoute({ ...base, answer: [own()], riding: true }).why
      ).toBe('aboard')
      expect(
        classifyFasterRoute({ ...base, answer: [own()], nowMs: T0 + 45 * MIN })
          .why
      ).toBe('no-transit-left')
    })
  })

  describe('compareAlightOffer (aboard, read-only over the optimizer)', () => {
    const BUS_AT = T0 + 20 * MIN
    const onward = (
      route: string,
      arrive: number,
      bikeM = 1500,
      trip?: string
    ) =>
      itin([
        bike(BUS_AT, BUS_AT + 2 * MIN, 200),
        bus(route, BUS_AT + 3 * MIN, arrive - 5 * MIN, trip ? { trip } : {}),
        bike(arrive - 5 * MIN, arrive, bikeM)
      ])
    const result = (stopId: string, itineraries: any[], at = BUS_AT) => ({
      busArrivalEpoch: at,
      itineraries,
      realtime: true,
      stopId,
      stopName: stopId
    })
    it('baseline = planned stop + planned onward trip; candidate = top', () => {
      const v = compareAlightOffer({
        nowMs: T0,
        plannedOnwardTripId: '1:PLANNED',
        plannedStopId: 'A',
        results: [
          result('A', [onward('1:539', T0 + 60 * MIN, 1500, '1:PLANNED')]),
          result('B', [onward('1:7', T0 + 52 * MIN)])
        ]
      })
      expect(v.why).toBe('offer')
      expect(v.kind).toBe('faster')
      expect(v.savingMs).toBe(8 * MIN)
      expect(v.candidate?.stopId).toBe('B')
    })
    it('no offer when the top is the plan itself, or no better', () => {
      const same = compareAlightOffer({
        plannedOnwardTripId: '1:PLANNED',
        plannedStopId: 'A',
        results: [
          result('A', [onward('1:539', T0 + 50 * MIN, 1500, '1:PLANNED')]),
          result('B', [onward('1:7', T0 + 55 * MIN)])
        ]
      })
      expect(same.why).toBe('same-as-plan')
      const close = compareAlightOffer({
        plannedOnwardTripId: '1:PLANNED',
        plannedStopId: 'A',
        results: [
          result('A', [onward('1:539', T0 + 50 * MIN, 1500, '1:PLANNED')]),
          result('B', [onward('1:7', T0 + 48 * MIN, 1500)])
        ]
      })
      expect(close.why).toBe('not-better')
    })
    it('less bike at the same arrival; street onward plans work too', () => {
      const v = compareAlightOffer({
        plannedOnwardTripId: null,
        plannedStopId: 'A',
        results: [
          result('A', [itin([bike(BUS_AT, T0 + 50 * MIN, 3000)])]),
          result('B', [onward('1:539', T0 + 50 * MIN + MIN, 500)])
        ]
      })
      expect(v.kind).toBe('lessBike')
      expect(v.bikeSavedM).toBe(2300)
    })
    it('no baseline when the planned connection is not in the answer', () => {
      const v = compareAlightOffer({
        plannedOnwardTripId: '1:PLANNED',
        plannedStopId: 'A',
        results: [result('B', [onward('1:7', T0 + 40 * MIN)])]
      })
      expect(v.why).toBe('no-baseline')
    })
  })

  describe('latch', () => {
    const offer = (routeSet: string, savingMs = 4 * MIN, bikeSavedM = 0) => ({
      bikeSavedM,
      kind: 'faster' as const,
      routeSet,
      savingMs
    })
    it('first offer passes, with a push still allowed', () => {
      expect(latchAllows(EMPTY_FASTER_ROUTE_LATCH, offer('1:5'))).toEqual({
        allow: true,
        push: true,
        why: 'ok'
      })
    })
    it('a route set already offered never comes back', () => {
      const l = latchRecordOffer(EMPTY_FASTER_ROUTE_LATCH, offer('1:5'))
      expect(latchAllows(l, offer('1:5', 30 * MIN)).why).toBe('same-route-set')
    })
    it('Keep holds until +3 min or +1 km', () => {
      const l = latchRecordOffer(
        EMPTY_FASTER_ROUTE_LATCH,
        offer('1:5', 4 * MIN, 500)
      )
      expect(latchAllows(l, offer('1:7', 6 * MIN, 1000)).why).toBe(
        'held-by-keep'
      )
      expect(latchAllows(l, offer('1:7', 7 * MIN)).allow).toBe(true)
      expect(latchAllows(l, offer('1:7', 4 * MIN, 1500)).allow).toBe(true)
    })
    it('at most 3 offers and 2 pushes a ride', () => {
      let l = latchRecordOffer(EMPTY_FASTER_ROUTE_LATCH, offer('a', MIN), true)
      l = latchRecordOffer(l, offer('b', 5 * MIN), true)
      expect(latchAllows(l, offer('c', 9 * MIN))).toEqual({
        allow: true,
        push: false,
        why: 'ok'
      })
      l = latchRecordOffer(l, offer('c', 9 * MIN))
      expect(latchAllows(l, offer('d', 60 * MIN)).why).toBe('offer-cap')
    })
  })
})
