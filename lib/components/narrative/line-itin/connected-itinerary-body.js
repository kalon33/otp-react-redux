/* eslint-disable react/prop-types */
// TODO: Typescript (otp-rr config object)
import {
  AgencyInfo,
  LegBody,
  LegClickable,
  LegDescription,
  LegDescriptionHeadsignPrefix,
  LineColumn,
  PlaceDetails,
  PlaceHeader,
  PlaceName as PlaceNameWrapper,
  PlaceRowWrapper,
  PlaceSubheader,
  StopMarker,
  StopName,
  StopRow,
  TimeColumn,
  TransitLegDetails,
  TransitLegDetailsHeader,
  TransitLegSummary as TransitLegSummaryButton,
  ViewerButton
} from '@opentripplanner/itinerary-body/lib/styled'
import { connect } from 'react-redux'
import { PlaceName } from '@opentripplanner/itinerary-body/lib/otp-react-redux'
import { useIntl } from 'react-intl'
import clone from 'clone'
import isEqual from 'lodash.isequal'
import ItineraryBody from '@opentripplanner/itinerary-body/lib/otp-react-redux/itinerary-body'
import React, { Component } from 'react'

// NOTE: The FaresV2Table2 component from @opentripplanner/itinerary-body generates a warning:
// "Warning: validateDOMNesting(...): <tr> cannot appear as a child of <table>."
// This is because FaresV2Table2 renders <tr> elements directly inside a <table> without a <tbody>.
// This warning is harmless and comes from the external package, not our code.
// To fix this properly, a PR should be created in @opentripplanner/itinerary-body to wrap <tr> in <tbody>.
import { formatPlaceName } from '../../../util/format-place-name'
import RouteDescription from '@opentripplanner/itinerary-body/lib/otp-react-redux/route-description'
import styled from 'styled-components'

import { ComponentContext } from '../../../util/contexts'
import { formatDuration } from '../../../components/util/formatted-duration'
import { MainPanelContent } from '../../../actions/ui-constants'
import { markTransfers } from '../../../util/transfer-times'
import { setLegDiagram, setMapillaryId } from '../../../actions/map'
import { setMainPanelContent, setViewedTrip } from '../../../actions/ui'
import TripDetails from '../connected-trip-details'
import TripTools from '../trip-tools'

import LegFrequencyFooter from './leg-frequency-footer'
import LegIconWithA11y from './LegIconWithA11y'
import LineColumnContent from './line-column-content'
import RealtimeTimeColumn from './realtime-time-column'
import TransitLegSubheader from './connected-transit-leg-subheader'
import TransitLegSummary from './transit-leg-summary'

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {}

