import { createAction } from 'redux-actions'
import polyline from '@mapbox/polyline'
import type { Itinerary, LatLngArray, Leg } from '@opentripplanner/types'

import { calculateTripProgress } from '../util/go-mode/progress-calculator'
import {
  checkForNotifications,
  showNotification
} from '../util/go-mode/notification-service'
import {
  matchPositionToRoute,
  shouldTransitionToNextLeg
} from '../util/go-mode/position-matching'
import type { NotificationEvent } from '../util/go-mode/notification-service'
import type { RouteMatchResult } from '../util/go-mode/position-matching'
import type { TripProgress } from '../util/go-mode/progress-calculator'

// Module-scoped GPS polling interval ID (replaces window.__goModeIntervalId)
let gpsPollingIntervalId: ReturnType<typeof setInterval> | null = null

// Module-scoped visibilitychange handler for cleanup
let visibilityChangeHandler: (() => void) | null = null

// GPS simulation state
let gpsSimulationIntervalId: ReturnType<typeof setInterval> | null = null

// Action types
export const START_GO_MODE = 'START_GO_MODE'
export const STOP_GO_MODE = 'STOP_GO_MODE'
export const UPDATE_POSITION = 'UPDATE_POSITION'
export const UPDATE_ROUTE_MATCH = 'UPDATE_ROUTE_MATCH'
export const UPDATE_PROGRESS = 'UPDATE_PROGRESS'
export const TRANSITION_LEG = 'TRANSITION_LEG'
export const ADD_NOTIFICATION = 'ADD_NOTIFICATION'
export const SET_TRACKING_ERROR = 'SET_TRACKING_ERROR'
export const TOGGLE_MAP_FOLLOW = 'TOGGLE_MAP_FOLLOW'
export const UPDATE_TRACKING_INTERVAL = 'UPDATE_TRACKING_INTERVAL'
export const SET_NOTIFICATION_CONFIG = 'SET_NOTIFICATION_CONFIG'

// Simple action creators
export const startGoMode = createAction<{ itinerary: Itinerary }>(START_GO_MODE)
export const stopGoMode = createAction(STOP_GO_MODE)
export const updatePosition = createAction<GeolocationPosition>(UPDATE_POSITION)
export const updateRouteMatch = createAction<RouteMatchResult | null>(
  UPDATE_ROUTE_MATCH
)
export const updateProgress = createAction<TripProgress>(UPDATE_PROGRESS)
export const transitionLeg = createAction<{ legIndex: number }>(TRANSITION_LEG)
export const addNotification = createAction<NotificationEvent>(ADD_NOTIFICATION)
export const setTrackingError = createAction<GeolocationPositionError | null>(
  SET_TRACKING_ERROR
)
export const toggleMapFollow = createAction(TOGGLE_MAP_FOLLOW)
export const updateTrackingInterval = createAction<{ interval: number }>(
  UPDATE_TRACKING_INTERVAL
)
export const setNotificationConfig = createAction<{
  enabled?: boolean
  soundEnabled?: boolean
  vibrationEnabled?: boolean
}>(SET_NOTIFICATION_CONFIG)

/**
 * Determine appropriate GPS tracking interval based on current leg mode
 */
function getTrackingIntervalForLeg(leg: Leg | undefined): number {
  if (!leg) return 8000

  switch (leg.mode) {
    case 'WALK':
      return 5000
    case 'BICYCLE':
      return 4000
    case 'BUS':
    case 'RAIL':
      // Check if we're likely waiting at stop (leg just started)
      return 10000
    default:
      return 8000
  }
}

/**
 * Start Go Mode tracking for an itinerary
 */
export function beginGoMode(itinerary: Itinerary) {
  return async function (dispatch: any) {
    // Check geolocation permission before starting
    if ('permissions' in navigator) {
      try {
        const result = await navigator.permissions.query({
          name: 'geolocation'
        })
        if (result.state === 'denied') {
          dispatch(
            setTrackingError({
              code: 1,
              message: 'Geolocation permission denied',
              PERMISSION_DENIED: 1,
              POSITION_UNAVAILABLE: 2,
              TIMEOUT: 3
            } as GeolocationPositionError)
          )
          dispatch(startGoMode({ itinerary }))
          return
        }
      } catch {
        // permissions API not supported, continue anyway
      }
    }

    dispatch(startGoMode({ itinerary }))

    // Set initial tracking interval based on first leg
    const interval = getTrackingIntervalForLeg(itinerary.legs[0])
    dispatch(updateTrackingInterval({ interval }))

    // Request location permission and start tracking
    dispatch(startPositionTracking())
  }
}

