import { createAction } from 'redux-actions'
import coreUtils from '@opentripplanner/core-utils'

import { setUrlSearch } from './api'

export const settingActiveItinerary = createAction('SET_ACTIVE_ITINERARY')

export function setActiveItinerary(payload) {
  return function (dispatch, getState) {
    // Trigger change in store.
    dispatch(settingActiveItinerary(payload))
    // Update URL params.
    const urlParams = coreUtils.query.getUrlParams()
    urlParams.ui_activeItinerary = payload.index
    if (payload.index === -1 || payload.index === '-1') {
      // Remove the ui_itineraryView param if changing to another itinerary.
      // Note: set to undefined instead of deleting so that it merges with the other search params.
      urlParams.ui_itineraryView = undefined
      // Also remove the ui_activeItinerary from URL because that's the default value.
      urlParams.ui_activeItinerary = undefined
    }

    dispatch(setUrlSearch(urlParams))
  }
}

export const setActiveLeg = createAction('SET_ACTIVE_LEG')
export const setActiveStep = createAction('SET_ACTIVE_STEP')
// Set itinerary visible on map. This is used for mouse over effects with
// itineraries in the list.
export const setVisibleItinerary = createAction('SET_VISIBLE_ITINERARY')
export const updateItineraryFilter = createAction('UPDATE_ITINERARY_FILTER')

/**
 * Recording only, like REROUTE_SNAPSHOT / ONBOARD_CANDIDATE_SNAPSHOT in
 * actions/go-mode: no reducer consumes it. It exists so the debug stream says
 * which result rows carried a same-shape-variants control and how many
 * itineraries folded into each.
 *
 * Backlog 16.6 could not be settled from the 2026-09-15 stream because the
 * only evidence of what was on screen was ROUTING_RESPONSE, and all twelve of
 * those between 09:23 and 09:31 were logged as `__summary: true` (the payload
 * size cap) — so "was the link even there?" was unanswerable. This payload is
 * a handful of integers, well under MAX_PAYLOAD_CHARS, and is therefore kept
 * in full.
 */
export const logItineraryVariantRows = createAction('ITINERARY_VARIANT_ROWS')
