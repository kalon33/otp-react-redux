/* eslint-disable sort-imports-es6-autofix/sort-imports-es6 -- the autofixer is
   non-convergent for this file's mix of value + type relative imports (it keeps
   hoisting a type import above sibling value imports); order is hand-maintained. */
import { createAction } from 'redux-actions'
import { format, utcToZonedTime } from 'date-fns-tz'
import coreUtils from '@opentripplanner/core-utils'
import polyline from '@mapbox/polyline'
import type { Itinerary, LatLngArray, Leg } from '@opentripplanner/types'

import {
  getDownstreamStops,
  hasLiveArrival,
  pickBestAlightOption,
  selectCandidateStops
} from '../util/go-mode/alight-optimizer'
import type { AlightCandidateResult } from '../util/go-mode/alight-optimizer'
import { calculateTripProgress } from '../util/go-mode/progress-calculator'
import {
  checkForNotifications,
  shouldAutoReroute,
  showNotification
} from '../util/go-mode/notification-service'
import {
  findNearbyVehicles,
  matchUserToVehicle,
  shouldShowBoardingPrompt,
  speedAdjustedRadius
} from '../util/go-mode/vehicle-matching'
import { getRoutingProfile } from '../util/routing-profiles'
import {
  calculateDistance,
  matchPositionToRoute,
  shouldTransitionToNextLeg
} from '../util/go-mode/position-matching'
import { sendPush } from '../util/go-mode/push-service'
import type {
  NotificationEvent,
  NotificationType
} from '../util/go-mode/notification-service'
import type { RouteMatchResult } from '../util/go-mode/position-matching'
import type { TripProgress } from '../util/go-mode/progress-calculator'
import {
  beginReplay,
  endReplay,
  isReplayActive,
  setReplayClock
} from '../util/go-mode/replay/replay-engine'
import { isTripRecordingEnabled } from '../util/debug-log'
import {
  hasNativeGps,
  startNativeGps,
  stopNativeGps
} from '../util/go-mode/native-gps'

import {
  fetchOnboardCandidatePlan,
  fetchRerouteSnapshotPlan,
  findRoutesNearby,
  findStopTimesForStop,
  findTrip,
  getBasePlanParts,
  getVehiclePositionsForRoute,
  onboardGraphQLQuery
} from './apiV2'
import { MobileScreens } from './ui-constants'
import { setMobileScreen } from './ui'
import { setQueryParam } from './form'

// Module-scoped GPS polling interval ID (replaces window.__goModeIntervalId)
let gpsPollingIntervalId: ReturnType<typeof setInterval> | null = null

// Module-scoped vehicle position polling interval ID
let vehiclePositionIntervalId: ReturnType<typeof setInterval> | null = null

// Reroute-snapshot capture interval (recording only). Periodically records the
// "alternatives to finish the trip" as a request/response pair so a replay can
// surface them by timestamp for debugging. See captureRerouteSnapshot.
let rerouteSnapshotIntervalId: ReturnType<typeof setInterval> | null = null
// How often to capture; each tick is a real isolated plan() call.
const REROUTE_SNAPSHOT_INTERVAL_MS = 90000

// Module-scoped visibilitychange handler for cleanup
let visibilityChangeHandler: (() => void) | null = null

// A single recorded GPS fix from a replay fixture (see build-fixture.js).
interface ReplayGpsFix {
  accuracy?: number | null
  heading?: number | null
  lat: number
  lon: number
  speed?: number | null
  tMs: number
}

// GPS simulation state
interface TimedSimulationPoint {
  // ms before advancing to next point (at 1x speed)
  // Optional recorded fix metadata (trip replay only). When present these are
  // played back verbatim so vehicle-matching heading/speed logic sees the real
  // values instead of the synthetic defaults used for itinerary-derived sims.
  accuracy?: number | null
  coord: [number, number]
  delayMs: number
  heading?: number | null
  speed?: number | null
}

let gpsSimulationTimeoutId: ReturnType<typeof setTimeout> | null = null
let simulationPointIndex = 0
let simulationCoords: TimedSimulationPoint[] = []
let simulationSpeedMultiplier = 1
let simulationActive = false
let simulatedTimeMs = 0 // epoch ms — the "current time" in simulation-land

// Trip replay: the transit route currently being tracked. During replay the
// wall-clock 15s vehicle poll is disabled; vehicle snapshots are instead
// refreshed from this route on each simulated GPS tick (see
// scheduleNextSimulationPoint) so the series stays aligned to the sim clock.
let replayTrackedRouteId: string | null = null

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

const { randId } = coreUtils.storage

// Action types
export const ADD_NOTIFICATION = 'ADD_NOTIFICATION'
export const CLEAR_VEHICLE_MATCH = 'CLEAR_VEHICLE_MATCH'
export const CONFIRM_VEHICLE = 'CONFIRM_VEHICLE'
export const DISMISS_BOARDING_PROMPT = 'DISMISS_BOARDING_PROMPT'
export const PAUSE_GPS_SIMULATION = 'PAUSE_GPS_SIMULATION'
export const REROUTE_SNAPSHOT = 'REROUTE_SNAPSHOT'
export const RESUME_GPS_SIMULATION = 'RESUME_GPS_SIMULATION'
export const SET_DEPARTURE_OVERRIDE = 'SET_DEPARTURE_OVERRIDE'
export const SET_NOTIFICATION_CONFIG = 'SET_NOTIFICATION_CONFIG'
export const SET_TRACKING_ERROR = 'SET_TRACKING_ERROR'
export const SET_TRANSIT_LEG_ENTERED = 'SET_TRANSIT_LEG_ENTERED'
export const SHOW_BOARDING_PROMPT = 'SHOW_BOARDING_PROMPT'
export const START_GO_MODE = 'START_GO_MODE'
export const START_GPS_SIMULATION = 'START_GPS_SIMULATION'
export const STOP_GO_MODE = 'STOP_GO_MODE'
export const STOP_GPS_SIMULATION = 'STOP_GPS_SIMULATION'
export const TOGGLE_MAP_FOLLOW = 'TOGGLE_MAP_FOLLOW'
export const TRANSITION_LEG = 'TRANSITION_LEG'
export const UPDATE_NEARBY_VEHICLES = 'UPDATE_NEARBY_VEHICLES'
export const UPDATE_POSITION = 'UPDATE_POSITION'
export const UPDATE_PROGRESS = 'UPDATE_PROGRESS'
export const UPDATE_ROUTE_MATCH = 'UPDATE_ROUTE_MATCH'
export const UPDATE_SIMULATION_PROGRESS = 'UPDATE_SIMULATION_PROGRESS'
export const UPDATE_TRACKING_INTERVAL = 'UPDATE_TRACKING_INTERVAL'
export const UPDATE_VEHICLE_MATCH = 'UPDATE_VEHICLE_MATCH'