/**
 * Stop Go Mode and clean up
 */
export function endGoMode() {
  return function (dispatch: any) {
    // Clean up GPS polling interval
    if (gpsPollingIntervalId) {
      clearInterval(gpsPollingIntervalId)
      gpsPollingIntervalId = null
    }

    // Clean up visibilitychange listener
    if (visibilityChangeHandler) {
      document.removeEventListener('visibilitychange', visibilityChangeHandler)
      visibilityChangeHandler = null
    }

    // Clean up GPS simulation interval
    if (gpsSimulationIntervalId) {
      clearInterval(gpsSimulationIntervalId)
      gpsSimulationIntervalId = null
    }

    dispatch(stopGoMode())
  }
}

/**
 * Start GPS position tracking
 */
export function startPositionTracking() {
  return function (dispatch: any, getState: any) {
    if (!('geolocation' in navigator)) {
      dispatch(
        setTrackingError({
          code: 0,
          message: 'Geolocation not supported',
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3
        } as GeolocationPositionError)
      )
      return
    }

    const options: PositionOptions = {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 10000
    }

    // Use polling instead of watchPosition to avoid conflicts with react-map-gl
    const pollPosition = () => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          dispatch(handlePositionUpdate(position))
        },
        (error) => {
          dispatch(setTrackingError(error))
        },
        options
      )
    }

    // Initial position with 15s timeout
    let initialResolved = false
    const initialTimeout = setTimeout(() => {
      if (!initialResolved) {
        dispatch(
          setTrackingError({
            code: 3,
            message: 'Initial GPS acquisition timed out',
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3
          } as GeolocationPositionError)
        )
      }
    }, 15000)

    navigator.geolocation.getCurrentPosition(
      (position) => {
        initialResolved = true
        clearTimeout(initialTimeout)
        dispatch(handlePositionUpdate(position))
      },
      (error) => {
        initialResolved = true
        clearTimeout(initialTimeout)
        dispatch(setTrackingError(error))
      },
      { ...options, timeout: 15000 }
    )

    // Set up polling interval
    const state = getState()
    const interval = state.otp?.goMode?.tracking?.interval || 8000
    const intervalId = setInterval(pollPosition, interval)

    // Store interval ID in module-scoped variable for cleanup
    gpsPollingIntervalId = intervalId

    // Re-acquire position when tab regains focus (background tab suspension recovery)
    if (!visibilityChangeHandler) {
      visibilityChangeHandler = () => {
        if (document.visibilityState === 'visible' && gpsPollingIntervalId) {
          // Immediately poll position when returning from background
          pollPosition()
        }
      }
      document.addEventListener('visibilitychange', visibilityChangeHandler)
    }
  }
}

/**
 * Handle a position update from GPS
 */
export function handlePositionUpdate(position: GeolocationPosition) {
  return function (dispatch: any, getState: any) {
    const state = getState()
    const goMode = state.otp?.goMode

    if (!goMode?.isActive || !goMode?.activeItinerary) {
      return
    }

    dispatch(updatePosition(position))

    const currentPosition: LatLngArray = [
      position.coords.latitude,
      position.coords.longitude
    ]

    const itinerary = goMode.activeItinerary
    const currentLegIndex = goMode.routeMatch?.legIndex || 0

    // Match position to route
    const routeMatch = matchPositionToRoute(
      currentPosition,
      itinerary.legs,
      currentLegIndex
    )

    dispatch(updateRouteMatch(routeMatch))

    if (!routeMatch) {
      return
    }

    // Check for leg transition
    const previousLegIndex = goMode.routeMatch?.legIndex || 0
    if (
      shouldTransitionToNextLeg(routeMatch, previousLegIndex, itinerary.legs)
    ) {
      dispatch(transitionLeg({ legIndex: routeMatch.legIndex }))

      // Update tracking interval for new leg
      const newLeg = itinerary.legs[routeMatch.legIndex]
      const newInterval = getTrackingIntervalForLeg(newLeg)
      dispatch(updateTrackingInterval({ interval: newInterval }))

      // Restart tracking with new interval
      if (gpsPollingIntervalId) {
        clearInterval(gpsPollingIntervalId)
        gpsPollingIntervalId = null
      }
      dispatch(startPositionTracking())
    }

    // Calculate progress
    const currentTime = new Date()
    const progress = calculateTripProgress(currentTime, itinerary, routeMatch)

    dispatch(updateProgress(progress))

    // Check for notifications
    const currentLeg = itinerary.legs[routeMatch.legIndex]
    const nextLeg =
      routeMatch.legIndex < itinerary.legs.length - 1
        ? itinerary.legs[routeMatch.legIndex + 1]
        : undefined

    const notifications = checkForNotifications(
      progress,
      currentLeg,
      previousLegIndex,
      nextLeg,
      routeMatch.distanceFromRoute,
      goMode.notifications?.sentNotifications || [],
      goMode.notifications || {
        enabled: true,
        soundEnabled: false,
        vibrationEnabled: true
      }
    )

    // Show notifications
    notifications.forEach((notification) => {
      dispatch(addNotification(notification))
      showNotification(
        notification,
        goMode.notifications || {
          enabled: true,
          soundEnabled: false,
          vibrationEnabled: true
        }
      )
    })
  }
}

