import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React, { useEffect, useState } from 'react'
import styled from 'styled-components'

import * as goModeActions from '../../actions/go-mode'
import { epochMs } from '../../util/go-mode/time'
import {
  formatCountdown,
  returnCountdownStage
} from '../../util/go-mode/round-trip'
import type {
  ReturnCountdownStage,
  RoundTripPlan
} from '../../util/go-mode/round-trip'

import {
  RerouteActions,
  RerouteBar,
  RerouteCard,
  RerouteCardTitle,
  RerouteKeepButton,
  RerouteSummary,
  RerouteSwitchButton
} from './styled'

/**
 * The card the rider sees at their destination on a ROUND TRIP, in place of the
 * plain "🎉 You've arrived! / Done" arrival card.
 *
 * Deliberately the same `RerouteBar` / `RerouteCard` primitives as the arrival
 * card it replaces — this is the same card in a different state, not a new
 * surface, and it sits in the same place at the bottom of the Go Mode screen.
 *
 * The one-second tick here is DISPLAY ONLY. Every decision — the stage, the two
 * alerts, the live refresh — is made on the position tick by
 * `runReturnCountdown` against the simulation-aware clock, and this component
 * dispatches nothing and decides nothing. It exists because a countdown that
 * only moves when a GPS fix lands (every 30 s at the destination's idle
 * cadence) reads as frozen. It unmounts with the card, so it cannot outlive the
 * trip the way an out-of-tick `setInterval` did on 2026-08-28.
 */

interface OwnProps {
  onDone: () => void
  /** Injected in the demo gallery; otherwise read off the store. */
  plan?: RoundTripPlan | null
}

interface Props extends OwnProps {
  homeTimezone?: string
  startReturnTrip: () => void
}

// Styled here rather than in ./styled because nothing else uses them and they
// are two lines each: the small caps label above the clock, and the clock.
const ReturnCountdownLabel = styled.div`
  color: #555;
  font-size: 13px;
  margin-bottom: 2px;
`

const ReturnCountdownValue = styled.div`
  color: #222;
  font-size: 34px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  line-height: 1.1;
  margin-bottom: 8px;
`

/** The first transit route of the return, for the one-line summary. */
function returnRouteLabel(plan: RoundTripPlan): string | null {
  const legs: any[] = plan.returnItinerary?.legs || []
  const transit = legs.find((l) => l?.transitLeg)
  if (!transit) return null
  return transit.routeShortName || transit.routeLongName || transit.mode || null
}

export const ReturnCountdownCard = ({
  homeTimezone,
  onDone,
  plan,
  startReturnTrip
}: Props): JSX.Element | null => {
  const intl = useIntl()
  const leaveByMs = plan?.leaveByMs
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    // Wall clock on purpose: this is a rendering of "how long until that time",
    // not a decision about the trip. Nothing here is dispatched, so it cannot
    // disagree with the tick — it can only lag it by under a second.
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  if (!plan || typeof leaveByMs !== 'number' || !Number.isFinite(leaveByMs)) {
    return null
  }

  const stage: ReturnCountdownStage = returnCountdownStage(nowMs, leaveByMs)
  const timeOpts = {
    hour: 'numeric' as const,
    minute: '2-digit' as const,
    ...(homeTimezone ? { timeZone: homeTimezone } : {})
  }

  const countdownLabel =
    stage === 'now'
      ? intl.formatMessage({
          defaultMessage: 'Leave now',
          id: 'components.GoMode.returnLeaveNow'
        })
      : stage === 'missed'
      ? intl.formatMessage({
          defaultMessage: 'Return departure passed',
          id: 'components.GoMode.returnMissed'
        })
      : intl.formatMessage({
          defaultMessage: 'Leave for return in',
          id: 'components.GoMode.returnCountdownLabel'
        })

  const routeLabel = returnRouteLabel(plan)
  const departsMs = epochMs(plan.returnItinerary?.startTime)

  return (
    <RerouteBar>
      <RerouteCard role="status">
        <RerouteCardTitle>
          {intl.formatMessage({
            defaultMessage: "🎉 You've arrived!",
            id: 'components.GoMode.arrivedTitle'
          })}
        </RerouteCardTitle>
        <ReturnCountdownLabel>{countdownLabel}</ReturnCountdownLabel>
        {stage !== 'missed' && (
          <ReturnCountdownValue aria-label={countdownLabel} role="timer">
            {formatCountdown(leaveByMs - nowMs)}
          </ReturnCountdownValue>
        )}
        <RerouteSummary>
          {intl.formatMessage(
            {
              defaultMessage: 'Leave by {time}',
              id: 'components.GoMode.returnLeaveBy'
            },
            { time: intl.formatTime(leaveByMs, timeOpts) }
          )}
          {routeLabel && Number.isFinite(departsMs) && (
            <>
              {' · '}
              {intl.formatMessage(
                {
                  defaultMessage: '{route} departs {time}',
                  id: 'components.GoMode.returnRouteDeparts'
                },
                {
                  route: routeLabel,
                  time: intl.formatTime(departsMs, timeOpts)
                }
              )}
            </>
          )}
        </RerouteSummary>
        <RerouteActions>
          <RerouteSwitchButton onClick={startReturnTrip} type="button">
            {stage === 'missed'
              ? // The thunk re-plans from NOW either way; only the promise
                // changes. Offering "Start return trip" for a departure that
                // left 25 minutes ago would be a claim about a bus that is
                // gone.
                intl.formatMessage({
                  defaultMessage: 'Plan return now',
                  id: 'components.GoMode.returnPlanNow'
                })
              : intl.formatMessage({
                  defaultMessage: 'Start return trip',
                  id: 'components.GoMode.returnStart'
                })}
          </RerouteSwitchButton>
          <RerouteKeepButton onClick={onDone} type="button">
            {intl.formatMessage({
              defaultMessage: 'Done',
              id: 'components.GoMode.arrivedDone'
            })}
          </RerouteKeepButton>
        </RerouteActions>
      </RerouteCard>
    </RerouteBar>
  )
}

const mapStateToProps = (state: any, ownProps: OwnProps) => ({
  homeTimezone: state.otp?.config?.homeTimezone,
  plan: ownProps.plan ?? state.otp?.goMode?.roundTrip ?? null
})

const mapDispatchToProps = {
  startReturnTrip: goModeActions.startReturnTrip
}

export default connect(mapStateToProps, mapDispatchToProps)(ReturnCountdownCard)
