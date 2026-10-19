import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React, { useState } from 'react'

import * as goModeActions from '../../actions/go-mode'
import { epochMs } from '../../util/go-mode/time'
import type { MultiStopPlan } from '../../util/multi-stop'

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
 * The card at one of the rider's STOPS on a multi-stop trip (backlog 43.1), in
 * place of the plain "You've arrived! / Done" card. The trip is not over: the
 * primary button starts the next segment (continueMultiStop), and "End trip"
 * is the same Done the plain card has.
 *
 * Same RerouteBar / RerouteCard primitives as the arrival card and the round
 * trip's countdown — one card in another state, in the same place.
 *
 * When the plan had the rider stay here (backlog 58.3), the card says until
 * when. Advisory only: "Continue" still plans the next segment from now.
 */

/** When the planned next segment leaves, if that is after the arrival here. */
function plannedLeave(plan: MultiStopPlan): number | null {
  const here = plan.segments[plan.index]
  const next = plan.segments[plan.index + 1]
  const arrive = epochMs(here?.endTime as any)
  const leave = epochMs(next?.legs?.[0]?.startTime as any)
  if (!Number.isFinite(arrive) || !Number.isFinite(leave)) return null
  return leave - arrive >= 60000 ? leave : null
}

interface OwnProps {
  onDone: () => void
  /** Injected in tests and the demo gallery; otherwise read off the store. */
  plan?: MultiStopPlan | null
}

interface Props extends OwnProps {
  continueMultiStop: () => Promise<void> | void
}

function MultiStopArrivalCard({
  continueMultiStop,
  onDone,
  plan
}: Props): JSX.Element | null {
  const intl = useIntl()
  const [starting, setStarting] = useState(false)
  if (!plan || plan.index >= plan.segments.length - 1) return null

  const total = plan.segments.length - 1
  const here = plan.stopNames[plan.index] || ''
  const next = plan.stopNames[plan.index + 1] || ''
  const leave = plannedLeave(plan)

  const handleContinue = async () => {
    if (starting) return
    setStarting(true)
    try {
      await continueMultiStop()
    } finally {
      setStarting(false)
    }
  }

  return (
    <RerouteBar>
      <RerouteCard className="multi-stop-arrival" role="status">
        <RerouteCardTitle>
          {intl.formatMessage(
            { id: 'components.MultiStop.arrivedAtStop' },
            { number: plan.index + 1, total }
          )}
        </RerouteCardTitle>
        <RerouteSummary>
          {here}
          {leave !== null && (
            <>
              {' · '}
              {intl.formatMessage(
                { id: 'components.MultiStop.plannedStay' },
                { time: intl.formatTime(leave) }
              )}
            </>
          )}
        </RerouteSummary>
        <RerouteActions>
          <RerouteSwitchButton
            disabled={starting}
            onClick={handleContinue}
            type="button"
          >
            {starting
              ? intl.formatMessage({ id: 'components.MultiStop.finding' })
              : intl.formatMessage(
                  { id: 'components.MultiStop.continueTo' },
                  { destination: next }
                )}
          </RerouteSwitchButton>
          <RerouteKeepButton onClick={onDone} type="button">
            {intl.formatMessage({ id: 'components.MultiStop.endTrip' })}
          </RerouteKeepButton>
        </RerouteActions>
      </RerouteCard>
    </RerouteBar>
  )
}

const mapStateToProps = (state: any, ownProps: OwnProps) => ({
  plan: ownProps.plan ?? state.otp?.goMode?.multiStop ?? null
})

const mapDispatchToProps = {
  continueMultiStop: goModeActions.continueMultiStop
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(MultiStopArrivalCard)
