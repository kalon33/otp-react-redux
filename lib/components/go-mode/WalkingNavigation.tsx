import { useIntl } from 'react-intl'
import React, { useEffect, useMemo, useState } from 'react'
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

type Urgency = 'ok' | 'tight' | 'late'

/**
 * The access (walk/bike) leg view, distilled to a single adaptive card.
 *
 * One hero element answers "what do I do now?" and changes with the trip phase:
 *   waiting  → live "Leave in M:SS" countdown to the must-leave deadline
 *   en route → time remaining to the boarding stop + on-time status
 *   arriving → "Board <route>" with the departure time
 * Every fact (stop, route, ride time, departure clock) appears exactly once.
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

  const getUrgency = (seconds: number): Urgency => {
    if (seconds < 0) return 'late'
    if (seconds < 300) return 'tight'
    return 'ok'
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

  const formatCountdown = (seconds: number): string => {
    const total = Math.max(0, Math.round(seconds))
    const mins = Math.floor(total / 60)
    const secs = total % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const walkSecondsRemaining = Math.max(
    0,
    (leg.duration || 0) * (1 - progress.currentLegProgress / 100)
  )

  const effectiveDepartureMs =
    departureOverride || progress.plannedDepartureTime
  const departureClock = effectiveDepartureMs
    ? formatClockTime(effectiveDepartureMs)
    : null
  const route = nextLeg?.routeShortName || nextLeg?.routeLongName || ''
  const stopName = nextLeg?.from?.name || leg.to.name
  const accessEmoji = leg.mode === 'BICYCLE' ? '🚲' : '🚶'

  // Live 1s tick so the countdown advances smoothly between GPS polls.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Deadline to set off and still catch the bus = departure − remaining ride.
  const leaveByMs =
    isNextLegTransit && effectiveDepartureMs
      ? effectiveDepartureMs - walkSecondsRemaining * 1000
      : null
  const leaveInSeconds = leaveByMs !== null ? (leaveByMs - nowMs) / 1000 : 0

  // Phase selection.
  const isNearStop = progress.currentLegProgress >= 90
  const isMoving = progress.currentLegProgress >= 8
  let phase: 'waiting' | 'enroute' | 'arriving' | 'walk'
  if (isNextLegTransit) {
    if (isNearStop) phase = 'arriving'
    else if (isMoving || leaveByMs === null) phase = 'enroute'
    else phase = 'waiting'
  } else {
    phase = 'walk'
  }

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

  // Per-phase card content.
  let urgency: Urgency = 'ok'
  let eyebrow = ''
  let hero = ''
  let sub: string | null = null
  let foot: string | null = null

  if (phase === 'waiting') {
    urgency =
      leaveInSeconds <= 120 ? 'late' : leaveInSeconds <= 300 ? 'tight' : 'ok'
    eyebrow =
      leaveInSeconds <= 120
        ? intl.formatMessage({
            defaultMessage: 'Time to go',
            id: 'components.GoMode.timeToGo'
          })
        : intl.formatMessage({
            defaultMessage: 'Leave in',
            id: 'components.GoMode.leaveInLabel'
          })
    hero =
      leaveInSeconds > 0
        ? formatCountdown(leaveInSeconds)
        : leaveInSeconds > -60
        ? intl.formatMessage({
            defaultMessage: 'Leave now',
            id: 'components.GoMode.leaveNowShort'
          })
        : intl.formatMessage({
            defaultMessage: 'Hurry!',
            id: 'components.GoMode.leaveHurryShort'
          })
    sub = intl.formatMessage(
      { defaultMessage: 'to catch {route}', id: 'components.GoMode.toCatch' },
      { route }
    )
    foot = intl.formatMessage(
      {
        defaultMessage: '{emoji} {ride} ride · departs {clock}',
        id: 'components.GoMode.rideAndDeparts'
      },
      {
        clock: departureClock,
        emoji: accessEmoji,
        ride: formatMinutes(walkSecondsRemaining)
      }
    )
  } else if (phase === 'enroute') {
    const onTime =
      progress.waitTimeAtStop === undefined
        ? null
        : progress.waitTimeAtStop >= 0
    urgency = getUrgency(
      progress.waitTimeAtStop ?? progress.timeUntilNextDeparture ?? 9999
    )
    eyebrow = intl.formatMessage(
      { defaultMessage: '{emoji} To {stop}', id: 'components.GoMode.toStop' },
      { emoji: accessEmoji, stop: stopName }
    )
    hero = formatMinutes(walkSecondsRemaining)
    if (route && departureClock) {
      sub =
        onTime === false
          ? intl.formatMessage(
              {
                defaultMessage: 'Behind — may miss {route}',
                id: 'components.GoMode.behindMayMiss'
              },
              { route }
            )
          : intl.formatMessage(
              {
                defaultMessage: 'On time for {route} · {clock}',
                id: 'components.GoMode.onTimeFor'
              },
              { clock: departureClock, route }
            )
    } else {
      sub = progress.nextInstruction || null
    }
  } else if (phase === 'arriving') {
    urgency = getUrgency(
      progress.waitTimeAtStop ?? progress.timeUntilNextDeparture ?? 0
    )
    eyebrow = intl.formatMessage({
      defaultMessage: 'Board',
      id: 'components.GoMode.boardLabel'
    })
    hero = route
    if (departureClock) {
      sub =
        progress.waitTimeAtStop !== undefined && progress.waitTimeAtStop >= 0
          ? intl.formatMessage(
              {
                defaultMessage: '{clock} · ~{wait} wait',
                id: 'components.GoMode.clockAndWait'
              },
              {
                clock: departureClock,
                wait: formatMinutes(progress.waitTimeAtStop)
              }
            )
          : departureClock
    }
  } else {
    // Plain walk/bike leg with no transit connection next.
    urgency = 'ok'
    eyebrow = intl.formatMessage(
      { defaultMessage: '{emoji} To {stop}', id: 'components.GoMode.toStop' },
      { emoji: accessEmoji, stop: leg.to.name }
    )
    hero = formatMinutes(walkSecondsRemaining)
    sub = progress.nextInstruction || null
  }

  return (
    <WalkingContainer>
      <NavCard $urgency={urgency}>
        {eyebrow && <NavEyebrow>{eyebrow}</NavEyebrow>}
        <NavHero $urgency={urgency}>{hero}</NavHero>
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
