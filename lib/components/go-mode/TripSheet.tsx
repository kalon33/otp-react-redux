import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React, { useState } from 'react'
import type { Itinerary, Leg } from '@opentripplanner/types'

import * as goModeActions from '../../actions/go-mode'
import * as routingProfileActions from '../../actions/routing-profiles'
import { getModeIcon } from '../../util/go-mode/mode-icon'
import type { GoModeState } from '../../reducers/go-mode'
import type { TripProgress } from '../../util/go-mode/progress-calculator'

import {
  AltRow,
  AltSwitchButton,
  BoardingOverlay,
  BoardingSheet,
  BoardingTitle,
  LegIcon,
  LegInfo,
  LegRow,
  LegSubtitle,
  LegTitle,
  RerouteButton,
  RerouteCardTitle,
  RerouteChip,
  RerouteChips,
  RerouteNlError,
  RerouteNlInput,
  RerouteNlRow,
  RerouteSendButton,
  RerouteSummary,
  SheetCloseButton,
  SheetHeader,
  SheetSectionTitle,
  StopDot,
  StopList,
  StopRow,
  VehicleDetail,
  VehicleInfo,
  VehicleLabel
} from './styled'

// Quick mid-trip re-route options; each maps to a pre-built routing profile.
const REROUTE_CHIPS = [
  { label: 'Less walking', profileId: 'minimize-walking' },
  { label: 'Fewer transfers', profileId: 'stay-seated' },
  { label: 'Avoid biking', profileId: 'avoid-biking' },
  { label: 'Fastest', profileId: 'fastest' }
]

const TRANSIT_MODES = new Set(['BUS', 'FERRY', 'RAIL', 'SUBWAY', 'TRAM'])

interface Props {
  activeItinerary: Itinerary | null
  beginGoMode: (itinerary: any) => void
  fetchPreferencesFromText: (text: string) => Promise<any>
  onClose: () => void
  progress: TripProgress | null
  reRouteCandidates: Itinerary[]
  reRouteFromCurrentPosition: (options?: {
    preferences?: any
    profileId?: string
  }) => void
  reRouteStatus: GoModeState['reRoute']['status']
}

/**
 * Slide-up sheet the rider opens mid-trip to (a) see the rest of their journey
 * as a list and (b) browse alternative routes — all without leaving the active
 * Go Mode route, which keeps running on the map underneath. Closing the sheet
 * never tears down the trip; only an explicit "Switch" swaps routes.
 */
