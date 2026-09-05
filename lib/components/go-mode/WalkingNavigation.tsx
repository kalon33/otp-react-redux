import { useIntl } from 'react-intl'
import React, { useMemo, useState } from 'react'
import type { Leg } from '@opentripplanner/types'

import {
  asContinuation,
  formatCueDistance,
  formatCueDistanceImperial
} from '../../util/go-mode/turn-by-turn'
import {
  getLegRouteId,
  getRouteDepartures,
  getSoonestCatchableMs
} from '../../util/go-mode/departure-anchor'
import type { TripProgress } from '../../util/go-mode/progress-calculator'

import {
  AlternativeDeparture,
  CardBackButton,
  NavCard,
  NavExtras,
  NavEyebrow,
  NavEyebrowRow,
  NavFoot,
  NavHero,
  NavSub,
  ResetButton,
  UseNextButton,
  WalkingContainer
} from './styled'
import RealtimeTime from './RealtimeTime'

/** Ties the toggle to the list it opens for assistive tech. */
const LATER_DEPARTURES_ID = 'go-mode-later-departures'

/** Verbatim the inline style the departure rows already used. */
const ALTERNATIVE_TEXT_STYLE = {
  fontSize: '13px',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const
}

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

  /**
   * One later-departure line, in the copy the rider already reads — the same
   * `nextDeparture` message whether it is the collapsed summary or a row of
   * the open list, so collapsing never changes the wording of a time.
   */
  const departureLine = (alt?: { departureMs: number; realtime: boolean }) =>
    alt
      ? intl.formatMessage(
          {
            defaultMessage: 'Next: {time} ({mins} min away)',
            id: 'components.GoMode.nextDeparture'
          },
          {
            mins: Math.round((alt.departureMs - nowMs) / 60000),
            time: (
              <RealtimeTime live={alt.realtime}>
                {formatClockTime(alt.departureMs)}
              </RealtimeTime>
            )
          }
        )
      : null

  const nowMs = progress.currentTime.getTime()
  const rideSecondsRemaining = Math.max(
    0,
    (leg.duration || 0) * (1 - progress.currentLegProgress / 100)
  )

  const route = nextLeg?.routeShortName || nextLeg?.routeLongName || ''
  const stopName = nextLeg?.from?.name || leg.to.name
  const isBike = leg.mode === 'BICYCLE'
  const accessEmoji = isBike ? '🚲' : '🚶'

  // Turn-by-turn guidance for this access leg, when the leg carries steps.
  // Off the corridor the metres are a straight line from the rider's own fix
  // to the corner, not a distance along a route they have left — say so, or
  // the number reads as a countdown it isn't.
  const turnLine =
    progress.nextTurnCue && progress.distanceToNextTurn != null
      ? `${progress.nextTurnCue.instruction} · ${formatCueDistanceImperial(
          progress.distanceToNextTurn
        )}${progress.turnDistanceIsDirect ? ' direct' : ''}`
      : null
  const thenLine = progress.followingTurnCue
    ? intl.formatMessage(
        { defaultMessage: 'then {turn}', id: 'components.GoMode.thenTurn' },
        { turn: asContinuation(progress.followingTurnCue.instruction) }
      )
    : null

  const nextLegRouteId = getLegRouteId(nextLeg)

  // All upcoming departures of the boarding route at the boarding stop, from
  // the stop-times data (re-polled while walking; sorted earliest first).
  const routeDepartures = useMemo(
    () =>
      isNextLegTransit
        ? getRouteDepartures(boardingStopData, nextLegRouteId)
        : [],
    [boardingStopData, isNextLegTransit, nextLegRouteId]
  )

  const soonestCatchableMs = useMemo(
    () => getSoonestCatchableMs(routeDepartures, nowMs, rideSecondsRemaining),
    [routeDepartures, nowMs, rideSecondsRemaining]
  )

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
      .map((d) => ({ departureMs: d.depMs, realtime: d.realtime }))
  }, [routeDepartures, effectiveDepartureMs])

  const showAlternatives = laterDepartures.length > 0 && waitAtStopSeconds < 120
  const showReset = !!progress.departureIsOverridden && !!onSelectDeparture
  const showExtras = (showAlternatives || showReset) && !!onSelectDeparture

  // Rider ask 2026-09-04 15:08:30, with a screenshot: three `Next: … / Use
  // this` rows took about a third of the card while the rider's actual next
  // action was a 208 ft turn. Collapsed by default, so the list costs one line
  // — the next departure, which is the only one they asked to keep — and the
  // whole of today's list is one tap away. Collapsed is the state on every
  // mount: this card re-renders on every GPS tick, and an expansion that
  // survived a leg change would be a panel the rider never opened.
  const [alternativesOpen, setAlternativesOpen] = useState(false)
  const nextAlternative = laterDepartures[0]

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
    // Plain walk/bike leg with no transit connection next. The turn is the only
    // thing to act on here, so it gets the sub line and the one after it the
    // foot — nothing else is competing for the space.
    eyebrow = intl.formatMessage(
      { defaultMessage: '{emoji} To {stop}', id: 'components.GoMode.toStop' },
      { emoji: accessEmoji, stop: leg.to.name }
    )
    hero = formatMinutes(rideSecondsRemaining)
    sub = turnLine || progress.nextInstruction || null
    foot = thenLine
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
        </NavEyebrowRow>
        {hero && (
          <NavHero>
            {isNextLegTransit ? (
              <RealtimeTime live={departureIsLive}>{hero}</RealtimeTime>
            ) : (
              hero
            )}
          </NavHero>
        )}
        {sub && <NavSub>{sub}</NavSub>}
        {/* Riding to a bus: the departure stays the headline, but the rider's
            next physical action is the turn — so it renders first, directly
            under "arrives in", ahead of the ride-to-stop line. As the trailing
            line it read as more bus info (7/29). While deviated there is no
            turnLine and the card gracefully shows bus facts only. */}
        {isNextLegTransit && turnLine && <NavFoot>{turnLine}</NavFoot>}
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
            {showAlternatives && (
              <>
                {/* The summary row carries the same dashed rule and spacing as
                    a departure row, so collapsing changes the card's height
                    and nothing else about how it reads. */}
                <AlternativeDeparture>
                  <span style={ALTERNATIVE_TEXT_STYLE}>
                    {alternativesOpen
                      ? intl.formatMessage({
                          defaultMessage: 'Later departures',
                          id: 'components.GoMode.laterDepartures'
                        })
                      : departureLine(nextAlternative)}
                  </span>
                  <ResetButton
                    aria-controls={LATER_DEPARTURES_ID}
                    aria-expanded={alternativesOpen}
                    onClick={() => setAlternativesOpen((open) => !open)}
                    type="button"
                  >
                    {alternativesOpen
                      ? `▴ ${intl.formatMessage({
                          defaultMessage: 'Less',
                          id: 'components.GoMode.hideLaterDepartures'
                        })}`
                      : `▾ ${intl.formatMessage({
                          defaultMessage: 'More',
                          id: 'components.GoMode.showLaterDepartures'
                        })}`}
                  </ResetButton>
                </AlternativeDeparture>
                {alternativesOpen && (
                  <div id={LATER_DEPARTURES_ID}>
                    {laterDepartures.map(
                      (
                        alt: { departureMs: number; realtime: boolean },
                        idx: number
                      ) => (
                        <AlternativeDeparture key={idx}>
                          <span style={ALTERNATIVE_TEXT_STYLE}>
                            {departureLine(alt)}
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
                    )}
                  </div>
                )}
              </>
            )}
          </NavExtras>
        )}
      </NavCard>
    </WalkingContainer>
  )
}

export default WalkingNavigation