const ItineraryBodyContainer = styled.div`
  padding: 0px 10px;

  /* TODO: Find a better way of doing this */
  table {
    font-size: 14px;
  }

  /* Phone layout (mobile overhaul, 2026-10-26): the body sits on a surface
     sheet, the Trip Details summary is a surface-2 inset block and the trip
     tools a row of secondary pills. Also rendered in Go Mode's trip sheet. */
  .tn-mobile & {
    background-color: var(--tn-surface);
    color: var(--tn-text);
    font-family: var(--tn-font);
    padding: var(--tn-space-2) var(--tn-space-4) var(--tn-space-4);
  }

  .tn-mobile & .trip-details {
    background-color: var(--tn-surface-2);
    border: 0;
    border-radius: var(--tn-radius);
    box-shadow: none;
    color: var(--tn-text);
    margin: var(--tn-space-4) 0 0;
    padding: var(--tn-space-4);

    h2,
    #trip-details-header {
      color: var(--tn-text-2);
      font: var(--tn-type-xs);
      letter-spacing: var(--tn-tracking-xs);
      margin: 0 0 var(--tn-space-3);
      text-transform: uppercase;
    }
    [role='group'] {
      align-items: flex-start;
      font: var(--tn-type-sm);
      gap: var(--tn-space-3);
      margin-top: var(--tn-space-3);
    }
    [role='group'] svg {
      color: var(--tn-text-2);
    }
    strong {
      font-variant-numeric: var(--tn-tabular);
      font-weight: 600;
    }
    table {
      background: transparent;
      color: var(--tn-text);
    }
    table th,
    table td {
      background: transparent !important;
      border-color: var(--tn-border);
      font-weight: 500;
      padding: 2px var(--tn-space-2) 2px 0;
    }
    button {
      color: var(--tn-accent);
    }
    /* "Show details" (?) toggle: 44px target around the 16px icon. */
    button[aria-controls] {
      align-items: center;
      display: inline-flex;
      justify-content: center;
      margin: -14px -12px;
      min-height: var(--tn-tap);
      min-width: var(--tn-tap);
    }
  }

  .tn-mobile & .trip-tools-container {
    background: transparent;
    margin: var(--tn-space-4) 0 0;
    padding: 0;

    h2 {
      color: var(--tn-text-2);
      font: var(--tn-type-xs);
      letter-spacing: var(--tn-tracking-xs);
      margin: 0 0 var(--tn-space-2);
      text-transform: uppercase;
    }
    .trip-tools {
      align-items: stretch;
      display: flex;
      flex-wrap: wrap;
      gap: var(--tn-space-2);
      justify-content: flex-start;
    }
    .button-container {
      /* min-width stays auto: a pill wraps to the next line rather than
         squeezing its label past the edge (360px). */
      flex: 1 1 96px;
      margin: 0;
      width: auto;
    }
    /* Copy Link's wrapper also holds an empty aria-live span: keep it from
       adding a line box above the button. */
    .button-container > div {
      display: flex;
      flex-direction: column;
    }
    .tool-button {
      align-items: center;
      background-color: var(--tn-surface-2);
      border: 0;
      border-radius: var(--tn-radius-pill);
      box-shadow: none;
      color: var(--tn-text);
      display: flex;
      font: 600 14px/18px var(--tn-font);
      gap: var(--tn-space-1);
      justify-content: center;
      min-height: var(--tn-tap);
      padding: 0 var(--tn-space-2);
      white-space: nowrap;
      width: 100%;
    }
  }
`

/* Rails and nodes drawn by ./line-column-content on the phone layout. */
const railCss = `
  .tn-rail {
    background: var(--tn-rail-color);
    border-radius: 2px;
    bottom: -11px;
    left: 50%;
    position: absolute;
    top: 11px;
    transform: translateX(-50%);
    width: 4px;
    z-index: 1;
  }
  .tn-rail-walk,
  .tn-rail-bike,
  .tn-rail-car {
    background: radial-gradient(
        circle,
        var(--tn-rail-color) 2px,
        transparent 2.5px
      )
      center 2px / 4px 9px repeat-y;
  }
  .tn-rail-node {
    background-color: var(--tn-surface);
    border: 3px solid var(--tn-node-color);
    border-radius: 50%;
    box-sizing: border-box;
    height: 12px;
    left: 50%;
    position: absolute;
    top: 5px;
    transform: translateX(-50%);
    width: 12px;
    z-index: 2;
  }
  .tn-rail-node-origin {
    border-color: var(--tn-text);
    height: 14px;
    top: 4px;
    width: 14px;
  }
  .tn-rail-node-destination {
    background-color: var(--tn-text);
    border-color: var(--tn-text);
    box-shadow: 0 0 0 3px var(--tn-surface);
    height: 14px;
    top: 4px;
    width: 14px;
  }
  .tn-rail-node-interline {
    border-width: 2px;
    height: 8px;
    top: 7px;
    width: 8px;
  }
`

