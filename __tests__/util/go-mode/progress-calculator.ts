import {
  calculateExpectedProgress,
  calculateOverallProgress,
  calculateTimeRemaining,
  calculateTripProgress,
  determineTripStatus,
  estimateArrival,
  getTransitProgress,
  getWalkingInstruction,
  shouldAlertForApproachingStop,
  shouldAlertForBoarding
} from '../../../lib/util/go-mode/progress-calculator'

const makeLegs = (distances: number[], durations: number[], modes?: string[]) =>
  distances.map((d, i) => ({
    distance: d,
    duration: durations[i],
    from: { name: `Point ${i}` },
    intermediateStops: [],
    mode: modes?.[i] || 'WALK',
    to: { name: `Point ${i + 1}` }
  })) as any[]

const makeItinerary = (legs: any[], startTime: string, endTime: string) =>
  ({
    endTime,
    legs,
    startTime
  } as any)

describe('util > go-mode > progress-calculator', () => {
  describe('calculateOverallProgress', () => {
    it('should return 0 for empty legs', () => {
      expect(calculateOverallProgress(0, 0, [])).toBe(0)
    })

    it('should return 0 at the start', () => {
      const legs = makeLegs([1000, 2000], [300, 600])
      expect(calculateOverallProgress(0, 0, legs)).toBe(0)
    })

    it('should return 100 at the end', () => {
      const legs = makeLegs([1000, 2000], [300, 600])
      // On last leg (index 1) with 100% progress
      expect(calculateOverallProgress(2, 0, legs)).toBeCloseTo(100)
    })

    it('should return ~33% when first of three equal legs is complete', () => {
      const legs = makeLegs([1000, 1000, 1000], [300, 300, 300])
      expect(calculateOverallProgress(1, 0, legs)).toBeCloseTo(33.33, 0)
    })

    it('should account for progress within current leg', () => {
      const legs = makeLegs([1000, 1000], [300, 300])
      // Halfway through first leg = 25% overall
      expect(calculateOverallProgress(0, 0.5, legs)).toBeCloseTo(25)
    })

    it('should handle legs with zero distance', () => {
      const legs = makeLegs([0, 0], [300, 300])
      expect(calculateOverallProgress(0, 0.5, legs)).toBe(0)
    })
  })

  describe('calculateTimeRemaining', () => {
    it('should return total duration at the start', () => {
      const legs = makeLegs([1000, 2000], [300, 600])
      const itinerary = makeItinerary(
        legs,
        '2026-01-28T10:00:00',
        '2026-01-28T10:15:00'
      )
      const result = calculateTimeRemaining(
        new Date('2026-01-28T10:00:00'),
        itinerary,
        0,
        0
      )
      expect(result).toBe(900) // 15 minutes = 900 seconds
    })

    it('should return 0 at the end', () => {
      const legs = makeLegs([1000, 2000], [300, 600])
      const itinerary = makeItinerary(
        legs,
        '2026-01-28T10:00:00',
        '2026-01-28T10:15:00'
      )
      const result = calculateTimeRemaining(
        new Date('2026-01-28T10:15:00'),
        itinerary,
        2,
        0
      )
      expect(result).toBe(0)
    })

    it('should return half remaining at midpoint', () => {
      const legs = makeLegs([1000, 1000], [300, 300])
      const itinerary = makeItinerary(
        legs,
        '2026-01-28T10:00:00',
        '2026-01-28T10:10:00'
      )
      // At start of second leg
      const result = calculateTimeRemaining(
        new Date('2026-01-28T10:05:00'),
        itinerary,
        1,
        0
      )
      expect(result).toBe(300) // 5 minutes remaining
    })

    it('should never return negative values', () => {
      const legs = makeLegs([1000], [300])
      const itinerary = makeItinerary(
        legs,
        '2026-01-28T10:00:00',
        '2026-01-28T10:05:00'
      )
      const result = calculateTimeRemaining(
        new Date('2026-01-28T10:10:00'),
        itinerary,
        1,
        0
      )
      expect(result).toBeGreaterThanOrEqual(0)
    })
  })

  describe('estimateArrival', () => {
    it('should add time remaining to current time', () => {
      const now = new Date('2026-01-28T10:00:00')
      const result = estimateArrival(now, 600) // 10 minutes
      expect(result.getTime()).toBe(new Date('2026-01-28T10:10:00').getTime())
    })

    it('should return current time when no time remaining', () => {
      const now = new Date('2026-01-28T10:00:00')
      const result = estimateArrival(now, 0)
      expect(result.getTime()).toBe(now.getTime())
    })
  })

  describe('determineTripStatus', () => {
    const onRouteMatch = {
      distanceFromRoute: 10,
      isOnRoute: true,
      legIndex: 0,
      nearestPoint: [44.98, -93.27] as [number, number],
      progressAlongLeg: 0.5,
      progressAlongSegment: 0.5,
      segmentIndex: 0
    }

    it('should return deviated when routeMatch is null', () => {
      expect(determineTripStatus(null, 50, 50)).toBe('deviated')
    })

    it('should return deviated when not on route', () => {
      const offRoute = { ...onRouteMatch, isOnRoute: false }
      expect(determineTripStatus(offRoute, 50, 50)).toBe('deviated')
    })

    it('should return completed when progress >= 99.5', () => {
      expect(determineTripStatus(onRouteMatch, 99, 99.5)).toBe('completed')
      expect(determineTripStatus(onRouteMatch, 99, 100)).toBe('completed')
    })

    it('should return on_track when within 5% of expected', () => {
      expect(determineTripStatus(onRouteMatch, 50, 52)).toBe('on_track')
      expect(determineTripStatus(onRouteMatch, 50, 48)).toBe('on_track')
    })

    it('should return ahead when actual > expected by more than 5%', () => {
      expect(determineTripStatus(onRouteMatch, 40, 50)).toBe('ahead')
    })

    it('should return behind when actual < expected by more than 5%', () => {
      expect(determineTripStatus(onRouteMatch, 60, 50)).toBe('behind')
    })
  })

  describe('calculateExpectedProgress', () => {
    it('should return 0 at start time', () => {
      const start = new Date('2026-01-28T10:00:00')
      expect(calculateExpectedProgress(start, start, 600)).toBe(0)
    })

    it('should return 50 at halfway', () => {
      const start = new Date('2026-01-28T10:00:00')
      const current = new Date('2026-01-28T10:05:00')
      expect(calculateExpectedProgress(start, current, 600)).toBe(50)
    })

    it('should clamp to 100', () => {
      const start = new Date('2026-01-28T10:00:00')
      const current = new Date('2026-01-28T10:20:00')
      expect(calculateExpectedProgress(start, current, 600)).toBe(100)
    })

    it('should clamp to 0 for negative elapsed time', () => {
      const start = new Date('2026-01-28T10:05:00')
      const current = new Date('2026-01-28T10:00:00')
      expect(calculateExpectedProgress(start, current, 600)).toBe(0)
    })
  })

  describe('getTransitProgress', () => {
    it('should return empty for non-transit legs', () => {
      const leg = { mode: 'WALK' } as any
      expect(getTransitProgress(leg, 0.5)).toEqual({})
    })

    it('should return stop info for BUS leg', () => {
      const leg = {
        intermediateStops: [
          { name: 'Stop A' },
          { name: 'Stop B' },
          { name: 'Stop C' }
        ],
        mode: 'BUS',
        to: { name: 'Destination' }
      } as any

      const result = getTransitProgress(leg, 0.1)
      expect(result.nextStopName).toBeDefined()
      expect(result.stopsRemaining).toBeGreaterThan(0)
    })

    it('should return destination as next stop when past all intermediate stops', () => {
      const leg = {
        intermediateStops: [{ name: 'Stop A' }],
        mode: 'BUS',
        to: { name: 'Destination' }
      } as any

      const result = getTransitProgress(leg, 0.99)
      expect(result.nextStopName).toBe('Destination')
      expect(result.stopsRemaining).toBe(1)
    })

    it('should return empty for legs without intermediate stops', () => {
      const leg = {
        intermediateStops: null,
        mode: 'BUS',
        to: { name: 'Destination' }
      } as any
      expect(getTransitProgress(leg, 0.5)).toEqual({})
    })
  })

  describe('getWalkingInstruction', () => {
    it('should return empty for non-walk/bike legs', () => {
      const leg = { mode: 'BUS' } as any
      expect(getWalkingInstruction(leg, 0.5)).toEqual({})
    })

    it('should return "Continue to" instruction when not near end', () => {
      const leg = {
        distance: 500,
        mode: 'WALK',
        to: { name: 'Bus Stop' }
      } as any

      const result = getWalkingInstruction(leg, 0.5)
      expect(result.nextInstruction).toContain('Continue to Bus Stop')
      expect(result.distanceToNextTurn).toBeCloseTo(250)
    })

    it('should return "Arriving at" instruction when near end', () => {
      const leg = {
        distance: 500,
        mode: 'WALK',
        to: { name: 'Bus Stop' }
      } as any

      const result = getWalkingInstruction(leg, 0.95)
      expect(result.nextInstruction).toContain('Arriving at Bus Stop')
    })

    it('should work for BICYCLE mode', () => {
      const leg = {
        distance: 1000,
        mode: 'BICYCLE',
        to: { name: 'Station' }
      } as any

      const result = getWalkingInstruction(leg, 0.5)
      expect(result.nextInstruction).toContain('Continue to Station')
    })
  })

  describe('shouldAlertForApproachingStop', () => {
    it('should return true when 2 stops remaining', () => {
      const leg = { mode: 'BUS' } as any
      expect(shouldAlertForApproachingStop(leg, 2)).toBe(true)
    })

    it('should return false when more than 2 stops remaining', () => {
      const leg = { mode: 'BUS' } as any
      expect(shouldAlertForApproachingStop(leg, 3)).toBe(false)
    })

    it('should return false when 1 stop remaining', () => {
      const leg = { mode: 'BUS' } as any
      expect(shouldAlertForApproachingStop(leg, 1)).toBe(false)
    })

    it('should return false when no stops remaining', () => {
      const leg = { mode: 'BUS' } as any
      expect(shouldAlertForApproachingStop(leg, undefined)).toBe(false)
    })
  })

  describe('shouldAlertForBoarding', () => {
    it('should return true when approaching end of previous leg and next is transit', () => {
      const leg = { mode: 'BUS', routeShortName: '5' } as any
      const previousLeg = { mode: 'WALK' } as any
      expect(shouldAlertForBoarding(leg, previousLeg, 0.95)).toBe(true)
    })

    it('should return false when no previous leg', () => {
      const leg = { mode: 'BUS' } as any
      expect(shouldAlertForBoarding(leg, null, 0.95)).toBe(false)
    })

    it('should return false when not near end of previous leg', () => {
      const leg = { mode: 'BUS' } as any
      const previousLeg = { mode: 'WALK' } as any
      expect(shouldAlertForBoarding(leg, previousLeg, 0.5)).toBe(false)
    })

    it('should return false when next leg is not transit', () => {
      const leg = { mode: 'WALK' } as any
      const previousLeg = { mode: 'BUS' } as any
      expect(shouldAlertForBoarding(leg, previousLeg, 0.95)).toBe(false)
    })
  })

  describe('calculateTripProgress', () => {
    it('should return comprehensive progress for a trip', () => {
      const legs = makeLegs(
        [500, 2000, 300],
        [300, 600, 180],
        ['WALK', 'BUS', 'WALK']
      )
      legs[1].intermediateStops = [
        { name: 'Stop A' },
        { name: 'Stop B' },
        { name: 'Stop C' }
      ]
      legs[1].routeShortName = '5'

      const itinerary = makeItinerary(
        legs,
        '2026-01-28T10:00:00',
        '2026-01-28T10:18:00'
      )

      const routeMatch = {
        distanceFromRoute: 10,
        isOnRoute: true,
        legIndex: 1,
        nearestPoint: [44.98, -93.27] as [number, number],
        progressAlongLeg: 0.5,
        progressAlongSegment: 0.5,
        segmentIndex: 3
      }

      const result = calculateTripProgress(
        new Date('2026-01-28T10:08:00'),
        itinerary,
        routeMatch
      )

      expect(result.currentLegIndex).toBe(1)
      expect(result.overallProgress).toBeGreaterThan(0)
      expect(result.overallProgress).toBeLessThan(100)
      expect(result.timeRemaining).toBeGreaterThan(0)
      expect(result.estimatedArrival).toBeInstanceOf(Date)
      expect(result.status).toBeDefined()
      expect(result.currentLegProgress).toBeCloseTo(50)
    })

    it('should handle null route match', () => {
      const legs = makeLegs([1000], [300])
      const itinerary = makeItinerary(
        legs,
        '2026-01-28T10:00:00',
        '2026-01-28T10:05:00'
      )

      const result = calculateTripProgress(
        new Date('2026-01-28T10:02:00'),
        itinerary,
        null
      )

      expect(result.status).toBe('deviated')
      expect(result.currentLegIndex).toBe(0)
    })
  })
})
