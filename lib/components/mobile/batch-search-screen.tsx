import { Bus } from '@styled-icons/fa-solid/Bus'
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
import { TnButton, TnCard } from '../util/tn-styled'
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

/** The measured form height, read by `.batch-search-map` (mobile.css). */
const FORM_HEIGHT_VAR = '--tn-search-form-height'

const MobileSearchSettings = styled.div<{
  advancedPanelOpen: boolean
  transitionDelay: number
  transitionDuration: number
}>`
  /* The grey ground of an Apple-Maps-style sheet: the route card, chips,
     mode segments and buttons are surface faces on it. */
  background: var(--tn-bg);
  border-radius: 0 0 var(--tn-radius) var(--tn-radius);
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

  .otp.mobile &.mobile-padding {
    padding: var(--tn-space-3) var(--tn-space-4) var(--tn-space-1);
  }
  &.advanced-mode-open {
    border-radius: 0;
    box-shadow: none;
  }
`

/**
 * From, any stops, To in ONE card: a dotted connector runs down the icon
 * column from the origin dot to the destination pin, and the swap button
 * sits on the card's right edge. The field look itself is base.css's; the
 * in-card overrides (transparent rows, hairlines) are in mobile.css under
 * `.tn-route-card`.
 */
const RouteCard = styled(TnCard)`
  position: relative;
`

/** Save this place · I'm already on the bus: quiet ghost rows. */
const FormFooter = styled.div`
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  margin: var(--tn-space-1) calc(-1 * var(--tn-space-2)) 0;
`

/** Secondary pill on the grey ground: a surface face, like the chips. */
const BackToResultsButton = styled(TnButton)`
  background-color: var(--tn-surface);
  box-shadow: var(--tn-shadow);
`

const OnBusButton = styled(TnButton)`
  font-size: 15px;
  gap: 6px;
  min-height: var(--tn-tap);
  padding: 0 var(--tn-space-2);

  svg {
    height: 18px;
    width: 18px;
  }
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
  _settingsRef = React.createRef<HTMLDivElement>()
  _mapRef = React.createRef<HTMLDivElement>()
  _formObserver: ResizeObserver | null = null

  /**
   * The map strip starts where the form ends. The form's height moves with
   * the chips (round trip's stays, the depart/arrive card, a stop, the footer
   * wrapping at 360 px), so it is measured and handed to `.batch-search-map`
   * as --tn-search-form-height rather than hard-coded per state. While the
   * options panel covers the screen the last closed height is kept, so the
   * map is already in place when the panel closes.
   */
  _measureForm = () => {
    const form = this._settingsRef.current
    const map = this._mapRef.current
    if (!form || !map || this.state.showAdvancedModeSettings) return
    map.style.setProperty(FORM_HEIGHT_VAR, `${form.offsetHeight}px`)
  }

  componentDidMount() {
    const Observer = (
      window as unknown as { ResizeObserver?: typeof ResizeObserver }
    ).ResizeObserver
    if (Observer && this._settingsRef.current) {
      this._formObserver = new Observer(this._measureForm)
      this._formObserver.observe(this._settingsRef.current)
    }
    this._measureForm()
  }

  componentDidUpdate() {
    // The form unmounts while a point is picked off the map; re-attach.
    const form = this._settingsRef.current
    if (form && this._formObserver) this._formObserver.observe(form)
    this._measureForm()
  }

  componentWillUnmount() {
    this._formObserver?.disconnect()
  }

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
              ref={this._settingsRef}
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
                        <RouteCard $padding="none" className="tn-route-card">
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
                        </RouteCard>
                        <BatchSettings
                          mobile
                          onPlanTripClick={this.handlePlanTripClick}
                          openAdvancedSettings={this.openAdvancedSettings}
                          // Edit keeps the search (backlog 70.1): while the
                          // form still asks for it, the rider can go back to
                          // its results without planning again.
                          secondaryAction={
                            formMatchesActiveSearch && (
                              <BackToResultsButton
                                $block
                                $variant="secondary"
                                className="back-to-results"
                                onClick={this._backToResultsClicked}
                                type="button"
                              >
                                {intl.formatMessage({
                                  defaultMessage: 'Back to results',
                                  id: 'components.BatchSearchScreen.backToResults'
                                })}
                              </BackToResultsButton>
                            )
                          }
                        />
                        <ActiveRoutingPreferences />
                        <FormFooter className="search-form-footer">
                          <SavePlaceButton />
                          <OnBusButton
                            $variant="ghost"
                            className="on-bus-button"
                            onClick={this._onBusClicked}
                            type="button"
                          >
                            <Bus aria-hidden />
                            {intl.formatMessage({
                              defaultMessage: "I'm already on the bus",
                              id: 'components.GoMode.onBusButton'
                            })}
                          </OnBusButton>
                        </FormFooter>
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
            ref={this._mapRef}
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
