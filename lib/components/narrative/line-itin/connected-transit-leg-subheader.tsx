import { connect } from 'react-redux'
import { Leg } from '@opentripplanner/types'
import React, { Component } from 'react'
import TransitLegSubheader from '@opentripplanner/itinerary-body/lib/otp-react-redux/transit-leg-subheader'

import { SetViewedStopHandler } from '../../util/types'
import { viewStopFromItinerary } from '../../../actions/ui'

interface Props {
  leg: Leg
  viewStopFromItinerary: SetViewedStopHandler
}

class ConnectedTransitLegSubheader extends Component<Props> {
  // Where this lands depends on whether a trip is running — see
  // actions/ui#viewStopFromItinerary. Mid-trip it opens inside the Go Mode
  // layer; otherwise it is the nearby view, exactly as before.
  onClick: SetViewedStopHandler = (payload) => {
    this.props.viewStopFromItinerary(payload)
  }

  render() {
    const { leg } = this.props
    return <TransitLegSubheader leg={leg} onStopClick={this.onClick} />
  }
}

const mapDispatchToProps = {
  viewStopFromItinerary
}

export default connect(null, mapDispatchToProps)(ConnectedTransitLegSubheader)
