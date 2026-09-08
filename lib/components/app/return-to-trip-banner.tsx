import { connect } from 'react-redux'
import { CSSTransition, TransitionGroup } from 'react-transition-group'
import { isMobile } from '@opentripplanner/core-utils/lib/ui'
import { useIntl } from 'react-intl'
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import styled from 'styled-components'

import * as goModeActions from '../../actions/go-mode'
import { liveArrivalMs } from '../../util/go-mode/live-itinerary'
import { MobileScreens } from '../../actions/ui-constants'
import useActiveTripGuards from '../go-mode/use-active-trip-guards'
import type { GoModeState } from '../../reducers/go-mode'

/**
 * The height the banner is currently taking, published so the fixed-position
 * mobile screens underneath can start below it instead of behind it. Read as
 * `calc(50px + var(--return-to-trip-banner-height, 0px))` in mobile.css and in
 * the mobile screens' styled-components; the fallback means nothing moves when
 * no banner is up.
 */
export const BANNER_HEIGHT_VAR = '--return-to-trip-banner-height'

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
    /* Absolute so the banner sits in the strip directly under the fixed nav
       bar. It does NOT get to overlap what is below it: its measured height is
       published as --return-to-trip-banner-height and every mobile screen's top offset
       adds it, so the strip is vacated rather than covered. */
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
  const [bannerHeight, setBannerHeight] = useState(0)

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

  const { activeItinerary, arrivedAt, liveLegTimes, progress } = goMode || {}

  // The SAME arrival the trip sheet prints — the end of buildLiveItinerary's
  // last leg — not `progress.estimatedArrival`.
  //
  // On 2026-09-08 (session mtsvo7ss-4nzccy, 11:29) this banner said "Arrive
  // 11:50 AM" while the sheet said 11:57 and the rider actually arrived at
  // 11:58:08. `progress.estimatedArrival` is `now + timeRemaining`, and
  // timeRemaining is anchored on `liveTripEndMs` = live alight of the current
  // transit leg PLUS the sum of the later legs' `duration`
  // (progress-calculator.ts). A duration sum has no room for the WAIT between
  // legs, so every transfer is silently spent: leg 0 alighted live at 11:41:09,
  // the walk and the 546 ride are 532 s of moving time, and 11:41:09 + 532 s is
  // exactly the 11:50:01 recorded on every tick — the eight minutes standing at
  // the stop for the 546 (boarded 11:51:20) had vanished. buildLiveItinerary
  // anchors instead of summing (72c5296fc), so it keeps the gaps and lands on
  // the sheet's figure. Falls back to estimatedArrival when there is no
  // itinerary to fold live times into.
  const liveArrival =
    (activeItinerary
      ? liveArrivalMs(activeItinerary, liveLegTimes || {})
      : null) ??
    (progress?.estimatedArrival
      ? new Date(progress.estimatedArrival).getTime()
      : null)

  let message: string
  if (arrivedAt != null) {
    message = intl.formatMessage({
      defaultMessage: "You've arrived — tap to finish",
      id: 'components.GoMode.returnBannerArrived'
    })
  } else if (progress?.nextStopName && liveArrival != null) {
    message = intl.formatMessage(
      {
        defaultMessage:
          'On trip · Next stop {stop} · Arrive {eta} — tap to return',
        id: 'components.GoMode.returnBannerLive'
      },
      {
        eta: new Date(liveArrival).toLocaleTimeString(intl.locale, {
          hour: 'numeric',
          minute: '2-digit'
        }),
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

  // Publish the banner's real height so the screens below can start under it.
  // Measured rather than assumed: the copy wraps to two lines on a narrow
  // phone (it did in the 2026-09-08 screenshot), and a hard-coded strip would
  // be wrong on one of the two.
  useLayoutEffect(() => {
    const el = bannerRef.current
    if (!visible || !el) {
      setBannerHeight(0)
      return
    }
    const measure = () => setBannerHeight(el.getBoundingClientRect().height)
    measure()
    const Observer = (
      window as unknown as { ResizeObserver?: typeof ResizeObserver }
    ).ResizeObserver
    if (!Observer) return
    const observer = new Observer(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [visible, message])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty(BANNER_HEIGHT_VAR, `${bannerHeight}px`)
    return () => root.style.setProperty(BANNER_HEIGHT_VAR, '0px')
  }, [bannerHeight])

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
