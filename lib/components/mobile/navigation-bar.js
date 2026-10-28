import { ArrowLeft } from '@styled-icons/fa-solid/ArrowLeft'
import { connect } from 'react-redux'
import { injectIntl } from 'react-intl'
import { Navbar } from 'react-bootstrap'
import PropTypes from 'prop-types'
import React, { Component } from 'react'
import styled from 'styled-components'

import * as uiActions from '../../actions/ui'
import { accountLinks, getAuth0Config } from '../../util/auth'
import { ComponentContext } from '../../util/contexts'
import { getBrandTitle } from '../../util/brand'
import { NetworkConnectionBanner } from '../app/network-connection-banner'
import { StyledIconWrapper } from '../util/styledIcon'
import AppMenu from '../app/app-menu'
import LocaleSelector from '../app/locale-selector'
import NavLoginButtonAuth0 from '../../components/user/nav-login-button-auth0'
import PageTitle from '../util/page-title'
import ReturnToTripBanner from '../app/return-to-trip-banner'

const MobileBar = styled.div`
  & > li svg {
    height: 18px;
  }
`

class MobileNavigationBar extends Component {
  static propTypes = {
    auth0Config: PropTypes.object,
    backScreen: PropTypes.number,
    brandTitle: PropTypes.string,
    configLanguages: PropTypes.object,
    defaultMobileTitle: PropTypes.string,
    extraMenuItems: PropTypes.array,
    headerAction: PropTypes.element,
    headerText: PropTypes.string,
    intl: PropTypes.object,
    locale: PropTypes.string,
    networkConnectionLost: PropTypes.bool,
    onBackClicked: PropTypes.func,
    setMobileScreen: PropTypes.func,
    showAppMenu: PropTypes.bool,
    showBackButton: PropTypes.bool
  }

  static contextType = ComponentContext

  _backButtonPressed = () => {
    const { backScreen, onBackClicked } = this.props
    if (backScreen) this.props.setMobileScreen(this.props.backScreen)
    else if (typeof onBackClicked === 'function') onBackClicked()
  }

  render() {
    const {
      auth0Config,
      brandTitle,
      configLanguages,
      defaultMobileTitle,
      extraMenuItems,
      headerAction,
      headerText,
      intl,
      locale,
      networkConnectionLost,
      showAppMenu,
      showBackButton
    } = this.props

    const backButtonText = intl.formatMessage({ id: 'common.forms.back' })

    return (
      <header style={{ height: '50px' }}>
        <Navbar className="mobile-navbar-container" fixedTop fluid>
          <Navbar.Header>
            <Navbar.Brand>
              {/* A back arrow used to REPLACE the app menu, which left every
                  screen that has one — Go Mode most of all — with no way to
                  reach the menu at all. Screens that want both ask for it. */}
              {(showAppMenu || !showBackButton) && <AppMenu />}
              {showBackButton && (
                <button
                  aria-label={backButtonText}
                  className="mobile-back"
                  // On the button, not the icon inside it: the button is the
                  // 44px tap target and a tap on its padding has to count.
                  onClick={this._backButtonPressed}
                  title={backButtonText}
                >
                  <StyledIconWrapper>
                    <ArrowLeft />
                  </StyledIconWrapper>
                </button>
              )}
            </Navbar.Brand>
          </Navbar.Header>

          {/* [] when there is no screen title: PageTitle spreads an array. */}
          <PageTitle title={headerText || []} />
          <div className="mobile-header">
            {headerText ? (
              <h1 className="mobile-header-text">{headerText}</h1>
            ) : (
              // No screen title: show the product name ("TransitNav" unless
              // config.yml sets a title of its own).
              <h1 className="navbar-title mobile-header-brand">
                {defaultMobileTitle || brandTitle}
              </h1>
            )}
          </div>

          {headerAction && (
            <div className="mobile-close">
              <div className="mobile-header-action">{headerAction}</div>
            </div>
          )}

          <MobileBar className="locale-selector-and-login">
            <LocaleSelector configLanguages={configLanguages} />
            {/* HACK: Normally, NavLoginButtonAuth0 should be inside a <Nav> element,
                however, in mobile mode, react-bootstrap's <Nav> causes the
                submenus of this component to be displayed full-screen-width,
                and that behavior is not desired here. */}
            {auth0Config && (
              <NavLoginButtonAuth0
                id="login-control"
                links={accountLinks(extraMenuItems)}
                locale={locale}
              />
            )}
          </MobileBar>
        </Navbar>
        <NetworkConnectionBanner
          networkConnectionLost={networkConnectionLost}
        />
        <ReturnToTripBanner />
      </header>
    )
  }
}

// connect to the redux store

const mapStateToProps = (state) => {
  return {
    auth0Config: getAuth0Config(state.otp.config.persistence),
    brandTitle: getBrandTitle(state.otp.config.title),
    configLanguages: state.otp.config.language,
    extraMenuItems: state.otp?.config?.extraMenuItems,
    locale: state.otp.ui.locale,
    networkConnectionLost: state.otp.ui.errors.networkConnectionLost
  }
}

const mapDispatchToProps = {
  setMobileScreen: uiActions.setMobileScreen
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(injectIntl(MobileNavigationBar))
