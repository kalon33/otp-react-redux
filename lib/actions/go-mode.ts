import { createAction } from 'redux-actions'
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
  return function (dispatch: any, getState: any) {
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
  return function (dispatch: any, getState: any) {
    const state = getState()
    const trackingId = state.otp?.goMode?.tracking?.trackingId

    if (trackingId) {
      navigator.geolocation.clearWatch(trackingId)
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

    // Initial position
    pollPosition()

    // Set up polling interval
    const state = getState()
    const interval = state.otp?.goMode?.tracking?.interval || 8000
    const intervalId = setInterval(pollPosition, interval)

    // Store interval ID in a way we can clear it later
    // Note: This is a workaround - ideally we'd store this in Redux
    // but for now we'll use a module-level variable
    if (typeof window !== 'undefined') {
      // eslint-disable-next-line @typescript-eslint/no-extra-semi
      ;(window as any).__goModeIntervalId = intervalId
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
      if (typeof window !== 'undefined') {
        const oldIntervalId = (window as any).__goModeIntervalId
        if (oldIntervalId) {
          clearInterval(oldIntervalId)
        }
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
