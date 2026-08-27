import {
  calculateCumulativeDistances,
  calculateDistance,
  decodeLegGeometry,
  matchPositionToRoute,
  shouldTransitionToNextLeg
} from '../../../lib/util/go-mode/position-matching'

describe('util > go-mode > position-matching', () => {
  describe('calculateDistance', () => {
    it('should return 0 for identical points', () => {
      expect(calculateDistance(44.98, -93.27, 44.98, -93.27)).toBe(0)
    })

    it('should calculate distance between two known points', () => {
      // Minneapolis City Hall to US Bank Stadium (~0.6 km)
      const distance = calculateDistance(44.9773, -93.2655, 44.9738, -93.2575)
      expect(distance).toBeGreaterThan(500)
      expect(distance).toBeLessThan(900)
    })

    it('should be symmetric', () => {
      const d1 = calculateDistance(44.98, -93.27, 45.0, -93.0)
      const d2 = calculateDistance(45.0, -93.0, 44.98, -93.27)
      expect(d1).toBeCloseTo(d2, 5)
    })

    it('should calculate a known long distance roughly correctly', () => {
      // Minneapolis to St Paul (~15 km)
      const distance = calculateDistance(44.9778, -93.265, 44.9537, -93.09)
      expect(distance).toBeGreaterThan(13000)
      expect(distance).toBeLessThan(17000)
    })
  })

  describe('decodeLegGeometry', () => {
    it('should return empty array for leg without geometry', () => {
      const leg = { mode: 'WALK' } as any
      expect(decodeLegGeometry(leg)).toEqual([])
    })

    it('should return empty array for leg with null points', () => {
      const leg = { legGeometry: { points: null }, mode: 'WALK' } as any
      expect(decodeLegGeometry(leg)).toEqual([])
    })

    it('should decode a valid encoded polyline', () => {
      // Encoded polyline for a simple path
      const leg = {
        legGeometry: { points: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
        mode: 'WALK'
      } as any
      const result = decodeLegGeometry(leg)
      expect(result.length).toBeGreaterThan(0)
      expect(result[0]).toHaveLength(2)
    })
  })

  describe('calculateCumulativeDistances', () => {
    it('should return [0] for single point', () => {
      const result = calculateCumulativeDistances([[44.98, -93.27]])
      expect(result).toEqual([0])
    })

    it('should start with 0 and increase monotonically', () => {
      const polyline: [number, number][] = [
        [44.97, -93.27],
        [44.98, -93.27],
        [44.99, -93.27]
      ]
      const result = calculateCumulativeDistances(polyline)
      expect(result[0]).toBe(0)
      expect(result[1]).toBeGreaterThan(0)
      expect(result[2]).toBeGreaterThan(result[1])
    })

    it('should have same length as input polyline', () => {
      const polyline: [number, number][] = [
        [44.97, -93.27],
        [44.98, -93.27],
        [44.99, -93.27],
        [45.0, -93.27]
      ]
      const result = calculateCumulativeDistances(polyline)
      expect(result).toHaveLength(4)
    })
  })

  describe('matchPositionToRoute', () => {
    // Encoded polyline decodes to approx [38.5,-120.2], [40.7,-120.95], [43.252,-126.453]
    const testPolyline = '_p~iF~ps|U_ulLnnqC_mqNvxq`@'

    it('should return null for legs with no geometry', () => {
      const legs = [{ mode: 'WALK' }]
      const result = matchPositionToRoute([44.98, -93.27], legs as never[])
      expect(result).toBeNull()
    })

    it('should return null for legs with empty polylines', () => {
      const legs = [{ legGeometry: { points: '' }, mode: 'WALK' }]
      const result = matchPositionToRoute([44.98, -93.27], legs as never[])
      expect(result).toBeNull()
    })

    it('should match position to a route with valid geometry', () => {
      const legs = [
        {
          legGeometry: { points: testPolyline },
          mode: 'WALK'
        }
      ]
      const result = matchPositionToRoute(
        [38.5, -120.2] as [number, number],
        legs as never[]
      )
      expect(result).not.toBeNull()
      expect(result!.legIndex).toBe(0)
      expect(result!.distanceFromRoute).toBeDefined()
      expect(result!.progressAlongLeg).toBeGreaterThanOrEqual(0)
      expect(result!.progressAlongLeg).toBeLessThanOrEqual(1)
    })

    it('should set isOnRoute true when close to route', () => {
      const legs = [
        {
          legGeometry: { points: testPolyline },
          mode: 'WALK'
        }
      ]
      // Position exactly on the first point of the decoded polyline
      const result = matchPositionToRoute(
        [38.5, -120.2] as [number, number],
        legs as never[]
      )
      expect(result).not.toBeNull()
      expect(result!.isOnRoute).toBe(true)
      expect(result!.distanceFromRoute).toBeLessThan(100)
    })

    it('should set isOnRoute false when far from route', () => {
      const legs = [
        {
          legGeometry: { points: testPolyline },
          mode: 'WALK'
        }
      ]
      // Position very far from the route
      const result = matchPositionToRoute(
        [50.0, -100.0] as [number, number],
        legs as never[]
      )
      expect(result).not.toBeNull()
      expect(result!.isOnRoute).toBe(false)
    })

    it('should only search current leg and next 2 legs', () => {
      const makeLegWithGeom = () => ({
        legGeometry: { points: testPolyline },
        mode: 'WALK'
      })

      const legs = [
        makeLegWithGeom(),
        makeLegWithGeom(),
        makeLegWithGeom(),
        makeLegWithGeom(),
        makeLegWithGeom()
      ]

      // Starting from leg 2, should search legs 2, 3, 4
      const result = matchPositionToRoute(
        [38.5, -120.2] as [number, number],
        legs as never[],
        2
      )
      expect(result).not.toBeNull()
      expect(result!.legIndex).toBeGreaterThanOrEqual(2)
      expect(result!.legIndex).toBeLessThanOrEqual(4)
    })
  })

  describe('shouldTransitionToNextLeg', () => {
    const matchOn = (legIndex: number, progressAlongLeg: number) => ({
      distanceFromRoute: 10,
      isOnRoute: true,
      legIndex,
      nearestPoint: [44.98, -93.27] as [number, number],
      progressAlongLeg,
      progressAlongSegment: 0.5,
      segmentIndex: 0
    })

    it('should return true when match is on a later leg', () => {
      expect(shouldTransitionToNextLeg(matchOn(1, 0.5), 0)).toBe(true)
    })

    it('should return false when on current leg and not near end', () => {
      expect(shouldTransitionToNextLeg(matchOn(0, 0.5), 0)).toBe(false)
    })

    // Waiting at the boarding stop pins the match to the end of the access leg
    // for the whole wait. That is not evidence of boarding, and advancing on it
    // would put a rider standing on the curb onto the bus — irreversibly, since
    // matching only ever searches forward.
    it('should return false when parked at the end of the current leg', () => {
      expect(shouldTransitionToNextLeg(matchOn(0, 1), 0)).toBe(false)
    })

    it('should return false when on the last leg', () => {
      expect(shouldTransitionToNextLeg(matchOn(2, 0.99), 2)).toBe(false)
    })

    describe('the transit board-time gate', () => {
      const NOW = new Date('2026-08-27T18:19:43Z').getTime()
      const busLeg = (startTime: number) =>
        ({
          mode: 'BUS',
          routeShortName: '465',
          startTime,
          to: { name: '2 Av S at 6 St S NE corner' },
          transitLeg: true
        } as any)
      const walkLeg = {
        mode: 'WALK',
        to: { name: 'I-35W & 98th Street Station Gate E' }
      } as any

      // 2026-08-27: Go Mode started on a trip whose 465 boarded at 20:17Z. The
      // rider was standing at the boarding stop, which is the shared endpoint
      // of the access and transit legs, so the matcher returned leg 1 — and
      // 82ms after START_GO_MODE the trip advanced onto a bus two hours out.
      it('should not board a transit leg that is hours away', () => {
        const board = new Date('2026-08-27T20:17:00Z').getTime()
        expect(
          shouldTransitionToNextLeg(matchOn(1, 0.01), 0, {
            nowMs: NOW,
            targetLeg: busLeg(board)
          })
        ).toBe(false)
      })

      it('should board once the departure is at hand', () => {
        const board = NOW + 4 * 60 * 1000
        expect(
          shouldTransitionToNextLeg(matchOn(1, 0.01), 0, {
            nowMs: NOW,
            targetLeg: busLeg(board)
          })
        ).toBe(true)
      })

      it('should let the riding state override the clock', () => {
        // A rider who caught an earlier run is aboard whatever the plan says.
        const board = new Date('2026-08-27T20:17:00Z').getTime()
        expect(
          shouldTransitionToNextLeg(matchOn(1, 0.01), 0, {
            isRiding: true,
            nowMs: NOW,
            targetLeg: busLeg(board)
          })
        ).toBe(true)
      })

      it('should prefer the live board time over the plan', () => {
        // Plan says now; the feed says the bus is an hour late. Don't advance.
        expect(
          shouldTransitionToNextLeg(matchOn(1, 0.01), 0, {
            boardEpoch: NOW + 60 * 60 * 1000,
            nowMs: NOW,
            targetLeg: busLeg(NOW)
          })
        ).toBe(false)
      })

      it('should never gate a walking leg on a board time', () => {
        expect(
          shouldTransitionToNextLeg(matchOn(1, 0.01), 0, {
            nowMs: NOW,
            targetLeg: walkLeg
          })
        ).toBe(true)
      })

      it('should keep index-order behaviour when the caller supplies no gate', () => {
        const board = new Date('2026-08-27T20:17:00Z').getTime()
        expect(shouldTransitionToNextLeg(matchOn(1, 0.01), 0)).toBe(true)
        expect(
          shouldTransitionToNextLeg(matchOn(1, 0.01), 0, {
            targetLeg: busLeg(board)
          })
        ).toBe(true)
      })

      it('should advance when the leg has no usable start time', () => {
        expect(
          shouldTransitionToNextLeg(matchOn(1, 0.01), 0, {
            nowMs: NOW,
            targetLeg: {
              mode: 'BUS',
              to: { name: 'x' },
              transitLeg: true
            } as any
          })
        ).toBe(true)
      })
    })
  })
})
