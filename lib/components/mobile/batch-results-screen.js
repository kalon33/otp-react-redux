/* eslint-disable react/prop-types */
import { ArrowsAlt } from '@styled-icons/fa-solid/ArrowsAlt'
import { connect } from 'react-redux'
import { FormattedMessage } from 'react-intl'
import { ListUl } from '@styled-icons/fa-solid/ListUl'
import { useMap } from 'react-map-gl/maplibre'
import coreUtils from '@opentripplanner/core-utils'
import React, { useEffect } from 'react'
import styled, { css } from 'styled-components'

import * as formActions from '../../actions/form'
import * as uiActions from '../../actions/ui'
import {
  getActiveItineraries,
  getActiveSearch,
  getResponsesWithErrors
} from '../../util/state'
import { getItineraryView, ItineraryView } from '../../util/ui'
import Map from '../map/map'
import NarrativeItineraries from '../narrative/narrative-itineraries'

import MobileContainer from './container'
import ResultsError from './results-error'
import ResultsHeader, { RESULTS_HEADER_HEIGHT } from './results-header'

const StyledMobileContainer = styled(MobileContainer)`
  .options > .header {
    margin: 10px;
  }

  &.otp.mobile .mobile-narrative-container {
    background-color: var(--tn-bg);
    bottom: 0;
    left: 0;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 0;
    position: fixed;
    right: 0;
  }
`

/** Where the map and the list start: the app bar, then the summary strip. */
const RESULTS_TOP = `calc(${
  50 + RESULTS_HEADER_HEIGHT
}px + var(--return-to-trip-banner-height, 0px))`

/**
 * "Expand map" / "Show results": a floating surface pill with its icon,
 * bottom-left over the map, clear of the home indicator when the map runs to
 * the bottom of the screen.
 */
const ExpandMapButton = styled.button`
  align-items: center;
  background-color: var(--tn-surface);
  border: 0;
  border-radius: var(--tn-radius-pill);
  /* Above the map's attribution line, which runs along the bottom edge. */
  bottom: ${(props) =>
    props.$expanded ? 'calc(34px + var(--tn-safe-bottom))' : '34px'};
  box-shadow: var(--tn-shadow);
  color: var(--tn-text);
  cursor: pointer;
  display: inline-flex;
  font: 600 14px/18px var(--tn-font);
  gap: var(--tn-space-2);
  left: var(--tn-space-3);
  min-height: var(--tn-tap);
  padding: 0 var(--tn-space-4);
  position: absolute;
  z-index: 999999;

  svg {
    color: var(--tn-accent);
    flex: none;
    height: 16px;
    width: 16px;
  }
  &:active {
    background-color: var(--tn-surface-2);
  }
  &:focus-visible {
    outline: 2px solid var(--tn-accent);
    outline-offset: 2px;
  }
`

const NARRATIVE_SPLIT_TOP_PERCENT = 45

// Styles for the results map also include prop-independent styles copied from mobile.css.
const ResultsMap = styled.div`
  bottom: ${(props) =>
    props.expanded ? '0' : `${100 - NARRATIVE_SPLIT_TOP_PERCENT}%`};
  display: ${(props) => (props.visible ? 'inherit' : 'none')};
  left: 0;
  position: fixed;
  right: 0;
  top: ${RESULTS_TOP};
`

const narrativeCss = css`
  top: ${(props) =>
    props.visible
      ? props.expanded
        ? RESULTS_TOP
        : `${NARRATIVE_SPLIT_TOP_PERCENT}%`
      : '100%'};
  transition: top 300ms;
`

const StyledResultsError = styled(ResultsError)`
  display: ${(props) => (props.visible ? 'inherit' : 'none')};
  ${narrativeCss}
`

const NarrativeContainer = styled.div`
  ${narrativeCss}
`

/**
 * This component renders the mobile view of itinerary results from batch routing,
 * and features a split view between the map and itinerary results or narratives.
 */
const BatchMobileResultsScreen = ({
  errors,
  itineraries,
  itineraryView,
  refreshStaleSearch,
  toggleBatchResultsMap
}) => {
  const hasErrorsAndNoResult = itineraries.length === 0 && errors.length > 0
  const mapExpanded =
    itineraryView === ItineraryView.LEG_HIDDEN ||
    itineraryView === ItineraryView.LIST_HIDDEN
  const itineraryExpanded = itineraryView === ItineraryView.FULL

  const { default: map } = useMap()
  // Trigger map resize when the map expanded variable changes.
  useEffect(() => {
    if (map) map.resize()
  }, [mapExpanded, map])

  // A leave-now result set left sitting (locked phone, long dwell) goes stale:
  // once every displayed departure has passed, auto re-plan instead of making
  // the rider notice and re-search by hand. Checked when the app returns to
  // the foreground and on a slow tick while the screen stays open.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible') refreshStaleSearch()
    }
    document.addEventListener('visibilitychange', check)
    const intervalId = setInterval(check, 60000)
    return () => {
      document.removeEventListener('visibilitychange', check)
      clearInterval(intervalId)
    }
  }, [refreshStaleSearch])

  return (
    <StyledMobileContainer>
      <ResultsHeader />
      <ResultsMap expanded={mapExpanded} visible={!itineraryExpanded}>
        <Map />
        <ExpandMapButton
          $expanded={mapExpanded}
          className="expand-map-button"
          onClick={toggleBatchResultsMap}
          type="button"
        >
          {mapExpanded ? <ListUl aria-hidden /> : <ArrowsAlt aria-hidden />}
          {mapExpanded ? (
            <FormattedMessage id="components.BatchResultsScreen.showResults" />
          ) : (
            <FormattedMessage id="components.BatchResultsScreen.expandMap" />
          )}
        </ExpandMapButton>
      </ResultsMap>
      {hasErrorsAndNoResult ? (
        <StyledResultsError
          error={errors[0]}
          expanded={itineraryExpanded}
          visible={!mapExpanded}
        />
      ) : (
        <NarrativeContainer
          className="mobile-narrative-container"
          expanded={itineraryExpanded}
          visible={!mapExpanded}
        >
          <NarrativeItineraries />
        </NarrativeContainer>
      )}
    </StyledMobileContainer>
  )
}

// connect to the redux store

const mapStateToProps = (state) => {
  const activeSearch = getActiveSearch(state)
  const urlParams = coreUtils.query.getUrlParams()
  return {
    activeLeg: activeSearch ? activeSearch.activeLeg : null,
    errors: getResponsesWithErrors(state),
    itineraries: getActiveItineraries(state),
    itineraryView: getItineraryView(urlParams) || state.otp.ui.itineraryView
  }
}

const mapDispatchToProps = {
  refreshStaleSearch: formActions.refreshStaleSearch,
  toggleBatchResultsMap: uiActions.toggleBatchResultsMap
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(BatchMobileResultsScreen)
