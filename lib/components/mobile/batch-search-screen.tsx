import { connect } from 'react-redux'
import { CSSTransition, TransitionGroup } from 'react-transition-group'
import { injectIntl, IntlShape } from 'react-intl'
import React, { Component } from 'react'
import styled from 'styled-components'

import * as apiActions from '../../actions/api'
import * as formActions from '../../actions/form'
import * as goModeActions from '../../actions/go-mode'
import * as uiActions from '../../actions/ui'
import {
  advancedPanelClassName,
  mainPanelClassName,
  transitionDuration,
  TransitionStyles
} from '../form/styled'
import { alertUserTripPlan } from '../form/util'
import { formQueryMatchesSearch } from '../../util/search-query-match'
import { getActiveSearch } from '../../util/state'
import { MobileScreens } from '../../actions/ui-constants'
import { RoutingQueryCallResult } from '../../actions/api-constants'
import ActiveRoutingPreferences from '../form/active-routing-preferences'
import AdvancedSettingsPanel from '../form/advanced-settings-panel'
import BatchSettings from '../form/batch-settings'
import DefaultMap from '../map/default-map'
import IntermediateStops from '../form/intermediate-stops'
import LocationField from '../form/connected-location-field'
import SavePlaceButton from '../form/save-place-button'
import SwitchButton from '../form/switch-button'

import MobileContainer from './container'
import MobileNavigationBar from './navigation-bar'

const { SET_FROM_LOCATION, SET_TO_LOCATION } = MobileScreens

const MobileSearchSettings = styled.div<{
  advancedPanelOpen: boolean
  transitionDelay: number
  transitionDuration: number
}>`
  background: var(--tn-surface);
  box-shadow: var(--tn-shadow);
  height: ${(props) =>
    props.advancedPanelOpen
      ? 'calc(100% - 50px - var(--return-to-trip-banner-height, 0px))'
      : 'auto'};
  left: 0;
  position: fixed;
  right: 0;
  /* Under the live-trip return banner, never behind it (2026-09-08). */
  top: calc(50px + var(--return-to-trip-banner-height, 0px));
  transition: ${(props) => `all ${props.transitionDuration}ms ease`};
  transition-delay: ${(props) => props.transitionDelay}ms;
  /* Must appear under the 'hamburger' dropdown which has z-index of 1000, and the "network lost"
    banner which has a z-index of 10 */
  z-index: 9;
`

const OnBusButton = styled.button`
  background: #fff;
  border: 2px solid #0b6ea8;
  border-radius: 8px;
  color: #0b6ea8;
  cursor: pointer;
  font-weight: 600;
  margin-top: 10px;
  padding: 12px;
  width: 100%;
`

interface Props {
  beginOnboardFlow: () => void
  currentQuery: any
  /** The kept search still answers this form (70.1): offer the way back. */
  formMatchesActiveSearch: boolean
  intl: IntlShape
  map: React.ReactElement
  mapPickActive: boolean
  routingQuery: any
  setMobileScreen: (screen: number) => void
  syncCurrentLocationOrigin: () => void
  updateQueryTimeIfLeavingNow: () => void
}

class BatchSearchScreen extends Component<Props> {
  state = {
    closeAdvancedSettingsWithDelay: false,
    planTripClicked: false,
    showAdvancedModeSettings: false
  }

  _fromFieldClicked = () => this.props.setMobileScreen(SET_FROM_LOCATION)

  _toFieldClicked = () => this.props.setMobileScreen(SET_TO_LOCATION)

  _onBusClicked = () => {
    const { beginOnboardFlow, currentQuery, setMobileScreen } = this.props
    const to = currentQuery?.to
    // A destination is required to optimize where to get off; if it's missing,
    // send the rider to set it first.
    if (!to || to.lat == null) {
      setMobileScreen(SET_TO_LOCATION)
      return
    }
    beginOnboardFlow()
  }

  _backToResultsClicked = () =>
    this.props.setMobileScreen(MobileScreens.RESULTS_SUMMARY)

  _mainPanelContentRef = React.createRef<HTMLDivElement>()
  _advancedSettingRef = React.createRef<HTMLDivElement>()

  handlePlanTripClick = () => {
    const {
      currentQuery,
      intl,
      routingQuery,
      setMobileScreen,
      syncCurrentLocationOrigin,
      updateQueryTimeIfLeavingNow
    } = this.props
    updateQueryTimeIfLeavingNow()
    // "Update the point with each search": a Current Location origin plans
    // from the freshest GPS fix, not the one captured when the field was set.
    syncCurrentLocationOrigin()
    // Declared order: (intl, query, onPlanTripClick, routingQuery). These two
    // were swapped, so the search fired before validation and the invalid-
    // query alert could never show on the phone (backlog 10.3).
    alertUserTripPlan(
      intl,
      currentQuery,
      () => this.setState({ planTripClicked: true }),
      () => {
        const result = routingQuery()
        // Open the results ourselves: componentDidUpdate only does it on a
        // null -> set change of activeSearch, which a cleared-and-replaced
        // search never produces (backlog 45.1).
        if (result === RoutingQueryCallResult.SUCCESS) {
          setMobileScreen(MobileScreens.RESULTS_SUMMARY)
        }
        return result
      }
    )
  }

  openAdvancedSettings = () => {
    this.setState({
      closeAdvancedSettingsWithDelay: false,
      showAdvancedModeSettings: true
    })
  }

  closeAdvancedSettings = () => {
    this.setState({ showAdvancedModeSettings: false })
  }

