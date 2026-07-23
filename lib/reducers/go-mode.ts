import { handleActions } from 'redux-actions'
import type { Itinerary } from '@opentripplanner/types'

import {
  ADD_NOTIFICATION,
  BEGIN_ONBOARD_FLOW,
  CLEAR_ONBOARD,
  CLEAR_REROUTE,
  CLEAR_RIDING,
  CLEAR_VEHICLE_MATCH,
  CONFIRM_VEHICLE,
  DISMISS_BOARDING_PROMPT,
  PAUSE_GPS_SIMULATION,
  RESUME_GPS_SIMULATION,
  SET_ARRIVED,
  SET_DEPARTURE_OVERRIDE,
  SET_GO_MODE_ACTIVE_LEG,
  SET_GO_MODE_BACKGROUNDED,
  SET_LIVE_LEG_TIMES,
  SET_NOTIFICATION_CONFIG,
  SET_ONBOARD_RESULT,
  SET_ONBOARD_STATUS,
  SET_ONBOARD_TRIP,
  SET_ONBOARD_VEHICLE,
  SET_REROUTE_RESULT,
  SET_RIDING,
  SET_TRACKING_ERROR,
  SET_TRANSIT_LEG_ENTERED,
  SHOW_BOARDING_PROMPT,
  START_GO_MODE,
  START_GPS_SIMULATION,
  START_ONBOARD_OPTIMIZE,
  START_REROUTE,
  STOP_GO_MODE,
  STOP_GPS_SIMULATION,
  TOGGLE_MAP_FOLLOW,
  TRANSITION_LEG,
  UPDATE_NEARBY_VEHICLES,
  UPDATE_POSITION,
  UPDATE_PROGRESS,
  UPDATE_ROUTE_MATCH,
  UPDATE_SIMULATION_PROGRESS,
  UPDATE_TRACKING_INTERVAL,
  UPDATE_VEHICLE_MATCH
} from '../actions/go-mode'
import type { LiveLegTime, RidingState } from '../actions/go-mode'
import type {
  NearbyVehicleOption,
  VehicleMatchResult
} from '../util/go-mode/vehicle-matching'
import type { NotificationEvent } from '../util/go-mode/notification-service'
import type { RouteMatchResult } from '../util/go-mode/position-matching'
import type { TripProgress } from '../util/go-mode/progress-calculator'

export interface SimulationState {
  pointIndex: number
  speedMultiplier: number
  status: 'idle' | 'running' | 'paused'
  totalPoints: number
}

/** The live vehicle the rider confirmed they are already aboard. */
export interface OnboardVehicle {
  label: string | null
  nextStopId: string | null
  routeId: string | null
  tripId: string | null
  vehicleId: string
}

/** One candidate alight stop being evaluated by the onboard optimizer. */
export interface OnboardCandidate {
  busArrivalEpoch: number
  realtime: boolean
  stopId: string
  stopName: string
}

/** The chosen best stop to get off, with its remaining-journey itinerary. */
export interface OnboardAlightOption {
  busArrivalEpoch: number
  /** The full trip a tap starts: current-bus leg + onward legs. What the
   * results list renders, so the display matches the outcome exactly. */
  displayItinerary?: Itinerary
  /** The onward plan from the alight stop (ranking input). */
  itinerary: Itinerary
  realtime: boolean
  stopId: string
  stopName: string
}

/**
 * "I'm already on the bus" flow: discover the live vehicle the rider is on,
 * fetch its schedule, and find the best stop to alight to finish the trip.
 * Distinct from reRoute (a mid-trip swap of an already-active itinerary).
 */
export interface OnboardState {
  alightOptions: OnboardAlightOption[]
  bestAlightStop: OnboardAlightOption | null
  candidates: OnboardCandidate[]
  status:
    | 'idle'
    | 'discovering'
    | 'awaiting-selection'
    | 'fetching-schedule'
    | 'optimizing'
    | 'ready'
    | 'error'
  trip: any | null
  vehicle: OnboardVehicle | null
}

export interface GoModeState {
  activeItinerary: Itinerary | null

  /** Epoch ms when trip progress first read completed; null while en route.
   * While set, position ticks quiesce and the arrival card is shown. */
  arrivedAt: number | null

  boardingPrompt: {
    lastDismissedAt: number | null
    shown: boolean
    transitLegEnteredAt: number | null
  }

  departureOverride: number | null

  isActive: boolean

