import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React from 'react'
import type { Itinerary, Leg } from '@opentripplanner/types'

import * as goModeActions from '../../actions/go-mode'
import { getModeIcon } from '../../util/go-mode/mode-icon'
import type { OnboardAlightPreview as PreviewState } from '../../reducers/go-mode'

import {
  GoModeLiveBanner,
  LegIcon,
  LegInfo,
  LegRow,
  LegSubtitle,
  LegTitle,
  OnboardResultsScroll,
  RerouteActions,
  RerouteCardTitle,
  RerouteKeepButton,
  RerouteSummary,
  RerouteSwitchButton,
  WaitNote
} from './styled'

const TRANSIT_MODES = new Set(['BUS', 'FERRY', 'RAIL', 'SUBWAY', 'TRAM'])

interface Props {
  closeOnboardAlightPreview: () => void
  confirmOnboardAlightStop: (option?: unknown) => void
  homeTimezone?: string
  preview: PreviewState | null
}

/** Whole minutes of dead time before `legs[i]` (0 for the first leg). */
function waitMinutesBeforeLeg(legs: Leg[], i: number): number {
  if (i <= 0) return 0
  const board = Number(legs[i].startTime)
  const prevEnd = Number(legs[i - 1].endTime)
  if (!Number.isFinite(board) || !Number.isFinite(prevEnd)) return 0
  return Math.max(0, Math.round((board - prevEnd) / 60000))
}

/**
 * The preview screen for ONE onboard alight option: its legs, when it gets the
 * rider there, and the waiting it implies — with `Confirm this stop` and
 * `Back to options` as its two controls.
 *
 * This is 17.1, the rider's second ask. Tapping a row in the options list used
 * to commit the trip outright (`onClickCapture` → `confirmOnboardAlightStop`,
 * whose first act is `clearOnboard()`), and because `onboard.alightOptions` is
 * the only copy of the list there was no way back: on 2026-09-15 the rider
 * tapped a row to look at it, the trip started, the list vanished, and getting
 * it back cost five fresh OTP plan requests. *"Again: I just want to view
 * alternatives for searches on 'already on bus'. But just viewing switched and
 * then other options are gone."*
 *
 * So the list stays mounted in state underneath this screen and Back is a
 * pure state change — no re-plan, no refetch. Commit happens here and nowhere
 * else in the flow.
 *
 * The wait line is deliberate: the ranker scores a waiting option as if the
 * wait were free (backlog 15.9), so the number the rider cannot see from the
 * row is exactly the one that decides whether the option is any good. It is
 * read off the displayed itinerary's own leg times — no new computation, and
 * nothing here can disagree with the row it came from.
 */
