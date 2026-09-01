import FromToLocationPicker from '@opentripplanner/from-to-location-picker'
import PropTypes from 'prop-types'
import React, { Component } from 'react'

export default class SetFromToButtons extends Component {
  static propTypes = {
    location: PropTypes.object.isRequired,
    map: PropTypes.object.isRequired,
    setLocation: PropTypes.func.isRequired
  }

  _setLocation = (type) => {
    this.props.setLocation({
      location: this.props.location,
      reverseGeocode: false,
      type
    })
    this.props.map.closePopup()
  }

  _setFromClicked = () => {
    this._setLocation('from')
  }

  _setToClicked = () => {
    this._setLocation('to')
  }

  render() {
    return (
      <FromToLocationPicker
        onFromClick={this._setFromClicked}
        onToClick={this._setToClicked}
      />
    )
  }
}