  /** Live (or schedule-fallback) transit-leg times, keyed by leg index. Kept
   * fresh mid-ride by refreshLiveLegTimes; consumed by the trip overview. */
  liveLegTimes: Record<number, LiveLegTime>

  notifications: {
    enabled: boolean
    recentNotifications: NotificationEvent[]
    sentNotifications: string[]
    soundEnabled: boolean
    vibrationEnabled: boolean
  }

  onboard: OnboardState

  /**
   * The trip origin captured when Go Mode began. A mid-trip re-route replaces
   * currentQuery.from with the rider's GPS position ("Current location"); this
   * lets endGoMode restore the origin the rider started with on exit.
   */
  originalFrom: any

  progress: TripProgress | null

  reRoute: {
    // Apply the best result without asking (definitive missed bus) instead of
    // surfacing the Switch/Keep card.
    autoApply: boolean
    // The single best candidate (kept for callers that only need one).
    candidate: Itinerary | null
    // All browsable alternatives, shortest-duration first.
    candidates: Itinerary[]
    // Auto-apply may only pick itineraries boarding this route — the one the
    // rider already chose. Null = no constraint (manual re-routes).
    keepRouteId: string | null
    // What prompted the re-route (e.g. 'missed-bus'); diagnostic only.
    reason: string | null
    searchId: string | null
    // Wall-clock start of the in-flight search — lets the position tick
    // declare a 'searching' that never settled (WebView suspension) stuck.
    startedAtMs: number | null
    status: 'idle' | 'searching' | 'found' | 'none' | 'error'
  }

  /**
   * The durable "rider is aboard this vehicle" fact (see RidingState in
   * actions/go-mode). Survives new searches and itinerary switches; cleared
   * on alight, STOP_GO_MODE, or sustained off-route.
   */
  riding: RidingState | null

  routeMatch: RouteMatchResult | null

  simulation: SimulationState

  tracking: {
    error: GeolocationPositionError | null
    interval: number
    isTracking: boolean
    lastPosition: GeolocationPosition | null
  }

  ui: {
    /**
     * Index of the leg the rider tapped in the trip sheet, or null for none.
     * The Go Mode equivalent of the planner's activeSearch.activeLeg: the map
     * zooms to it and draws it as selected.
     */
    activeLeg: number | null
    /**
     * The trip is running but the rider has stepped out to the normal trip
     * planner (browsing alternate routes). Tracking, notifications, and
     * auto-updates all keep running; only what's on screen changes. The
     * ReturnToTripBanner is the way back.
     */
    backgrounded: boolean
    mapFollowUser: boolean
  }

  vehicleMatch: {
    consecutiveMatches: number
    /**
     * Consecutive vehicle-position polls that came back with ZERO vehicles on
     * the tracked route. Some agencies publish no GTFS-RT vehicle feed at all
     * (or theirs is down), in which case a match can never happen and an
     * endless "Locating your bus…" reads as a hung app. Past
     * NO_LIVE_VEHICLE_POLLS the UI says so instead.
     */
    emptyPolls: number
    match: VehicleMatchResult | null
    nearbyVehicles: NearbyVehicleOption[]
    trackedRouteId: string | null
  }
}

const defaultState: GoModeState = {
  activeItinerary: null,

  arrivedAt: null,

  boardingPrompt: {
    lastDismissedAt: null,
    shown: false,
    transitLegEnteredAt: null
  },

  departureOverride: null,

  isActive: false,
  liveLegTimes: {},
  notifications: {
    enabled: true,
    recentNotifications: [],
    sentNotifications: [],
    soundEnabled: false,
    vibrationEnabled: true
  },

  onboard: {
    alightOptions: [],
    bestAlightStop: null,
    candidates: [],
    status: 'idle',
    trip: null,
    vehicle: null
  },

  originalFrom: null,

  progress: null,

  reRoute: {
    autoApply: false,
    candidate: null,
    candidates: [],
    keepRouteId: null,
    reason: null,
    searchId: null,
    startedAtMs: null,
    status: 'idle'
  },

  riding: null,

  routeMatch: null,

  simulation: {
    pointIndex: 0,
    speedMultiplier: 1,
    status: 'idle',
    totalPoints: 0
  },

  tracking: {
    error: null,
    interval: 8000,
    isTracking: false,
    lastPosition: null
  },

  ui: {
    activeLeg: null,
    backgrounded: false,
    // Off by default: the map should stay where the user leaves it and only
    // recenter on the live GPS point when the user asks (blue dot control).
    mapFollowUser: false
  },

  vehicleMatch: {
    consecutiveMatches: 0,
    emptyPolls: 0,
    match: null,
    nearbyVehicles: [],
    trackedRouteId: null
  }
}

