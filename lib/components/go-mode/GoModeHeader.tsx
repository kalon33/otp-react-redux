import { useIntl } from 'react-intl'
import React from 'react'
import type { Itinerary } from '@opentripplanner/types'

import type { TripProgress } from '../../util/go-mode/progress-calculator'

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
    <div
      style={{
        backgroundColor: '#fff',
        borderBottom: '1px solid #e0e0e0',
        padding: '12px 16px'
      }}
    >
      {/* Progress Bar */}
      <div
        style={{
          backgroundColor: '#E0E0E0',
          borderRadius: '4px',
          height: '8px',
          marginBottom: '12px',
          overflow: 'hidden',
          width: '100%'
        }}
      >
        <div
          style={{
            backgroundColor: getStatusColor(progress.status),
            height: '100%',
            transition: 'width 0.3s ease',
            width: `${progress.overallProgress}%`
          }}
        />
      </div>

      {/* ETA and Time Remaining */}
      <div
        style={{
          alignItems: 'center',
          display: 'flex',
          justifyContent: 'space-between'
        }}
      >
        <div>
          <div style={{ fontSize: '24px', fontWeight: 'bold' }}>
            {formatETA(progress.estimatedArrival)}
          </div>
          <div style={{ color: '#666', fontSize: '12px' }}>
            {intl.formatMessage({
              defaultMessage: 'Estimated Arrival',
              id: 'components.GoMode.estimatedArrival'
            })}
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '18px', fontWeight: '500' }}>
            {formatTimeRemaining(progress.timeRemaining)}
          </div>
          <div style={{ color: '#666', fontSize: '12px' }}>
            {intl.formatMessage({
              defaultMessage: 'remaining',
              id: 'components.GoMode.remaining'
            })}
          </div>
        </div>
      </div>

      {/* Status Indicator */}
      {progress.status !== 'on_track' && (
        <div
          style={{
            backgroundColor: getStatusColor(progress.status),
            borderRadius: '4px',
            color: '#fff',
            fontSize: '12px',
            marginTop: '8px',
            padding: '6px 12px',
            textAlign: 'center'
          }}
        >
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
        </div>
      )}
    </div>
  )
}

export default GoModeHeader
