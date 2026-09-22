import { useIntl } from 'react-intl'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Leg } from '@opentripplanner/types'

import {
  accessSecondsToBoardStop,
  TripProgress
} from '../../util/go-mode/progress-calculator'
import {
  asContinuation,
  formatCueDistance
} from '../../util/go-mode/turn-by-turn'
import {
  getLegRouteId,
  getRouteDepartures,
  getSoonestCatchableMs,
  HeldDeparture,
  legBoardingDirection,
  resolveCardDeparture
} from '../../util/go-mode/departure-anchor'

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

/**
 * How long past a departure time the card still counts down rather than
 * calling the bus gone. The epoch is a prediction and a bus dwells at the
 * kerb, so a few seconds either side is not evidence it has left; two minutes
 * in the past is (see formatMinutes / backlog 12.16).
 */
const DEPARTED_GRACE_S = 30

/** Verbatim the inline style the departure rows already used. */
const ALTERNATIVE_TEXT_STYLE = {
  fontSize: '13px',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const
}

interface Props {
  /** Trip over (goMode.arrivedAt set): no turn cues. See CurrentLegPanel. */
  arrived?: boolean
  boardingStopData?: any
  departureOverride?: number | null
  leg: Leg
  nextLeg?: Leg
  /**
   * Told when the departure this card headlines is NOT the one the tick
   * pipeline is running its wait math on. Recording only — see 16.3: on
   * 2026-09-15 the card said 10:09 while UPDATE_PROGRESS counted down to
   * 09:54:02 and nothing anywhere noticed the two had parted company.
   */
  onDepartureMismatch?: (info: {
    cardDepartureMs: number | null
    heldTripId: string | null
    reason: string
    tickDepartureMs: number | null
  }) => void
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
  arrived,
  boardingStopData,
  departureOverride,
  leg,
  nextLeg,
  onDepartureMismatch,
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

  /**
   * Minutes of an interval that is still AHEAD. `<1 min` is a floor, so a
   * negative interval must never reach it: handed −109 s at 10:09:22 on
   * 2026-09-08 it returned the floor string and the card said the bus
   * "arrives in <1 min" about a departure nearly two minutes in the past —
   * that sentence, not the wrong time, is what the rider answered with "Not
   * true bus left" (backlog 12.16).
   *
   * `rideSecondsRemaining` is clamped at 0 where it is computed, so the bus
   * countdown is the one input here that can go negative, and `hasElapsed`
   * gates it at its own call site below.
   */
  const formatMinutes = (seconds: number): string => {
    const mins = Math.round(seconds / 60)
    return mins <= 0 ? '<1 min' : `${mins} min`
  }

  /** The interval has run out — see formatMinutes. */
  const hasElapsed = (seconds: number): boolean => seconds < -DEPARTED_GRACE_S

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

  /**
   * How long the rider still needs to reach the boarding stop.
   *
   * Distance still in front of them over the pace they are actually keeping —
   * `accessSecondsToBoardStop` on this one leg, which takes the rider's
   * measured rolling pace on a BICYCLE leg, else the leg's own planned pace
   * (distance/duration), else the mode's figure. `leg.duration x (1 -
   * progress)` is the fallback, for a leg that carries no distance.
   *
   * The plan's duration was the whole input before 16.3, and it is the worst
   * of the three: it is OTP's estimate for somebody else's bike speed, and it
   * is scaled by a progress figure that can freeze. On 2026-09-15 an 847 s leg
   * sat at 0 % progress the whole way to the stop, so this counted the full
   * 847 s of a ride the rider was most of the way through — and five seconds
   * of the resulting threshold is what moved the card off the bus they caught.
   */
  const rideSecondsRemaining = Math.max(
    0,
    accessSecondsToBoardStop(
      [leg],
      0,
      progress.currentLegProgress,
      progress.riderPaceMps ?? null
    ) ?? (leg.duration || 0) * (1 - progress.currentLegProgress / 100)
  )

  const route = nextLeg?.routeShortName || nextLeg?.routeLongName || ''
  const stopName = nextLeg?.from?.name || leg.to.name
  const isBike = leg.mode === 'BICYCLE'
  const accessEmoji = isBike ? '🚲' : '🚶'

