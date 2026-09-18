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
  RerouteSummary,
  RerouteSwitchButton,
  VehicleTrackingBadge
} from './styled'
import OnboardAlightPreview from './OnboardAlightPreview'
import OnboardItineraryList from './OnboardItineraryList'

interface Props {
  changeBus: () => void
  clearOnboard: () => void
  endGoMode: () => void
  goMode: GoModeState
  openOnboardAlightPreview: (
    option: unknown,
    control?: 'row' | 'variant'
  ) => void
}

/**
 * "I'm on the bus" flow UI: shows discovery/optimization progress and, once
 * ready, the recommended stop to get off plus a handoff into live guidance.
 */
const AlightRecommendation = ({
  changeBus,
  clearOnboard,
  endGoMode,
  goMode,
  openOnboardAlightPreview
}: Props) => {
  const intl = useIntl()
  const { onboard } = goMode
  const { status } = onboard

  if (status === 'idle') return null

  // 15.3. The flow reaches this screen with a vehicle it was never asked
  // about: `riding` survives STOP_GO_MODE, so the next "I'm on the bus"
  // re-confirms the remembered trip silently and the rider saw only "Finding
  // the best stop to get off…" — nothing about WHICH bus, and no way to say it
  // was wrong (2026-09-13 11:39, the assumption happened to be right both
  // times, which is why silent is fine and invisible is not). State it; the
  // button beside it corrects it.
  const { vehicle } = onboard
  // Fleet numbers are feed-prefixed internally ("1:32141"); the rider reads
  // the number off the bus. A synthetic "route:<id>" is not a vehicle at all.
  const fleetNumber =
    vehicle?.vehicleId && !vehicle.vehicleId.startsWith('route:')
      ? vehicle.vehicleId.split(':').pop() || null
      : null
  const routeName = vehicle?.label || vehicle?.routeId || fleetNumber
  let assumedVehicle: string | null = null
  if (routeName && fleetNumber && routeName !== fleetNumber) {
    assumedVehicle = intl.formatMessage(
      {
        defaultMessage: 'On the {route} · {vehicle}',
        id: 'components.GoMode.onboardAssumedVehicle'
      },
      { route: routeName, vehicle: fleetNumber }
    )
  } else if (routeName) {
    assumedVehicle = intl.formatMessage(
      {
        defaultMessage: 'On the {route}',
        id: 'components.GoMode.onboardAssumedRoute'
      },
      { route: routeName }
    )
  }

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

    // Only once a vehicle has actually been adopted — while discovering, or
    // with the picker open, there is no assumption to state.
    const stateTheAssumption =
      !!assumedVehicle &&
      (status === 'fetching-schedule' || status === 'optimizing')

    return (
      <RerouteBar>
        <RerouteCard>
          {stateTheAssumption && (
            <VehicleTrackingBadge
              $confirmed
              data-testid="onboard-assumed-vehicle"
            >
              {assumedVehicle}
            </VehicleTrackingBadge>
          )}
          <RerouteCardTitle>{message}</RerouteCardTitle>
          {stateTheAssumption && (
            <RerouteActions style={{ marginTop: 10 }}>
              <RerouteKeepButton onClick={changeBus} type="button">
                {intl.formatMessage({
                  defaultMessage: 'Not this one',
                  id: 'components.GoMode.onboardNotThisVehicle'
                })}
              </RerouteKeepButton>
            </RerouteActions>
          )}
        </RerouteCard>
      </RerouteBar>
    )
  }

  if (status === 'error') {
    // 17.17. The second button is the rider's only way off this card that is
    // not "Choose bus", and it used to be `endGoMode` UNCONDITIONALLY — over a
    // trip that is still running. `replanFromAboard` opens this flow mid-ride
    // (the panel renders OVER the live trip; onboard.status !== 'idle' is what
    // puts it there), so on a failed bus search aboard the bus the rider's
    // only exit killed the whole trip: tracking, the itinerary, the vehicle
    // lock, everything, from a card that is only about the search that failed.
    // The asymmetry is already settled for the header Back button one level up
    // — `GoModeScreen.tsx:183-188` sends back to `clearOnboard` when
    // `goMode.activeItinerary` exists and to `handleOnboardExit` (confirm,
    // then end) when it does not, and 17.1's preview added a third level above
    // both. This card gets the same rule.
    //
    // PRE-TRIP IS UNCHANGED, deliberately: `BEGIN_ONBOARD_FLOW` has already
    // nulled `activeItinerary` there, so there is no trip to go back to and
    // Cancel really does mean "never mind" — ending Go Mode is the only honest
    // thing it can do. No confirm is added on that path either: unlike the
    // header's back button (hit twice by accident on 8/9) this is a button the
    // rider chose that says Cancel.
    const midRide = !!goMode.activeItinerary
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
            <RerouteKeepButton
              data-testid={
                midRide ? 'onboard-error-back-to-trip' : 'onboard-error-cancel'
              }
              onClick={midRide ? clearOnboard : endGoMode}
              type="button"
            >
              {midRide
                ? // Mid-ride the button no longer cancels anything, so it must
                  // not say Cancel — it dismisses this panel and leaves the
                  // rider on the trip they are on.
                  intl.formatMessage({
                    defaultMessage: 'Back to trip',
                    id: 'components.GoMode.onboardBackToTrip'
                  })
                : intl.formatMessage({
                    defaultMessage: 'Cancel',
                    id: 'components.GoMode.onboardCancel'
                  })}
            </RerouteKeepButton>
          </RerouteActions>
        </RerouteCard>
      </RerouteBar>
    )
  }

  // status === 'ready' — the best onward options (earliest arrival first),
  // one per candidate alight stop, rendered through the app's NORMAL
  // itinerary-results list so each row carries the familiar full detail
  // (times, transfers, bike/walk legs with distances). A "Go Mode is live"
  // banner keeps the context clear; tapping a row opens its preview.
  const options = onboard.alightOptions || []
  if (options.length === 0) return null

  // The preview is its own screen over the list (17.1). The list is NOT
  // unmounted from state — `onboard.alightOptions` stands untouched underneath
  // — so "Back to options" is a pure state change and costs no re-plan and no
  // refetch. Before this, a row tap committed the trip and `clearOnboard()`
  // threw the list away; recovering it on 2026-09-15 cost five OTP plan
  // requests over 12 s.
  if (onboard.preview) return <OnboardAlightPreview />

  // Both open the preview; which control it came from is recorded (17.11).
  const previewFromRow = (option: unknown) =>
    openOnboardAlightPreview(option, 'row')
  const previewFromVariant = (option: unknown) =>
    openOnboardAlightPreview(option, 'variant')

  // The list is ranked from whatever answered by the optimizer's deadline
  // (4.1), so it can legitimately be short. Say so rather than presenting two
  // of five candidate stops as the whole answer — a straggler that lands is
  // folded in behind this line (optimizeAlightFromTrip's foldInLateResult).
  const stillChecking = onboard.pendingCandidates || 0
  // 17.3: "still checking" was the only thing this panel could say, and a
  // candidate that FAILED is not pending — on 2026-09-15 three of five failed,
  // pendingCandidates was 0, and two stops were shown as the whole answer in
  // silence. A failure is its own sentence, and only after the retries have
  // settled: while they are in flight the line above is the true one.
  const answered = onboard.answeredCandidates || 0
  const total = onboard.totalCandidates || 0
  const failed = onboard.failedCandidates || 0
  const showAnsweredCount = stillChecking === 0 && failed > 0 && total > 0

  return (
    <OnboardResultsScroll>
      <GoModeLiveBanner>
        {intl.formatMessage({
          defaultMessage: 'Go Mode is live — tracking your bus',
          id: 'components.GoMode.liveBanner'
        })}
      </GoModeLiveBanner>
      {assumedVehicle && (
        <VehicleTrackingBadge
          $confirmed
          data-testid="onboard-assumed-vehicle"
          style={{ margin: '8px 16px 0' }}
        >
          {assumedVehicle}
        </VehicleTrackingBadge>
      )}
      <RerouteCardTitle style={{ padding: '12px 16px 0' }}>
        {intl.formatMessage({
          defaultMessage: 'Where do you want to get off?',
          id: 'components.GoMode.whereToAlight'
        })}
      </RerouteCardTitle>
      {stillChecking > 0 && (
        <RerouteSummary
          data-testid="onboard-still-checking"
          style={{ marginBottom: 0, padding: '0 16px' }}
        >
          {intl.formatMessage(
            {
              defaultMessage:
                'Still checking {count, plural, one {1 more stop} other {# more stops}}…',
              id: 'components.GoMode.stillCheckingStops'
            },
            { count: stillChecking }
          )}
        </RerouteSummary>
      )}
      {showAnsweredCount && (
        <RerouteSummary
          data-testid="onboard-answered-count"
          style={{ marginBottom: 0, padding: '0 16px' }}
        >
          {intl.formatMessage(
            {
              defaultMessage: '{answered} of {total} stops answered',
              id: 'components.GoMode.stopsAnswered'
            },
            { answered, total }
          )}
        </RerouteSummary>
      )}
      <OnboardItineraryList
        onPreview={previewFromRow}
        onPreviewVariant={previewFromVariant}
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
  // "Not this one" / "Change bus" is the rider contradicting the app, so it
  // goes through the deny path (15.3): rediscoverOnboardVehicles alone leaves
  // the riding fact standing and the next onboard flow re-adopts the vehicle
  // they just rejected.
  changeBus: goModeActions.denyOnboardVehicle,
  // Mid-ride exit from the error card: dismiss the onboard panel and leave the
  // live trip running (17.17). Never endGoMode while activeItinerary stands.
  clearOnboard: goModeActions.clearOnboard,
  endGoMode: goModeActions.endGoMode,
  // A row tap PREVIEWS. confirmOnboardAlightStop is reachable from the preview
  // screen's own Confirm control now (OnboardAlightPreview) and nowhere else
  // in this flow.
  openOnboardAlightPreview: goModeActions.openOnboardAlightPreview
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(AlightRecommendation)
