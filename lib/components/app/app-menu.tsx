import { Bug } from '@styled-icons/fa-solid/Bug'
import { Bus } from '@styled-icons/fa-solid/Bus'
import { Comment } from '@styled-icons/fa-regular/Comment'
import { connect } from 'react-redux'
import { Envelope } from '@styled-icons/fa-regular/Envelope'
import { ExternalLinkSquareAlt } from '@styled-icons/fa-solid/ExternalLinkSquareAlt'
import { FormattedMessage, injectIntl } from 'react-intl'
import { GlobeAmericas } from '@styled-icons/fa-solid/GlobeAmericas'
import { GraduationCap } from '@styled-icons/fa-solid/GraduationCap'
import { History } from '@styled-icons/fa-solid/History'
import { MapMarked } from '@styled-icons/fa-solid/MapMarked'
import { MapMarkerAlt } from '@styled-icons/fa-solid/MapMarkerAlt'
import { MapPin } from '@styled-icons/fa-solid/MapPin'
import { Sliders } from '@styled-icons/fa-solid/Sliders'
import { Undo } from '@styled-icons/fa-solid/Undo'
import React, { Component, Fragment, useContext } from 'react'
import SlidingPane from 'react-sliding-pane'
import type { WrappedComponentProps } from 'react-intl'

import * as callTakerActions from '../../actions/call-taker'
import * as fieldTripActions from '../../actions/field-trip'
import * as goModeActions from '../../actions/go-mode'
import * as uiActions from '../../actions/ui'
import { AppMenuItemConfig, LanguageConfig } from '../../util/config-types'
import { AppReduxState } from '../../util/state-types'
import { ComponentContext } from '../../util/contexts'
import { convertChineseLanguageCode, getLanguageOptions } from '../../util/i18n'
import {
  FEEDBACK_PATH,
  LOCAL_PLACES_PATH,
  SETTINGS_PATH
} from '../../util/constants'
import {
  getBuildInfo,
  getDeviceId,
  isDebugLogEnabled,
  setDebugLogEnabled
} from '../../util/debug-log'
import { isModuleEnabled, Modules } from '../../util/config'

import AppMenuItem from './app-menu-item'
import PopupTriggerText from './popup-trigger-text'

type MenuItem = {
  children?: MenuItem[]
  href?: string
  iconType?: string | JSX.Element
  iconUrl?: string
  id: string
  isSelected?: boolean
  label?: string | JSX.Element
  lang?: string
  onClick?: () => void
  skipLocales?: boolean
  subMenuDivider?: boolean
}

type AppMenuProps = {
  activeLocale: string
  backgroundGoMode: () => void
  callTakerEnabled?: boolean
  extraMenuItems?: AppMenuItemConfig[]
  fieldTripEnabled?: boolean
  language?: LanguageConfig
  languageOptions: Record<string, any> | null
  mailablesEnabled?: boolean
  popupTarget?: string
  resetAndToggleCallHistory?: () => void
  resetAndToggleFieldTrips?: () => void
  rideConsoleDeviceIds?: string[]
  rideConsoleUrl?: string
  setLocale: (locale: string) => void
  setPopupContent: (url: string) => void
  startOverFromInitialUrl: () => void
  toggleMailables: () => void
  translateExternalLinks?: boolean
  tripInForeground?: boolean
}
type AppMenuState = {
  diagnosticsOn: boolean
  isPaneOpen: boolean
}

/**
 * Sidebar which appears to show user list of options and links
 */
class AppMenu extends Component<
  AppMenuProps & WrappedComponentProps,
  AppMenuState