  // Turn-by-turn guidance for this access leg, when the leg carries steps.
  // Off the corridor the metres are a straight line from the rider's own fix
  // to the corner, not a distance along a route they have left — say so, or
  // the number reads as a countdown it isn't.
  //
  // Once the rider has ARRIVED there is no next turn to take, and the cue is
  // stale by construction — progress stops being recomputed for a finished
  // trip, so whatever corner was pending at the latch stays on the card. On
  // 2026-09-09 that put "<1 min · Turn right on alley · 39 ft" directly above
  // "🎉 You've arrived!". Nothing here is a notification, so there is no copy
  // to replace it with: the lines simply go.
  const turnLine =
    !arrived && progress.nextTurnCue && progress.distanceToNextTurn != null
      ? `${progress.nextTurnCue.instruction} · ${formatCueDistance(
          progress.distanceToNextTurn
        )}${progress.turnDistanceIsDirect ? ' direct' : ''}`
      : null
  const thenLine =
    !arrived && progress.followingTurnCue
      ? intl.formatMessage(
          { defaultMessage: 'then {turn}', id: 'components.GoMode.thenTurn' },
          { turn: asContinuation(progress.followingTurnCue.instruction) }
        )
      : null

  const nextLegRouteId = getLegRouteId(nextLeg)

  // All upcoming departures of the boarding route at the boarding stop, from
  // the stop-times data (re-polled while walking; sorted earliest first).
  //
  // Narrowed to the direction the BOARDING LEG goes: a stop serves both
  // directions of a route as often as not, and on 2026-09-21 at 16:15:31 the
  // southbound 465 sat in this list against a rider waiting for the northbound
  // and was adopted as "a meaningfully earlier run of the same route" (19.1).
  const boardingDirection = useMemo(
    () => legBoardingDirection(nextLeg),
    [nextLeg]
  )
  const routeDepartures = useMemo(
    () =>
      isNextLegTransit
        ? getRouteDepartures(
            boardingStopData,
            nextLegRouteId,
            boardingDirection
          )
        : [],
    [boardingStopData, boardingDirection, isNextLegTransit, nextLegRouteId]
  )

  const soonestCatchableMs = useMemo(
    () => getSoonestCatchableMs(routeDepartures, nowMs, rideSecondsRemaining),
    [routeDepartures, nowMs, rideSecondsRemaining]
  )

  /**
   * The departure the card commits to, with hysteresis (16.3).
   *
   * `soonestCatchableMs` above is a PROJECTION. It may seed this anchor and it
   * may make the card read tight, but it may not move the anchor forward once
   * the rider is counting down to a bus: that takes physical evidence, which
   * `resolveCardDeparture` gets from the missed-bus classifier's verdict
   * (`progress.boardingMiss`) and from the run leaving the feed. A
   * realtime->schedule flip moves the number and keeps the bus.
   *
   * The hold is a ref, not state: this card re-renders on every GPS tick and
   * the decision has to be available in the same render that produced it (a
   * setState would show the projection's answer for one tick, which is the
   * whole bug). It is re-keyed on the boarding — a different route or stop is
   * a different anchor, and a re-mount mid-leg starts over, which is the same
   * position the card was in before any of this.
   */
  const holdKey = `${nextLegRouteId ?? ''}|${
    (nextLeg as any)?.from?.stop?.gtfsId ?? ''
  }`
  const holdRef = useRef<{ held: HeldDeparture | null; key: string }>({
    held: null,
    key: holdKey
  })
  if (holdRef.current.key !== holdKey) {
    holdRef.current = { held: null, key: holdKey }
  }

  const departureInput = {
    boardingMiss: progress.boardingMiss ?? null,
    candidateMs: soonestCatchableMs,
    departures: routeDepartures,
    held: isNextLegTransit ? holdRef.current.held : null,
    nowMs,
    plannedDepartureMs: progress.plannedDepartureTime ?? null,
    // The run the rest of the trip is on. The card may hold that one and no
    // other (19.1) — when the plan moves to an earlier bus (23.3) the card
    // follows it there, and when the card has wandered it comes back.
    tickTripId: boardingDirection.tripId ?? null
  }

  const decision = resolveCardDeparture({
    ...departureInput,
    departureOverride: departureOverride ?? null
  })

