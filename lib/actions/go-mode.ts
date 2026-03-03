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

import { findStopTimesForStop } from './apiV2'
import { MobileScreens } from './ui-constants'
import { setMobileScreen } from './ui'
import type { NotificationEvent } from '../util/go-mode/notification-service'
import type { RouteMatchResult } from '../util/go-mode/position-matching'
import type { TripProgress } from '../util/go-mode/progress-calculator'

// Module-scoped GPS polling interval ID (replaces window.__goModeIntervalId)
let gpsPollingIntervalId: ReturnType<typeof setInterval> | null = null

// Module-scoped visibilitychange handler for cleanup
let visibilityChangeHandler: (() => void) | null = null

// GPS simulation state
interface TimedSimulationPoint {
  coord: [number, number]
  delayMs: number // ms before advancing to next point (at 1x speed)
}

let gpsSimulationTimeoutId: ReturnType<typeof setTimeout> | null = null
let simulationPointIndex = 0
let simulationCoords: TimedSimulationPoint[] = []
let simulationSpeedMultiplier = 1
let simulationActive = false
let simulatedTimeMs = 0 // epoch ms — the "current time" in simulation-land

/**
 * Get the current time for Go Mode calculations.
 * During simulation, returns the simulated clock time (accumulated from schedule delays).
 * During live GPS tracking, returns real wall-clock time.
 */