  setCloseAdvancedSettingsWithDelay = () => {
    this.setState({
      closeAdvancedSettingsWithDelay: true
    })
  }

  render() {
    const { formMatchesActiveSearch, intl, mapPickActive } = this.props
    const { planTripClicked, showAdvancedModeSettings } = this.state
    const { departArrive } = this.props.currentQuery
    const dateTimeSelectorOpen = departArrive !== 'NOW'

    const transitionDelay = this.state.closeAdvancedSettingsWithDelay ? 300 : 0
    const transitionDurationWithDelay = transitionDuration + transitionDelay
    return (
      <MobileContainer>
        <MobileNavigationBar
          headerText={intl.formatMessage({
            id: 'components.BatchSearchScreen.header'
          })}
        />
        <main tabIndex={-1}>
          {/* While the rider is choosing a point off the map (backlog 3.9) the
              form gets out of the way, so the map they are aiming is the whole
              screen rather than the strip below the form. */}
          {!mapPickActive && (
            <MobileSearchSettings
              advancedPanelOpen={showAdvancedModeSettings}
              className={`batch-search-settings mobile-padding ${
                showAdvancedModeSettings && 'advanced-mode-open'
              }`}
              transitionDelay={transitionDelay}
              transitionDuration={transitionDuration}
            >
              <TransitionStyles transitionDelay={transitionDelay}>
                <TransitionGroup style={{ display: 'content' }}>
                  {/* Unfortunately we can't use a ternary operator here because it is cancelling out the CSSTransition animations. */}
                  {!showAdvancedModeSettings && (
                    <CSSTransition
                      classNames={mainPanelClassName}
                      nodeRef={this._mainPanelContentRef}
                      timeout={transitionDurationWithDelay}
                    >
                      <div
                        ref={this._mainPanelContentRef}
                        style={{ display: 'content' }}
                      >
                        <LocationField
                          inputPlaceholder={intl.formatMessage({
                            id: 'components.LocationSearch.setOrigin'
                          })}
                          isRequired
                          locationType="from"
                          onTextInputClick={this._fromFieldClicked}
                          selfValidate={planTripClicked}
                          showClearButton={false}
                        />
                        <IntermediateStops />
                        <LocationField
                          inputPlaceholder={intl.formatMessage({
                            id: 'components.LocationSearch.setDestination'
                          })}
                          isRequired
                          locationType="to"
                          onTextInputClick={this._toFieldClicked}
                          selfValidate={planTripClicked}
                          showClearButton={false}
                        />
                        <div className="switch-button-container-mobile">
                          <SwitchButton />
                        </div>
                        <BatchSettings
                          onPlanTripClick={this.handlePlanTripClick}
                          openAdvancedSettings={this.openAdvancedSettings}
                        />
                        {/* Edit keeps the search (backlog 70.1): while the
                            form still asks for it, the rider can go back to
                            its results without planning again. */}
                        {formMatchesActiveSearch && (
                          <OnBusButton
                            className="back-to-results"
                            onClick={this._backToResultsClicked}
                            type="button"
                          >
                            {intl.formatMessage({
                              defaultMessage: 'Back to results',
                              id: 'components.BatchSearchScreen.backToResults'
                            })}
                          </OnBusButton>
                        )}
                        <ActiveRoutingPreferences />
                        <SavePlaceButton />
                        <OnBusButton onClick={this._onBusClicked} type="button">
                          {intl.formatMessage({
                            defaultMessage: "I'm already on the bus",
                            id: 'components.GoMode.onBusButton'
                          })}
                        </OnBusButton>
                      </div>
                    </CSSTransition>
                  )}
                  {showAdvancedModeSettings && (
                    <CSSTransition
                      classNames={advancedPanelClassName}
                      nodeRef={this._advancedSettingRef}
                      timeout={{
                        enter: transitionDuration,
                        exit: transitionDurationWithDelay
                      }}
                    >
                      <AdvancedSettingsPanel
                        closeAdvancedSettings={this.closeAdvancedSettings}
                        handlePlanTrip={this.handlePlanTripClick}
                        innerRef={this._advancedSettingRef}
                        setCloseAdvancedSettingsWithDelay={
                          this.setCloseAdvancedSettingsWithDelay
                        }
                      />
                    </CSSTransition>
                  )}
                </TransitionGroup>
              </TransitionStyles>
            </MobileSearchSettings>
          )}
          <div
            className={`batch-search-map ${
              mapPickActive ? 'map-pick-open' : ''
            } ${dateTimeSelectorOpen && !mapPickActive ? 'dt-open' : ''}`}
          >
            <DefaultMap />
          </div>
        </main>
      </MobileContainer>
    )
  }
}

// connect to the redux store

const mapStateToProps = (state: any) => {
  const currentQuery = state.otp.currentQuery
  const activeSearch: any = getActiveSearch(state)
  return {
    currentQuery,
    formMatchesActiveSearch: formQueryMatchesSearch(
      currentQuery,
      activeSearch?.query
    ),
    mapPickActive: Boolean(state.otp.ui.mapPickLocationType)
  }
}

const mapDispatchToProps = {
  beginOnboardFlow: goModeActions.beginOnboardFlow,
  routingQuery: apiActions.routingQuery,
  setMobileScreen: uiActions.setMobileScreen,
  syncCurrentLocationOrigin: formActions.syncCurrentLocationOrigin,
  updateQueryTimeIfLeavingNow: formActions.updateQueryTimeIfLeavingNow
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(injectIntl(BatchSearchScreen))
