import { ArrowLeft } from '@styled-icons/fa-solid/ArrowLeft'
import { FormattedMessage } from 'react-intl'
import PropTypes from 'prop-types'
import React from 'react'
import styled from 'styled-components'

import ErrorMessage from '../form/error-message'

import EditSearchButton from './edit-search-button'

/**
 * The no-results card (mobile overhaul, 2026-10-26): ErrorMessage's header,
 * message and "Trip tools" buttons on one token card, and Back to search as
 * the primary pill under it. ErrorMessage and TripTools keep their markup;
 * this only dresses them.
 */
const ErrorCard = styled.div`
  background-color: var(--tn-surface);
  border-radius: var(--tn-radius);
  box-shadow: var(--tn-shadow);
  color: var(--tn-text);
  margin: var(--tn-space-3);
  padding: var(--tn-space-4);

  && .error-message {
    margin: 0;
  }
  && .error-message > .header {
    border: 0;
    color: var(--tn-text);
    font: var(--tn-type-lg);
    margin: 0 0 var(--tn-space-1);
    padding: 0;
  }
  && .error-message > .header svg {
    color: var(--tn-danger);
    height: 20px;
    width: 20px;
  }
  && .error-message > .message {
    color: var(--tn-text-2);
    font: var(--tn-type-sm);
  }
  && .trip-tools-container {
    background: transparent;
    border-radius: 0;
    margin: var(--tn-space-3) 0 0;
    padding: 0;
  }
  && .trip-tools-container h2 {
    color: var(--tn-text-2);
    font: var(--tn-type-xs);
    letter-spacing: var(--tn-tracking-xs);
    margin: 0 0 var(--tn-space-2);
    text-transform: uppercase;
  }
  && .trip-tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--tn-space-2);
    margin: 0;
    text-align: start;
  }
  && .trip-tools .button-container {
    padding: 0;
  }
  && .trip-tools .tool-button {
    border-radius: var(--tn-radius-pill);
    font: 500 14px/18px var(--tn-font);
    min-height: var(--tn-tap);
    min-width: 0;
    padding: 0 var(--tn-space-4);
  }
`

const BackToSearch = styled.div`
  padding: 0 var(--tn-space-3) calc(var(--tn-space-3) + var(--tn-safe-bottom));
`

/**
 * This component is used on mobile views to
 * render an error message if no results are found.
 */
const ResultsError = ({ className, error }) => (
  <div className={`results-error-message ${className}`}>
    <ErrorCard>
      <ErrorMessage error={error} />
    </ErrorCard>
    <BackToSearch className="mobile-padding">
      <EditSearchButton $block className="back-to-search-button">
        <ArrowLeft aria-hidden />
        <FormattedMessage id="components.ResultsError.backToSearch" />
      </EditSearchButton>
    </BackToSearch>
  </div>
)

ResultsError.propTypes = {
  className: PropTypes.string,
  error: PropTypes.object
}

const StyledResultsError = styled(ResultsError)`
  background-color: var(--tn-bg);
  overflow-y: auto;
  top: 300px;
`

export default StyledResultsError