function getCurrentTime(): Date {
  if (simulationActive && simulatedTimeMs > 0) {
    return new Date(simulatedTimeMs)
  }
  return new Date()
}

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
export const START_GPS_SIMULATION = 'START_GPS_SIMULATION'
export const STOP_GPS_SIMULATION = 'STOP_GPS_SIMULATION'
export const PAUSE_GPS_SIMULATION = 'PAUSE_GPS_SIMULATION'
export const RESUME_GPS_SIMULATION = 'RESUME_GPS_SIMULATION'
export const SET_DEPARTURE_OVERRIDE = 'SET_DEPARTURE_OVERRIDE'
export const UPDATE_SIMULATION_PROGRESS = 'UPDATE_SIMULATION_PROGRESS'

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
export const setDepartureOverride = createAction<number | null>(
  SET_DEPARTURE_OVERRIDE
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
  return async function (dispatch: any, getState: any) {
    // Set state and navigate to Go Mode screen synchronously first,
    // before any async work, to avoid race with the GoModeScreen useEffect
    // that redirects away when isActive is false.
    dispatch(startGoMode({ itinerary }))
    dispatch(setMobileScreen(MobileScreens.GO_MODE))

    // Pre-fetch stop times for all transit boarding stops
    const today = new Date().toISOString().split('T')[0]
    for (const leg of itinerary.legs) {
      if (leg.transitLeg && (leg as any).from?.stopId) {
        try {
          dispatch(
            findStopTimesForStop({
              date: today,
              stopId: (leg as any).from.stopId
            })
          )
        } catch {
          // Silently ignore — departure display degrades gracefully
        }
      }
    }

    // Expose GPS simulation on window for dev console access
    const w = window as any
    w.__startGpsSimulation = (speedMultiplier?: number) => {
      dispatch(startGpsSimulation(speedMultiplier))
    }
    w.__stopGpsSimulation = () => {
      dispatch(stopGpsSimulation())
    }
    w.__pauseGpsSimulation = () => {
      dispatch(pauseGpsSimulation())
    }
    w.__resumeGpsSimulation = () => {
      dispatch(resumeGpsSimulation())
    }

    // Set initial tracking interval based on first leg
    const interval = getTrackingIntervalForLeg(itinerary.legs[0])
    dispatch(updateTrackingInterval({ interval }))

    // Check geolocation permission — if denied, still allow simulation
    let geoDenied = false
    if ('permissions' in navigator) {
      try {
        const result = await navigator.permissions.query({
          name: 'geolocation'
        })
        if (result.state === 'denied') {
          geoDenied = true
        }
      } catch {
        // permissions API not supported, continue anyway
      }
    }

    if (!geoDenied) {
      // Request location permission and start tracking
      dispatch(startPositionTracking())
    }
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

    // Clean up GPS simulation state
    if (gpsSimulationTimeoutId) {
      clearTimeout(gpsSimulationTimeoutId)
      gpsSimulationTimeoutId = null
    }
    simulationActive = false
    simulationPointIndex = 0
    simulationCoords = []
    simulatedTimeMs = 0

    // Remove console simulation helpers
    const w = window as any
    delete w.__startGpsSimulation
    delete w.__stopGpsSimulation
    delete w.__pauseGpsSimulation
    delete w.__resumeGpsSimulation

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
      // Skip real GPS updates while simulation is running
      if (simulationActive) return
      navigator.geolocation.getCurrentPosition(
        (position) => {
          // Double-check: simulation may have started while getCurrentPosition was pending
          if (simulationActive) return
          dispatch(handlePositionUpdate(position))
        },
        (error) => {
          if (simulationActive) return
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
        // Skip if simulation started while waiting for initial GPS fix
        if (simulationActive) return
        dispatch(handlePositionUpdate(position))
      },
      (error) => {
        initialResolved = true
        clearTimeout(initialTimeout)
        if (simulationActive) return
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

      // Restart tracking with new interval (but not during simulation)
      if (!simulationActive) {
        if (gpsPollingIntervalId) {
          clearInterval(gpsPollingIntervalId)
          gpsPollingIntervalId = null
        }
        dispatch(startPositionTracking())
      }
    }

    // Calculate progress — use simulated clock during simulation, real time for live GPS
    const currentTime = getCurrentTime()
    const departureOverride = goMode.departureOverride ?? null
    const progress = calculateTripProgress(
      currentTime,
      itinerary,
      routeMatch,
      departureOverride
    )

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
 * Haversine distance in meters between two [lat, lng] points.
 */
function haversineDistance(a: [number, number], b: [number, number]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const R = 6371000
  const dLat = toRad(b[0] - a[0])
  const dLon = toRad(b[1] - a[1])
  const sinLat = Math.sin(dLat / 2)
  const sinLon = Math.sin(dLon / 2)
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * sinLon * sinLon
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * Find the index of the polyline point closest to a given [lat, lng],
 * searching from startIdx onward.
 */
function findClosestPolylineIndex(
  decoded: Array<[number, number]>,
  lat: number,
  lon: number,
  startIdx: number
): number {
  let bestIdx = startIdx
  let bestDist = Infinity
  for (let i = startIdx; i < decoded.length; i++) {
    const d = haversineDistance(decoded[i], [lat, lon])
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return bestIdx
}

interface IntermediatePlace {
  arrivalTime: number
  departureTime: number
  lat: number
  lon: number
  name: string
  stop?: { code: string; gtfsId: string; id: string }
}

/**
 * Build timed simulation points for a transit leg using stop schedule data.
 * Each polyline segment between stops gets timing derived from the timetable.
 */
function buildTransitTimedPoints(
  leg: Leg,
  decoded: Array<[number, number]>,
  places: IntermediatePlace[]
): TimedSimulationPoint[] {
  const points: TimedSimulationPoint[] = []

  // Build stop sequence: leg origin, intermediate places, leg destination
  const stops: Array<{
    arrivalTime: number
    departureTime: number
    lat: number
    lon: number
    name: string
  }> = []

  // Origin
  const legFrom = (leg as any).from
  stops.push({
    arrivalTime: leg.startTime,
    departureTime: leg.startTime,
    lat: legFrom?.lat ?? decoded[0][0],
    lon: legFrom?.lon ?? decoded[0][1],
    name: legFrom?.name ?? 'Origin'
  })

  // Intermediate places
  for (const p of places) {
    stops.push({
      arrivalTime: p.arrivalTime,
      departureTime: p.departureTime,
      lat: p.lat,
      lon: p.lon,
      name: p.name
    })
  }

  // Destination
  const legTo = (leg as any).to
  stops.push({
    arrivalTime: leg.endTime,
    departureTime: leg.endTime,
    lat: legTo?.lat ?? decoded[decoded.length - 1][0],
    lon: legTo?.lon ?? decoded[decoded.length - 1][1],
    name: legTo?.name ?? 'Destination'
  })

  // Map each stop to its nearest polyline index
  const stopPolyIndices: number[] = []
  let searchFrom = 0
  for (const stop of stops) {
    const idx = findClosestPolylineIndex(
      decoded,
      stop.lat,
      stop.lon,
      searchFrom
    )
    stopPolyIndices.push(idx)
    searchFrom = idx
  }

  // Build timed points for each segment between consecutive stops
  for (let s = 0; s < stops.length - 1; s++) {
    const fromIdx = stopPolyIndices[s]
    const toIdx = stopPolyIndices[s + 1]
    const travelTimeMs = stops[s + 1].arrivalTime - stops[s].departureTime
    const segmentPointCount = Math.max(1, toIdx - fromIdx)
    const delayPerPoint = Math.max(50, travelTimeMs / segmentPointCount)

    // Add travel points for this segment
    const endIdx = s < stops.length - 2 ? toIdx : toIdx + 1 // include final point on last segment
    for (let i = fromIdx; i < endIdx && i < decoded.length; i++) {
      // Skip duplicate of previous segment's last point
      if (s > 0 && i === fromIdx) continue
      points.push({ coord: decoded[i], delayMs: delayPerPoint })
    }

    // Add dwell time at the arrival stop (except for the final destination)
    if (s < stops.length - 2) {
      const dwellMs = stops[s + 1].departureTime - stops[s + 1].arrivalTime
      if (dwellMs > 0) {
        // Add a dwell point at the stop location
        points.push({ coord: decoded[toIdx], delayMs: dwellMs })
      }
    }
  }

  // Handle edge case: if no points were generated, fall back to even distribution
  if (points.length === 0) {
    const delayMs = (leg.duration * 1000) / decoded.length
    for (const coord of decoded) {
      points.push({ coord, delayMs: Math.max(50, delayMs) })
    }
  }

  console.info(
    `[Go Mode] Transit leg "${stops[0].name}" → "${
      stops[stops.length - 1].name
    }": ` +
      `${stops.length} stops, ${points.length} simulation points, ` +
      `${Math.round((leg.duration * 1000) / 1000)}s scheduled duration`
  )

  return points
}

/**
 * Extract timed simulation points from an itinerary.
 * Transit legs with intermediatePlaces use schedule-aware timing.
 * Walk/bike legs use even time distribution.
 */
function extractItineraryTimedPoints(
  itinerary: Itinerary
): TimedSimulationPoint[] {
  const points: TimedSimulationPoint[] = []
  for (const leg of itinerary.legs) {
    if (!leg.legGeometry?.points) continue
    try {
      const decoded = polyline.decode(leg.legGeometry.points)
      if (decoded.length === 0) continue

      const places = (leg as any).intermediatePlaces as
        | IntermediatePlace[]
        | undefined
      if (leg.transitLeg && places && places.length > 0) {
        points.push(...buildTransitTimedPoints(leg, decoded, places))
      } else {
        // Non-transit or no schedule data: even distribution
        const delayMs = Math.max(50, (leg.duration * 1000) / decoded.length)
        for (const coord of decoded) {
          points.push({ coord, delayMs })
        }
      }
    } catch {
      // Skip legs with invalid geometry
    }
  }
  return points
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
    timestamp:
      simulationActive && simulatedTimeMs > 0 ? simulatedTimeMs : Date.now()
  } as GeolocationPosition
}

/**
 * Schedule the next simulation point using setTimeout.
 * Each point has its own delay (derived from schedule or even distribution).
 */
function scheduleNextSimulationPoint(dispatch: any) {
  if (!simulationActive || simulationPointIndex >= simulationCoords.length) {
    simulationActive = false
    gpsSimulationTimeoutId = null
    dispatch({ type: STOP_GPS_SIMULATION })
    console.info('[Go Mode] GPS simulation complete')
    return
  }

  const point = simulationCoords[simulationPointIndex]
  const delay = Math.max(50, point.delayMs / simulationSpeedMultiplier)

  gpsSimulationTimeoutId = setTimeout(() => {
    if (!simulationActive) return

    // Advance the simulated clock by the un-scaled delay (actual schedule time)
    simulatedTimeMs += point.delayMs

    const { coord } = simulationCoords[simulationPointIndex]
    dispatch(handlePositionUpdate(createMockPosition(coord[0], coord[1])))
    simulationPointIndex++
    dispatch({
      payload: { pointIndex: simulationPointIndex },
      type: UPDATE_SIMULATION_PROGRESS
    })

    scheduleNextSimulationPoint(dispatch)
  }, delay)
}

/**
 * Start GPS simulation mode for development.
 * For transit legs with schedule data, timing follows the bus timetable.
 * For walk/bike legs, positions are evenly distributed over leg duration.
 */
export function startGpsSimulation(speedMultiplier = 1) {
  return function (dispatch: any, getState: any) {
    const state = getState()
    const itinerary = state.otp?.goMode?.activeItinerary

    if (!itinerary) {
      console.warn('[Go Mode] No active itinerary for GPS simulation')
      return
    }

    const timedPoints = extractItineraryTimedPoints(itinerary)
    if (timedPoints.length === 0) {
      console.warn('[Go Mode] No coordinates found in itinerary')
      return
    }

    // Clean up any existing simulation
    if (gpsSimulationTimeoutId) {
      clearTimeout(gpsSimulationTimeoutId)
      gpsSimulationTimeoutId = null
    }

    // Clean up real GPS tracking if running
    if (gpsPollingIntervalId) {
      clearInterval(gpsPollingIntervalId)
      gpsPollingIntervalId = null
    }

    // Store in module scope for pause/resume
    simulationCoords = timedPoints
    simulationPointIndex = 0
    simulationSpeedMultiplier = speedMultiplier
    simulationActive = true
    simulatedTimeMs = itinerary.startTime // begin simulated clock at itinerary start

    console.info(
      `[Go Mode] Starting schedule-aware GPS simulation: ${timedPoints.length} points, ` +
        `speed ${speedMultiplier}x`
    )

    dispatch({
      payload: { speedMultiplier, totalPoints: timedPoints.length },
      type: START_GPS_SIMULATION
    })

    // Dispatch the first point immediately
    const first = timedPoints[0]
    dispatch(
      handlePositionUpdate(createMockPosition(first.coord[0], first.coord[1]))
    )
    simulationPointIndex = 1
    dispatch({
      payload: { pointIndex: simulationPointIndex },
      type: UPDATE_SIMULATION_PROGRESS
    })

    // Start the setTimeout chain
    scheduleNextSimulationPoint(dispatch)
  }
}

/**
 * Stop GPS simulation and optionally resume real GPS tracking.
 */
export function stopGpsSimulation() {
  return function (dispatch: any, getState: any) {
    if (gpsSimulationTimeoutId) {
      clearTimeout(gpsSimulationTimeoutId)
      gpsSimulationTimeoutId = null
    }
    simulationActive = false

    simulationPointIndex = 0
    simulationCoords = []
    simulatedTimeMs = 0

    dispatch({ type: STOP_GPS_SIMULATION })

    // Resume real GPS polling if Go Mode is still active
    const state = getState()
    if (state.otp?.goMode?.isActive) {
      dispatch(startPositionTracking())
    }

    console.info('[Go Mode] GPS simulation stopped')
  }
}

/**
 * Pause GPS simulation — preserves current position index.
 */
export function pauseGpsSimulation() {
  return function (dispatch: any) {
    if (gpsSimulationTimeoutId) {
      clearTimeout(gpsSimulationTimeoutId)
      gpsSimulationTimeoutId = null
    }
    simulationActive = false

    dispatch({ type: PAUSE_GPS_SIMULATION })
    console.info(
      `[Go Mode] GPS simulation paused at point ${simulationPointIndex}/${simulationCoords.length}`
    )
  }
}

/**
 * Resume GPS simulation from where it was paused.
 */
export function resumeGpsSimulation() {
  return function (dispatch: any, getState: any) {
    const state = getState()
    const sim = state.otp?.goMode?.simulation

    if (!sim || sim.status !== 'paused') {
      console.warn('[Go Mode] Cannot resume — simulation is not paused')
      return
    }

    if (simulationPointIndex >= simulationCoords.length) {
      console.warn('[Go Mode] Cannot resume — simulation already complete')
      dispatch({ type: STOP_GPS_SIMULATION })
      return
    }

    simulationSpeedMultiplier = sim.speedMultiplier
    simulationActive = true

    dispatch({ type: RESUME_GPS_SIMULATION })

    console.info(
      `[Go Mode] GPS simulation resumed at point ${simulationPointIndex}/${simulationCoords.length}`
    )

    scheduleNextSimulationPoint(dispatch)
  }
}
