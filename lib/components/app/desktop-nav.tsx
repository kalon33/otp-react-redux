import { connect } from 'react-redux'
import { isMobile } from '@opentripplanner/core-utils/lib/ui'
import { Nav, Navbar } from 'react-bootstrap'
import { useIntl } from 'react-intl'
import React from 'react'
import styled from 'styled-components'

import * as uiActions from '../../actions/ui'
import { accountLinks, getAuth0Config } from '../../util/auth'
import { AppConfig } from '../../util/config-types'
import { AppReduxState } from '../../util/state-types'
import { DEFAULT_APP_TITLE } from '../../util/constants'
import { isModuleEnabled, Modules } from '../../util/config'
import CallTakerControls from '../admin/call-taker-controls'
import { getBrandTitle } from '../../util/brand'
import InvisibleA11yLabel from '../util/invisible-a11y-label'
import NavLoginButtonAuth0 from '../user/nav-login-button-auth0'

import { NetworkConnectionBanner } from './network-connection-banner'
import AppMenu, { Icon } from './app-menu'
import DiagnosticsNotice from './diagnostics-notice'
import LocaleSelector from './locale-selector'
import NavbarItem from './nav-item'
import ReturnToTripBanner from './return-to-trip-banner'
import ViewSwitcher from './view-switcher'

const StyledNav = styled(Nav)`
  display: flex;
  justify-content: end;
  /* Target only the svgs in the Navbar */
  & > li > button > svg,
  & > li > span > button > span > svg {
    height: 18px;
  }

  & .caret {
    margin-left: 5px;
    margin-right: -10px;
  }

  .navBarItem {
    position: static;
    & > button {
      background: transparent;
      border: none;
      color: white;
      padding: 15px;
      line-height: 20px;

      &:hover {
        background: rgba(0, 0, 0, 0.05);
        color: #ececec;
      }
    }
  }
`

const NavItemOnLargeScreens = styled(NavbarItem)`
  display: block;
  @media (max-width: 768px) {
    display: none !important;
  }
`

// Typscript TODO: otpConfig type
export type Props = {
  callTakerEnabled: boolean
  locale: string
  networkConnectionLost: boolean
  otpConfig: AppConfig
  /** The AppFrame page's own name, shown as the bar title on a phone. */
  pageTitle?: string
  popupTarget?: string
  setPopupContent: (url: string) => void
}

/**
 * The desktop navigation bar, featuring a `branding` logo or a `title` text
 * defined in config.yml, and a sign-in button/menu with account links.
 *
 * The `branding` and `title` parameters in config.yml are handled
 * and shown in this order in the navigation bar:
 * 1. If `branding` is defined, it is shown, and no title is displayed.
 *    (The title is still rendered for screen readers and browsers that lack image support.)
 * 2. If `branding` is not defined but if `title` is, then `title` is shown.
 * 3. If neither is defined (or `title` is the OTP default 'OpenTripPlanner'),
 *    show 'TransitNav' (see util/brand.ts).
 *
 * TODO: merge with the mobile navigation bar.
 */
const DesktopNav = ({
  callTakerEnabled,
  locale,
  networkConnectionLost,
  otpConfig,
  pageTitle,
  popupTarget,
  setPopupContent
}: Props) => {
  const { brandClickable, branding, extraMenuItems, persistence } = otpConfig
  const title = getBrandTitle(otpConfig.title)
  const intl = useIntl()
  const showLogin = Boolean(getAuth0Config(persistence))

  const BrandingElement = brandClickable ? 'a' : 'div'

  const brandingProps = brandClickable && {
    href: '/#/',
    style: {
      display: 'block',
      position: 'relative',
      zIndex: 10
    }
  }
  const popupButtonText =
    popupTarget &&
    intl.formatMessage({
      id: `config.popups.${popupTarget}`
    })

  return (
    <header>
      <Navbar fluid inverse>
        <Navbar.Header
          style={{ position: 'relative', width: '100%', zIndex: 2 }}
        >
          <Navbar.Brand>
            <AppMenu />

            {!isMobile() && (
              <>
                {/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */}
                {/* @ts-ignore The dynamic tag is causing some trouble */}
                <BrandingElement
                  className={branding && `with-icon icon-${branding}`}
                  {...brandingProps}
                >
                  {/* A title is always rendered (e.g.for screen readers)
                    but is visually-hidden if a branding icon is used. */}
                  <div className="navbar-title">{title}</div>
                </BrandingElement>
              </>
            )}
          </Navbar.Brand>

          {/* On a phone the brand is hidden (above) and the bar is the page's
              only header, so it names the page — "Settings", "Saved places" —
              or the product on pages that pass no title. aria-hidden: the
              page's own <h1> is what a screen reader announces. */}
          {isMobile() && (
            <div aria-hidden className="navbar-title tn-appbar-title">
              {pageTitle || title}
            </div>
          )}

          <ViewSwitcher />

          <StyledNav pullRight>
            {popupTarget && (
              <NavItemOnLargeScreens
                onClick={() => setPopupContent(popupTarget)}
                title={popupButtonText}
              >
                <Icon iconType={popupTarget} />
                <InvisibleA11yLabel>{popupButtonText}</InvisibleA11yLabel>
              </NavItemOnLargeScreens>
            )}
            <LocaleSelector />
            {showLogin && (
              <NavLoginButtonAuth0
                id="login-control"
                links={accountLinks(extraMenuItems)}
                locale={locale}
                style={{ float: 'right' }}
              />
            )}
            {callTakerEnabled && <CallTakerControls />}
          </StyledNav>
        </Navbar.Header>
      </Navbar>
      <NetworkConnectionBanner networkConnectionLost={networkConnectionLost} />
      <ReturnToTripBanner />
      <DiagnosticsNotice />
    </header>
  )
}

// connect to the redux store
const mapStateToProps = (state: AppReduxState) => {
  const { config: otpConfig } = state.otp
  const { networkConnectionLost } = state.otp.ui.errors
  return {
    callTakerEnabled: isModuleEnabled(state, Modules.CALL_TAKER),
    locale: state.otp.ui.locale,
    networkConnectionLost,
    otpConfig,
    popupTarget: otpConfig.popups?.launchers?.toolbar
  }
}

const mapDispatchToProps = {
  setPopupContent: uiActions.setPopupContent
}

export default connect(mapStateToProps, mapDispatchToProps)(DesktopNav)
