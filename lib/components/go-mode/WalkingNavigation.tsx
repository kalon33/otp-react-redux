import { useIntl } from 'react-intl'
import React, { useMemo } from 'react'
import type { Leg } from '@opentripplanner/types'

import { mergeAndSortStopTimes } from '../../util/stop-times'
import type { TripProgress } from '../../util/go-mode/progress-calculator'

import {
  AlternativeDeparture,
  CardBackButton,
  LiveDot,
  NavCard,
  NavExtras,
  NavEyebrow,
  NavEyebrowRow,
  NavFoot,
  NavHero,
  NavSub,
  ResetButton,
  TimeKindBadge,
  UseNextButton,
  WalkingContainer
} from './styled'

// OTP realtimeState values that mean the time reflects live vehicle data
// (as opposed to the static schedule).
const LIVE_REALTIME_STATES = new Set(['UPDATED', 'ADDED', 'MODIFIED'])

interface Props {
  boardingStopData?: any
  departureOverride?: number | null
  leg: Leg
  nextLeg?: Leg
  onExit?: () => void
  onSelectDeparture?: (epochMs: number | null) => void
  progress: TripProgress
}

/**
 * Access (walk/bike) leg view: state the facts directly and let the rider
 * decide when to leave. The card shows when the bus arrives at the boarding
 * stop (clock time + minutes away) and how long the ride to that stop is.
 *
 * Crucially it targets the *soonest bus the rider can physically reach* — the
 * earliest departure of the route at the boarding stop whose time is at least
 * the remaining ride away — rather than the comfortably-padded departure OTP
 * planned. A slim margin still counts: if you can bike there before it leaves,
 * you see it.
 */
const WalkingNavigation = ({
  boardingStopData,
  departureOverride,
  leg,
  nextLeg,
  onExit,
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

  const nowMs = progress.currentTime.getTime()
  const rideSecondsRemaining = Math.max(
    0,
    (leg.duration || 0) * (1 - progress.currentLegProgress / 100)
  )

  const route = nextLeg?.routeShortName || nextLeg?.routeLongName || ''
  const stopName = nextLeg?.from?.name || leg.to.name
  const isBike = leg.mode === 'BICYCLE'
  const accessEmoji = isBike ? '🚲' : '🚶'

  // OTP2 returns the route as an object (leg.route.id, aliased to gtfsId);
  // legacy responses use a top-level leg.routeId. Match the stop-time gtfsId.
  const nextLegRoute = (nextLeg as any)?.route
  const nextLegRouteId =
    (nextLegRoute && typeof nextLegRoute === 'object'
      ? nextLegRoute.id || nextLegRoute.gtfsId
      : null) ||
    (nextLeg as any)?.routeId ||
    null

  // All upcoming departures of the boarding route at the boarding stop, from the
  // live schedule pre-fetched when Go Mode started (sorted earliest first).
  const routeDepartures = useMemo(() => {
    if (!boardingStopData || !isNextLegTransit || !nextLegRouteId) return []
    try {
      return mergeAndSortStopTimes(boardingStopData)
        .map((st: any) => {
          // Prefer the live (realtime) departure when the feed reports one;
          // fall back to the static schedule otherwise.
          const live =
            LIVE_REALTIME_STATES.has(st.realtimeState) &&
            st.realtimeDeparture != null
          const secs = live ? st.realtimeDeparture : st.scheduledDeparture
          return {
            depMs: (st.serviceDay + secs) * 1000,
            realtime: live,
            routeId: st.route?.gtfsId || st.trip?.route?.gtfsId
          }
        })
        .filter(
          (d: { depMs: number; routeId?: string }) =>
            d.routeId === nextLegRouteId
        )
        .sort((a: { depMs: number }, b: { depMs: number }) => a.depMs - b.depMs)
    } catch {
      return []
    }
  }, [boardingStopData, isNextLegTransit, nextLegRouteId])

  // Soonest departure the rider has a chance at. Leaving now they'd reach the
  // stop in ~`rideSecondsRemaining`, but OTP's bike-time estimate is
  // conservative — so we also surface departures they'd reach by riding up to
  // 25% faster (capped at 3 min). If there's a chance, you see it.
  const optimismMs = Math.min(180000, rideSecondsRemaining * 1000 * 0.25)
  const soonestCatchableMs = useMemo(() => {
    const reachable = routeDepartures.find(
      (d) => d.depMs - nowMs >= rideSecondsRemaining * 1000 - optimismMs
    )
    return reachable?.depMs ?? null
  }, [routeDepartures, nowMs, rideSecondsRemaining, optimismMs])

  // Manual override wins; otherwise show the soonest reachable bus; fall back to
  // OTP's planned departure only when we have no schedule data.
  const effectiveDepartureMs =
    departureOverride || soonestCatchableMs || progress.plannedDepartureTime

  // Whether the departure time we're showing came from live (realtime) data.
  // Override / soonest-catchable times originate from routeDepartures, so we
  // match back to that list; a fall-back to OTP's planned time is "scheduled".
  const departureIsLive = useMemo(
    () =>
      !!effectiveDepartureMs &&
      routeDepartures.some(
        (d) => d.depMs === effectiveDepartureMs && d.realtime
      ),
    [routeDepartures, effectiveDepartureMs]
  )

  const busInSeconds = effectiveDepartureMs
    ? (effectiveDepartureMs - nowMs) / 1000
    : progress.timeUntilNextDeparture ?? 0
  // Slack between reaching the stop and the bus leaving — negative if you can't
  // quite make it.
  const waitAtStopSeconds = busInSeconds - rideSecondsRemaining

  // Later departures of the same route, offered as safer fallbacks when the
  // targeted bus is tight (or the rider just wants the next one).
  const laterDepartures = useMemo(() => {
    if (!effectiveDepartureMs) return []
    return routeDepartures
      .filter((d) => d.depMs > effectiveDepartureMs + 30000)
      .slice(0, 3)
      .map((d) => ({ departureMs: d.depMs }))
  }, [routeDepartures, effectiveDepartureMs])

  const showAlternatives = laterDepartures.length > 0 && waitAtStopSeconds < 120
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
    foot = isBike
      ? intl.formatMessage(
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
      : intl.formatMessage(
          {
            defaultMessage: '{emoji} {time} walk to {stop}',
            id: 'components.GoMode.walkToStop'
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
        <NavEyebrowRow>
          {onExit && (
            <CardBackButton
              aria-label={intl.formatMessage({ id: 'common.forms.back' })}
              onClick={onExit}
              type="button"
            >
              ←
            </CardBackButton>
          )}
          <NavEyebrow>{eyebrow}</NavEyebrow>
          {isNextLegTransit && hero && (
            <TimeKindBadge $live={departureIsLive}>
              {departureIsLive ? (
                <>
                  <LiveDot />
                  {intl.formatMessage({
                    defaultMessage: 'Live',
                    id: 'components.GoMode.liveTime'
                  })}
                </>
              ) : (
                intl.formatMessage({
                  defaultMessage: 'Scheduled',
                  id: 'components.GoMode.scheduledTime'
                })
              )}
            </TimeKindBadge>
          )}
        </NavEyebrowRow>
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
              laterDepartures.map(
                (alt: { departureMs: number }, idx: number) => {
                  const minsAway = Math.round((alt.departureMs - nowMs) / 60000)
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
