import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React from 'react'
import type { Leg } from '@opentripplanner/types'

import { getModeIcon } from '../../util/go-mode/mode-icon'
import type { TripProgress } from '../../util/go-mode/progress-calculator'
import type { VehicleMatchResult } from '../../util/go-mode/vehicle-matching'

import {
  AlertBanner,
  CardBackButton,
  InfoCard,
  InfoCardLabel,
  InfoCardValue,
  LocatingIndicator,
  ModeIcon,
  RouteDirection,
  RouteHeader,
  RouteName,
  StopsCount,
  StopsLabel,
  TransitContainer,
  VehicleTrackingBadge
} from './styled'

interface Props {
  leg: Leg
  onExit?: () => void
  progress: TripProgress
  vehicleMatch?: VehicleMatchResult | null
}

const TransitProgress = ({ leg, onExit, progress, vehicleMatch }: Props) => {
  const intl = useIntl()

  const shouldShowAlert =
    progress.stopsRemaining === 2 || progress.stopsRemaining === 1

  const isTracking =
    vehicleMatch?.confidence === 'confirmed' ||
    vehicleMatch?.confidence === 'high'

  return (
    <TransitContainer>
      {/* Route Header */}
      <RouteHeader>
        {onExit && (
          <CardBackButton
            aria-label={intl.formatMessage({ id: 'common.forms.back' })}
            onClick={onExit}
            type="button"
          >
            ←
          </CardBackButton>
        )}
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
          {/* Vehicle tracking status */}
          {isTracking && vehicleMatch?.label && (
            <VehicleTrackingBadge
              $confirmed={vehicleMatch.confidence === 'confirmed'}
            >
              {vehicleMatch.confidence === 'confirmed'
                ? intl.formatMessage(
                    {
                      defaultMessage: 'On Bus #{label}',
                      id: 'components.GoMode.onBus'
                    },
                    { label: vehicleMatch.label }
                  )
                : intl.formatMessage(
                    {
                      defaultMessage: 'Tracking Bus #{label}',
                      id: 'components.GoMode.trackingBus'
                    },
                    { label: vehicleMatch.label }
                  )}
            </VehicleTrackingBadge>
          )}
          {!isTracking &&
            vehicleMatch?.confidence !== 'confirmed' &&
            leg.transitLeg && (
              <LocatingIndicator>
                {typeof leg.startTime === 'number' && leg.startTime > Date.now()
                  ? // Before the leg's scheduled start the vehicle usually is
                    // not broadcasting AT ALL yet — an endless "Locating…"
                    // reads as a bug. Say what is actually happening.
                    intl.formatMessage(
                      {
                        defaultMessage:
                          'Bus not broadcasting yet — scheduled {time}',
                        id: 'components.GoMode.busNotBroadcasting'
                      },
                      {
                        time: intl.formatTime(leg.startTime, {
                          hour: 'numeric',
                          minute: '2-digit'
                        })
                      }
                    )
                  : intl.formatMessage({
                      defaultMessage: 'Locating your bus...',
                      id: 'components.GoMode.locatingBus'
                    })}
              </LocatingIndicator>
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

const mapStateToProps = (state: any) => ({
  vehicleMatch: state.otp?.goMode?.vehicleMatch?.match || null
})

export default connect(mapStateToProps)(TransitProgress)
