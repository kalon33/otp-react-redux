import { handleActions } from 'redux-actions'

import {
  CLEAR_RETURN_PLAN,
  SELECT_RETURN_ITINERARY,
  SET_RETURN_PLAN
} from '../actions/round-trip'
import type { ReturnPlanState, RoundTripState } from '../actions/round-trip'

/**
 * `state.otp.roundTrip` — the return options planned under the outbound
 * itinerary the rider is looking at. One plan at a time: the panel only ever
 * asks about the itinerary that is expanded, and keeping a map of them would
 * only make it possible to show a stale one.
 */

/**
 * A new outbound search invalidates the return: the plan on screen was for an
 * itinerary that is about to be replaced. Handled here (rather than by the
 * panel re-fetching) so the stale list never renders for even a tick.
 */
const ROUTING_REQUEST = 'ROUTING_REQUEST'

export const defaultState: RoundTripState = { returnPlan: null }

const roundTrip = handleActions<RoundTripState, any>(
  {
    [CLEAR_RETURN_PLAN]: () => ({ returnPlan: null }),

    [ROUTING_REQUEST]: () => ({ returnPlan: null }),

    [SELECT_RETURN_ITINERARY]: (state: RoundTripState, action: any) => {
      const { returnPlan } = state
      if (!returnPlan) return state
      const index = Number(action.payload)
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= returnPlan.itineraries.length
      ) {
        return state
      }
      return { returnPlan: { ...returnPlan, selectedIndex: index } }
    },

    [SET_RETURN_PLAN]: (state: RoundTripState, action: any) => ({
      returnPlan: action.payload as ReturnPlanState
    })
  },
  defaultState
)

export default roundTrip