const StyledItineraryBody = styled(ItineraryBody)`
  /* Render itineraries using the ambient font (not necessarily Hind). */
  *:not(.fa) {
    font-family: inherit;
  }
  ${PlaceNameWrapper},
  ${PlaceSubheader},
  ${LegDescriptionHeadsignPrefix} {
    font-weight: inherit;
  }
  ${PlaceRowWrapper} {
    max-width: inherit;
  }
  ${TimeColumn} {
    white-space: nowrap;
  }

  /* ---------- Phone layout: the timeline (mobile overhaul) ----------
     Columns: rail (28px) | place name | time (right, tabular), and the
     instructions under the name spanning to the right edge — the time only
     takes the name's row, so the leg details keep the full width.
     Stop names 16px 600, times 14px tabular, details 14px text-2. */
  .tn-mobile & {
    color: var(--tn-text);
    font-size: 16px;
    margin: 0;
  }
  .tn-mobile & ${PlaceRowWrapper} {
    column-gap: var(--tn-space-3);
    grid-template-areas:
      'line title time'
      'line instructions instructions';
    grid-template-columns: 28px minmax(0, 1fr) auto;
    max-width: none;
  }
  .tn-mobile & ${LineColumn} {
    max-width: 28px;
    padding: 0;
    width: 28px;
  }
  .tn-mobile & {
    ${railCss}
  }

  .tn-mobile & ${PlaceHeader} {
    color: var(--tn-text);
    font: 600 16px/22px var(--tn-font);
  }
  .tn-mobile & ${PlaceNameWrapper} {
    font-weight: 600;
    padding: 0 0 var(--tn-space-1);
  }
  .tn-mobile & ${TimeColumn} {
    color: var(--tn-text-2);
    font: 500 14px/22px var(--tn-font);
    font-variant-numeric: var(--tn-tabular);
    grid-row: 1;
    padding: 0 0 var(--tn-space-1);
    text-align: right;
    width: auto;
  }
  .tn-mobile & ${PlaceDetails} {
    color: var(--tn-text-2);
    font: var(--tn-type-sm);
    min-width: 0;
    padding-bottom: var(--tn-space-4);
  }
  .tn-mobile & ${PlaceSubheader} {
    align-items: center;
    color: var(--tn-text-2);
    display: flex;
    flex-wrap: wrap;
    font: var(--tn-type-sm);
    gap: 0 var(--tn-space-2);
    margin: 0 0 var(--tn-space-2);
    padding: 0;
  }
  .tn-mobile & ${LegBody} {
    color: var(--tn-text-2);
    display: flex;
    flex-direction: column;
    font: var(--tn-type-sm);
    gap: var(--tn-space-1);
    padding-bottom: 0;
  }
  /* The leg header: route pill row, then "Ride 18 min · 9 stops", then the
     frequency, alerts and operator. The details wrapper dissolves so its
     children can be ordered against the footer. */
  .tn-mobile & .transit-leg-details-wrapper {
    display: contents;
  }
  .tn-mobile & ${LegClickable} {
    order: 0;
  }
  .tn-mobile & ${TransitLegDetails} {
    margin: 0;
    order: 1;
  }
  .tn-mobile & .leg-frequency {
    color: var(--tn-text-2);
    order: 2;
  }
  .tn-mobile & .alert-toggle,
  .tn-mobile & .alert-toggle + div {
    order: 3;
  }
  /* The invisible "Zoom to leg" overlay buttons: 44px tall. */
  .tn-mobile & ${LegDescription} > button {
    min-height: var(--tn-tap);
  }
  .tn-mobile & ${AgencyInfo} a {
    display: inline-block;
    margin: -15px 0;
    padding: 15px 0;
  }
  .tn-mobile & ${AgencyInfo} {
    color: var(--tn-text-3);
    font: 400 12px/16px var(--tn-font);
    margin: var(--tn-space-1) 0 0;
    order: 4;

    a {
      color: var(--tn-text-2);
    }
    img {
      display: none;
    }
  }
  .tn-mobile & ${LegDescription} {
    color: var(--tn-text-2);
    font: var(--tn-type-sm);
    min-height: 32px;
  }
  /* The route pill row: one line, sr-only words included. */
  .tn-mobile & ${LegDescription} {
    width: 100%;
  }
  .tn-mobile & ${LegDescription} > span:first-child {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--tn-space-1);
  }
  .tn-mobile & ${LegDescription} svg {
    color: var(--tn-text-2);
    fill: currentColor;
  }
  .tn-mobile & .place-details.transit ${LegDescription} {
    color: var(--tn-text);
    font: 600 16px/22px var(--tn-font);
  }
  .tn-mobile & ${TransitLegDetailsHeader} {
    align-items: center;
    color: var(--tn-text-2);
    flex-wrap: wrap;
    gap: 0 var(--tn-space-3);
  }
  .tn-mobile & ${TransitLegSummaryButton}, .tn-mobile & .alert-toggle {
    align-items: center;
    color: var(--tn-text-2);
    display: inline-flex;
    font: var(--tn-type-sm);
    font-variant-numeric: var(--tn-tabular);
    gap: var(--tn-space-1);
    /* 44px touch target without growing the line (-12px each side). */
    margin: -12px 0;
    min-height: var(--tn-tap);
    padding: 0;
    text-align: start;
  }
  .tn-mobile & .alert-toggle {
    color: var(--tn-warn);
    font-weight: 500;
  }
  .tn-mobile & .alert-toggle svg {
    color: var(--tn-warn);
    fill: currentColor;
  }
  /* "Stop Viewer" / "Trip Viewer": accent text links, no pipe, 44px tall. */
  .tn-mobile & ${ViewerButton} {
    align-items: center;
    color: var(--tn-accent);
    display: inline-flex;
    font: 600 14px/18px var(--tn-font);
    margin: -13px 0;
    min-height: var(--tn-tap);
    padding: 0;
  }
  .tn-mobile & ${ViewerButton}::before {
    content: none;
  }
  /* Access legs' "6 min ▾" step toggle. */
  .tn-mobile & .place-details:not(.transit) button[aria-expanded] {
    align-items: center;
    color: var(--tn-text-2);
    display: inline-flex;
    font: var(--tn-type-sm);
    font-variant-numeric: var(--tn-tabular);
    margin: -12px 0;
    min-height: var(--tn-tap);
    padding: 0;
  }
  /* Intermediate stops: 8px nodes on the rail, names 14px text-2. */
  .tn-mobile & ${StopRow} {
    font: var(--tn-type-sm);
    padding: 5px 0;
  }
  .tn-mobile & ${StopMarker} {
    background-color: var(--tn-surface);
    border: 2px solid var(--tn-text-2);
    border-radius: 50%;
    box-sizing: border-box;
    color: transparent;
    font-size: 0;
    height: 10px;
    /* rail centre: 28px column / 2 = 14px; instructions start 40px in. */
    margin: 4px 0 0 -31px;
    width: 10px;
  }
  .tn-mobile & ${StopName} {
    color: var(--tn-text-2);
    margin: 0;
  }
`

