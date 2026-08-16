import { connect } from 'react-redux'
import { injectIntl, IntlShape } from 'react-intl'
import TransitiveCanvasOverlay from '@opentripplanner/transitive-overlay'

import { AppReduxState } from '../../util/state-types'
import { getActiveLeg, getTransitiveData } from '../../util/state'
import { GoModeState } from '../../reducers/go-mode'
import { TransitiveConfig } from '../../util/config-types'

type Props = TransitiveConfig & IntlShape

/**
 * Whether the planner's transitive (itinerary paths) overlay should be hidden
 * because the rider is on the Go Mode screen: GoModeMap wraps DefaultMap,
 * which always mounts this overlay, so the LAST planner search kept drawing
 * as a stale ghost under the live trip (7/29 ride). While the trip is
 * backgrounded (browsing the planner mid-trip) the overlay shows the
 * planner's own current search and must keep rendering. Exported for unit
 * tests (mirrors shouldIgnoreEndpointDrag). Note: if a future layout mounted
 * the planner map and Go Mode simultaneously this would hide the planner's
 * overlay too — acceptable for this single-rider mobile app.
 */
export function hidePlannerItineraryOverlay(
  goMode: GoModeState | null | undefined
): boolean {
  return !!goMode?.isActive && !goMode?.ui?.backgrounded
}

// connect to the redux store
const mapStateToProps = (state: AppReduxState, ownProps: Props) => {
  const { labeledModes, styles } = state.otp.config.map.transitive || {}
  const { viewedRoute } = state.otp.ui

  // If the route viewer is active, do not show itinerary on map.
  // mainPanelContent is null whenever the trip planner is active.
  // Some views like the stop viewer can be accessed via the trip planner
  // or the route viewer, so include a route being viewed as a condition
  // for hiding
  if (state.otp.ui.mainPanelContent !== null && viewedRoute) {
    return {}
  }

  // On the Go Mode screen the planner's paths are a stale ghost — hide them.
  if (hidePlannerItineraryOverlay(state.otp.goMode)) {
    return {}
  }

  return {
    activeLeg: getActiveLeg(state),
    labeledModes,
    styles,
    // @ts-expect-error typescript is confused by the complex redux reducer. Both params are needed
    transitiveData: getTransitiveData(state, ownProps)
  }
}

// @ts-expect-error state.js being typescripted will fix this error
export default injectIntl(connect(mapStateToProps)(TransitiveCanvasOverlay))
