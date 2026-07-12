import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React from 'react'

import * as goModeActions from '../../actions/go-mode'
import type { GoModeState } from '../../reducers/go-mode'

import {
  AltRow,
  AltSwitchButton,
  RerouteActions,
  RerouteBar,
  RerouteCard,
  RerouteCardTitle,
  RerouteKeepButton,
  RerouteSwitchButton,
  VehicleDetail,
  VehicleInfo,
  VehicleLabel
} from './styled'
import RealtimeTime from './RealtimeTime'

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
        defaultMessage: 'Finding your bus…',
        id: 'components.GoMode.findingYourBus'
      })
    } else if (status === 'awaiting-selection') {
      message = intl.formatMessage({
        defaultMessage: 'Which bus are you on? Pick it below.',
        id: 'components.GoMode.pickYourBus'
      })
    } else if (status === 'fetching-schedule') {
      message = intl.formatMessage({
        defaultMessage: 'Loading the schedule for your bus…',
        id: 'components.GoMode.loadingSchedule'
      })
    } else {
      message = intl.formatMessage({
        defaultMessage: 'Finding the best stop to get off…',
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
                id: 'components.GoMode.changeBus'
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

  // status === 'ready' — a ranked list of the best onward options (earliest
  // arrival first), each a stop the rider can choose to get off at.
  const options = onboard.alightOptions || []
  if (options.length === 0) return null

  return (
    <RerouteBar>
      <RerouteCard>
        <RerouteCardTitle>
          {intl.formatMessage({
            defaultMessage: 'Where do you want to get off?',
            id: 'components.GoMode.whereToAlight'
          })}
        </RerouteCardTitle>
        {options.map((option, i) => {
          const arrivalTime = new Date(
            option.busArrivalEpoch + (option.itinerary.duration || 0) * 1000
          )
          return (
            <AltRow key={`${option.stopId}-${i}`}>
              <VehicleInfo>
                <VehicleLabel>
                  {intl.formatMessage(
                    {
                      defaultMessage: 'Off at {stop}',
                      id: 'components.GoMode.offAtStop'
                    },
                    { stop: option.stopName }
                  )}
                </VehicleLabel>
                <VehicleDetail>
                  {intl.formatMessage(
                    {
                      defaultMessage:
                        '{arrival} · {transfers, plural, one {# more transfer} other {# more transfers}} · {walk} m walk',
                      id: 'components.GoMode.alightSummary'
                    },
                    {
                      arrival: (
                        <RealtimeTime live={option.realtime}>
                          {arrivalTime.toLocaleTimeString([], {
                            hour: 'numeric',
                            minute: '2-digit'
                          })}
                        </RealtimeTime>
                      ),
                      transfers: option.itinerary.transfers ?? 0,
                      walk: Math.round(option.itinerary.walkDistance ?? 0)
                    }
                  )}
                </VehicleDetail>
              </VehicleInfo>
              <AltSwitchButton
                onClick={() => confirmOnboardAlightStop(option)}
                type="button"
              >
                {intl.formatMessage({
                  defaultMessage: 'Go',
                  id: 'components.GoMode.startGuidanceShort'
                })}
              </AltSwitchButton>
            </AltRow>
          )
        })}
        <RerouteActions>
          <RerouteKeepButton onClick={changeBus} type="button">
            {intl.formatMessage({
              defaultMessage: 'Change bus',
              id: 'components.GoMode.changeBus'
            })}
          </RerouteKeepButton>
        </RerouteActions>
      </RerouteCard>
    </RerouteBar>
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

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(AlightRecommendation)