// Live re-route action types
export const CLEAR_REROUTE = 'CLEAR_REROUTE'
export const SET_REROUTE_RESULT = 'SET_REROUTE_RESULT'
export const START_REROUTE = 'START_REROUTE'

// "I'm already on the bus" onboard-flow action types
export const BEGIN_ONBOARD_FLOW = 'BEGIN_ONBOARD_FLOW'
export const CLEAR_ONBOARD = 'CLEAR_ONBOARD'
export const SET_ONBOARD_RESULT = 'SET_ONBOARD_RESULT'
export const SET_ONBOARD_STATUS = 'SET_ONBOARD_STATUS'
export const SET_ONBOARD_TRIP = 'SET_ONBOARD_TRIP'
export const SET_ONBOARD_VEHICLE = 'SET_ONBOARD_VEHICLE'
export const START_ONBOARD_OPTIMIZE = 'START_ONBOARD_OPTIMIZE'

// Simple action creators
export const clearVehicleMatch = createAction(CLEAR_VEHICLE_MATCH)
export const dismissBoardingPrompt = createAction(DISMISS_BOARDING_PROMPT)
export const showBoardingPromptAction = createAction(SHOW_BOARDING_PROMPT)
export const startGoMode = createAction<{
  itinerary: Itinerary
  originalFrom?: any
}>(START_GO_MODE)
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

export const startReroute = createAction<{ searchId: string }>(START_REROUTE)
// Accepts the full list of alternatives (preferred), or a single itinerary /
// null for the legacy "best candidate only" callers. The reducer normalizes.
export const setRerouteResult = createAction<Itinerary[] | Itinerary | null>(
  SET_REROUTE_RESULT
)
export const clearReroute = createAction(CLEAR_REROUTE)

export const beginOnboardFlowAction =
  createAction<{ originalFrom?: any }>(BEGIN_ONBOARD_FLOW)
export const clearOnboard = createAction(CLEAR_ONBOARD)
export const setOnboardStatus = createAction<string>(SET_ONBOARD_STATUS)
export const setOnboardVehicle = createAction<{
  label: string | null
  nextStopId: string | null
  routeId: string | null
  tripId: string | null
  vehicleId: string
}>(SET_ONBOARD_VEHICLE)
export const setOnboardTrip = createAction<any>(SET_ONBOARD_TRIP)
export const startOnboardOptimize = createAction<{
  candidates: Array<{
    busArrivalEpoch: number
    realtime: boolean
    stopId: string
    stopName: string
  }>
}>(START_ONBOARD_OPTIMIZE)
export const setOnboardResult = createAction<any>(SET_ONBOARD_RESULT)

/**
 * Derive the GTFS route id from an itinerary leg.
 * OTP2 returns the route as an object (leg.route.id, aliased to gtfsId);
 * legacy responses use a top-level leg.routeId. Mirrors lib/util/itinerary.tsx.
 */
function getLegRouteId(leg: Leg | undefined): string | null {
  if (!leg) return null
  const route = (leg as any).route
  if (route && typeof route === 'object') return route.id ?? null
  return (leg as any).routeId ?? null
}

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
    // Capture the origin so it can be restored on exit if a mid-trip re-route
    // replaces it with the rider's GPS position.
    const originalFrom = getState().otp.currentQuery?.from || null
    dispatch(startGoMode({ itinerary, originalFrom }))
    dispatch(setMobileScreen(MobileScreens.GO_MODE))

    await dispatch(startGoModeTracking(itinerary))
  }
}

/**
 * Start the live-tracking machinery for an already-active Go Mode trip: stop-time
 * prefetch, dev GPS-simulation hooks, vehicle tracking, and GPS polling. Split out
 * of beginGoMode so a trip restored from storage on reload (see
 * session-persistence) can resume tracking without resetting the restored state.
 */
