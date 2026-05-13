import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React, { useEffect, useState } from 'react'

import * as goModeActions from '../../actions/go-mode'
import * as uiActions from '../../actions/ui'
import { MobileScreens } from '../../actions/ui-constants'
import MobileNavigationBar from '../mobile/navigation-bar'
import type { GoModeState } from '../../reducers/go-mode'

import {
  ErrorMessage,
  FullScreenWrapper,
  GpsWarningBanner,
  LoadingMessage,
  RetryButton,
  ScreenMain,
  SimButton,
  SimProgress,
  SimSpeedSelect,
  SimToggle,
  SimToolbar
} from './styled'
import BoardingPrompt from './BoardingPrompt'
import CurrentLegPanel from './CurrentLegPanel'
import GoModeMap from './GoModeMap'
import GoModeNotifications from './GoModeNotifications'

interface Props {
  beginGoMode: (itinerary: any) => void
  boardingStopData: any
  departureOverride: number | null
  endGoMode: () => void
  goMode: GoModeState
  pauseGpsSimulation: () => void
  resumeGpsSimulation: () => void
  setDepartureOverride: (epochMs: number | null) => void
  setMobileScreen: (screen: number) => void
  startGpsSimulation: (speedMultiplier?: number) => void
  stopGpsSimulation: () => void
}

const GoModeScreen = ({
  beginGoMode,
  boardingStopData,
  departureOverride,
  endGoMode,
  goMode,
  pauseGpsSimulation,
  resumeGpsSimulation,
  setDepartureOverride,
  setMobileScreen,
  startGpsSimulation,
  stopGpsSimulation
}: Props) => {
  const intl = useIntl()
  const [simSpeed, setSimSpeed] = useState(2)
  const [simToolbarOpen, setSimToolbarOpen] = useState(true)

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

  // Navigation exit protection: warn on page unload and cleanup on unmount
  useEffect(() => {
    if (!goMode.isActive) return

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      // Clean up tracking if component unmounts while active
      endGoMode()
    }
  }, [goMode.isActive, endGoMode])

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

  const handleRetry = () => {
    if (goMode.activeItinerary) {
      endGoMode()
      beginGoMode(goMode.activeItinerary)
    }
  }

  // GPS error state with specific messages and retry
  if (goMode.tracking.error && !goMode.progress) {
    const error = goMode.tracking.error
    let errorMessage: string
    if (error.code === 1) {
      errorMessage = intl.formatMessage({
        defaultMessage:
          'Location permission denied. Please enable location access in your browser settings.',
        id: 'components.GoMode.errorPermissionDenied'
      })
    } else if (error.code === 3) {
      errorMessage = intl.formatMessage({
        defaultMessage:
          'GPS signal timed out. Please ensure you are in an area with GPS coverage.',
        id: 'components.GoMode.errorTimeout'
      })
    } else {
      errorMessage = intl.formatMessage({
        defaultMessage:
          'Unable to determine your location. Please check your device settings.',
        id: 'components.GoMode.errorUnavailable'
      })
    }

    return (
      <FullScreenWrapper>
        <MobileNavigationBar
          headerText={intl.formatMessage({
            defaultMessage: 'GPS Error',
            id: 'components.GoMode.gpsErrorTitle'
          })}
          onBackClicked={handleExit}
          showBackButton
        />
        <LoadingMessage>
          <ErrorMessage>{errorMessage}</ErrorMessage>
          <RetryButton onClick={handleRetry} type="button">
            {intl.formatMessage({
              defaultMessage: 'Retry',
              id: 'components.GoMode.retry'
            })}
          </RetryButton>
        </LoadingMessage>
      </FullScreenWrapper>
    )
  }

  if (!goMode.activeItinerary || !goMode.progress) {
    return (
      <FullScreenWrapper>
        <MobileNavigationBar
          headerText={intl.formatMessage({
            defaultMessage: 'Starting Trip...',
            id: 'components.GoMode.loading'
          })}
          onBackClicked={handleExit}
          showBackButton
        />
        <LoadingMessage>
          <p>
            {intl.formatMessage({
              defaultMessage: 'Acquiring GPS signal...',
              id: 'components.GoMode.waitingGPS'
            })}
          </p>
        </LoadingMessage>
      </FullScreenWrapper>
    )
  }

  const currentLeg =
    goMode.activeItinerary.legs[goMode.progress.currentLegIndex]

  const TRANSIT_MODES = new Set(['BUS', 'FERRY', 'RAIL', 'SUBWAY', 'TRAM'])
  const isTransit = TRANSIT_MODES.has(currentLeg.mode)

  return (
    <FullScreenWrapper>
      <MobileNavigationBar
        headerText={isTransit ? currentLeg.to.name : ''}
        onBackClicked={handleExit}
        showBackButton
      />
      <ScreenMain>
        <CurrentLegPanel
          boardingStopData={boardingStopData}
          departureOverride={departureOverride}
          leg={currentLeg}
          nextLeg={
            goMode.progress.currentLegIndex <
            goMode.activeItinerary.legs.length - 1
              ? goMode.activeItinerary.legs[goMode.progress.currentLegIndex + 1]
              : undefined
          }
          onSelectDeparture={setDepartureOverride}
          progress={goMode.progress}
        />

        <GoModeMap
          currentLegIndex={goMode.progress.currentLegIndex}
          currentPosition={goMode.tracking.lastPosition}
          followUser={goMode.ui.mapFollowUser}
          itinerary={goMode.activeItinerary}
          routeMatch={goMode.routeMatch}
        />

        {goMode.tracking.error && (
          <GpsWarningBanner>
            {intl.formatMessage({
              defaultMessage: 'GPS signal lost. Trying to reconnect...',
              id: 'components.GoMode.gpsError'
            })}
          </GpsWarningBanner>
        )}

        {process.env.NODE_ENV !== 'production' && (
          <>
            <SimToggle
              aria-label="Toggle simulation toolbar"
              onClick={() => setSimToolbarOpen(!simToolbarOpen)}
            >
              {simToolbarOpen ? 'DEV ▼' : 'DEV ▲'}
            </SimToggle>
            {simToolbarOpen && (
              <SimToolbar aria-label="GPS simulation controls" role="toolbar">
                {goMode.simulation.status === 'idle' && (
                  <>
                    <SimSpeedSelect
                      aria-label="Simulation speed"
                      onChange={(e) => setSimSpeed(Number(e.target.value))}
                      value={simSpeed}
                    >
                      <option value={1}>1x</option>
                      <option value={2}>2x</option>
                      <option value={5}>5x</option>
                    </SimSpeedSelect>
                    <SimButton
                      $variant="start"
                      aria-label="Start GPS simulation"
                      onClick={() => startGpsSimulation(simSpeed)}
                    >
                      Simulate GPS
                    </SimButton>
                  </>
                )}
                {goMode.simulation.status === 'running' && (
                  <>
                    <SimButton
                      $variant="pause"
                      aria-label="Pause GPS simulation"
                      onClick={pauseGpsSimulation}
                    >
                      Pause
                    </SimButton>
                    <SimButton
                      $variant="stop"
                      aria-label="Stop GPS simulation"
                      onClick={stopGpsSimulation}
                    >
                      Stop
                    </SimButton>
                    <SimProgress>
                      point {goMode.simulation.pointIndex}/
                      {goMode.simulation.totalPoints} (
                      {goMode.simulation.speedMultiplier}x)
                    </SimProgress>
                    {goMode.progress?.currentTime && (
                      <SimProgress aria-label="Simulated clock">
                        {'\u{1F550}'}{' '}
                        {goMode.progress.currentTime.toLocaleTimeString()}
                      </SimProgress>
                    )}
                  </>
                )}
                {goMode.simulation.status === 'paused' && (
                  <>
                    <SimButton
                      $variant="resume"
                      aria-label="Resume GPS simulation"
                      onClick={resumeGpsSimulation}
                    >
                      Resume
                    </SimButton>
                    <SimButton
                      $variant="stop"
                      aria-label="Stop GPS simulation"
                      onClick={stopGpsSimulation}
                    >
                      Stop
                    </SimButton>
                    <SimProgress>
                      paused at {goMode.simulation.pointIndex}/
                      {goMode.simulation.totalPoints}
                    </SimProgress>
                    {goMode.progress?.currentTime && (
                      <SimProgress aria-label="Simulated clock">
                        {'\u{1F550}'}{' '}
                        {goMode.progress.currentTime.toLocaleTimeString()}
                      </SimProgress>
                    )}
                  </>
                )}
              </SimToolbar>
            )}
          </>
        )}
      </ScreenMain>
      <BoardingPrompt />
    </FullScreenWrapper>
  )
}

