import { createAction } from 'redux-actions'
import coreUtils from '@opentripplanner/core-utils'

import { getActiveItineraries } from '../util/state'
import { itineraryIdentityKey } from '../util/itinerary'

import { setUrlSearch } from './api'

export const settingActiveItinerary = createAction('SET_ACTIVE_ITINERARY')

/**
 * The URL carries the chosen trip's POSITION in the results list, and a
 * re-plan renumbers that list: on 2026-09-21 the three returns from the
 * feedback screen each restored `ui_activeItinerary=38`, which by then was a
 * different bus than the one the rider had picked (backlog 23.5). So the trips
 * themselves go in the URL beside the index, and narrative-itineraries reads
 * those back rather than the position.
 *
 * Callers pass either the whole itinerary (a row, a departure chip, a variant)
 * or a bare `{index}` (the URL restore, the back button); the bare form is
 * resolved against the list on screen so the key stays in step with the index.
 */
function activeItineraryKey(state, payload) {
  // A caller that already knows which trip it means says so: the back button
  // carries the key out of the history entry it is restoring.
  if (payload?.key) return payload.key
  if (payload?.legs) return itineraryIdentityKey(payload) || undefined
  const { index } = payload || {}
  // `{index: null}` and `{index: -1}` are the two ways the selection is
  // cleared; neither names a trip, and neither should reach the store.
  if (index === null || index === undefined) return undefined
  const position = Number(index)
  if (!Number.isInteger(position) || position < 0) return undefined
  return (
    itineraryIdentityKey(getActiveItineraries(state)?.[position]) || undefined
  )
}

export function setActiveItinerary(payload) {
  return function (dispatch, getState) {
    // Trigger change in store.
    dispatch(settingActiveItinerary(payload))
    // Update URL params.
    const urlParams = coreUtils.query.getUrlParams()
    urlParams.ui_activeItinerary = payload.index
    urlParams.ui_activeItineraryKey = activeItineraryKey(getState(), payload)
    if (payload.index === -1 || payload.index === '-1') {
      // Remove the ui_itineraryView param if changing to another itinerary.
      // Note: set to undefined instead of deleting so that it merges with the other search params.
      urlParams.ui_itineraryView = undefined
      // Also remove the ui_activeItinerary from URL because that's the default value.
      urlParams.ui_activeItinerary = undefined
      urlParams.ui_activeItineraryKey = undefined
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