/**
 * Toggle map following user position
 */
export function toggleUserFollow() {
  return function (dispatch: any) {
    dispatch(toggleMapFollow())
  }
}

/**
 * Update notification settings
 */
export function updateNotificationSettings(config: {
  enabled?: boolean
  soundEnabled?: boolean
  vibrationEnabled?: boolean
}) {
  return function (dispatch: any) {
    dispatch(setNotificationConfig(config))
  }
}

/**
 * Extract all coordinates from an itinerary's leg geometries as [lat, lng] pairs.
 */
function extractItineraryCoordinates(
  itinerary: Itinerary
): Array<[number, number]> {
  const coords: Array<[number, number]> = []
  for (const leg of itinerary.legs) {
    if (leg.legGeometry?.points) {
      try {
        const decoded = polyline.decode(leg.legGeometry.points)
        coords.push(...decoded)
      } catch {
        // Skip legs with invalid geometry
      }
    }
  }
  return coords
}

/**
 * Create a mock GeolocationPosition from lat/lng coordinates.
 */
function createMockPosition(lat: number, lng: number): GeolocationPosition {
  return {
    coords: {
      accuracy: 10,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: lat,
      longitude: lng,
      speed: null
    },
    timestamp: Date.now()
  } as GeolocationPosition
}

/**
 * Start GPS simulation mode for development.
 * Replays positions along the itinerary's leg geometries at a configurable speed.
 * Activate by calling from browser console: window.__startGpsSimulation()
 */
export function startGpsSimulation(speedMultiplier = 1) {
  return function (dispatch: any, getState: any) {
    const state = getState()
    const itinerary = state.otp?.goMode?.activeItinerary

    if (!itinerary) {
      console.warn('[Go Mode] No active itinerary for GPS simulation')
      return
    }

    const coords = extractItineraryCoordinates(itinerary)
    if (coords.length === 0) {
      console.warn('[Go Mode] No coordinates found in itinerary')
      return
    }

    // Clean up any existing simulation
    if (gpsSimulationIntervalId) {
      clearInterval(gpsSimulationIntervalId)
    }

    // Clean up real GPS tracking if running
    if (gpsPollingIntervalId) {
      clearInterval(gpsPollingIntervalId)
      gpsPollingIntervalId = null
    }

    let pointIndex = 0
    const intervalMs = Math.max(500, 2000 / speedMultiplier)

    console.info(
      `[Go Mode] Starting GPS simulation: ${coords.length} points, ` +
        `interval ${intervalMs}ms, speed ${speedMultiplier}x`
    )

    // Dispatch the first point immediately
    const [firstLat, firstLng] = coords[0]
    dispatch(handlePositionUpdate(createMockPosition(firstLat, firstLng)))
    pointIndex = 1

    gpsSimulationIntervalId = setInterval(() => {
      if (pointIndex >= coords.length) {
        console.info('[Go Mode] GPS simulation complete')
        if (gpsSimulationIntervalId) {
          clearInterval(gpsSimulationIntervalId)
          gpsSimulationIntervalId = null
        }
        return
      }

      const [lat, lng] = coords[pointIndex]
      dispatch(handlePositionUpdate(createMockPosition(lat, lng)))
      pointIndex++
    }, intervalMs)
  }
}
