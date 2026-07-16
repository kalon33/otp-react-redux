import { connect } from 'react-redux'
import { IntlShape, useIntl } from 'react-intl'
import { Location, UserLocationAndType } from '@opentripplanner/types'
import EndpointsOverlay from '@opentripplanner/endpoints-overlay'
import React, { ComponentProps, useCallback } from 'react'

import { calculateDistance } from '../../util/go-mode/position-matching'
import { clearLocation } from '../../actions/form'
import { forgetPlace, rememberPlace } from '../../actions/user'
import { getActiveSearch, getShowUserSettings } from '../../util/state'
import { getUserLocations } from '../../util/user'
import { setLocation } from '../../actions/map'
import { setViewedStop } from '../../actions/ui'

// An accidental touch-drag of an endpoint pin (brushing it while scrolling
// the map) must not re-geocode the endpoint — which clears the active search
// and dumps the rider back on the search form. Below this distance a drag is
// treated as a slip, not a decision. (7/13 ride note.)
const DRAG_IGNORE_THRESHOLD_METERS = 30

/**
 * Endpoint marker drags are the only setLocation calls from the overlay that
 * carry reverseGeocode. Ignore a drag when it is too small to be deliberate,
 * or while a Go Mode trip is live — a live trip is never torn down by a map
 * gesture; route changes go through the explicit reroute button. The marker
 * snaps back to the query position on the next render.
 */
export function shouldIgnoreEndpointDrag(
  payload: any,
  goModeActive: boolean,
  anchor: { lat?: number; lon?: number } | null | undefined
): boolean {
  if (!payload?.reverseGeocode) return false
  if (goModeActive) return true
  if (
    anchor?.lat != null &&
    anchor?.lon != null &&
    payload.location?.lat != null &&
    payload.location?.lon != null
  ) {
    return (
      calculateDistance(
        anchor.lat,
        anchor.lon,
        payload.location.lat,
        payload.location.lon
      ) < DRAG_IGNORE_THRESHOLD_METERS
    )
  }
  return false
}

type Props = ComponentProps<typeof EndpointsOverlay> & {
  forgetPlace: (place: string, intl: IntlShape) => void
  goModeActive?: boolean
  rememberPlace: (arg: UserLocationAndType, intl: IntlShape) => void
  setLocation: (payload: any) => void
  setViewedStop: (arg: Location) => void
}

const ConnectedEndpointsOverlay = ({
  forgetPlace,
  goModeActive,
  rememberPlace,
  setLocation,
  setViewedStop,
  ...otherProps
}: Props): JSX.Element => {
  const intl = useIntl()
  const { fromLocation, toLocation } = otherProps
  const _forgetPlace = useCallback(
    (place) => {
      forgetPlace(place, intl)
    },
    [forgetPlace, intl]
  )

  const _rememberPlace = useCallback(
    async (placeTypeLocation) => {
      rememberPlace(placeTypeLocation, intl)
    },
    [rememberPlace, intl]
  )

  const _setLocation = useCallback(
    (payload) => {
      const anchor =
        payload?.locationType === 'from' ? fromLocation : toLocation
      if (shouldIgnoreEndpointDrag(payload, !!goModeActive, anchor)) return
      setLocation(payload)
    },
    [fromLocation, goModeActive, setLocation, toLocation]
  )
  return (
    <EndpointsOverlay
      {...otherProps}
      forgetPlace={_forgetPlace}
      rememberPlace={_rememberPlace}
      setLocation={_setLocation}
      setViewNearby={setViewedStop}
    />
  )
}

// connect to the redux store
// TODO: Add TypeScript to this section.

const mapStateToProps = (state: any) => {
  const { viewedRoute } = state.otp.ui
  // If the route viewer is active, do not show itinerary on map.
  // mainPanelContent is null whenever the trip planner is active.
  // Some views like the stop viewer can be accessed via the trip planner
  // or the route viewer, so include a route being viewed as a condition
  // for hiding
  if (state.otp.ui.mainPanelContent !== null && viewedRoute) {
    return {}
  }

  // Use query from active search (if a search has been made) or default to
  // current query is no search is available.
  const activeSearch: any = getActiveSearch(state)
  const query = activeSearch ? activeSearch.query : state.otp.currentQuery
  const showUserSettings =
    getShowUserSettings(state) ||
    state.otp.config?.map?.forceDisplayEndpointsPopup
  const { from, to } = query
  // Intermediate places doesn't trigger a re-plan, so for now default to
  // current query. FIXME: Determine with TriMet if this is desired behavior.
  const places = state.otp.currentQuery.intermediatePlaces.filter((p: any) => p)

  return {
    fromLocation: from,
    goModeActive: !!state.otp.goMode?.isActive,
    intermediatePlaces: places,
    locations: getUserLocations(state).saved,
    showUserSettings,
    toLocation: to,
    visible: true
  }
}

const mapDispatchToProps = {
  clearLocation,
  forgetPlace,
  rememberPlace,
  setLocation,
  setViewedStop
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(ConnectedEndpointsOverlay)
