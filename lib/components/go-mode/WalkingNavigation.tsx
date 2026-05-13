import { useIntl } from 'react-intl'
import React, { useMemo } from 'react'
import type { Leg } from '@opentripplanner/types'

import { mergeAndSortStopTimes } from '../../util/stop-times'
import type { TripProgress } from '../../util/go-mode/progress-calculator'

import {
  AlternativeDeparture,
  CountdownCard,
  CountdownLabel,
  CountdownValue,
  InfoCardLabel,
  InfoCardValue,
  NextLegPreview,
  ResetButton,
  UseNextButton,
  WalkingContainer
} from './styled'

interface Props {
  boardingStopData?: any
  departureOverride?: number | null
  leg: Leg
  nextLeg?: Leg
  onSelectDeparture?: (epochMs: number | null) => void
  progress: TripProgress
}

const WalkingNavigation = ({
  boardingStopData,
  departureOverride,
  leg,
  nextLeg,
  onSelectDeparture,
  progress
}: Props) => {
  const intl = useIntl()

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

  const formatClockTime = (epochMs: number): string => {
    return new Date(epochMs).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    })
  }

  const walkSecondsRemaining = Math.max(
    0,
    (leg.duration || 0) * (1 - progress.currentLegProgress / 100)
  )

  // Determine the effective departure time for display
  const effectiveDepartureMs =
    departureOverride || progress.plannedDepartureTime

  // Filter upcoming alternative departures for the same route at the boarding stop
  const alternativeDepartures = useMemo(() => {
    if (!boardingStopData || !isNextLegTransit || !nextLeg) return []

    try {
      const allStopTimes = mergeAndSortStopTimes(boardingStopData)
      const nowMs = progress.currentTime.getTime()
      const targetedDepartureMs = effectiveDepartureMs || nextLeg.startTime

      // Match by route GTFS ID
      const nextLegRouteId = (nextLeg as any).routeId || nextLeg.routeId
      return allStopTimes
        .filter((st: any) => {
          // Match route
          const stRouteId = st.route?.gtfsId || st.trip?.route?.gtfsId
          if (!stRouteId || !nextLegRouteId) return false
          if (stRouteId !== nextLegRouteId) return false

          // Calculate actual departure epoch ms
          const depSeconds = st.realtimeDeparture ?? st.scheduledDeparture
          const depMs = (st.serviceDay + depSeconds) * 1000

          // Must be in the future and within 2 hours
          if (depMs <= nowMs) return false
          if (depMs > nowMs + 2 * 60 * 60 * 1000) return false

          // Exclude the currently-targeted departure (within 60s tolerance)
          if (Math.abs(depMs - targetedDepartureMs) < 60000) return false

          return true
        })
        .slice(0, 3)
        .map((st: any) => {
          const depSeconds = st.realtimeDeparture ?? st.scheduledDeparture
          const depMs = (st.serviceDay + depSeconds) * 1000
          return { departureMs: depMs }
        })
    } catch {
      return []
    }
  }, [
    boardingStopData,
    isNextLegTransit,
    nextLeg,
    progress.currentTime,
    effectiveDepartureMs
  ])

  // Show alternatives when timing is tight (wait < 60s) or late
  const showAlternatives =
    isNextLegTransit &&
    alternativeDepartures.length > 0 &&
    progress.waitTimeAtStop !== undefined &&
    progress.waitTimeAtStop < 60

  return (
    <WalkingContainer>
      {/* Navigation instruction with time remaining -- compact inline */}
      <div
        style={{
          alignItems: 'center',
          display: 'flex',
          justifyContent: 'space-between'
        }}
      >
        <span
          style={{
            fontSize: '15px',
            fontWeight: 500,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap' as const
          }}
        >
          {progress.nextInstruction || `Walk to ${leg.to.name}`}
        </span>
        <span
          style={{
            color: '#2196f3',
            flexShrink: 0,
            fontSize: '15px',
            fontWeight: 'bold',
            marginLeft: '12px',
            whiteSpace: 'nowrap'
          }}
        >
          {formatMinutes(walkSecondsRemaining)}
        </span>
      </div>

      {/* Transit Departure Countdown */}
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
            {effectiveDepartureMs
              ? `${formatClockTime(
                  effectiveDepartureMs
                )} \u2014 ${formatMinutes(
                  progress.timeUntilNextDeparture
                )} away`
              : intl.formatMessage(
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

          {/* Override reset link */}
          {progress.departureIsOverridden && onSelectDeparture && (
            <div style={{ marginTop: '6px' }}>
              <ResetButton
                onClick={() => onSelectDeparture(null)}
                type="button"
              >
                {intl.formatMessage({
                  defaultMessage: 'Reset to planned',
                  id: 'components.GoMode.resetToPlanned'
                })}
              </ResetButton>
            </div>
          )}

          {/* Alternative departures */}
          {showAlternatives &&
            onSelectDeparture &&
            alternativeDepartures.map(
              (alt: { departureMs: number }, idx: number) => {
                const minsAway = Math.round(
                  (alt.departureMs - progress.currentTime.getTime()) / 60000
                )
                return (
                  <AlternativeDeparture key={idx}>
                    <span
                      style={{
                        fontSize: '13px',
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap' as const
                      }}
                    >
                      {intl.formatMessage(
                        {
                          defaultMessage: 'Next: {time} ({mins} min away)',
                          id: 'components.GoMode.nextDeparture'
                        },
                        {
                          mins: minsAway,
                          time: formatClockTime(alt.departureMs)
                        }
                      )}
                    </span>
                    <UseNextButton
                      onClick={() => onSelectDeparture(alt.departureMs)}
                      type="button"
                    >
                      {intl.formatMessage({
                        defaultMessage: 'Use this',
                        id: 'components.GoMode.useThisDeparture'
                      })}
                    </UseNextButton>
                  </AlternativeDeparture>
                )
              }
            )}
        </CountdownCard>
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
    </WalkingContainer>
  )
}

export default WalkingNavigation
