import polyline from '@mapbox/polyline'

import {
  assessMatchTrust,
  legGeometryUsable
} from '../../../lib/util/go-mode/geometry-trust'
import { matchPositionToRoute } from '../../../lib/util/go-mode/position-matching'
import { repairLegGeometry } from '../../../lib/actions/go-mode'
import { sliceTripGeometryForLeg } from '../../../lib/util/go-mode/geometry'
import goMode from '../../../lib/reducers/go-mode'

const encode = (coords: [number, number][]) => polyline.encode(coords)

const leg = (over: any = {}) => ({
  legGeometry: { length: 2, points: encode(over.coords ?? []) },
  mode: 'WALK',
  transitLeg: false,
  ...over
})

// The 2026-08-27 shape, in miniature. Access walk south along -93.310, a bus
// leg whose geometry never arrived (the onboard flow synthesizes one with
// empty points while its trip fetch fails), and an egress walk further east.
const accessLeg = leg({
  coords: [
    [44.818, -93.31],
    [44.817, -93.31]
  ]
})
const blindBusLeg = leg({
  legGeometry: { length: 0, points: '' },
  mode: 'BUS',
  transitLeg: true
})
const egressLeg = leg({
  coords: [
    [44.817, -93.305],
    [44.816, -93.305]
  ]
})
const legs: any = [accessLeg, blindBusLeg, egressLeg]

describe('util > go-mode > geometry trust', () => {
  describe('legGeometryUsable', () => {
    it('needs at least two decoded points', () => {
      expect(legGeometryUsable(blindBusLeg as any)).toBe(false)
      expect(legGeometryUsable(accessLeg as any)).toBe(true)
      expect(legGeometryUsable(null)).toBe(false)
    })
  })

  describe('the 2026-08-27 blind match', () => {
    it('the raw matcher lands on the wrong leg — which is why trust exists', () => {
      // Rider aboard the bus, nowhere near either walk leg. The matcher skips
      // the empty bus geometry and pins them to the nearest remaining
      // polyline. This is the mechanism behind the pinned point, the bogus
      // "121m from route" push and the 16-point progress jump.
      const aboard: [number, number] = [44.8175, -93.308]
      const match = matchPositionToRoute(aboard, legs, 1)
      expect(match).not.toBeNull()
      expect(match!.legIndex).not.toBe(1)
    })

    it('flags a match that had to see through the blind transit leg', () => {
      const trust = assessMatchTrust(legs, 1, 2)
      expect(trust.provisional).toBe(true)
      expect(trust.reason).toBe('unsettled-geometry')
      expect(trust.unsettledLegIndexes).toEqual([1])
    })

    it('trusts the same window once every transit leg has geometry', () => {
      const healedLegs: any = [
        accessLeg,
        leg({
          coords: [
            [44.818, -93.309],
            [44.817, -93.306]
          ],
          mode: 'BUS',
          transitLeg: true
        }),
        egressLeg
      ]
      expect(assessMatchTrust(healedLegs, 1, 2).provisional).toBe(false)
    })

    it('ignores a blind leg behind the match window', () => {
      // The rider is past the degenerate leg; nothing in [2, 2] is blind.
      expect(assessMatchTrust(legs, 2, 2).provisional).toBe(false)
    })

    it('exempts walk and bike legs — a zero-length transfer walk is normal', () => {
      const withEmptyWalk: any = [
        accessLeg,
        leg({ legGeometry: { length: 0, points: '' } }),
        egressLeg
      ]
      expect(assessMatchTrust(withEmptyWalk, 0, 2).provisional).toBe(false)
    })
  })

  describe('sliceTripGeometryForLeg', () => {
    // A trip shape running well past both stops; the leg rides the middle.
    const shape: [number, number][] = [
      [44.83, -93.31],
      [44.82, -93.31],
      [44.81, -93.31],
      [44.8, -93.31],
      [44.79, -93.31]
    ]
    const busLeg: any = {
      from: { lat: 44.82, lon: -93.31 },
      to: { lat: 44.8, lon: -93.31 }
    }

    it('slices the shape between the board and alight stops', () => {
      const repaired = sliceTripGeometryForLeg(encode(shape), busLeg)
      expect(repaired).not.toBeNull()
      expect(repaired!.length).toBe(3)
      expect(polyline.decode(repaired!.points)).toEqual([
        [44.82, -93.31],
        [44.81, -93.31],
        [44.8, -93.31]
      ])
    })

    it('returns null rather than degrade: degenerate shape or missing stops', () => {
      expect(sliceTripGeometryForLeg('', busLeg)).toBeNull()
      expect(
        sliceTripGeometryForLeg(encode(shape), { from: {}, to: {} } as any)
      ).toBeNull()
    })
  })

  describe('REPAIR_LEG_GEOMETRY reducer', () => {
    const initial = goMode(undefined, { type: '@@INIT' })
    const withItinerary: any = {
      ...initial,
      activeItinerary: { duration: 1, legs }
    }

    it('swaps only the repaired leg geometry and keeps other legs intact', () => {
      const repaired = {
        length: 2,
        points: encode([
          [44.818, -93.309],
          [44.817, -93.306]
        ])
      }
      const next: any = goMode(
        withItinerary,
        repairLegGeometry({ legGeometry: repaired, legIndex: 1 })
      )
      expect(next.activeItinerary.legs[1].legGeometry).toEqual(repaired)
      expect(next.activeItinerary.legs[1].mode).toBe('BUS')
      // Untouched legs keep their object identity.
      expect(next.activeItinerary.legs[0]).toBe(legs[0])
      expect(next.activeItinerary.legs[2]).toBe(legs[2])
      expect(next.activeItinerary.duration).toBe(1)
    })

    it('is a no-op without a matching leg', () => {
      const next = goMode(
        initial,
        repairLegGeometry({
          legGeometry: { length: 2, points: 'xx' },
          legIndex: 4
        })
      )
      expect(next).toBe(initial)
    })
  })
})
