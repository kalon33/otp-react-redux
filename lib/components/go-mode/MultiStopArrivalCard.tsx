import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React, { useState } from 'react'

import * as goModeActions from '../../actions/go-mode'
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
 */

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
        <RerouteSummary>{here}</RerouteSummary>
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
