/* eslint-disable react/prop-types */
import { Briefcase } from '@styled-icons/fa-solid/Briefcase'
import { Clock } from '@styled-icons/fa-regular/Clock'
import { connect } from 'react-redux'
import { Home } from '@styled-icons/fa-solid/Home'
import { injectIntl } from 'react-intl'
import { MapMarker } from '@styled-icons/fa-solid/MapMarker'
import React from 'react'

import * as locationActions from '../../actions/location'
import { findNearbyStops } from '../../actions/apiV2'
import {
  getActiveSearch,
  getShowUserSettings,
  hasValidLocation
} from '../../util/state'
import { getUserLocations } from '../../util/user'
import { isBlank } from '../../util/ui'
import { isSameRecentPlace } from '../../util/recent-places'
import { StyledIconWrapper } from '../util/styledIcon'

/**
 * Custom icon component that renders based on the user location icon prop.
 */
const UserLocationIcon = ({ userLocation }) => {
  const { icon = 'marker', type } = userLocation
  // Places from localStorage that are assigned the 'work' icon
  // should be rendered as 'briefcase'. State holds Work as 'briefcase'
  // (convertToPlace), so accept both. Recent places get a clock (backlog
  // 60.2) so they read apart from the saved places above them.
  let FinalIcon = MapMarker
  if (icon === 'work' || icon === 'briefcase' || type === 'work') {
    FinalIcon = Briefcase
  } else if (icon === 'home' || type === 'home') FinalIcon = Home
  else if (type === 'recent' || icon === 'clock-o') FinalIcon = Clock

  return (
    <StyledIconWrapper>
      <FinalIcon />
    </StyledIconWrapper>
  )
}

/**
 * This higher-order component connects the target (styled) LocationField to the
 * redux store.
 * @param StyledLocationField The input LocationField component to connect.
 * @param options Optional object with the following optional props (see defaults in code):
 *                - actions: a list of actions to include in mapDispatchToProps
 *                - excludeSavedLocations: whether to not render user-saved locations
 *                - includeLocation: whether to derive the location prop from
 *                  the active query
 * @returns The connected component.
 */
export default function connectLocationField(
  StyledLocationField,
  options = {}
) {
  // By default, set actions to empty list and do not include location.
  const {
    actions = {},
    excludeSavedLocations = false,
    includeLocation = false
  } = options
  // eslint-disable-next-line complexity
  const mapStateToProps = (state, ownProps) => {
    const { config, currentQuery, location, transitIndex } = state.otp
    const { currentPosition, nearbyStops, sessionSearches } = location
    const activeSearch = getActiveSearch(state)
    const query = activeSearch ? activeSearch.query : currentQuery

    const isValid =
      !ownProps.selfValidate ||
      (includeLocation
        ? hasValidLocation(query, ownProps.locationType)
        : !isBlank(ownProps.location?.name))

    // Display saved locations and recent places according to the configured persistence strategy,
    // unless displaying user locations is disabled via prop (e.g. in the saved-place editor
    // when the loggedInUser defines their saved locations).
    let userSavedLocations = []
    let recentPlaces = []
    if (!excludeSavedLocations) {
      const userLocations = getUserLocations(state)
      userSavedLocations = userLocations.saved
      recentPlaces = userLocations.recent
    }

    const geocoderConfig = config.geocoder
    if (geocoderConfig) {
      if (query.to && query.to?.lat && query.to?.lon) {
        const { lat, lon } = query.to
        geocoderConfig.focusPoint = { lat, lon }
      }
      if (query.from && query.from?.lat && query.from?.lon) {
        const { lat, lon } = query.from
        geocoderConfig.focusPoint = { lat, lon }
      }
      if (currentPosition?.coords) {
        const { latitude: lat, longitude: lon } = currentPosition.coords
        geocoderConfig.focusPoint = { lat, lon }
      }
    }

    // Backlog 60.2: the dropdown shows saved and recent places as two
    // sections, so a "Recently searched" entry that is already one of the
    // recents would show twice — drop it (same rule as the recents' own dedupe).
    const showUserSettings = getShowUserSettings(state)
    const visibleSessionSearches =
      showUserSettings && recentPlaces.length > 0
        ? sessionSearches.filter(
            (search) =>
              !recentPlaces.some((recent) => isSameRecentPlace(recent, search))
          )
        : sessionSearches

    const stateToProps = {
      currentPosition,
      geocoderConfig,
      geocoderResultsOrder: config.geocoder?.geocoderResultsOrder,
      isValid,
      layerColorMap: config.geocoder?.resultsColors || {},
      nearbyStops,
      outputMetricUnits: config.units !== 'imperial',
      sessionSearches: visibleSessionSearches,
      showUserSettings,
      stopsIndex: transitIndex.stops,
      suggestionCount: config.geocoder?.resultsCount,
      UserLocationIconComponent: UserLocationIcon,
      // Two lists, two headers: "Saved places" (Home, Work, custom) above
      // "Recent" (backlog 60.2). The single upstream list stays for anything
      // that reads it.
      userLocationsAndRecentPlaces: [...userSavedLocations, ...recentPlaces],
      userRecentPlaces: recentPlaces,
      userSavedPlaces: userSavedLocations
    }
    // Set the location prop only if includeLocation is specified, else leave unset.
    // Otherwise, the StyledLocationField component will use the fixed undefined/null value as location
    // and will not respond to user input.
    if (includeLocation) {
      stateToProps.location = query[ownProps.locationType]
    }

    return stateToProps
  }

  const mapDispatchToProps = {
    addLocationSearch: locationActions.addLocationSearch,
    findNearbyStops,
    getCurrentPosition: locationActions.getCurrentPosition,
    ...actions
  }

  return connect(
    mapStateToProps,
    mapDispatchToProps
  )(injectIntl(StyledLocationField))
}
