import { useIntl } from 'react-intl'
import React from 'react'
import type { Itinerary, Leg } from '@opentripplanner/types'

import type { TripProgress } from '../../util/go-mode/progress-calculator'

import {
  ETALabel,
  ETAValue,
  HeaderContainer,
  HeaderRow,
  ProgressBarFill,
  ProgressBarTrack,
  TimeRemainingValue
} from './styled'

interface Props {
  itinerary: Itinerary
  onExit: () => void
  progress: TripProgress
}

type Urgency = 'ok' | 'tight' | 'late'

const URGENCY_COLORS: Record<Urgency, string> = {
  late: '#c62828',
  ok: '#2e7d32',
  tight: '#e65100'
}

const GoModeHeader = ({ itinerary, onExit, progress }: Props) => {
  const intl = useIntl()

  const currentLeg: Leg | undefined = itinerary.legs[progress.currentLegIndex]
  const nextLeg: Leg | undefined = itinerary.legs[progress.currentLegIndex + 1]

  const isTransitMode = (mode: string): boolean =>
    mode === 'BUS' || mode === 'RAIL' || mode === 'SUBWAY' || mode === 'TRAM'

  const isWalkOrBike = (mode: string): boolean =>
    mode === 'WALK' || mode === 'BICYCLE'

  const getUrgency = (seconds: number): Urgency => {
    if (seconds < 0) return 'late'
    if (seconds < 300) return 'tight'
    return 'ok'
  }

  const formatTimeRemaining = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    if (mins < 1)
      return intl.formatMessage({
        defaultMessage: 'Arriving soon',
        id: 'components.GoMode.arrivingSoon'
      })
    if (mins < 60) {
      return intl.formatMessage(
        {
          defaultMessage: '{mins} min',
          id: 'components.GoMode.minutesRemaining'
        },
        { mins }
      )
    }
    const hours = Math.floor(mins / 60)
    const remainingMins = mins % 60
    return intl.formatMessage(
      {
        defaultMessage: '{hours}h {mins}m',
        id: 'components.GoMode.hoursMinutesRemaining'
      },
      { hours, mins: remainingMins }
    )
  }

  const formatETA = (date: Date): string => {
    return date.toLocaleTimeString(intl.locale, {
      hour: 'numeric',
      minute: '2-digit'
    })
  }

  const formatMinutes = (seconds: number): string => {
    const mins = Math.round(seconds / 60)
    if (mins <= 0) return '<1 min'
    return `${mins} min`
  }

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'on_track':
        return '#4CAF50'
      case 'ahead':
        return '#2196F3'
      case 'behind':
        return '#FF9800'
      case 'deviated':
        return '#F44336'
      case 'completed':
        return '#4CAF50'
      default:
        return '#9E9E9E'
    }
  }

  // Determine what to show in the primary (left) area
  const renderPrimary = (): React.ReactNode => {
    // Walking/biking to a transit leg → show departure countdown
    if (
      currentLeg &&
      isWalkOrBike(currentLeg.mode) &&
      nextLeg &&
      isTransitMode(nextLeg.mode) &&
      progress.timeUntilNextDeparture !== undefined
    ) {
      const routeName = nextLeg.routeShortName || nextLeg.routeLongName || 'Bus'
      const urgency = getUrgency(
        progress.waitTimeAtStop ?? progress.timeUntilNextDeparture
      )
      return (
        <div style={{ minWidth: 0, overflow: 'hidden' }}>
          <ETAValue $color={URGENCY_COLORS[urgency]}>
            {intl.formatMessage(
              {
                defaultMessage: '{route} in {time}',
                id: 'components.GoMode.header.routeDepartsIn'
              },
              {
                route: routeName,
                time: formatMinutes(progress.timeUntilNextDeparture)
              }
            )}
          </ETAValue>
          <ETALabel>
            {intl.formatMessage({
              defaultMessage: 'Next Departure',
              id: 'components.GoMode.header.nextDeparture'
            })}
          </ETALabel>
        </div>
      )
    }

    // On transit → show "Get off at [stop]" with arrival time
    if (currentLeg && isTransitMode(currentLeg.mode)) {
      const stopName = currentLeg.to.name
      const arrivalTime = progress.destinationArrivalTime
        ? formatETA(new Date(progress.destinationArrivalTime))
        : ''
      return (
        <div style={{ minWidth: 0, overflow: 'hidden' }}>
          <ETAValue>
            {arrivalTime
              ? intl.formatMessage(
                  {
                    defaultMessage: 'Off at {time}',
                    id: 'components.GoMode.header.getOffAtTime'
                  },
                  { time: arrivalTime }
                )
              : stopName}
          </ETAValue>
          <ETALabel>
            {intl.formatMessage(
              {
                defaultMessage: 'Get off at {stop}',
                id: 'components.GoMode.header.getOffAt'
              },
              { stop: stopName }
            )}
          </ETALabel>
        </div>
      )
    }

    // Default (final walk or no transit) → estimated arrival
    return (
      <div style={{ minWidth: 0, overflow: 'hidden' }}>
        <ETAValue>{formatETA(progress.estimatedArrival)}</ETAValue>
        <ETALabel>
          {intl.formatMessage({
            defaultMessage: 'Estimated Arrival',
            id: 'components.GoMode.estimatedArrival'
          })}
        </ETALabel>
      </div>
    )
  }

  return (
    <HeaderContainer>
      {/* Progress Bar */}
      <ProgressBarTrack>
        <ProgressBarFill
          $color={getStatusColor(progress.status)}
          $width={progress.overallProgress}
        />
      </ProgressBarTrack>

      {/* Context-aware primary info + Time Remaining */}
      <HeaderRow>
        {renderPrimary()}

        <div style={{ flexShrink: 0, textAlign: 'right' }}>
          <TimeRemainingValue>
            {formatTimeRemaining(progress.timeRemaining)}
          </TimeRemainingValue>
          <ETALabel>
            {intl.formatMessage({
              defaultMessage: 'remaining',
              id: 'components.GoMode.remaining'
            })}
          </ETALabel>
        </div>
      </HeaderRow>
    </HeaderContainer>
  )
}

export default GoModeHeader
