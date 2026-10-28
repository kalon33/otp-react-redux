import { connect } from 'react-redux'
import { decodeQueryParams } from 'use-query-params'
import { FormattedMessage, injectIntl } from 'react-intl'
import { toDate } from 'date-fns-tz'
import PropTypes from 'prop-types'
import React, { Component } from 'react'
import styled from 'styled-components'

import {
  getActiveItineraries,
  getActiveSearch,
  getResponsesWithErrors
} from '../../util/state'
import { getFormattedMode } from '../../util/i18n'
import { modesQueryParamConfig } from '../form/util'
import FormattedTimePreview from '../util/formatted-date-time-preview'

import EditSearchButton from './edit-search-button'
import MobileNavigationBar from './navigation-bar'

/**
 * Height of the summary strip under the app bar. The results map and list
 * (batch-results-screen.js) start below 50 px + this + the return banner.
 */
export const RESULTS_HEADER_HEIGHT = 64

// The from/to summary and the Edit button. Offset by the live-trip return
// banner's height (return-to-trip-banner.tsx) — on 2026-09-08 the banner sat
// on top of this strip and the rider could not reach the Edit button while a
// trip was backgrounded.
const LocationSummaryContainer = styled.div`
  background-color: var(--tn-bg);
  box-sizing: border-box;
  height: ${RESULTS_HEADER_HEIGHT}px;
  left: 0;
  padding: var(--tn-space-2) var(--tn-space-3);
  position: fixed;
  right: 0;
  top: calc(50px + var(--return-to-trip-banner-height, 0px));
`

/** One compact card: "A → B" over "Leave now · Transit, Bike", and Edit. */
const SummaryCard = styled.div`
  align-items: center;
  background-color: var(--tn-surface);
  border-radius: var(--tn-radius);
  box-shadow: var(--tn-shadow);
  box-sizing: border-box;
  color: var(--tn-text);
  display: flex;
  gap: var(--tn-space-2);
  height: 100%;
  padding: 0 var(--tn-space-1) 0 var(--tn-space-4);
`

const SummaryText = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
`

const Places = styled.div`
  align-items: baseline;
  display: flex;
  font: 600 16px/20px var(--tn-font);
  gap: 6px;
  min-width: 0;

  .place {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .arrow {
    color: var(--tn-text-3);
    flex: none;
    font-weight: 400;
  }
`

const When = styled.div`
  color: var(--tn-text-2);
  font: var(--tn-type-sm);
  font-variant-numeric: var(--tn-tabular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

/** The place's name up to its first comma: "Union Depot", not the address. */
function placeLabel(place) {
  const name = place?.name || ''
  return name.split(',')[0].trim() || name
}

/**
 * This component renders the results header and an error message
 * if no itinerary was found.
 */
class ResultsHeader extends Component {
  static propTypes = {
    enabledModeButtons: PropTypes.array,
    errors: PropTypes.array,
    intl: PropTypes.object,
    query: PropTypes.object,
    resultCount: PropTypes.number,
    timeZone: PropTypes.string
  }

  render() {
    const { enabledModeButtons, intl, query, timeZone } = this.props
    const headerText = intl.formatMessage({
      id: 'components.BatchSearchScreen.header'
    })
    const from = placeLabel(query.from)
    const to = placeLabel(query.to)
    const timestamp =
      query.date && query.time
        ? toDate(`${query.date} ${query.time}`, { timeZone }).valueOf()
        : NaN
    const modes = intl.formatList(
      (enabledModeButtons || []).map((key) => getFormattedMode(key, intl)),
      { style: 'short', type: 'unit' }
    )

    return (
      <>
        <MobileNavigationBar headerText={headerText} />

        <LocationSummaryContainer className="locations-summary">
          <SummaryCard>
            <SummaryText>
              <Places
                title={[query.from?.name, query.to?.name]
                  .filter(Boolean)
                  .join(' → ')}
              >
                <span className="place">{from}</span>
                <span aria-hidden className="arrow">
                  →
                </span>
                <span className="place">{to}</span>
              </Places>
              <When>
                {query.departArrive === 'NOW' || !isNaN(timestamp) ? (
                  <FormattedTimePreview
                    departArrive={query.departArrive}
                    time={timestamp}
                  />
                ) : null}
                {modes ? ` · ${modes}` : null}
              </When>
            </SummaryText>
            <EditSearchButton
              $size="sm"
              $variant="ghost"
              className="edit-search-button"
            >
              <FormattedMessage id="common.forms.edit" />
            </EditSearchButton>
          </SummaryCard>
        </LocationSummaryContainer>
      </>
    )
  }
}

// connect to the redux store

const mapStateToProps = (state) => {
  const activeSearch = getActiveSearch(state)
  const response = activeSearch?.response
  const urlSearchParams = new URLSearchParams(state.router?.location?.search)
  const { homeTimezone, modes } = state.otp.config

  const itineraries = getActiveItineraries(state)
  return {
    // The mode buttons the search ran with, as the form reads them
    // (batch-settings.tsx).
    enabledModeButtons:
      decodeQueryParams(modesQueryParamConfig, {
        modeButtons: urlSearchParams.get('modeButtons')
      })?.modeButtons ||
      modes?.initialState?.enabledModeButtons ||
      [],
    errors: getResponsesWithErrors(state),
    query: state.otp.currentQuery,
    resultCount: response ? itineraries.length : null,
    timeZone: homeTimezone
  }
}

export default connect(mapStateToProps)(injectIntl(ResultsHeader))
