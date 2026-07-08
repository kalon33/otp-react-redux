import { randId } from '@opentripplanner/core-utils/lib/storage'
import update from 'immutability-helper'

import { compareEndTimes } from '../util/call-taker'
import { FETCH_STATUS } from '../util/constants'
import { getISOLikeTimestamp } from '../util/state'
import { getModuleConfig, Modules } from '../util/config'

function getCalltakerConfig(config) {
  return getModuleConfig({ otp: { config } }, Modules.CALL_TAKER)
}

function createCallTakerReducer(config) {
  const calltakerConfig = getCalltakerConfig(config)
  
  // Define initial state - this will be used even if calltaker is not enabled
  // to ensure state.callTaker is always defined
  const initialState = {
    activeCall: null,
    callHistory: {
      calls: {
        data: [],
        status: FETCH_STATUS.UNFETCHED
      },
      visible: false
    },
    fieldTrip: {
      activeId: null,
      filter: {
        tab: 'new'
      },
      groupSize: null,
      requests: {
        data: [],
        status: FETCH_STATUS.UNFETCHED
      },
      travelDateTripsInUse: [],
      tripHashLookup: {},
      visible: false
    },
    mailables: {
      visible: false
    },
    session: null
  }

  if (!calltakerConfig) {
    // Return a dummy reducer that just returns the initial state
    // This ensures state.callTaker is always defined
    return (state = initialState) => state
  }

  // eslint-disable-next-line complexity
  return (state = {
    ...initialState,
    callHistory: {
      ...initialState.callHistory,
      visible: calltakerConfig?.options?.showCallHistoryOnLoad
    }
  }, action) => {
    switch (action.type) {
      case 'BEGIN_CALL': {
        const newCall = {
          id: randId(),
          searches: [],
          startTime: getISOLikeTimestamp(config.homeTimezone)
        }
        // Initialize new call and show call history window.
        return update(state, {
          activeCall: { $set: newCall },
          callHistory: { visible: { $set: true } }
        })
      }
      case 'REQUESTING_CALLS': {
        return update(state, {
          callHistory: { calls: { status: { $set: FETCH_STATUS.FETCHING } } }
        })
      }
      case 'RECEIVED_CALLS': {
        const data = action.payload.calls
        const calls = {
          data: data.sort(compareEndTimes),
          status: FETCH_STATUS.FETCHED
        }
        return update(state, {
          callHistory: { calls: { $set: calls } }
        })
      }
      case 'REQUESTING_FIELD_TRIPS': {
        return update(state, {
          fieldTrip: { requests: { status: { $set: FETCH_STATUS.FETCHING } } }
        })
      }
      case 'RECEIVED_FIELD_TRIPS': {
        const data = action.payload.fieldTrips
        const requests = {
          data: data.sort(compareEndTimes),
          status: FETCH_STATUS.FETCHED
        }
        return update(state, {
          fieldTrip: { requests: { $set: requests } }
        })
      }
      case 'SET_FIELD_TRIP_FILTER': {
        return update(state, {
          fieldTrip: { filter: { $merge: action.payload } }
        })
      }
      case 'SET_GROUP_SIZE': {
        return update(state, {
          fieldTrip: { groupSize: { $set: action.payload } }
        })
      }
      case 'SET_ACTIVE_FIELD_TRIP': {
        return update(state, {
          fieldTrip: {
            activeId: { $set: action.payload },
            groupSize: { $set: null }
          }
        })
      }
      case 'TOGGLE_FIELD_TRIPS': {
        return update(state, {
          fieldTrip: { visible: { $set: !state.fieldTrip.visible } }
        })
      }
      case 'TOGGLE_CALL_HISTORY': {
        return update(state, {
          callHistory: { visible: { $set: !state.callHistory.visible } }
        })
      }
      case 'TOGGLE_MAILABLES': {
        return update(state, {
          mailables: { visible: { $set: !state.mailables.visible } }
        })
      }
      case 'RESET_AND_TOGGLE_CALL_HISTORY': {
        return update(state, {
          callHistory: {
            calls: { $set: initialState.callHistory.calls },
            visible: { $set: !state.callHistory.visible }
          }
        })
      }
      case 'END_CALL': {
        return update(state, {
          activeCall: { $set: null }
        })
      }
      case 'RECEIVED_SESSION': {
        const { session } = action.payload
        return update(state, {
          session: { $set: session }
        })
      }
      case 'BEGIN_CALL_IF_NEEDED': {
        // No state change, handled in middleware
        return state
      }
      case 'FETCH_CALLS': {
        // No state change, handled in middleware
        return state
      }
      case 'FETCH_FIELD_TRIPS': {
        // No state change, handled in middleware
        return state
      }
      case 'SAVE_CALL': {
        // No state change, handled in middleware
        return state
      }
      case 'SAVE_FIELD_TRIP_ITINERARIES': {
        const { hash, requestId, tripData } = action.payload
        return update(state, {
          fieldTrip: {
            tripHashLookup: { [requestId]: { $set: hash } },
            travelDateTripsInUse: { $push: [tripData] }
          }
        })
      }
      case 'REMOVE_SAVED_FIELD_TRIP_ITINERARIES': {
        const { requestId } = action.payload
        return update(state, {
          fieldTrip: {
            tripHashLookup: { $unset: [requestId] },
            travelDateTripsInUse: {
              $set: state.fieldTrip.travelDateTripsInUse.filter(
                (t) => t.requestId !== requestId
              )
            }
          }
        })
      }
      case 'SET_SAVEABLE_FIELD_TRIP': {
        const { requestId, saveable } = action.payload
        return update(state, {
          fieldTrip: {
            saveable: { $set: { ...state.fieldTrip.saveable, [requestId]: saveable } }
          }
        })
      }
      default:
        return state
    }
  }
}

export default createCallTakerReducer
