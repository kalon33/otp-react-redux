import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React, { useEffect, useRef, useState } from 'react'

import * as goModeActions from '../../actions/go-mode'
import * as uiActions from '../../actions/ui'
import { getRerouteCandidates, isRerouteSearchSettled } from '../../util/state'
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
  SheetHandle,
  SheetHandleLabel,
  SimButton,
  SimProgress,
  SimSpeedSelect,
  SimToggle,
  SimToolbar
} from './styled'
import AlightRecommendation from './AlightRecommendation'
import BoardingPrompt from './BoardingPrompt'
import CurrentLegPanel from './CurrentLegPanel'
import GoModeMap from './GoModeMap'
import GoModeNotifications from './GoModeNotifications'
import TripSheet from './TripSheet'

interface Props {
  beginGoMode: (itinerary: any) => void
  boardingStopData: any
  departureOverride: number | null
  endGoMode: () => void
  goMode: GoModeState
  pauseGpsSimulation: () => void
  reRouteCandidates: any[]
  reRouteSettled: boolean
  resumeGpsSimulation: () => void
  setDepartureOverride: (epochMs: number | null) => void
  setMobileScreen: (screen: number) => void
  setRerouteResult: (itineraries: any) => void
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
  reRouteCandidates,
  reRouteSettled,
  resumeGpsSimulation,
  setDepartureOverride,
  setMobileScreen,
  setRerouteResult,
  startGpsSimulation,
  stopGpsSimulation
}: Props) => {
  const intl = useIntl()
  const [simSpeed, setSimSpeed] = useState(2)
  const [simToolbarOpen, setSimToolbarOpen] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)

  const onboardActive = goMode.onboard.status !== 'idle'

  // The dev GPS-simulation toolbar overlays the bottom controls, so keep it
  // opt-in even in dev builds. Enable it with ?sim=1 in the URL (or set
  // localStorage.goModeSim = '1'); otherwise it stays hidden.
  const simToolsEnabled =
    process.env.NODE_ENV !== 'production' &&
    typeof window !== 'undefined' &&
    (window.location.search.includes('sim=1') ||
      window.localStorage?.getItem('goModeSim') === '1')

  // Only leave Go Mode once a trip has genuinely ended — never during the entry
  // transition. Bouncing on the first render was kicking riders straight back to
  // results the instant they hit "Start Trip".
  const hasBeenActiveRef = useRef(false)
  useEffect(() => {
    const active =
      goMode.isActive || goMode.activeItinerary != null || onboardActive
    if (active) {
      hasBeenActiveRef.current = true
      return
    }
    // Inactive: redirect back to results only if we were previously in a trip
    // (i.e. it actually ended), not on a spurious early/transient render.
    if (hasBeenActiveRef.current) {
      setMobileScreen(MobileScreens.RESULTS_SUMMARY)
    }
  }, [goMode.isActive, goMode.activeItinerary, onboardActive, setMobileScreen])

  useEffect(() => {
    // Keep the screen awake during a trip. The OS silently RELEASES the wake
    // lock every time the page hides (app switch, brief lock), so a single
    // request is not enough — re-request on every return to visibility, or the
    // screen starts auto-locking again mid-trip and tracking/recording dies
    // with it.
    if ('wakeLock' in navigator && goMode.isActive) {
      let wakeLock: any = null
      let disposed = false

      const requestWakeLock = async () => {
        try {
          wakeLock = await (navigator as any).wakeLock.request('screen')
        } catch (err) {
          console.warn('Wake lock request failed:', err)
        }
      }

      const reacquire = () => {
        if (!disposed && document.visibilityState === 'visible') {
          requestWakeLock()
        }
      }

      requestWakeLock()
      document.addEventListener('visibilitychange', reacquire)

      return () => {
        disposed = true
        document.removeEventListener('visibilitychange', reacquire)
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
      // Do NOT tear down Go Mode here. Unmounting (navigating away, a transient
      // remount) must leave the trip intact so it survives navigation and can be
      // resumed; tracking is torn down only on an explicit exit or completion
      // (handleExit / handleOnboardExit -> endGoMode).
    }
  }, [goMode.isActive])

  // Resolve the re-route search into a browsable list of alternatives (or
  // "none") once results arrive. getRerouteCandidates reads the dedicated
  // re-route search directly.
  useEffect(() => {
    if (goMode.reRoute.status !== 'searching') return
    if (reRouteCandidates.length > 0) {
      setRerouteResult(reRouteCandidates)
    } else if (reRouteSettled) {
      setRerouteResult(null)
    }
  }, [
    goMode.reRoute.status,
    reRouteCandidates,
    reRouteSettled,
    setRerouteResult
  ])

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

  const handleOnboardExit = () => {
    endGoMode()
    setMobileScreen(MobileScreens.SEARCH_FORM)
  }

  // "I'm on the bus" onboard flow: no itinerary yet — show discovery, the bus
  // picker, and the alight-stop recommendation.
  if (onboardActive && !goMode.activeItinerary) {
    return (
      <FullScreenWrapper>
        <MobileNavigationBar
          headerText={intl.formatMessage({
            defaultMessage: 'On the bus',
            id: 'components.GoMode.onboardTitle'
          })}
          onBackClicked={handleOnboardExit}
          showBackButton
        />
        <ScreenMain>
          <AlightRecommendation />
        </ScreenMain>
        <BoardingPrompt />
      </FullScreenWrapper>
    )
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

  return (
    <FullScreenWrapper>
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
          onExit={handleExit}
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

        {!sheetOpen && (
          <SheetHandle
            aria-label={intl.formatMessage({
              defaultMessage: 'Open trip overview',
              id: 'components.GoMode.openTripSheet'
            })}
            onClick={() => setSheetOpen(true)}
            type="button"
          >
            <SheetHandleLabel>
              {intl.formatMessage({
                defaultMessage: 'View trip & other ways',
                id: 'components.GoMode.sheetHandleLabel'
              })}
            </SheetHandleLabel>
          </SheetHandle>
        )}
        {sheetOpen && <TripSheet onClose={() => setSheetOpen(false)} />}
        {simToolsEnabled && (
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

    // The boarding stop times are pre-fetched in beginGoMode keyed by the stop's
    // gtfsId (leg.from.stop.gtfsId). The plan query's leg `from` block exposes
    // the gtfsId under `from.stop.gtfsId` — there is no `from.stopId` — so we
    // must look the store up by the same gtfsId, else boardingStopData is always
    // null and the card silently falls back to OTP's planned (scheduled) time.
    const boardingStopId =
      (nextLeg as any)?.from?.stop?.gtfsId || (nextLeg as any)?.from?.stopId
    if (
      currentLeg &&
      (currentLeg.mode === 'WALK' || currentLeg.mode === 'BICYCLE') &&
      nextLeg?.transitLeg &&
      boardingStopId
    ) {
      boardingStopData = state.otp.transitIndex?.stops?.[boardingStopId] || null
    }
  }

  return {
    boardingStopData,
    departureOverride: goMode?.departureOverride ?? null,
    goMode,
    reRouteCandidates: getRerouteCandidates(state),
    reRouteSettled: isRerouteSearchSettled(state)
  }
}

const mapDispatchToProps = {
  beginGoMode: goModeActions.beginGoMode,
  endGoMode: goModeActions.endGoMode,
  pauseGpsSimulation: goModeActions.pauseGpsSimulation,
  resumeGpsSimulation: goModeActions.resumeGpsSimulation,
  setDepartureOverride: goModeActions.setDepartureOverride,
  setMobileScreen: uiActions.setMobileScreen,
  setRerouteResult: goModeActions.setRerouteResult,
  startGpsSimulation: goModeActions.startGpsSimulation,
  stopGpsSimulation: goModeActions.stopGpsSimulation
}

export default connect(mapStateToProps, mapDispatchToProps)(GoModeScreen)
