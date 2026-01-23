import type { Itinerary, Leg } from '@opentripplanner/types'

import type { RouteMatchResult } from './position-matching'

export type TripStatus =
  | 'on_track'
  | 'ahead'
  | 'behind'
  | 'deviated'
  | 'completed'

export interface TripProgress {
  // 0-100%
  currentLegIndex: number
  currentLegProgress: number
  delay?: number
  distanceToNextTurn?: number
  // 0-100%
  estimatedArrival: Date
  // seconds
  // Walking-specific
  nextInstruction?: string

  nextStopName?: string
  overallProgress: number
  // seconds
  status: TripStatus

  // Transit-specific
  stopsRemaining?: number
  timeRemaining: number
}

/**
 * Calculate overall trip progress based on distance traveled
 */
export function calculateOverallProgress(
  currentLegIndex: number,
  progressInCurrentLeg: number,
  legs: Leg[]
): number {
  if (legs.length === 0) return 0

  // Calculate total distance
  const totalDistance = legs.reduce((sum, leg) => sum + (leg.distance || 0), 0)

  if (totalDistance === 0) return 0

  // Calculate distance completed
  let completedDistance = 0

  // Add completed legs
  for (let i = 0; i < currentLegIndex; i++) {
    completedDistance += legs[i].distance || 0
  }

  // Add progress in current leg
  if (currentLegIndex < legs.length) {
    const currentLeg = legs[currentLegIndex]
    completedDistance += (currentLeg.distance || 0) * progressInCurrentLeg
  }

  return (completedDistance / totalDistance) * 100
}

/**
 * Calculate time remaining based on current progress and scheduled times
 */
export function calculateTimeRemaining(
  currentTime: Date,
  itinerary: Itinerary,
  currentLegIndex: number,
  progressInCurrentLeg: number
): number {
  const endTime = new Date(itinerary.endTime)
  const startTime = new Date(itinerary.startTime)
  const totalDuration = (endTime.getTime() - startTime.getTime()) / 1000 // seconds

  // Calculate expected time elapsed based on leg progress
  const legs = itinerary.legs
  let expectedElapsed = 0

  for (let i = 0; i < currentLegIndex; i++) {
    expectedElapsed += legs[i].duration || 0
  }

  if (currentLegIndex < legs.length) {
    const currentLeg = legs[currentLegIndex]
    expectedElapsed += (currentLeg.duration || 0) * progressInCurrentLeg
  }

  // Simple calculation: remaining = total - expected elapsed
  const remaining = totalDuration - expectedElapsed

  return Math.max(0, remaining)
}

/**
 * Estimate arrival time based on current progress
 */
export function estimateArrival(
  currentTime: Date,
  timeRemaining: number
): Date {
  return new Date(currentTime.getTime() + timeRemaining * 1000)
}

/**
 * Determine trip status based on position and timing
 */
export function determineTripStatus(
  routeMatch: RouteMatchResult | null,
  expectedProgress: number,
  actualProgress: number
): TripStatus {
  if (!routeMatch) {
    return 'deviated'
  }

  if (!routeMatch.isOnRoute) {
    return 'deviated'
  }

  if (actualProgress >= 99.5) {
    return 'completed'
  }

  const progressDifference = actualProgress - expectedProgress

  if (Math.abs(progressDifference) < 5) {
    return 'on_track'
  }

  return progressDifference > 0 ? 'ahead' : 'behind'
}

/**
 * Calculate expected progress based on time elapsed
 */
export function calculateExpectedProgress(
  startTime: Date,
  currentTime: Date,
  totalDuration: number
): number {
  const elapsed = (currentTime.getTime() - startTime.getTime()) / 1000
  const progress = (elapsed / totalDuration) * 100
  return Math.max(0, Math.min(100, progress))
}

/**
 * Get transit-specific progress information
 */