export function startGoModeTracking(
  itinerary: Itinerary,
  options: { replay?: boolean } = {}
) {
  return async function (dispatch: any) {
    // Pre-fetch stop times for all transit boarding stops
    const today = new Date().toISOString().split('T')[0]
    for (const leg of itinerary.legs) {
      const stopId = (leg as any).from?.stop?.gtfsId
      if (leg.transitLeg && stopId) {
        try {
          dispatch(
            findStopTimesForStop({
              date: today,
              stopId
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

    // Start vehicle tracking if first leg is transit
    const firstLeg = itinerary.legs[0]
    const firstLegRouteId = getLegRouteId(firstLeg)
    if (firstLeg?.transitLeg && firstLegRouteId) {
      dispatch(startVehicleTracking(firstLegRouteId))
    }

    // Trip replay drives position from the recorded GPS track (startTrackReplay),
    // not the device — skip the geolocation permission check and live polling.
    if (options.replay) {
      return
    }

    // Recording sessions only: periodically capture the "alternatives to finish
    // the trip" as request/response pairs for later replay/debugging.
    if (isTripRecordingEnabled()) {
      startRerouteSnapshotCapture(dispatch)
    }

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
  return function (dispatch: any, getState: any) {
    // Capture origin state before stopGoMode wipes the goMode slice.
    const { currentQuery, goMode } = getState().otp
    const originalFrom = goMode?.originalFrom
    const currentFrom = currentQuery?.from

    // Clean up GPS polling interval
    if (gpsPollingIntervalId) {
      clearInterval(gpsPollingIntervalId)
      gpsPollingIntervalId = null
    }

    // Stop the native background-location stream (iOS shell) — ends the blue
    // location indicator and the battery draw between trips.
    stopNativeGps()

    // Clean up vehicle position polling
    if (vehiclePositionIntervalId) {
      clearInterval(vehiclePositionIntervalId)
      vehiclePositionIntervalId = null
    }

    // Stop reroute-snapshot capture (recording sessions)
    stopRerouteSnapshotCapture()

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

    // If a mid-trip re-route replaced the origin with the rider's GPS position,
    // restore the origin they started with so the trip planner isn't left
    // showing "Current location".
    if (
      originalFrom &&
      currentFrom &&
      (currentFrom.lat !== originalFrom.lat ||
        currentFrom.lon !== originalFrom.lon)
    ) {
      dispatch(setQueryParam({ from: originalFrom }))
    }
  }
}

/**
 * Re-plan from the rider's current GPS position to the trip destination using
 * the standard routing pipeline (real OTP results — no fabricated data). The
 * resulting itineraries land in a dedicated search; GoModeScreen surfaces the
 * best one as a Switch/Keep card. Optionally applies a routing profile.
 */
export function reRouteFromCurrentPosition(
  options: { preferences?: any; profileId?: string } = {}
) {
  return function (dispatch: any, getState: any) {
    const state = getState()
    const goMode = state.otp.goMode
    const itinerary: Itinerary | null = goMode?.activeItinerary
    const lastPosition: GeolocationPosition | null =
      goMode?.tracking?.lastPosition
    const legs = itinerary?.legs || []
    const destLeg = legs[legs.length - 1]

    // Need a real position and destination — never fabricate either.
    if (!itinerary || !lastPosition || !destLeg) {
      dispatch(setRerouteResult(null))
      return
    }

    const { homeTimezone } = state.otp.config
    const searchId = randId()
    dispatch(startReroute({ searchId }))

    const payload: any = {
      date: coreUtils.time.getCurrentDate(homeTimezone),
      departArrive: 'NOW',
      from: {
        lat: lastPosition.coords.latitude,
        lon: lastPosition.coords.longitude,
        name: 'Current location'
      },
      time: coreUtils.time.getCurrentTime(homeTimezone),
      to: {
        lat: destLeg.to.lat,
        lon: destLeg.to.lon,
        name: destLeg.to.name
      }
    }

    const profile = options.profileId
      ? getRoutingProfile(options.profileId)
      : undefined
    if (profile) {
      payload.activeProfileId = profile.id
      payload.routingPreferences = profile.prefs
    } else if (options.preferences) {
      payload.routingPreferences = options.preferences
    }

    // Reuse the normal search pipeline; results populate searches[searchId].
    dispatch(setQueryParam(payload, searchId))
  }
}

/**
 * Record the current "alternatives to finish the trip" as a self-contained
 * request/response pair (recording only). Fires an ISOLATED plan from the rider's
 * current position → final destination — no UI/currentQuery side effects, like
 * the onboard alight optimizer — and dispatches REROUTE_SNAPSHOT, which the
 * debug-log captures in full. On replay these are served by nearest timestamp, so
 * "Find another way" at any moment yields the alternatives real at that moment.
 * The recorded `request` (query+variables) is also what a future primed-OTP
 * re-issues to reproduce the response. Best-effort; never disrupts the trip.
 */
export function captureRerouteSnapshot() {
  return async function (dispatch: any, getState: any) {
    const state = getState()
    const goMode = state.otp?.goMode
    const itinerary: Itinerary | null = goMode?.activeItinerary
    const lastPosition: GeolocationPosition | null =
      goMode?.tracking?.lastPosition
    const legs = itinerary?.legs || []
    const destLeg = legs[legs.length - 1]
    // Need a real position and destination — never fabricate either.
    if (!itinerary || !lastPosition || !destLeg) return

    const { homeTimezone } = state.otp.config
    const { modes, modeSettings, numItineraries } = getBasePlanParts(state)
    const routingPreferences = state.otp.currentQuery?.routingPreferences
    const zoned = utcToZonedTime(getCurrentTime().getTime(), homeTimezone)
    const from = {
      lat: lastPosition.coords.latitude,
      lon: lastPosition.coords.longitude,
      name: 'Current location'
    }
    const to = {
      lat: destLeg.to.lat,
      lon: destLeg.to.lon,
      name: destLeg.to.name
    }
    const combo = {
      arriveBy: false,
      date: format(zoned, coreUtils.time.OTP_API_DATE_FORMAT),
      from,
      modes,
      modeSettings,
      numItineraries,
      routingPreferences,
      time: format(zoned, coreUtils.time.OTP_API_TIME_FORMAT),
      to
    }

    try {
      const { query, response, variables } = await dispatch(
        fetchRerouteSnapshotPlan(combo)
      )
      dispatch({
        payload: {
          request: { departArrive: 'NOW', from, modes, query, to, variables },
          response,
          tMs: getCurrentTime().getTime()
        },
        type: REROUTE_SNAPSHOT
      })
    } catch {
      // best-effort — never disrupt the trip
    }
  }
}

/**
 * Start periodic reroute-snapshot capture (recording sessions only). Cadence is
 * the knob (each tick is a real plan() call); overridable via
 * localStorage.otpRerouteSnapshotMs for testing.
 */
function startRerouteSnapshotCapture(dispatch: any) {
  if (rerouteSnapshotIntervalId) return
  let intervalMs = REROUTE_SNAPSHOT_INTERVAL_MS
  try {
    const override = Number(
      window.localStorage?.getItem('otpRerouteSnapshotMs')
    )
    if (override > 0) intervalMs = override
  } catch {
    // ignore
  }
  rerouteSnapshotIntervalId = setInterval(() => {
    dispatch(captureRerouteSnapshot())
  }, intervalMs)
}

function stopRerouteSnapshotCapture() {
  if (rerouteSnapshotIntervalId) {
    clearInterval(rerouteSnapshotIntervalId)
    rerouteSnapshotIntervalId = null
  }
}

/**
 * Map a GTFS route_type to an OTP leg mode string, for synthesizing the bus leg
 * when the route's `mode` field is unavailable.
 */
function gtfsTypeToMode(type: number | undefined): string {
  switch (type) {
    case 0:
      return 'TRAM'
    case 1:
      return 'SUBWAY'
    case 2:
      return 'RAIL'
    case 4:
      return 'FERRY'
    case 3:
    default:
      return 'BUS'
  }
}

/**
 * "I'm already on the bus" — entry point. Captures the rider's trip origin,
 * navigates to the Go Mode screen, starts GPS, and kicks off discovery of the
 * live vehicle they are aboard. A destination must already be set on the query.
 */
export function beginOnboardFlow() {
  return function (dispatch: any, getState: any) {
    const originalFrom = getState().otp.currentQuery?.from || null
    dispatch(beginOnboardFlowAction({ originalFrom }))
    dispatch(setMobileScreen(MobileScreens.GO_MODE))
    dispatch(updateTrackingInterval({ interval: 5000 }))
    dispatch(startPositionTracking())
    dispatch(discoverNearbyVehicles())
  }
}

/**
 * Discover the live transit vehicles near the rider so they can pick the one
 * they are on. Scans every route serving a nearby stop for vehicle positions,
 * then surfaces those within 200m via the boarding prompt. Retries while the
 * initial GPS fix is still being acquired; falls back to manual selection.
 */
export function discoverNearbyVehicles(attempt = 0) {
  return async function (dispatch: any, getState: any) {
    const goMode = getState().otp?.goMode
    if (!goMode?.isActive || goMode.onboard?.status === 'idle') return

    const pos = goMode.tracking?.lastPosition
    if (!pos) {
      if (attempt < 10) {
        setTimeout(() => dispatch(discoverNearbyVehicles(attempt + 1)), 1000)
      } else {
        // No GPS fix — let the rider pick their route manually.
        dispatch(setOnboardStatus('awaiting-selection'))
        dispatch(showBoardingPromptAction())
      }
      return
    }

    const lat = pos.coords.latitude
    const lon = pos.coords.longitude

    // 1. Routes serving nearby stops.
    await dispatch(findRoutesNearby({ lat, lon, radius: 250 }))
    const routes = getState().otp?.transitIndex?.nearbyRoutes || []

    // 2. Live vehicles for each nearby route.
    await Promise.all(
      routes.map((r: { id: string }) =>
        dispatch(getVehiclePositionsForRoute(r.id))
      )
    )

    // 3. Vehicles within range of the rider, across all those routes. The radius
    // is generous (750m): the rider is on a moving bus and GTFS-RT positions lag
    // and are sparse, so a tight radius silently matched nothing. When still none
    // are detected, the prompt offers manual route selection (confirmOnboardRoute).
    const routesIndex = getState().otp?.transitIndex?.routes || {}
    const allVehicles = routes.flatMap(
      (r: { id: string }) => routesIndex[r.id]?.vehicles || []
    )
    const nearby = findNearbyVehicles(
      lat,
      lon,
      allVehicles,
      speedAdjustedRadius(750, pos.coords.speed)
    )

    dispatch({ payload: nearby, type: UPDATE_NEARBY_VEHICLES })
    dispatch(setOnboardStatus('awaiting-selection'))
    dispatch(showBoardingPromptAction())
  }
}

/**
 * Reset the onboard flow back to vehicle discovery (e.g. the rider picked the
 * wrong bus, or no good alight stop was found).
 */
export function rediscoverOnboardVehicles() {
  return function (dispatch: any) {
    dispatch(setOnboardStatus('discovering'))
    dispatch(clearVehicleMatch())
    dispatch(discoverNearbyVehicles())
  }
}

/**
 * Fetch the confirmed vehicle's trip schedule, then optimize the alight stop.
 */
export function loadOnboardScheduleAndOptimize(tripId: string) {
  return async function (dispatch: any, getState: any) {
    await dispatch(findTrip({ tripId }))
    const trip = getState().otp?.transitIndex?.trips?.[tripId]
    if (!trip || !(trip.stopTimes?.length > 0)) {
      dispatch(setOnboardStatus('error'))
      return
    }
    dispatch(setOnboardTrip(trip))
    dispatch(planFromOnboardBus())
  }
}

/**
 * Plan the onward trip from one candidate alight stop to the destination,
 * anchored to the bus's expected arrival at that stop. Issues an ISOLATED
 * background plan (see fetchOnboardCandidatePlan) — no shared currentQuery, no
 * URL change, no active-search churn — and resolves to an AlightCandidateResult.
 */
function fetchCandidatePlan(
  candidate: {
    busArrivalEpoch: number
    realtime: boolean
    stop: { id: string; lat: number; lon: number; name: string }
  },
  ctx: {
    homeTimezone: string
    modeSettings: any
    modes: any
    numItineraries: number
    routingPreferences: any
    to: { lat: number; lon: number; name: string }
  }
) {
  return async function (dispatch: any): Promise<AlightCandidateResult> {
    const { busArrivalEpoch, realtime, stop } = candidate
    const zoned = utcToZonedTime(busArrivalEpoch, ctx.homeTimezone)
    const combo = {
      arriveBy: false,
      date: format(zoned, coreUtils.time.OTP_API_DATE_FORMAT),
      from: { lat: stop.lat, lon: stop.lon, name: stop.name },
      modes: ctx.modes,
      modeSettings: ctx.modeSettings,
      numItineraries: ctx.numItineraries,
      routingPreferences: ctx.routingPreferences,
      time: format(zoned, coreUtils.time.OTP_API_TIME_FORMAT),
      to: { lat: ctx.to.lat, lon: ctx.to.lon, name: ctx.to.name }
    }
    const { error, itineraries } = await dispatch(
      fetchOnboardCandidatePlan(combo)
    )
    return {
      busArrivalEpoch,
      error,
      itineraries,
      realtime,
      stopId: stop.id,
      stopName: stop.name
    }
  }
}

/**
 * Plan the remaining journey from each candidate alight stop to the rider's
 * destination, anchored to each stop's expected bus arrival. All candidates are
 * fetched in parallel as isolated background plans, then the best is scored and
 * dispatched here (deterministic — no selector polling / completion race).
 */
export function planFromOnboardBus() {
  return async function (dispatch: any, getState: any) {
    const state = getState()
    const goMode = state.otp?.goMode
    const trip = goMode?.onboard?.trip
    const vehicle = goMode?.onboard?.vehicle
    const to = state.otp.currentQuery?.to
    const lastPosition = goMode?.tracking?.lastPosition

    if (!trip || !to || to.lat == null || to.lon == null) {
      dispatch(setOnboardResult(null))
      return
    }

    const { homeTimezone } = state.otp.config
    const userPos = lastPosition
      ? {
          lat: lastPosition.coords.latitude,
          lon: lastPosition.coords.longitude
        }
      : null
    const nowMs = Date.now()

    const downstream = getDownstreamStops(
      trip,
      vehicle,
      userPos,
      { lat: to.lat, lon: to.lon },
      nowMs
    )
    const candidates = selectCandidateStops(downstream, 5)
    if (candidates.length === 0) {
      dispatch(setOnboardResult(null))
      return
    }

    dispatch(
      startOnboardOptimize({
        candidates: candidates.map((c) => ({
          busArrivalEpoch: c.busArrivalEpoch,
          realtime: c.realtime,
          stopId: c.stop.id,
          stopName: c.stop.name
        }))
      })
    )

    const { modes, modeSettings, numItineraries } = getBasePlanParts(state)
    const walkOnlyMax = state.otp.config?.itinerary?.maxWalkDistance ?? 1200
    const ctx = {
      homeTimezone,
      modes,
      modeSettings,
      numItineraries,
      routingPreferences: state.otp.currentQuery?.routingPreferences,
      to: { lat: to.lat, lon: to.lon, name: to.name }
    }

    const results = await Promise.all(
      candidates.map((c) => dispatch(fetchCandidatePlan(c, ctx)))
    )

    dispatch(setOnboardResult(pickBestAlightOption(results, { walkOnlyMax })))
  }
}

/**
 * Build a Go Mode itinerary that keeps the rider on their current bus to the
 * chosen alight stop, then continues with the onward plan. The bus leg is
 * synthesized from the trip schedule (geometry sliced between boarding and
 * alight stops, intermediate stops, schedule-anchored times).
 */
function buildOnboardItinerary(
  trip: any,
  vehicle: any,
  best: { busArrivalEpoch: number; itinerary: Itinerary; stopId: string },
  lastPosition: GeolocationPosition | null
): Itinerary {
  const stopTimes = trip.stopTimes || []
  const onward = best.itinerary

  // Boarding stop: the bus's next stop, else the stop nearest the rider.
  let boardIdx = 0
  if (vehicle?.nextStopId) {
    const i = stopTimes.findIndex(
      (st: any) => st.stop?.id === vehicle.nextStopId
    )
    if (i >= 0) boardIdx = i
  } else if (lastPosition) {
    let bestDist = Infinity
    stopTimes.forEach((st: any, i: number) => {
      if (st.stop?.lat == null || st.stop?.lon == null) return
      const d = haversineDistance(
        [lastPosition.coords.latitude, lastPosition.coords.longitude],
        [st.stop.lat, st.stop.lon]
      )
      if (d < bestDist) {
        bestDist = d
        boardIdx = i
      }
    })
  }

  let alightIdx = stopTimes.findIndex((st: any) => st.stop?.id === best.stopId)
  if (alightIdx < 0 || alightIdx <= boardIdx) {
    alightIdx = Math.min(boardIdx + 1, stopTimes.length - 1)
  }

  const boardStop = stopTimes[boardIdx]?.stop
  const alightStop = stopTimes[alightIdx]?.stop
  // If the trip schedule lacks usable board/alight stop data we can't synthesize
  // the bus leg — fall back to the onward plan so the rider still gets guidance
  // to their destination rather than crashing.
  if (!boardStop || !alightStop) {
    return onward
  }
  const anchorSd = stopTimes[boardIdx].scheduledDeparture
  const busLegStart = Date.now()
  // Prefer the live (GPS-fed) realtime arrival per stop; otherwise anchor the
  // scheduled spacing to the start of the bus leg.
  const stopEpoch = (i: number) => {
    const st = stopTimes[i]
    if (hasLiveArrival(st)) {
      return (st.serviceDay + st.realtimeArrival) * 1000
    }
    return busLegStart + (st.scheduledDeparture - anchorSd) * 1000
  }

  // Slice the trip geometry between boarding and alight stops.
  let geomPoints = trip.geometry?.points || ''
  try {
    const decoded = trip.geometry?.points
      ? polyline.decode(trip.geometry.points)
      : []
    if (decoded.length) {
      const startGeo = findClosestPolylineIndex(
        decoded,
        boardStop.lat,
        boardStop.lon,
        0
      )
      const endGeo = findClosestPolylineIndex(
        decoded,
        alightStop.lat,
        alightStop.lon,
        startGeo
      )
      geomPoints = polyline.encode(decoded.slice(startGeo, endGeo + 1))
    }
  } catch {
    // Keep the full geometry on failure — guidance still works.
  }

  const intermediatePlaces = []
  for (let i = boardIdx + 1; i < alightIdx; i++) {
    const st = stopTimes[i]
    if (!st?.stop) continue
    const t = stopEpoch(i)
    intermediatePlaces.push({
      arrivalTime: t,
      departureTime: t,
      lat: st.stop.lat,
      lon: st.stop.lon,
      name: st.stop.name,
      stop: { code: st.stop.code, gtfsId: st.stop.id, id: st.stop.id }
    })
  }

  const routeId = vehicle?.routeId || trip.route?.id || null
  const mode = trip.route?.mode || gtfsTypeToMode(trip.route?.type)

  const busLeg: any = {
    distance: 0,
    duration: (best.busArrivalEpoch - busLegStart) / 1000,
    endTime: best.busArrivalEpoch,
    from: {
      lat: boardStop.lat,
      lon: boardStop.lon,
      name: boardStop.name,
      stop: { code: boardStop.code, gtfsId: boardStop.id, id: boardStop.id },
      stopId: boardStop.id
    },
    headsign: trip.tripHeadsign,
    intermediatePlaces,
    legGeometry: { length: geomPoints.length, points: geomPoints },
    mode,
    route: {
      color: trip.route?.color,
      id: routeId,
      longName: trip.route?.longName,
      shortName: trip.route?.shortName
    },
    routeLongName: trip.route?.longName,
    routeShortName: trip.route?.shortName,
    startTime: busLegStart,
    to: {
      lat: alightStop.lat,
      lon: alightStop.lon,
      name: alightStop.name,
      stop: { code: alightStop.code, gtfsId: alightStop.id, id: alightStop.id },
      stopId: alightStop.id
    },
    transitLeg: true
  }

  const legs = [busLeg, ...(onward.legs || [])]
  const transitLegCount = legs.filter((l: any) => l.transitLeg).length

  return {
    ...onward,
    duration: (onward.endTime - busLegStart) / 1000,
    endTime: onward.endTime,
    legs,
    startTime: busLegStart,
    transfers: Math.max(0, transitLegCount - 1)
  } as Itinerary
}

/**
 * Commit to the recommended alight stop: synthesize the full itinerary and hand
 * off into live Go Mode tracking, keeping the same bus confirmed as the vehicle.
 */
export function confirmOnboardAlightStop() {
  return function (dispatch: any, getState: any) {
    const goMode = getState().otp?.goMode
    const best = goMode?.onboard?.bestAlightStop
    const trip = goMode?.onboard?.trip
    const vehicle = goMode?.onboard?.vehicle
    if (!best || !trip) return

    const itinerary = buildOnboardItinerary(
      trip,
      vehicle,
      best,
      goMode.tracking?.lastPosition || null
    )

    dispatch(clearOnboard())
    dispatch(beginGoMode(itinerary))

    // beginGoMode resets the vehicle match; re-confirm this bus so tracking
    // stays locked to the vehicle the rider is already aboard.
    if (vehicle?.vehicleId) {
      setTimeout(() => {
        dispatch({
          payload: {
            confidence: 'confirmed' as const,
            distanceMeters: null,
            label: vehicle.label || vehicle.vehicleId,
            lastSeen: Date.now(),
            vehicleId: vehicle.vehicleId
          },
          type: CONFIRM_VEHICLE
        })
      }, 0)
    }
  }
}

/**
 * Start GPS position tracking
 */
export function startPositionTracking() {
  return function (dispatch: any, getState: any) {
    // Native iOS shell: a continuous background-location stream replaces the
    // browser poll entirely. It keeps delivering fixes with the screen locked
    // (the whole reason the shell exists) at ~1/s — see native-gps.ts.
    if (hasNativeGps()) {
      startNativeGps(
        (position) => {
          if (!simulationActive) dispatch(handlePositionUpdate(position))
        },
        (error) => {
          if (!simulationActive) dispatch(setTrackingError(error as any))
        }
      )
      return
    }

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
// Notification types worth a real phone push (vs in-app toast only). Kept tight
// so the rider's phone only buzzes for time-critical, act-now moments.
const PUSH_NOTIFICATION_TYPES = new Set<NotificationType>([
  'LEAVE_SOON',
  'CONNECTION_WARNING',
  'ARRIVING_STOP'
])

export function handlePositionUpdate(position: GeolocationPosition) {
  return function (dispatch: any, getState: any) {
    const state = getState()
    const goMode = state.otp?.goMode

    if (!goMode?.isActive) {
      return
    }

    // During the "I'm on the bus" onboard flow there is no active itinerary
    // yet; still record position so vehicle discovery and schedule anchoring
    // (alight-optimizer) can use the rider's location.
    if (!goMode.activeItinerary) {
      dispatch(updatePosition(position))
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

      // Handle vehicle tracking on leg transitions
      const previousLeg = itinerary.legs[previousLegIndex]
      if (previousLeg?.transitLeg) {
        dispatch(stopVehicleTracking())
      }
      const newLegRouteId = getLegRouteId(newLeg)
      if (newLeg?.transitLeg && newLegRouteId) {
        dispatch(startVehicleTracking(newLegRouteId))
      }

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

    // Perform vehicle matching on transit legs
    const currentLegForVehicle = itinerary.legs[routeMatch.legIndex]
    const currentLegRouteId = getLegRouteId(currentLegForVehicle)
    if (currentLegForVehicle?.transitLeg && currentLegRouteId) {
      dispatch(performVehicleMatching(currentLegRouteId))
    }

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
      },
      itinerary.legs
    )

    // Show notifications. Always record them in state (so replay assertions and
    // the debug log see the sequence), but suppress the real-world side effects
    // (browser notification/vibration and the Pushover relay) during replay so a
    // fast offline replay loop doesn't buzz the phone.
    const replaying = isReplayActive()
    notifications.forEach((notification) => {
      dispatch(addNotification(notification))
      if (!replaying) {
        showNotification(
          notification,
          goMode.notifications || {
            enabled: true,
            soundEnabled: false,
            vibrationEnabled: true
          }
        )
        // Forward the highest-value alerts to the phone as a real push (Pushover).
        // Dedup is already guaranteed upstream by checkForNotifications, so each
        // fires at most once. Limited to a few types to avoid push spam.
        if (PUSH_NOTIFICATION_TYPES.has(notification.type)) {
          sendPush({
            message: notification.message,
            priority: notification.priority === 'high' ? 1 : 0,
            title: notification.title
          })
        }
      }
    })

    // Proactively offer a re-route when a connection is at risk or the rider
    // has drifted off-route. Surfaced as a Switch/Keep card — never swapped
    // automatically. The helper guards on reRoute.status === 'idle'.
    if (shouldAutoReroute(notifications, goMode.reRoute?.status || 'idle')) {
      dispatch(reRouteFromCurrentPosition())
    }
  }
}

/**
 * Start polling vehicle positions for a transit route.
 */
export function startVehicleTracking(routeId: string) {
  return function (dispatch: any) {
    // Clean up any existing interval
    if (vehiclePositionIntervalId) {
      clearInterval(vehiclePositionIntervalId)
      vehiclePositionIntervalId = null
    }

    // Fetch immediately, then every 15 seconds
    dispatch(getVehiclePositionsForRoute(routeId))

    if (isReplayActive()) {
      // Replay drives vehicle refresh off the simulated clock (per GPS tick in
      // scheduleNextSimulationPoint), not wall-clock — so fast/slow playback
      // stays deterministic. Just remember which route to refresh.
      replayTrackedRouteId = routeId
    } else {
      vehiclePositionIntervalId = setInterval(() => {
        dispatch(getVehiclePositionsForRoute(routeId))
        dispatch(performVehicleMatching(routeId))
      }, 15000)
    }

    dispatch({
      payload: getCurrentTime().getTime(),
      type: SET_TRANSIT_LEG_ENTERED
    })
  }
}

/**
 * Stop polling vehicle positions.
 */
export function stopVehicleTracking() {
  return function (dispatch: any) {
    if (vehiclePositionIntervalId) {
      clearInterval(vehiclePositionIntervalId)
      vehiclePositionIntervalId = null
    }
    replayTrackedRouteId = null
    dispatch(clearVehicleMatch())
  }
}

/**
 * Match user position against live vehicle positions.
 */
export function performVehicleMatching(routeId: string) {
  return function (dispatch: any, getState: any) {
    const state = getState()
    const goMode = state.otp?.goMode
    if (!goMode?.isActive) return

    const userPos = goMode.tracking.lastPosition
    if (!userPos) return

    const vehicles = state.otp?.transitIndex?.routes?.[routeId]?.vehicles || []
    if (vehicles.length === 0) return

    const previousMatch = goMode.vehicleMatch?.match || null

    // Skip matching if already user-confirmed
    if (previousMatch?.confidence === 'confirmed') return

    // Widen the match radius by rider speed: on a moving bus the GTFS-RT
    // position lags behind the rider (freeway BRT can outrun the feed by
    // several hundred meters), so fixed walking-scale radii never match.
    const riderSpeed = userPos.coords.speed
    const matchResult = matchUserToVehicle(
      userPos.coords.latitude,
      userPos.coords.longitude,
      userPos.coords.heading,
      vehicles,
      routeId,
      previousMatch,
      speedAdjustedRadius(80, riderSpeed)
    )

    // Track consecutive matches
    const prevId = previousMatch?.vehicleId
    let consecutiveMatches = goMode.vehicleMatch?.consecutiveMatches || 0
    if (matchResult.vehicleId && matchResult.vehicleId === prevId) {
      consecutiveMatches++
      // Promote to 'high' after 2+ consecutive matches with same vehicle
      if (consecutiveMatches >= 2 && matchResult.confidence === 'medium') {
        matchResult.confidence = 'high'
      }
    } else {
      consecutiveMatches = matchResult.vehicleId ? 1 : 0
    }

    dispatch({
      payload: { consecutiveMatches, match: matchResult },
      type: UPDATE_VEHICLE_MATCH
    })

    // Update nearby vehicles for boarding prompt (same speed widening)
    const nearby = findNearbyVehicles(
      userPos.coords.latitude,
      userPos.coords.longitude,
      vehicles,
      speedAdjustedRadius(200, riderSpeed)
    )
    dispatch({ payload: nearby, type: UPDATE_NEARBY_VEHICLES })

    // Check if boarding prompt should be shown
    if (
      !goMode.boardingPrompt?.shown &&
      shouldShowBoardingPrompt(
        matchResult,
        goMode.boardingPrompt?.transitLegEnteredAt,
        getCurrentTime().getTime(),
        goMode.boardingPrompt?.lastDismissedAt
      )
    ) {
      dispatch(showBoardingPromptAction())
    }
  }
}

/**
 * User selected a vehicle from the boarding prompt.
 */
export function confirmVehicleSelection(vehicleId: string) {
  return function (dispatch: any, getState: any) {
    const state = getState()
    const goMode = state.otp?.goMode
    const nearby = goMode?.vehicleMatch?.nearbyVehicles || []
    const selected = nearby.find(
      (v: { vehicleId: string }) => v.vehicleId === vehicleId
    )

    dispatch({
      payload: {
        confidence: 'confirmed' as const,
        distanceMeters: selected?.distanceMeters || null,
        label: selected?.label || vehicleId,
        lastSeen: Date.now(),
        vehicleId
      },
      type: CONFIRM_VEHICLE
    })

    // In the "I'm on the bus" onboard flow (no itinerary yet), use the selected
    // vehicle's trip to fetch the schedule and optimize the alight stop.
    const onboardStatus = goMode?.onboard?.status
    if (onboardStatus && onboardStatus !== 'idle' && !goMode.activeItinerary) {
      if (selected?.tripId) {
        dispatch(
          setOnboardVehicle({
            label: selected.label || vehicleId,
            nextStopId: selected.nextStopId || null,
            routeId: selected.routeId || null,
            tripId: selected.tripId,
            vehicleId
          })
        )
        dispatch(loadOnboardScheduleAndOptimize(selected.tripId))
      } else {
        // No trip id on the realtime feed — can't anchor to this vehicle.
        dispatch(setOnboardStatus('error'))
      }
    }
  }
}

/**
 * Trust the rider when they tap a route: infer the specific GTFS trip they are
 * most likely on from the STATIC schedule. Uses the two facts we already have —
 * the rider's GPS (which direction's stops are near them) and their destination
 * (which direction heads toward it) — then picks, at the nearest stop, the trip
 * whose departure is closest to now. Returns { tripId, headsign } or null.
 */
export function resolveOnboardTripFromSchedule(routeId: string) {
  return async function (dispatch: any, getState: any) {
    const state = getState()
    const pos = state.otp?.goMode?.tracking?.lastPosition
    if (!pos) return null
    const userLat = pos.coords.latitude
    const userLon = pos.coords.longitude
    const to = state.otp.currentQuery?.to

    // 1. Route directions (patterns) with their ordered stops.
    const routeResp: any = await dispatch(
      onboardGraphQLQuery(
        `{ route(id: "${routeId}") { patterns {
            code
            headsign
            stops { gtfsId lat lon }
          } } }`
      )
    )
    const patterns = routeResp?.data?.route?.patterns || []
    if (!patterns.length) return null

    // For each direction: the stop nearest the rider, and whether the
    // destination lies downstream of it (i.e. this is the way they're heading).
    const nearestIdx = (stops: any[], lat: number, lon: number) => {
      let idx = -1
      let best = Infinity
      stops.forEach((s, i) => {
        if (s?.lat == null || s?.lon == null) return
        const d = calculateDistance(lat, lon, s.lat, s.lon)
        if (d < best) {
          best = d
          idx = i
        }
      })
      return { dist: best, idx }
    }

    const scored = patterns
      .map((p: any) => {
        const stops = p.stops || []
        const rider = nearestIdx(stops, userLat, userLon)
        const dest =
          to?.lat != null && to?.lon != null
            ? nearestIdx(stops, to.lat, to.lon)
            : { dist: Infinity, idx: -1 }
        return {
          headedToDest: dest.idx > rider.idx,
          nearestStop: stops[rider.idx],
          pattern: p,
          riderDist: rider.dist
        }
      })
      .filter((s: any) => s.nearestStop)

    if (!scored.length) return null
    const towardDest = scored.filter((s: any) => s.headedToDest)
    const pool = towardDest.length ? towardDest : scored
    pool.sort((a: any, b: any) => a.riderDist - b.riderDist)
    const best = pool[0]

    // 2. Today's departures at that stop; pick the trip on the chosen direction
    // whose departure is closest to now — the bus the rider just boarded.
    const startOfToday = (() => {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      return Math.floor(d.getTime() / 1000)
    })()
    const schedResp: any = await dispatch(
      onboardGraphQLQuery(
        `{ stop(id: "${best.nearestStop.gtfsId}") {
            stoptimesForPatterns(startTime: ${startOfToday}, numberOfDepartures: 1000, omitNonPickups: false, omitCanceled: false) {
              pattern { code route { gtfsId } }
              stoptimes {
                serviceDay
                scheduledDeparture
                realtimeDeparture
                realtimeState
                trip { gtfsId tripHeadsign pattern { code } }
              }
            }
          } }`
      )
    )
    const groups = schedResp?.data?.stop?.stoptimesForPatterns || []
    const now = Date.now()
    let chosen: { headsign?: string; tripId: string } | null = null
    let bestDelta = Infinity
    groups.forEach((g: any) => {
      if (g?.pattern?.route?.gtfsId !== routeId) return
      const samePattern = g?.pattern?.code === best.pattern.code
      ;(g.stoptimes || []).forEach((st: any) => {
        const live =
          st.realtimeState === 'UPDATED' && st.realtimeDeparture != null
        const secs = live ? st.realtimeDeparture : st.scheduledDeparture
        if (secs == null || st.serviceDay == null || !st.trip?.gtfsId) return
        const epoch = (st.serviceDay + secs) * 1000
        // Strongly prefer the direction we resolved; only fall back to the other
        // direction if it is dramatically closer in time.
        const delta = Math.abs(epoch - now) + (samePattern ? 0 : 60 * 60 * 1000)
        if (delta < bestDelta) {
          bestDelta = delta
          chosen = { headsign: st.trip.tripHeadsign, tripId: st.trip.gtfsId }
        }
      })
    })

    return chosen
  }
}

/**
 * Onboard fallback: the rider taps a nearby route ("I'm on the 546") when no
 * live vehicle was matched within range. Anchor to the nearest live vehicle on
 * that route if there is one (no radius cap — the rider says they're aboard);
 * otherwise infer the trip from the static schedule. Then run the same schedule
 * fetch + alight optimization as a direct vehicle pick.
 */
export function confirmOnboardRoute(routeId: string) {
  return async function (dispatch: any, getState: any) {
    const state = getState()
    const goMode = state.otp?.goMode
    const onboardStatus = goMode?.onboard?.status
    const pos = goMode?.tracking?.lastPosition
    const routesIndex = state.otp?.transitIndex?.routes || {}
    const vehicles = (routesIndex[routeId]?.vehicles || []).filter(
      (v: { lat: number; lon: number }) => v.lat && v.lon
    )

    let chosen: any = null
    if (pos && vehicles.length) {
      chosen = findNearbyVehicles(
        pos.coords.latitude,
        pos.coords.longitude,
        vehicles,
        Infinity
      )[0]
    } else if (vehicles.length) {
      chosen = vehicles[0]
    }

    let tripId: string | null = chosen?.tripId || null
    let label: string | null = chosen?.label || chosen?.vehicleId || null

    // No realtime vehicle on this route — infer the rider's trip from the
    // static schedule (their direction + the trip closest to now).
    if (!tripId) {
      const resolved: any = await dispatch(
        resolveOnboardTripFromSchedule(routeId)
      )
      if (resolved?.tripId) {
        tripId = resolved.tripId
        label = resolved.headsign || label
      }
    }

    if (!tripId || !onboardStatus || onboardStatus === 'idle') {
      dispatch(setOnboardStatus('error'))
      return
    }

    const vehicleId = chosen?.vehicleId || `route:${routeId}`
    dispatch({
      payload: {
        confidence: 'confirmed' as const,
        distanceMeters: chosen?.distanceMeters ?? null,
        label: label || routeId,
        lastSeen: Date.now(),
        vehicleId
      },
      type: CONFIRM_VEHICLE
    })
    dispatch(
      setOnboardVehicle({
        label: label || routeId,
        nextStopId: chosen?.nextStopId || null,
        routeId,
        tripId,
        vehicleId
      })
    )
    dispatch(loadOnboardScheduleAndOptimize(tripId))
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
 * `fix` carries recorded accuracy/heading/speed during trip replay; when absent
 * (itinerary-derived sim) synthetic defaults are used.
 */
function createMockPosition(
  lat: number,
  lng: number,
  fix?: Pick<TimedSimulationPoint, 'accuracy' | 'heading' | 'speed'>
): GeolocationPosition {
  return {
    coords: {
      accuracy: fix?.accuracy ?? 10,
      altitude: null,
      altitudeAccuracy: null,
      heading: fix?.heading ?? null,
      latitude: lat,
      longitude: lng,
      speed: fix?.speed ?? null
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

    // Replay: keep the fixture clock in step and refresh the recorded vehicle
    // snapshot for the current sim time BEFORE matching runs in
    // handlePositionUpdate, so vehicle matching sees sim-time-aligned positions
    // (the wall-clock 15s poll is disabled during replay for determinism).
    if (isReplayActive()) {
      setReplayClock(simulatedTimeMs)
      if (replayTrackedRouteId) {
        dispatch(getVehiclePositionsForRoute(replayTrackedRouteId))
      }
    }

    const cur = simulationCoords[simulationPointIndex]
    dispatch(
      handlePositionUpdate(createMockPosition(cur.coord[0], cur.coord[1], cur))
    )
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

    // Resume real GPS polling if Go Mode is still active (but not during replay —
    // replay never wants live GPS).
    const state = getState()
    if (state.otp?.goMode?.isActive && !isReplayActive()) {
      dispatch(startPositionTracking())
    }

    console.info('[Go Mode] GPS simulation stopped')
  }
}

/**
 * Convert a recorded GPS track (from a replay fixture) into timed simulation
 * points. delayMs between fixes is the recorded wall-clock gap, so playback
 * preserves the trip's real pacing (scaled by speedMultiplier at run time).
 */
function trackToTimedPoints(track: ReplayGpsFix[]): TimedSimulationPoint[] {
  return track.map((fix, i) => ({
    accuracy: fix.accuracy,
    coord: [fix.lat, fix.lon] as [number, number],
    delayMs:
      i < track.length - 1 ? Math.max(50, track[i + 1].tMs - fix.tMs) : 500,
    heading: fix.heading,
    speed: fix.speed
  }))
}

/**
 * Play back an explicit recorded GPS track (trip replay), as opposed to
 * startGpsSimulation which derives points from itinerary geometry. Reuses the
 * same setTimeout chain + handlePositionUpdate funnel; the only difference is the
 * source of the points and that the simulated clock starts at the recorded trip
 * start so progress/delay math lines up with the recorded schedule.
 */
export function startTrackReplay(
  track: ReplayGpsFix[],
  speedMultiplier = 1,
  startMs?: number
) {
  return function (dispatch: any) {
    if (!track || track.length === 0) {
      console.warn('[Go Mode] startTrackReplay: empty track')
      return
    }

    if (gpsSimulationTimeoutId) {
      clearTimeout(gpsSimulationTimeoutId)
      gpsSimulationTimeoutId = null
    }
    if (gpsPollingIntervalId) {
      clearInterval(gpsPollingIntervalId)
      gpsPollingIntervalId = null
    }

    simulationCoords = trackToTimedPoints(track)
    simulationPointIndex = 0
    simulationSpeedMultiplier = speedMultiplier
    simulationActive = true
    simulatedTimeMs = startMs ?? track[0].tMs
    setReplayClock(simulatedTimeMs)

    console.info(
      `[Go Mode] Starting trip replay: ${simulationCoords.length} fixes, ` +
        `speed ${speedMultiplier}x`
    )

    dispatch({
      payload: { speedMultiplier, totalPoints: simulationCoords.length },
      type: START_GPS_SIMULATION
    })

    const first = simulationCoords[0]
    dispatch(
      handlePositionUpdate(
        createMockPosition(first.coord[0], first.coord[1], first)
      )
    )
    simulationPointIndex = 1
    dispatch({
      payload: { pointIndex: simulationPointIndex },
      type: UPDATE_SIMULATION_PROGRESS
    })

    scheduleNextSimulationPoint(dispatch)
  }
}

/**
 * Replay a recorded trip fixture fully offline & deterministically. Loads the
 * recorded itinerary into Go Mode exactly as a live trip would, then plays the
 * recorded GPS track; every OTP read (vehicle positions, stop times, reroute
 * plans) is served from the fixture via the replay-engine interception. Exposed
 * as window.__replayTrip (see main.js). See build-fixture.js for the producer.
 */
export function replayTrip(
  fixture: any,
  options: { speedMultiplier?: number } = {}
) {
  return async function (dispatch: any, getState: any) {
    if (!fixture?.itinerary) {
      console.warn('[Go Mode] replayTrip: fixture is missing an itinerary')
      return
    }
    const speedMultiplier = options.speedMultiplier || 1

    // Arm the replay engine BEFORE any dispatch, so startVehicleTracking and the
    // OTP interception both see replay mode from the first action.
    beginReplay(fixture)

    const originalFrom =
      fixture.itinerary.legs?.[0]?.from ||
      getState().otp?.currentQuery?.from ||
      null
    dispatch(startGoMode({ itinerary: fixture.itinerary, originalFrom }))
    dispatch(setMobileScreen(MobileScreens.GO_MODE))

    // Set up tracking machinery (stop-time prefetch, vehicle tracking, window
    // hooks) but skip live GPS — the recorded track drives the trip instead.
    await dispatch(startGoModeTracking(fixture.itinerary, { replay: true }))

    dispatch(
      startTrackReplay(fixture.gpsTrack, speedMultiplier, fixture.meta?.startMs)
    )
  }
}

/**
 * Stop an in-progress trip replay: halt track playback, exit Go Mode, and
 * disarm the replay engine so live OTP requests resume. Exposed as
 * window.__stopReplay.
 */
export function stopReplay() {
  return function (dispatch: any) {
    if (gpsSimulationTimeoutId) {
      clearTimeout(gpsSimulationTimeoutId)
      gpsSimulationTimeoutId = null
    }
    simulationActive = false
    simulationPointIndex = 0
    simulationCoords = []
    simulatedTimeMs = 0
    replayTrackedRouteId = null
    dispatch({ type: STOP_GPS_SIMULATION })
    dispatch(endGoMode())
    endReplay()
    console.info('[Go Mode] Trip replay stopped')
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
