import { handleActions } from 'redux-actions'
import type { Itinerary } from '@opentripplanner/types'

import {
  ADD_NOTIFICATION,
  SET_NOTIFICATION_CONFIG,
  SET_TRACKING_ERROR,
  START_GO_MODE,
  STOP_GO_MODE,
  TOGGLE_MAP_FOLLOW,
  TRANSITION_LEG,
  UPDATE_POSITION,
  UPDATE_PROGRESS,
  UPDATE_ROUTE_MATCH,
  UPDATE_TRACKING_INTERVAL
} from '../actions/go-mode'
import type { NotificationEvent } from '../util/go-mode/notification-service'
import type { RouteMatchResult } from '../util/go-mode/position-matching'
import type { TripProgress } from '../util/go-mode/progress-calculator'

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

  tracking: {
    error: GeolocationPositionError | null
    interval: number
    isTracking: boolean
    lastPosition: GeolocationPosition | null
    trackingId?: number
  }

  ui: {
    mapFollowUser: boolean
    showDetailedView: boolean
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

  tracking: {
    error: null,
    interval: 8000,
    isTracking: false,
    lastPosition: null
  },

  ui: {
    mapFollowUser: true,
    showDetailedView: false
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

    [STOP_GO_MODE]: (state) => {
      // Clean up interval if exists
      if (typeof window !== 'undefined') {
        const intervalId = (window as any).__goModeIntervalId
        if (intervalId) {
          clearInterval(intervalId)
          delete (window as any).__goModeIntervalId
        }
      }

      return {
        ...defaultState
      }
    },

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
