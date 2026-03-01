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
        <div style={{ flex: 1, minWidth: 0 }}>
          <RouteName>{leg.routeShortName || leg.routeLongName}</RouteName>
          {/* Compact stops remaining */}
          {progress.stopsRemaining !== undefined &&
            progress.stopsRemaining > 0 && (
              <RouteDirection>
                {intl.formatMessage(
                  {
                    defaultMessage:
                      '{count, plural, one {1 stop} other {# stops}} remaining',
                    id: 'components.GoMode.stopsRemainingCompact'
                  },
                  { count: progress.stopsRemaining }
                )}
              </RouteDirection>
            )}
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
    </TransitContainer>
  )
}

export default TransitProgress
