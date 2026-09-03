import { connect } from 'react-redux'
import { CSSTransition, TransitionGroup } from 'react-transition-group'
import { isMobile } from '@opentripplanner/core-utils/lib/ui'
import { useIntl } from 'react-intl'
import React, { useRef } from 'react'
import styled from 'styled-components'

import * as goModeActions from '../../actions/go-mode'
import { MobileScreens } from '../../actions/ui-constants'
import useActiveTripGuards from '../go-mode/use-active-trip-guards'
import type { GoModeState } from '../../reducers/go-mode'

const containerClassname = 'return-to-trip-banner'
const timeout = 250

// Same slide-in recipe as network-connection-banner, in Go Mode live green.
const TransitionStyles = styled.div`
  .${containerClassname} {
    background: #2e7d32;
    border: 0;
    border-left: 1px solid #e7e7e7;
    border-right: 1px solid #e7e7e7;
    color: #fff;
    cursor: pointer;
    font-weight: 600;
    padding: 8px 5px;
    position: absolute;
    text-align: center;
    top: 50px;
    width: 100%;
    // When banner is fully loaded, set z-index higher than nav so we're not seeing the nav border.
    z-index: 26;

    @media (max-width: 768px) {
      border: 0;
    }
  }
  .${containerClassname}-enter {
    opacity: 0;
    transform: translateY(-100%);
  }
  .${containerClassname}-enter-active {
    opacity: 1;
    transform: translateY(0);
    transition: opacity ${timeout}ms ease-in;
  }
  .${containerClassname}-exit {
    opacity: 1;
    transform: translateY(0);
    z-index: 20;
  }
  .${containerClassname}-exit-active {
    opacity: 0;
    transform: translateY(-100%);
    transition: opacity ${timeout}ms ease-in, transform ${timeout}ms ease-in;
    z-index: 20;
  }
`

interface Props {
  goMode: GoModeState
  mobileScreen: number
  returnToGoMode: () => void
}

/**
 * Persistent "you're still on a trip" banner, shown under the nav bar on every
 * screen while an active Go Mode trip is backgrounded (rider browsing the
 * planner). Shows live next-stop/ETA context and returns to the Go Mode
 * screen on tap. Also keeps the active-trip guards (wake lock, reload
 * warning) alive while the Go Mode screen is unmounted.
 */
const ReturnToTripBanner = ({
  goMode,
  mobileScreen,
  returnToGoMode
}: Props): JSX.Element => {
  const intl = useIntl()
  const bannerRef = useRef<HTMLButtonElement>(null)

  // `backgrounded` is the deliberate step-out (backgroundGoMode, the app menu,
  // browseFromCurrentPosition) and stays the primary signal. The second clause
  // is the safety net: on a phone, ANY screen other than Go Mode while a trip
  // is running means the rider is looking at something else and needs a way
  // back, whether or not the code that moved them remembered to arm the flag.
  // On 2026-09-03 (session mtlutz2c-mfb2nx) a from-location change dropped a
  // live trip onto the bare search form with the flag unset and no route back.
  // Desktop is excluded: there the Go Mode screen is chosen by
  // `isActive && !backgrounded` (responsive-webapp), not by mobileScreen, so
  // reading mobileScreen there would show the banner over the trip screen.
  const strandedOnMobile = isMobile() && mobileScreen !== MobileScreens.GO_MODE
  const visible = Boolean(
    goMode?.isActive &&
      goMode.activeItinerary &&
      (goMode.ui?.backgrounded || strandedOnMobile)
  )
  useActiveTripGuards(visible)

  const { arrivedAt, progress } = goMode || {}
  let message: string
  if (arrivedAt != null) {
    message = intl.formatMessage({
      defaultMessage: "You've arrived — tap to finish",
      id: 'components.GoMode.returnBannerArrived'
    })
  } else if (progress?.nextStopName && progress?.estimatedArrival) {
    message = intl.formatMessage(
      {
        defaultMessage:
          'On trip · Next stop {stop} · Arrive {eta} — tap to return',
        id: 'components.GoMode.returnBannerLive'
      },
      {
        eta: new Date(progress.estimatedArrival).toLocaleTimeString(
          intl.locale,
          { hour: 'numeric', minute: '2-digit' }
        ),
        stop: progress.nextStopName
      }
    )
  } else {
    // GPS still (re)acquiring — e.g. right after a reload mid-trip.
    message = intl.formatMessage({
      defaultMessage: 'Trip in progress — tap to return',
      id: 'components.GoMode.returnBannerNoProgress'
    })
  }

  return (
    <TransitionStyles>
      <TransitionGroup style={{ display: 'content' }}>
        {visible && (
          <CSSTransition
            classNames={containerClassname}
            nodeRef={bannerRef}
            timeout={timeout}
          >
            <button
              className={containerClassname}
              onClick={returnToGoMode}
              ref={bannerRef}
              type="button"
            >
              {message}
            </button>
          </CSSTransition>
        )}
      </TransitionGroup>
    </TransitionStyles>
  )
}

const mapStateToProps = (state: any) => ({
  goMode: state.otp.goMode,
  mobileScreen: state.otp.ui.mobileScreen
})

const mapDispatchToProps = {
  returnToGoMode: goModeActions.returnToGoMode
}

export default connect(mapStateToProps, mapDispatchToProps)(ReturnToTripBanner)