  /**
   * What this card would headline if the override went away — the departure
   * "Reset to planned" actually hands back (18.1).
   *
   * It has to be resolved separately because the override branch of
   * `resolveCardDeparture` returns the override and nothing else, so with the
   * override in force the card has no other way to know what it is holding
   * the rider back from.
   *
   * The hold ref then carries THIS decision's hold rather than the override's.
   * That is the half that makes the control honest: the hold used to be
   * re-seeded from the override on every render, so releasing the override
   * left the card holding the override's own run and the headline never moved
   * — the rider tapped a control that could not change the number it sits
   * under. Tracking the un-overridden resolution instead means the release
   * lands on exactly the departure this label names. It is also what
   * `evaluateDepartureAnchor` already documents for its own `clear` path
   * ("with the override gone the display and the anchor both fall back to the
   * soonest departure the rider CAN catch"), which the old re-seed defeated.
   */
  const releasedDecision =
    departureOverride != null && Number.isFinite(departureOverride)
      ? resolveCardDeparture({ ...departureInput, departureOverride: null })
      : decision
  if (isNextLegTransit) holdRef.current.held = releasedDecision.held

  const effectiveDepartureMs =
    decision.departureMs || progress.plannedDepartureTime

  // The tick pipeline runs its wait math on its own departure
  // (progress.effectiveDepartureMs = override || live board || plan). When the
  // two disagree the rider is reading one number while every notification is
  // timed off another — 16.3's entire failure mode — so it goes in the debug
  // stream rather than being quietly resolved in favour of either.
  const tickDepartureMs = progress.effectiveDepartureMs ?? null
  const mismatch =
    isNextLegTransit &&
    !!effectiveDepartureMs &&
    tickDepartureMs != null &&
    effectiveDepartureMs !== tickDepartureMs
  useEffect(() => {
    if (!mismatch) return
    onDepartureMismatch?.({
      cardDepartureMs: effectiveDepartureMs ?? null,
      heldTripId: decision.held?.tripId ?? null,
      reason: decision.reason,
      tickDepartureMs
    })
    // The pair is the event: re-log when either side moves, not every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mismatch, effectiveDepartureMs, tickDepartureMs])

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

  /**
   * The departure "Reset to planned" gives back, named on the control itself.
   *
   * 2026-09-17 17:57:39, with a screenshot: *"Reset to planned? What's the
   * point? I don't know what that means. And it did nothing."* The tap was
   * mechanically correct — `SET_DEPARTURE_OVERRIDE {ms: null, source:
   * 'rider'}` at 17:57:09, `departureIsOverridden` true->false on the next
   * tick — but the override was 17:57:53 and what it fell back to was
   * 17:57:00, and both render "5:57 PM". The rider was offered a control
   * that named neither time and then changed nothing they could see.
   *
   * So the control states the time it restores, and it is offered only when
   * that time READS differently from the one in force. Comparing the rendered
   * strings rather than the epochs is deliberate: a 53-second difference is
   * invisible on a card that shows minutes, and an affordance whose whole
   * effect is invisible is worse than no affordance.
   */
  const resetDepartureMs =
    releasedDecision.departureMs ?? progress.plannedDepartureTime ?? null
  const resetWouldShowSameTime =
    resetDepartureMs == null ||
    !effectiveDepartureMs ||
    formatClockTime(resetDepartureMs) === formatClockTime(effectiveDepartureMs)
  const showReset =
    !!progress.departureIsOverridden &&
    !!onSelectDeparture &&
    !resetWouldShowSameTime
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
    // The clock time stays the headline — it is the departure the rider was
    // told about — and the line under it says whether it is still ahead. A bus
    // whose time has passed gets its own word; the countdown cannot describe
    // it (12.16).
    sub = hasElapsed(busInSeconds)
      ? intl.formatMessage({
          defaultMessage: 'departed',
          id: 'components.GoMode.departureGone'
        })
      : intl.formatMessage(
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
    // `nextInstruction` is the same turn in plainer words, so it goes with the
    // rest of them once the trip is over.
    sub = arrived ? null : turnLine || progress.nextInstruction || null
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
                {intl.formatMessage(
                  {
                    defaultMessage: 'Back to {time} (planned)',
                    id: 'components.GoMode.resetToPlanned'
                  },
                  { time: formatClockTime(resetDepartureMs as number) }
                )}
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
