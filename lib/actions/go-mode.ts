/* eslint-disable sort-imports-es6-autofix/sort-imports-es6 -- the autofixer is
   non-convergent for this file's mix of value + type relative imports (it keeps
   hoisting a type import above sibling value imports); order is hand-maintained. */
import { createAction } from 'redux-actions'
import { format, utcToZonedTime } from 'date-fns-tz'
import coreUtils from '@opentripplanner/core-utils'
import polyline from '@mapbox/polyline'
import type { Itinerary, LatLngArray, Leg } from '@opentripplanner/types'

import {
  builtAlightStop,
  clampNonLiveLegTimes,
  findStopTimeIndex,
  getDownstreamStops,
  hasLiveArrival,
  journeySignature,
  liveStopArrival,
  mergeLiveTimePoint,
  ONBOARD_CANDIDATE_SETTLE_MS,
  pickSameRouteAlight,
  rankAlightOptions,
  selectCandidateStops,
  settleCandidatePlans
} from '../util/go-mode/alight-optimizer'
import type { AlightCandidateResult } from '../util/go-mode/alight-optimizer'
import {
  calculateTripProgress,
  hasArrivedAtDestination
} from '../util/go-mode/progress-calculator'
import {
  BOARD_AUTO_CONFIRM_MIN_CONSECUTIVE,
  decideRiding,
  ridingFactIsEvidenced,
  trackBoardStopDwell,
  vehicleReachedBoardStop
} from '../util/go-mode/riding'
import {
  estimateBikeSpeedMps,
  recordRiderSpeedSample,
  withObservedBikeSpeed
} from '../util/go-mode/rider-speed'
import {
  destinationStalled,
  noteDestinationDistance,
  noteReplanAttempt
} from '../util/go-mode/destination-progress'
import {
  latchStopsRemaining,
  getNextStopOnRide
} from '../util/go-mode/next-stop'
import {
  checkBoardVehicleApproach,
  checkDestinationUnreachable,
  checkForNotifications,
  checkMissedBus,
  classifyMissedBus,
  findBoardLegIndex,
  itineraryArrivalMs,
  nextDeviationHandledAtMs,
  resetDelayAlerts,
  resetLegAnnouncements,
  resetTurnAnnouncements,
  showNotification
} from '../util/go-mode/notification-service'
import {
  findNearbyVehicles,
  matchUserToVehicle,
  shouldShowBoardingPrompt,
  speedAdjustedRadius
} from '../util/go-mode/vehicle-matching'
import {
  assessRiderGpsTrust,
  findRidingVehicle,
  findVehicleById,
  findVehicleForTrip,
  isVehicleRecordFresh,
  matchProvesAboard,
  refreshConfirmedMatch,
  shouldRebindRidingTrip,
  shouldReplanBoardedEarlier,
  stopsAheadFromNextStopId,
  vehicleProgressOnLeg
} from '../util/go-mode/transit-trust'
import { getRoutingProfile } from '../util/routing-profiles'
import {
  calculateDistance,
  matchPositionToRoute,
  shouldTransitionToNextLeg
} from '../util/go-mode/position-matching'
import {
  extractItineraryTimedPoints,
  findClosestPolylineIndex,
  haversineDistance,
  sliceTripGeometryForLeg
} from '../util/go-mode/geometry'
import {
  assessMatchTrust,
  legGeometryUsable
} from '../util/go-mode/geometry-trust'
import type { TimedSimulationPoint } from '../util/go-mode/geometry'
import { resumedTransitionedLegIndex } from '../util/go-mode/session-persistence'
import { createTripSession } from '../util/go-mode/trip-session'
import type { TripSession } from '../util/go-mode/trip-session'
import type { LiveLegTime, RidingState } from '../util/go-mode/types'
import { spliceAccessOntoItinerary } from '../util/go-mode/access-splice'
import { legAlight } from '../util/go-mode/live-itinerary'
import {
  buildBannedRoutes,
  ROUTE_LOCK_MODES,
  routeLockIds,
  withRouteLockPrefs
} from '../util/route-lock'
import {
  mergeAdjacentSameTripLegs,
  normalizeGoModeItinerary,
  polylineLength,
  repairLegTimeInversions
} from '../util/go-mode/leg-merge'
import {
  collectRerouteCandidates,
  itinerarySignature,
  onwardTransitRouteId
} from '../util/go-mode/reroute-candidates'
import {
  getActiveItinerary,
  pickAccessReplanCandidate,
  pickSameRouteReroute
} from '../util/state'
import type {
  AlightContext,
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
import {
  acceptAutoReplan,
  pickHopFreeSibling
} from '../util/go-mode/replan-acceptance'
import { accessArriveByTarget } from '../util/go-mode/arrive-on-time'
import { ridingSuppressedByRider } from '../util/go-mode/boarding-confirmation'
import { isTripRecordingEnabled } from '../util/debug-log'
import { fetchOnboardContext } from '../util/go-mode/onboard-discovery'
import {
  hasNativeGps,
  nativeGpsDistanceFilter,
  restartNativeGps,
  setNativeGpsDistanceFilter,
  startNativeGps,
  stopNativeGps
} from '../util/go-mode/native-gps'
import {
  nativeGpsDistanceFilterFor,
  shouldRestartNativeWatcher,
  shouldSeedProgressFromLastFix
} from '../util/go-mode/tracking-gates'
import {
  anchorBoardingStopId,
  currentServiceDate,
  evaluateDepartureAnchor,
  getRouteDepartures
} from '../util/go-mode/departure-anchor'
import {
  TURN_CARD_NOTIFICATION_ID,
  cancelPush,
  ensureNativeNotifyPermission,
  hasNativeNotify,
  sendPush
} from '../util/go-mode/native-notify'
import {
  PACING_CARD_NOTIFICATION_ID,
  evaluatePacingCard
} from '../util/go-mode/pacing-card'
import { evaluateTurnCard } from '../util/go-mode/turn-card'
import { evaluateMissedBusRecovery } from '../util/go-mode/missed-bus-recovery'
import {
  quietReplanAdmitted,
  remainingAccessDistanceM,
  shouldQuietReplanAccessLeg,
  smoothDistanceFromRoute,
  trimQuietReplanHistory,
  willQuietReplanAccessLeg
} from '../util/go-mode/deviation'
import { evaluateDepartureDrift } from '../util/go-mode/departure-drift'
import type { DepartureBaselineState } from '../util/go-mode/departure-drift'
import type { PacingCardState } from '../util/go-mode/pacing-card'

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
import { setMainPanelContent, setMobileScreen, setViewedStop } from './ui'
import { setQueryParam } from './form'

// The mutable state of the trip in progress. One object, one lifetime: created
// here for the first trip of the page, replaced wholesale by endGoMode. See
// util/go-mode/trip-session.ts for why it is not 21 loose `let`s any more.
let session: TripSession = createTripSession()

// Native fix-staleness watchdog. iOS occasionally wedges a background
// location watcher without erroring (7/29: minutes of silence mid-ride while
// the trip state aged in place); the only recovery is tearing the watcher
// down and starting a new one. Wall-clock, because the whole point is
// detecting that the position stream — the app's heartbeat — has died.
let lastFixAtMs = 0
// 45s of silence on a ~1/s stream before restarting — never churns a healthy
// watcher, still recovers within one missed traffic light.
const GPS_WATCHDOG_MS = 45000
// How often the watchdog looks. Cheap check, no dispatch on the happy path.
// 15s, not 30: the check interval is pure latency on top of the budget, and on
// 2026-08-31 that made a 45s rule fire at exactly 60s of dead navigation.
const GPS_WATCHDOG_POLL_MS = 15000
// A restart is not proof of a fix. While one is still unproven the budget
// shortens to this, for GPS_WATCHDOG_MAX_FAST_RETRIES tries, and then backs off
// to GPS_WATCHDOG_MS — a radio that is genuinely dead must not be torn down and
// rebuilt every 20 seconds for the rest of the trip. On 2026-08-31 the first
// restart delivered one 1615m cell-tower fix and wedged again, and the rider
// waited a second full 60s window for the restart that actually worked.
const GPS_WATCHDOG_RETRY_MS = 20000
const GPS_WATCHDOG_MAX_FAST_RETRIES = 2
// Restarts since the last fix actually arrived. Reset by handlePositionUpdate,
// which is the only proof the stream is alive.
let nativeGpsRestartsSinceLastFix = 0
// How old the last fix may be and still be worth re-running to fill the boot
// card left by a mid-trip replan. Two minutes: long enough to cover the GPS
// wedge that produced the 2026-08-31 blank screen, short enough that it can
// never place the rider at a previous trip's position.
const SEED_PROGRESS_MAX_AGE_MS = 120000

function stopGpsWatchdog() {
  if (session.gpsWatchdogIntervalId) {
    clearInterval(session.gpsWatchdogIntervalId)
    session.gpsWatchdogIntervalId = null
  }
}

// Reroute-snapshot capture interval (recording only). Periodically records the
// "alternatives to finish the trip" as a request/response pair so a replay can
// surface them by timestamp for debugging. See captureRerouteSnapshot.
// How often to capture; each tick is a real isolated plan() call.
const REROUTE_SNAPSHOT_INTERVAL_MS = 90000

// ...and how often while the rider is settled: verifiably aboard a vehicle,
// with the match confirmed and the position on the route's own shape.
//
// The snapshot is a RECORDING, not a probe — nothing consumes REROUTE_SNAPSHOT
// and no reducer handles it — but recording is not free: every tick is a real
// isolated plan() call from a phone on cellular, plus a 200-580 KB debug-log
// payload. On 2026-09-01's third ride 14 fired in 21 minutes, seven of them
// while the rider was CONFIRM_VEHICLE-confirmed aboard a moving bus on I-35W,
// against ONE real reroute all ride. Alternatives-to-finish-the-trip is the
// least interesting question that can be asked of a rider who is sitting on
// their bus and on their line; the onboard alight snapshots cover what is
// interesting there. So the cadence stretches rather than stopping — the
// record stays continuous, at a quarter of the cost.
const REROUTE_SNAPSHOT_RIDING_INTERVAL_MS = 360000

// Wall-clock throttle for re-polling live transit leg times off GTFS-realtime.
// handlePositionUpdate fires on every GPS/simulation tick (as fast as ~1s), but
// re-fetching each upcoming trip's schedule that often is wasteful — 20s keeps
// the overview current without hammering OTP. Reset to 0 per trip so the first
// tick fetches immediately.
const LIVE_LEG_TIMES_INTERVAL_MS = 20000

// Quiet access-leg replans that keep coming back empty (fetch failed, or the
// never-force-a-route-change picker rejected everything) are counted but
// settle silently: the ROUTE_DEVIATION notification already fired and the
// ever-present TripSheet ("View trip & other ways") is the rider's escape
// hatch — prompting again would be redundant. The streak (scoped AND fallback
// both came up empty) is kept as bookkeeping for the debug log.

// The scoped access replan (GPS → boarding stop, single mode) is a
// point-to-stop query — OTP rarely returns more than 2 distinct paths and the
// picker takes the fastest anyway, so 3 keeps the fetch light.
const ACCESS_REPLAN_NUM_ITINERARIES = 3

// A single wild GPS fix (urban multipath) can put the matched distance
// kilometers off-route for one tick — 5836 m mid-ride on 7/22, while riding
// the bus dead on its line. Deviation handling only sees a distance that
// exceeded reality on the PREVIOUS tick too, so one-tick glitches vanish and
// sustained drift passes through one tick late.

// Auto-anchor bookkeeping (see the throttled block in handlePositionUpdate).
// The rider's explicit departure pick (or "Reset to planned") must never be
// fought by the auto-anchor, so a manual selectDeparture locks auto-anchoring
// off for the current boarding. session.lastAutoAnchorMs lets the anchor keep chasing
// the live feed while the current override is its own.

// The boarded-earlier replan retries per boarding (spaced, capped) rather than
// one-shot: a single lost fetch used to strand the whole ride on the planned
// bus's times. Success ends the loop naturally — the applied itinerary boards
// the actual trip, so the trigger condition itself disappears.
const EARLY_BOARD_REPLAN_RETRY_MS = 60000
const EARLY_BOARD_REPLAN_MAX_ATTEMPTS = 3

// Identity (leg + cue index) of the turn currently on the sticky card, so it is
// re-posted only when the turn itself changes — once per turn, not once per GPS
// tick. Null when no card is showing.

// What the sticky pacing card last showed (see pacing-card.ts). Null when no
// card is showing.

// The boarding being watched for departure jumps, and what the rider was last
// told about it (see departure-drift.ts). Module state for the same reason
// session.lastPacingCard is: it must survive a tick but never a trip.

// A leg transition is side-effectful (vehicle tracking, GPS interval restart,
// departure-override reset), so it must run once per leg. The route match is
// recomputed from raw position on every tick and cannot carry that fact.

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

// Minimum progress along a transit leg before GPS alone establishes
// aboard-ness. isOnRoute is true within 250m of the leg — including while
// still waiting at the boarding stop — so require clear movement along the

// A single recorded GPS fix from a replay fixture (see build-fixture.js).
interface ReplayGpsFix {
  accuracy?: number | null
  heading?: number | null
  lat: number
  lon: number
  speed?: number | null
  tMs: number
}

let simulationSpeedMultiplier = 1

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
  if (session.simulationActive && session.simulatedTimeMs > 0) {
    return new Date(session.simulatedTimeMs)
  }
  return new Date()
}

/**
 * The rider's own measured cycling speed for a plan query, or null when there
 * is not enough evidence to improve on the profile / engine default.
 *
 * One reading, shared by every re-plan builder, so two plans issued seconds
 * apart cannot time the same bike leg differently. The samples themselves are
 * collected on the tick (handlePositionUpdate) and only while the rider is
 * actually on a bike leg — see rider-speed.ts for why this is a rolling median
 * of moving fixes and not `position.coords.speed`.
 */
function observedBikeSpeedMps(): number | null {
  return estimateBikeSpeedMps(
    session.riderSpeedSamples,
    getCurrentTime().getTime()
  )
}

const { randId } = coreUtils.storage

// Action types
export const ADD_NOTIFICATION = 'ADD_NOTIFICATION'
export const CLEAR_RIDING = 'CLEAR_RIDING'
export const CLEAR_VEHICLE_MATCH = 'CLEAR_VEHICLE_MATCH'
export const CONFIRM_VEHICLE = 'CONFIRM_VEHICLE'
export const DISMISS_BOARDING_PROMPT = 'DISMISS_BOARDING_PROMPT'
// Recording only, like REROUTE_SNAPSHOT: no reducer consumes either, they
// exist to put a request/response pair in the debug stream for build-fixture.
export const ONBOARD_CANDIDATE_SNAPSHOT = 'ONBOARD_CANDIDATE_SNAPSHOT'
export const PAUSE_GPS_SIMULATION = 'PAUSE_GPS_SIMULATION'
export const REROUTE_SNAPSHOT = 'REROUTE_SNAPSHOT'
export const REPAIR_LEG_GEOMETRY = 'REPAIR_LEG_GEOMETRY'
export const RESUME_GO_MODE = 'RESUME_GO_MODE'
export const RESUME_GPS_SIMULATION = 'RESUME_GPS_SIMULATION'
export const SET_ARRIVED = 'SET_ARRIVED'
export const SET_DEPARTURE_OVERRIDE = 'SET_DEPARTURE_OVERRIDE'
export const SET_GO_MODE_ACTIVE_LEG = 'SET_GO_MODE_ACTIVE_LEG'
export const SET_GO_MODE_BACKGROUNDED = 'SET_GO_MODE_BACKGROUNDED'
export const SET_MAP_FOLLOW = 'SET_MAP_FOLLOW'
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
// Types moved to util/go-mode/types.ts; re-exported so existing imports of
// `LiveLegTime` / `RidingState` from this module keep working.
export type { LiveLegTime, RidingState } from '../util/go-mode/types'

export const clearVehicleMatch = createAction(CLEAR_VEHICLE_MATCH)
export const dismissBoardingPrompt = createAction(DISMISS_BOARDING_PROMPT)
export const showBoardingPromptAction = createAction(SHOW_BOARDING_PROMPT)
export const startGoMode = createAction<{
  itinerary: Itinerary
  originalFrom?: any
}>(START_GO_MODE)
export const stopGoMode = createAction(STOP_GO_MODE)
/**
 * A trip picked up again after the page went away and came back — the marker a
 * RESUMED ride begins with, and the only record that it did.
 *
 * It changes no state: create-otp-reducer has already rebuilt the trip from
 * storage by the time this is dispatched, so there is nothing left to set (and
 * so, deliberately, nothing in goModeReducer and nothing in that reducer's
 * delegation list — the trap where a new goMode type is silently dropped does
 * not apply to a type no reducer handles).
 *
 * What it is FOR is the record. A resumed ride emitted no START_GO_MODE, so
 * build-fixture.js could not find where it began: the 2026-08-31 18:52 session
 * ran 104 minutes and was unreplayable, and it is the session that turned out
 * to matter most. The payload therefore carries the itinerary, exactly as
 * START_GO_MODE does, so the same builder can bracket a resumed ride from it —
 * and `arrivedAt`, because whether the trip it resumed was already OVER is the
 * first thing anyone reading that log needs to know.
 */
export const resumeGoMode = createAction<{
  arrivedAt: number | null
  itinerary: Itinerary
  resumed: true
}>(RESUME_GO_MODE)
export const updatePosition = createAction<GeolocationPosition>(UPDATE_POSITION)
export const updateRouteMatch = createAction<RouteMatchResult | null>(
  UPDATE_ROUTE_MATCH
)
export const updateProgress = createAction<TripProgress>(UPDATE_PROGRESS)
export const transitionLeg = createAction<{ legIndex: number }>(TRANSITION_LEG)

export const setLiveLegTimes =
  createAction<Record<number, LiveLegTime>>(SET_LIVE_LEG_TIMES)

// Replace one leg's missing/degenerate polyline with a slice of its trip's
// real shape, once the trip fetch that failed at itinerary-build time finally
// lands. Only ever an improvement: the dispatcher (refreshLiveLegTimes) fires
// it solely for a leg whose current geometry is unusable for matching.
export const repairLegGeometry = createAction<{
  legGeometry: { length: number; points: string }
  legIndex: number
}>(REPAIR_LEG_GEOMETRY)

// Epoch ms of the moment trip progress first read "completed" — the rider is
// at their destination and Go Mode shows the arrival card until they dismiss.
export const setArrived = createAction<number>(SET_ARRIVED)

export const setRiding = createAction<RidingState>(SET_RIDING)
export const clearRiding = createAction(CLEAR_RIDING)
export const addNotification = createAction<NotificationEvent>(ADD_NOTIFICATION)
export const setTrackingError = createAction<GeolocationPositionError | null>(
  SET_TRACKING_ERROR
)
export const toggleMapFollow = createAction(TOGGLE_MAP_FOLLOW)
// Idempotent "set" alongside the toggle: auto-disengage (map drag/rotate)
// must never race the follow button — dispatching false twice stays false.
export const setMapFollow = createAction<boolean>(SET_MAP_FOLLOW)
export const setGoModeBackgrounded = createAction<boolean>(
  SET_GO_MODE_BACKGROUNDED
)

/**
 * The leg the rider tapped in the trip sheet, mirroring the planner's
 * activeLeg: the Go Mode map zooms to it and draws it as selected. null means
 * "no selection" — the map is back to the whole trip.
 */