/** Route id from a leg — OTP2 object form (leg.route.id) or legacy leg.routeId. */
function legRouteId(leg: any): string | null {
  if (!leg) return null
  const route = leg.route
  if (route && typeof route === 'object') return route.id ?? null
  return leg.routeId ?? null
}

/**
 * Re-anchor the sticky riding fact onto a (possibly new) itinerary: find the
 * transit leg matching the boarded trip (preferred) or route. When the new
 * itinerary doesn't contain it, keep the fact un-anchored (legIndex -1) —
 * the rider is still on that bus until GPS disproves it.
 */
function reanchorRiding(
  riding: RidingState | null,
  itinerary: Itinerary | null
): RidingState | null {
  if (!riding || !itinerary?.legs) return riding
  const legs: any[] = itinerary.legs
  let legIndex = -1
  if (riding.tripId) {
    legIndex = legs.findIndex(
      (l) =>
        l?.transitLeg &&
        (l.trip?.gtfsId === riding.tripId || l.tripId === riding.tripId)
    )
  }
  if (legIndex < 0 && riding.routeId) {
    legIndex = legs.findIndex(
      (l) => l?.transitLeg && legRouteId(l) === riding.routeId
    )
  }
  return { ...riding, legIndex }
}

const goMode = handleActions<GoModeState, any>(
  {
    [ADD_NOTIFICATION]: (state, action) => {
      const notification: NotificationEvent = action.payload

      // Add to sent notifications to prevent duplicates
      const sentNotifications = [
        ...state.notifications.sentNotifications,
        notification.id
      ]

      // Keep only last 50 sent notification IDs to prevent memory growth. The
      // window must be wide enough that a chatty type (e.g. route deviation)
      // cannot evict one-shot ids like TRIP_COMPLETE within their dedup window.
      if (sentNotifications.length > 50) {
        sentNotifications.shift()
      }

      // Add to recent notifications (keep last 10)
      const recentNotifications = [
        notification,
        ...state.notifications.recentNotifications
      ].slice(0, 10)

      return {
        ...state,
        notifications: {
          ...state.notifications,
          recentNotifications,
          sentNotifications
        }
      }
    },

    [BEGIN_ONBOARD_FLOW]: (state, action) => ({
      ...state,
      activeItinerary: null,
      boardingPrompt: { ...defaultState.boardingPrompt },
      isActive: true,
      onboard: {
        ...defaultState.onboard,
        status: 'discovering' as const
      },
      originalFrom: action.payload?.originalFrom ?? null,
      progress: null,
      reRoute: { ...defaultState.reRoute },
      routeMatch: null,
      tracking: {
        ...state.tracking,
        error: null,
        isTracking: true
      },
      // Keep a confirmed vehicle: re-entering the onboard flow must not make
      // the app forget which bus it already verified the rider is on.
      vehicleMatch:
        state.vehicleMatch.match?.confidence === 'confirmed'
          ? state.vehicleMatch
          : { ...defaultState.vehicleMatch }
    }),

    [CLEAR_ONBOARD]: (state) => ({
      ...state,
      onboard: { ...defaultState.onboard }
    }),

    [CLEAR_REROUTE]: (state) => ({
      ...state,
      reRoute: { ...defaultState.reRoute }
    }),

    [CLEAR_RIDING]: (state) => ({
      ...state,
      riding: null
    }),

    [CLEAR_VEHICLE_MATCH]: (state) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        shown: false,
        transitLegEnteredAt: null
      },
      vehicleMatch: {
        ...defaultState.vehicleMatch
      }
    }),

    [CONFIRM_VEHICLE]: (state, action) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        shown: false
      },
      vehicleMatch: {
        ...state.vehicleMatch,
        consecutiveMatches: 0,
        match: action.payload
      }
    }),

    [DISMISS_BOARDING_PROMPT]: (state) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        lastDismissedAt: Date.now(),
        shown: false
      }
    }),

    [PAUSE_GPS_SIMULATION]: (state) => ({
      ...state,
      simulation: {
        ...state.simulation,
        status: 'paused' as const
      }
    }),

    [RESUME_GPS_SIMULATION]: (state) => ({
      ...state,
      simulation: {
        ...state.simulation,
        status: 'running' as const
      }
    }),

    [SET_ARRIVED]: (state, action) => ({
      ...state,
      arrivedAt: action.payload
    }),

    [SET_DEPARTURE_OVERRIDE]: (state, action) => ({
      ...state,
      departureOverride: action.payload
    }),

    [SET_GO_MODE_ACTIVE_LEG]: (state, action) => ({
      ...state,
      ui: {
        ...state.ui,
        activeLeg: action.payload ?? null
      }
    }),

    [SET_GO_MODE_BACKGROUNDED]: (state, action) => ({
      ...state,
      ui: {
        ...state.ui,
        backgrounded: !!action.payload
      }
    }),

    [SET_LIVE_LEG_TIMES]: (state, action) => ({
      ...state,
      liveLegTimes: action.payload
    }),

    [SET_NOTIFICATION_CONFIG]: (state, action) => {
      return {
        ...state,
        notifications: {
          ...state.notifications,
          ...action.payload
        }
      }
    },

    [SET_ONBOARD_RESULT]: (state, action) => {
      const options: OnboardAlightOption[] = action.payload || []
      return {
        ...state,
        onboard: {
          ...state.onboard,
          alightOptions: options,
          bestAlightStop: options[0] || null,
          status: options.length ? ('ready' as const) : ('error' as const)
        }
      }
    },

    [SET_ONBOARD_STATUS]: (state, action) => ({
      ...state,
      onboard: {
        ...state.onboard,
        status: action.payload
      }
    }),

    [SET_ONBOARD_TRIP]: (state, action) => ({
      ...state,
      onboard: {
        ...state.onboard,
        trip: action.payload
      }
    }),

    [SET_ONBOARD_VEHICLE]: (state, action) => ({
      ...state,
      onboard: {
        ...state.onboard,
        status: 'fetching-schedule' as const,
        vehicle: action.payload
      }
    }),

    [SET_REROUTE_RESULT]: (state, action) => {
      // Payload is the full list of alternatives (or null/[] for "none").
      const candidates: Itinerary[] = Array.isArray(action.payload)
        ? action.payload
        : action.payload
        ? [action.payload]
        : []
      return {
        ...state,
        reRoute: {
          ...state.reRoute,
          // Results resolved into a card (or "none") — the auto-apply moment,
          // if there was one, has passed.
          autoApply: false,
          candidate: candidates[0] ?? null,
          candidates,
          status: candidates.length > 0 ? ('found' as const) : ('none' as const)
        }
      }
    },

    [SET_RIDING]: (state, action) => ({
      ...state,
      riding: action.payload
    }),

    [SET_TRACKING_ERROR]: (state, action) => {
      return {
        ...state,
        tracking: {
          ...state.tracking,
          error: action.payload
        }
      }
    },

    [SET_TRANSIT_LEG_ENTERED]: (state, action) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        transitLegEnteredAt: action.payload
      }
    }),

    [SHOW_BOARDING_PROMPT]: (state) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        shown: true
      }
    }),

    [START_GO_MODE]: (state, action) => {
      const { itinerary, originalFrom } = action.payload

      // `ui` is deliberately preserved: a background auto-update (missed bus,
      // quiet access replan) swaps the itinerary via this action while the
      // rider may be browsing the planner — that must not clear
      // ui.backgrounded and yank them back to the Go Mode screen.
      return {
        ...state,
        activeItinerary: itinerary,
        arrivedAt: null,
        isActive: true,
        liveLegTimes: {},
        notifications: {
          ...state.notifications,
          recentNotifications: [],
          // Alight alerts are keyed to the physical exit STOP, and they alone
          // survive a trip swap: a background auto-update re-enters here with a
          // new itinerary, and wiping their history let the same stop buzz the
          // rider a second time — the complaint this whole path exists to fix.
          // Everything else (boarding, connections, turns) is about the trip
          // that just changed and must be free to fire again.
          sentNotifications: state.notifications.sentNotifications.filter(
            (id) =>
              id.startsWith('APPROACH_STOP_') || id.startsWith('ARRIVING_STOP_')
          )
        },
        originalFrom: originalFrom ?? null,
        progress: null,
        reRoute: { ...defaultState.reRoute },
        riding: reanchorRiding(state.riding, itinerary),
        routeMatch: null,
        tracking: {
          ...state.tracking,
          error: null,
          isTracking: true
        }
      }
    },

    [START_GPS_SIMULATION]: (state, action) => ({
      ...state,
      simulation: {
        pointIndex: 0,
        speedMultiplier: action.payload.speedMultiplier,
        status: 'running' as const,
        totalPoints: action.payload.totalPoints
      }
    }),

    [START_ONBOARD_OPTIMIZE]: (state, action) => ({
      ...state,
      onboard: {
        ...state.onboard,
        alightOptions: [],
        bestAlightStop: null,
        candidates: action.payload.candidates,
        status: 'optimizing' as const
      }
    }),

    [START_REROUTE]: (state, action) => ({
      ...state,
      reRoute: {
        autoApply: !!action.payload.autoApply,
        candidate: null,
        candidates: [],
        keepRouteId: action.payload.keepRouteId ?? null,
        reason: action.payload.reason ?? null,
        searchId: action.payload.searchId,
        startedAtMs: action.payload.startedAtMs ?? null,
        status: 'searching' as const
      }
    }),

    [STOP_GO_MODE]: (state) => ({
      ...defaultState,
      // Being aboard a bus is a physical fact; exiting the Go Mode screen
      // doesn't change it. On 7/12 the rider backed out and immediately
      // reopened "I'm on the bus" — with riding wiped here, the flow forgot
      // the confirmed vehicle and re-ran (failing) discovery. Alight and
      // sustained off-route remain the only physical invalidators.
      riding: state.riding,
      vehicleMatch:
        state.vehicleMatch.match?.confidence === 'confirmed'
          ? state.vehicleMatch
          : { ...defaultState.vehicleMatch }
    }),

    [STOP_GPS_SIMULATION]: (state) => ({
      ...state,
      simulation: {
        pointIndex: 0,
        speedMultiplier: 1,
        status: 'idle' as const,
        totalPoints: 0
      }
    }),

    [TOGGLE_MAP_FOLLOW]: (state) => {
      return {
        ...state,
        ui: {
          ...state.ui,
          mapFollowUser: !state.ui.mapFollowUser
        }
      }
    },

    [TRANSITION_LEG]: (state, action) => {
      const { legIndex } = action.payload

      // Advancing past the boarded transit leg means the rider alighted —
      // drop the sticky riding fact.
      const alighted =
        state.riding != null &&
        state.riding.legIndex >= 0 &&
        legIndex > state.riding.legIndex

      return {
        ...state,
        departureOverride: null,
        riding: alighted ? null : state.riding,
        routeMatch: state.routeMatch
          ? {
              ...state.routeMatch,
              legIndex
            }
          : null
      }
    },

    [UPDATE_NEARBY_VEHICLES]: (state: GoModeState, action: any) => ({
      ...state,
      vehicleMatch: {
        ...state.vehicleMatch,
        nearbyVehicles: action.payload
      }
    }),

    [UPDATE_POSITION]: (state: GoModeState, action: any) => {
      return {
        ...state,
        tracking: {
          ...state.tracking,
          error: null,
          lastPosition: action.payload
        }
      }
    },

    [UPDATE_PROGRESS]: (state: GoModeState, action: any) => {
      return {
        ...state,
        progress: action.payload
      }
    },

    [UPDATE_ROUTE_MATCH]: (state: GoModeState, action: any) => {
      return {
        ...state,
        routeMatch: action.payload
      }
    },

    [UPDATE_SIMULATION_PROGRESS]: (state: GoModeState, action: any) => ({
      ...state,
      simulation: {
        ...state.simulation,
        pointIndex: action.payload.pointIndex
      }
    }),

    [UPDATE_TRACKING_INTERVAL]: (state: GoModeState, action: any) => {
      const { interval } = action.payload

      return {
        ...state,
        tracking: {
          ...state.tracking,
          interval
        }
      }
    },

    // Payload keys are optional so the "no vehicles on this route" poll can
    // bump emptyPolls alone without clobbering the last real match.
    [UPDATE_VEHICLE_MATCH]: (state: GoModeState, action: any) => ({
      ...state,
      vehicleMatch: {
        ...state.vehicleMatch,
        ...(action.payload.consecutiveMatches !== undefined && {
          consecutiveMatches: action.payload.consecutiveMatches
        }),
        ...(action.payload.emptyPolls !== undefined && {
          emptyPolls: action.payload.emptyPolls
        }),
        ...(action.payload.match !== undefined && {
          match: action.payload.match
        })
      }
    })
  },
  defaultState
)

export default goMode
