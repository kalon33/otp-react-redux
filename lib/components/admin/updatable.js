import { Button } from 'react-bootstrap'
import PropTypes from 'prop-types'
import React, { Component } from 'react'

import { Val } from './styled'

export default class Updatable extends Component {
  static propTypes = {
    fieldName: PropTypes.string.isRequired,
    label: PropTypes.string,
    onUpdate: PropTypes.func.isRequired,
    value: PropTypes.string.isRequired
  }

  _onClick = () => {
    const { fieldName, onUpdate, value } = this.props
    const newValue = window.prompt(
      `Please input new value for ${fieldName}:`,
      value
    )
    if (newValue !== null) onUpdate(newValue)
  }

  render() {
    const { fieldName, label, value } = this.props
    return (
      <>
        {label || fieldName}: <Val>{value}</Val>
        <Button bsSize="xsmall" bsStyle="link" onClick={this._onClick}>
          Update
        </Button>
      </>
    )
  }
}
