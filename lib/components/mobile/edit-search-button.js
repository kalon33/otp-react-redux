/* eslint-disable react/prop-types */
import { connect } from 'react-redux'
import React from 'react'

import * as uiActions from '../../actions/ui'
import { TnButton } from '../util/tn-styled'

/**
 * Renders the "Edit" or "Back to search" button in mobile result views
 * that takes the user back to the mobile search screen. A TransitNav pill
 * (tn-styled TnButton): pass `$variant` / `$size` / `$block` through.
 */
const EditSearchButton = ({ showMobileSearchScreen, ...props }) => (
  <TnButton onClick={showMobileSearchScreen} type="button" {...props} />
)

// connect to the redux store
const mapDispatchToProps = {
  showMobileSearchScreen: uiActions.showMobileSearchScreen
}

export default connect(null, mapDispatchToProps)(EditSearchButton)
