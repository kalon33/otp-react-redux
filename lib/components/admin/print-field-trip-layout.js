import { ArrowLeft } from '@styled-icons/fa-solid/ArrowLeft'
import { connect } from 'react-redux'
import { FormattedMessage, useIntl } from 'react-intl'
import PropTypes from 'prop-types'
import React, { useEffect } from 'react'
import styled from 'styled-components'

import * as callTakerActions from '../../actions/call-taker'
import * as fieldTripActions from '../../actions/field-trip'
import { getItineraryLegs } from '../../util/itinerary'
import { getTripFromRequest } from '../../util/call-taker'
import { printableItinerary } from './printable-itinerary'

const PrintContainer = styled.div`
  display: flex;
  flex-direction: column;
  padding: 20px;
  @media print {
    .no-print {
      display: none;
    }
  }
`

const BackButton = styled.div`
  cursor: pointer;
  display: flex;
  margin-bottom: 20px;
`

const PrintableItineraryContainer = styled.div`
  page-break-after: always;
`

const PrintFieldTripLayout = ({ config, request, requestId, session }) => {
  const intl = useIntl()

  useEffect(() => {
    // If there's no request, the component should not render
    if (!request) return
    window.print()
  }, [request])

  if (!request) {
    return (
      <PrintContainer>
        <BackButton
          className="no-print"
          onClick={() => {
            window.history.back()
          }}
        >
          <ArrowLeft size={20} />
          <FormattedMessage id="components.PrintFieldTripLayout.back" />
        </BackButton>
        <FormattedMessage id="components.PrintFieldTripLayout.noRequest" />
      </PrintContainer>
    )
  }

  const outboundTrip = getTripFromRequest(request, true)
  const inboundTrip = getTripFromRequest(request, false)

  return (
    <PrintContainer>
      <BackButton
        className="no-print"
        onClick={() => {
          window.history.back()
        }}
      >
        <ArrowLeft size={20} />
        <FormattedMessage id="components.PrintFieldTripLayout.back" />
      </BackButton>
      <PrintableItineraryContainer>
        {printableItinerary(outboundTrip, request, config, intl, session)}
      </PrintableItineraryContainer>
      <PrintableItineraryContainer>
        {printableItinerary(inboundTrip, request, config, intl, session)}
      </PrintableItineraryContainer>
    </PrintContainer>
  )
}

PrintFieldTripLayout.propTypes = {
  config: PropTypes.object,
  request: PropTypes.object,
  requestId: PropTypes.number,
  session: PropTypes.object
}

// connect to the redux store

const mapStateToProps = (state, ownProps) => {
  const requestId = parseInt(state.router.location.query.requestId)
  // Check if callTaker exists before accessing its properties
  const callTaker = state.callTaker
  if (!callTaker) {
    return {
      config: state.otp.config,
      request: null,
      requestId,
      session: null
    }
  }
  
  const { requests } = callTaker.fieldTrip || {}
  const request = requests?.data?.find((req) => req.id === requestId)
  return {
    config: state.otp.config,
    request,
    requestId,
    session: callTaker.session
  }
}

const mapDispatchToProps = {
  fetchFieldTripDetails: fieldTripActions.fetchFieldTripDetails,
  initializeModules: callTakerActions.initializeModules,
  receivedFieldTrips: fieldTripActions.receivedFieldTrips
}

export default connect(mapStateToProps, mapDispatchToProps)(PrintFieldTripLayout)
