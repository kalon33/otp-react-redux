import { handleActions } from 'redux-actions'
import type { Itinerary } from '@opentripplanner/types'

import {
  ADD_NOTIFICATION,
  BEGIN_ONBOARD_FLOW,
  CLEAR_ONBOARD,
  CLEAR_REROUTE,
  CLEAR_VEHICLE_MATCH,
  CONFIRM_VEHICLE,
  DISMISS_BOARDING_PROMPT,
  PAUSE_GPS_SIMULATION,
  RESUME_GPS_SIMULATION,
  SET_DEPARTURE_OVERRIDE,
  SET_NOTIFICATION_CONFIG,
  SET_ONBOARD_RESULT,
  SET_ONBOARD_STATUS,
  SET_ONBOARD_TRIP,
  SET_ONBOARD_VEHICLE,
  SET_REROUTE_RESULT,
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

/** One candidate alight stop whose stop→destination plan is in flight. */
export interface OnboardCandidateSearch {
  busArrivalEpoch: number
  realtime: boolean
  searchId: string
  stopId: string
  stopName: string
}

/** The chosen best stop to get off, with its remaining-journey itinerary. */
export interface OnboardAlightOption {
  busArrivalEpoch: number
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
  bestAlightStop: OnboardAlightOption | null
  candidateSearches: OnboardCandidateSearch[]
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

  boardingPrompt: {
    lastDismissedAt: number | null
    shown: boolean
    transitLegEnteredAt: number | null
  }

  departureOverride: number | null

  isActive: boolean
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
    candidate: Itinerary | null
    searchId: string | null
    status: 'idle' | 'searching' | 'found' | 'none' | 'error'
  }

  routeMatch: RouteMatchResult | null

  simulation: SimulationState

  tracking: {
    error: GeolocationPositionError | null
    interval: number
    isTracking: boolean
    lastPosition: GeolocationPosition | null
  }

  ui: {
    mapFollowUser: boolean
  }

  vehicleMatch: {
    consecutiveMatches: number
    match: VehicleMatchResult | null
    nearbyVehicles: NearbyVehicleOption[]
    trackedRouteId: string | null
  }
}

const defaultState: GoModeState = {
  activeItinerary: null,

  boardingPrompt: {
    lastDismissedAt: null,
    shown: false,
    transitLegEnteredAt: null
  },

  departureOverride: null,

  isActive: false,
  notifications: {
    enabled: true,
    recentNotifications: [],
    sentNotifications: [],
    soundEnabled: false,
    vibrationEnabled: true
  },

  onboard: {
    bestAlightStop: null,
    candidateSearches: [],
    status: 'idle',
    trip: null,
    vehicle: null
  },

  originalFrom: null,

  progress: null,

  reRoute: {
    candidate: null,
    searchId: null,
    status: 'idle'
  },

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
    mapFollowUser: true
  },

  vehicleMatch: {
    consecutiveMatches: 0,
    match: null,
    nearbyVehicles: [],
    trackedRouteId: null
  }
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

      // Keep only last 20 sent notification IDs to prevent memory growth
      if (sentNotifications.length > 20) {
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
      vehicleMatch: { ...defaultState.vehicleMatch }
    }),

    [CLEAR_ONBOARD]: (state) => ({
      ...state,
      onboard: { ...defaultState.onboard }
    }),

    [CLEAR_REROUTE]: (state) => ({
      ...state,
      reRoute: { ...defaultState.reRoute }
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

    [SET_DEPARTURE_OVERRIDE]: (state, action) => ({
      ...state,
      departureOverride: action.payload
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

    [SET_ONBOARD_RESULT]: (state, action) => ({
      ...state,
      onboard: {
        ...state.onboard,
        bestAlightStop: action.payload || null,
        status: action.payload ? ('ready' as const) : ('error' as const)
      }
    }),

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

    [SET_REROUTE_RESULT]: (state, action) => ({
      ...state,
      reRoute: {
        ...state.reRoute,
        candidate: action.payload || null,
        status: action.payload ? ('found' as const) : ('none' as const)
      }
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

      return {
        ...state,
        activeItinerary: itinerary,
        isActive: true,
        notifications: {
          ...state.notifications,
          recentNotifications: [],
          sentNotifications: []
        },
        originalFrom: originalFrom ?? null,
        progress: null,
        reRoute: { ...defaultState.reRoute },
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
        bestAlightStop: null,
        candidateSearches: action.payload.candidateSearches,
        status: 'optimizing' as const
      }
    }),

    [START_REROUTE]: (state, action) => ({
      ...state,
      reRoute: {
        candidate: null,
        searchId: action.payload.searchId,
        status: 'searching' as const
      }
    }),

    [STOP_GO_MODE]: () => ({
      ...defaultState
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

      return {
        ...state,
        departureOverride: null,
        routeMatch: state.routeMatch
          ? {
              ...state.routeMatch,
              legIndex
            }
          : null
      }
    },

    [UPDATE_NEARBY_VEHICLES]: (state, action) => ({
      ...state,
      vehicleMatch: {
        ...state.vehicleMatch,
        nearbyVehicles: action.payload
      }
    }),

    [UPDATE_POSITION]: (state, action) => {
      return {
        ...state,
        tracking: {
          ...state.tracking,
          error: null,
          lastPosition: action.payload
        }
      }
    },

    [UPDATE_PROGRESS]: (state, action) => {
      return {
        ...state,
        progress: action.payload
      }
    },

    [UPDATE_ROUTE_MATCH]: (state, action) => {
      return {
        ...state,
        routeMatch: action.payload
      }
    },

    [UPDATE_SIMULATION_PROGRESS]: (state, action) => ({
      ...state,
      simulation: {
        ...state.simulation,
        pointIndex: action.payload.pointIndex
      }
    }),

    [UPDATE_TRACKING_INTERVAL]: (state, action) => {
      const { interval } = action.payload

      return {
        ...state,
        tracking: {
          ...state.tracking,
          interval
        }
      }
    },

    [UPDATE_VEHICLE_MATCH]: (state, action) => ({
      ...state,
      vehicleMatch: {
        ...state.vehicleMatch,
        consecutiveMatches: action.payload.consecutiveMatches,
        match: action.payload.match
      }
    })
  },
  defaultState
)

export default goMode
