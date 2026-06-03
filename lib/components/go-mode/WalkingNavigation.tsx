import { useIntl } from 'react-intl'
import React, { useMemo } from 'react'
import type { Leg } from '@opentripplanner/types'

import { mergeAndSortStopTimes } from '../../util/stop-times'
import type { TripProgress } from '../../util/go-mode/progress-calculator'

import {
  AlternativeDeparture,
  NavCard,
  NavExtras,
  NavEyebrow,
  NavFoot,
  NavHero,
  NavSub,
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

/**
 * Access (walk/bike) leg view: state the facts directly and let the rider
 * decide when to leave. The card shows when the bus arrives at the boarding
 * stop (clock time + minutes away) and how long the ride to that stop is.
 * No "leave in" countdown — the rider deduces that themselves.
 */
const WalkingNavigation = ({
  boardingStopData,
  departureOverride,
  leg,
  nextLeg,
  onSelectDeparture,
  progress
}: Props) => {
  const intl = useIntl()

  const isNextLegTransit =
    !!nextLeg &&
    (nextLeg.mode === 'BUS' ||
      nextLeg.mode === 'RAIL' ||
      nextLeg.mode === 'SUBWAY' ||
      nextLeg.mode === 'TRAM')

  const transitEmoji = (mode?: string): string => {
    switch (mode) {
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

  const formatMinutes = (seconds: number): string => {
    const mins = Math.round(seconds / 60)
    return mins <= 0 ? '<1 min' : `${mins} min`
  }

  const formatClockTime = (epochMs: number): string =>
    new Date(epochMs).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    })

  const rideSecondsRemaining = Math.max(
    0,
    (leg.duration || 0) * (1 - progress.currentLegProgress / 100)
  )

  const effectiveDepartureMs =
    departureOverride || progress.plannedDepartureTime
  const route = nextLeg?.routeShortName || nextLeg?.routeLongName || ''
  const stopName = nextLeg?.from?.name || leg.to.name
  const accessEmoji = leg.mode === 'BICYCLE' ? '🚲' : '🚶'

  // Minutes until the bus reaches the boarding stop — from the trip clock
  // (so it stays correct under GPS simulation too).
  const busInSeconds = effectiveDepartureMs
    ? (effectiveDepartureMs - progress.currentTime.getTime()) / 1000
    : progress.timeUntilNextDeparture ?? 0

  // Upcoming alternative departures for the same route (only surfaced when tight).
  const alternativeDepartures = useMemo(() => {
    if (!boardingStopData || !isNextLegTransit || !nextLeg) return []
    try {
      const allStopTimes = mergeAndSortStopTimes(boardingStopData)
      const now = progress.currentTime.getTime()
      const targetedDepartureMs = effectiveDepartureMs || nextLeg.startTime
      const nextLegRouteId = nextLeg.routeId
      return allStopTimes
        .filter((st: any) => {
          const stRouteId = st.route?.gtfsId || st.trip?.route?.gtfsId
          if (!stRouteId || !nextLegRouteId) return false
          if (stRouteId !== nextLegRouteId) return false
          const depSeconds = st.realtimeDeparture ?? st.scheduledDeparture
          const depMs = (st.serviceDay + depSeconds) * 1000
          if (depMs <= now) return false
          if (depMs > now + 2 * 60 * 60 * 1000) return false
          if (Math.abs(depMs - targetedDepartureMs) < 60000) return false
          return true
        })
        .slice(0, 3)
        .map((st: any) => {
          const depSeconds = st.realtimeDeparture ?? st.scheduledDeparture
          return { departureMs: (st.serviceDay + depSeconds) * 1000 }
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

  const showAlternatives =
    alternativeDepartures.length > 0 &&
    progress.waitTimeAtStop !== undefined &&
    progress.waitTimeAtStop < 60
  const showReset = !!progress.departureIsOverridden && !!onSelectDeparture
  const showExtras = (showAlternatives || showReset) && !!onSelectDeparture

  // Card content.
  let eyebrow: string
  let hero: string
  let sub: string | null = null
  let foot: string | null = null

  if (isNextLegTransit) {
    // Bus facts as the headline; ride-to-stop fact below.
    eyebrow = `${transitEmoji(nextLeg?.mode)} ${route}`
    hero = effectiveDepartureMs ? formatClockTime(effectiveDepartureMs) : ''
    sub = intl.formatMessage(
      {
        defaultMessage: 'arrives in {time}',
        id: 'components.GoMode.arrivesIn'
      },
      { time: formatMinutes(busInSeconds) }
    )
    foot = intl.formatMessage(
      {
        defaultMessage: '{emoji} {time} ride to {stop}',
        id: 'components.GoMode.rideToStop'
      },
      {
        emoji: accessEmoji,
        stop: stopName,
        time: formatMinutes(rideSecondsRemaining)
      }
    )
  } else {
    // Plain walk/bike leg with no transit connection next.
    eyebrow = intl.formatMessage(
      { defaultMessage: '{emoji} To {stop}', id: 'components.GoMode.toStop' },
      { emoji: accessEmoji, stop: leg.to.name }
    )
    hero = formatMinutes(rideSecondsRemaining)
    sub = progress.nextInstruction || null
  }

  return (
    <WalkingContainer>
      <NavCard>
        <NavEyebrow>{eyebrow}</NavEyebrow>
        {hero && <NavHero>{hero}</NavHero>}
        {sub && <NavSub>{sub}</NavSub>}
        {foot && <NavFoot>{foot}</NavFoot>}

        {showExtras && (
          <NavExtras>
            {showReset && (
              <ResetButton
                onClick={() => onSelectDeparture?.(null)}
                type="button"
              >
                {intl.formatMessage({
                  defaultMessage: 'Reset to planned',
                  id: 'components.GoMode.resetToPlanned'
                })}
              </ResetButton>
            )}
            {showAlternatives &&
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
                        onClick={() => onSelectDeparture?.(alt.departureMs)}
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
          </NavExtras>
        )}
      </NavCard>
    </WalkingContainer>
  )
}

export default WalkingNavigation