const mapStateToProps = (state: any) => {
  const goMode = state.otp.goMode
  let boardingStopData = null

  // When on a walking/biking leg approaching transit, look up stop data
  if (goMode?.isActive && goMode?.progress && goMode?.activeItinerary) {
    const legs = goMode.activeItinerary.legs
    const currentLegIndex = goMode.progress.currentLegIndex
    const currentLeg = legs[currentLegIndex]
    const nextLeg =
      currentLegIndex < legs.length - 1 ? legs[currentLegIndex + 1] : undefined

    if (
      currentLeg &&
      (currentLeg.mode === 'WALK' || currentLeg.mode === 'BICYCLE') &&
      nextLeg?.transitLeg &&
      (nextLeg as any).from?.stopId
    ) {
      const stopId = (nextLeg as any).from.stopId
      boardingStopData = state.otp.transitIndex?.stops?.[stopId] || null
    }
  }

  return {
    boardingStopData,
    departureOverride: goMode?.departureOverride ?? null,
    goMode
  }
}

const mapDispatchToProps = {
  beginGoMode: goModeActions.beginGoMode,
  endGoMode: goModeActions.endGoMode,
  pauseGpsSimulation: goModeActions.pauseGpsSimulation,
  resumeGpsSimulation: goModeActions.resumeGpsSimulation,
  setDepartureOverride: goModeActions.setDepartureOverride,
  setMobileScreen: uiActions.setMobileScreen,
  startGpsSimulation: goModeActions.startGpsSimulation,
  stopGpsSimulation: goModeActions.stopGpsSimulation
}

export default connect(mapStateToProps, mapDispatchToProps)(GoModeScreen)