const OnboardAlightPreview = ({
  closeOnboardAlightPreview,
  confirmOnboardAlightStop,
  homeTimezone,
  preview
}: Props) => {
  const intl = useIntl()
  if (!preview?.option) return null

  const { option } = preview
  const itinerary: Itinerary | undefined =
    option.displayItinerary || option.itinerary
  const legs: Leg[] = (itinerary?.legs as Leg[]) || []
  const timeOpts = {
    hour: 'numeric' as const,
    minute: '2-digit' as const,
    ...(homeTimezone ? { timeZone: homeTimezone } : {})
  }

  const legTitle = (leg: Leg): string => {
    if (TRANSIT_MODES.has(leg.mode)) {
      return leg.routeShortName || leg.routeLongName || leg.mode
    }
    if (leg.mode === 'WALK') {
      return intl.formatMessage({
        defaultMessage: 'Walk',
        id: 'components.GoMode.legWalk'
      })
    }
    if (leg.mode === 'BICYCLE') {
      return intl.formatMessage({
        defaultMessage: 'Bike',
        id: 'components.GoMode.legBike'
      })
    }
    return leg.mode
  }

  const totalWaitMins = legs.reduce(
    (sum, _leg, i) => sum + waitMinutesBeforeLeg(legs, i),
    0
  )
  const arriveMs = Number(itinerary?.endTime)

  const summary: string[] = []
  if (Number.isFinite(arriveMs)) {
    summary.push(
      intl.formatMessage(
        {
          defaultMessage: 'Arrive {time}',
          id: 'components.GoMode.onboardPreviewArrive'
        },
        { time: intl.formatTime(arriveMs, timeOpts) }
      )
    )
  }
  if (totalWaitMins >= 1) {
    summary.push(
      intl.formatMessage(
        {
          defaultMessage: '{mins} min wait',
          id: 'components.GoMode.onboardPreviewWait'
        },
        { mins: totalWaitMins }
      )
    )
  }

  return (
    <OnboardResultsScroll data-testid="onboard-preview">
      <GoModeLiveBanner>
        {intl.formatMessage({
          defaultMessage: 'Go Mode is live — tracking your bus',
          id: 'components.GoMode.liveBanner'
        })}
      </GoModeLiveBanner>
      <RerouteCardTitle style={{ padding: '12px 16px 0' }}>
        {intl.formatMessage(
          {
            defaultMessage: 'Off at {stop}',
            id: 'components.GoMode.offAtStop'
          },
          { stop: option.alightStopName || option.stopName }
        )}
      </RerouteCardTitle>
      {summary.length > 0 && (
        <RerouteSummary
          data-testid="onboard-preview-summary"
          style={{ marginBottom: 0, padding: '0 16px' }}
        >
          {summary.join(' · ')}
        </RerouteSummary>
      )}
      <div style={{ padding: '8px 16px 0' }}>
        {legs.map((leg, i) => {
          const waitMins = waitMinutesBeforeLeg(legs, i)
          const isTransit = TRANSIT_MODES.has(leg.mode)
          const stopCount = (leg.intermediateStops?.length ?? 0) + 1
          return (
            <LegRow key={i}>
              <LegIcon>{getModeIcon(leg.mode)}</LegIcon>
              <LegInfo>
                <LegTitle>{legTitle(leg)}</LegTitle>
                {waitMins >= 1 && (
                  <WaitNote>
                    {intl.formatMessage(
                      {
                        defaultMessage: '🕒 {mins} min wait',
                        id: 'components.GoMode.legWait'
                      },
                      { mins: waitMins }
                    )}
                  </WaitNote>
                )}
                <LegSubtitle>
                  {isTransit
                    ? intl.formatMessage(
                        {
                          defaultMessage:
                            '{count, plural, one {# stop} other {# stops}} to {dest}',
                          id: 'components.GoMode.legStopsTo'
                        },
                        { count: stopCount, dest: leg.to?.name }
                      )
                    : intl.formatMessage(
                        {
                          defaultMessage: 'to {dest}',
                          id: 'components.GoMode.legTo'
                        },
                        { dest: leg.to?.name }
                      )}
                </LegSubtitle>
              </LegInfo>
            </LegRow>
          )
        })}
      </div>
      <RerouteActions style={{ padding: '16px' }}>
        <RerouteSwitchButton
          data-testid="onboard-preview-confirm"
          onClick={() => confirmOnboardAlightStop(option)}
          type="button"
        >
          {intl.formatMessage({
            defaultMessage: 'Confirm this stop',
            id: 'components.GoMode.onboardPreviewConfirm'
          })}
        </RerouteSwitchButton>
        <RerouteKeepButton
          data-testid="onboard-preview-back"
          onClick={closeOnboardAlightPreview}
          type="button"
        >
          {intl.formatMessage({
            defaultMessage: 'Back to options',
            id: 'components.GoMode.onboardPreviewBack'
          })}
        </RerouteKeepButton>
      </RerouteActions>
    </OnboardResultsScroll>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mapStateToProps = (state: any) => ({
  homeTimezone: state.otp?.config?.homeTimezone,
  preview: state.otp?.goMode?.onboard?.preview || null
})

const mapDispatchToProps = {
  closeOnboardAlightPreview: goModeActions.closeOnboardAlightPreview,
  confirmOnboardAlightStop: goModeActions.confirmOnboardAlightStop
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(OnboardAlightPreview)
