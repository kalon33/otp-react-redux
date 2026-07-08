import { connect } from 'react-redux'
import { FormattedMessage } from 'react-intl'
import PropTypes from 'prop-types'
import React from 'react'
import styled from 'styled-components'

import { getTimeFormat } from '../../util/time'

const TripStatusContainer = styled.div`
  display: flex;
  flex-direction: column;
  margin: 10px 0;
`

const StatusText = styled.div`
  font-size: 1.2em;
  font-weight: ${(props) => (props.saveable ? 'bold' : 'normal')};;
`

function TripStatus({ currentQuery, saveable, status, timeFormat }) {
  if (!status) {
    return (
      <TripStatusContainer>
        <StatusText>
          <FormattedMessage id="components.TripStatus.notPlanned" />
        </StatusText>
      </TripStatusContainer>
    )
  }

  const { arrivalTime, departureTime } = status

  return (
    <TripStatusContainer>
      <StatusText saveable={saveable}>
        <FormattedMessage
          id="components.TripStatus.planned"
          values={{
            arrivalTime: arrivalTime && formatTime(arrivalTime, timeFormat),
            departureTime:
              departureTime && formatTime(departureTime, timeFormat)
          }}
        />
      </StatusText>
    </TripStatusContainer>
  )
}

function formatTime(time, timeFormat) {
  const date = new Date(time)
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const ampm = hours >= 12 ? 'pm' : 'am'
  const displayHours = hours % 12
  const displayHoursStr = displayHours === 0 ? '12' : displayHours
  const displayMinutesStr = minutes < 10 ? `0${minutes}` : minutes

  if (timeFormat === '24') {
    return `${hours}:${displayMinutesStr}`
  } else {
    return `${displayHoursStr}:${displayMinutesStr} ${ampm}`
  }
}

TripStatus.propTypes = {
  currentQuery: PropTypes.object,
  saveable: PropTypes.bool,
  status: PropTypes.object,
  timeFormat: PropTypes.string
}

const mapStateToProps = (state, ownProps) => {
  const { outbound, request } = ownProps
  // Check if callTaker exists before accessing its properties
  const callTaker = state.callTaker
  const saveable = callTaker?.fieldTrip?.saveable
  return {
    currentQuery: state.otp.currentQuery,
    saveable: outbound ? saveable?.outbound : saveable?.inbound,
    status: outbound ? request.outboundTripStatus : request.inboundTripStatus,
    timeFormat: getTimeFormat(state.otp.config)
  }
}

export default connect(mapStateToProps)(TripStatus)