class ConnectedItineraryBody extends Component {
  static contextType = ComponentContext

  /** avoid rerendering if the itinerary to display hasn't changed */
  shouldComponentUpdate(nextProps) {
    return !isEqual(this.props.itinerary, nextProps.itinerary)
  }

  render() {
    const {
      accessibilityScoreGradationMap,
      closedStops,
      config,
      diagramVisible,
      itinerary,
      RouteDescriptionOverride,
      setActiveLeg,
      setLegDiagram,
      setMainPanelContent,
      setMapillaryId,
      setViewedTrip,
      // Go Mode's trip sheet renders this body mid-ride, where the trip tools
      // (Start Over / Print / Report Issue) are wrong at best and destructive
      // at worst — "Start Over" would discard the trip being navigated.
      showTripTools = true
    } = this.props
    const { RouteDescriptionFooter } = this.context
    const clonedItinerary = markTransfers(clone(itinerary))

    const showViewTripButton = !config?.itinerary?.hideViewTripButton
    const allowUserAlertCollapsing = config?.itinerary?.allowUserAlertCollapsing
    const showApproximatePrefixAccessLegs =
      config?.itinerary?.showApproximatePrefixAccessLegs
    const showAlertEffectiveDateTimeText =
      config?.itinerary?.showAlertEffectiveDateTimeText

    // Support OTP1 flex messages in Trip Details
    // Adding empty pickupBookingInfo and dropOffBookingInfo objects
    // to a leg will trigger relevant flex pickup / dropoff descriptions in
    // the Trip Details component.
    const boardingRuleLeg = clonedItinerary.legs.find(
      (leg) => !!leg.boardRule && !leg.pickupBookingInfo
    )
    const alightingRuleLeg = clonedItinerary.legs.find(
      (leg) => !!leg.alightRule && !leg.dropOffBookingInfo
    )

    // Add pickupBookingInfo for any boarding rules
    if (boardingRuleLeg) {
      boardingRuleLeg.pickupBookingInfo = {
        latestBookingTime: {
          daysPrior: 0
        }
      }
    }
    // Add dropOffBookingInfo for any alighting rules
    if (alightingRuleLeg) {
      alightingRuleLeg.dropOffBookingInfo = {
        latestBookingTime: {
          daysPrior: 0
        }
      }
    }

    config.formatDuration = formatDuration
    return (
      <ItineraryBodyContainer>
        <StyledItineraryBody
          accessibilityScoreGradationMap={accessibilityScoreGradationMap}
          alwaysCollapseAlerts={allowUserAlertCollapsing}
          className="itin-body"
          closedStopIds={closedStops}
          config={config}
          diagramVisible={diagramVisible}
          itinerary={clonedItinerary}
          LegIcon={LegIconWithA11y}
          LineColumnContent={LineColumnContent}
          mapillaryCallback={setMapillaryId}
          mapillaryKey={config?.mapillary?.key}
          PlaceName={({ place }) => {
            const intl = useIntl()
            return formatPlaceName(place?.name || '', intl)
          }}
          RouteDescription={RouteDescriptionOverride || RouteDescription}
          // How often each transit leg runs (backlog 58.1), unless the app
          // supplies a footer of its own.
          RouteDescriptionFooter={RouteDescriptionFooter || LegFrequencyFooter}
          setActiveLeg={setActiveLeg}
          setLegDiagram={setLegDiagram}
          setViewedTrip={(tripId) => {
            setViewedTrip(tripId)
            setMainPanelContent(MainPanelContent.TRIP_VIEWER)
          }}
          showAgencyInfo
          showAlertEffectiveDateTimeText={showAlertEffectiveDateTimeText}
          showApproximateAccessLegTravelTimes={showApproximatePrefixAccessLegs}
          showElevationProfile={config.elevationProfile}
          showLegIcon
          showMapButtonColumn={false}
          showRouteFares={config.itinerary && config.itinerary.showRouteFares}
          showViewTripButton={showViewTripButton}
          TimeColumnContent={RealtimeTimeColumn}
          toRouteAbbreviation={noop}
          TransitLegSubheader={TransitLegSubheader}
          TransitLegSummary={TransitLegSummary}
        />
        <TripDetails
          itinerary={clonedItinerary}
          showApproximateMinutesActive={showApproximatePrefixAccessLegs}
        />
        {showTripTools && <TripTools itinerary={clonedItinerary} />}
      </ItineraryBodyContainer>
    )
  }
}

const mapStateToProps = (state) => {
  return {
    closedStops: state.otp.ui.stopClosures.closedStops,
    config: state.otp.config,
    diagramVisible: state.otp.ui.diagramLeg
  }
}

const mapDispatchToProps = {
  setLegDiagram,
  setMainPanelContent,
  setMapillaryId,
  setViewedTrip
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(ConnectedItineraryBody)
