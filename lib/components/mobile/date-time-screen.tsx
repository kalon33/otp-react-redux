import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import coreUtils from '@opentripplanner/core-utils'
import React, { useCallback } from 'react'
import styled from 'styled-components'

import * as formActions from '../../actions/form'
import * as narrativeActions from '../../actions/narrative'
import * as uiActions from '../../actions/ui'
import { MobileDateTimeCard } from '../form/batch-styled'
import { MobileScreens } from '../../actions/ui-constants'
import DateTimeModal, {
  DepartArriveValue,
  setQueryParamMiddleware
} from '../form/date-time-modal'
import PlanTripButton from '../form/plan-trip-button'

import MobileContainer from './container'
import MobileNavigationBar from './navigation-bar'

const { getCurrentDate, getCurrentTime } = coreUtils.time

const OPTIONS: { id: string; type: DepartArriveValue }[] = [
  { id: 'otpUi.DateTimeSelector.now', type: 'NOW' },
  { id: 'otpUi.DateTimeSelector.depart', type: 'DEPART' },
  { id: 'otpUi.DateTimeSelector.arrive', type: 'ARRIVE' }
]

/** Leave now · Depart at · Arrive by, one segmented pill group. */
const Segments = styled.div`
  background-color: var(--tn-surface);
  border-radius: var(--tn-radius-pill);
  box-shadow: var(--tn-shadow);
  display: flex;
  gap: var(--tn-space-1);
  margin-bottom: var(--tn-space-3);
  padding: var(--tn-space-1);

  button {
    background-color: transparent;
    border: 0;
    border-radius: var(--tn-radius-pill);
    color: var(--tn-text-2);
    flex: 1 1 0;
    font: 500 15px/20px var(--tn-font);
    min-height: var(--tn-tap);
    min-width: 0;
    overflow: hidden;
    padding: 0 var(--tn-space-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button[aria-pressed='true'] {
    background-color: var(--tn-accent-soft);
    color: var(--tn-accent);
    font-weight: 600;
  }
  button:focus-visible {
    outline: 2px solid var(--tn-accent);
    outline-offset: 0;
  }
`

interface Props {
  departArrive: DepartArriveValue
  homeTimezone: string
  setMobileScreen: (screen: number) => void
  setQueryParam: (params: any) => void
  sort: any
  syncSortWithDepartArrive?: boolean
  updateItineraryFilter: (payload: any) => void
}

const MobileDateTimeScreen = ({
  departArrive,
  homeTimezone,
  setMobileScreen,
  setQueryParam,
  sort,
  syncSortWithDepartArrive,
  updateItineraryFilter
}: Props) => {
  const intl = useIntl()

  // The same params the depart/arrive dropdown sends (trip-form's
  // DepartArriveDropdown): "Leave now" also resets the clock to now.
  const choose = useCallback(
    (type: DepartArriveValue) =>
      setQueryParamMiddleware(
        syncSortWithDepartArrive,
        updateItineraryFilter,
        type === 'NOW'
          ? {
              date: getCurrentDate(homeTimezone),
              departArrive: 'NOW',
              time: getCurrentTime(homeTimezone)
            }
          : { departArrive: type },
        setQueryParam,
        sort
      ),
    [
      homeTimezone,
      setQueryParam,
      sort,
      syncSortWithDepartArrive,
      updateItineraryFilter
    ]
  )

  return (
    <MobileContainer>
      <MobileNavigationBar
        backScreen={MobileScreens.SEARCH_FORM}
        headerText={intl.formatMessage({
          id: 'components.DateTimeScreen.header'
        })}
        showBackButton
      />
      <main tabIndex={-1}>
        <div className="options-main-content mobile-padding date-time-screen">
          <Segments
            aria-label={intl.formatMessage({
              id: 'components.DateTimePreview.editDepartOrArrival'
            })}
            role="group"
          >
            {OPTIONS.map((option) => (
              <button
                aria-pressed={departArrive === option.type}
                key={option.type}
                onClick={() => choose(option.type)}
                type="button"
              >
                {intl.formatMessage({ id: option.id })}
              </button>
            ))}
          </Segments>
          <MobileDateTimeCard>
            <DateTimeModal />
          </MobileDateTimeCard>
        </div>

        <div className="options-lower-tray mobile-padding">
          <PlanTripButton
            onClick={useCallback(
              () => setMobileScreen(MobileScreens.RESULTS_SUMMARY),
              [setMobileScreen]
            )}
            text={intl.formatMessage({
              id: 'components.BatchSettings.planTripTooltip'
            })}
          />
        </div>
      </main>
    </MobileContainer>
  )
}

// connect to the redux store

const mapStateToProps = (state: any) => {
  const { config, currentQuery, filter } = state.otp
  return {
    departArrive: currentQuery.departArrive,
    homeTimezone: config.homeTimezone,
    sort: filter.sort,
    syncSortWithDepartArrive: config?.itinerary?.syncSortWithDepartArrive
  }
}

const mapDispatchToProps = {
  setMobileScreen: uiActions.setMobileScreen,
  setQueryParam: formActions.setQueryParam,
  updateItineraryFilter: narrativeActions.updateItineraryFilter
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(MobileDateTimeScreen)