export const setGoModeActiveLeg = createAction<number | null>(
  SET_GO_MODE_ACTIVE_LEG
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
    session.manualDepartureLock = true
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

export const beginOnboardFlowAction = createAction<{
  /** The route the rider already chose for the leg after this bus. The reducer
   * reads this (it is what ranks the rider's own route up in the alight
   * options); the type simply never said so. */
  keepRouteId?: string | null
  originalFrom?: any
}>(BEGIN_ONBOARD_FLOW)
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
 * GPS cadence once the rider has arrived, replacing the per-leg value above.
 *
 * Nothing behind the static arrival card is time-critical any more — no
 * matching, no notifications, no reroutes (the tick quiesces; see setArrived
 * below) — so the only thing left for a fix to do is keep the blue dot roughly
 * where the rider is. Twice a minute does that, and is the same order as the
 * GPS watchdog's own poll. 30 s rather than "stop entirely" because the trip is
 * only over when the rider says so: they may still be walking the last block,
 * and Go Mode has to keep drawing them.
 */
const ARRIVED_TRACKING_INTERVAL_MS = 30000

/**
 * The token-hop thresholds, from config where the deployment sets them. Same
 * two keys the results list reads (narrative-itineraries), so the rule the
 * rider sees applied to the list is the rule applied to an automatic swap.
 * Undefined falls through to the defaults in util/itinerary.
 */
function tokenHopMeters(state: any): number | undefined {
  return state?.otp?.config?.itinerary?.tokenTransitHopMeters
}

function tokenHopToleranceMs(state: any): number | undefined {
  const minutes = state?.otp?.config?.itinerary?.tokenTransitHopToleranceMinutes
  return minutes != null ? minutes * 60000 : undefined
}

/**
 * The one place an AUTOMATIC itinerary replacement is judged against the plan
 * it would replace — arrival, and whether it starts where the rider is. Every
 * auto-apply path funnels through here before its `beginGoMode`; the rules and
 * the evidence behind them live in util/go-mode/replan-acceptance.
 *
 * Returns true when the swap must NOT happen. Callers settle their own
 * bookkeeping (setRerouteResult / the quiet-replan miss streak) exactly as they
 * do when a plan comes back empty, so retry semantics are unchanged: refusing a
 * worse plan is the same outcome as finding no plan, not an error.
 */
function autoReplanRejected(
  state: any,
  candidate: Itinerary,
  options: { currentPlanIsDead?: boolean; reason?: string | null } = {}
): boolean {
  const goMode = state?.otp?.goMode
  const coords = goMode?.tracking?.lastPosition?.coords
  const verdict = acceptAutoReplan(candidate, goMode?.activeItinerary, {
    currentPlanIsDead: !!options.currentPlanIsDead,
    position: coords
      ? ([coords.latitude, coords.longitude] as [number, number])
      : null,
    riding: !!goMode?.riding?.tripId,
    tokenHopMaxMeters: tokenHopMeters(state),
    tokenHopToleranceMs: tokenHopToleranceMs(state)
  })
  if (verdict.accept) return false
  // eslint-disable-next-line no-console
  console.log(
    `[go-mode] auto replan (${options.reason || 'unknown'}) refused: ${
      verdict.reason
    }`
  )
  return true
}

/**
 * Start Go Mode tracking for an itinerary
 */
export function beginGoMode(rawItinerary: Itinerary) {
  return async function (dispatch: any, getState: any) {
    // The one choke point every itinerary entering Go Mode passes through —
    // onboard confirm, aboard replan, auto-reroute, quiet access replan, the
    // explicit reroute apply, session restore and the normal start. Returns
    // the input reference when nothing merges, so a clean itinerary stays
    // object-identical and spliceAccessOntoItinerary's same-objects promise
    // (the 7/29 "only reroute the bike leg" fix) still holds.
    const itinerary = normalizeGoModeItinerary(rawItinerary) as Itinerary
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
  return function (dispatch: any, getState: any) {
    // The mobile shell renders mainPanelContent (route/nearby/trip viewers) and
    // a viewed stop AHEAD of the mobile screen, so a rider who reached one of
    // those from the app menu would tap the banner, be back in Go Mode by every
    // measure of state, and still be looking at the viewer.
    const { ui } = getState().otp
    if (ui.mainPanelContent !== null) dispatch(setMainPanelContent(null))
    if (ui.viewedStop) dispatch(setViewedStop(null))
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
    // A trip that had ALREADY ARRIVED when the page came back. Everything below
    // that starts a repeating job — the boarding stop-time prefetch, live
    // vehicle polling, the reroute-snapshot capture, and the GPS poll's own
    // cadence — exists to serve a trip with something left to do, and this one
    // has nothing. Restoring `arrivedAt` (cb453726) made the arrival visible
    // here; this is what acts on it, and it is the difference between a resumed
    // arrival card and the 2026-08-31 18:52 mount, which came back and armed
    // the whole live-trip machine over a rider standing 41 m from their door.
    //
    // Position tracking still starts: the map and the arrival card stay honest,
    // and handlePositionUpdate's post-arrival funnel holds the work to one fix
    // per ARRIVED_TRACKING_INTERVAL_MS.
    const resumedArrived = getState().otp?.goMode?.arrivedAt != null

    // A reroute or missed-bus auto-update swaps the itinerary without going
    // through endGoMode, so clear the per-leg transition guard here too.
    session.lastTransitionedLegIndex = null
    // ...and the deviation smoother's memory. smoothDistanceFromRoute takes the
    // MINIMUM of this tick and the last, so a distance measured against the old
    // geometry damps the first tick against the new — the one tick where the
    // rider's relationship to the route has genuinely just changed. It was
    // cleared only in endGoMode, so every swap carried a stale number across.
    session.prevDistanceFromRoute = null
    // Damping ONE tick is not enough for the alert: on 2026-08-27 the off-route
    // push landed 0.9 s after this swap's START_GO_MODE (13:14:04) and 1.25 s
    // after a leg transition (13:16:20, "5464m from the planned route"). Give
    // the rider the convergence window before accusing them of drifting off a
    // line they have only just been handed.
    session.geometryChangedAtMs = getCurrentTime().getTime()

    // Pre-fetch stop times for all transit boarding stops
    const today = currentServiceDate(
      getCurrentTime().getTime(),
      getState().otp.config.homeTimezone
    )
    for (const leg of resumedArrived ? [] : itinerary.legs) {
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
      if (session.simulationActive && session.simulatedTimeMs > 0) {
        session.simulatedTimeMs += ms
      }
    }
    w.__pingPosition = () => {
      const last = getState().otp?.goMode?.tracking?.lastPosition
      if (last) dispatch(handlePositionUpdate(last))
    }

    // Set initial tracking interval based on first leg — except on a trip that
    // is already over, which resumes at the post-arrival cadence rather than
    // at leg 0's. On 2026-08-31 both mounts dispatched `interval: 10000` for a
    // finished trip's first leg and then streamed at 1 Hz for 104 minutes.
    const interval = resumedArrived
      ? ARRIVED_TRACKING_INTERVAL_MS
      : getTrackingIntervalForLeg(itinerary.legs[0])
    dispatch(updateTrackingInterval({ interval }))

    // Start vehicle tracking if first leg is transit. Never on a resumed
    // arrival: there is no bus left to match, and this poll is the one that
    // outlives the tick — it has no arrival guard of its own. Arming it here
    // for a FINISHED trip whose leg 0 happened to be the bus is what produced
    // 392 vehicle-position responses over the 104 minutes of the 2026-08-31
    // 18:52 mount.
    const firstLeg = itinerary.legs[0]
    const firstLegRouteId = getLegRouteId(firstLeg)
    if (!resumedArrived && firstLeg?.transitLeg && firstLegRouteId) {
      dispatch(startVehicleTracking(firstLegRouteId))
    }

    // Trip replay drives position from the recorded GPS track (startTrackReplay),
    // not the device — skip the geolocation permission check and live polling.
    if (options.replay) {
      return
    }

    // Recording sessions only: periodically capture the "alternatives to finish
    // the trip" as request/response pairs for later replay/debugging.
    // ...but never for a trip that has already arrived: an "alternatives to
    // finish the trip" probe on a finished trip is a real plan() call with
    // nothing to plan toward. captureRerouteSnapshot stops the interval on its
    // first tick, which bounds the damage at one probe and 90 s; not arming it
    // is the honest version, and it is what the ×4 in the 18:52 session was.
    if (isTripRecordingEnabled() && !resumedArrived) {
      startRerouteSnapshotCapture(dispatch)
    }

    // Fill the boot card, when there is an honest way to fill it.
    //
    // START_GO_MODE nulls `progress` (reducers/go-mode.ts:696) and GoModeScreen
    // renders "Starting Trip… / Acquiring GPS signal…" while it is null. On a
    // fresh trip that is the truth. On a mid-trip replan it is not: the rider
    // is moving, the app knows where they are, and the screen goes blank until
    // the next fix happens to land. On 2026-08-31 the auto-applied
    // "boarded-earlier" replan re-dispatched START_GO_MODE at 17:15:01 and the
    // native watcher wedged on the same second; the next position arrived at
    // 17:16:01. The rider spent that minute on a bus platform looking at a boot
    // screen — "What's going on / Why don't you answer me" — with the 17:15:01
    // fix sitting in the store the whole time.
    //
    // Re-running that fix through the pipeline recomputes progress against the
    // NEW itinerary, which is exactly what the screen is waiting for. Age-gated:
    // a fix older than SEED_PROGRESS_MAX_AGE_MS would put the rider where they
    // are not, and the honest card is better than that.
    if (!session.simulationActive) {
      const seedState = getState().otp?.goMode
      const lastFix = seedState?.tracking?.lastPosition
      if (
        shouldSeedProgressFromLastFix({
          hasProgress: seedState?.progress != null,
          lastPositionMs: lastFix?.timestamp,
          maxAgeMs: SEED_PROGRESS_MAX_AGE_MS,
          nowMs: Date.now()
        })
      ) {
        dispatch(handlePositionUpdate(lastFix))
      }
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
 * The leg the trip has actually TRANSITIONED onto, for the session save.
 *
 * `session` is module-private and rebuilt by every page load, so this field
 * cannot ride in the store and cannot be read from `session-persistence`
 * either — that would point the dependency the wrong way round. `main.js`
 * already owns both sides of the save (it hands across the debug session id
 * for the same reason), so it reads it here and passes it in. See 6.30.
 */
export function currentTransitionedLegIndex(): number | null {
  return session.lastTransitionedLegIndex
}

/**
 * Pick a saved trip back up after the page went away and came back.
 *
 * create-otp-reducer has already rebuilt the trip from storage by the time this
 * runs; all that is left is to say so in the record and re-arm tracking. It
 * exists as its own entry point, rather than a bare startGoModeTracking call in
 * main.js, for one reason: a resumed ride had no beginning anyone could find.
 * `beginGoMode` dispatches START_GO_MODE and the resume path did not, so
 * build-fixture.js — which brackets a ride from START_GO_MODE to trip end —
 * could not build one at all. The 2026-08-31 18:52 session is the case: 104
 * minutes, 6,100 position/match/progress triples, and no way to replay a second
 * of it.
 */
export function resumeGoModeTrip() {
  return async function (dispatch: any, getState: any) {
    const goMode = getState().otp?.goMode
    if (!goMode?.isActive || !goMode.activeItinerary) return
    dispatch(
      resumeGoMode({
        arrivedAt: goMode.arrivedAt ?? null,
        itinerary: goMode.activeItinerary,
        resumed: true
      })
    )
    await dispatch(startGoModeTracking(goMode.activeItinerary))

    // Put the transition guard back — AFTER startGoModeTracking, which clears
    // it (it is the itinerary-swap reset, and a resume comes through the same
    // door). Left at null, `previousLegIndex` reads 0 on the first resumed
    // tick, `routeMatch.legIndex !== null` is trivially true, and the trip
    // announces a TRANSITION_LEG onto the leg the rider is already on: a leg
    // change in the record that never physically happened, and one ride-watch
    // reads as real (6.30).
    //
    // Suppressing the dispatch would have been the wrong fix. `advanceToLeg`
    // is the ONLY place `startVehicleTracking` runs for a mid-trip transit
    // leg, and `startGoModeTracking` arms it for leg 0 alone — so a resume
    // that merely stopped transitioning would come back with no vehicle
    // polling at all for the bus the rider is sitting on. Restore the guard
    // and do that leg's arming explicitly.
    const resumedLegIndex = resumedTransitionedLegIndex()
    const legs = goMode.activeItinerary.legs || []
    if (resumedLegIndex == null || !legs[resumedLegIndex]) return
    session.lastTransitionedLegIndex = resumedLegIndex

    // Never on a resumed ARRIVAL: there is no bus left to match, and this poll
    // outlives the tick — arming it for a finished trip is what produced the
    // 392 vehicle-position responses of the 2026-08-31 18:52 mount. Leg 0 is
    // excluded because startGoModeTracking has already handled it, and
    // re-arming would re-stamp transitLegEnteredAt for no reason.
    const resumedLeg: any = legs[resumedLegIndex]
    const resumedRouteId = getLegRouteId(resumedLeg)
    if (
      getState().otp?.goMode?.arrivedAt == null &&
      resumedLegIndex > 0 &&
      resumedLeg?.transitLeg &&
      resumedRouteId
    ) {
      dispatch(startVehicleTracking(resumedRouteId))
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

    // Everything the session HOLDS ON TO outside itself has to be released
    // before the session goes: timers keep firing, the listener keeps the
    // handler alive, and the two sticky cards live on the rider's phone (and
    // their watch) until they are cancelled.
    if (session.gpsPollingIntervalId)
      clearInterval(session.gpsPollingIntervalId)
    if (session.vehiclePositionIntervalId) {
      clearInterval(session.vehiclePositionIntervalId)
    }
    if (session.gpsSimulationTimeoutId) {
      clearTimeout(session.gpsSimulationTimeoutId)
    }
    if (session.visibilityChangeHandler) {
      document.removeEventListener(
        'visibilitychange',
        session.visibilityChangeHandler
      )
    }
    stopGpsWatchdog()
    stopRerouteSnapshotCapture()
    // Stop the native background-location stream (iOS shell) — ends the blue
    // location indicator and the battery draw between trips. Its watchdog is
    // already down, so it can't restart the stream it just lost.
    stopNativeGps()
    if (session.lastTurnCardKey !== null) cancelPush(TURN_CARD_NOTIFICATION_ID)
    if (session.lastPacingCard !== null) cancelPush(PACING_CARD_NOTIFICATION_ID)
    // The per-leg turn-announcement latch lives in notification-service, keyed
    // on the leg OBJECT, and is permanent for that object's life — which
    // assumes a new trip brings new legs. False on the retry path, where
    // handleRetry re-enters beginGoMode with the same itinerary and
    // normalizeGoModeItinerary hands back the same legs; without this reset
    // every cue already announced stays silent for the whole retried trip.
    // Here and not in beginGoMode: a quiet access replan re-enters there
    // mid-trip with the transit legs deliberately object-identical, and
    // re-arming then is the 7/31 notification storm again.
    resetTurnAnnouncements()
    // The leg-entry latch is keyed the same way and makes the same assumption,
    // so it is re-armed in the same place and for the same retry-path reason.
    resetLegAnnouncements()
    // Same story for the warned-lateness baseline: keyed on the leg object, so
    // a retry that reuses the legs would inherit what the previous attempt had
    // already said and swallow the retried trip's first delay alert.
    resetDelayAlerts()

    // ...and then the trip's state goes in one line. Anything added to
    // TripSession is cleared by this automatically — which is the point.
    session = createTripSession()

    // Remove console simulation helpers
    const w = window as any
    delete w.__startGpsSimulation
    delete w.__stopGpsSimulation
    delete w.__pauseGpsSimulation
    delete w.__resumeGpsSimulation
    delete w.__advanceSimulatedTime
    delete w.__pingPosition

    dispatch(stopGoMode())

    // If a mid-trip search replaced the origin with the rider's GPS position,
    // restore the origin they started with so the trip planner isn't left
    // showing "Current location". Automatic re-routes are isolated plans and
    // never touch currentQuery, but browseFromCurrentPosition deliberately
    // does — it IS a real search — so this restore is load-bearing.
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
 * Where a mid-trip search should start FROM. Aboard a bus, "current position"
 * is a moving mid-street point the rider can't act on, so plan from the next
 * stop ahead on their line, anchored to when the bus gets there. Otherwise plan
 * from the GPS fix, now. Shared by the isolated auto-reroute and the rider's
 * own "Search from here" so the two never disagree about where they are.
 */
function currentPositionOrigin(state: any): {
  date: string
  from: any
  time: string
} | null {
  const goMode = state.otp.goMode
  const lastPosition: GeolocationPosition | null =
    goMode?.tracking?.lastPosition
  if (!lastPosition) return null
  const { homeTimezone } = state.otp.config

  const riding = goMode?.riding
  const nextStop = riding ? getNextStopOnRide(state) : null
  if (riding && nextStop) {
    const zoned = utcToZonedTime(nextStop.arrivalEpoch, homeTimezone)
    return {
      date: format(zoned, coreUtils.time.OTP_API_DATE_FORMAT),
      from: { lat: nextStop.lat, lon: nextStop.lon, name: nextStop.name },
      time: format(zoned, coreUtils.time.OTP_API_TIME_FORMAT)
    }
  }
  return {
    date: coreUtils.time.getCurrentDate(homeTimezone),
    from: {
      category: 'CURRENT_LOCATION',
      lat: lastPosition.coords.latitude,
      lon: lastPosition.coords.longitude,
      name: 'Current location'
    },
    time: coreUtils.time.getCurrentTime(homeTimezone)
  }
}

/**
 * The rider's own "show me other ways from here": run a REAL search — origin at
 * their actual position (or the next stop ahead when aboard), destination
 * unchanged — and hand them the normal trip-planner results screen, which
 * already has the expand-map/list toggle, tap-a-leg-to-zoom, and a "Switch to
 * this trip" button on every itinerary (metro-itinerary renders it whenever
 * goMode.isActive). The trip keeps running behind the ReturnToTripBanner.
 *
 * Unlike reRouteFromCurrentPosition this deliberately DOES touch currentQuery
 * and the active search — that is what makes the planner render it. The
 * isolation rule applies to AUTOMATIC re-routes (which must never disturb a
 * planner the rider is reading), not to a search the rider just asked for.
 * endGoMode restores goMode.originalFrom afterwards.
 *
 * VERIFIABLY ABOARD a known bus (sticky riding fact with a tripId), the
 * question "other ways from here" really means "where should I get off THIS
 * bus" — a point-to-point plan from a mid-street moving position can invent
 * itineraries that require boarding a bus the rider is already on (or worse,
 * getting off it). Those requests hand off to replanFromAboard's explicit
 * path, which drives the existing onboard alight-stop UI. One gate here
 * covers all three TripSheet entries (profile chips, "Search from here", the
 * NL box). A route-only riding fact (no tripId) keeps today's planner search.
 */
export function browseFromCurrentPosition(
  options: { preferences?: any; profileId?: string } = {}
) {
  return function (dispatch: any, getState: any) {
    const state = getState()
    const goMode = state.otp.goMode
    const itinerary: Itinerary | null = goMode?.activeItinerary
    const legs = itinerary?.legs || []
    const destLeg = legs[legs.length - 1]
    const origin = currentPositionOrigin(state)

    if (goMode?.riding?.tripId && itinerary) {
      dispatch(
        replanFromAboard({
          autoApply: false,
          preferences: options.preferences,
          profileId: options.profileId,
          reason: 'rider-reroute'
        })
      )
      return
    }

    // No fix or no destination yet: fall back to the plain step-out rather than
    // dead-ending the button. The rider still lands in the planner.
    if (!itinerary || !destLeg || !origin) {
      dispatch(backgroundGoMode())
      return
    }

    // Same preference ladder as the auto-reroute: an explicit profile wins,
    // then caller-supplied levers, then (mid-ride) stay-seated so transfers
    // away from the boarded bus cost extra.
    const profile = options.profileId
      ? getRoutingProfile(options.profileId)
      : undefined
    const riding = goMode?.riding
    const nextStop = riding ? getNextStopOnRide(state) : null
    const routingPreferences =
      profile?.prefs ??
      options.preferences ??
      (riding && nextStop ? getRoutingProfile('stay-seated')?.prefs : undefined)

    dispatch(
      setQueryParam(
        {
          activeProfileId: profile?.id,
          date: origin.date,
          // Force depart-at: an earlier arrive-by search must not carry over
          // into "leave from here, now".
          departArrive: 'DEPART',
          from: origin.from,
          routingPreferences,
          time: origin.time,
          to: {
            lat: destLeg.to.lat,
            lon: destLeg.to.lon,
            name: destLeg.to.name
          }
        },
        // A searchId makes setQueryParam fire the real routingQuery, which
        // already biases toward goMode.riding.routeId ("stay on this bus"
        // ranks first) and suppresses recents while Go Mode is active.
        randId()
      )
    )

    dispatch(setGoModeBackgrounded(true))
    dispatch(setMobileScreen(MobileScreens.RESULTS_SUMMARY))
  }
}

/**
 * Re-plan from the rider's current GPS position to the trip destination as an
 * ISOLATED background plan (real OTP results — no fabricated data): no shared
 * currentQuery, no URL change, no active-search churn, so the trip planner the
 * rider may be browsing in the foreground is never disturbed. Results resolve
 * here in the thunk (screen-independent) into goMode.reRoute and are
 * auto-apply-or-discard: applyAutoReroute swaps in a same-route result, and
 * anything else settles as bookkeeping (nothing renders goMode.reRoute
 * candidates since eb74a9d8 replaced the Switch/Keep card with the planner —
 * manual alternatives live there via browseFromCurrentPosition). Optionally
 * applies a routing profile.
 */
export function reRouteFromCurrentPosition(
  options: {
    // Apply the best result automatically — used when the current itinerary
    // is definitively dead (missed bus) and there is nothing for the rider to
    // decide. Without it, results only settle reRoute bookkeeping.
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
    // Aboard a bus this resolves to the next stop ahead at the time the bus
    // gets there, else the GPS fix now — see currentPositionOrigin.
    const origin = currentPositionOrigin(state)

    // Need a real position and destination — never fabricate either.
    if (!itinerary || !lastPosition || !destLeg || !origin) {
      dispatch(setRerouteResult(null))
      return
    }

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
      date: origin.date,
      from: origin.from,
      modes,
      modeSettings,
      numItineraries,
      time: origin.time,
      to: {
        lat: destLeg.to.lat,
        lon: destLeg.to.lon,
        name: destLeg.to.name
      }
    }

    // Aboard a bus, prefer the rider's current route so "stay on this bus"
    // surfaces as the default choice. (The origin/time anchor for that case is
    // already applied above by currentPositionOrigin.)
    //
    // Soft, and deliberately so. The hard expression of "keep me on this bus"
    // is a splice from riding.tripId, which is what the AUTOMATIC aboard paths
    // now do (replanFromAboard, and the missed-bus branch of the position
    // tick). Banning the complement the way route-lock does is the wrong tool
    // here: route-lock means "ride this route and bike the rest", so it can ban
    // everything else, whereas a rider mid-ride usually still needs the
    // transfer that comes after this bus — banning it would return no plan at
    // all. What reaches this line is a route-only riding fact (no tripId, so
    // nothing to splice from), where a preference is the strongest honest
    // statement available.
    const riding = goMode?.riding
    const nextStop = riding ? getNextStopOnRide(state) : null
    if (riding && nextStop && riding.routeId) {
      payload.preferred = {
        otherThanPreferredRoutesPenalty: 900,
        routes: riding.routeId
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

    // Time the bike legs at the pace this rider is actually keeping. The
    // ladder above still decides everything else, and a bikeSpeed the rider
    // chose (bike-forward, or their own levers) is left alone — see
    // withObservedBikeSpeed. Routed through routingPreferences because that is
    // the channel applyRoutingPreferences merges AFTER generateOtp2Query, which
    // is the only way a lever the default planQuery does not declare survives.
    payload.routingPreferences = withObservedBikeSpeed(
      payload.routingPreferences,
      observedBikeSpeedMps()
    )

    // A named route outlives the search it was named in.
    //
    // "Only take the 18" was a search-time setting only: Go Mode re-routes build
    // an isolated payload and deliberately never touch currentQuery, so the ban
    // did not ride along and the lock silently evaporated the first time the app
    // re-planned mid-trip — the rider ended up on whatever came, having asked
    // for one route by name. If they said it, it holds until they clear it.
    //
    // Rebuilt from the live route index rather than reusing currentQuery.banned:
    // the index is the authority on which routes exist, and a ban list is only
    // correct if it is the complete complement of the kept route.
    //
    // Only a whole-trip lock is a ban. A "starting route" (#45) names the
    // vehicle the rider boards FIRST, and a mid-trip re-plan is not a first
    // boarding — banning the complement here would forbid exactly the
    // connections the rider deliberately left free.
    const routeLock = state.otp?.currentQuery?.routeLock
    const lockedRouteIds = routeLockIds(routeLock)
    if (lockedRouteIds.length && routeLock?.scope !== 'starting') {
      const banned = buildBannedRoutes(
        state.otp?.transitIndex?.routes,
        lockedRouteIds
      )
      if (banned) {
        payload.banned = { routes: banned }
        // Bike both ends: naming routes only makes sense with a personal
        // vehicle filling the gaps (see util/route-lock).
        payload.modes = ROUTE_LOCK_MODES
        payload.routingPreferences = withRouteLockPrefs(
          payload.routingPreferences
        )
        // The stay-seated/preferred bias is about keeping the rider on the bus
        // they are on. Under a lock the named routes already decide that, and a
        // preference for a now-banned route is just noise in the query.
        if (!lockedRouteIds.includes(payload.preferred?.routes as string)) {
          delete payload.preferred
        }
      }
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
 * nothing boards the same route, the attempt settles via setRerouteResult
 * (bookkeeping only — no UI renders the candidates since eb74a9d8, but the
 * 'none'-settle retry semantics are load-bearing for missed-bus retries).
 * Manual alternatives live in the planner via browseFromCurrentPosition,
 * behind the explicit "Find another way" button.
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
    // bike-the-whole-way options)... then take the hop-free version of
    // whatever the picker chose, if the same set carries one: keeping the
    // rider's route is the rule, keeping a 602 m ride between two bike legs is
    // not (2026-08-31, util/go-mode/replan-acceptance#pickHopFreeSibling).
    const rerouteCandidates = collectRerouteCandidates(allItineraries, 50)
    const best = pickHopFreeSibling(
      pickSameRouteReroute(rerouteCandidates, goMode.reRoute?.keepRouteId),
      rerouteCandidates,
      {
        maxHopMeters: tokenHopMeters(state),
        requireRouteId: goMode.reRoute?.keepRouteId ?? null,
        toleranceMs: tokenHopToleranceMs(state)
      }
    )
    if (!best) {
      // No same-route option (last run of the day, outside the search
      // window...): settle the attempt instead of auto-swapping — 'found'
      // keeps a later definitive miss from re-firing instantly, 'none' stays
      // retryable. The missed-bus push already told the rider.
      dispatch(
        setRerouteResult(displayCandidates?.length ? displayCandidates : null)
      )
      return
    }

    // A swap that changes nothing is not an update. Settling as 'none' keeps
    // it retryable; what it does not do is buzz the rider. See the note on
    // the same guard in replanFromAboard.
    if (
      itinerarySignature(best) === itinerarySignature(goMode.activeItinerary)
    ) {
      dispatch(setRerouteResult(null))
      return
    }

    // The missed-bus plan is the one case where a LATER arrival is the honest
    // answer — the itinerary being replaced cannot happen at all — so only the
    // origin half of the gate applies here.
    if (
      autoReplanRejected(state, best, {
        currentPlanIsDead: true,
        reason: goMode.reRoute?.reason ?? 'auto-reroute'
      })
    ) {
      dispatch(setRerouteResult(null))
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
 * drifted off it (chosen their own way, car-GPS style). With a transit
 * boarding still ahead the replan is SCOPED to the access chain: plan current
 * GPS → the boarding stop in the access mode only, then splice the result
 * onto the byte-identical transit suffix (spliceAccessOntoItinerary) — the
 * 7/29 ride's ask: "only reroute the bike leg, don't switch my bus routes".
 * Only when the scoped plan comes back empty (or nothing qualifies) does it
 * fall back to the full-trip replan, whose picker still pins the next transit
 * route. Both fetches are ISOLATED background requests (no currentQuery / URL
 * / active-search side effects, so the mobile shell never yanks the rider off
 * the Go Mode screen) and swap the itinerary in without asking. Selection
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
    const nowMs = getCurrentTime().getTime()

    // Verifiably aboard a known trip? Then the rider is on a bus, whatever the
    // leg index says, and there is no access leg to re-plan. This matters
    // because the two facts disagree: the route matcher advances
    // routeMatch.legIndex on geometry alone and has run as much as four
    // minutes ahead of the boarding it describes (2026-09-01 ride 2), so a
    // rider still sitting on the bus can be "on" the bike leg after it, off
    // its geometry by construction, and drifting further every second. The
    // full-trip fallback below would then answer with an all-BICYCLE plan —
    // pickAccessReplanCandidate accepts only non-transit itineraries once no
    // boarding remains ahead — and swap the rider off the bus they are sitting
    // on, silently. The rider's rule is that an automatic update keeps their
    // route; getting off the vehicle is the largest possible change to it.
    //
    // Keyed on riding.tripId rather than the bare riding fact: a trip id is
    // evidence of a specific vehicle, and a route-only fact is exactly the
    // shape a false board leaves behind (6.1), which must not be able to
    // silence a real access re-plan.
    if (goMode.riding?.tripId) return

    const currentLegIndex = goMode.routeMatch?.legIndex ?? 0
    const currentLeg = legs[currentLegIndex]
    // Index-preserving find (not a slice): the suffix from this index is what
    // the scoped splice below must keep byte-identical.
    const boardLegIndex = legs.findIndex(
      (l: Leg, i: number) => i >= currentLegIndex && l.transitLeg
    )
    const nextTransitLeg = boardLegIndex >= 0 ? legs[boardLegIndex] : undefined
    // Bike plans include their own walk segments, so one mode suffices; the
    // chain the scoped path re-plans is what the mode has to describe.
    const accessMode = legs
      .slice(currentLegIndex, boardLegIndex >= 0 ? boardLegIndex : legs.length)
      .some((l: Leg) => l.mode === 'BICYCLE')
      ? 'BICYCLE'
      : 'WALK'

    // Re-planning that is not getting the rider any closer does not get to keep
    // going. Three attempts with no net reduction in distance to the
    // destination and this mode is retired for the trip — on 2026-08-28 the
    // afternoon ride spent 32 minutes re-planning into a venue interior the
    // street graph does not reach, never getting inside 454 m, and told the
    // rider nothing. Detection and the stop live here; what the rider is told
    // is one notification through the existing machinery, no new surface.
    if (destinationStalled(session.destinationProgress, accessMode)) {
      const sent = goMode.notifications?.sentNotifications || []
      const stalledNote = checkDestinationUnreachable(
        sent,
        session.destinationProgress?.bestDistanceM,
        destLeg.to?.name
      )
      if (stalledNote) {
        dispatch(addNotification(stalledNote))
        if (!isReplayActive()) {
          showNotification(
            stalledNote,
            goMode.notifications || {
              enabled: true,
              soundEnabled: false,
              vibrationEnabled: true
            }
          )
          sendPush({
            message: stalledNote.message,
            priority: 1,
            title: stalledNote.title
          })
        }
      }
      return
    }

    if (
      !quietReplanAdmitted({
        lastReplanAtMs: session.lastQuietReplanAt,
        nowMs,
        recentReplanAtMs: session.quietReplanHistory,
        // How much access leg is actually left. A rider two blocks from the
        // boarding stop should not wait the same minute as one with 3 km to go
        // — 8/28's 670 m leg went 122 m wrong within 55 s and got no retry for
        // nearly three minutes.
        remainingAccessMeters: remainingAccessDistanceM(
          legs,
          currentLegIndex,
          goMode.routeMatch?.progressAlongLeg
        ),
        reRouteStatus: goMode.reRoute?.status || 'idle'
      })
    ) {
      return
    }
    session.lastQuietReplanAt = nowMs
    session.quietReplanHistory = [
      ...trimQuietReplanHistory(session.quietReplanHistory, nowMs),
      nowMs
    ]
    session.destinationProgress = noteReplanAttempt(
      session.destinationProgress,
      accessMode
    )

    const { homeTimezone } = state.otp.config
    const { modes, modeSettings, numItineraries } = getBasePlanParts(state)
    // 2026-08-28: every access re-plan re-derived the bike leg at OTP's default
    // speed while the rider was measurably doing 5.6-7.8 m/s, which is what
    // produced the backwards trip sheets — the spliced transit suffix was
    // sequenced for an arrival at the boarding stop the rider beat every time.
    const routingPreferences = withObservedBikeSpeed(
      state.otp.currentQuery?.routingPreferences,
      observedBikeSpeedMps()
    )
    const zoned = utcToZonedTime(nowMs, homeTimezone)
    const date = format(zoned, coreUtils.time.OTP_API_DATE_FORMAT)
    const time = format(zoned, coreUtils.time.OTP_API_TIME_FORMAT)
    const from = {
      category: 'CURRENT_LOCATION',
      lat: lastPosition.coords.latitude,
      lon: lastPosition.coords.longitude,
      name: 'Current location'
    }

    // Rider exited Go Mode / a reroute started while a request was in flight?
    const stillReplannable = () => {
      const after = getState().otp?.goMode
      const statusAfter = after?.reRoute?.status || 'idle'
      return !!(
        after?.isActive &&
        (statusAfter === 'idle' || statusAfter === 'none')
      )
    }

    // Primary path with a boarding still ahead: re-plan ONLY the access chain
    // (GPS → boarding stop, single mode) and keep every transit leg as-is.
    if (boardLegIndex >= 0 && nextTransitLeg) {
      const boardPlace = nextTransitLeg.from
      // "Arrive on time" (rider ask 6.10b, opt-in): aim the access query a few
      // minutes ahead of the boarding instead of as-fast-as-possible. The
      // boarding time is the feed's when the feed is genuinely predicting it —
      // a board epoch that is NOT realtime has been clamped forward to `now`
      // by clampNonLiveLegTimes and would set a deadline of about right now —
      // and the plan's own leg start otherwise. Null target = the ordinary
      // depart-now query, unchanged.
      const liveBoardForReplan = goMode.liveLegTimes?.[boardLegIndex]
      const arriveTarget = accessArriveByTarget({
        boardEpochMs:
          liveBoardForReplan?.boardRealtime &&
          liveBoardForReplan.boardEpoch != null
            ? liveBoardForReplan.boardEpoch
            : Number(nextTransitLeg.startTime),
        enabled: !!state.otp.currentQuery?.arriveOnTimeAccess,
        nowMs
      })
      const targetZoned =
        arriveTarget != null ? utcToZonedTime(arriveTarget, homeTimezone) : null
      const scopedAt = (target: number | null) => ({
        arriveBy: target != null,
        date:
          target != null && targetZoned
            ? format(targetZoned, coreUtils.time.OTP_API_DATE_FORMAT)
            : date,
        from,
        modes: [{ mode: accessMode }],
        modeSettings,
        numItineraries: ACCESS_REPLAN_NUM_ITINERARIES,
        routingPreferences,
        time:
          target != null && targetZoned
            ? format(targetZoned, coreUtils.time.OTP_API_TIME_FORMAT)
            : time,
        to: {
          lat: boardPlace.lat,
          lon: boardPlace.lon,
          name: boardPlace.name
        }
      })
      // nextTransitRouteId null: a mode-restricted query cannot return
      // transit, and the picker still refuses to downgrade a biking rider to
      // walk-only.
      const runScoped = async (target: number | null) => {
        const { error, itineraries } = await dispatch(
          fetchOnboardCandidatePlan(scopedAt(target))
        )
        if (!stillReplannable()) return undefined
        return error || !itineraries?.length
          ? null
          : pickAccessReplanCandidate(itineraries, {
              accessMode,
              nextTransitRouteId: null
            })
      }
      let best = await runScoped(arriveTarget)
      if (best === undefined) return
      // An arrive-by query that comes back with nothing must not cost the
      // rider the scoped re-plan itself: the alternative is the full-trip
      // fallback below, which is where all three of 2026-09-01's unwanted
      // swaps came from (6.12). Ask the ordinary depart-now question before
      // giving up on the access chain.
      if (!best && arriveTarget != null) {
        best = await runScoped(null)
        if (best === undefined) return
      }
      if (best) {
        const spliced = spliceAccessOntoItinerary(
          itinerary,
          best,
          boardLegIndex
        )
        if (
          autoReplanRejected(getState(), spliced, {
            reason: 'quiet-replan-scoped'
          })
        ) {
          session.quietReplanMissStreak += 1
          return
        }
        session.quietReplanMissStreak = 0
        dispatch(beginGoMode(spliced))
        return
      }
      // Scoped plan found nothing usable — fall through to the full-trip
      // replan below (fallback, not default).
    }

    const combo = {
      arriveBy: false,
      date,
      from,
      modes,
      modeSettings,
      numItineraries,
      routingPreferences,
      time,
      to: {
        lat: destLeg.to.lat,
        lon: destLeg.to.lon,
        name: destLeg.to.name
      }
    }

    const { error, itineraries } = await dispatch(
      fetchOnboardCandidatePlan(combo)
    )

    // Re-check state after the async plan: the rider may have exited Go Mode
    // or a reroute may have started while the request was in flight.
    if (!stillReplannable()) return

    const keepRouteId = nextTransitLeg
      ? getLegRouteId(nextTransitLeg as Leg)
      : null
    const best =
      error || !itineraries?.length
        ? null
        : pickHopFreeSibling(
            pickAccessReplanCandidate(itineraries, {
              accessMode: currentLeg?.mode,
              nextTransitRouteId: keepRouteId
            }),
            itineraries,
            {
              maxHopMeters: tokenHopMeters(getState()),
              requireRouteId: keepRouteId,
              toleranceMs: tokenHopToleranceMs(getState())
            }
          )
    if (!best) {
      // Empty fetches or nothing qualifying under the
      // never-force-a-route-change rule. Settle silently: the ROUTE_DEVIATION
      // notification already fired and the TripSheet is the rider's escape
      // hatch — the old miss-streak escalation dispatched a non-autoApply
      // reroute whose Switch/Keep card no UI has rendered since eb74a9d8, so
      // it only burned a fetch and blocked later auto-updates. The streak
      // stays as bookkeeping.
      session.quietReplanMissStreak += 1
      return
    }

    if (autoReplanRejected(getState(), best, { reason: 'quiet-replan' })) {
      // Same settle as an empty fetch: the rider keeps the plan they have, the
      // TripSheet is still their escape hatch, and the streak records that this
      // attempt changed nothing.
      session.quietReplanMissStreak += 1
      return
    }

    session.quietReplanMissStreak = 0
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
    // A rider who has arrived has no rest-of-trip to find alternatives for.
    // Guarded here as well as stopped on the arrival tick because the 90 s
    // interval is SESSION state that outlives any single dispatch path: on
    // 2026-08-28 it went on firing for the 88 minutes between the arrival card
    // and the rider ending the trip by hand — 58 real plan() calls from a
    // parked phone, the last at 23:35:52.
    if (goMode?.arrivedAt != null) {
      stopRerouteSnapshotCapture()
      return
    }

    // Settled aboard: stretch the cadence (see
    // REROUTE_SNAPSHOT_RIDING_INTERVAL_MS). "Settled" is all three facts
    // together — the sticky riding fact names a trip, the vehicle match is
    // confirmed, and the route match still has the rider on the shape — so a
    // rider whose bus has diverted, or who never really boarded, keeps the
    // full-rate record that a diagnosis of exactly that would need.
    const settledAboard =
      goMode?.riding?.tripId != null &&
      goMode?.vehicleMatch?.match?.confidence === 'confirmed' &&
      goMode?.routeMatch?.isOnRoute === true
    const sinceLastMs =
      getCurrentTime().getTime() - session.lastRerouteSnapshotAt
    if (
      settledAboard &&
      session.lastRerouteSnapshotAt > 0 &&
      sinceLastMs < REROUTE_SNAPSHOT_RIDING_INTERVAL_MS
    ) {
      return
    }
    session.lastRerouteSnapshotAt = getCurrentTime().getTime()

    const { homeTimezone } = state.otp.config
    const { modes, modeSettings, numItineraries } = getBasePlanParts(state)
    // Same levers a real re-plan would carry, observed bike speed included —
    // a snapshot that queries differently from the path it exists to reproduce
    // is not a recording of anything.
    const routingPreferences = withObservedBikeSpeed(
      state.otp.currentQuery?.routingPreferences,
      observedBikeSpeedMps()
    )
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
  if (session.rerouteSnapshotIntervalId) return
  let intervalMs = REROUTE_SNAPSHOT_INTERVAL_MS
  try {
    const override = Number(
      window.localStorage?.getItem('otpRerouteSnapshotMs')
    )
    if (override > 0) intervalMs = override
  } catch {
    // ignore
  }
  session.rerouteSnapshotIntervalId = setInterval(() => {
    dispatch(captureRerouteSnapshot())
  }, intervalMs)
}

function stopRerouteSnapshotCapture() {
  if (session.rerouteSnapshotIntervalId) {
    clearInterval(session.rerouteSnapshotIntervalId)
    session.rerouteSnapshotIntervalId = null
  }
}

/**
 * Silence the 15-second live-vehicle poll without touching the vehicle MATCH.
 *
 * stopVehicleTracking is the other half of a leg change and clears the match
 * with it — right there, wrong at arrival, where the match is the record of the
 * bus the rider actually rode and the arrival card may still be showing it.
 * This drops only the timer.
 *
 * It needs dropping because the timer is the one piece of the trip that lives
 * outside the tick and so is untouched by the arrival quiesce. It only survives
 * arrival when the trip is still ON a transit leg — advanceToLeg stops it on
 * the way to a walk or bike leg, which is why the 2026-09-01 rides, both ending
 * on an access leg, show no vehicle traffic after their arrival cards. The
 * 2026-08-31 18:52 mount is the case that does: it resumed a finished trip
 * whose leg 0 was the bus, armed the poll from startGoModeTracking, and logged
 * 392 REALTIME_VEHICLE_POSITIONS_RESPONSE over 104 minutes — one per 16 s, the
 * interval exactly — from a phone parked 41 m from its destination.
 */
function stopVehiclePolling() {
  if (session.vehiclePositionIntervalId) {
    clearInterval(session.vehiclePositionIntervalId)
    session.vehiclePositionIntervalId = null
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
    const before = getState()
    const originalFrom = before.otp.currentQuery?.from || null
    // Read the rider's plan BEFORE dispatching: BEGIN_ONBOARD_FLOW nulls
    // goMode.activeItinerary, and the route they chose for the leg after this
    // bus is the one the alight optimizer must not quietly replace. Pre-trip
    // there is no Go Mode itinerary yet, so fall back to the planner's active
    // one; boardedRouteId skips the leading leg for the bus they're aboard.
    const planned =
      before.otp.goMode?.activeItinerary ?? getActiveItinerary(before)
    const keepRouteId = onwardTransitRouteId(planned, {
      afterLegIndex: before.otp.goMode?.riding?.legIndex ?? -1,
      boardedRouteId: before.otp.goMode?.riding?.routeId ?? null
    })
    dispatch(beginOnboardFlowAction({ keepRouteId, originalFrom }))
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
    const now = getState()
    const match: any = now.otp.goMode?.vehicleMatch?.match
    // ...unless they have since GOT OFF that trip. 8/9 19:29:13: riding had
    // been cleared at the 19:27:43 alight, so this branch adopted a 4.5-minute
    // -old confirmed match for the trip the rider had just left — silently,
    // with its stale nextStopId — and built a bus leg back to a stop behind
    // them. An alight ends the assertion; from here the rider has to say, and
    // discoverNearbyVehicles below asks with the routes named.
    if (
      match?.confidence === 'confirmed' &&
      matchProvesAboard(match, now.otp.goMode?.alightedFrom ?? null)
    ) {
      // The anchor for the whole optimize comes off this field, so take it
      // only from a bus the feed can still see — the same guard replanFromAboard
      // applies at its own nextStopId. Null degrades to the GPS-nearest stop.
      const feedRecord = findVehicleById(
        now.otp?.transitIndex?.routes?.[match.routeId ?? '']?.vehicles,
        match.vehicleId,
        Date.now()
      )
      dispatch(
        setOnboardVehicle({
          label: match.label ?? match.vehicleId,
          nextStopId: isVehicleRecordFresh(feedRecord)
            ? match.nextStopId ?? null
            : null,
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
    let routes: Array<{
      color?: string | null
      id: string
      longName?: string | null
      shortName?: string | null
      textColor?: string | null
    }> = []
    const context = await fetchOnboardContext(
      lat,
      lon,
      speedAdjustedRadius(750, pos.coords.speed)
    )
    const candidates = context?.routes
    // vehicleId -> {direction, headsign}; empty when the sidecar is unreachable
    // and the stop-radius fallback runs, in which case the picker simply shows
    // no direction rather than guessing one.
    const vehicleDetails: Record<string, any> = context?.vehicleDetails || {}
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
    // Carry each route's rider-facing identity onto its vehicles while we still
    // know which route they came from — the feed records themselves have no
    // route name or color, and matching them back up afterwards would have to
    // guess at feed-prefixed vs bare ids.
    const allVehicles = routes.flatMap((r) =>
      (routesIndex[r.id]?.vehicles || []).map((v: Record<string, unknown>) => ({
        ...v,
        routeColor: r.color ?? null,
        routeName: r.shortName || r.longName || null,
        routeTextColor: r.textColor ?? null
      }))
    )
    const nearby = findNearbyVehicles(
      lat,
      lon,
      allVehicles,
      speedAdjustedRadius(750, pos.coords.speed)
    ).map((v) => ({ ...v, ...(vehicleDetails[v.vehicleId] || {}) }))

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
    to: { lat: number; lon: number; name?: string }
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
    const { error, itineraries, query, response, variables } = await dispatch(
      fetchOnboardCandidatePlan(combo)
    )
    // Recording only. These five plans are what the optimizer actually ranks,
    // and until now nothing kept them: fetchOnboardCandidatePlan resolves
    // through a local promise rather than dispatching ROUTING_RESPONSE, so
    // build-fixture.js never saw one. That is why the 8/9 fixture carries the
    // onboard trip and the ranked result but cannot replay the step between
    // them — its proof had to be written as a unit test instead
    // (__tests__/util/go-mode/alight-backwards-0809.ts). Keyed by the stop the
    // plan departs from, which is what a replay has to match on: five
    // simultaneous plans differ only by origin.
    if (isTripRecordingEnabled()) {
      dispatch({
        payload: {
          request: {
            busArrivalEpoch,
            from: combo.from,
            query,
            stopId: stop.id,
            to: combo.to,
            variables
          },
          response,
          tMs: getCurrentTime().getTime()
        },
        type: ONBOARD_CANDIDATE_SNAPSHOT
      })
    }
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

    if (!trip || !to || to.lat == null || to.lon == null) {
      dispatch(setOnboardResult(null))
      return
    }

    await dispatch(
      optimizeAlightFromTrip({
        to: { lat: to.lat, lon: to.lon, name: to.name },
        trip,
        updateOnboardState: true,
        vehicle
      })
    )
  }
}

/**
 * The shared "where do I get off THIS bus" optimizer: downstream stops →
 * bounded candidate set → parallel isolated onward plans (hard bias toward the
 * boarded route + stay-seated prefs) → ranked, display-decorated options.
 * Extracted from planFromOnboardBus so the pre-trip onboard flow and the
 * mid-ride aboard replan (replanFromAboard) can never drift apart.
 *
 * Dispatches the onboard-UI bookkeeping (START_ONBOARD_OPTIMIZE /
 * SET_ONBOARD_RESULT) only when `updateOnboardState` is set: the autoApply
 * mid-ride path must not touch onboard.status — a non-idle status now renders
 * the onboard UI over the live trip screen (GoModeScreen), which an automatic
 * update must never do. Resolves to the ranked options, or null when none.
 */
function optimizeAlightFromTrip(options: {
  /**
   * The route the rider already chose for the leg AFTER this bus. Never
   * filters; it wins ties and holds a slot so the cap cannot cut it. Defaults
   * to the id captured when the onboard flow opened.
   */
  keepRouteId?: string | null
  /** How many options to rank. Defaults to the five the results list shows. */
  limit?: number
  /** Rider-supplied routing prefs; falls back to currentQuery / stay-seated. */
  prefsOverride?: any
  to: { lat: number; lon: number; name?: string }
  trip: any
  updateOnboardState?: boolean
  vehicle: any
}) {
  return async function (dispatch: any, getState: any): Promise<any[] | null> {
    const { limit, prefsOverride, to, trip, updateOnboardState, vehicle } =
      options
    const state = getState()
    const goMode = state.otp?.goMode
    const lastPosition = goMode?.tracking?.lastPosition

    const { homeTimezone } = state.otp.config
    const userPos = lastPosition
      ? {
          lat: lastPosition.coords.latitude,
          lon: lastPosition.coords.longitude
        }
      : null
    // Wall clock on purpose, NOT getCurrentTime(). During a GPS simulation the
    // sim clock starts at the itinerary's start and advances by SCHEDULE deltas
    // while playback scales wall time by up to 25x, so it runs ahead of real
    // time — while the candidate plans verify-boarded-earlier and
    // verify-onboard-options fetch come from the live OTP server at real now.
    // Feeding sim time to the reachability check below would reject those
    // legitimate plans and break both gates. The guard has to be right for the
    // live app, which is the only place it runs against a real feed.
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
      if (updateOnboardState) dispatch(setOnboardResult(null))
      return null
    }

    // Kept by identity: START_ONBOARD_OPTIMIZE stores this exact array, so
    // `onboard.candidates === candidatePayload` later is a precise "this is
    // still MY optimize run" token — a second run (Change bus, rediscover)
    // replaces it and the late re-rank below stands down.
    const candidatePayload = candidates.map((c) => ({
      busArrivalEpoch: c.busArrivalEpoch,
      realtime: c.realtime,
      stopId: c.stop.id,
      stopName: c.stop.name
    }))
    if (updateOnboardState) {
      dispatch(startOnboardOptimize({ candidates: candidatePayload }))
    }

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
      // The onward plans from each candidate alight stop are mostly bike
      // egress, so they get the observed pace too. It is null unless the rider
      // was cycling within rider-speed.ts's window, so a long bus ride simply
      // falls back to the profile / engine default.
      routingPreferences: withObservedBikeSpeed(
        prefsOverride ??
          state.otp.currentQuery?.routingPreferences ??
          getRoutingProfile('stay-seated')?.prefs,
        observedBikeSpeedMps()
      ),
      to: { lat: to.lat, lon: to.lon, name: to.name }
    }

    // Bounded, NOT Promise.all. Each candidate plan already carries its own
    // request deadline (actions/api), and this is the backstop over the set:
    // whatever has answered when the clock runs out is what gets ranked. On
    // 2026-08-31 three of five candidate plans never settled, `Promise.all`
    // never resolved, SET_ONBOARD_RESULT was never dispatched, and the onboard
    // panel sat on 'optimizing' for 9m11s until the rider gave up. Two of five
    // would have been a real answer; the rider got none.
    const settleMs =
      state.otp.config?.itinerary?.onboardSettleMs ??
      ONBOARD_CANDIDATE_SETTLE_MS
    // Candidates whose request was still in flight at the deadline. A REJECTED
    // candidate is not in here: that one is over, so telling the rider we are
    // still checking it would be a lie.
    const stillInFlight = new Set<number>()
    // Declared ahead of foldInLateResult, which reads it. A straggler's
    // callback can only run after settleCandidatePlans has returned (it sets
    // its hand-off flag synchronously before returning), so by then this holds
    // the array the rider was actually shown.
    let results: AlightCandidateResult[] = []
    const keepRouteId =
      options.keepRouteId !== undefined
        ? options.keepRouteId
        : goMode?.onboard?.keepRouteId ?? null

    const substitute = (index: number) => ({
      busArrivalEpoch: candidates[index].busArrivalEpoch,
      // rankAlightOptions skips an errored result, which is exactly right:
      // a candidate stop whose onward plan never came back is not a stop the
      // rider can be told to get off at.
      error: true,
      itineraries: [],
      realtime: candidates[index].realtime,
      stopId: candidates[index].stop.id,
      stopName: candidates[index].stop.name
    })

    const rankAndDecorate = (
      settledResults: AlightCandidateResult[],
      at: number
    ) => {
      const ranked = rankAlightOptions(settledResults, {
        keepRouteId,
        limit,
        nowMs: at,
        tokenHopMaxMeters: tokenHopMeters(state),
        tokenHopToleranceMs: tokenHopToleranceMs(state),
        walkOnlyMax
      })
      return decorateAlightOptions(ranked, trip, vehicle, lastPosition)
    }

    /**
     * A candidate plan that landed after the deadline. Folding it in is only
     * safe while the answer it would replace is still the one on screen: a
     * re-dispatched SET_ONBOARD_RESULT sets onboard.status back to 'ready',
     * and a non-idle onboard status renders the onboard UI OVER the live trip
     * screen — so doing this after the rider has tapped an option would throw
     * them back into the chooser mid-ride. Hence the four guards below;
     * anything else and the straggler is discarded, which is what the code
     * did unconditionally before.
     */
    const foldInLateResult = (index: number, value: AlightCandidateResult) => {
      results[index] = value
      stillInFlight.delete(index)
      const now = getState()
      const onboard = now.otp?.goMode?.onboard
      if (
        // (1) still showing an answer, not idle/optimizing/error, and (2) not
        // a fresh run: candidates is the very array this run dispatched.
        onboard?.status !== 'ready' ||
        onboard?.candidates !== candidatePayload ||
        // (3) same bus, same trip — a re-confirm can swap either.
        onboard?.trip?.id !== trip?.id ||
        (onboard?.vehicle?.vehicleId ?? null) !==
          (vehicle?.vehicleId ?? null) ||
        // (4) the rider is no longer looking at this list (they tapped an
        // option, which clears onboard, or Go Mode moved on).
        !now.otp?.goMode?.isActive
      ) {
        return
      }
      const improved = rankAndDecorate(results, Date.now())
      if (!improved.length) return
      dispatch(
        setOnboardResult({
          answeredCandidates: results.filter((r) => !r?.error).length,
          options: improved,
          pendingCandidates: stillInFlight.size
        })
      )
    }

    results = await settleCandidatePlans<AlightCandidateResult>(
      candidates.map((c) =>
        Promise.resolve(dispatch(fetchCandidatePlan(c, ctx)))
      ),
      settleMs,
      (index, reason) => {
        if (reason === 'timeout') stillInFlight.add(index)
        return substitute(index)
      },
      updateOnboardState ? foldInLateResult : undefined
    )

    const decorated = rankAndDecorate(results, nowMs)
    if (updateOnboardState) {
      dispatch(
        decorated.length
          ? setOnboardResult({
              answeredCandidates: results.filter((r) => !r?.error).length,
              options: decorated,
              pendingCandidates: stillInFlight.size
            })
          : setOnboardResult(null)
      )
    }
    return decorated.length ? decorated : null
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
  best: {
    busArrivalEpoch: number
    itinerary: Itinerary
    stopId: string
    /** Alight stop NAME, for the twin-feed id fallback — see
     * findStopTimeIndex. Optional: callers that never had one are unchanged. */
    stopName?: string | null
  },
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

  // Same id-then-name resolution liveStopArrival used to produce
  // best.busArrivalEpoch. When the two disagreed — a twin-feed stop id that
  // only the name lookup resolves — this fell through to `boardIdx + 1` and
  // collapsed the whole ride to a single stop pair carrying a perfectly valid
  // arrival time, which is most of what made 8/2's leg split look plausible.
  let alightIdx = findStopTimeIndex(stopTimes, best.stopId, best.stopName)
  if (alightIdx < 0) {
    alightIdx = Math.min(boardIdx + 1, stopTimes.length - 1)
  }
  // Alighting at the bus's very next stop: the ride segment is the approach to
  // that stop, not a leg starting there — anchor the board stop one back so
  // the rider's chosen stop is honored instead of silently pushed one further.
  //
  // NOTE (2026-08-31): this roll-back is what produced the phantom leg 0 of
  // that ride — the rider stood AT I-35W & 98th St, their own alight stop, and
  // the splice handed back a 4.6 km leg from Knox Ave & American Blvd, ridden
  // four minutes earlier, "departing" now. It is left alone deliberately. The
  // roll-back is the right model for the premise it is given ("you are aboard
  // trip T and will alight at S"); the premise was the lie, and it is fixed
  // upstream. Nothing in the inputs separates that ride from the legitimate
  // mid-ride case: onboard-flow's pinned splice cases sit at the same
  // alightIdx === boardIdx with a 4.4 km roll-back of their own, with the same
  // provenance (no live vehicle, nearest-stop board) and the same absent
  // realtime departures. A guard here cannot tell them apart.
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
  let geomSlice: [number, number][] = []
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
      geomSlice = decoded.slice(startGeo, endGeo + 1) as [number, number][]
      geomPoints = polyline.encode(geomSlice)
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

  // An arrival that has already passed is not evidence the rider has arrived.
  // busLegStart is Date.now() while best.busArrivalEpoch can be a realtime
  // prediction already behind the clock — on 8/2 that produced legs whose
  // endTime preceded their startTime by 114s, 175s and 268s, and a "Trip
  // updated — arriving 9:23 PM" push sent at 9:24. Only then substitute the
  // remaining SCHEDULED running time, the least we can honestly claim the
  // rest of the ride will take.
  //
  // Strictly an inversion guard, NOT a floor: a realtime arrival that is
  // merely EARLIER than schedule is a bus running ahead, which is exactly the
  // kind of truth realtime exists to tell. Flooring against the schedule
  // there would quietly make the app 30s pessimistic on every early bus
  // (caught by verify-rest-of-trip-times).
  const arrivalEpoch = Number(best.busArrivalEpoch)
  const busLegEnd =
    Number.isFinite(arrivalEpoch) && arrivalEpoch > busLegStart
      ? arrivalEpoch
      : busLegStart +
        Math.max(0, (stopTimes[alightIdx].scheduledDeparture - anchorSd) * 1000)

  const routeId = vehicle?.routeId || trip.route?.id || null
  const mode = trip.route?.mode || gtfsTypeToMode(trip.route?.type)

  const rawBusLeg: any = {
    // GraphQL shape, so convertGraphQLResponseToLegacy below can flatten it
    // the same way it flattens every planner leg — findTrip already fetches
    // all of these (its `id` IS the gtfsId, via an alias).
    agency: trip.route?.agency,

    // Measured along the sliced polyline, not 0. A zero distance propagates:
    // spliceAccessOntoItinerary's walkDistance recompute and the leg merge
    // both read it, so the lie outlives this function.
    distance: polylineLength(geomSlice),

    duration: (busLegEnd - busLegStart) / 1000,

    endTime: busLegEnd,

    // Every real OTP leg carries this (empty when the agency has no Fares V2
    // data). Omitting it crashes the fare table, which does
    // `transitLegs.flatMap(leg => leg.fareProducts)` and then reads
    // `.product` off each entry — a missing array lands `undefined` in that
    // list and takes the whole trip-details panel down.
    fareProducts: [],

    from: {
      lat: boardStop.lat,
      lon: boardStop.lon,
      name: boardStop.name,
      stop: { code: boardStop.code, gtfsId: boardStop.id, id: boardStop.id },
      stopId: boardStop.id
    },

    headsign: trip.tripHeadsign,

    intermediatePlaces,

    // OTP's convention for legGeometry.length is the POINT COUNT, not the
    // length of the encoded string. Nothing reads it today; free correctness.
    legGeometry: { length: geomSlice.length, points: geomPoints },

    mode,
    route: {
      color: trip.route?.color,
      gtfsId: routeId,
      id: routeId,
      longName: trip.route?.longName,
      shortName: trip.route?.shortName,
      textColor: trip.route?.textColor,
      type: trip.route?.type
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
    trip: { gtfsId: trip.id, tripHeadsign: trip.tripHeadsign },
    tripId: trip.id
  }

  // Flatten exactly like every planner leg. GoModeMap reads leg.routeColor and
  // itinerary-summary reads it too — neither looks inside leg.route — so the
  // hand-built leg drew the Orange Line in default blue on 8/2. Don't hand-copy
  // the fields; the repo already has the normalizer, applied to every real leg
  // in convertPlanResponseItineraries.
  const busLeg: any = {
    ...coreUtils.itinerary.convertGraphQLResponseToLegacy(rawBusLeg),

    // A synthesized leg is always first — there is no previous leg to interline
    // with.
    interlineWithPreviousLeg: false,

    // Honest: only true when busArrivalEpoch came from realtime data.
    realTime: !!(best as any).realtime,

    // The converter collapses route to a shortName STRING. apiV2 restores the
    // object for transit legs; skipping that here would make this leg diverge
    // from planner-sourced legs in a way unit tests miss and only the map
    // shows. Orange Line has no shortName at all, so the string would be null.
    route: rawBusLeg.route
  }
  // Deliberately NOT decorated with getRouteColorBasedOnSettings: this
  // deployment comments transitOperators out of app-config.yml, so it resolves
  // to the raw GTFS F68B1F anyway. Plumbing config into a pure builder to
  // reach the same value is cost without benefit.

  // Merge rather than prepend. OTP's onward plan from the alight stop can
  // legitimately begin with THIS SAME TRIP continuing — the route bias at the
  // fetch (otherThanPreferredRoutesPenalty: 900) is why, and that bias is
  // correct behavior, not a bug. Prepending was the bug: on 8/2 it rendered
  // one continuous Orange Line ride as two legs with a fake 5-minute transfer
  // at 66th St and the fare charged twice.
  const legs = mergeAdjacentSameTripLegs([busLeg, ...(onward.legs || [])])
  const transitLegCount = legs.filter((l: any) => l.transitLeg).length

  // Same clamp at the container: the onward plan was fetched against the
  // pre-clamp arrival, so its endTime can also sit behind the bus leg's.
  const itineraryEnd = Math.max(Number(onward.endTime), busLegEnd)

  // Repair here too, not only at beginGoMode. This return feeds the option
  // cards' displayItinerary, so without it the 8/9 card read "7:31 PM" above
  // "7:20 PM" BEFORE the rider tapped anything. The repaired card's duration
  // then disagrees with the score it was ranked on — which only happens for
  // options isReachableItinerary already drops.
  return repairLegTimeInversions({
    ...onward,
    duration: (itineraryEnd - busLegStart) / 1000,
    endTime: itineraryEnd,
    legs,
    startTime: busLegStart,
    transfers: Math.max(0, transitLegCount - 1)
  } as Itinerary) as Itinerary
}

/**
 * Decorate each ranked alight option with the itinerary the rider actually gets
 * on tap — current-bus leg included, transfers recounted, real bike legs — so
 * the results list displays exactly what confirmOnboardAlightStop will start.
 * The 7/12 cards showed the ONWARD plan's numbers instead: "0 more transfers"
 * became a 1-transfer trip after tapping.
 *
 * It also records where that built itinerary REALLY alights. An option's
 * stopId/stopName are the planning anchor — the stop its onward plan was
 * fetched from — and OTP's onward plan legitimately opens with the boarded trip
 * CONTINUING, which mergeAdjacentSameTripLegs then folds into the synthesized
 * bus leg as one ride running on to that leg's own alight stop. Live on
 * 2026-09-02 (6.44): the row captioned "Off at I-35W & Lake St Station" started
 * guidance that stayed aboard to Burnsville Heart of the City, the end of the
 * line — legs BUS,BICYCLE, alighting at 1:56830. The merge is right (splitting
 * one ride in two invented a fake transfer and charged the fare twice on 8/2);
 * the caption was the liar, so `builtAlightStop` gives the list the truth to
 * print.
 *
 * Once the anchors are collapsed like that, several candidate stops describe
 * ONE ride — on the reproduction three of five options all rode to the
 * terminus — so options whose built journey duplicates one already kept are
 * dropped rather than offered as three choices that do the same thing. Ranked
 * order is preserved, so the survivor of each set is the best-ranked one.
 */
export function decorateAlightOptions(
  ranked: any[] | null | undefined,
  trip: any,
  vehicle: any,
  lastPosition: GeolocationPosition | null
): any[] {
  const seen = new Set<string>()
  const decorated: any[] = []
  ;(ranked || []).forEach((option: any) => {
    let displayItinerary: Itinerary
    try {
      displayItinerary = buildOnboardItinerary(
        trip,
        vehicle,
        option,
        lastPosition
      )
    } catch {
      // Undecorated rather than dropped: an option the builder cannot splice
      // still ranks, and the list falls back to its onward itinerary.
      decorated.push(option)
      return
    }
    const actual = builtAlightStop(displayItinerary, trip?.id)
    const signature = journeySignature(
      actual?.stopId ?? option.stopId,
      displayItinerary
    )
    if (seen.has(signature)) return
    seen.add(signature)
    decorated.push({
      ...option,
      ...(actual && actual.stopId !== option.stopId
        ? { alightStopId: actual.stopId, alightStopName: actual.stopName }
        : {}),
      displayItinerary
    })
  })
  return decorated
}

/**
 * Re-lock the vehicle match onto the bus the rider is already aboard after a
 * beginGoMode itinerary swap, so tracking never re-runs matching or re-prompts
 * for a vehicle the app has verified. Deferred a tick so it lands after the
 * swap settles. Shared by confirmOnboardAlightStop and replanFromAboard.
 */
function reconfirmBoardedVehicle(dispatch: any, vehicle: any) {
  if (!vehicle?.vehicleId) return
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
    reconfirmBoardedVehicle(dispatch, vehicle)

    // Same latent gap verify-boarded-earlier caught on the aboard splice:
    // live leg times otherwise wait for a position tick, so the synthesized
    // bus leg would show schedule-anchored times until GPS delivers. Anchor
    // them to the boarded trip immediately.
    if (!isReplayActive()) {
      dispatch(refreshLiveLegTimes())
    }
  }
}

/**
 * Mid-ride, ABOARD-AWARE re-plan — the recovery for "the app took me off the
 * Orange Line" (7/29). While the sticky riding fact holds a verified tripId,
 * any re-plan must start from the physical truth: the rider is ON that bus.
 * So instead of a point-to-point plan from a moving GPS fix (which can legally
 * board the same route at a different station, or another route entirely),
 * this fetches the boarded trip's schedule and runs the onboard alight
 * optimizer — the spliced result's FIRST leg IS the boarded bus, by
 * construction (buildOnboardItinerary), so an aboard re-plan can never take
 * the rider off their line.
 *
 * Two exits:
 * - autoApply (boarded-earlier auto-recovery): swap the itinerary in quietly
 *   via beginGoMode, re-confirm the vehicle, post "Trip updated".
 * - explicit (rider tapped a reroute entry in the TripSheet): populate the
 *   existing onboard alight-stop UI (AlightRecommendation) and let
 *   confirmOnboardAlightStop commit the choice — the trip keeps running
 *   underneath. NEVER via BEGIN_ONBOARD_FLOW: its reducer clears
 *   activeItinerary, which would kill the live trip mid-ride.
 *
 * Bookkeeping reuses startReroute/setRerouteResult (no new action types), so
 * the position tick's stuck-reroute recovery and idle/none gating apply
 * unchanged. Schedule-fetch failure settles reRoute to 'none' (retryable) —
 * never onboard.status 'error' mid-trip.
 */
export function replanFromAboard(
  options: {
    autoApply?: boolean
    preferences?: any
    profileId?: string
    reason?: string
  } = {}
) {
  return async function (dispatch: any, getState: any) {
    const state = getState()
    const goMode = state.otp?.goMode
    const riding: RidingState | null = goMode?.riding ?? null
    const itinerary: Itinerary | null = goMode?.activeItinerary
    const legs = itinerary?.legs || []
    const destLeg = legs[legs.length - 1]
    // Gate on the verified fact: no tripId, no aboard replan — callers fall
    // back to their existing behavior (point-plan / planner search).
    if (!goMode?.isActive || !riding?.tripId || !itinerary || !destLeg) return

    // Destination from the ACTIVE ITINERARY, not currentQuery.to — a mid-trip
    // browse (browseFromCurrentPosition) rewrites the query, and an automatic
    // recovery must never adopt a destination the rider was only exploring.
    const to = {
      lat: destLeg.to.lat,
      lon: destLeg.to.lon,
      name: destLeg.to.name
    }

    // WHICH LEG IS THE BOARDED TRIP ACTUALLY ON? riding.legIndex comes from the
    // route matcher and can point at a leg the rider has not boarded, while
    // riding.tripId — the trip this whole path fetches and splices from — names
    // another. On 2026-08-31 a confirmed Orange Line match re-established the
    // riding fact on the 539's leg (index 2) while the trip stayed the Orange
    // Line's (leg 0). Resolve the anchor from the trip, because the trip is what
    // the splice replaces; fall back to riding.legIndex when the plan no longer
    // contains it.
    const boardedLegIndex = legs.findIndex(
      (l: any) =>
        l?.transitLeg &&
        (l.trip?.gtfsId === riding.tripId || l.tripId === riding.tripId)
    )
    const aboardLegIndex =
      boardedLegIndex >= 0 ? boardedLegIndex : riding.legIndex ?? -1

    // The route to preserve is the one the rider has NOT boarded yet — the leg
    // after this bus. riding.routeId used to be written here, which is the bus
    // they are already on: a constraint that is always satisfied and therefore
    // says nothing. Null when the plan has no onward transit leg.
    //
    // Anchored on riding.legIndex this read the 539 — the leg the rider had not
    // boarded and was standing at the stop for — as already ridden, so it came
    // out NULL, the automatic update was free to change lines, and it traded a
    // 17:53 arrival for an 18:28 one. An auto-update keeps the rider's route.
    // boardedRouteId is only for the pre-trip onboard flow, where there is no
    // index to start after; with one resolved the boarded leg is already behind
    // us, and passing it would skip the very route we are trying to keep.
    const keepRouteId = onwardTransitRouteId(itinerary, {
      afterLegIndex: aboardLegIndex,
      boardedRouteId: aboardLegIndex >= 0 ? null : riding.routeId ?? null
    })

    // Single-flight bookkeeping: same token/stuck-detection contract as
    // reRouteFromCurrentPosition.
    const searchId = randId()
    dispatch(
      startReroute({
        autoApply: !!options.autoApply,
        keepRouteId,
        reason: options.reason,
        searchId,
        startedAtMs: Date.now()
      })
    )
    const stillCurrent = () => {
      const after = getState().otp?.goMode
      return !!(
        after?.isActive &&
        after.reRoute?.searchId === searchId &&
        after.reRoute?.status === 'searching'
      )
    }

    const tripId = riding.tripId
    try {
      await dispatch(findTrip({ tripId }))
    } catch {
      // Settled below via the missing-trip check.
    }
    if (!stillCurrent()) return
    const trip = getState().otp?.transitIndex?.trips?.[tripId]
    if (!trip || !(trip.stopTimes?.length > 0)) {
      dispatch(setRerouteResult(null))
      return
    }

    // Vehicle context for the splice, from the riding fact + the live match
    // (refreshConfirmedMatch keeps match.nextStopId fresh mid-ride). Only
    // trust nextStopId when the matched vehicle is the boarded bus AND its
    // feed record is fresh; otherwise buildOnboardItinerary falls back to
    // nearest-stop boarding — acceptable.
    const nowState = getState()
    const match: any = nowState.otp?.goMode?.vehicleMatch?.match
    const matchIsBoarded =
      match != null &&
      (match.tripId === tripId ||
        (riding.vehicleId != null && match.vehicleId === riding.vehicleId))
    const feedRecord = findRidingVehicle(
      nowState.otp?.transitIndex?.routes?.[riding.routeId ?? '']?.vehicles,
      riding,
      Date.now()
    )
    const vehicle = {
      label: riding.routeShortName || riding.headsign || riding.routeId || null,
      nextStopId:
        matchIsBoarded && isVehicleRecordFresh(feedRecord)
          ? match.nextStopId ?? null
          : null,
      routeId: riding.routeId ?? null,
      tripId,
      vehicleId:
        riding.vehicleId ||
        (matchIsBoarded ? match.vehicleId : null) ||
        `route:${riding.routeId}`
    }

    // Same preference ladder as the other rider-facing re-plans; undefined
    // falls through to currentQuery prefs / stay-seated in the optimizer.
    const profile = options.profileId
      ? getRoutingProfile(options.profileId)
      : undefined
    const prefsOverride = profile?.prefs ?? options.preferences

    if (options.autoApply) {
      // An AUTO-APPLIED splice keeps the rider's plan: alight where the
      // active itinerary already alights whenever the boarded trip serves
      // that stop (same route, earlier bus — it almost always does), and
      // keep the plan's own onward legs. No optimizer, no candidate plans —
      // deterministic, and an automatic update cannot invent a route change
      // the rider didn't ask for (their standing rule). The optimizer run
      // below is the FALLBACK for a boarded trip that genuinely doesn't
      // reach the planned stop; even then a ranked candidate matching the
      // planned stop is preferred, because the ranking can legally favor a
      // hop-off-and-transfer — verify-boarded-earlier caught both holes: the
      // planned stop missing from the sampled candidates entirely, and
      // schedule-anchored epochs (no realtime yet) skewing the ranking into
      // a 3-minute-hop splice whose transfer leg then re-armed the
      // boarded-earlier gate and wiped the live-times anchor. The explicit
      // rider-facing path keeps the full ranked choice.
      const ridingLegForAlight: any =
        aboardLegIndex >= 0 ? legs[aboardLegIndex] : null
      const plannedAlightStopId =
        ridingLegForAlight?.to?.stop?.gtfsId ??
        ridingLegForAlight?.to?.stopId ??
        null
      const plannedArrival =
        plannedAlightStopId != null
          ? liveStopArrival(
              trip.stopTimes || [],
              plannedAlightStopId,
              ridingLegForAlight?.to?.name
            )
          : null
      let best: any = null
      if (plannedArrival) {
        best = {
          busArrivalEpoch: plannedArrival.epoch,
          itinerary: {
            ...itinerary,
            legs: legs.slice(aboardLegIndex + 1)
          },
          stopId: plannedAlightStopId,
          // liveStopArrival resolved the epoch above by id-OR-name; the
          // builder must resolve the same stop the same way or it silently
          // falls back to boardIdx + 1.
          stopName: ridingLegForAlight?.to?.name ?? null
        }
      } else {
        const ranked = await dispatch(
          optimizeAlightFromTrip({
            keepRouteId,
            // Not the five the results list shows. The chosen route can sit
            // below five faster alternatives and still be the only one this
            // path may apply — the same reason applyAutoReroute searches
            // collectRerouteCandidates(all, 50) instead of its display list.
            limit: 50,
            prefsOverride,
            to,
            trip,
            vehicle
          })
        )
        if (!stillCurrent()) return
        const atPlannedStop = (r: any) =>
          plannedAlightStopId != null && r.stopId === plannedAlightStopId
        if (keepRouteId) {
          // Automatic means same route, full stop. Preferring the planned
          // alight stop within that route keeps the rest of the plan intact;
          // a stop match alone would not, because the onward plan from the
          // planned stop can still be built around a different line.
          best =
            pickSameRouteAlight(
              (ranked || []).filter(atPlannedStop),
              keepRouteId
            ) || pickSameRouteAlight(ranked, keepRouteId)
        } else {
          best = (ranked || []).find(atPlannedStop) || ranked?.[0]
        }
      }
      if (!best) {
        // Nothing onward on the rider's own route (last run of the day, or the
        // boarded trip does not reach it): settle the attempt and leave the
        // trip alone rather than swapping them onto a line they didn't pick.
        // 'none' stays retryable under the caller's attempt caps.
        dispatch(setRerouteResult(null))
        return
      }

      const spliced = buildOnboardItinerary(
        trip,
        vehicle,
        best,
        getState().otp?.goMode?.tracking?.lastPosition || null
      )

      // The last line before the rider's trip is replaced: if the splice is
      // materially the same trip they are already on, do not swap and do not
      // notify. On 8/2 all nine auto-applied itineraries were byte-identical
      // — the trigger read match.tripId while the remedy built from the
      // frozen riding.tripId, so the replan could never satisfy itself. The
      // conjunct in shouldReplanBoardedEarlier fixes that specific loop; this
      // guard makes the whole CLASS non-recurring, whatever arms it next.
      // Suppressing here rather than at the notification layer is deliberate:
      // the TRIP_UPDATED id embeds Date.now(), so the reducer's id-based
      // dedupe can never catch these, and a notification-level dedupe would
      // be cleared by START_GO_MODE anyway.
      // Compare against the itinerary that is live NOW, not the one captured
      // before the schedule fetch — that is the one about to be replaced.
      const activeNow = getState().otp?.goMode?.activeItinerary ?? itinerary
      if (itinerarySignature(spliced) === itinerarySignature(activeNow)) {
        dispatch(setRerouteResult(null))
        return
      }

      // Boarding an EARLIER bus must not cost the rider time. On 2026-09-01's
      // first ride this path auto-applied a splice that moved the arrival
      // 08:42:51 -> 08:51:45 (+8:54) with no rider action; a re-plan that
      // arrives later than the plan in hand is not a recovery.
      if (
        autoReplanRejected(getState(), spliced, {
          // A missed connection makes the plan in hand unachievable, so there
          // is no arrival left to defend — only the boarded-earlier case is
          // asked to be no worse than what it replaces.
          currentPlanIsDead: options.reason === 'missed-bus',
          reason: options.reason ?? 'boarded-earlier'
        })
      ) {
        dispatch(setRerouteResult(null))
        return
      }

      dispatch(beginGoMode(spliced))
      // beginGoMode resets the vehicle match; re-lock the boarded bus.
      reconfirmBoardedVehicle(dispatch, vehicle)

      // The riding fact justified this replan, but by the time the async
      // splice lands the fact itself can be GONE: the schedule fetch and
      // alight optimization take seconds, and if the rider's fixes ran off
      // the OLD itinerary's short bus leg meanwhile, the off-route clock
      // (RIDING_OFFROUTE_CLEAR_MS — it counts SIM time, so a 16x run burns
      // it in seconds) clears the fact. START_GO_MODE's reanchorRiding then
      // has nothing to carry over, and with no further GPS ticks nothing
      // re-forms it (verify-boarded-earlier caught exactly this: riding
      // undefined after the splice). Re-assert the fact anchored to the
      // spliced bus leg — the rider verifiably being on `tripId` is the
      // premise of this whole path.
      const busLegIndex = (spliced.legs || []).findIndex(
        (l: any) =>
          l?.transitLeg && (l.trip?.gtfsId === tripId || l.tripId === tripId)
      )
      const ridingAfter: RidingState | null =
        getState().otp?.goMode?.riding ?? null
      dispatch(
        setRiding({
          boardedAt: ridingAfter?.boardedAt ?? riding.boardedAt,
          headsign:
            (spliced.legs?.[busLegIndex] as any)?.headsign ??
            riding.headsign ??
            null,
          legIndex: busLegIndex,
          offRouteSince: null,
          routeId: riding.routeId ?? null,
          routeShortName: riding.routeShortName ?? null,
          tripId,
          vehicleId: riding.vehicleId ?? vehicle.vehicleId ?? null
        })
      )

      // Anchor the trip-overview times to the RIDDEN trip now. Live leg
      // times are otherwise refreshed only from position ticks
      // (handlePositionUpdate), and post-splice there may be none for a
      // while (GPS gap; verify-boarded-earlier's sim ran out of points) —
      // START_GO_MODE just wiped liveLegTimes, so the overview would sit on
      // the planned trip's times indefinitely. Skipped under replay like
      // every live-times poll (replays reproduce recorded data).
      if (!isReplayActive()) {
        await dispatch(refreshLiveLegTimes())
      }

      // Same "Trip updated" style as applyAutoReroute — but aboard, the new
      // ALIGHTING is the fact the rider needs (the boarding is under them).
      const busLeg: any = spliced.legs?.[0]
      // The arrival is the TRIP's end, not this leg's. `legs[0].endTime` is
      // when the rider steps off the bus, and quoting it as the arrival is how
      // 2026-09-01 ride 1 announced 8:45 AM against an itinerary that ended at
      // 8:51:45 — see itineraryArrivalMs. Alight stop and arrival time are two
      // facts, so the copy no longer runs them into one clause.
      const arrivalMs = itineraryArrivalMs(spliced)
      const arrivalText =
        arrivalMs == null
          ? ''
          : ` Arriving ${format(
              utcToZonedTime(arrivalMs, getState().otp.config.homeTimezone),
              'h:mm a'
            )}.`
      const message = `Trip updated — ${
        busLeg?.routeShortName || busLeg?.routeLongName || 'your bus'
      }, off at ${busLeg?.to?.name || 'your stop'}.${arrivalText}`
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
      return
    }

    // Explicit path: hand the decision to the existing onboard UI (rendered
    // by GoModeScreen whenever onboard.status is non-idle — the live trip
    // keeps running underneath; back = clearOnboard). reRoute was bookkeeping
    // only — clear it so idle/none gating is unaffected while the rider looks
    // at the options; onboard.status drives this UI from here.
    dispatch(clearReroute())
    dispatch(setOnboardVehicle(vehicle))
    dispatch(setOnboardTrip(trip))
    await dispatch(
      optimizeAlightFromTrip({
        // Rider-facing: this only holds their route a slot in the list and
        // wins its ties. Anything faster still ranks above it and is still
        // one tap away — the strict rule belongs on the automatic path above.
        keepRouteId,
        prefsOverride,
        to,
        trip,
        updateOnboardState: true,
        vehicle
      })
    )
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
      const onNativePosition = (position: GeolocationPosition) => {
        if (!session.simulationActive) dispatch(handlePositionUpdate(position))
      }
      const onNativeError = (error: Error) => {
        if (!session.simulationActive) dispatch(setTrackingError(error as any))
      }
      // Arm — or RE-arm — the watcher at the filter this trip's current state
      // calls for. A live trip wants every fix; a trip that has already arrived
      // wants a coarse one, because the funnel added in Session 1.3 throttles
      // what we DO with fixes and does nothing at all about the chip that
      // produces them (2026-08-28: 5,318 post-arrival fixes over 88 parked
      // minutes, battery draw unchanged). This runs on every re-entry —
      // beginGoMode, a mid-trip swap, and the arrival branch below all come
      // back through here — and setNativeGpsDistanceFilter is a no-op when the
      // watcher already holds the requested filter, so a healthy stream is
      // never churned.
      const desiredFilter = nativeGpsDistanceFilterFor(
        getState().otp?.goMode?.arrivedAt != null
      )
      if (nativeGpsDistanceFilter() == null) {
        startNativeGps(onNativePosition, onNativeError, {
          distanceFilter: desiredFilter
        })
      } else {
        setNativeGpsDistanceFilter(
          desiredFilter,
          onNativePosition,
          onNativeError
        )
      }
      // Watchdog on the stream itself: a wedged watcher delivers no fix and no
      // error, so silence is the only symptom. Restart with the SAME handlers
      // after GPS_WATCHDOG_MS of quiet. Replaced (never stacked) on re-entry —
      // a mid-trip itinerary switch comes back through here.
      stopGpsWatchdog()
      lastFixAtMs = Date.now()
      nativeGpsRestartsSinceLastFix = 0
      session.gpsWatchdogIntervalId = setInterval(() => {
        if (session.simulationActive || !getState().otp?.goMode?.isActive)
          return
        const silenceMs = Date.now() - lastFixAtMs
        // Post-arrival the watcher is deliberately deaf: a parked phone under a
        // 50m filter delivers nothing, which reads to this check exactly like a
        // wedge. Restarting it would undo the idling and cost more battery than
        // never idling at all — so arrival suppresses the restart, and the next
        // trip re-arms the watcher by coming back through this function.
        if (
          !shouldRestartNativeWatcher({
            arrived: getState().otp?.goMode?.arrivedAt != null,
            maxFastRetries: GPS_WATCHDOG_MAX_FAST_RETRIES,
            restartsSinceLastFix: nativeGpsRestartsSinceLastFix,
            retryMs: GPS_WATCHDOG_RETRY_MS,
            silenceMs,
            watchdogMs: GPS_WATCHDOG_MS
          })
        ) {
          return
        }
        // console.warn feeds the debug-log sink (installGlobalErrorCapture),
        // so a remote device's wedge shows up in the jsonl with its timing.
        console.warn(
          `[Go Mode] GPS watchdog: no fix for ${Math.round(
            silenceMs / 1000
          )}s — restarting native watcher (attempt ${
            nativeGpsRestartsSinceLastFix + 1
          })`
        )
        // Reset the clock so a watcher that stays dead restarts once per
        // silence window, not on every poll.
        lastFixAtMs = Date.now()
        nativeGpsRestartsSinceLastFix += 1
        restartNativeGps(onNativePosition, onNativeError, {
          distanceFilter: nativeGpsDistanceFilterFor(false)
        })
      }, GPS_WATCHDOG_POLL_MS)
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
      if (session.simulationActive) return
      navigator.geolocation.getCurrentPosition(
        (position) => {
          // Double-check: simulation may have started while getCurrentPosition was pending
          if (session.simulationActive) return
          dispatch(handlePositionUpdate(position))
        },
        (error) => {
          if (session.simulationActive) return
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
        if (session.simulationActive) return
        dispatch(handlePositionUpdate(position))
      },
      (error) => {
        initialResolved = true
        clearTimeout(initialTimeout)
        if (session.simulationActive) return
        dispatch(setTrackingError(error))
      },
      { ...options, timeout: 15000 }
    )

    // Set up polling interval. A mid-trip itinerary switch (rider switch or
    // missed-bus auto-update) re-enters here with a poll already running —
    // replace it, never stack a second one.
    if (session.gpsPollingIntervalId) {
      clearInterval(session.gpsPollingIntervalId)
      session.gpsPollingIntervalId = null
    }
    const state = getState()
    const interval = state.otp?.goMode?.tracking?.interval || 8000
    const intervalId = setInterval(pollPosition, interval)

    // Store interval ID in module-scoped variable for cleanup
    session.gpsPollingIntervalId = intervalId

    // Re-acquire position when tab regains focus (background tab suspension recovery)
    if (!session.visibilityChangeHandler) {
      session.visibilityChangeHandler = () => {
        if (
          document.visibilityState === 'visible' &&
          session.gpsPollingIntervalId
        ) {
          // Immediately poll position when returning from background
          pollPosition()
        }
      }
      document.addEventListener(
        'visibilitychange',
        session.visibilityChangeHandler
      )
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
  'MISSED_BUS',
  // The rider's own bus closing on the boarding stop while they are still
  // walking or biking to it. Both stages are act-now: the rider asked to be
  // told, and a toast they cannot see from the pavement tells nobody.
  'BOARD_BUS_APPROACHING',
  'BOARD_BUS_ARRIVING',
  // The bus moved while the rider was on their way to it — the one thing they
  // cannot see from the pavement, and the reason they asked for this.
  'DEPARTURE_CHANGED',
  // Only the turns worth interrupting for; routine ones arrive as
  // UPCOMING_TURN, which is deliberately absent here and reaches the rider
  // through the silent turn card below instead. A paired watch gets one
  // vibration policy for the whole app, so restraint here IS the haptic design.
  'TURN_ALERT'
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
    const lp = goMode.tracking?.lastPosition
    const lastPos = lp
      ? { lat: lp.coords.latitude, lon: lp.coords.longitude }
      : null

    const riding = goMode.riding
    for (let i = currentLegIndex; i < legs.length; i++) {
      const leg: any = legs[i]
      if (!leg?.transitLeg) continue
      // convertGraphQLResponseToLegacy keeps leg.trip.gtfsId and also adds a
      // top-level leg.tripId; accept either. For the leg the rider is
      // verifiably aboard, the sticky riding fact wins: they may be on a
      // different run of the route than the plan boarded (earlier bus), and
      // the times shown must be THEIR bus's, not the planned one's.
      const tripId =
        (riding?.legIndex === i && riding.tripId) ||
        leg.trip?.gtfsId ||
        leg.tripId
      if (!tripId) continue

      // findTrip is noThrottle and idempotent; it refreshes the cached trip
      // (with current realtimeArrival) in transitIndex.trips[tripId].
      await dispatch(findTrip({ tripId }))
      const trip = getState().otp?.transitIndex?.trips?.[tripId]

      // Heal a leg whose plan geometry is missing (the onboard flow builds one
      // with empty points when its trip fetch fails): the trip record fetched
      // above carries the full shape, so slice it to the leg and repair. Until
      // this lands, handlePositionUpdate holds route matching entirely — see
      // assessMatchTrust — so this dispatch is what ends that hold.
      if (!legGeometryUsable(leg) && trip?.geometry?.points) {
        const repaired = sliceTripGeometryForLeg(trip.geometry.points, leg)
        if (repaired) {
          dispatch(repairLegGeometry({ legGeometry: repaired, legIndex: i }))
        }
      }

      const stopTimes = trip?.stopTimes || []
      if (!stopTimes.length) continue

      // Where this bus actually is, but ONLY for the leg the rider is
      // verifiably aboard. With it, a stop that has no realtime is projected
      // forward from the bus's current position instead of falling back to an
      // absolute timetable moment that has already passed. For a leg not yet
      // boarded there is no such anchor and the timetable is the honest answer.
      // Keyed on the TRIP, not the leg index. The onboard "I'm already on a
      // bus" flow sets riding.legIndex to -1 until a route match exists
      // (setRiding at :3954 and :4184 both pass routeMatch?.legIndex ?? -1), so
      // a legIndex test is false exactly when the rider is most certainly
      // aboard — the projection below never fired on the flow it was built for.
      // tripId is set at every setRiding call site, and these stopTimes ARE
      // that trip's, so matching on it is both correct and stricter.
      const anchor =
        riding?.tripId && riding.tripId === tripId
          ? {
              nextStopId: goMode.vehicleMatch?.match?.nextStopId ?? null,
              nowMs,
              userPos: lastPos
            }
          : null

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
        liveStopArrival(stopTimes, leg.to?.stop?.gtfsId, leg.to?.name, anchor),
        nowMs
      )
      const board = mergeLiveTimePoint(
        prev?.boardEpoch != null
          ? {
              epoch: prev.boardEpoch,
              realtime: prev.boardRealtime ?? prev.realtime
            }
          : null,
        liveStopArrival(
          stopTimes,
          leg.from?.stop?.gtfsId,
          leg.from?.name,
          anchor
        ),
        nowMs
      )
      if (alight || board) {
        liveTimes[i] = {
          alightEpoch: alight?.epoch ?? null,
          alightProjected: !!alight?.projected,
          alightRealtime: !!alight?.realtime,
          boardEpoch: board?.epoch ?? null,
          boardProjected: !!board?.projected,
          boardRealtime: !!board?.realtime,
          realtime: !!(alight?.realtime || board?.realtime)
        }
      }
    }

    dispatch(setLiveLegTimes(liveTimes))
  }
}

/**
 * Move the trip on to `legIndex`. Side-effectful — it clears the anchored
 * departure, swaps vehicle tracking, and restarts the position watcher at the
 * new leg's polling rate — so it must run once per leg; `session.lastTransitionedLegIndex`
 * is the guard, and setting it here is what keeps the automatic path from
 * re-running the same transition on the following tick.
 *
 * Both the GPS-driven transition and the rider's manual "I got off here" come
 * through this. Manual advances stick: matchPositionToRoute only ever searches
 * forward from the current leg, so the matcher cannot pull the trip back.
 */
export function advanceToLeg(legIndex: number) {
  return function (dispatch: any, getState: any) {
    const goMode = getState().otp?.goMode
    const itinerary: Itinerary | null = goMode?.activeItinerary
    if (!goMode?.isActive || !itinerary) return
    const legs = itinerary.legs || []
    if (legIndex < 0 || legIndex >= legs.length) return

    session.lastTransitionedLegIndex = legIndex
    dispatch(transitionLeg({ legIndex }))

    // New leg = new upcoming boarding = a fresh auto-anchor decision.
    session.manualDepartureLock = false
    session.lastAutoAnchorMs = null
    // And a fresh departure baseline. The boardingKey carries the leg index so
    // this is belt-and-braces, but it keeps a finished boarding's figures from
    // riding along for the rest of the trip.
    session.lastDepartureBaseline = null
    // A new leg is also a fresh quiet-replan slate — an egress leg must not
    // inherit the access leg's miss streak.
    session.quietReplanMissStreak = 0
    // Same reasoning for the deviation smoother: the previous leg's distance
    // says nothing about the new leg's geometry.
    session.prevDistanceFromRoute = null
    // And the same reasoning, one step further out, for the off-route alert —
    // see the stamp in startGoModeTracking.
    session.geometryChangedAtMs = getCurrentTime().getTime()

    // Update tracking interval for new leg
    const newLeg = legs[legIndex]
    const newInterval = getTrackingIntervalForLeg(newLeg)
    dispatch(updateTrackingInterval({ interval: newInterval }))

    // Vehicle tracking follows the NEW leg, never the old one. Reading the leg
    // being left from routeMatch.legIndex misses: by the time a GPS-driven
    // transition dispatches, the matcher has usually already moved to the new
    // leg, so `previousLeg` reads as the BIKE leg and the transit teardown is
    // skipped. That is the 8/9 leak — the confirmed match for vehicle 1:8150
    // outlived the 19:27:43 alight by 90 s and the onboard flow then adopted it
    // as proof the rider was still aboard. A non-transit leg has no vehicle to
    // track, which is all this needs to know.
    const newLegRouteId = getLegRouteId(newLeg)
    if (newLeg?.transitLeg && newLegRouteId) {
      dispatch(startVehicleTracking(newLegRouteId))
    } else if (
      goMode.vehicleMatch?.match ||
      goMode.vehicleMatch?.trackedRouteId
    ) {
      dispatch(stopVehicleTracking())
    }

    // Restart tracking with new interval (but not during simulation)
    if (!session.simulationActive) {
      if (session.gpsPollingIntervalId) {
        clearInterval(session.gpsPollingIntervalId)
        session.gpsPollingIntervalId = null
      }
      dispatch(startPositionTracking())
    }
  }
}

export function handlePositionUpdate(position: GeolocationPosition) {
  return function (dispatch: any, getState: any) {
    // Heartbeat for the native GPS watchdog — wall clock, unconditionally:
    // ANY position arriving proves the stream is alive, and with it that the
    // last restart worked, which is what returns the watchdog to its ordinary
    // budget after a run of fast retries.
    lastFixAtMs = Date.now()
    nativeGpsRestartsSinceLastFix = 0

    const state = getState()
    const goMode = state.otp?.goMode

    if (!goMode?.isActive) {
      return
    }

    // The post-arrival idle cadence, applied where the fixes land.
    // UPDATE_TRACKING_INTERVAL sizes the browser poll and nothing else: inside
    // the iOS shell the native watcher streams on its own terms (native-gps.ts
    // asks for distanceFilter: 0 so vehicle matching sees every fix), so on the
    // phone — the only place this bug has ever bitten — the tapered interval is
    // advisory unless the funnel enforces it. On 2026-08-28 that stream kept
    // delivering ~1 fix/s for 88 minutes past the arrival card: 5,318
    // positions, and with them 5,319 route matches and 5,319 progress
    // recomputations. Judged on the fix's own timestamp, not the wall clock, so
    // a replayed ride tapers exactly where the live one did.
    if (goMode.arrivedAt != null) {
      // The baseline falls back to the ARRIVAL ITSELF, not to Infinity.
      //
      // `session.lastArrivedFixMs` lives on the trip session, which is a
      // module-level object rebuilt from scratch on every page load, while
      // `arrivedAt` lives in the store and now survives one (cb453726). Null
      // therefore means two different things: "the first fix since we arrived",
      // and "a re-mount threw the baseline away". Reading it as Infinity waved
      // both through — harmless once, but on a phone that re-mounts twice in
      // 41 s, as this one did on 2026-08-31, it is a free full tick per mount
      // and the funnel visibly does not hold. Arrival is the true zero for
      // this taper, and it is the one the store remembers.
      const baselineMs = session.lastArrivedFixMs ?? goMode.arrivedAt
      const sinceLastFixMs = position.timestamp - baselineMs
      // A device clock that steps backwards reads as a fresh fix rather than
      // jamming the gate shut for as long as the skew lasts.
      if (sinceLastFixMs >= 0 && sinceLastFixMs < ARRIVED_TRACKING_INTERVAL_MS)
        return
      session.lastArrivedFixMs = position.timestamp
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

    // The rider's OWN ground step since the last fix. `goMode` was read before
    // this tick's updatePosition dispatch, so tracking.lastPosition is still
    // the previous fix. Null on the first fix of a session, where there is no
    // step to measure and the matcher is ungated anyway.
    const previousFix = goMode.tracking?.lastPosition
    const movedSinceFixM =
      previousFix?.coords?.latitude == null ||
      previousFix?.coords?.longitude == null
        ? null
        : calculateDistance(
            previousFix.coords.latitude,
            previousFix.coords.longitude,
            currentPosition[0],
            currentPosition[1]
          )

    // Match position to route
    let routeMatch = matchPositionToRoute(
      currentPosition,
      itinerary.legs,
      currentLegIndex,
      // Last tick's match, so a self-overlapping shape cannot flip between two
      // near-tied candidates and invent hundreds of metres of progress.
      // Already in the store; no new state needed.
      goMode.routeMatch,
      // The fix's OWN clock, matching the arrival taper above, so a replayed
      // ride gates exactly where the live one did. Deliberately NOT
      // previousMatchMs: that defaults to previousMatch.matchedAtMs, which the
      // matcher stamps and the store carries, and which is the moment the held
      // projection was ESTABLISHED. Feeding tracking.lastPosition.timestamp
      // instead would advance every tick — including through a
      // matchTrust.provisional hold, where the match does not move — freezing
      // the budget at ~1 s and stranding the rider on a stale point.
      {
        accuracyM: position.coords.accuracy,
        // Without this the jump budget is a mode ceiling and nothing else, and
        // a stationary rider on a bike leg is allowed 15 m/s of projection
        // movement they never made (2026-09-01, twice).
        movedSinceFixM,
        nowMs: position.timestamp
      }
    )

    if (!routeMatch) {
      dispatch(updateRouteMatch(routeMatch))
      return
    }

    // ONE current leg, not two.
    //
    // The matcher nominates a leg; TRANSITION_LEG decides. Those were two
    // independent answers to the same question, and the store held whichever
    // was written last — which is always the matcher, every tick. On
    // 2026-09-01 ride 2 the matcher moved to the Orange Line leg at 10:37:33
    // (810 m off it, `isOnRoute: false`) and TRANSITION_LEG did not follow
    // until 10:42:09, so for 4m36s the progress producer, the deviation
    // detector and the riding decision all ran against a bus polyline while
    // the trip believed it was still on the bike leg (backlog 6.3).
    //
    // So the nomination is put to the gate FIRST, and a refused nomination is
    // not stored: the match is re-taken over the legs the trip has actually
    // reached. The gate is re-asked from scratch every tick — this holds
    // nothing shut, it only declines to act early. `advanceToLeg` below then
    // sees an accepted match, unchanged.
    const transitionedLegIndex = session.lastTransitionedLegIndex ?? 0
    if (
      routeMatch.legIndex > transitionedLegIndex &&
      !shouldTransitionToNextLeg(routeMatch, transitionedLegIndex, {
        boardEpoch: goMode.liveLegTimes?.[routeMatch.legIndex]?.boardEpoch,
        isRiding: goMode.riding?.legIndex === routeMatch.legIndex,
        nowMs: getCurrentTime().getTime(),
        targetLeg: itinerary.legs[routeMatch.legIndex]
      })
    ) {
      routeMatch =
        matchPositionToRoute(
          currentPosition,
          // Sliced from the FRONT, so every legIndex the matcher returns is
          // still an index into itinerary.legs.
          itinerary.legs.slice(0, transitionedLegIndex + 1),
          Math.min(currentLegIndex, transitionedLegIndex),
          goMode.routeMatch,
          // Same gate as the nomination above, `movedSinceFixM` included.
          // Both calls measure from the same held match, so the rider's step
          // is not counted twice — but leaving it off here dropped the
          // unaccounted-ground accumulator on every tick the gate refused,
          // and that accumulator is the evidence that later releases a held
          // projection. A rider cycling toward the stop while the matcher
          // nominates the bus leg early would arrive with none of the ground
          // they had covered on the record.
          {
            accuracyM: position.coords.accuracy,
            movedSinceFixM,
            nowMs: position.timestamp
          }
        ) ?? routeMatch
    }

    // A match that had to see THROUGH a transit leg with unusable geometry is
    // no statement about where the rider is: the matcher silently skips such
    // legs and lands on whatever geometry remains. On 2026-08-27 that meant
    // five ticks pinned to a far-away point, a bogus "121m from route" push
    // and a 16-point progress jump while the trip fetch was failing. Holding
    // the PREVIOUS match is also what protects next tick's anchor — the
    // matcher only searches forward from routeMatch.legIndex, so storing a
    // blind cross-leg match would bake the jump in with no way back. Only the
    // live-times poll (the healing path — it re-fetches the trip and repairs
    // the leg's geometry) runs while the hold is on.
    const matchTrust = assessMatchTrust(
      itinerary.legs,
      currentLegIndex,
      routeMatch.legIndex
    )
    if (matchTrust.provisional) {
      if (session.matchHeldSinceMs == null) {
        session.matchHeldSinceMs = Date.now()
        // eslint-disable-next-line no-console
        console.log(
          '[go-mode] holding route match: unsettled geometry on leg(s) ' +
            matchTrust.unsettledLegIndexes.join(', ')
        )
      }
      if (
        !isReplayActive() &&
        Date.now() - session.lastLiveLegTimesAt > LIVE_LEG_TIMES_INTERVAL_MS
      ) {
        session.lastLiveLegTimesAt = Date.now()
        dispatch(refreshLiveLegTimes())
      }
      return
    }
    if (session.matchHeldSinceMs != null) {
      // eslint-disable-next-line no-console
      console.log(
        `[go-mode] route match resumed after ${Math.round(
          (Date.now() - session.matchHeldSinceMs) / 1000
        )}s geometry hold`
      )
      session.matchHeldSinceMs = null
    }

    dispatch(updateRouteMatch(routeMatch))

    const matchedLeg: any = itinerary.legs[routeMatch.legIndex]
    const riding = goMode.riding
    const nowForRiding = getCurrentTime().getTime()
    // Once the rider has arrived the trip is over, and neither of the two
    // side-effectful blocks below has anything left to decide. The quiesce
    // further down already stops notifications, reroutes and polling, but it
    // sits BELOW these, so on 2026-08-27 a finished trip went on maintaining
    // riding state and advancing legs for four and a half hours — through the
    // rider's drive home, where it chased a leg 9.9km away at 18 m/s. Position,
    // route match and progress still update above, so the map stays honest
    // while the arrival card is up; only the decisions stop.
    const alreadyArrived = goMode.arrivedAt != null

    // ORDER MATTERS: the leg transition runs BEFORE the riding update.
    //
    // It used to be the other way round, and the two disagreed about what tick
    // they were in. SET_RIDING advanced riding.legIndex to the new leg, and
    // TRANSITION_LEG's alight test is `legIndex > state.riding.legIndex`
    // (reducers/go-mode.ts) — which was then false, so on a transit-to-transit
    // transfer riding was never cleared and alightedFrom was never recorded.
    // The 2026-08-27 Gold Line transition inherited the falsely-boarded 94's
    // tripId, vehicleId and boardedAt, and the record claimed a Gold Line train
    // identified by a Minneapolis bus. Transitioning first means the alight
    // test sees the riding fact from the leg the rider is actually leaving.
    //
    // The basis for "have we already advanced onto this leg" is the leg the
    // trip actually TRANSITIONED to, not the matcher's last projection. Those
    // were the same number until 3f5d5b95 gave the transition a way to say no:
    // an access leg and the transit leg after it share an endpoint, so a rider
    // waiting at the stop projects onto the bus leg while the bus is still
    // minutes out, and the board-time gate refuses. But updateRouteMatch above
    // has already stored legIndex 1, so the NEXT tick reads previousLegIndex 1,
    // `match.legIndex <= currentLegIndex` short-circuits ahead of the gate, and
    // the refusal becomes permanent — the gate never gets asked again, not even
    // once the rider is aboard.
    //
    // The 2026-07-29 Orange Line replay shows the whole cost: the rider reached
    // the platform at 17:19:43 for a 17:26 bus, 77 s outside the five-minute
    // window, and advanceToLeg never ran for the rest of the ride. That is the
    // only place startVehicleTracking is called for a mid-trip transit leg, so
    // vehicle tracking never started, no vehicle was ever matched, and the
    // riding fact was established from GPS alone with vehicleId null. Arriving
    // at the stop early — which is exactly what the app tells riders to do — was
    // enough to lose vehicle tracking for the whole bus leg.
    //
    // session.lastTransitionedLegIndex is null before the first transition and
    // is reset on every itinerary swap and trip start; leg 0 is where a trip
    // begins. Everywhere a transition actually happens the two values agree, and
    // routeMatch is null after both a swap and a restore, so this reads the same
    // as the old expression in every case except a refusal.
    const previousLegIndex = session.lastTransitionedLegIndex ?? 0
    if (
      !alreadyArrived &&
      shouldTransitionToNextLeg(routeMatch, previousLegIndex, {
        boardEpoch: goMode.liveLegTimes?.[routeMatch.legIndex]?.boardEpoch,
        isRiding: riding?.legIndex === routeMatch.legIndex,
        nowMs: nowForRiding,
        targetLeg: matchedLeg
      }) &&
      routeMatch.legIndex !== session.lastTransitionedLegIndex
    ) {
      dispatch(advanceToLeg(routeMatch.legIndex))
    }

    // Maintain the sticky "riding" fact (see RidingState). Established once the
    // rider is verifiably aboard a transit leg; refreshed if the anchor leg
    // changes; dropped only after a sustained off-route period. The decision
    // itself is a pure function (util/go-mode/riding.ts) so it can be tested —
    // this is the seam every riding bug of 2026-08-27 lived in, and it had no
    // coverage at all.
    if (!alreadyArrived) {
      // "Has the rider waited at this stop?" is not a function of one fix, so
      // it is accumulated here and handed to the decision. See
      // BOARD_STOP_DWELL_MIN_MS: this is the evidence a bicycle overtaking a
      // bus route cannot manufacture, and its absence is what let 2026-09-01
      // ride 2 be declared aboard 4.3 km from its boarding stop.
      //
      // The wait happens where the access leg ENDS and the transit leg
      // begins, so it is measured against the next transit leg's boarding
      // stop whatever leg the matcher currently favours — otherwise the count
      // could not start until the trip had already stepped onto the bus, and
      // the two gates would depend on each other. Keyed by that leg's index,
      // so walking on to a different boarding stop starts the count again.
      const matchedLegIndex = routeMatch.legIndex
      const boardLegIndex = itinerary.legs.findIndex(
        (l: any, i: number) => i >= matchedLegIndex && l?.transitLeg
      )
      const boardStop: any =
        boardLegIndex >= 0 ? (itinerary.legs[boardLegIndex] as any).from : null
      session.boardStopDwell = trackBoardStopDwell(session.boardStopDwell, {
        distanceToBoardStopM:
          boardStop?.lat != null && boardStop?.lon != null
            ? calculateDistance(
                position.coords.latitude,
                position.coords.longitude,
                boardStop.lat,
                boardStop.lon
              )
            : null,
        legIndex: boardLegIndex,
        nowMs: nowForRiding
      })

      // Re-read riding: advanceToLeg above may have cleared it on alight.
      const ridingNow = getState().otp?.goMode?.riding ?? null
      const decision = decideRiding({
        boardStopDwellMs:
          session.boardStopDwell?.legIndex === routeMatch.legIndex
            ? session.boardStopDwell.dwellMs
            : null,
        fixAccuracyM: position.coords.accuracy ?? null,
        matchedLeg,
        nowMs: nowForRiding,
        offRouteClearMs: RIDING_OFFROUTE_CLEAR_MS,
        prevRiding: ridingNow,
        riderSpeedMps: position.coords.speed ?? null,
        routeMatch,
        vehicleMatch: goMode.vehicleMatch
      })
      if (decision.kind === 'set' || decision.kind === 'markOffRoute') {
        // A rider who has just tapped "Not on the bus" must not be put back
        // aboard by the next tick's guess (6.10c). Only an evidence-free
        // establishment is held, and only while riding is unset — a matched
        // vehicle, or the rider's own "I'm on the bus", still lands at once.
        if (
          !ridingSuppressedByRider({
            deniedAtMs: session.riderDeniedBoardingAtMs,
            next: decision.riding,
            nowMs: nowForRiding,
            prev: ridingNow
          })
        ) {
          dispatch(setRiding(decision.riding))
        }
      } else if (decision.kind === 'clear') {
        dispatch(clearRiding())
      }
    }

    // Feed the rolling bike-speed estimate the re-plan builders query with.
    // Gated on the rider being on a bike leg and NOT aboard anything: a fix
    // taken on a bus reads 15 m/s and would clamp straight to the top of the
    // lever range, which is how "tell OTP how fast the rider is" turns into a
    // different lie. Judged on the fix's own timestamp so a replay reproduces
    // the live estimate exactly. See util/go-mode/rider-speed.ts.
    if (
      matchedLeg?.mode === 'BICYCLE' &&
      !matchedLeg?.transitLeg &&
      !getState().otp?.goMode?.riding
    ) {
      session.riderSpeedSamples = recordRiderSpeedSample(
        session.riderSpeedSamples,
        { speedMps: position.coords.speed ?? null, tMs: position.timestamp }
      )
    }

    // Calculate progress — use simulated clock during simulation, real time for live GPS
    const currentTime = getCurrentTime()
    const departureOverride = goMode.departureOverride ?? null

    // On transit legs, hand progress calculation the trust-assessed inputs for
    // stop counting: is the rider's own fix sound, and what does their bus's
    // own feed record say (position projected on the leg, next-stop fact).
    // On 7/29 a stale fix kept driving the count while the bus knew better.
    // Simulation/replay fixes carry the sim clock in `timestamp`, so their age
    // is forced fresh — fixtures replay identically.
    let transitCtx
    const legForProgress: any = itinerary.legs[routeMatch.legIndex]
    if (legForProgress?.transitLeg) {
      const fixAgeMs =
        session.simulationActive || isReplayActive()
          ? 0
          : Date.now() - position.timestamp
      const ridingVehicle = findRidingVehicle(
        goMode.riding?.routeId
          ? state.otp?.transitIndex?.routes?.[goMode.riding.routeId]?.vehicles
          : null,
        goMode.riding,
        currentTime.getTime()
      )
      const vehicleFresh = isVehicleRecordFresh(ridingVehicle)
      transitCtx = {
        riderTrusted: assessRiderGpsTrust({
          accuracy: position.coords.accuracy,
          anchorLegIndex: goMode.riding?.legIndex ?? routeMatch.legIndex,
          fixAgeMs,
          routeMatch
        }),
        vehicleProgress: vehicleFresh
          ? vehicleProgressOnLeg(legForProgress, ridingVehicle!.vehicle)
          : null,
        vehicleStops: vehicleFresh
          ? stopsAheadFromNextStopId(
              legForProgress,
              ridingVehicle!.vehicle.nextStopId
            )
          : null
      }
    }

    // The live GTFS-realtime prediction for the boarding the rider is heading
    // toward. Believed ONLY when the feed genuinely flagged it live: a non-live
    // epoch is clamped forward to `now` by mergeLiveTimePoint /
    // clampNonLiveLegTimes, so trusting it would read as a bus perpetually
    // about to leave. Without this the wait math runs on a departure time that
    // cannot move, and a bus running six minutes late reaches the pacing card
    // as if it were on time.
    const boardingLegIndex = routeMatch.legIndex + 1
    const boardingLeg: any = itinerary.legs[boardingLegIndex]
    const liveBoarding = goMode.liveLegTimes?.[boardingLegIndex]
    const liveBoardMs =
      boardingLeg?.transitLeg &&
      liveBoarding?.boardRealtime &&
      liveBoarding.boardEpoch != null
        ? liveBoarding.boardEpoch
        : null

    // The live arrival at the leg the rider is ON. legAlight resolves
    // live -> projected -> plan in one place, so the header, the alight banner
    // and the notification ETA all read the same number instead of the header
    // quietly using the plan's frozen endTime.
    const liveAlightMs = itinerary.legs[routeMatch.legIndex]?.transitLeg
      ? Number(
          legAlight(
            routeMatch.legIndex,
            itinerary.legs[routeMatch.legIndex],
            goMode.liveLegTimes || {}
          ).epoch
        )
      : null

    const progress = calculateTripProgress(
      currentTime,
      itinerary,
      routeMatch,
      departureOverride,
      transitCtx,
      // The fix's own ground speed lets turn-announcement leads scale with how
      // fast the rider is actually moving (7/29: 6.5 m/s made the static 120 m
      // prepare an 18 s warning).
      position.coords.speed ?? null,
      liveBoardMs,
      Number.isFinite(liveAlightMs) ? liveAlightMs : null,
      // The raw fix, so arrival can be judged by where the rider actually is
      // and not only by a progress scalar that can freeze short of the bar.
      currentPosition
    )

    // A stop the rider has passed stays passed. calculateTripProgress is pure
    // and re-derives the count from this tick's position alone, so the latch is
    // applied here rather than inside it.
    if (progress.stopsRemaining != null) {
      const latched = latchStopsRemaining(session.stopCountLatch, {
        legIndex: progress.currentLegIndex,
        source: progress.stopsSource ?? 'unknown',
        stopsRemaining: progress.stopsRemaining
      })
      session.stopCountLatch = latched.next
      progress.stopsRemaining = latched.stopsRemaining
    } else {
      session.stopCountLatch = null
    }

    // How late the rider ARRIVED is a fact fixed at arrival. computeCurrentDelay
    // measures the schedule against the wall clock, so on a trip that is already
    // over it just counts the time since: on 2026-08-31 a rider standing still
    // at their destination went from "24 min late" to "31 min late" over the
    // 104 minutes the finished trip kept ticking, and every notification and
    // card that quotes delay climbed with it. Carry the measurement taken on the
    // arrival tick instead — the last one that meant anything. Not a fabricated
    // number: it is the real delay, held at the moment it stopped changing.
    if (goMode.arrivedAt != null && goMode.progress?.delay != null) {
      progress.delay = goMode.progress.delay
    }

    dispatch(updateProgress(progress))

    // The only thing that remembers distanceToDestination past this tick. Until
    // now it was computed every tick and read by nothing but the arrival latch,
    // so no part of the app could see the 8/28 afternoon failure: 32 minutes of
    // re-planning into the State Fairgrounds interior that never once got
    // inside 454 m. See util/go-mode/destination-progress.ts.
    session.destinationProgress = noteDestinationDistance(
      session.destinationProgress,
      progress.distanceToDestination
    )

    // Arrival: mark it once and let this tick's notification pass emit
    // TRIP_COMPLETE; every later tick quiesces here — no live-times polling,
    // auto-anchor, notifications, missed-bus or reroute activity for a rider
    // who has arrived (on 7/12 the deviation checks kept firing after the
    // destination). Position/route/progress updates above keep the map honest
    // while the arrival card is up.
    const hasArrived = goMode.arrivedAt != null
    if (
      !hasArrived &&
      (progress.status === 'completed' ||
        hasArrivedAtDestination(
          progress.overallProgress,
          progress.distanceToDestination
        ))
    ) {
      // Say which condition fired. The daemon reads this stream and had no way
      // to tell an arrival from a trip that simply stopped reporting, and a
      // one-way latch deserves a reason in the record.
      // eslint-disable-next-line no-console
      console.log(
        `[go-mode] arrived: progress=${progress.overallProgress.toFixed(2)}% ` +
          `distanceToDestination=${
            progress.distanceToDestination == null
              ? 'unknown'
              : `${Math.round(progress.distanceToDestination)}m`
          }`
      )
      dispatch(setArrived(currentTime.getTime()))
      // The quiesce below only governs what THIS function does; the two
      // subsystems that live outside the tick have to be told separately, and
      // on 2026-08-28 neither was. The trip was over at 22:08:37 and the rider
      // ended it by hand at 23:37:04 — 48% of that ride's telemetry (16,740 of
      // 34,784 actions) was recorded in between.
      stopRerouteSnapshotCapture()
      stopVehiclePolling()
      dispatch(
        updateTrackingInterval({ interval: ARRIVED_TRACKING_INTERVAL_MS })
      )
      // Resize the running poll in place, the way advanceToLeg does: the store
      // value is read once, when the interval is armed, so a dispatch on its
      // own never reaches the setInterval already ticking. Replay drives
      // positions from the recorded track and simulation from its own timer —
      // neither has a poll to resize, and starting one would put a live GPS
      // stream underneath a reproduced trip.
      if (!session.simulationActive && !isReplayActive()) {
        if (session.gpsPollingIntervalId) {
          clearInterval(session.gpsPollingIntervalId)
          session.gpsPollingIntervalId = null
        }
        dispatch(startPositionTracking())
      }
    } else if (hasArrived) {
      return
    }

    // Keep the trip-overview transit rows current off GTFS-realtime, throttled
    // to LIVE_LEG_TIMES_INTERVAL_MS regardless of tick rate. Skipped in replay,
    // which reproduces recorded data rather than re-polling live feeds.
    const nowMs = Date.now()
    if (
      !isReplayActive() &&
      nowMs - session.lastLiveLegTimesAt > LIVE_LEG_TIMES_INTERVAL_MS
    ) {
      session.lastLiveLegTimesAt = nowMs
      dispatch(refreshLiveLegTimes())

      // While the rider is on an access leg nothing else polls the boarding
      // route's vehicles — startVehicleTracking runs only on transit legs —
      // so the board-vehicle alert below would starve without its own poll.
      // Same 20s cadence as the rest of this block; the api layer's URL
      // throttle absorbs any overlap. Read-only: no vehicle MATCHING happens
      // while walking, this only fills the store the alert reads from.
      const accessLegNow: any = itinerary.legs[routeMatch.legIndex]
      if (accessLegNow?.mode === 'WALK' || accessLegNow?.mode === 'BICYCLE') {
        const pollBoardLegIndex = findBoardLegIndex(
          itinerary.legs,
          routeMatch.legIndex
        )
        const pollBoardRouteId =
          pollBoardLegIndex >= 0
            ? getLegRouteId(itinerary.legs[pollBoardLegIndex])
            : null
        if (pollBoardRouteId) {
          dispatch(getVehiclePositionsForRoute(pollBoardRouteId))
        }
      }

      // Auto-anchor: while walking/biking toward a transit boarding, target the
      // soonest same-route departure the rider can actually catch — the planned
      // itinerary may board a much later trip, and the wait/notification math
      // must track the real bus. Writing it into departureOverride is what makes
      // progress, the pacing card and missed-bus all agree on which bus that is.
      // Every rule lives in util/go-mode/departure-anchor.ts.
      const anchorLeg = itinerary.legs[routeMatch.legIndex]
      const anchorNextLeg = itinerary.legs[routeMatch.legIndex + 1]
      const boardingStopId = anchorBoardingStopId(anchorLeg, anchorNextLeg)
      if (boardingStopId) {
        // Re-poll the boarding stop's departures first — the trip-start
        // snapshot goes stale, and an earlier bus only ever shows up here.
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
          // Best-effort; the decision below uses whatever is in the store.
        }

        const anchor = evaluateDepartureAnchor(session.lastAutoAnchorMs, {
          departureOverride,
          departures: getRouteDepartures(
            getState().otp.transitIndex?.stops?.[boardingStopId],
            getLegRouteId(anchorNextLeg)
          ),
          manualLock: session.manualDepartureLock,
          nowMs: currentTime.getTime(),
          plannedBoardMs: anchorNextLeg?.startTime,
          rideSecondsRemaining: Math.max(
            0,
            (anchorLeg?.duration || 0) *
              (1 - (progress.currentLegProgress || 0) / 100)
          )
        })
        session.lastAutoAnchorMs = anchor.next
        if (anchor.anchorMs != null) {
          dispatch(setDepartureOverride(anchor.anchorMs))
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

    // How close the rider is to their exit, for the two alight alerts. The live
    // alight epoch is used ONLY when it is genuinely realtime: the non-live
    // branch is clamped forward to `now` by clampNonLiveLegTimes, which would
    // read as "arriving now" on every tick. Schedule data falls back to the
    // plan leg's own endTime, and GPS distance backs both up at the kerb.
    const liveAlight = goMode.liveLegTimes?.[routeMatch.legIndex]
    // Same value the header and the alight banner use. This used to be a
    // hand-rolled copy that honoured only alightRealtime, so it ignored a
    // projected time entirely and could disagree with the banner about when
    // the rider gets off.
    const alightEpochMs = Number.isFinite(liveAlightMs)
      ? (liveAlightMs as number)
      : Number(currentLeg?.endTime)
    const alightContext: AlightContext = {
      distanceMetres:
        currentLeg?.to?.lat != null && currentLeg?.to?.lon != null
          ? calculateDistance(
              currentPosition[0],
              currentPosition[1],
              currentLeg.to.lat,
              currentLeg.to.lon
            )
          : null,
      etaSeconds: Number.isFinite(alightEpochMs)
        ? (alightEpochMs - currentTime.getTime()) / 1000
        : null
    }

    // Deviation is judged on the smaller of this tick's and last tick's matched
    // distance, so one wild fix cannot read as drift — see deviation.ts.
    const smoothed = smoothDistanceFromRoute(
      session.prevDistanceFromRoute,
      routeMatch.distanceFromRoute
    )
    const persistedDistanceFromRoute = smoothed.distance
    session.prevDistanceFromRoute = smoothed.next

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

    // ORDER MATTERS: this is decided BEFORE the notification pass, not after.
    //
    // The quiet access-leg re-plan used to be evaluated at the bottom of the
    // tick, long after the cards had gone out, and on 2026-08-28 the "Off
    // Route" push beat the re-plan that made it moot by under two seconds three
    // times over (17:12:57, 17:14:45, 17:36:33). The rider was told they were
    // lost and then silently un-lost. Asking first is only possible since the
    // re-plan stopped keying on the notification (see shouldQuietReplanAccessLeg
    // in deviation.ts); while that dependency ran backwards, suppressing the
    // card would have suppressed the fix.
    //
    // The dispatch itself stays where it is, inside the else-if chain that
    // gives missed-bus recovery and the boarded-earlier swap precedence. Both
    // of those are re-plans too, so a tick they win is still a tick the app is
    // fixing the route on.
    const quietReplanImminent = willQuietReplanAccessLeg({
      currentLeg,
      distanceFromRoute: persistedDistanceFromRoute,
      lastReplanAtMs: session.lastQuietReplanAt,
      nowMs: currentTime.getTime(),
      recentReplanAtMs: session.quietReplanHistory,
      remainingAccessMeters: remainingAccessDistanceM(
        itinerary.legs,
        routeMatch.legIndex,
        routeMatch.progressAlongLeg
      ),
      reRouteStatus
    })

    const notifications = checkForNotifications(
      progress,
      currentLeg,
      previousLegIndex,
      nextLeg,
      persistedDistanceFromRoute,
      goMode.notifications?.sentNotifications || [],
      goMode.notifications || {
        enabled: true,
        soundEnabled: false,
        vibrationEnabled: true
      },
      itinerary.legs,
      alightContext,
      {
        geometryChangedAtMs: session.geometryChangedAtMs,
        handledAtMs: session.deviationHandledAtMs,
        nowMs: currentTime.getTime(),
        replanImminent: quietReplanImminent
      }
    )

    // One clock for three arms — told, quietly re-planned around, or simply
    // still off the line. The first two are the same event handled two ways;
    // the third is what stopped ride 2 of 2026-09-01 getting five identical
    // "Off Route" cards 120 s apart through one continuous excursion. All of
    // the reasoning, and the reason the third arm can only extend an open
    // window and never open one, is on nextDeviationHandledAtMs.
    session.deviationHandledAtMs = nextDeviationHandledAtMs({
      alerted: notifications.some((n) => n.type === 'ROUTE_DEVIATION'),
      currentLeg,
      distanceFromRoute: persistedDistanceFromRoute,
      handledAtMs: session.deviationHandledAtMs,
      nowMs: currentTime.getTime(),
      replanImminent: quietReplanImminent
    })

    // Missed boarding? Judged outside checkForNotifications because it needs
    // live board times, the sticky riding fact, and the raw GPS fix. The
    // planned trip's own vehicle record rides along so the classifier can
    // cross-check a "departed" epoch against where the bus actually is (7/29:
    // the epoch said departed while bus 8140 was still pulling in).
    const boardLegIndex = findBoardLegIndex(itinerary.legs, routeMatch.legIndex)
    const boardLeg: any =
      boardLegIndex >= 0 ? itinerary.legs[boardLegIndex] : null
    const boardVehicleRecord = boardLeg
      ? findVehicleForTrip(
          state.otp?.transitIndex?.routes?.[getLegRouteId(boardLeg) ?? '']
            ?.vehicles,
          boardLeg.trip?.gtfsId || boardLeg.tripId,
          currentTime.getTime()
        )
      : null
    // One reading of the planned trip's vehicle, shared by the missed-bus
    // classifier and the board-vehicle alert so they judge the same evidence.
    const boardVehicleInfo = boardVehicleRecord
      ? {
          ageSec: boardVehicleRecord.ageSec,
          distanceToBoardStopM:
            boardLeg?.from?.lat != null && boardLeg?.from?.lon != null
              ? calculateDistance(
                  boardVehicleRecord.vehicle.lat,
                  boardVehicleRecord.vehicle.lon,
                  boardLeg.from.lat,
                  boardLeg.from.lon
                )
              : null,
          nextStopId: boardVehicleRecord.vehicle.nextStopId ?? null
        }
      : null
    const missedCtx = classifyMissedBus({
      boardVehicle: boardVehicleInfo,
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

    // "Your bus is coming", while the rider walks or bikes to the stop —
    // rider-requested from the kerb on 2026-08-27. Judged out here for the
    // same reason as missed-bus, on the same vehicle reading; skipped on a
    // tick that raised MISSED_BUS, which owns the bus-already-gone story, and
    // once riding is established there is nothing left to announce.
    if (
      !missedEvent &&
      !goMode.riding &&
      boardLeg &&
      routeMatch.legIndex < boardLegIndex &&
      (currentLeg?.mode === 'WALK' || currentLeg?.mode === 'BICYCLE')
    ) {
      const liveBoardForAlert = goMode.liveLegTimes?.[boardLegIndex]
      const boardAlert = checkBoardVehicleApproach(
        boardLeg,
        {
          liveBoardEpochMs:
            liveBoardForAlert?.boardRealtime &&
            liveBoardForAlert.boardEpoch != null
              ? liveBoardForAlert.boardEpoch
              : null,
          nowMs: currentTime.getTime(),
          vehicle: boardVehicleInfo
        },
        goMode.notifications?.sentNotifications || []
      )
      if (boardAlert) notifications.push(boardAlert)
    }

    // Has the bus the rider is travelling toward moved? Judged out here rather
    // than inside checkForNotifications because the answer needs a baseline
    // held across ticks — the same reason classifyMissedBus lives out here.
    //
    // Skipped entirely on a tick that already raised MISSED_BUS or LEAVE_SOON:
    // both say the actionable thing, and a second buzz would only dilute them.
    // Skipping rather than discarding also keeps the baseline intact, so a
    // drift that is still real re-alerts on the next tick.
    const supersedesDrift = notifications.some(
      (n) => n.type === 'MISSED_BUS' || n.type === 'LEAVE_SOON'
    )
    if (
      !supersedesDrift &&
      getState().otp.config.goMode?.departureDrift !== false
    ) {
      const onAccessLeg =
        currentLeg?.mode === 'WALK' || currentLeg?.mode === 'BICYCLE'
      const boardingTripId =
        boardingLeg?.trip?.gtfsId || boardingLeg?.tripId || null
      const drift = evaluateDepartureDrift(session.lastDepartureBaseline, {
        boardingKey:
          onAccessLeg && boardingLeg?.transitLeg && boardingTripId
            ? `${boardingLegIndex}:${boardingTripId}:${
                departureOverride ?? 'plan'
              }`
            : null,
        // A rider-selected departure is a DIFFERENT bus from the one
        // liveLegTimes follows (it keys off the planned leg's trip id), so
        // there is no honest live figure to watch and nothing to report.
        liveDepartureMs: departureOverride == null ? liveBoardMs : null,
        nowMs: currentTime.getTime(),
        routeName:
          boardingLeg?.routeShortName ||
          boardingLeg?.routeLongName ||
          'Your bus',
        waitSeconds: progress.waitTimeAtStop ?? null
      })
      session.lastDepartureBaseline = drift.next
      if (drift.alert) notifications.push(drift.alert)
    }

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
        // (native shell only; no-op in a browser). Repeat suppression lives in
        // each individual check, not here: turn cues are latched per (cue,
        // stage) for the life of the leg in checkUpcomingTurn, with
        // wasRecentlySent's window as a backstop; the others carry their own
        // windows. This comment used to claim checkForNotifications guaranteed
        // "each fires at most once" — it never did and gated nothing, and on
        // 7/31 a stationary rider got the same turn pushed 14 times in 7 min.
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

    // The two sticky cards on the rider's wrist. Both sit BELOW the arrival
    // quiesce's `else if (hasArrived) return`, so the tick that latches arrival
    // is the last one that ever reaches them — which means whatever card was
    // posted last has no path to being cleared. On the 2026-08-28 ride the
    // watch still read "Turn left on George Perry Floyd Jr Place" 88 minutes
    // after the trip ended; only endGoMode cancels these, so a rider who
    // backgrounds or kills the app keeps a dead turn on their wrist. That
    // became reachable when 73ef2b9a taught arrival to fire on distance
    // (correctly — it is why the trip ends at all now), moving the latch off
    // the final tick and ahead of the last cue.
    //
    // Arrival is the end of navigation: clear both, once, and do not evaluate
    // them again. Evaluating would be worse than doing nothing — the arrival
    // tick can still have a cue pending, so it would post a fresh turn card
    // onto a wrist that nothing will visit again.
    if (getState().otp.goMode?.arrivedAt != null) {
      if (session.lastTurnCardKey !== null) {
        cancelPush(TURN_CARD_NOTIFICATION_ID)
        session.lastTurnCardKey = null
      }
      if (session.lastPacingCard !== null) {
        cancelPush(PACING_CARD_NOTIFICATION_ID)
        session.lastPacingCard = null
      }
    } else {
      // What to show and when to swap or clear it is decided in
      // util/go-mode/turn-card.ts, which carries the reasoning and the rides
      // behind it.
      const turnCard = evaluateTurnCard(session.lastTurnCardKey, {
        currentLeg,
        enabled: !replaying && getState().otp.config.goMode?.turnCard !== false,
        progress
      })
      session.lastTurnCardKey = turnCard.next
      if (turnCard.post) {
        sendPush({ id: TURN_CARD_NOTIFICATION_ID, ...turnCard.post })
      } else if (turnCard.clear) {
        cancelPush(TURN_CARD_NOTIFICATION_ID)
      }

      // The pacing card (id 2, alongside the turn card): ride time left, the
      // bus being chased, and the buffer at the stop, so the rider knows
      // whether to go fast or slow. Every decision — cadence, clearing, and the
      // enable gate — lives in util/go-mode/pacing-card.ts.
      //
      // The last two arguments are the rider's 2026-09-01 ask (6.10a): the
      // feed's own departure (liveBoardMs is already the boardRealtime-gated
      // one, computed above for exactly this reason) and the rolling observed
      // cycling pace, which is non-null only after the rider has really been
      // moving on a bike leg. With both, the card's buffer becomes measured
      // flex rather than plan arithmetic, and it is allowed to buzz when that
      // flex erodes. Without them the card behaves exactly as it did.
      const pacingCard = evaluatePacingCard(session.lastPacingCard, {
        currentLeg,
        enabled:
          !replaying && getState().otp.config.goMode?.pacingCard !== false,
        liveBoardEpochMs: liveBoardMs,
        nextLeg,
        nowMs: currentTime.getTime(),
        observedSpeedMps: observedBikeSpeedMps(),
        progress
      })
      session.lastPacingCard = pacingCard.next
      if (pacingCard.post) {
        sendPush({ id: PACING_CARD_NOTIFICATION_ID, ...pacingCard.post })
      } else if (pacingCard.clear) {
        cancelPush(PACING_CARD_NOTIFICATION_ID)
      }
    }

    // Whether a missed bus re-plans now, whether the result is applied without
    // asking, and the per-departure retry schedule all live in
    // util/go-mode/missed-bus-recovery.ts.
    const recovery = evaluateMissedBusRecovery(
      session.missedBusRerouteAttempt,
      {
        justRaised: missedEvent != null,
        missed: missedCtx,
        // Wall clock, not currentTime: the retry schedule is about how long the
        // rider has really been stranded, and this is what the inline version
        // used. It does mean a sped-up replay does not reproduce the retry
        // cadence faithfully — see the note in missed-bus-recovery.ts.
        nowMs: Date.now(),
        reRouteStatus
      }
    )
    session.missedBusRerouteAttempt = recovery.next
    if (recovery.replan && missedCtx) {
      // Never reached while the rider is aboard: classifyMissedBus returns null
      // outright when the sticky riding fact is set (notification-service,
      // "Aboard already?"), so a missed-bus re-plan can only ever run for a
      // rider who is not on a bus. That is what makes this path's
      // currentPositionOrigin anchor — the next stop ahead — safe.
      dispatch(
        reRouteFromCurrentPosition({
          autoApply: recovery.autoApply,
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
      // before the planned bus could exist. Recovery is replanFromAboard:
      // the boarded trip's own schedule drives the alight optimizer, so the
      // applied itinerary's first leg IS the ridden bus and downstream
      // transfers are real; beginGoMode (via the auto-apply path) then
      // resets the override.
      (() => {
        // 'none' is a settled failed/empty attempt — retryable, same as the
        // missed-bus auto-update. Anything else is in flight or showing a card.
        if (reRouteStatus !== 'idle' && reRouteStatus !== 'none') return false
        const riding = goMode.riding
        if (!riding || riding.legIndex == null || riding.legIndex < 0)
          return false
        const ridingLeg = itinerary.legs[riding.legIndex]
        if (!ridingLeg?.transitLeg) return false
        // Key the latch on facts that SURVIVE an auto-apply. legIndex is
        // exactly the field the splice rewrites, so on 8/2 every successful
        // replan minted a fresh key and reset the attempt counter — the cap
        // never held. tripId and boardedAt are both preserved by setRiding
        // across the splice, and both change on a genuine re-board, since
        // TRANSITION_LEG clears riding on alight.
        const boardingKey = `${riding.tripId ?? ''}:${riding.boardedAt ?? ''}`
        if (
          session.earlyBoardReplan?.key === boardingKey &&
          (session.earlyBoardReplan.attempts >=
            EARLY_BOARD_REPLAN_MAX_ATTEMPTS ||
            Date.now() - session.earlyBoardReplan.lastAtMs <
              EARLY_BOARD_REPLAN_RETRY_MS)
        ) {
          return false
        }
        // The proof gates live in shouldReplanBoardedEarlier: a trusted match
        // on a different trip must also be sustained (a flap can't arm it),
        // same-headsign (an opposite-direction same-route vehicle is never
        // "the earlier bus you boarded" — 7/29), and backed by a fresh feed
        // record for the matched vehicle.
        const matched = goMode.vehicleMatch?.match
        const ridingVehicles =
          state.otp?.transitIndex?.routes?.[
            riding.routeId ?? getLegRouteId(ridingLeg as Leg) ?? ''
          ]?.vehicles
        const matchedRecord =
          findVehicleById(
            ridingVehicles,
            matched?.vehicleId,
            currentTime.getTime()
          ) ??
          findVehicleForTrip(
            ridingVehicles,
            matched?.tripId,
            currentTime.getTime()
          )
        // The ridden leg's board time as the feed has it now. Without this the
        // early-board clock test runs on the plan's frozen startTime, and a bus
        // running ahead of schedule reads as a bus the rider could not yet be
        // on. Same resolution as the boarding-approach alert below.
        const liveRidingBoard = goMode.liveLegTimes?.[riding.legIndex]
        if (
          !shouldReplanBoardedEarlier({
            liveBoardEpochMs:
              liveRidingBoard?.boardRealtime &&
              liveRidingBoard.boardEpoch != null
                ? liveRidingBoard.boardEpoch
                : null,
            nowMs: currentTime.getTime(),
            // Every leg's trip, so the gate can tell "an earlier run of this
            // route" from "the trip of a leg already ridden" — the 8/31
            // transfer loop was entirely the latter.
            plannedTripIds: (itinerary.legs || []).map(
              (l: any) => l?.trip?.gtfsId ?? l?.tripId ?? null
            ),
            ridingLeg: ridingLeg as Leg,
            ridingTripId: riding.tripId,
            vehicleMatchState: goMode.vehicleMatch,
            vehicleRecord: matchedRecord
          })
        ) {
          return false
        }
        session.earlyBoardReplan = {
          attempts:
            session.earlyBoardReplan?.key === boardingKey
              ? session.earlyBoardReplan.attempts + 1
              : 1,
          key: boardingKey,
          lastAtMs: Date.now()
        }
        return true
      })()
    ) {
      // Every trust gate lives above (shouldReplanBoardedEarlier IIFE,
      // rebind hysteresis, attempt caps, session.earlyBoardReplan bookkeeping) —
      // only the dispatched recovery changed. The old keepRouteId point-plan
      // could still legally board the same route at a different station;
      // the aboard replan keeps the rider on the physically-boarded trip by
      // construction.
      dispatch(replanFromAboard({ autoApply: true, reason: 'boarded-earlier' }))
    } else if (
      shouldQuietReplanAccessLeg({
        currentLeg,
        // The drift itself, not only a fresh alert about it. checkRouteDeviation
        // dedups on a 120 s window because that is how often it is decent to
        // interrupt someone — borrowing it as the re-plan's retry interval is
        // why 8/28's 670 m leg went un-replanned for three minutes and why
        // scaling the re-plan cooldown alone would have changed nothing. Rate
        // is quietReplanAdmitted's job now.
        distanceFromRoute: persistedDistanceFromRoute,
        notifications,
        reRouteStatus
      })
    ) {
      // Drifted off a walk/bike leg: the rider chose their own way. Quietly
      // re-plan the access path from where they are (car-GPS style) — no card,
      // no screen change; same-route rule enforced by the picker. Why a transit
      // leg gets nothing automatic is in deviation.ts.
      dispatch(quietReplanAccessLeg())
    }
  }
}

/**
 * Start polling vehicle positions for a transit route.
 */
export function startVehicleTracking(routeId: string) {
  return function (dispatch: any) {
    // Clean up any existing interval
    if (session.vehiclePositionIntervalId) {
      clearInterval(session.vehiclePositionIntervalId)
      session.vehiclePositionIntervalId = null
    }

    // Fetch immediately, then every 15 seconds
    dispatch(getVehiclePositionsForRoute(routeId))

    if (isReplayActive()) {
      // Replay drives vehicle refresh off the simulated clock (per GPS tick in
      // scheduleNextSimulationPoint), not wall-clock — so fast/slow playback
      // stays deterministic. Just remember which route to refresh.
      replayTrackedRouteId = routeId
    } else {
      session.vehiclePositionIntervalId = setInterval(() => {
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
    if (session.vehiclePositionIntervalId) {
      clearInterval(session.vehiclePositionIntervalId)
      session.vehiclePositionIntervalId = null
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
    if (vehicles.length === 0) {
      // No vehicles on this route at all. Usually the feed simply hasn't
      // landed yet, but some agencies (e.g. MVTA before its GTFS-RT was wired
      // up) publish none — count the empty polls so the UI can stop promising
      // a match that will never come. See NO_LIVE_VEHICLE_POLLS.
      dispatch({
        payload: { emptyPolls: (goMode.vehicleMatch?.emptyPolls || 0) + 1 },
        type: UPDATE_VEHICLE_MATCH
      })
      return
    }

    const previousMatch = goMode.vehicleMatch?.match || null

    // A confirmed match never re-matches — but it must not freeze either. On
    // 7/29 the confirmed record kept its confirmation-time lastSeen/nextStopId
    // for the whole ride, so a dead feed looked healthy and the next-stop fact
    // was useless. Refresh distance/lastSeen/nextStopId from the SAME
    // vehicle's feed record; absent from the feed → dispatch nothing and let
    // lastSeen age honestly (the badge goes stale at VEHICLE_MATCH_FRESH_MS).
    if (previousMatch?.confidence === 'confirmed') {
      const refreshed = refreshConfirmedMatch(
        previousMatch,
        vehicles,
        userPos.coords.latitude,
        userPos.coords.longitude,
        Date.now()
      )
      if (refreshed) {
        dispatch({
          payload: { emptyPolls: 0, match: refreshed },
          type: UPDATE_VEHICLE_MATCH
        })
      }
      return
    }

    // Widen the match radius by rider speed: on a moving bus the GTFS-RT
    // position lags behind the rider (freeway BRT can outrun the feed by
    // several hundred meters), so fixed walking-scale radii never match.
    // Speed also feeds the direction gate — headings only count against a
    // candidate while the rider is actually moving.
    const riderSpeed = userPos.coords.speed

    // Which way is the rider's own leg going? The PLANNED leg cannot say — the
    // plan query never fetched direction_id — so ask the feed: find the record
    // for the trip the rider is supposed to be on and read its direction. When
    // that trip isn't currently reporting there is no expected direction and
    // the gate stays inert, which is the honest answer rather than a guess.
    // The leg the rider is boarding: the next TRANSIT leg at or after the one
    // the matcher favours. Reading the matcher's own leg would name the access
    // leg while the rider is still walking to the stop, and an access leg has
    // no trip and no boarding stop id — so both the direction gate and the
    // board-stop gate below would go inert exactly while the rider waits.
    const legs: any[] = goMode.activeItinerary?.legs ?? []
    const matcherLegIndex = goMode.routeMatch?.legIndex ?? 0
    const boardLegIndex = legs.findIndex(
      (l: any, i: number) => i >= matcherLegIndex && l?.transitLeg
    )
    const plannedLeg: any =
      boardLegIndex >= 0 ? legs[boardLegIndex] : legs[matcherLegIndex]
    const plannedTripId = plannedLeg?.trip?.gtfsId || plannedLeg?.tripId || null
    const expectedDirectionId = plannedTripId
      ? vehicles.find((v: any) => v.tripId === plannedTripId)?.directionId ??
        null
      : null

    const matchResult = matchUserToVehicle(
      userPos.coords.latitude,
      userPos.coords.longitude,
      userPos.coords.heading,
      vehicles,
      routeId,
      previousMatch,
      speedAdjustedRadius(80, riderSpeed),
      riderSpeed,
      expectedDirectionId
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
      payload: { consecutiveMatches, emptyPolls: 0, match: matchResult },
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
        // Auto-confirming is the app boarding the rider on their behalf, so it
        // needs more than one poll and more than a bus that is on its way.
        //
        // 2026-09-01 ride 1, 08:26:26: one poll (`consecutiveMatches: 1`,
        // confidence `medium`), vehicle 8139 135 m off with `nextStopId` still
        // "I-35W & 98th St Station" — the rider's OWN boarding stop, so it had
        // not arrived — and the rider standing on the platform at 0.0-0.9 m/s.
        // This fired anyway, minted `confidence: "confirmed"`, and SET_RIDING
        // landed 3 ms later. The boarded-earlier branch then swapped the whole
        // itinerary with `autoApply: true`, moving the estimated arrival
        // +8m54s. Both halves of that are the same missing gate.
        if (
          matchResult.vehicleId &&
          matchResult.confidence !== 'low' &&
          consecutiveMatches >= BOARD_AUTO_CONFIRM_MIN_CONSECUTIVE &&
          vehicleReachedBoardStop(matchResult, plannedLeg)
        ) {
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
 * The rider says they ARE on the bus (trip-sheet button, 6.10c).
 *
 * Deliberately not a new way to write `riding`: it routes through
 * `confirmVehicleSelection`, exactly as the boarding prompt's own "This one"
 * button does, so the fact that lands carries a real vehicle and trip id
 * instead of a rider-shaped placeholder — which is what makes it usable by
 * everything downstream that keys on `riding.tripId` (the alight optimizer,
 * the access re-plan's aboard check, the stop counter).
 *
 * With no vehicle matched yet there is nothing honest to name, so the existing
 * boarding prompt opens and the rider picks from the buses actually nearby.
 * No new surface, and no guessing.
 */
export function confirmBoardingByRider() {
  return function (dispatch: any, getState: any) {
    const goMode = getState().otp?.goMode
    // A confirmation retires any standing denial: the rider has changed their
    // answer, and the hold exists to respect them, not to outlive them.
    session.riderDeniedBoardingAtMs = null
    const vehicleId = goMode?.vehicleMatch?.match?.vehicleId || null
    if (vehicleId) {
      dispatch(confirmVehicleSelection(vehicleId))
    } else {
      dispatch(showBoardingPromptAction())
    }
  }
}

/**
 * The rider says they are NOT on the bus (trip-sheet button, 6.10c).
 *
 * Drops the riding fact and the vehicle match that fed it, and holds the
 * evidence-free half of the board gate off for BOARDING_DENIAL_HOLD_MS so the
 * next tick cannot simply re-declare it. The rider's word is the strongest
 * signal there is in either direction; on 2026-09-01 they had to say it out
 * loud with no way to tell the app.
 */
export function denyBoardingByRider() {
  return function (dispatch: any) {
    session.riderDeniedBoardingAtMs = getCurrentTime().getTime()
    dispatch(clearRiding())
    dispatch(clearVehicleMatch())
    dispatch(dismissBoardingPrompt())
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
    let selected = nearby.find(
      (v: { vehicleId: string }) => v.vehicleId === vehicleId
    )
    // The nearby list (tighter radius, per-tick snapshot) can miss a vehicle
    // the matcher itself found — falling through with tripId null here used to
    // confirm a bus whose run we then couldn't identify (and skipped the
    // riding fact entirely). Recover the identity from the raw route feeds.
    if (!selected) {
      const routes = state.otp?.transitIndex?.routes || {}
      for (const routeId of Object.keys(routes)) {
        const v = (routes[routeId]?.vehicles || []).find(
          (rv: { vehicleId: string }) => rv.vehicleId === vehicleId
        )
        if (v) {
          selected = { ...v, routeId: v.routeId ?? routeId }
          break
        }
      }
    }

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
      // Keep a board time that already had a bus behind it; re-stamp one that
      // did not. On 2026-09-01 ride 2 riding was established from GPS alone at
      // 10:47:15 with `vehicleId: null`; real evidence arrived 3m40s later
      // (CONFIRM_VEHICLE 10:50:55, vehicle 1:8216 at 127.9 m) and this line
      // carried the fabricated `boardedAt: 1788277635049` straight through it,
      // so the recorded boarding stayed 3m40s early even after confirmation.
      const prevBoardedAt = ridingFactIsEvidenced(prevRiding)
        ? prevRiding?.boardedAt
        : null
      dispatch(
        setRiding({
          boardedAt: prevBoardedAt ?? Date.now(),
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
      session.simulationActive && session.simulatedTimeMs > 0
        ? session.simulatedTimeMs
        : Date.now()
  } as GeolocationPosition
}

/**
 * Schedule the next simulation point using setTimeout.
 * Each point has its own delay (derived from schedule or even distribution).
 */
function scheduleNextSimulationPoint(dispatch: any) {
  if (
    !session.simulationActive ||
    session.simulationPointIndex >= session.simulationCoords.length
  ) {
    session.simulationActive = false
    session.gpsSimulationTimeoutId = null
    dispatch({ type: STOP_GPS_SIMULATION })
    console.info('[Go Mode] GPS simulation complete')
    return
  }

  const point = session.simulationCoords[session.simulationPointIndex]
  const delay = Math.max(50, point.delayMs / simulationSpeedMultiplier)

  session.gpsSimulationTimeoutId = setTimeout(() => {
    if (!session.simulationActive) return

    // Advance the simulated clock by the un-scaled delay (actual schedule time)
    session.simulatedTimeMs += point.delayMs

    // Replay: keep the fixture clock in step and refresh the recorded vehicle
    // snapshot for the current sim time BEFORE matching runs in
    // handlePositionUpdate, so vehicle matching sees sim-time-aligned positions
    // (the wall-clock 15s poll is disabled during replay for determinism).
    if (isReplayActive()) {
      setReplayClock(session.simulatedTimeMs)
      if (replayTrackedRouteId) {
        dispatch(getVehiclePositionsForRoute(replayTrackedRouteId))
      }
    }

    const cur = session.simulationCoords[session.simulationPointIndex]
    dispatch(
      handlePositionUpdate(createMockPosition(cur.coord[0], cur.coord[1], cur))
    )
    session.simulationPointIndex++
    dispatch({
      payload: { pointIndex: session.simulationPointIndex },
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
    if (session.gpsSimulationTimeoutId) {
      clearTimeout(session.gpsSimulationTimeoutId)
      session.gpsSimulationTimeoutId = null
    }

    // Clean up real GPS tracking if running. The native watchdog goes with it
    // — simulated ticks would look like GPS silence and trigger restarts.
    if (session.gpsPollingIntervalId) {
      clearInterval(session.gpsPollingIntervalId)
      session.gpsPollingIntervalId = null
    }
    stopGpsWatchdog()

    // Store in module scope for pause/resume
    session.simulationCoords = timedPoints
    session.simulationPointIndex = 0
    simulationSpeedMultiplier = speedMultiplier
    session.simulationActive = true
    session.simulatedTimeMs = itinerary.startTime // begin simulated clock at itinerary start

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
    session.simulationPointIndex = 1
    dispatch({
      payload: { pointIndex: session.simulationPointIndex },
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
    if (session.gpsSimulationTimeoutId) {
      clearTimeout(session.gpsSimulationTimeoutId)
      session.gpsSimulationTimeoutId = null
    }
    session.simulationActive = false

    session.simulationPointIndex = 0
    session.simulationCoords = []
    session.simulatedTimeMs = 0

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

    if (session.gpsSimulationTimeoutId) {
      clearTimeout(session.gpsSimulationTimeoutId)
      session.gpsSimulationTimeoutId = null
    }
    if (session.gpsPollingIntervalId) {
      clearInterval(session.gpsPollingIntervalId)
      session.gpsPollingIntervalId = null
    }
    // Replay drives positions itself; the native watchdog would read the
    // recorded track as GPS silence.
    stopGpsWatchdog()

    session.simulationCoords = trackToTimedPoints(track)
    session.simulationPointIndex = 0
    simulationSpeedMultiplier = speedMultiplier
    session.simulationActive = true
    session.simulatedTimeMs = startMs ?? track[0].tMs
    setReplayClock(session.simulatedTimeMs)

    console.info(
      `[Go Mode] Starting trip replay: ${session.simulationCoords.length} fixes, ` +
        `speed ${speedMultiplier}x`
    )

    dispatch({
      payload: {
        speedMultiplier,
        totalPoints: session.simulationCoords.length
      },
      type: START_GPS_SIMULATION
    })

    const first = session.simulationCoords[0]
    dispatch(
      handlePositionUpdate(
        createMockPosition(first.coord[0], first.coord[1], first)
      )
    )
    session.simulationPointIndex = 1
    dispatch({
      payload: { pointIndex: session.simulationPointIndex },
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
    // Same normalization beginGoMode applies. This path bypasses beginGoMode,
    // so without it a replay would exercise different code than the live app
    // and the verification scripts would prove nothing.
    dispatch(
      startGoMode({
        itinerary: normalizeGoModeItinerary(fixture.itinerary) as Itinerary,
        originalFrom
      })
    )
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
    if (session.gpsSimulationTimeoutId) {
      clearTimeout(session.gpsSimulationTimeoutId)
      session.gpsSimulationTimeoutId = null
    }
    session.simulationActive = false
    session.simulationPointIndex = 0
    session.simulationCoords = []
    session.simulatedTimeMs = 0
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
    if (session.gpsSimulationTimeoutId) {
      clearTimeout(session.gpsSimulationTimeoutId)
      session.gpsSimulationTimeoutId = null
    }
    session.simulationActive = false

    dispatch({ type: PAUSE_GPS_SIMULATION })
    console.info(
      `[Go Mode] GPS simulation paused at point ${session.simulationPointIndex}/${session.simulationCoords.length}`
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

    if (session.simulationPointIndex >= session.simulationCoords.length) {
      console.warn('[Go Mode] Cannot resume — simulation already complete')
      dispatch({ type: STOP_GPS_SIMULATION })
      return
    }

    simulationSpeedMultiplier = sim.speedMultiplier
    session.simulationActive = true

    dispatch({ type: RESUME_GPS_SIMULATION })

    console.info(
      `[Go Mode] GPS simulation resumed at point ${session.simulationPointIndex}/${session.simulationCoords.length}`
    )

    scheduleNextSimulationPoint(dispatch)
  }
}
