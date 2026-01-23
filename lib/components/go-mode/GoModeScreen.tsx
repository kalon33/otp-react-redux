import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React, { useEffect } from 'react'

import * as goModeActions from '../../actions/go-mode'
import * as uiActions from '../../actions/ui'
import { MobileScreens } from '../../actions/ui-constants'
import MobileContainer from '../mobile/container'
import MobileNavigationBar from '../mobile/navigation-bar'
import type { GoModeState } from '../../reducers/go-mode'

import CurrentLegPanel from './CurrentLegPanel'
import GoModeHeader from './GoModeHeader'
import GoModeMap from './GoModeMap'

interface Props {
  endGoMode: () => void
  goMode: GoModeState
  setMobileScreen: (screen: number) => void
}

const GoModeScreen = ({ endGoMode, goMode, setMobileScreen }: Props) => {
  const intl = useIntl()

  useEffect(() => {
    // If Go Mode is not active, redirect back to results
    if (!goMode.isActive || !goMode.activeItinerary) {
      setMobileScreen(MobileScreens.RESULTS_SUMMARY)
    }
  }, [goMode.isActive, goMode.activeItinerary, setMobileScreen])

  useEffect(() => {
    // Request wake lock to keep screen on
    if ('wakeLock' in navigator && goMode.isActive) {
      let wakeLock: any = null

      const requestWakeLock = async () => {
        try {
          wakeLock = await (navigator as any).wakeLock.request('screen')
        } catch (err) {
          console.warn('Wake lock request failed:', err)
        }
      }

      requestWakeLock()

      return () => {
        if (wakeLock) {
          wakeLock.release()
        }
      }
    }
  }, [goMode.isActive])

  const handleExit = () => {
    if (
      window.confirm(
        intl.formatMessage({
          defaultMessage: 'Are you sure you want to stop tracking this trip?',
          id: 'components.GoMode.confirmExit'
        })
      )
    ) {
      endGoMode()
      setMobileScreen(MobileScreens.RESULTS_SUMMARY)
    }
  }

  if (!goMode.activeItinerary || !goMode.progress) {
    return (
      <MobileContainer>
        <MobileNavigationBar
          headerText={intl.formatMessage({
            defaultMessage: 'Starting Trip...',
            id: 'components.GoMode.loading'
          })}
          onBackClicked={handleExit}
          showBackButton
        />
        <main style={{ padding: '20px', textAlign: 'center' }}>
          <p>
            {intl.formatMessage({
              defaultMessage: 'Acquiring GPS signal...',
              id: 'components.GoMode.waitingGPS'
            })}
          </p>
        </main>
      </MobileContainer>
    )
  }

  const currentLeg =
    goMode.activeItinerary.legs[goMode.progress.currentLegIndex]

  return (
    <MobileContainer>
      <MobileNavigationBar
        headerText={intl.formatMessage({
          defaultMessage: 'Trip in Progress',
          id: 'components.GoMode.header'
        })}
        onBackClicked={handleExit}
        showBackButton
      />
      <main
        style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      >
        <GoModeHeader
          itinerary={goMode.activeItinerary}
          onExit={handleExit}
          progress={goMode.progress}
        />

        <GoModeMap
          currentLegIndex={goMode.progress.currentLegIndex}
          currentPosition={goMode.tracking.lastPosition}
          followUser={goMode.ui.mapFollowUser}
          itinerary={goMode.activeItinerary}
          routeMatch={goMode.routeMatch}
        />

        <CurrentLegPanel
          leg={currentLeg}
          nextLeg={
            goMode.progress.currentLegIndex <
            goMode.activeItinerary.legs.length - 1
              ? goMode.activeItinerary.legs[goMode.progress.currentLegIndex + 1]
              : undefined
          }
          progress={goMode.progress}
        />

        {goMode.tracking.error && (
          <div
            style={{
              background: '#ff9800',
              color: 'white',
              padding: '10px',
              textAlign: 'center'
            }}
          >
            {intl.formatMessage({
              defaultMessage: 'GPS signal lost. Trying to reconnect...',
              id: 'components.GoMode.gpsError'
            })}
          </div>
        )}
      </main>
    </MobileContainer>
  )
}

const mapStateToProps = (state: any) => {
  return {
    goMode: state.otp.goMode
  }
}

const mapDispatchToProps = {
  endGoMode: goModeActions.endGoMode,
  setMobileScreen: uiActions.setMobileScreen
}

export default connect(mapStateToProps, mapDispatchToProps)(GoModeScreen)
