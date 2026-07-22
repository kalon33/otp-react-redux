/* eslint-disable sort-imports-es6-autofix/sort-imports-es6 -- the autofixer is
   non-convergent for this file's mix of value + type relative imports (it keeps
   hoisting a type import above sibling value imports); order is hand-maintained. */
import { createAction } from 'redux-actions'
import { format, utcToZonedTime } from 'date-fns-tz'
import coreUtils from '@opentripplanner/core-utils'
import polyline from '@mapbox/polyline'
import type { Itinerary, LatLngArray, Leg } from '@opentripplanner/types'

import {
  clampNonLiveLegTimes,
  getDownstreamStops,
  hasLiveArrival,
  liveStopArrival,
  mergeLiveTimePoint,
  rankAlightOptions,
  selectCandidateStops
} from '../util/go-mode/alight-optimizer'
import type { AlightCandidateResult } from '../util/go-mode/alight-optimizer'
import { calculateTripProgress } from '../util/go-mode/progress-calculator'
import {
  checkForNotifications,
  checkMissedBus,
  classifyMissedBus,
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
import { getNextStopOnRide } from '../util/go-mode/next-stop'
import { collectRerouteCandidates } from '../util/go-mode/reroute-candidates'
import { pickAccessReplanCandidate, pickSameRouteReroute } from '../util/state'
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
import { fetchOnboardCandidateRoutes } from '../util/go-mode/onboard-discovery'
import {
  hasNativeGps,
  startNativeGps,
  stopNativeGps
} from '../util/go-mode/native-gps'
import {
  AUTO_ANCHOR_MIN_GAIN_MS,
  currentServiceDate,
  getRouteDepartures,
  getSoonestCatchableMs
} from '../util/go-mode/departure-anchor'
import {
  ensureNativeNotifyPermission,
  hasNativeNotify,
  sendPush
} from '../util/go-mode/native-notify'

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

// Wall-clock throttle for re-polling live transit leg times off GTFS-realtime.
// handlePositionUpdate fires on every GPS/simulation tick (as fast as ~1s), but
// re-fetching each upcoming trip's schedule that often is wasteful — 20s keeps
// the overview current without hammering OTP. Reset to 0 per trip so the first
// tick fetches immediately.
let lastLiveLegTimesAt = 0
const LIVE_LEG_TIMES_INTERVAL_MS = 20000

// Debounce for the quiet access-leg replan (bike/walk deviation): a swap
// restarts route matching from the new itinerary, so give the rider time to
// converge onto it before considering another replan.
let lastQuietReplanAt = 0
const QUIET_REPLAN_MIN_INTERVAL_MS = 60000

// Auto-anchor bookkeeping (see the throttled block in handlePositionUpdate).
// The rider's explicit departure pick (or "Reset to planned") must never be
// fought by the auto-anchor, so a manual selectDeparture locks auto-anchoring
// off for the current boarding. lastAutoAnchorMs lets the anchor keep chasing
// the live feed while the current override is its own. earlyBoardReplanKey
// makes the boarded-earlier replan a one-shot per boarding.
let manualDepartureLock = false
let lastAutoAnchorMs: number | null = null
let earlyBoardReplanKey: string | null = null

// A leg transition is side-effectful (vehicle tracking, GPS interval restart,
// departure-override reset), so it must run once per leg. The route match is
// recomputed from raw position on every tick and cannot carry that fact.
let lastTransitionedLegIndex: number | null = null

// You can't be aboard a bus that hasn't left yet: riding this much before the
// planned board time proves the rider caught an earlier departure.
const EARLY_BOARD_MIN_MS = 120000

// How long the rider must stay off-route before the sticky "riding" fact is
// dropped. GPS noise and tunnels produce transient off-route ticks; only a
// sustained departure means the rider genuinely left the vehicle.
const RIDING_OFFROUTE_CLEAR_MS = 90000

// A reroute fetch must always settle: a fetch killed by a WebView suspension
// (app backgrounded mid-flight) can otherwise pin reRoute.status at
// 'searching' forever, silently blocking every future missed-bus auto-update
// (this stranded the 7/13 trip for two hours).
const REROUTE_FETCH_TIMEOUT_MS = 45000
// Wall-clock age past which a 'searching' reroute is declared stuck and
// cleared by the position tick — covers the timeout timer itself being lost
// to a suspension.
const REROUTE_STUCK_MS = 90000
// A definitive missed bus retries the same-route auto-update on its own
// schedule: the notification's 30-minute dedup must not gate trip recovery.
// Retries only while the previous attempt failed outright ('idle'/'none'),
// never over a card the rider is looking at.
const MISSED_BUS_REROUTE_RETRY_MS = 60000
const MISSED_BUS_REROUTE_MAX_ATTEMPTS = 5
let missedBusRerouteAttempt: {
  attempts: number
  departureMs: number
  lastAtMs: number
} | null = null

// Minimum progress along a transit leg before GPS alone establishes
// aboard-ness. isOnRoute is true within 250m of the leg — including while
// still waiting at the boarding stop — so require clear movement along the
// leg (or a confirmed/high vehicle match, which skips this gate).
const RIDING_MIN_PROGRESS = 0.05

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
export const CLEAR_RIDING = 'CLEAR_RIDING'
export const CLEAR_VEHICLE_MATCH = 'CLEAR_VEHICLE_MATCH'
export const CONFIRM_VEHICLE = 'CONFIRM_VEHICLE'
export const DISMISS_BOARDING_PROMPT = 'DISMISS_BOARDING_PROMPT'
export const PAUSE_GPS_SIMULATION = 'PAUSE_GPS_SIMULATION'
export const REROUTE_SNAPSHOT = 'REROUTE_SNAPSHOT'
export const RESUME_GPS_SIMULATION = 'RESUME_GPS_SIMULATION'
export const SET_ARRIVED = 'SET_ARRIVED'
export const SET_DEPARTURE_OVERRIDE = 'SET_DEPARTURE_OVERRIDE'
export const SET_GO_MODE_BACKGROUNDED = 'SET_GO_MODE_BACKGROUNDED'
export const SET_RIDING = 'SET_RIDING'
export const SET_LIVE_LEG_TIMES = 'SET_LIVE_LEG_TIMES'
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

/** Live (or schedule-fallback) times for a transit leg, keyed by leg index. */
export interface LiveLegTime {
  alightEpoch: number | null
  /** Whether alightEpoch is a live prediction (drives the pulsing icon). */
  alightRealtime?: boolean
  boardEpoch: number | null
  /** Whether boardEpoch is a live prediction. */
  boardRealtime?: boolean
  /** Legacy any-field-live flag; display code should use the per-field ones. */
  realtime: boolean
}
export const setLiveLegTimes =
  createAction<Record<number, LiveLegTime>>(SET_LIVE_LEG_TIMES)

// Epoch ms of the moment trip progress first read "completed" — the rider is
// at their destination and Go Mode shows the arrival card until they dismiss.
export const setArrived = createAction<number>(SET_ARRIVED)

/**
 * The durable "rider is aboard this vehicle" fact. Unlike routeMatch (a
 * per-GPS-tick snapshot) and vehicleMatch (reset by each new trip/search),
 * this survives new searches and itinerary switches so the app never asks
 * the rider which bus they're on mid-ride. Cleared when the rider alights
 * (leg transition past the bus leg), Go Mode stops, or the rider stays
 * off-route long enough that the fact is evidently no longer true.
 */
export interface RidingState {
  /** Epoch ms when aboard-ness was first established. */
  boardedAt: number
  headsign: string | null
  /** Transit leg index in activeItinerary; -1 = not anchored to a leg. */
  legIndex: number
  /** Epoch ms of the first consecutive off-route tick; null while on route. */
  offRouteSince: number | null
  routeId: string | null
  routeShortName: string | null
  tripId: string | null
  vehicleId: string | null
}
export const setRiding = createAction<RidingState>(SET_RIDING)
export const clearRiding = createAction(CLEAR_RIDING)
export const addNotification = createAction<NotificationEvent>(ADD_NOTIFICATION)
export const setTrackingError = createAction<GeolocationPositionError | null>(
  SET_TRACKING_ERROR
)
export const toggleMapFollow = createAction(TOGGLE_MAP_FOLLOW)
export const setGoModeBackgrounded = createAction<boolean>(
  SET_GO_MODE_BACKGROUNDED
)
export const updateTrackingInterval = createAction<{ interval: number }>(
  UPDATE_TRACKING_INTERVAL
)
export const setDepartureOverride = createAction<number | null>(
  SET_DEPARTURE_OVERRIDE
)

/**
 * The rider explicitly picked a departure (or reset to planned). Routes
 * through the same SET_DEPARTURE_OVERRIDE, but locks the auto-anchor off for
 * this boarding so it never fights the rider's choice.
 */
export function selectDeparture(epochMs: number | null) {
  return function (dispatch: any) {
    manualDepartureLock = true
    dispatch(setDepartureOverride(epochMs))
  }
}
export const setNotificationConfig = createAction<{
  enabled?: boolean
  soundEnabled?: boolean
  vibrationEnabled?: boolean
}>(SET_NOTIFICATION_CONFIG)

export const startReroute = createAction<{
  autoApply?: boolean
  keepRouteId?: string | null
  reason?: string
  searchId: string
  startedAtMs?: number
}>(START_REROUTE)
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
    // replaces it with the rider's GPS position. When switching itineraries
    // mid-trip (rider switch or missed-bus auto-update), currentQuery.from is
    // already the re-route's GPS point — keep the origin from trip start.
    const { currentQuery, goMode: priorGoMode } = getState().otp
    const originalFrom =
      (priorGoMode?.isActive && priorGoMode?.originalFrom) ||
      currentQuery?.from ||
      null
    dispatch(startGoMode({ itinerary, originalFrom }))
    // While the trip is backgrounded (rider browsing the planner), an
    // auto-update swapping the itinerary through here must not yank the
    // screen back to Go Mode — explicit returns go through returnToGoMode.
    if (!priorGoMode?.ui?.backgrounded) {
      dispatch(setMobileScreen(MobileScreens.GO_MODE))
    }

    await dispatch(startGoModeTracking(itinerary))

    // If the rider is already aboard a known vehicle (sticky riding state —
    // e.g. this trip was started from a mid-ride search), keep the vehicle
    // match locked so matching never re-runs or re-prompts.
    const { goMode } = getState().otp
    const riding: RidingState | null = goMode?.riding ?? null
    if (
      riding?.vehicleId &&
      goMode?.vehicleMatch?.match?.confidence !== 'confirmed'
    ) {
      dispatch({
        payload: {
          confidence: 'confirmed' as const,
          distanceMeters: null,
          label: riding.routeShortName || riding.vehicleId,
          lastSeen: Date.now(),
          routeId: riding.routeId,
          tripId: riding.tripId,
          vehicleId: riding.vehicleId
        },
        type: CONFIRM_VEHICLE
      })
    }
  }
}

