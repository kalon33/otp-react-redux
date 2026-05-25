import { handleActions } from 'redux-actions'
import type { Itinerary } from '@opentripplanner/types'

import {
  ADD_NOTIFICATION,
  CLEAR_REROUTE,
  CLEAR_VEHICLE_MATCH,
  CONFIRM_VEHICLE,
  DISMISS_BOARDING_PROMPT,
  PAUSE_GPS_SIMULATION,
  RESUME_GPS_SIMULATION,
  SET_DEPARTURE_OVERRIDE,
  SET_NOTIFICATION_CONFIG,
  SET_REROUTE_RESULT,
  SET_TRACKING_ERROR,
  SET_TRANSIT_LEG_ENTERED,
  SHOW_BOARDING_PROMPT,
  START_GO_MODE,
  START_GPS_SIMULATION,
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
      const { itinerary } = action.payload

      return {
        ...state,
        activeItinerary: itinerary,
        isActive: true,
        notifications: {
          ...state.notifications,
          recentNotifications: [],
          sentNotifications: []
        },
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
