import { useIntl } from 'react-intl'
import React from 'react'
import type { Leg } from '@opentripplanner/types'

import type { TripProgress } from '../../util/go-mode/progress-calculator'

import {
  AlertBanner,
  InfoCard,
  InfoCardLabel,
  InfoCardValue,
  ModeIcon,
  RouteDirection,
  RouteHeader,
  RouteName,
  StopsCount,
  StopsLabel,
  TransitContainer
} from './styled'

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
      case 'FERRY':
        return '⛴️'
      default:
        return '🚍'
    }
  }

  const shouldShowAlert =
    progress.stopsRemaining === 2 || progress.stopsRemaining === 1

  return (
    <TransitContainer>
      {/* Route Header */}
      <RouteHeader>
        <ModeIcon>{getModeIcon(leg.mode)}</ModeIcon>
        <div style={{ flex: 1 }}>
          <RouteName>{leg.routeShortName || leg.routeLongName}</RouteName>
          <RouteDirection>
            {intl.formatMessage(
              {
                defaultMessage: 'to {destination}',
                id: 'components.GoMode.routeDirection'
              },
              { destination: leg.to.name }
            )}
          </RouteDirection>
        </div>
      </RouteHeader>

      {/* Get Ready Alert */}
      {shouldShowAlert && (
        <AlertBanner
          $severity={progress.stopsRemaining === 1 ? 'urgent' : 'warning'}
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
        </AlertBanner>
      )}

      {/* Stops Progress */}
      {progress.stopsRemaining !== undefined && progress.stopsRemaining > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <StopsCount $alert={shouldShowAlert}>
            {progress.stopsRemaining}
          </StopsCount>
          <StopsLabel>
            {intl.formatMessage(
              {
                defaultMessage:
                  '{count, plural, one {stop} other {stops}} remaining',
                id: 'components.GoMode.stopsRemaining'
              },
              { count: progress.stopsRemaining }
            )}
          </StopsLabel>
        </div>
      )}

      {/* Next Stop */}
      {progress.nextStopName && (
        <InfoCard>
          <InfoCardLabel>
            {intl.formatMessage({
              defaultMessage: 'Next Stop',
              id: 'components.GoMode.nextStop'
            })}
          </InfoCardLabel>
          <InfoCardValue>{progress.nextStopName}</InfoCardValue>
        </InfoCard>
      )}

      {/* Destination */}
      <InfoCard $bgColor="#e3f2fd">
        <InfoCardLabel $color="#1976d2">
          {intl.formatMessage({
            defaultMessage: 'Your Stop',
            id: 'components.GoMode.yourStop'
          })}
        </InfoCardLabel>
        <InfoCardValue $color="#1976d2">{leg.to.name}</InfoCardValue>
      </InfoCard>
    </TransitContainer>
  )
}

export default TransitProgress