> {
  static contextType = ComponentContext

  state = {
    diagnosticsOn: isDebugLogEnabled(),
    isPaneOpen: false
  }

  _startOver = () => {
    this.props.startOverFromInitialUrl()
  }

  _triggerPopup = () => {
    const { popupTarget, setPopupContent } = this.props
    if (popupTarget) setPopupContent(popupTarget)
  }

  _togglePane = () => {
    const { isPaneOpen } = this.state
    this.setState({ isPaneOpen: !isPaneOpen })
  }

  // Every item below that navigates takes the rider off this screen. An active
  // Go Mode trip is a fixed full-screen layer over the whole app, so with the
  // trip in the foreground the rider taps a menu item and nothing appears to
  // happen. Background it instead: tracking, notifications and the trip itself
  // keep running, and the ReturnToTripBanner is the way back.
  _handleNavigate = () => {
    const { backgroundGoMode, tripInForeground } = this.props
    if (tripInForeground) backgroundGoMode()
    this._togglePane()
  }

  _handleSkipNavigation = () => {
    document.querySelector('main')?.focus()
  }

  // Diagnostics sharing (the remote debug-log stream) is opt-in per device;
  // this menu toggle is the only way to opt in from the native app, which has
  // no URL bar for the ?debugLog=1 override.
  _toggleDiagnostics = () => {
    const diagnosticsOn = !this.state.diagnosticsOn
    setDebugLogEnabled(diagnosticsOn)
    this.setState({ diagnosticsOn })
  }

  _addExtraMenuItems = (
    menuItems?: MenuItem[] | null,
    translateExternalLinks?: boolean
  ) => {
    return (
      menuItems &&
      menuItems.map((menuItem) => {
        const {
          children,
          href,
          iconType,
          iconUrl,
          id,
          isSelected,
          label: configLabel,
          lang,
          onClick,
          skipLocales,
          subMenuDivider
        } = menuItem
        const { activeLocale, language } = this.props
        const localizedLabel = language?.[activeLocale]?.config?.menuItems?.[id]
        const useLocalizedLabel = !skipLocales && localizedLabel
        // Override the config label if a localized label exists
        const label = useLocalizedLabel ? localizedLabel : configLabel

        const languageCode = convertChineseLanguageCode(activeLocale)
        const url = translateExternalLinks
          ? href + `/#googtrans(${languageCode})`
          : href
        return (
          <AppMenuItem
            aria-selected={isSelected || undefined}
            className={subMenuDivider ? 'app-menu-divider' : undefined}
            href={url}
            icon={
              iconType && typeof iconType !== 'string' ? (
                iconType
              ) : (
                <Icon iconType={iconType} iconUrl={iconUrl} />
              )
            }
            id={id}
            key={id}
            lang={lang}
            onClick={onClick}
            role={isSelected !== undefined ? 'option' : undefined}
            subItems={this._addExtraMenuItems(children) || undefined}
            text={label}
          />
        )
      })
    )
  }

  render() {
    const {
      activeLocale,
      callTakerEnabled,
      extraMenuItems,
      fieldTripEnabled,
      intl,
      languageOptions,
      mailablesEnabled,
      popupTarget,
      resetAndToggleCallHistory,
      resetAndToggleFieldTrips,
      rideConsoleDeviceIds,
      rideConsoleUrl,
      setLocale,
      toggleMailables,
      translateExternalLinks
    } = this.props
    const languageMenuItems: MenuItem[] | null = languageOptions && [
      {
        children: Object.keys(languageOptions).map((locale: string) => ({
          iconType: <svg />,
          id: locale,
          isSelected: activeLocale === locale,
          label: languageOptions[locale].name,
          lang: locale,
          onClick: () => setLocale(locale),
          skipLocales: true,
          subMenuDivider: false
        })),
        iconType: <GlobeAmericas />,
        id: 'app-menu-locale-selector',
        label: <FormattedMessage id="components.SubNav.languageSelector" />,
        skipLocales: true,
        subMenuDivider: false
      }
    ]

    // The console is tailnet-gated server-side, so on any device not on the
    // owner's tailnet the link is a dead 403 — and native builds default
    // diagnostics ON, so without the allowlist every TestFlight install would
    // show a button that cannot work.
    const showRideConsole =
      this.state.diagnosticsOn &&
      !!getDeviceId() &&
      !!rideConsoleUrl &&
      (!rideConsoleDeviceIds ||
        rideConsoleDeviceIds.includes(getDeviceId() as string))

    const { isPaneOpen } = this.state
    const { SvgIcon } = this.context
    const buttonLabel = isPaneOpen
      ? intl.formatMessage({ id: 'components.AppMenu.closeMenu' })
      : intl.formatMessage({ id: 'components.AppMenu.openMenu' })
    const Bar = 'span'

    return (
      <>
        {/* Use a button for skipping navigation. A regular <a href=...> element would modify the URL,
            and such change would be captured by the router without changing the focused element. */}
        <button
          className="skip-nav-button"
          onClick={this._handleSkipNavigation}
        >
          <FormattedMessage id="components.AppMenu.skipNavigation" />
        </button>
        <button
          aria-controls="app-menu"
          aria-expanded={isPaneOpen}
          aria-label={buttonLabel}
          className="app-menu-icon"
          onClick={this._togglePane}
        >
          <Bar className="menu-line top" />
          <Bar className="menu-line middle" />
          <Bar className="menu-line bottom" />
        </button>
        <SlidingPane
          from="left"
          hideHeader
          isOpen={isPaneOpen}
          onRequestClose={() => this.setState({ isPaneOpen: false })}
          shouldCloseOnEsc
          width="320px"
        >
          <div className="app-menu" id="app-menu">
            {/* This item is duplicated by the view-switcher, but only shown on mobile
            when the view switcher isn't shown (using css) */}
            <AppMenuItem
              className="app-menu-trip-planner-link"
              icon={<MapMarked />}
              onClick={this._handleNavigate}
              text={intl.formatMessage({
                id: 'components.BatchRoutingPanel.shortTitle'
              })}
              to="/"
            />
            {/* This item is duplicated by the view-switcher, but only shown on mobile
            when the view switcher isn't shown (using css) */}
            <AppMenuItem
              className="app-menu-route-viewer-link"
              icon={<Bus />}
              onClick={this._handleNavigate}
              text={intl.formatMessage({
                id: 'components.RouteViewer.shortTitle'
              })}
              to="/route"
            />
            {/* This item is duplicated by the view-switcher, but only shown on mobile
            when the view switcher isn't shown (using css) */}
            <AppMenuItem
              className="app-menu-nearby-viewer-link"
              icon={<MapPin />}
              onClick={this._handleNavigate}
              text={intl.formatMessage({
                id: 'components.ViewSwitcher.nearby'
              })}
              to="/nearby"
            />
            <AppMenuItem
              icon={<MapMarkerAlt />}
              onClick={this._handleNavigate}
              text={intl.formatMessage({
                defaultMessage: 'My places',
                id: 'components.AppMenu.myPlaces'
              })}
              to={LOCAL_PLACES_PATH}
            />
            {/* The rider's routing levers and turn-by-turn default. Before
                this they existed only inside the search form's advanced
                panel — reachable only mid-plan — which is why no preference
                was ever set on the 2026-09-04 ride ("Where my user params
                at??"). */}
            <AppMenuItem
              icon={<Sliders />}
              onClick={this._handleNavigate}
              text={intl.formatMessage({
                defaultMessage: 'Settings',
                id: 'components.AppMenu.settings'
              })}
              to={SETTINGS_PATH}
            />
            {/* Next to Settings, and reachable mid-ride for the same reason:
                _handleNavigate backgrounds an active trip rather than ending
                it. A UI defect emits no telemetry, so the screenshot the rider
                takes while looking at it is the only evidence there is. */}
            <AppMenuItem
              icon={<Comment />}
              onClick={this._handleNavigate}
              text={intl.formatMessage({
                defaultMessage: 'Share feedback',
                id: 'components.AppMenu.shareFeedback'
              })}
              to={FEEDBACK_PATH}
            />
            <AppMenuItem
              icon={<Undo />}
              onClick={this._startOver}
              text={intl.formatMessage({
                id: 'common.forms.startOver'
              })}
            />
            {popupTarget && (
              <AppMenuItem
                icon={<SvgIcon iconName={popupTarget} />}
                onClick={this._triggerPopup}
                text={<PopupTriggerText popupTarget={popupTarget} />}
              />
            )}
            {callTakerEnabled && (
              <AppMenuItem
                icon={<History />}
                onClick={resetAndToggleCallHistory}
                text={intl.formatMessage({
                  id: 'components.AppMenu.callHistory'
                })}
              />
            )}
            {fieldTripEnabled && (
              <AppMenuItem
                icon={<GraduationCap />}
                onClick={resetAndToggleFieldTrips}
                text={intl.formatMessage({
                  id: 'components.AppMenu.fieldTrip'
                })}
              />
            )}
            {mailablesEnabled && (
              <AppMenuItem
                icon={<Envelope />}
                onClick={toggleMailables}
                text={intl.formatMessage({
                  id: 'components.AppMenu.mailables'
                })}
              />
            )}
            <AppMenuItem
              aria-pressed={this.state.diagnosticsOn}
              icon={<Bug />}
              onClick={this._toggleDiagnostics}
              text={
                this.state.diagnosticsOn
                  ? intl.formatMessage({
                      defaultMessage: 'Share diagnostics: On',
                      id: 'components.AppMenu.shareDiagnosticsOn'
                    })
                  : intl.formatMessage({
                      defaultMessage: 'Share diagnostics: Off',
                      id: 'components.AppMenu.shareDiagnosticsOff'
                    })
              }
            />
            {/* The ride console is a page on the server, not part of this app,
                so it cannot read this phone's device id for itself. Opening it
                from here is what hands the id over; the console keeps it, so
                the rider's bookmark works on every later trip. Without it the
                server can only serve whoever reported last — which, with two
                riders out, is the other one. */}
            {showRideConsole && (
              <AppMenuItem
                href={`${rideConsoleUrl}?device=${encodeURIComponent(
                  getDeviceId() as string
                )}`}
                icon={<ExternalLinkSquareAlt />}
                text={intl.formatMessage({
                  defaultMessage: 'Open ride console',
                  id: 'components.AppMenu.openRideConsole'
                })}
              />
            )}
            {this._addExtraMenuItems(extraMenuItems, translateExternalLinks)}
            {this._addExtraMenuItems(languageMenuItems)}
            <div className="app-menu-build-info">
              TransitNav {getBuildInfo()}
            </div>
          </div>
        </SlidingPane>
      </>
    )
  }
}

