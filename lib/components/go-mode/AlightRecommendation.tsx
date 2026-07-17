import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React from 'react'

import * as goModeActions from '../../actions/go-mode'
import type { GoModeState } from '../../reducers/go-mode'

import {
  GoModeLiveBanner,
  OnboardResultsScroll,
  RerouteActions,
  RerouteBar,
  RerouteCard,
  RerouteCardTitle,
  RerouteKeepButton,
  RerouteSwitchButton
} from './styled'
import OnboardItineraryList from './OnboardItineraryList'

interface Props {
  changeBus: () => void
  confirmOnboardAlightStop: (option?: unknown) => void
  endGoMode: () => void
  goMode: GoModeState
}

/**
 * "I'm on the bus" flow UI: shows discovery/optimization progress and, once
 * ready, the recommended stop to get off plus a handoff into live guidance.
 */
const AlightRecommendation = ({
  changeBus,
  confirmOnboardAlightStop,
  endGoMode,
  goMode
}: Props) => {
  const intl = useIntl()
  const { onboard } = goMode
  const { status } = onboard

  if (status === 'idle') return null

  if (
    status === 'discovering' ||
    status === 'awaiting-selection' ||
    status === 'fetching-schedule' ||
    status === 'optimizing'
  ) {
    let message: string
    if (status === 'discovering') {
      message = intl.formatMessage({
        defaultMessage: 'Finding your bus\u2026',
        id: 'components.GoMode.findingYourBus'
      })
    } else if (status === 'awaiting-selection') {
      message = intl.formatMessage({
        defaultMessage: 'Which bus are you on? Pick it below.',
        id: 'components.GoMode.pickYourBus'
      })
    } else if (status === 'fetching-schedule') {
      message = intl.formatMessage({
        defaultMessage: 'Loading the schedule for your bus\u2026',
        id: 'components.GoMode.loadingSchedule'
      })
    } else {
      message = intl.formatMessage({
        defaultMessage: 'Finding the best stop to get off\u2026',
        id: 'components.GoMode.findingBestStop'
      })
    }

    return (
      <RerouteBar>
        <RerouteCard>
          <RerouteCardTitle>{message}</RerouteCardTitle>
        </RerouteCard>
      </RerouteBar>
    )
  }

  if (status === 'error') {
    return (
      <RerouteBar>
        <RerouteCard>
          <RerouteCardTitle>
            {intl.formatMessage({
              defaultMessage: "Couldn't work out your bus. Try again?",
              id: 'components.GoMode.onboardError'
            })}
          </RerouteCardTitle>
          <RerouteActions>
            <RerouteSwitchButton onClick={changeBus} type="button">
              {intl.formatMessage({
                defaultMessage: 'Choose bus',
                id: 'components.GoMode.chooseBus'
              })}
            </RerouteSwitchButton>
            <RerouteKeepButton onClick={endGoMode} type="button">
              {intl.formatMessage({
                defaultMessage: 'Cancel',
                id: 'components.GoMode.onboardCancel'
              })}
            </RerouteKeepButton>
          </RerouteActions>
        </RerouteCard>
      </RerouteBar>
    )
  }

  // status === 'ready' \u2014 the best onward options (earliest arrival first),
  // one per candidate alight stop, rendered through the app's NORMAL
  // itinerary-results list so each row carries the familiar full detail
  // (times, transfers, bike/walk legs with distances). A "Go Mode is live"
  // banner keeps the context clear; tapping a row starts guidance.
  const options = onboard.alightOptions || []
  if (options.length === 0) return null

  return (
    <OnboardResultsScroll>
      <GoModeLiveBanner>
        {intl.formatMessage({
          defaultMessage: 'Go Mode is live \u2014 tracking your bus',
          id: 'components.GoMode.liveBanner'
        })}
      </GoModeLiveBanner>
      <RerouteCardTitle style={{ padding: '12px 16px 0' }}>
        {intl.formatMessage({
          defaultMessage: 'Where do you want to get off?',
          id: 'components.GoMode.whereToAlight'
        })}
      </RerouteCardTitle>
      <OnboardItineraryList
        onSelect={(option) => confirmOnboardAlightStop(option)}
        options={options}
      />
      <RerouteActions style={{ padding: '0 16px 16px' }}>
        <RerouteKeepButton onClick={changeBus} type="button">
          {intl.formatMessage({
            defaultMessage: 'Change bus',
            id: 'components.GoMode.changeBus'
          })}
        </RerouteKeepButton>
      </RerouteActions>
    </OnboardResultsScroll>
  )
}

const mapStateToProps = (state: any) => ({
  goMode: state.otp?.goMode
})

const mapDispatchToProps = {
  changeBus: goModeActions.rediscoverOnboardVehicles,
  confirmOnboardAlightStop: goModeActions.confirmOnboardAlightStop,
  endGoMode: goModeActions.endGoMode
}

export default connect(mapStateToProps, mapDispatchToProps)(AlightRecommendation)
