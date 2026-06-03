import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React, { useEffect, useState } from 'react'

import * as goModeActions from '../../actions/go-mode'
import * as routingProfileActions from '../../actions/routing-profiles'
import * as uiActions from '../../actions/ui'
import {
  getBestAlightOption,
  getRerouteCandidate,
  isOnboardSearchSettled,
  isRerouteSearchSettled
} from '../../util/state'
import { MobileScreens } from '../../actions/ui-constants'
import MobileNavigationBar from '../mobile/navigation-bar'
import type { GoModeState } from '../../reducers/go-mode'

import {
  ErrorMessage,
  FullScreenWrapper,
  GpsWarningBanner,
  LoadingMessage,
  RerouteActions,
  RerouteBar,
  RerouteButton,
  RerouteCard,
  RerouteCardTitle,
  RerouteChip,
  RerouteChips,
  RerouteKeepButton,
  RerouteNlError,
  RerouteNlInput,
  RerouteNlRow,
  RerouteSendButton,
  RerouteSummary,
  RerouteSwitchButton,
  RetryButton,
  ScreenMain,
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

// Quick mid-trip re-route options; each maps to a pre-built routing profile.
const REROUTE_CHIPS = [
  { label: 'Less walking', profileId: 'minimize-walking' },
  { label: 'Fewer transfers', profileId: 'stay-seated' },
  { label: 'Avoid biking', profileId: 'avoid-biking' },
  { label: 'Fastest', profileId: 'fastest' }
]

interface Props {
  beginGoMode: (itinerary: any) => void
  boardingStopData: any
  clearReroute: () => void
  departureOverride: number | null
  endGoMode: () => void
  fetchPreferencesFromText: (text: string) => Promise<any>
  goMode: GoModeState
  onboardBest: any
  onboardSettled: boolean
  pauseGpsSimulation: () => void
  reRouteCandidate: any
  reRouteFromCurrentPosition: (options?: {
    preferences?: any
    profileId?: string
  }) => void
  reRouteSettled: boolean
  resumeGpsSimulation: () => void
  setDepartureOverride: (epochMs: number | null) => void
  setMobileScreen: (screen: number) => void
  setOnboardResult: (result: any) => void
  setRerouteResult: (itinerary: any) => void
  startGpsSimulation: (speedMultiplier?: number) => void
  stopGpsSimulation: () => void
}

const GoModeScreen = ({
  beginGoMode,
  boardingStopData,
  clearReroute,
  departureOverride,
  endGoMode,
  fetchPreferencesFromText,
  goMode,
  onboardBest,
  onboardSettled,
  pauseGpsSimulation,
  reRouteCandidate,
  reRouteFromCurrentPosition,
  reRouteSettled,
  resumeGpsSimulation,
  setDepartureOverride,
  setMobileScreen,
  setOnboardResult,
  setRerouteResult,
  startGpsSimulation,
  stopGpsSimulation
}: Props) => {
  const intl = useIntl()
  const [simSpeed, setSimSpeed] = useState(2)
  const [simToolbarOpen, setSimToolbarOpen] = useState(true)
  const [rerouteText, setRerouteText] = useState('')
  const [nlBusy, setNlBusy] = useState(false)
  const [nlError, setNlError] = useState(false)
  const [rerouteOpen, setRerouteOpen] = useState(false)

  const onboardActive = goMode.onboard.status !== 'idle'

  useEffect(() => {
    // If Go Mode is not active, redirect back to results. The onboard
    // ("I'm on the bus") flow has no itinerary yet, so don't redirect while it
    // is running.
    if (!goMode.isActive || (!goMode.activeItinerary && !onboardActive)) {
      setMobileScreen(MobileScreens.RESULTS_SUMMARY)
    }
  }, [goMode.isActive, goMode.activeItinerary, onboardActive, setMobileScreen])

  // Resolve the alight-stop optimization into a best recommendation once the
  // candidate searches settle (mirrors the re-route resolution below).
  useEffect(() => {
    if (goMode.onboard.status !== 'optimizing') return
    if (onboardBest) {
      setOnboardResult(onboardBest)
    } else if (onboardSettled) {
      setOnboardResult(null)
    }
  }, [goMode.onboard.status, onboardBest, onboardSettled, setOnboardResult])

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

  // Resolve the re-route search into a best candidate (or "none") once results
  // arrive. getRerouteCandidate reads the dedicated re-route search directly.
  useEffect(() => {
    if (goMode.reRoute.status !== 'searching') return
    if (reRouteCandidate) {
      setRerouteResult(reRouteCandidate)
    } else if (reRouteSettled) {
      setRerouteResult(null)
    }
  }, [
    goMode.reRoute.status,
    reRouteCandidate,
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

  const handleFindAnotherWay = () => {
    reRouteFromCurrentPosition()
  }

  const handleSwitchRoute = () => {
    const candidate = goMode.reRoute.candidate
    if (candidate) {
      // beginGoMode restarts tracking and resets re-route state.
      beginGoMode(candidate)
    }
  }

  const handleKeepRoute = () => {
    clearReroute()
  }

  const handleRerouteChip = (profileId: string) => {
    reRouteFromCurrentPosition({ profileId })
  }

  const handleSendRerouteMessage = async () => {
    const text = rerouteText.trim()
    if (!text) return
    setNlBusy(true)
    setNlError(false)
    try {
      const prefs = await fetchPreferencesFromText(text)
      reRouteFromCurrentPosition({ preferences: prefs })
      setRerouteText('')
    } catch {
      setNlError(true)
    } finally {
      setNlBusy(false)
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

  const TRANSIT_MODES = new Set(['BUS', 'FERRY', 'RAIL', 'SUBWAY', 'TRAM'])
  const isTransit = TRANSIT_MODES.has(currentLeg.mode)
  const showNoReroute =
    goMode.reRoute.status === 'none' || goMode.reRoute.status === 'error'

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

        {goMode.reRoute.status === 'idle' && !rerouteOpen && (
          <RerouteBar>
            <RerouteButton onClick={() => setRerouteOpen(true)} type="button">
              {intl.formatMessage({
                defaultMessage: 'Find another way ▾',
                id: 'components.GoMode.findAnotherWayToggle'
              })}
            </RerouteButton>
          </RerouteBar>
        )}
        {goMode.reRoute.status === 'idle' && rerouteOpen && (
          <RerouteBar>
            <RerouteCard>
              <RerouteButton onClick={handleFindAnotherWay} type="button">
                {intl.formatMessage({
                  defaultMessage: 'Find another way',
                  id: 'components.GoMode.findAnotherWay'
                })}
              </RerouteButton>
              <RerouteChips>
                {REROUTE_CHIPS.map((chip) => (
                  <RerouteChip
                    key={chip.profileId}
                    onClick={() => handleRerouteChip(chip.profileId)}
                    type="button"
                  >
                    {chip.label}
                  </RerouteChip>
                ))}
              </RerouteChips>
              <RerouteNlRow>
                <RerouteNlInput
                  aria-label={intl.formatMessage({
                    defaultMessage: 'Describe what you need',
                    id: 'components.GoMode.rerouteNlLabel'
                  })}
                  disabled={nlBusy}
                  onChange={(e) => {
                    setRerouteText(e.target.value)
                    if (nlError) setNlError(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSendRerouteMessage()
                  }}
                  placeholder={intl.formatMessage({
                    defaultMessage: 'e.g. avoid stairs today',
                    id: 'components.GoMode.rerouteNlPlaceholder'
                  })}
                  value={rerouteText}
                />
                <RerouteSendButton
                  disabled={nlBusy || !rerouteText.trim()}
                  onClick={handleSendRerouteMessage}
                  type="button"
                >
                  {nlBusy
                    ? '…'
                    : intl.formatMessage({
                        defaultMessage: 'Go',
                        id: 'components.GoMode.rerouteNlSend'
                      })}
                </RerouteSendButton>
              </RerouteNlRow>
              {nlError && (
                <RerouteNlError>
                  {intl.formatMessage({
                    defaultMessage: "Couldn't read that — try again.",
                    id: 'components.GoMode.rerouteNlError'
                  })}
                </RerouteNlError>
              )}
            </RerouteCard>
          </RerouteBar>
        )}
        {goMode.reRoute.status === 'searching' && (
          <RerouteBar>
            <RerouteCard>
              <RerouteCardTitle>
                {intl.formatMessage({
                  defaultMessage: 'Finding a better route…',
                  id: 'components.GoMode.rerouteSearching'
                })}
              </RerouteCardTitle>
            </RerouteCard>
          </RerouteBar>
        )}
        {goMode.reRoute.status === 'found' && goMode.reRoute.candidate && (
          <RerouteBar>
            <RerouteCard>
              <RerouteCardTitle>
                {intl.formatMessage({
                  defaultMessage: 'Alternative route',
                  id: 'components.GoMode.rerouteFound'
                })}
              </RerouteCardTitle>
              <RerouteSummary>
                {intl.formatMessage(
                  {
                    defaultMessage:
                      '{minutes} min · {transfers, plural, one {# transfer} other {# transfers}} · {walk} m walk',
                    id: 'components.GoMode.rerouteSummary'
                  },
                  {
                    minutes: Math.round(goMode.reRoute.candidate.duration / 60),
                    transfers: goMode.reRoute.candidate.transfers ?? 0,
                    walk: Math.round(goMode.reRoute.candidate.walkDistance ?? 0)
                  }
                )}
              </RerouteSummary>
              <RerouteActions>
                <RerouteSwitchButton onClick={handleSwitchRoute} type="button">
                  {intl.formatMessage({
                    defaultMessage: 'Switch',
                    id: 'components.GoMode.rerouteSwitch'
                  })}
                </RerouteSwitchButton>
                <RerouteKeepButton onClick={handleKeepRoute} type="button">
                  {intl.formatMessage({
                    defaultMessage: 'Keep current',
                    id: 'components.GoMode.rerouteKeep'
                  })}
                </RerouteKeepButton>
              </RerouteActions>
            </RerouteCard>
          </RerouteBar>
        )}
        {showNoReroute && (
          <RerouteBar>
            <RerouteCard>
              <RerouteCardTitle>
                {intl.formatMessage({
                  defaultMessage: 'No better route right now',
                  id: 'components.GoMode.rerouteNone'
                })}
              </RerouteCardTitle>
              <RerouteActions>
                <RerouteKeepButton onClick={handleKeepRoute} type="button">
                  {intl.formatMessage({
                    defaultMessage: 'OK',
                    id: 'components.GoMode.rerouteOk'
                  })}
                </RerouteKeepButton>
              </RerouteActions>
            </RerouteCard>
          </RerouteBar>
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
    goMode,
    onboardBest: getBestAlightOption(state),
    onboardSettled: isOnboardSearchSettled(state),
    reRouteCandidate: getRerouteCandidate(state),
    reRouteSettled: isRerouteSearchSettled(state)
  }
}

const mapDispatchToProps = {
  beginGoMode: goModeActions.beginGoMode,
  clearReroute: goModeActions.clearReroute,
  endGoMode: goModeActions.endGoMode,
  fetchPreferencesFromText: routingProfileActions.fetchPreferencesFromText,
  pauseGpsSimulation: goModeActions.pauseGpsSimulation,
  reRouteFromCurrentPosition: goModeActions.reRouteFromCurrentPosition,
  resumeGpsSimulation: goModeActions.resumeGpsSimulation,
  setDepartureOverride: goModeActions.setDepartureOverride,
  setMobileScreen: uiActions.setMobileScreen,
  setOnboardResult: goModeActions.setOnboardResult,
  setRerouteResult: goModeActions.setRerouteResult,
  startGpsSimulation: goModeActions.startGpsSimulation,
  stopGpsSimulation: goModeActions.stopGpsSimulation
}

export default connect(mapStateToProps, mapDispatchToProps)(GoModeScreen)
