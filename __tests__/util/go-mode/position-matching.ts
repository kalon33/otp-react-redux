import {
  calculateCumulativeDistances,
  calculateDistance,
  decodeLegGeometry,
  isNearLegEnd,
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

  describe('isNearLegEnd', () => {
    it('should return true when progress >= threshold', () => {
      const match = {
        distanceFromRoute: 10,
        isOnRoute: true,
        legIndex: 0,
        nearestPoint: [44.98, -93.27] as [number, number],
        progressAlongLeg: 0.96,
        progressAlongSegment: 0.5,
        segmentIndex: 0
      }
      expect(isNearLegEnd(match)).toBe(true)
    })

    it('should return false when progress < threshold', () => {
      const match = {
        distanceFromRoute: 10,
        isOnRoute: true,
        legIndex: 0,
        nearestPoint: [44.98, -93.27] as [number, number],
        progressAlongLeg: 0.5,
        progressAlongSegment: 0.5,
        segmentIndex: 0
      }
      expect(isNearLegEnd(match)).toBe(false)
    })

    it('should respect custom threshold', () => {
      const match = {
        distanceFromRoute: 10,
        isOnRoute: true,
        legIndex: 0,
        nearestPoint: [44.98, -93.27] as [number, number],
        progressAlongLeg: 0.85,
        progressAlongSegment: 0.5,
        segmentIndex: 0
      }
      expect(isNearLegEnd(match, 0.8)).toBe(true)
      expect(isNearLegEnd(match, 0.9)).toBe(false)
    })
  })

  describe('shouldTransitionToNextLeg', () => {
    const legs = [{ mode: 'WALK' }, { mode: 'BUS' }, { mode: 'WALK' }] as any[]

    it('should return true when match is on a later leg', () => {
      const match = {
        distanceFromRoute: 10,
        isOnRoute: true,
        legIndex: 1,
        nearestPoint: [44.98, -93.27] as [number, number],
        progressAlongLeg: 0.5,
        progressAlongSegment: 0.5,
        segmentIndex: 0
      }
      expect(shouldTransitionToNextLeg(match, 0, legs)).toBe(true)
    })

    it('should return true when very close to end of current leg and next leg exists', () => {
      const match = {
        distanceFromRoute: 10,
        isOnRoute: true,
        legIndex: 0,
        nearestPoint: [44.98, -93.27] as [number, number],
        progressAlongLeg: 0.99,
        progressAlongSegment: 0.5,
        segmentIndex: 0
      }
      expect(shouldTransitionToNextLeg(match, 0, legs)).toBe(true)
    })

    it('should return false when on current leg and not near end', () => {
      const match = {
        distanceFromRoute: 10,
        isOnRoute: true,
        legIndex: 0,
        nearestPoint: [44.98, -93.27] as [number, number],
        progressAlongLeg: 0.5,
        progressAlongSegment: 0.5,
        segmentIndex: 0
      }
      expect(shouldTransitionToNextLeg(match, 0, legs)).toBe(false)
    })

    it('should return false when on last leg even if near end', () => {
      const match = {
        distanceFromRoute: 10,
        isOnRoute: true,
        legIndex: 2,
        nearestPoint: [44.98, -93.27] as [number, number],
        progressAlongLeg: 0.99,
        progressAlongSegment: 0.5,
        segmentIndex: 0
      }
      expect(shouldTransitionToNextLeg(match, 2, legs)).toBe(false)
    })
  })
})
