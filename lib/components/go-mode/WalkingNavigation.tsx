import { useIntl } from 'react-intl'
import React from 'react'
import type { Leg } from '@opentripplanner/types'

import type { TripProgress } from '../../util/go-mode/progress-calculator'

interface Props {
  leg: Leg
  nextLeg?: Leg
  progress: TripProgress
}

const WalkingNavigation = ({ leg, nextLeg, progress }: Props) => {
  const intl = useIntl()

  const getModeIcon = (mode: string): string => {
    switch (mode) {
      case 'WALK':
        return '🚶'
      case 'BICYCLE':
        return '🚴'
      default:
        return '🚶'
    }
  }

  const formatDistance = (meters: number): string => {
    if (meters < 100) {
      return intl.formatMessage(
        {
          defaultMessage: '{meters}m',
          id: 'components.GoMode.distanceMeters'
        },
        { meters: Math.round(meters) }
      )
    }
    const km = (meters / 1000).toFixed(1)
    return intl.formatMessage(
      {
        defaultMessage: '{km}km',
        id: 'components.GoMode.distanceKilometers'
      },
      { km }
    )
  }

  const isNearDestination = progress.currentLegProgress > 90

  return (
    <div style={{ padding: '16px' }}>
      {/* Mode Header */}
      <div
        style={{ alignItems: 'center', display: 'flex', marginBottom: '16px' }}
      >
        <span style={{ fontSize: '32px', marginRight: '12px' }}>
          {getModeIcon(leg.mode)}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '18px', fontWeight: 'bold' }}>
            {leg.mode === 'WALK'
              ? intl.formatMessage({
                  defaultMessage: 'Walking',
                  id: 'components.GoMode.walking'
                })
              : intl.formatMessage({
                  defaultMessage: 'Biking',
                  id: 'components.GoMode.biking'
                })}
          </div>
          <div style={{ color: '#666', fontSize: '14px' }}>
            {intl.formatMessage(
              {
                defaultMessage: 'to {destination}',
                id: 'components.GoMode.walkingTo'
              },
              { destination: leg.to.name }
            )}
          </div>
        </div>
      </div>

      {/* Navigation Instruction */}
      {progress.nextInstruction && (
        <div
          style={{
            backgroundColor: isNearDestination ? '#e3f2fd' : '#f5f5f5',
            borderLeft: `4px solid ${
              isNearDestination ? '#2196F3' : '#9e9e9e'
            }`,
            borderRadius: '8px',
            marginBottom: '16px',
            padding: '16px'
          }}
        >
          <div
            style={{ fontSize: '16px', fontWeight: '500', marginBottom: '8px' }}
          >
            {progress.nextInstruction}
          </div>
          {progress.distanceToNextTurn !== undefined && (
            <div
              style={{ color: '#2196F3', fontSize: '24px', fontWeight: 'bold' }}
            >
              {formatDistance(progress.distanceToNextTurn)}
            </div>
          )}
        </div>
      )}

      {/* Next Leg Preview */}
      {nextLeg && isNearDestination && (
        <div
          style={{
            backgroundColor: '#fff3e0',
            borderLeft: '4px solid #FF9800',
            borderRadius: '4px',
            padding: '12px'
          }}
        >
          <div style={{ color: '#666', fontSize: '12px', marginBottom: '4px' }}>
            {intl.formatMessage({
              defaultMessage: 'Up Next',
              id: 'components.GoMode.upNext'
            })}
          </div>
          <div style={{ fontSize: '14px', fontWeight: '500' }}>
            {nextLeg.mode === 'BUS' || nextLeg.mode === 'RAIL'
              ? intl.formatMessage(
                  {
                    defaultMessage: 'Board {route}',
                    id: 'components.GoMode.nextLegTransit'
                  },
                  { route: nextLeg.routeShortName || nextLeg.routeLongName }
                )
              : intl.formatMessage(
                  {
                    defaultMessage: 'Walk to {destination}',
                    id: 'components.GoMode.nextLegWalk'
                  },
                  { destination: nextLeg.to.name }
                )}
          </div>
        </div>
      )}

      {/* Progress Bar */}
      <div style={{ marginTop: '16px' }}>
        <div style={{ color: '#666', fontSize: '12px', marginBottom: '4px' }}>
          {intl.formatMessage({
            defaultMessage: 'Progress',
            id: 'components.GoMode.progress'
          })}
        </div>
        <div
          style={{
            backgroundColor: '#E0E0E0',
            borderRadius: '3px',
            height: '6px',
            overflow: 'hidden',
            width: '100%'
          }}
        >
          <div
            style={{
              backgroundColor: '#4CAF50',
              height: '100%',
              transition: 'width 0.3s ease',
              width: `${progress.currentLegProgress}%`
            }}
          />
        </div>
        <div
          style={{
            color: '#666',
            fontSize: '12px',
            marginTop: '4px',
            textAlign: 'right'
          }}
        >
          {Math.round(progress.currentLegProgress)}%
        </div>
      </div>
    </div>
  )
}

export default WalkingNavigation
