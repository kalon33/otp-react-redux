import { useIntl } from 'react-intl'
import React from 'react'
import type { Leg } from '@opentripplanner/types'

import type { TripProgress } from '../../util/go-mode/progress-calculator'

interface Props {
  leg: Leg
  progress: TripProgress
}

const TransitProgress = ({ leg, progress }: Props) => {
  const intl = useIntl()

  const getModeIcon = (mode: string): string => {
    switch (mode) {
      case 'BUS':
        return '🚌'
      case 'RAIL':
        return '🚆'
      case 'SUBWAY':
        return '🚇'
      case 'TRAM':
        return '🚊'
      default:
        return '🚌'
    }
  }

  const shouldShowAlert =
    progress.stopsRemaining === 2 || progress.stopsRemaining === 1

  return (
    <div style={{ padding: '16px' }}>
      {/* Route Header */}
      <div
        style={{ alignItems: 'center', display: 'flex', marginBottom: '16px' }}
      >
        <span style={{ fontSize: '32px', marginRight: '12px' }}>
          {getModeIcon(leg.mode)}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '18px', fontWeight: 'bold' }}>
            {leg.routeShortName || leg.routeLongName}
          </div>
          <div style={{ color: '#666', fontSize: '14px' }}>
            {intl.formatMessage(
              {
                defaultMessage: 'to {destination}',
                id: 'components.GoMode.routeDirection'
              },
              { destination: leg.to.name }
            )}
          </div>
        </div>
      </div>

      {/* Get Ready Alert */}
      {shouldShowAlert && (
        <div
          style={{
            animation: 'pulse 1s ease-in-out infinite',
            backgroundColor:
              progress.stopsRemaining === 1 ? '#F44336' : '#FF9800',
            borderRadius: '8px',
            color: 'white',
            fontSize: '16px',
            fontWeight: 'bold',
            marginBottom: '16px',
            padding: '16px',
            textAlign: 'center'
          }}
        >
          {progress.stopsRemaining === 1
            ? intl.formatMessage({
                defaultMessage: '🔔 GET READY! Next stop is yours!',
                id: 'components.GoMode.getReadyNow'
              })
            : intl.formatMessage({
                defaultMessage: '⚠️ Get Ready - 2 stops away',
                id: 'components.GoMode.getReady'
              })}
        </div>
      )}

      {/* Stops Progress */}
      {progress.stopsRemaining !== undefined && progress.stopsRemaining > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <div
            style={{
              color: shouldShowAlert ? '#F44336' : '#2196F3',
              fontSize: '32px',
              fontWeight: 'bold',
              textAlign: 'center'
            }}
          >
            {progress.stopsRemaining}
          </div>
          <div
            style={{
              color: '#666',
              fontSize: '14px',
              textAlign: 'center'
            }}
          >
            {intl.formatMessage(
              {
                defaultMessage:
                  '{count, plural, one {stop} other {stops}} remaining',
                id: 'components.GoMode.stopsRemaining'
              },
              { count: progress.stopsRemaining }
            )}
          </div>
        </div>
      )}

      {/* Next Stop */}
      {progress.nextStopName && (
        <div
          style={{
            backgroundColor: '#f5f5f5',
            borderRadius: '4px',
            marginBottom: '12px',
            padding: '12px'
          }}
        >
          <div style={{ color: '#666', fontSize: '12px', marginBottom: '4px' }}>
            {intl.formatMessage({
              defaultMessage: 'Next Stop',
              id: 'components.GoMode.nextStop'
            })}
          </div>
          <div style={{ fontSize: '16px', fontWeight: '500' }}>
            {progress.nextStopName}
          </div>
        </div>
      )}

      {/* Destination */}
      <div
        style={{
          backgroundColor: '#e3f2fd',
          borderRadius: '4px',
          padding: '12px'
        }}
      >
        <div
          style={{ color: '#1976d2', fontSize: '12px', marginBottom: '4px' }}
        >
          {intl.formatMessage({
            defaultMessage: 'Your Stop',
            id: 'components.GoMode.yourStop'
          })}
        </div>
        <div style={{ color: '#1976d2', fontSize: '16px', fontWeight: '500' }}>
          {leg.to.name}
        </div>
      </div>

      <style>
        {`
        @keyframes pulse {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.8;
          }
        }
      `}
      </style>
    </div>
  )
}

export default TransitProgress