// connect to the redux store

const mapStateToProps = (state: AppReduxState) => {
  const {
    extraMenuItems,
    language,
    popups,
    rideConsoleDeviceIds,
    rideConsoleUrl,
    translateExternalLinks
  } = state.otp.config
  return {
    activeLocale: state.otp.ui.locale,
    callTakerEnabled: isModuleEnabled(state, Modules.CALL_TAKER),
    extraMenuItems,
    fieldTripEnabled: isModuleEnabled(state, Modules.FIELD_TRIP),
    language,
    languageOptions: getLanguageOptions(language),
    mailablesEnabled: isModuleEnabled(state, Modules.MAILABLES),
    popupTarget: popups?.launchers?.sidebarLink,
    rideConsoleDeviceIds,
    rideConsoleUrl,
    translateExternalLinks,
    tripInForeground: Boolean(
      state.otp.goMode?.isActive && !state.otp.goMode?.ui?.backgrounded
    )
  }
}

const mapDispatchToProps = {
  backgroundGoMode: goModeActions.backgroundGoMode,
  resetAndToggleCallHistory: callTakerActions.resetAndToggleCallHistory,
  resetAndToggleFieldTrips: fieldTripActions.resetAndToggleFieldTrips,
  setLocale: uiActions.setLocale,
  setPopupContent: uiActions.setPopupContent,
  startOverFromInitialUrl: uiActions.startOverFromInitialUrl,
  toggleMailables: callTakerActions.toggleMailables
}

export default injectIntl(connect(mapStateToProps, mapDispatchToProps)(AppMenu))

/**
 * Renders a label and icon either from url or font awesome type
 */
export const Icon = ({
  iconType,
  iconUrl
}: {
  iconType?: string
  iconUrl?: string
}): JSX.Element => {
  // FIXME: add types to context
  // @ts-expect-error No type on ComponentContext
  const { SvgIcon } = useContext(ComponentContext)
  return iconUrl ? (
    <img alt="" src={iconUrl} />
  ) : iconType ? (
    <SvgIcon iconName={iconType} />
  ) : (
    <ExternalLinkSquareAlt />
  )
}