const TripSheet = ({
  activeItinerary,
  beginGoMode,
  fetchPreferencesFromText,
  onClose,
  progress,
  reRouteCandidates,
  reRouteFromCurrentPosition,
  reRouteStatus
}: Props) => {
  const intl = useIntl()
  const [rerouteText, setRerouteText] = useState('')
  const [nlBusy, setNlBusy] = useState(false)
  const [nlError, setNlError] = useState(false)

  const legs = activeItinerary?.legs || []
  const currentLegIndex = progress?.currentLegIndex ?? 0

  const legTitle = (leg: Leg): string => {
    if (TRANSIT_MODES.has(leg.mode)) {
      return leg.routeShortName || leg.routeLongName || leg.mode
    }
    if (leg.mode === 'WALK') {
      return intl.formatMessage({
        defaultMessage: 'Walk',
        id: 'components.GoMode.legWalk'
      })
    }
    if (leg.mode === 'BICYCLE') {
      return intl.formatMessage({
        defaultMessage: 'Bike',
        id: 'components.GoMode.legBike'
      })
    }
    return leg.mode
  }

  // For the current transit leg, list its remaining stops with the rider's
  // position highlighted. progress.stopsRemaining counts the stops still ahead
  // (intermediate + destination); a stop's position-from-end tells us whether
  // it's passed, the one being approached next, or still upcoming.
  const renderCurrentStops = (leg: Leg) => {
    const stops = leg.intermediateStops || []
    if (stops.length === 0) return null
    const k = stops.length
    const remaining = progress?.stopsRemaining ?? k + 1
    return (
      <StopList>
        {stops.map((stop: any, i: number) => {
          const positionFromEnd = k - i + 1 // destination = 1
          const passed = positionFromEnd > remaining
          const next = positionFromEnd === remaining
          return (
            <StopRow $next={next} $passed={passed} key={i}>
              <StopDot $next={next} $passed={passed} />
              {stop.name}
            </StopRow>
          )
        })}
        <StopRow $next={remaining === 1}>
          <StopDot $next={remaining === 1} />
          {leg.to.name}
        </StopRow>
      </StopList>
    )
  }

  const handleChip = (profileId: string) => {
    reRouteFromCurrentPosition({ profileId })
  }

  const handleFindAnotherWay = () => {
    reRouteFromCurrentPosition()
  }

  const handleSwitch = (itinerary: Itinerary) => {
    // beginGoMode restarts tracking and resets re-route state for the new route.
    onClose()
    beginGoMode(itinerary)
  }

  const handleSendMessage = async () => {
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

  const formatSummary = (itin: Itinerary): string =>
    intl.formatMessage(
      {
        defaultMessage:
          '{minutes} min · {transfers, plural, one {# transfer} other {# transfers}} · {walk} m walk',
        id: 'components.GoMode.rerouteSummary'
      },
      {
        minutes: Math.round(itin.duration / 60),
        transfers: (itin as any).transfers ?? 0,
        walk: Math.round(itin.walkDistance ?? 0)
      }
    )

  return (
    <>
      <BoardingOverlay onClick={onClose} />
      <BoardingSheet
        aria-label={intl.formatMessage({
          defaultMessage: 'Trip overview',
          id: 'components.GoMode.tripSheetTitle'
        })}
        role="dialog"
      >
        <SheetHeader>
          <BoardingTitle>
            {intl.formatMessage({
              defaultMessage: 'Your trip',
              id: 'components.GoMode.tripSheetHeading'
            })}
          </BoardingTitle>
          <SheetCloseButton
            aria-label={intl.formatMessage({ id: 'common.forms.close' })}
            onClick={onClose}
            type="button"
          >
            ×
          </SheetCloseButton>
        </SheetHeader>

        {/* Section A — rest of the trip */}
        <SheetSectionTitle>
          {intl.formatMessage({
            defaultMessage: 'Rest of your trip',
            id: 'components.GoMode.restOfTrip'
          })}
        </SheetSectionTitle>
        {legs.map((leg: Leg, i: number) => {
          const isCurrent = i === currentLegIndex
          const isTransit = TRANSIT_MODES.has(leg.mode)
          const stopCount = (leg.intermediateStops?.length ?? 0) + 1
          return (
            <LegRow $current={isCurrent} $dim={i < currentLegIndex} key={i}>
              <LegIcon>{getModeIcon(leg.mode)}</LegIcon>
              <LegInfo>
                <LegTitle>{legTitle(leg)}</LegTitle>
                <LegSubtitle>
                  {isTransit
                    ? intl.formatMessage(
                        {
                          defaultMessage:
                            '{count, plural, one {# stop} other {# stops}} to {dest}',
                          id: 'components.GoMode.legStopsTo'
                        },
                        { count: stopCount, dest: leg.to.name }
                      )
                    : intl.formatMessage(
                        {
                          defaultMessage: 'to {dest}',
                          id: 'components.GoMode.legTo'
                        },
                        { dest: leg.to.name }
                      )}
                </LegSubtitle>
                {isCurrent && isTransit && renderCurrentStops(leg)}
              </LegInfo>
            </LegRow>
          )
        })}

        {/* Section B — find another way (browsable alternatives) */}
        <SheetSectionTitle>
          {intl.formatMessage({
            defaultMessage: 'Find another way',
            id: 'components.GoMode.findAnotherWay'
          })}
        </SheetSectionTitle>
        <RerouteButton
          disabled={reRouteStatus === 'searching'}
          onClick={handleFindAnotherWay}
          type="button"
        >
          {intl.formatMessage({
            defaultMessage: 'Search from my current position',
            id: 'components.GoMode.rerouteSearchHere'
          })}
        </RerouteButton>
        <RerouteChips>
          {REROUTE_CHIPS.map((chip) => (
            <RerouteChip
              disabled={reRouteStatus === 'searching'}
              key={chip.profileId}
              onClick={() => handleChip(chip.profileId)}
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
              if (e.key === 'Enter') handleSendMessage()
            }}
            placeholder={intl.formatMessage({
              defaultMessage: 'e.g. avoid stairs today',
              id: 'components.GoMode.rerouteNlPlaceholder'
            })}
            value={rerouteText}
          />
          <RerouteSendButton
            disabled={nlBusy || !rerouteText.trim()}
            onClick={handleSendMessage}
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

        {reRouteStatus === 'searching' && (
          <RerouteCardTitle>
            {intl.formatMessage({
              defaultMessage: 'Finding a better route…',
              id: 'components.GoMode.rerouteSearching'
            })}
          </RerouteCardTitle>
        )}
        {reRouteStatus === 'found' &&
          reRouteCandidates.map((itin, i) => (
            <AltRow key={i}>
              <VehicleInfo>
                <VehicleLabel>
                  {intl.formatMessage(
                    {
                      defaultMessage: 'Option {n}',
                      id: 'components.GoMode.altOption'
                    },
                    { n: i + 1 }
                  )}
                </VehicleLabel>
                <VehicleDetail>{formatSummary(itin)}</VehicleDetail>
              </VehicleInfo>
              <AltSwitchButton onClick={() => handleSwitch(itin)} type="button">
                {intl.formatMessage({
                  defaultMessage: 'Switch',
                  id: 'components.GoMode.rerouteSwitch'
                })}
              </AltSwitchButton>
            </AltRow>
          ))}
        {(reRouteStatus === 'none' || reRouteStatus === 'error') && (
          <RerouteCardTitle>
            {intl.formatMessage({
              defaultMessage: 'No better route right now',
              id: 'components.GoMode.rerouteNone'
            })}
          </RerouteCardTitle>
        )}
      </BoardingSheet>
    </>
  )
}

const mapStateToProps = (state: any) => {
  const goMode = state.otp.goMode
  return {
    activeItinerary: goMode?.activeItinerary || null,
    progress: goMode?.progress || null,
    reRouteCandidates: goMode?.reRoute?.candidates || [],
    reRouteStatus: goMode?.reRoute?.status || 'idle'
  }
}

const mapDispatchToProps = {
  beginGoMode: goModeActions.beginGoMode,
  fetchPreferencesFromText: routingProfileActions.fetchPreferencesFromText,
  reRouteFromCurrentPosition: goModeActions.reRouteFromCurrentPosition
}

export default connect(mapStateToProps, mapDispatchToProps)(TripSheet)
