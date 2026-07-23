import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React from 'react'
import type { Leg } from '@opentripplanner/types'

import * as goModeActions from '../../actions/go-mode'
import {
  displayVehicleLabel,
  NO_LIVE_VEHICLE_POLLS
} from '../../util/go-mode/vehicle-matching'
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
  NavExtras,
  ResetButton,
  RouteDirection,
  RouteHeader,
  RouteName,
  StopsCount,
  StopsLabel,
  TransitContainer,
  VehicleTrackingBadge
} from './styled'

interface Props {
  advanceToLeg: (legIndex: number) => void
  emptyPolls: number
  leg: Leg
  onExit?: () => void
  progress: TripProgress
  vehicleMatch?: VehicleMatchResult | null
}

const TransitProgress = ({
  advanceToLeg,
  emptyPolls,
  leg,
  onExit,
  progress,
  vehicleMatch
}: Props) => {
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
                    { label: displayVehicleLabel(vehicleMatch.label) }
                  )
                : intl.formatMessage(
                    {
                      defaultMessage: 'Tracking Bus #{label}',
                      id: 'components.GoMode.trackingBus'
                    },
                    { label: displayVehicleLabel(vehicleMatch.label) }
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
                  : emptyPolls >= NO_LIVE_VEHICLE_POLLS
                  ? // The route publishes no live vehicle positions (or the
                    // feed is down). Stop promising a match that will never
                    // arrive — stop progress still comes from GPS.
                    intl.formatMessage({
                      defaultMessage: 'No live bus data — tracking by GPS',
                      id: 'components.GoMode.noLiveVehicleData'
                    })
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

      {/* Getting off before the planned stop (an early transfer, say) leaves
          the app tracking a bus the rider is no longer on — position matching
          keeps them pinned to this leg while they walk along the same corridor,
          so no boarding alerts fire for the next bus. This is the rider saying
          so directly; it advances the trip to the next leg. */}
      <NavExtras>
        <ResetButton
          onClick={() => advanceToLeg((progress.currentLegIndex ?? 0) + 1)}
          type="button"
        >
          {intl.formatMessage({
            defaultMessage: 'I got off here',
            id: 'components.GoMode.gotOffHere'
          })}
        </ResetButton>
      </NavExtras>
    </TransitContainer>
  )
}

const mapStateToProps = (state: any) => ({
  emptyPolls: state.otp?.goMode?.vehicleMatch?.emptyPolls || 0,
  vehicleMatch: state.otp?.goMode?.vehicleMatch?.match || null
})

const mapDispatchToProps = {
  advanceToLeg: goModeActions.advanceToLeg
}

export default connect(mapStateToProps, mapDispatchToProps)(TransitProgress)
