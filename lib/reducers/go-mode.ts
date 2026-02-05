import { handleActions } from 'redux-actions'
import type { Itinerary } from '@opentripplanner/types'

import {
  ADD_NOTIFICATION,
  PAUSE_GPS_SIMULATION,
  RESUME_GPS_SIMULATION,
  SET_NOTIFICATION_CONFIG,
  SET_TRACKING_ERROR,
  START_GO_MODE,
  START_GPS_SIMULATION,
  STOP_GO_MODE,
  STOP_GPS_SIMULATION,
  TOGGLE_MAP_FOLLOW,
  TRANSITION_LEG,
  UPDATE_POSITION,
  UPDATE_PROGRESS,
  UPDATE_ROUTE_MATCH,
  UPDATE_SIMULATION_PROGRESS,
  UPDATE_TRACKING_INTERVAL
} from '../actions/go-mode'
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
  isActive: boolean

  notifications: {
    enabled: boolean
    recentNotifications: NotificationEvent[]
    sentNotifications: string[]
    soundEnabled: boolean
    vibrationEnabled: boolean
  }

  progress: TripProgress | null

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
}

const defaultState: GoModeState = {
  activeItinerary: null,
  isActive: false,

  notifications: {
    enabled: true,
    recentNotifications: [],
    sentNotifications: [],
    soundEnabled: false,
    vibrationEnabled: true
  },

  progress: null,
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

    [SET_NOTIFICATION_CONFIG]: (state, action) => {
      return {
        ...state,
        notifications: {
          ...state.notifications,
          ...action.payload
        }
      }
    },

    [SET_TRACKING_ERROR]: (state, action) => {
      return {
        ...state,
        tracking: {
          ...state.tracking,
          error: action.payload
        }
      }
    },

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
        routeMatch: state.routeMatch
          ? {
              ...state.routeMatch,
              legIndex
            }
          : null
      }
    },

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
    }
  },
  defaultState
)

export default goMode
