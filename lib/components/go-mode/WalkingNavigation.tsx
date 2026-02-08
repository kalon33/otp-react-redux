import { useIntl } from 'react-intl'
import React from 'react'
import type { Leg } from '@opentripplanner/types'

import type { TripProgress } from '../../util/go-mode/progress-calculator'

import {
  CountdownCard,
  CountdownLabel,
  CountdownValue,
  DistanceDisplay,
  ETALabel,
  InfoCardLabel,
  InfoCardValue,
  InstructionText,
  ModeIcon,
  NavigationInstruction,
  NextLegPreview,
  RouteDirection,
  RouteHeader,
  RouteName,
  SmallProgressFill,
  SmallProgressTrack,
  WalkingContainer
} from './styled'

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

  const isNextLegTransit =
    nextLeg &&
    (nextLeg.mode === 'BUS' ||
      nextLeg.mode === 'RAIL' ||
      nextLeg.mode === 'SUBWAY' ||
      nextLeg.mode === 'TRAM')

  const getUrgency = (waitSeconds: number): 'ok' | 'tight' | 'late' => {
    if (waitSeconds < 0) return 'late'
    if (waitSeconds < 300) return 'tight'
    return 'ok'
  }

  const formatMinutes = (seconds: number): string => {
    const mins = Math.round(seconds / 60)
    if (mins <= 0) return '<1 min'
    return `${mins} min`
  }

  return (
    <WalkingContainer>
      {/* Mode Header */}
      <RouteHeader>
        <ModeIcon>{getModeIcon(leg.mode)}</ModeIcon>
        <div style={{ flex: 1 }}>
          <RouteName>
            {leg.mode === 'WALK'
              ? intl.formatMessage({
                  defaultMessage: 'Walking',
                  id: 'components.GoMode.walking'
                })
              : intl.formatMessage({
                  defaultMessage: 'Biking',
                  id: 'components.GoMode.biking'
                })}
          </RouteName>
          <RouteDirection>
            {intl.formatMessage(
              {
                defaultMessage: 'to {destination}',
                id: 'components.GoMode.walkingTo'
              },
              { destination: leg.to.name }
            )}
          </RouteDirection>
        </div>
      </RouteHeader>

      {/* Transit Departure Countdown - MOST IMPORTANT */}
      {isNextLegTransit && progress.timeUntilNextDeparture !== undefined && (
        <CountdownCard
          $urgency={getUrgency(
            progress.waitTimeAtStop ?? progress.timeUntilNextDeparture
          )}
        >
          <CountdownLabel>
            {nextLeg.routeShortName || nextLeg.routeLongName}
          </CountdownLabel>
          <CountdownValue
            $urgency={getUrgency(
              progress.waitTimeAtStop ?? progress.timeUntilNextDeparture
            )}
          >
            {intl.formatMessage(
              {
                defaultMessage: 'Departs in {time}',
                id: 'components.GoMode.departsIn'
              },
              { time: formatMinutes(progress.timeUntilNextDeparture) }
            )}
          </CountdownValue>
          {progress.waitTimeAtStop !== undefined && (
            <div style={{ fontSize: '13px', marginTop: '4px' }}>
              {progress.waitTimeAtStop < 0
                ? intl.formatMessage({
                    defaultMessage: 'Hurry! You may miss the bus',
                    id: 'components.GoMode.hurryWarning'
                  })
                : intl.formatMessage(
                    {
                      defaultMessage: '~{time} wait at stop',
                      id: 'components.GoMode.waitAtStop'
                    },
                    { time: formatMinutes(progress.waitTimeAtStop) }
                  )}
            </div>
          )}
        </CountdownCard>
      )}

      {/* Navigation Instruction */}
      {progress.nextInstruction && (
        <NavigationInstruction $highlight={isNearDestination}>
          <InstructionText>{progress.nextInstruction}</InstructionText>
          {progress.distanceToNextTurn !== undefined && (
            <DistanceDisplay>
              {formatDistance(progress.distanceToNextTurn)}
            </DistanceDisplay>
          )}
        </NavigationInstruction>
      )}

      {/* Next Leg Preview */}
      {nextLeg && isNearDestination && (
        <NextLegPreview>
          <InfoCardLabel>
            {intl.formatMessage({
              defaultMessage: 'Up Next',
              id: 'components.GoMode.upNext'
            })}
          </InfoCardLabel>
          <InfoCardValue>
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
          </InfoCardValue>
        </NextLegPreview>
      )}

      {/* Progress Bar */}
      <div style={{ marginTop: '16px' }}>
        <ETALabel>
          {intl.formatMessage({
            defaultMessage: 'Progress',
            id: 'components.GoMode.progress'
          })}
        </ETALabel>
        <SmallProgressTrack>
          <SmallProgressFill $width={progress.currentLegProgress} />
        </SmallProgressTrack>
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
    </WalkingContainer>
  )
}

export default WalkingNavigation