export function getTransitProgress(
  leg: Leg,
  progressInLeg: number
): {
  nextStopName?: string
  stopsRemaining?: number
} {
  if (!leg.intermediateStops || (leg.mode !== 'BUS' && leg.mode !== 'RAIL')) {
    return {}
  }

  const stops = leg.intermediateStops
  const totalStops = stops.length + 1 // +1 for destination stop

  // Estimate which stop we're approaching based on progress
  const stopIndex = Math.floor(progressInLeg * totalStops)

  if (stopIndex < stops.length) {
    return {
      nextStopName: stops[stopIndex].name,
      stopsRemaining: totalStops - stopIndex
    }
  }

  // At or past last intermediate stop, next stop is destination
  return {
    nextStopName: leg.to.name,
    stopsRemaining: 1
  }
}

/**
 * Get walking-specific navigation information
 */
export function getWalkingInstruction(
  leg: Leg,
  progressInLeg: number
): {
  distanceToNextTurn?: number
  nextInstruction?: string
} {
  if (leg.mode !== 'WALK' && leg.mode !== 'BICYCLE') {
    return {}
  }

  // For Phase 1 MVP, return basic instruction
  // Phase 2 will add turn-by-turn with steps
  const remainingDistance = (leg.distance || 0) * (1 - progressInLeg)

  if (progressInLeg < 0.9) {
    return {
      distanceToNextTurn: remainingDistance,
      nextInstruction: `Continue to ${leg.to.name}`
    }
  }

  return {
    distanceToNextTurn: remainingDistance,
    nextInstruction: `Arriving at ${leg.to.name}`
  }
}

/**
 * Calculate comprehensive trip progress
 */
export function calculateTripProgress(
  currentTime: Date,
  itinerary: Itinerary,
  routeMatch: RouteMatchResult | null
): TripProgress {
  const legs = itinerary.legs
  const currentLegIndex = routeMatch?.legIndex || 0
  const progressInCurrentLeg = routeMatch?.progressAlongLeg || 0

  const overallProgress = calculateOverallProgress(
    currentLegIndex,
    progressInCurrentLeg,
    legs
  )

  const timeRemaining = calculateTimeRemaining(
    currentTime,
    itinerary,
    currentLegIndex,
    progressInCurrentLeg
  )

  const estimatedArrival = estimateArrival(currentTime, timeRemaining)

  const startTime = new Date(itinerary.startTime)
  const endTime = new Date(itinerary.endTime)
  const totalDuration = (endTime.getTime() - startTime.getTime()) / 1000

  const expectedProgress = calculateExpectedProgress(
    startTime,
    currentTime,
    totalDuration
  )

  const status = determineTripStatus(
    routeMatch,
    expectedProgress,
    overallProgress
  )

  const currentLeg = legs[currentLegIndex]
  const currentLegProgress = progressInCurrentLeg * 100

  // Get mode-specific progress info
  const transitInfo = getTransitProgress(currentLeg, progressInCurrentLeg)
  const walkingInfo = getWalkingInstruction(currentLeg, progressInCurrentLeg)

  return {
    currentLegIndex,
    currentLegProgress,
    estimatedArrival,
    overallProgress,
    status,
    timeRemaining,
    ...transitInfo,
    ...walkingInfo
  }
}

/**
 * Check if should alert for approaching stop
 */
export function shouldAlertForApproachingStop(
  leg: Leg,
  stopsRemaining?: number
): boolean {
  if (!stopsRemaining) return false

  // Alert when 2 stops away from destination
  return stopsRemaining === 2
}

/**
 * Check if should alert for boarding
 */
export function shouldAlertForBoarding(
  leg: Leg,
  previousLeg: Leg | null,
  progressInPreviousLeg: number
): boolean {
  if (!previousLeg) return false

  // Alert when approaching end of previous leg and next leg is transit
  if (
    progressInPreviousLeg > 0.9 &&
    (leg.mode === 'BUS' || leg.mode === 'RAIL')
  ) {
    return true
  }

  return false
}
