import PropTypes from 'prop-types'
import React, { Component } from 'react'

export default class MobileContainer extends Component {
  render() {
    const { children, className } = this.props
    return (
      <div className={`otp mobile${className ? ` ${className}` : ''}`}>
        {children}
      </div>
    )
  }
}

MobileContainer.propTypes = {
  children: PropTypes.node,
  className: PropTypes.string
}
