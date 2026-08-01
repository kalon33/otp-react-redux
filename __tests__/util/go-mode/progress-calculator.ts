import { encode } from '@mapbox/polyline'

import {
  calculateExpectedProgress,
  calculateOverallProgress,
  calculateTimeRemaining,
  calculateTripProgress,
  computeCurrentDelay,
  determineTripStatus,
  estimateArrival,
  getTransitProgress,
  getUpcomingTransitTiming,
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

    describe('with leg geometry (unevenly spaced stops)', () => {
      // Orange-Line shape: a straight leg whose stops bunch at the far end —
      // one early stop at 20% of the distance, then nothing until a cluster at
      // 85/90/95%, alighting at 100%. Even spacing would badly miscount here.
      const line: [number, number][] = []
      for (let i = 0; i <= 20; i++) line.push([i * 0.005, 0])
      const stopAt = (lat: number, name: string) => ({ lat, lon: 0, name })
      const leg = {
        intermediateStops: [
          stopAt(0.02, 'Early Stop'),
          stopAt(0.085, 'Cluster A'),
          stopAt(0.09, 'Cluster B'),
          stopAt(0.095, 'Cluster C')
        ],
        legGeometry: { points: encode(line, 5) },
        mode: 'BUS',
        to: { lat: 0.1, lon: 0, name: 'Destination' }
      } as any

      it('counts every stop ahead early in the leg', () => {
        expect(getTransitProgress(leg, 0.1)).toEqual({
          nextStopName: 'Early Stop',
          stopsRemaining: 5
        })
      })

      it('still counts the whole tail cluster mid-leg', () => {
        // Even spacing says floor(0.5 × 5) = 2 stops passed; in reality only
        // one stop is behind the rider at half the distance.
        expect(getTransitProgress(leg, 0.5)).toEqual({
          nextStopName: 'Cluster A',
          stopsRemaining: 4
        })
      })

      it('does not report the alight stop as next while cluster stops remain', () => {
        // The 7/22 ride bug: at 90% of the distance the header said "1 stop
        // remaining" with two cluster stops still ahead of the rider.
        expect(getTransitProgress(leg, 0.9)).toEqual({
          nextStopName: 'Cluster C',
          stopsRemaining: 2
        })
      })

      it('reports the alight stop once past the cluster', () => {
        expect(getTransitProgress(leg, 0.99)).toEqual({
          nextStopName: 'Destination',
          stopsRemaining: 1
        })
      })

      it('prefers intermediatePlaces when present', () => {
        const placesLeg = {
          ...leg,
          intermediatePlaces: [
            stopAt(0.085, 'Places A'),
            stopAt(0.09, 'Places B'),
            stopAt(0.095, 'Places C')
          ]
        }
        expect(getTransitProgress(placesLeg, 0.5)).toEqual({
          nextStopName: 'Places A',
          stopsRemaining: 4
        })
      })
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

    it('returns nothing at all while the rider is off the route', () => {
      const leg = {
        distance: 1000,
        mode: 'BICYCLE',
        to: { name: 'Station' }
      } as any

      // No turn fields AND no "Continue to" filler: off the plan, that line is
      // exactly the stale guidance the 7/29 rider shouldn't have seen. The
      // deviation toast and the quiet replan own this state.
      expect(getWalkingInstruction(leg, 0.5, false)).toEqual({})
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

  describe('computeCurrentDelay', () => {
    const start = new Date('2026-01-28T10:00:00').getTime()
    const end = start + 600000 // 10-minute leg
    const leg = { endTime: end, mode: 'BUS', startTime: start } as any

    it('should return undefined for undefined leg', () => {
      expect(
        computeCurrentDelay(undefined, 0.5, new Date(start))
      ).toBeUndefined()
    })

    it('should return undefined when leg lacks scheduled times', () => {
      const noTimes = { mode: 'BUS' } as any
      expect(computeCurrentDelay(noTimes, 0.5, new Date(start))).toBeUndefined()
    })

    it('should return ~0 when exactly on schedule', () => {
      // Halfway along the leg, at the scheduled halfway time
      const result = computeCurrentDelay(leg, 0.5, new Date(start + 300000))
      expect(result).toBeCloseTo(0)
    })

    it('should return positive seconds when running late', () => {
      // Only halfway along, but the scheduled halfway time passed 60s ago
      const result = computeCurrentDelay(leg, 0.5, new Date(start + 360000))
      expect(result).toBeCloseTo(60)
    })

    it('should return negative seconds when running ahead', () => {
      const result = computeCurrentDelay(leg, 0.5, new Date(start + 240000))
      expect(result).toBeCloseTo(-60)
    })

    it('should clamp progress outside [0, 1]', () => {
      // progress > 1 is treated as end of leg
      const result = computeCurrentDelay(leg, 1.5, new Date(end))
      expect(result).toBeCloseTo(0)
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
      // A null match reads as deviated, and deviated access legs carry no turn
      // guidance at all — the projection behind it is a fiction (7/29).
      expect(result.nextInstruction).toBeUndefined()
      expect(result.nextTurnCue).toBeUndefined()
      expect(result.distanceToNextTurn).toBeUndefined()
    })

    it('carries no turn fields while the rider is off the route', () => {
      const legs = makeLegs([1000], [300], ['BICYCLE'])
      const itinerary = makeItinerary(
        legs,
        '2026-01-28T10:00:00',
        '2026-01-28T10:05:00'
      )

      const result = calculateTripProgress(
        new Date('2026-01-28T10:02:00'),
        itinerary,
        {
          distanceFromRoute: 150,
          isOnRoute: false,
          legIndex: 0,
          nearestPoint: [44.92, -93.27] as [number, number],
          progressAlongLeg: 0.4,
          progressAlongSegment: 0.5,
          segmentIndex: 1
        }
      )

      expect(result.status).toBe('deviated')
      expect(result.nextInstruction).toBeUndefined()
      expect(result.nextTurnCue).toBeUndefined()
      expect(result.distanceToNextTurn).toBeUndefined()
    })

    it('passes the rider speed through for lead scaling', () => {
      const legs = makeLegs([1000], [300], ['BICYCLE'])
      const itinerary = makeItinerary(
        legs,
        '2026-01-28T10:00:00',
        '2026-01-28T10:05:00'
      )

      const result = calculateTripProgress(
        new Date('2026-01-28T10:02:00'),
        itinerary,
        {
          distanceFromRoute: 5,
          isOnRoute: true,
          legIndex: 0,
          nearestPoint: [44.92, -93.27] as [number, number],
          progressAlongLeg: 0.4,
          progressAlongSegment: 0.5,
          segmentIndex: 1
        },
        undefined,
        undefined,
        6.5
      )

      expect(result.riderSpeedMps).toBe(6.5)

      // No speed on the fix → the field stays absent (floors apply downstream).
      const noSpeed = calculateTripProgress(
        new Date('2026-01-28T10:02:00'),
        itinerary,
        null,
        undefined,
        undefined,
        null
      )
      expect(noSpeed.riderSpeedMps).toBeUndefined()
    })
  })
})

describe('getUpcomingTransitTiming', () => {
  const NOW = new Date('2026-01-28T10:00:00')
  const walkLeg = { duration: 600, mode: 'WALK' } as any
  const busLeg = {
    endTime: NOW.getTime() + 40 * 60000,
    mode: 'BUS',
    startTime: NOW.getTime() + 20 * 60000
  } as any

  it('uses the planned board time without an override', () => {
    const t = getUpcomingTransitTiming(NOW, walkLeg, busLeg, 0.5)
    // 20 min to departure, 5 min of walking left -> 15 min wait at the stop.
    expect(t.timeUntilNextDeparture).toBeCloseTo(1200)
    expect(t.waitTimeAtStop).toBeCloseTo(900)
    expect(t.departureIsOverridden).toBe(false)
    expect(t.plannedDepartureTime).toBe(busLeg.startTime)
  })

  it('an override (auto-anchor or manual pick) shifts the wait', () => {
    // Anchored to a bus 8 min out instead of the planned 20.
    const overrideMs = NOW.getTime() + 8 * 60000
    const t = getUpcomingTransitTiming(NOW, walkLeg, busLeg, 0.5, overrideMs)
    expect(t.timeUntilNextDeparture).toBeCloseTo(480)
    expect(t.waitTimeAtStop).toBeCloseTo(180)
    expect(t.departureIsOverridden).toBe(true)
    // The planned time is still reported for display/deltas.
    expect(t.plannedDepartureTime).toBe(busLeg.startTime)
  })

  it('reports the destination arrival on transit legs', () => {
    const t = getUpcomingTransitTiming(NOW, busLeg, undefined, 0.2)
    expect(t.destinationArrivalTime).toBe(busLeg.endTime)
  })

  it('returns nothing for non-transit connections', () => {
    const bikeLeg = { duration: 300, mode: 'BICYCLE' } as any
    expect(getUpcomingTransitTiming(NOW, walkLeg, bikeLeg, 0.5)).toEqual({})
  })
})

describe('getTransitProgress with a trust context', () => {
  // Straight geometry, one early stop and a tail cluster (see the geometry
  // describe above); progress 0.5 puts the rider between them.
  const line: [number, number][] = []
  for (let i = 0; i <= 20; i++) line.push([i * 0.005, 0])
  const stopAt = (lat: number, name: string) => ({ lat, lon: 0, name })
  const leg = {
    intermediateStops: [
      stopAt(0.02, 'Early Stop'),
      stopAt(0.085, 'Cluster A'),
      stopAt(0.09, 'Cluster B'),
      stopAt(0.095, 'Cluster C')
    ],
    legGeometry: { points: encode(line, 5) },
    mode: 'BUS',
    to: { lat: 0.1, lon: 0, name: 'Destination' }
  } as any

  it('without a ctx, returns the legacy result exactly — no trust fields', () => {
    // Back-compat pin: legacy callers (demo harness, tests) see byte-identical
    // output, so untouched paths cannot regress.
    expect(getTransitProgress(leg, 0.5)).toEqual({
      nextStopName: 'Cluster A',
      stopsRemaining: 4
    })
  })

  it('sound rider GPS drives the count: source gps, trusted', () => {
    expect(
      getTransitProgress(leg, 0.5, {
        riderTrusted: true,
        vehicleProgress: null,
        vehicleStops: null
      })
    ).toEqual({
      nextStopName: 'Cluster A',
      stopsRemaining: 4,
      stopsSource: 'gps',
      stopsTrusted: true
    })
  })

  it("distrusted rider GPS falls to the bus's own position: source vehicle, trusted", () => {
    // The rider's fix says 0.93 of the leg (stale/garbage); the bus's own
    // feed position projects to 0.3 — the bus wins.
    expect(
      getTransitProgress(leg, 0.93, {
        riderTrusted: false,
        vehicleProgress: 0.3,
        vehicleStops: null
      })
    ).toEqual({
      nextStopName: 'Cluster A',
      stopsRemaining: 4,
      stopsSource: 'vehicle',
      stopsTrusted: true
    })
  })

  it("the feed's next-stop fact is the next fallback: source vehicle-stop", () => {
    expect(
      getTransitProgress(leg, 0.93, {
        riderTrusted: false,
        vehicleProgress: null,
        vehicleStops: { nextStopName: 'Cluster B', stopsRemaining: 3 }
      })
    ).toEqual({
      nextStopName: 'Cluster B',
      stopsRemaining: 3,
      stopsSource: 'vehicle-stop',
      stopsTrusted: true
    })
  })

  it('with every trusted source empty, the count is an untrusted schedule guess', () => {
    // The stale-fix regression: the count may render on passive surfaces but
    // must never light the GET READY banner.
    const result = getTransitProgress(leg, 0.93, {
      riderTrusted: false,
      vehicleProgress: null,
      vehicleStops: null
    })
    expect(result.stopsTrusted).toBe(false)
    expect(result.stopsSource).toBe('schedule')
  })

  it('a degenerate stop list is never trusted, whatever the source', () => {
    // Claims intermediates, but every entry lacks coordinates: the count can
    // only ever be "1 stop remaining" (the 7/29 permanent GET READY shape).
    const degenerate = {
      intermediatePlaces: [{ name: 'No Coords A' }, { name: 'No Coords B' }],
      legGeometry: leg.legGeometry,
      mode: 'BUS',
      to: leg.to
    } as any
    const result = getTransitProgress(degenerate, 0.2, {
      riderTrusted: true,
      vehicleProgress: null,
      vehicleStops: null
    })
    expect(result.stopsRemaining).toBe(1)
    expect(result.stopsTrusted).toBe(false)
  })

  it('calculateTripProgress threads the ctx through to the transit info', () => {
    const itinerary = {
      endTime: '2026-07-29T17:55:00',
      legs: [{ ...leg, distance: 11000, duration: 1200 }],
      startTime: '2026-07-29T17:27:00'
    } as any
    const routeMatch = {
      distanceFromRoute: 10,
      isOnRoute: true,
      legIndex: 0,
      nearestPoint: [0.05, 0] as [number, number],
      progressAlongLeg: 0.5,
      progressAlongSegment: 0.5,
      segmentIndex: 10
    }
    const progress = calculateTripProgress(
      new Date('2026-07-29T17:40:00'),
      itinerary,
      routeMatch,
      null,
      { riderTrusted: false, vehicleProgress: 0.3, vehicleStops: null }
    )
    expect(progress.stopsSource).toBe('vehicle')
    expect(progress.stopsTrusted).toBe(true)
    expect(progress.stopsRemaining).toBe(4)
  })
})
