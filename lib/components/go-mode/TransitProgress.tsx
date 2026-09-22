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
import { isWaitingForDeparture } from '../../util/go-mode/waiting-at-stop'
import { legBoard } from '../../util/go-mode/live-itinerary'
import { VEHICLE_MATCH_FRESH_MS } from '../../util/go-mode/transit-trust'
import type { LiveLegTime } from '../../util/go-mode/types'
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
  liveLegTimes?: Record<number, LiveLegTime>
  onExit?: () => void
  progress: TripProgress
  /** goMode.riding — the evidenced fact that the rider is aboard this leg. */
  riding?: { legIndex: number } | null
  vehicleMatch?: VehicleMatchResult | null
}

const TransitProgress = ({
  advanceToLeg,
  emptyPolls,
  leg,
  liveLegTimes,
  onExit,
  progress,
  riding,
  vehicleMatch
}: Props) => {
  const intl = useIntl()

  /**
   * The rider is at the stop, not on the bus.
   *
   * The trip steps onto a transit leg before the bus leaves — it has to: the
   * transition is the only place startVehicleTracking runs for a mid-trip
   * transit leg (13.1) — so this card comes up for the whole platform wait and
   * used to spend it stating ride facts: stops remaining, "On Bus #1234", and
   * a button saying the rider got off. Every one of them keys on
   * currentLegIndex; none of them asks whether the rider is aboard. On
   * 2026-09-11 the rider typed their note standing 23 m from the stop, 2m11s
   * before the 08:27:31 bus, with the card already reading as a ride (13.9).
   *
   * The gate is a positive fact, not the absence of one: before the bus's own
   * departure time nobody can be riding it. Past that time the card keeps its
   * old wording even without a riding fact, so a rider genuinely aboard a bus
   * the feed never confirmed is never told they are waiting.
   */
  const aboard = riding != null && riding.legIndex === progress.currentLegIndex
  const boardTime = legBoard(
    progress.currentLegIndex ?? 0,
    leg,
    liveLegTimes || {}
  )
  const boardMs = Number(boardTime.epoch)
  // A floored epoch is "no earlier than this", not a prediction (17.6), so it
  // may not be shown as a departure time — but it is still a fact that the
  // departure has not happened.
  const departureMs = Number.isFinite(boardMs) ? boardMs : null
  // Lives in util/go-mode/waiting-at-stop since 2026-09-22: the backgrounded
  // banner makes the same claim on a different surface (13.9's second half)
  // and must not grow a second copy of this test.
  const waiting = isWaitingForDeparture({
    aboard,
    departureMs,
    leg,
    nowMs: Date.now()
  })

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
          {/* Standing at the stop: where the rider is and when the bus goes.
              The stop count below is a ride fact and says nothing true here —
              its "next stop" is the one after the boarding stop (13.9). */}
          {waiting && (
            <RouteDirection>
              {departureMs != null && !boardTime.isFloor
                ? intl.formatMessage(
                    {
                      defaultMessage: 'Waiting at {stop} · {time}',
                      id: 'components.GoMode.waitingAtStopTime'
                    },
                    {
                      stop: leg.from?.name,
                      time: intl.formatTime(departureMs, {
                        hour: 'numeric',
                        minute: '2-digit'
                      })
                    }
                  )
                : intl.formatMessage(
                    {
                      defaultMessage: 'Waiting at {stop}',
                      id: 'components.GoMode.waitingAtStop'
                    },
                    { stop: leg.from?.name }
                  )}
            </RouteDirection>
          )}
          {/* Compact stops remaining — never shown from an untrusted count;
              an approximate substitute would just be fake data. */}
          {!waiting &&
            stopsTrusted &&
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
              $confirmed={vehicleMatch.confidence === 'confirmed' && !waiting}
            >
              {/* "On Bus" is a claim about where the rider is, so it needs the
                  riding fact and not just a confirmed vehicle match: while
                  they are still on the platform the honest badge is that the
                  bus is being tracked (13.9). */}
              {vehicleMatch.confidence === 'confirmed' && !waiting
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

      {/* Get Ready Alert — an alight warning is a ride fact. On the platform
          "GET READY! Next stop is yours!" is about a stop the rider has not
          boarded for yet (13.9). */}
      {!waiting && alertLevel && (
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
          so directly; it advances the trip to the next leg.

          Hidden while waiting: it reads as a statement that the rider was
          aboard (12.1's lesson), and its action would skip the leg — throwing
          away the very bus they are standing there for (13.9). It returns the
          moment the departure time passes, so a rider aboard a bus the feed
          never confirmed still has it. */}
      {!waiting && (
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
      )}
    </TransitContainer>
  )
}

const mapStateToProps = (state: any) => ({
  emptyPolls: state.otp?.goMode?.vehicleMatch?.emptyPolls || 0,
  liveLegTimes: state.otp?.goMode?.liveLegTimes || {},
  riding: state.otp?.goMode?.riding || null,
  vehicleMatch: state.otp?.goMode?.vehicleMatch?.match || null
})

const mapDispatchToProps = {
  advanceToLeg: goModeActions.advanceToLeg
}

export default connect(mapStateToProps, mapDispatchToProps)(TransitProgress)
