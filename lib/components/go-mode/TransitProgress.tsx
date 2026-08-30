import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React from 'react'
import type { Leg } from '@opentripplanner/types'

import * as goModeActions from '../../actions/go-mode'
import { alightBannerLevel } from '../../util/go-mode/progress-calculator'
import {
  displayVehicleLabel,
  NO_LIVE_VEHICLE_POLLS
} from '../../util/go-mode/vehicle-matching'
import { getModeIcon } from '../../util/go-mode/mode-icon'
import { VEHICLE_MATCH_FRESH_MS } from '../../util/go-mode/transit-trust'
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

  // Only an assessed distrust suppresses (stopsTrusted is unset on legacy
  // trusted paths); a deviated route match means the count is being measured
  // against a leg the rider may not be on. On 7/29 a cascade of wrong replans
  // put a GET READY banner up off legIndex 0 / stopsRemaining 1 of an
  // itinerary the rider never chose.
  const stopsTrusted = progress.stopsTrusted !== false

  // Those gates are necessary but not sufficient. On 8/2 stopsRemaining was a
  // perfectly honest 1 for a 30-minute ride (both legs of the split were
  // single-hop), so nothing above could suppress the banner and "GET READY!
  // Next stop is yours!" stayed up the whole way. alightBannerLevel adds the
  // ETA test — the same move checkAlightAlerts already made for notifications.
  const alertLevel = alightBannerLevel(progress, Date.now())

  // The badge is a live claim ("On Bus…"), so it also needs a recent feed
  // sighting — a confirmed match whose vehicle left the feed keeps its
  // confidence but its lastSeen ages (see performVehicleMatching), and the
  // honest thing to show then is the locating/no-live-data line below.
  const isTracking =
    (vehicleMatch?.confidence === 'confirmed' ||
      vehicleMatch?.confidence === 'high') &&
    Date.now() - (vehicleMatch?.lastSeen ?? 0) < VEHICLE_MATCH_FRESH_MS

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
          {/* Compact stops remaining — never shown from an untrusted count;
              an approximate substitute would just be fake data. */}
          {stopsTrusted &&
            progress.stopsRemaining !== undefined &&
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
          {/* A fresh confirmed/high match renders the badge above; anything
              else — including a confirmed match gone stale — gets the honest
              status line. */}
          {!isTracking && leg.transitLeg && (
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
      {alertLevel && (
        <AlertBanner $severity={alertLevel}>
          {alertLevel === 'urgent'
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
