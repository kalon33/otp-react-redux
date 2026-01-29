import { useIntl } from 'react-intl'
import React from 'react'
import type { Itinerary } from '@opentripplanner/types'

import type { TripProgress } from '../../util/go-mode/progress-calculator'

import {
  ETALabel,
  ETAValue,
  HeaderContainer,
  HeaderRow,
  ProgressBarFill,
  ProgressBarTrack,
  StatusBadge,
  TimeRemainingValue
} from './styled'

interface Props {
  itinerary: Itinerary
  onExit: () => void
  progress: TripProgress
}

const GoModeHeader = ({ itinerary, onExit, progress }: Props) => {
  const intl = useIntl()

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

  return (
    <HeaderContainer>
      {/* Progress Bar */}
      <ProgressBarTrack>
        <ProgressBarFill
          $color={getStatusColor(progress.status)}
          $width={progress.overallProgress}
        />
      </ProgressBarTrack>

      {/* ETA and Time Remaining */}
      <HeaderRow>
        <div>
          <ETAValue>{formatETA(progress.estimatedArrival)}</ETAValue>
          <ETALabel>
            {intl.formatMessage({
              defaultMessage: 'Estimated Arrival',
              id: 'components.GoMode.estimatedArrival'
            })}
          </ETALabel>
        </div>

        <div style={{ textAlign: 'right' }}>
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

      {/* Status Indicator */}
      {progress.status !== 'on_track' && (
        <StatusBadge $color={getStatusColor(progress.status)}>
          {progress.status === 'ahead' &&
            intl.formatMessage({
              defaultMessage: 'Ahead of schedule',
              id: 'components.GoMode.statusAhead'
            })}
          {progress.status === 'behind' &&
            intl.formatMessage({
              defaultMessage: 'Running behind',
              id: 'components.GoMode.statusBehind'
            })}
          {progress.status === 'deviated' &&
            intl.formatMessage({
              defaultMessage: 'Off route',
              id: 'components.GoMode.statusDeviated'
            })}
          {progress.status === 'completed' &&
            intl.formatMessage({
              defaultMessage: 'Trip completed!',
              id: 'components.GoMode.statusCompleted'
            })}
        </StatusBadge>
      )}
    </HeaderContainer>
  )
}

export default GoModeHeader