/**
 * Step out of the Go Mode screen into the normal trip planner WITHOUT ending
 * the trip: tracking, notifications, and auto-updates keep running, and the
 * ReturnToTripBanner stays visible as the way back. Lands the rider on their
 * own last search results (or the search form when there are none).
 */
export function backgroundGoMode() {
  return function (dispatch: any, getState: any) {
    const { activeSearchId, goMode, searches } = getState().otp
    if (!goMode?.isActive || !goMode.activeItinerary) return
    dispatch(setGoModeBackgrounded(true))
    dispatch(
      setMobileScreen(
        activeSearchId && searches?.[activeSearchId]
          ? MobileScreens.RESULTS_SUMMARY
          : MobileScreens.SEARCH_FORM
      )
    )
  }
}

/**
 * Return from the planner to the active trip's Go Mode screen (banner tap or
 * after explicitly adopting an alternate itinerary).
 */
export function returnToGoMode() {
  return function (dispatch: any) {
    dispatch(setGoModeBackgrounded(false))
    dispatch(setMobileScreen(MobileScreens.GO_MODE))
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
  return async function (dispatch: any, getState: any) {
    // A reroute or missed-bus auto-update swaps the itinerary without going
    // through endGoMode, so clear the per-leg transition guard here too.
    lastTransitionedLegIndex = null

    // Pre-fetch stop times for all transit boarding stops
    const today = currentServiceDate(
      getCurrentTime().getTime(),
      getState().otp.config.homeTimezone
    )
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
    // Test-only time control: jump the simulated clock forward (e.g. past a
    // departure) and re-run a position tick at the last fix without moving.
    // Together these make a "rider stands still through the departure"
    // scenario reproducible in seconds.
    w.__advanceSimulatedTime = (ms: number) => {
      if (simulationActive && simulatedTimeMs > 0) {
        simulatedTimeMs += ms
      }
    }
    w.__pingPosition = () => {
      const last = getState().otp?.goMode?.tracking?.lastPosition
      if (last) dispatch(handlePositionUpdate(last))
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

    // Reset the live-leg-times throttle so the next trip fetches immediately.
    lastLiveLegTimesAt = 0

    // Reset the quiet-replan debounce — a new trip is a fresh slate.
    lastQuietReplanAt = 0

    // Reset auto-anchor bookkeeping — a new trip is a new decision.
    manualDepartureLock = false
    lastAutoAnchorMs = null
    earlyBoardReplanKey = null
    lastTransitionedLegIndex = null
    missedBusRerouteAttempt = null

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
    delete w.__advanceSimulatedTime
    delete w.__pingPosition

    dispatch(stopGoMode())

    // If a mid-trip re-route replaced the origin with the rider's GPS position,
    // restore the origin they started with so the trip planner isn't left
    // showing "Current location". (Re-routes are isolated plans now and no
    // longer touch currentQuery — this restore only protects sessions started
    // under the old pipeline and can eventually be removed.)
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
 * Re-plan from the rider's current GPS position to the trip destination as an
 * ISOLATED background plan (real OTP results — no fabricated data): no shared
 * currentQuery, no URL change, no active-search churn, so the trip planner the
 * rider may be browsing in the foreground is never disturbed. Results resolve
 * here in the thunk (screen-independent) into goMode.reRoute; TripSheet
 * surfaces them as a Switch/Keep card. Optionally applies a routing profile.
 */
export function reRouteFromCurrentPosition(
  options: {
    // Apply the best result automatically instead of surfacing the
    // Switch/Keep card — used when the current itinerary is definitively dead
    // (missed bus) and there is nothing for the rider to decide.
    autoApply?: boolean
    // Restrict an auto-applied result to itineraries boarding this route (the
    // one the rider already chose). Never force a different route on them.
    keepRouteId?: string | null
    preferences?: any
    profileId?: string
    reason?: string
  } = {}
) {
  return async function (dispatch: any, getState: any) {
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
    // Not a searches[] key anymore — a stale-response token: only the newest
    // in-flight reroute may resolve into goMode.reRoute.
    const searchId = randId()
    dispatch(
      startReroute({
        autoApply: !!options.autoApply,
        keepRouteId: options.keepRouteId ?? null,
        reason: options.reason,
        searchId,
        startedAtMs: Date.now()
      })
    )

    const { modes, modeSettings, numItineraries } = getBasePlanParts(state)
    const payload: any = {
      arriveBy: false,
      date: coreUtils.time.getCurrentDate(homeTimezone),
      from: {
        category: 'CURRENT_LOCATION',
        lat: lastPosition.coords.latitude,
        lon: lastPosition.coords.longitude,
        name: 'Current location'
      },
      modes,
      modeSettings,
      numItineraries,
      time: coreUtils.time.getCurrentTime(homeTimezone),
      to: {
        lat: destLeg.to.lat,
        lon: destLeg.to.lon,
        name: destLeg.to.name
      }
    }

    // Aboard a bus, "current position" is a moving mid-street point the rider
    // can't act on. Plan from the next stop ahead on their line instead,
    // anchored to when the bus gets there, and prefer their current route so
    // "stay on this bus" surfaces as the default choice.
    const riding = goMode?.riding
    const nextStop = riding ? getNextStopOnRide(state) : null
    if (riding && nextStop) {
      const zoned = utcToZonedTime(nextStop.arrivalEpoch, homeTimezone)
      payload.date = format(zoned, coreUtils.time.OTP_API_DATE_FORMAT)
      payload.from = {
        lat: nextStop.lat,
        lon: nextStop.lon,
        name: nextStop.name
      }
      payload.time = format(zoned, coreUtils.time.OTP_API_TIME_FORMAT)
      if (riding.routeId) {
        payload.preferred = {
          otherThanPreferredRoutesPenalty: 900,
          routes: riding.routeId
        }
      }
    }

    // Keeping the rider's chosen route (missed-bus auto-update): bias the
    // search toward it so its next departure is in the result set.
    if (options.keepRouteId && !payload.preferred) {
      payload.preferred = {
        otherThanPreferredRoutesPenalty: 900,
        routes: options.keepRouteId
      }
    }

    const profile = options.profileId
      ? getRoutingProfile(options.profileId)
      : undefined
    if (profile) {
      payload.routingPreferences = profile.prefs
    } else if (options.preferences) {
      payload.routingPreferences = options.preferences
    } else if (riding && nextStop) {
      // No caller-specified preferences: default a mid-ride re-plan to the
      // stay-seated profile so transfers away from the boarded bus cost extra.
      payload.routingPreferences = getRoutingProfile('stay-seated')?.prefs
    }

    // The plan fetch is written to never reject, but a WebView suspension can
    // kill it without ever settling — race a timeout (and catch, belt and
    // braces) so this thunk ALWAYS resolves reRoute.status. Left at
    // 'searching', every future missed-bus auto-update is silently blocked.
    let fetchTimeoutId: ReturnType<typeof setTimeout> | undefined
    const { error, itineraries } = await Promise.race([
      Promise.resolve(dispatch(fetchOnboardCandidatePlan(payload))).catch(
        () => ({ error: true, itineraries: [] })
      ),
      new Promise<{ error: boolean; itineraries: Itinerary[] }>((resolve) => {
        fetchTimeoutId = setTimeout(
          () => resolve({ error: true, itineraries: [] }),
          REROUTE_FETCH_TIMEOUT_MS
        )
      })
    ])
    clearTimeout(fetchTimeoutId)

    // Re-check state after the async plan: the rider may have exited Go Mode,
    // cleared the card, or fired a newer reroute while this one was in flight.
    const after = getState().otp?.goMode
    if (
      !after?.isActive ||
      after.reRoute?.searchId !== searchId ||
      after.reRoute?.status !== 'searching'
    ) {
      return
    }

    if (error || !itineraries?.length) {
      dispatch(setRerouteResult(null))
      return
    }

    const display = collectRerouteCandidates(itineraries)
    if (after.reRoute.autoApply) {
      dispatch(applyAutoReroute(itineraries, display))
    } else {
      dispatch(setRerouteResult(display))
    }
  }
}

/**
 * Apply a re-route candidate without asking (missed-bus auto-update: the old
 * itinerary is dead, so there is no decision to put to the rider) — but ONLY
 * one that keeps the rider on the route they chose (same route, next
 * departure). Auto-updating must never force a different route or mode; when
 * nothing boards the same route, fall back to the Switch/Keep card so the
 * rider decides. Full re-planning stays behind the explicit
 * "Find another way" button.
 */
export function applyAutoReroute(
  allItineraries: Itinerary[],
  displayCandidates?: Itinerary[]
) {
  return function (dispatch: any, getState: any) {
    const state = getState()
    const goMode = state.otp?.goMode
    if (!goMode?.isActive || !goMode.reRoute?.autoApply) return

    // Search the FULL result set (the display list is capped at 5 by
    // duration, which is exactly the ranking that buried the next bus under
    // bike-the-whole-way options).
    const best = pickSameRouteReroute(
      collectRerouteCandidates(allItineraries, 50),
      goMode.reRoute?.keepRouteId
    )
    if (!best) {
      // No same-route option (last run of the day, outside the search
      // window...): surface the alternatives as the regular card instead of
      // auto-swapping. The missed-bus push already told the rider.
      dispatch(
        setRerouteResult(displayCandidates?.length ? displayCandidates : null)
      )
      return
    }

    dispatch(beginGoMode(best))

    // Confirm what changed — the new boarding is the fact the rider needs.
    const firstTransitLeg = (best.legs || []).find((l: any) => l.transitLeg)
    const message = `Trip updated — ${
      firstTransitLeg.routeShortName ||
      firstTransitLeg.routeLongName ||
      'your bus'
    } departs ${firstTransitLeg.from?.name || 'the stop'} at ${format(
      utcToZonedTime(
        Number(firstTransitLeg.startTime),
        getState().otp.config.homeTimezone
      ),
      'h:mm a'
    )}.`
    const notification: NotificationEvent = {
      id: `TRIP_UPDATED_auto_${Date.now()}`,
      message,
      priority: 'high',
      timestamp: new Date(),
      title: 'Trip updated',
      type: 'TRIP_UPDATED'
    }
    // After beginGoMode so the fresh trip's notification state keeps it.
    dispatch(addNotification(notification))
    if (!isReplayActive()) {
      showNotification(notification, getState().otp.goMode.notifications)
      sendPush({ message, priority: 1, title: notification.title })
    }
  }
}

/**
 * Quietly re-plan the current WALK/BICYCLE access leg when the rider has
 * drifted off it (chosen their own way, car-GPS style): plan current GPS →
 * final destination as an ISOLATED background request (no currentQuery / URL /
 * active-search side effects, so the mobile shell never yanks the rider off
 * the Go Mode screen), then swap the itinerary in without asking. Selection
 * never forces a route change (pickAccessReplanCandidate); when nothing
 * qualifies the trip is left untouched — the explicit reroute button remains
 * the rider's escape hatch.
 */
export function quietReplanAccessLeg() {
  return async function (dispatch: any, getState: any) {
    const state = getState()
    const goMode = state.otp?.goMode
    const itinerary: Itinerary | null = goMode?.activeItinerary
    const lastPosition: GeolocationPosition | null =
      goMode?.tracking?.lastPosition
    const legs = itinerary?.legs || []
    const destLeg = legs[legs.length - 1]
    if (!goMode?.isActive || !itinerary || !lastPosition || !destLeg) return
    if ((goMode.reRoute?.status || 'idle') !== 'idle') return

    const nowMs = getCurrentTime().getTime()
    if (nowMs - lastQuietReplanAt < QUIET_REPLAN_MIN_INTERVAL_MS) return
    lastQuietReplanAt = nowMs

    const { homeTimezone } = state.otp.config
    const { modes, modeSettings, numItineraries } = getBasePlanParts(state)
    const routingPreferences = state.otp.currentQuery?.routingPreferences
    const zoned = utcToZonedTime(nowMs, homeTimezone)
    const combo = {
      arriveBy: false,
      date: format(zoned, coreUtils.time.OTP_API_DATE_FORMAT),
      from: {
        category: 'CURRENT_LOCATION',
        lat: lastPosition.coords.latitude,
        lon: lastPosition.coords.longitude,
        name: 'Current location'
      },
      modes,
      modeSettings,
      numItineraries,
      routingPreferences,
      time: format(zoned, coreUtils.time.OTP_API_TIME_FORMAT),
      to: {
        lat: destLeg.to.lat,
        lon: destLeg.to.lon,
        name: destLeg.to.name
      }
    }

    const currentLegIndex = goMode.routeMatch?.legIndex ?? 0
    const currentLeg = legs[currentLegIndex]
    const nextTransitLeg = legs
      .slice(currentLegIndex)
      .find((l: Leg) => l.transitLeg)

    const { error, itineraries } = await dispatch(
      fetchOnboardCandidatePlan(combo)
    )
    if (error || !itineraries?.length) return

    // Re-check state after the async plan: the rider may have exited Go Mode
    // or a reroute may have started while the request was in flight.
    const after = getState().otp?.goMode
    if (!after?.isActive || (after.reRoute?.status || 'idle') !== 'idle') return

    const best = pickAccessReplanCandidate(itineraries, {
      accessMode: currentLeg?.mode,
      nextTransitRouteId: nextTransitLeg
        ? getLegRouteId(nextTransitLeg as Leg)
        : null
    })
    if (!best) return

    dispatch(beginGoMode(best))
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
      category: 'CURRENT_LOCATION',
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

    // The rider's vehicle may already be known from a prior confirmation or
    // route match this ride (sticky riding state). Re-confirm it silently
    // instead of re-running discovery and re-asking which bus they're on.
    const riding: RidingState | null = getState().otp.goMode?.riding ?? null
    if (riding?.tripId) {
      const label = riding.routeShortName || riding.headsign || riding.routeId
      const vehicleId = riding.vehicleId || `route:${riding.routeId}`
      dispatch({
        payload: {
          confidence: 'confirmed' as const,
          distanceMeters: null,
          label: label || vehicleId,
          lastSeen: Date.now(),
          routeId: riding.routeId,
          tripId: riding.tripId,
          vehicleId
        },
        type: CONFIRM_VEHICLE
      })
      dispatch(
        setOnboardVehicle({
          label,
          nextStopId: null,
          routeId: riding.routeId,
          tripId: riding.tripId,
          vehicleId
        })
      )
      dispatch(loadOnboardScheduleAndOptimize(riding.tripId))
      return
    }
    if (riding?.routeId) {
      // Route known but not the specific trip — resolve it without prompting.
      dispatch(confirmOnboardRoute(riding.routeId))
      return
    }

    // No riding fact, but the vehicle-match pipeline may already have a
    // confirmed vehicle (it survives BEGIN_ONBOARD_FLOW when confirmed).
    // Never re-ask the rider what the app has already verified.
    const match: any = getState().otp.goMode?.vehicleMatch?.match
    if (match?.confidence === 'confirmed' && match.tripId) {
      dispatch(
        setOnboardVehicle({
          label: match.label ?? match.vehicleId,
          nextStopId: match.nextStopId ?? null,
          routeId: match.routeId ?? null,
          tripId: match.tripId,
          vehicleId: match.vehicleId
        })
      )
      dispatch(loadOnboardScheduleAndOptimize(match.tripId))
      return
    }

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

    // 1. Candidate routes from the rider's POSITION — what they are ON, not
    // what stops are near: live vehicles around them first (the nearest bus
    // IS the answer), route shapes under them second (see the transitnav
    // sidecar's /api/onboard endpoints). Stop-radius discovery survives only
    // as the last-resort fallback when the sidecar is unreachable — it found
    // nothing three times mid-I-35W on the 2026-07-12 ride.
    let routes: Array<{ id: string }> = []
    const candidates = await fetchOnboardCandidateRoutes(
      lat,
      lon,
      speedAdjustedRadius(750, pos.coords.speed)
    )
    if (candidates?.length) {
      routes = candidates
      // Same shape findRoutesNearby stores — keeps the boarding prompt's
      // manual route picker working off transitIndex.nearbyRoutes.
      dispatch({
        payload: { routes: candidates },
        type: 'NEARBY_ROUTES_RESPONSE'
      })
    } else {
      // Fallback: routes serving nearby stops, widened with rider speed and
      // retried once at a much larger radius before the manual prompt.
      const stopsRadius = speedAdjustedRadius(400, pos.coords.speed)
      await dispatch(findRoutesNearby({ lat, lon, radius: stopsRadius }))
      routes = getState().otp?.transitIndex?.nearbyRoutes || []
      if (!routes.length) {
        await dispatch(
          findRoutesNearby({
            lat,
            lon,
            radius: Math.max(1500, stopsRadius * 3)
          })
        )
        routes = getState().otp?.transitIndex?.nearbyRoutes || []
      }
    }

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
    preferred: any
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
      preferred: ctx.preferred,
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
    // The question being answered is "where do I get off THIS bus" — bias the
    // onward plans like a mid-ride re-plan (stay-seated profile + prefer the
    // boarded route) so a parallel express can't hijack the recommendation
    // into "get off in two stops and switch buses". Observed 2026-07-13:
    // MVTA 460 outran the Orange Line on I-35W and became the top option.
    const boardedRouteId =
      vehicle?.routeId || goMode?.riding?.routeId || trip.route?.id || null
    const ctx = {
      homeTimezone,
      modes,
      modeSettings,
      numItineraries,
      preferred: boardedRouteId
        ? { otherThanPreferredRoutesPenalty: 900, routes: boardedRouteId }
        : undefined,
      routingPreferences:
        state.otp.currentQuery?.routingPreferences ??
        getRoutingProfile('stay-seated')?.prefs,
      to: { lat: to.lat, lon: to.lon, name: to.name }
    }

    const results = await Promise.all(
      candidates.map((c) => dispatch(fetchCandidatePlan(c, ctx)))
    )

    const ranked = rankAlightOptions(results, { walkOnlyMax })
    // Decorate each option with the itinerary the rider actually gets on tap
    // (current-bus leg prepended, transfers recounted, real bike legs) so the
    // results list displays exactly what confirmOnboardAlightStop will start.
    // The 7/12 cards showed the ONWARD plan's numbers instead — "0 more
    // transfers" became a 1-transfer trip after tapping.
    const decorated = (ranked || []).map((option: any) => {
      try {
        return {
          ...option,
          displayItinerary: buildOnboardItinerary(
            trip,
            vehicle,
            option,
            lastPosition
          )
        }
      } catch {
        return option
      }
    })
    dispatch(setOnboardResult(decorated.length ? decorated : null))
  }
}

/**
 * Build a Go Mode itinerary that keeps the rider on their current bus to the
 * chosen alight stop, then continues with the onward plan. The bus leg is
 * synthesized from the trip schedule (geometry sliced between boarding and
 * alight stops, intermediate stops, schedule-anchored times).
 */
export function buildOnboardItinerary(
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
  if (alightIdx < 0) {
    alightIdx = Math.min(boardIdx + 1, stopTimes.length - 1)
  }
  // Alighting at the bus's very next stop: the ride segment is the approach to
  // that stop, not a leg starting there — anchor the board stop one back so
  // the rider's chosen stop is honored instead of silently pushed one further.
  if (alightIdx <= boardIdx) {
    boardIdx = Math.max(0, alightIdx - 1)
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
    transitLeg: true,
    // Carry the boarded trip's id so refreshLiveLegTimes can re-poll this
    // leg's GTFS-RT mid-ride (it skips legs without a trip id).
    trip: { gtfsId: trip.id },
    tripId: trip.id
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
export function confirmOnboardAlightStop(option?: any) {
  return function (dispatch: any, getState: any) {
    const goMode = getState().otp?.goMode
    const best = option || goMode?.onboard?.bestAlightStop
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
            routeId: vehicle.routeId ?? null,
            tripId: vehicle.tripId ?? null,
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
      // Ask for notification permission alongside the location prompt — trip
      // start is the moment the rider understands why. Fire-and-forget; alerts
      // fall back to in-app toasts if declined.
      if (hasNativeNotify()) ensureNativeNotifyPermission()
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

    // Set up polling interval. A mid-trip itinerary switch (rider switch or
    // missed-bus auto-update) re-enters here with a poll already running —
    // replace it, never stack a second one.
    if (gpsPollingIntervalId) {
      clearInterval(gpsPollingIntervalId)
      gpsPollingIntervalId = null
    }
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
  'ARRIVING_STOP',
  'MISSED_BUS'
])

/**
 * Re-poll GTFS-realtime for the trip's upcoming transit legs so the trip
 * overview shows LIVE board/alight times mid-ride — not just the plan's
 * realtime-as-of-planning snapshot. For each transit leg from the current one
 * onward, fetch its trip schedule (findTrip carries per-stop realtimeArrival)
 * and read the live-or-scheduled epoch at the leg's board and alight stops.
 * Results are stored by leg index; TripSheet falls back to the plan's own leg
 * times for any leg without a live figure, so this only ever improves accuracy.
 */
export function refreshLiveLegTimes() {
  return async function (dispatch: any, getState: any) {
    const goMode = getState().otp?.goMode
    const itinerary: Itinerary | null = goMode?.activeItinerary
    if (!goMode?.isActive || !itinerary) return

    const legs = itinerary.legs || []
    const currentLegIndex = goMode.routeMatch?.legIndex ?? 0
    const prevTimes: Record<number, LiveLegTime> = goMode.liveLegTimes || {}
    const liveTimes: Record<number, LiveLegTime> = {}
    const nowMs = getCurrentTime().getTime()

    for (let i = currentLegIndex; i < legs.length; i++) {
      const leg: any = legs[i]
      if (!leg?.transitLeg) continue
      // convertGraphQLResponseToLegacy keeps leg.trip.gtfsId and also adds a
      // top-level leg.tripId; accept either.
      const tripId = leg.trip?.gtfsId || leg.tripId
      if (!tripId) continue

      // findTrip is noThrottle and idempotent; it refreshes the cached trip
      // (with current realtimeArrival) in transitIndex.trips[tripId].
      await dispatch(findTrip({ tripId }))
      const stopTimes =
        getState().otp?.transitIndex?.trips?.[tripId]?.stopTimes || []
      if (!stopTimes.length) continue

      // Merge each field against its previous value so a realtime dropout
      // (liveStopArrival falling back to the schedule) can never walk a
      // displayed time backwards or keep styling it live.
      const prev = prevTimes[i]
      const alight = mergeLiveTimePoint(
        prev?.alightEpoch != null
          ? {
              epoch: prev.alightEpoch,
              realtime: prev.alightRealtime ?? prev.realtime
            }
          : null,
        liveStopArrival(stopTimes, leg.to?.stop?.gtfsId, leg.to?.name),
        nowMs
      )
      const board = mergeLiveTimePoint(
        prev?.boardEpoch != null
          ? {
              epoch: prev.boardEpoch,
              realtime: prev.boardRealtime ?? prev.realtime
            }
          : null,
        liveStopArrival(stopTimes, leg.from?.stop?.gtfsId, leg.from?.name),
        nowMs
      )
      if (alight || board) {
        liveTimes[i] = {
          alightEpoch: alight?.epoch ?? null,
          alightRealtime: !!alight?.realtime,
          boardEpoch: board?.epoch ?? null,
          boardRealtime: !!board?.realtime,
          realtime: !!(alight?.realtime || board?.realtime)
        }
      }
    }

    dispatch(setLiveLegTimes(liveTimes))
  }
}

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

    // Maintain the sticky "riding" fact (see RidingState). Established once the
    // rider is verifiably aboard a transit leg; refreshed if the anchor leg
    // changes; dropped only after a sustained off-route period.
    const matchedLeg: any = itinerary.legs[routeMatch.legIndex]
    const riding = goMode.riding
    const nowForRiding = getCurrentTime().getTime()
    if (routeMatch.isOnRoute && matchedLeg?.transitLeg) {
      const vehicleConfidence = goMode.vehicleMatch?.match?.confidence
      const aboard =
        vehicleConfidence === 'confirmed' ||
        vehicleConfidence === 'high' ||
        routeMatch.progressAlongLeg >= RIDING_MIN_PROGRESS
      if (
        aboard &&
        (!riding ||
          riding.legIndex !== routeMatch.legIndex ||
          riding.offRouteSince != null)
      ) {
        dispatch(
          setRiding({
            boardedAt: riding?.boardedAt ?? nowForRiding,
            headsign: matchedLeg.headsign ?? null,
            legIndex: routeMatch.legIndex,
            offRouteSince: null,
            routeId: getLegRouteId(matchedLeg),
            routeShortName:
              matchedLeg.routeShortName ?? matchedLeg.route?.shortName ?? null,
            tripId:
              matchedLeg.trip?.gtfsId ||
              matchedLeg.tripId ||
              riding?.tripId ||
              null,
            vehicleId:
              goMode.vehicleMatch?.match?.vehicleId ?? riding?.vehicleId ?? null
          })
        )
      }
    } else if (riding) {
      if (riding.offRouteSince == null) {
        dispatch(setRiding({ ...riding, offRouteSince: nowForRiding }))
      } else if (
        nowForRiding - riding.offRouteSince >
        RIDING_OFFROUTE_CLEAR_MS
      ) {
        dispatch(clearRiding())
      }
    }

    // Check for leg transition. This is side-effectful (it restarts the position
    // watcher and vehicle tracking, and clears the anchored departure), so it
    // must run once per leg — routeMatch is rebuilt from raw GPS every tick and
    // cannot carry that fact itself.
    const previousLegIndex = goMode.routeMatch?.legIndex || 0
    if (
      shouldTransitionToNextLeg(routeMatch, previousLegIndex) &&
      routeMatch.legIndex !== lastTransitionedLegIndex
    ) {
      lastTransitionedLegIndex = routeMatch.legIndex
      dispatch(transitionLeg({ legIndex: routeMatch.legIndex }))

      // New leg = new upcoming boarding = a fresh auto-anchor decision.
      manualDepartureLock = false
      lastAutoAnchorMs = null

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

    // Arrival: mark it once and let this tick's notification pass emit
    // TRIP_COMPLETE; every later tick quiesces here — no live-times polling,
    // auto-anchor, notifications, missed-bus or reroute activity for a rider
    // who has arrived (on 7/12 the deviation checks kept firing after the
    // destination). Position/route/progress updates above keep the map honest
    // while the arrival card is up.
    const hasArrived = goMode.arrivedAt != null
    if (
      !hasArrived &&
      (progress.status === 'completed' || progress.overallProgress >= 99.5)
    ) {
      dispatch(setArrived(currentTime.getTime()))
    } else if (hasArrived) {
      return
    }

    // Keep the trip-overview transit rows current off GTFS-realtime, throttled
    // to LIVE_LEG_TIMES_INTERVAL_MS regardless of tick rate. Skipped in replay,
    // which reproduces recorded data rather than re-polling live feeds.
    const nowMs = Date.now()
    if (
      !isReplayActive() &&
      nowMs - lastLiveLegTimesAt > LIVE_LEG_TIMES_INTERVAL_MS
    ) {
      lastLiveLegTimesAt = nowMs
      dispatch(refreshLiveLegTimes())

      // Auto-anchor: while walking/biking toward a transit boarding, target
      // the soonest same-route departure the rider can actually catch — the
      // planned itinerary may board a much later trip (e.g. a later-departing
      // itinerary was activated), and the wait/notification math must track
      // the real bus. The header already displays this value; this writes it
      // into departureOverride so progress + missed-bus agree with it. A
      // manual pick or reset (selectDeparture) locks auto-anchoring off.
      const anchorLeg = itinerary.legs[routeMatch.legIndex]
      const anchorNextLeg = itinerary.legs[routeMatch.legIndex + 1]
      if (
        (anchorLeg?.mode === 'WALK' || anchorLeg?.mode === 'BICYCLE') &&
        anchorNextLeg?.transitLeg
      ) {
        const boardingStopId = (anchorNextLeg as any)?.from?.stop?.gtfsId
        if (boardingStopId) {
          // Re-poll the boarding stop's departures — the trip-start snapshot
          // goes stale, and an earlier bus only ever shows up here.
          try {
            dispatch(
              findStopTimesForStop({
                date: currentServiceDate(
                  currentTime.getTime(),
                  getState().otp.config.homeTimezone
                ),
                forceFetch: true,
                stopId: boardingStopId
              })
            )
          } catch {
            // Best-effort; the anchor below uses whatever is in the store.
          }

          if (
            !manualDepartureLock &&
            (departureOverride == null ||
              departureOverride === lastAutoAnchorMs)
          ) {
            const stopData =
              getState().otp.transitIndex?.stops?.[boardingStopId]
            const rideSecondsRemaining = Math.max(
              0,
              (anchorLeg.duration || 0) *
                (1 - (progress.currentLegProgress || 0) / 100)
            )
            const soonest = getSoonestCatchableMs(
              getRouteDepartures(stopData, getLegRouteId(anchorNextLeg)),
              currentTime.getTime(),
              rideSecondsRemaining
            )
            if (
              soonest != null &&
              Number(anchorNextLeg.startTime) - soonest >=
                AUTO_ANCHOR_MIN_GAIN_MS &&
              soonest !== departureOverride
            ) {
              lastAutoAnchorMs = soonest
              dispatch(setDepartureOverride(soonest))
            }
          }
        }
      }
    } else if (!isReplayActive()) {
      // Between polls the clock keeps walking — re-raise any non-live epoch
      // that fell into the past so displayed times never sit behind now.
      // (Replay reproduces recorded state and is left untouched, same as the
      // poll itself.)
      const staleClamped = clampNonLiveLegTimes(
        getState().otp.goMode?.liveLegTimes,
        currentTime.getTime()
      )
      if (staleClamped) dispatch(setLiveLegTimes(staleClamped))
    }

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

    // Missed boarding? Judged outside checkForNotifications because it needs
    // live board times, the sticky riding fact, and the raw GPS fix.
    const missedCtx = classifyMissedBus({
      currentLegIndex: routeMatch.legIndex,
      departureOverrideMs: departureOverride,
      legs: itinerary.legs,
      liveLegTimes: goMode.liveLegTimes || {},
      nowMs: currentTime.getTime(),
      riderPosition: currentPosition,
      riderSpeedMps: position.coords.speed ?? null,
      riding: goMode.riding,
      vehicleConfidence: goMode.vehicleMatch?.match?.confidence
    })
    const missedEvent =
      missedCtx &&
      checkMissedBus(
        missedCtx,
        itinerary.legs,
        goMode.notifications?.sentNotifications || []
      )
    if (missedEvent) notifications.push(missedEvent)

    // Show notifications. Always record them in state (so replay assertions and
    // the debug log see the sequence), but suppress the real-world side effects
    // (in-app toast/vibration and the phone's system notification) during replay
    // so a fast offline replay loop doesn't buzz the phone.
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
        // Raise the highest-value alerts as a system notification on the phone
        // (native shell only; no-op in a browser). Dedup is already guaranteed
        // upstream by checkForNotifications, so each fires at most once.
        // Limited to a few types to avoid notification spam.
        if (PUSH_NOTIFICATION_TYPES.has(notification.type)) {
          sendPush({
            message: notification.message,
            priority: notification.priority === 'high' ? 1 : 0,
            title: notification.title
          })
        }
      }
    })

    // A reroute stuck at 'searching' (both the fetch and its timeout timer
    // lost to a WebView suspension) blocks every auto-update below — declare
    // it dead once definitively overdue so recovery can proceed.
    let reRouteStatus = goMode.reRoute?.status || 'idle'
    if (
      reRouteStatus === 'searching' &&
      goMode.reRoute?.startedAtMs != null &&
      Date.now() - goMode.reRoute.startedAtMs > REROUTE_STUCK_MS
    ) {
      dispatch(clearReroute())
      reRouteStatus = 'idle'
    }

    // Track auto-update attempts per missed departure: the notification's
    // 30-minute dedup must not gate trip recovery, so a definitive miss keeps
    // its own retry schedule while attempts fail outright ('idle'/'none') —
    // never over a card the rider is looking at, and capped so a dead network
    // doesn't retry forever.
    if (
      missedCtx?.definitive &&
      missedBusRerouteAttempt?.departureMs !== missedCtx.effectiveBoardMs
    ) {
      missedBusRerouteAttempt = {
        attempts: 0,
        departureMs: missedCtx.effectiveBoardMs,
        lastAtMs: 0
      }
    }
    const missedRetryDue =
      missedCtx?.definitive &&
      missedBusRerouteAttempt != null &&
      (reRouteStatus === 'idle' || reRouteStatus === 'none') &&
      missedBusRerouteAttempt.attempts < MISSED_BUS_REROUTE_MAX_ATTEMPTS &&
      Date.now() - missedBusRerouteAttempt.lastAtMs >=
        MISSED_BUS_REROUTE_RETRY_MS

    // A detected missed bus re-plans immediately: definitively missed (the
    // realtime feed says the bus left, or the rider clearly isn't at the stop)
    // auto-updates to the SAME route's next departure — no prompt, no route
    // change — while an ambiguous miss surfaces the regular Switch/Keep card.
    if (
      missedCtx &&
      (missedEvent
        ? // A definitive miss also supersedes an already-showing card — those
          // alternatives were computed for an itinerary that is now dead. Only
          // an in-flight search is left to resolve on its own.
          reRouteStatus === 'idle' ||
          (missedCtx.definitive && reRouteStatus !== 'searching')
        : missedRetryDue)
    ) {
      if (missedCtx.definitive && missedBusRerouteAttempt) {
        missedBusRerouteAttempt.attempts += 1
        missedBusRerouteAttempt.lastAtMs = Date.now()
      }
      dispatch(
        reRouteFromCurrentPosition({
          autoApply: missedCtx.definitive,
          keepRouteId: getLegRouteId(
            itinerary.legs[missedCtx.boardLegIndex] as Leg
          ),
          reason: 'missed-bus'
        })
      )
    } else if (
      // Boarded an EARLIER same-route trip than the itinerary planned (the
      // auto-anchor targets it while walking; this fixes the legs once the
      // rider is verifiably aboard). Proof is either a confirmed vehicle
      // match on a different tripId than planned, or simply being aboard
      // before the planned bus could exist. Replanning with keepRouteId
      // yields a same-route itinerary whose downstream transfers are real;
      // beginGoMode (via the auto-apply path) then resets the override.
      (() => {
        if (reRouteStatus !== 'idle') return false
        const riding = goMode.riding
        if (!riding || riding.legIndex == null || riding.legIndex < 0)
          return false
        const ridingLeg = itinerary.legs[riding.legIndex]
        if (!ridingLeg?.transitLeg) return false
        const oneShotKey = `${riding.legIndex}:${riding.boardedAt ?? ''}`
        if (earlyBoardReplanKey === oneShotKey) return false
        const plannedTripId =
          (ridingLeg as any)?.trip?.gtfsId || (ridingLeg as any)?.tripId
        const matched = goMode.vehicleMatch?.match
        const tripMismatch =
          (matched?.confidence === 'confirmed' ||
            matched?.confidence === 'high') &&
          matched?.tripId != null &&
          plannedTripId != null &&
          matched.tripId !== plannedTripId
        const aboardBeforePlanned =
          currentTime.getTime() <
          Number(ridingLeg.startTime) - EARLY_BOARD_MIN_MS
        if (!tripMismatch && !aboardBeforePlanned) return false
        earlyBoardReplanKey = oneShotKey
        return true
      })()
    ) {
      const ridingLegIndex = goMode.riding?.legIndex ?? -1
      dispatch(
        reRouteFromCurrentPosition({
          autoApply: true,
          keepRouteId: getLegRouteId(itinerary.legs[ridingLegIndex] as Leg),
          reason: 'boarded-earlier'
        })
      )
    } else if (shouldAutoReroute(notifications, reRouteStatus)) {
      const offAccessLeg =
        currentLeg &&
        !currentLeg.transitLeg &&
        (currentLeg.mode === 'WALK' || currentLeg.mode === 'BICYCLE') &&
        notifications.some((n) => n.type === 'ROUTE_DEVIATION') &&
        !notifications.some((n) => n.type === 'CONNECTION_WARNING')
      if (offAccessLeg) {
        // Drifted off a walk/bike leg: the rider chose their own way. Quietly
        // re-plan the access path from where they are (car-GPS style) — no
        // card, no screen change; same-route rule enforced by the picker.
        dispatch(quietReplanAccessLeg())
      } else {
        // Connection at risk or off-route on transit: offer a re-route as the
        // Switch/Keep card — never swapped automatically. The helper guards
        // on reRoute.status === 'idle'.
        dispatch(reRouteFromCurrentPosition())
      }
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

    // Boarding confirmation. shouldShowBoardingPrompt fires only when the
    // vehicle match is still low/medium confidence — i.e. we're unsure which
    // bus the rider is on.
    if (
      !goMode.boardingPrompt?.shown &&
      shouldShowBoardingPrompt(
        matchResult,
        goMode.boardingPrompt?.transitLegEnteredAt,
        getCurrentTime().getTime(),
        goMode.boardingPrompt?.lastDismissedAt
      )
    ) {
      // On a planned trip the route is already known from the itinerary, so we
      // never ask the rider which bus they're on. When a clear vehicle on that
      // route is matched (this matcher only ever considers `routeId`), auto-
      // confirm it and keep guidance moving. 'low' confidence means several
      // same-route buses are ambiguously near — binding one could pick the
      // wrong bus, and confirming freezes further matching, so we stay silent
      // and let the match keep refining rather than guessing. The manual prompt
      // is reserved for the onboard ("I'm already on the bus") flow, which has
      // no itinerary and genuinely needs the rider to identify their route.
      if (goMode.activeItinerary) {
        if (matchResult.vehicleId && matchResult.confidence !== 'low') {
          dispatch(confirmVehicleSelection(matchResult.vehicleId))
        }
      } else if (!goMode.riding) {
        // With sticky riding state set, the rider's bus is already known —
        // never re-ask, even in the onboard flow.
        dispatch(showBoardingPromptAction())
      }
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
        routeId: selected?.routeId ?? null,
        tripId: selected?.tripId ?? null,
        vehicleId
      },
      type: CONFIRM_VEHICLE
    })

    // An explicit rider confirmation is the strongest aboard-ness signal —
    // stamp the sticky riding fact directly (no GPS heuristics needed).
    if (selected?.routeId || selected?.tripId) {
      const prevRiding = goMode?.riding
      dispatch(
        setRiding({
          boardedAt: prevRiding?.boardedAt ?? Date.now(),
          headsign: selected.tripHeadsign ?? null,
          legIndex: goMode?.routeMatch?.legIndex ?? -1,
          offRouteSince: null,
          routeId: selected.routeId ?? null,
          routeShortName: null,
          tripId: selected.tripId ?? null,
          vehicleId
        })
      )
    }

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
        routeId,
        tripId,
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
    // The rider explicitly told us their route — stamp the sticky riding fact
    // so no later flow re-asks which bus they're on.
    const prevRiding = goMode?.riding
    dispatch(
      setRiding({
        boardedAt: prevRiding?.boardedAt ?? Date.now(),
        headsign: chosen?.tripHeadsign ?? null,
        legIndex: goMode?.routeMatch?.legIndex ?? -1,
        offRouteSince: null,
        routeId,
        routeShortName: null,
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
