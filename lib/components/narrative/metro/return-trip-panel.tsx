import { connect } from 'react-redux'
import { FormattedMessage, FormattedTime, useIntl } from 'react-intl'
import { Itinerary } from '@opentripplanner/types'
import coreUtils from '@opentripplanner/core-utils'
import React, { useCallback, useContext, useEffect } from 'react'
import styled from 'styled-components'

import { ComponentContext } from '../../../util/contexts'
import { DARK_TEXT_GREY } from '../../util/colors'
import {
  outboundKeyOf,
  planReturnTrip,
  selectReturnItinerary
} from '../../../actions/round-trip'
import {
  returnDepartureMs,
  timeAtDestinationMs
} from '../../../util/go-mode/round-trip'
import FormattedDuration from '../../util/formatted-duration'
import Loading from '../loading'
import type { ReturnPlanState } from '../../../actions/round-trip'

import MetroItineraryRoutes from './metro-itinerary-routes'

const { ensureAtLeastOneMinute } = coreUtils.time

/**
 * The ways back, under the outbound itinerary the rider has open. Rendered only
 * when the round-trip toggle is on (components/form/round-trip-settings).
 *
 * The list is sorted by departure and nothing is dropped for being slower —
 * the rider picks; "faster" is advice, not a filter.
 *
 * The stay the rider set is a MINIMUM: the query departs at
 * `outbound.endTime + stay` and OTP answers with that departure and later ones.
 * So the thing that actually differs between two ways back is how long each one
 * leaves the rider at the destination, and every row prints it.
 */

const Panel = styled.section`
  border-top: 0.1ch solid ${DARK_TEXT_GREY}33;
  color: ${DARK_TEXT_GREY};
  margin: 8px 16px 0;
  padding-top: 10px;
`

const Header = styled.h3`
  font-size: 15px;
  font-weight: 700;
  margin: 0;
`

const Subhead = styled.p`
  color: #666;
  font-size: 13px;
  margin: 2px 0 8px;
`

const Options = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const OptionButton = styled.button<{ $selected: boolean }>`
  align-items: center;
  background: ${(props) => (props.$selected ? '#ffffff' : 'transparent')};
  border-radius: 6px;
  border: ${(props) =>
    props.$selected
      ? '2px solid var(--main-base-color, rgb(173, 216, 230))'
      : '1px solid rgb(187, 187, 187)'};
  display: grid;
  gap: 4px 8px;
  grid-template-columns: 1fr auto;
  padding: 6px 8px;
  text-align: left;
  width: 100%;
`

/**
 * The same route strip the collapsed results rows carry. It expects to sit in
 * a grid (its screen-reader header is parked in an unused second column) and
 * brings a top margin sized for the results list, which here is just a gap.
 */
const OptionRoutes = styled.span`
  display: grid;
  grid-column: 1;
  grid-template-columns: 1fr 0;
  min-width: 0;

  > div {
    margin-top: 0 !important;
  }
`

const OptionTimes = styled.span`
  font-size: 14px;
  font-weight: 600;
  grid-column: 1;
`

/** How long this way back leaves the rider there. See timeAtDestinationMs. */
const OptionStay = styled.span`
  color: #666;
  font-size: 13px;
  grid-column: 1;
`

const OptionDuration = styled.span`
  font-size: 14px;
  grid-column: 2;
  grid-row: 1 / span 2;
  text-align: right;
`

const Message = styled.p`
  color: #666;
  font-size: 13px;
  margin: 0 0 6px;
`

const RetryButton = styled.button`
  background: none;
  border-radius: 3px;
  border: 1px solid rgb(187, 187, 187);
  font-size: 13px;
  padding: 4px 10px;
`

type Props = {
  homeTimezone: string
  itinerary: Itinerary
  planReturnTrip: (itinerary: Itinerary) => void
  returnPlan: ReturnPlanState | null
  selectReturnItinerary: (index: number) => void
  stayMinutes: number
}

function ReturnTripPanel({
  homeTimezone,
  itinerary,
  planReturnTrip: plan,
  returnPlan,
  selectReturnItinerary: select,
  stayMinutes
}: Props): JSX.Element {
  const intl = useIntl()
  // @ts-expect-error React context is populated dynamically
  const { LegIcon } = useContext(ComponentContext)

  const outboundKey = outboundKeyOf(itinerary)

  useEffect(() => {
    plan(itinerary)
  }, [itinerary, outboundKey, plan, stayMinutes])

  const onRetry = useCallback(() => plan(itinerary), [itinerary, plan])
  const onSelect = useCallback((index: number) => () => select(index), [select])

  // Before the first plan lands there is still a departure to name: it follows
  // from the outbound arrival and the stay alone.
  const forThisOutbound = returnPlan?.outboundKey === outboundKey
  const departMs = forThisOutbound
    ? returnPlan.departMs
    : returnDepartureMs(itinerary, stayMinutes)
  const status = forThisOutbound ? returnPlan.status : 'pending'

  const legs = itinerary.legs || []
  const destination = legs[legs.length - 1]?.to?.name

  return (
    <Panel
      aria-label={intl.formatMessage({
        defaultMessage: 'Return trip',
        id: 'components.RoundTrip.header'
      })}
    >
      <Header>
        <FormattedMessage
          defaultMessage="Return trip"
          id="components.RoundTrip.header"
        />
      </Header>
      <Subhead>
        <FormattedMessage
          defaultMessage="Leave {destination} from {time} · {stay}+ there"
          id="components.RoundTrip.leaveLine"
          values={{
            destination,
            stay: intl
              .formatMessage(
                {
                  defaultMessage:
                    '{hours, plural, =0 {} other {# h }}{minutes, plural, =0 {} other {# min}}',
                  id: 'components.RoundTrip.stayOption'
                },
                {
                  hours: Math.floor(stayMinutes / 60),
                  minutes: stayMinutes % 60
                }
              )
              .trim(),
            time: Number.isFinite(departMs)
              ? intl.formatTime(departMs, { timeZone: homeTimezone })
              : ''
          }}
        />
      </Subhead>

      {status === 'pending' && <Loading small />}

      {(status === 'empty' || status === 'error') && (
        <>
          <Message>
            {status === 'empty' ? (
              <FormattedMessage
                defaultMessage="No return options found"
                id="components.RoundTrip.noOptions"
              />
            ) : (
              <FormattedMessage
                defaultMessage="Couldn’t plan the return"
                id="components.RoundTrip.planError"
              />
            )}
          </Message>
          <RetryButton onClick={onRetry} type="button">
            <FormattedMessage
              defaultMessage="Retry"
              id="components.RoundTrip.retry"
            />
          </RetryButton>
        </>
      )}

      {status === 'ready' && returnPlan && (
        <Options
          aria-label={intl.formatMessage({
            defaultMessage: 'Ways back',
            id: 'components.RoundTrip.optionsGroupLabel'
          })}
          role="group"
        >
          {returnPlan.itineraries.map((option: Itinerary, index: number) => {
            const selected = index === returnPlan.selectedIndex
            return (
              <OptionButton
                $selected={selected}
                aria-pressed={selected}
                key={`${option.startTime}-${index}`}
                onClick={onSelect(index)}
                type="button"
              >
                {LegIcon && (
                  <OptionRoutes>
                    <MetroItineraryRoutes expanded={false} itinerary={option} />
                  </OptionRoutes>
                )}
                <OptionTimes>
                  <FormattedTime
                    timeZone={homeTimezone}
                    value={option.startTime}
                  />
                  {' – '}
                  <FormattedTime
                    timeZone={homeTimezone}
                    value={option.endTime}
                  />
                </OptionTimes>
                <OptionDuration>
                  <FormattedDuration
                    duration={ensureAtLeastOneMinute(option.duration)}
                    includeSeconds={false}
                  />
                </OptionDuration>
                {Number.isFinite(timeAtDestinationMs(itinerary, option)) && (
                  <OptionStay>
                    {/* "there" and not the stop name: the subhead two lines up
                        already names it, and a long stop name wraps the row. */}
                    <FormattedMessage
                      defaultMessage="{duration} there"
                      id="components.RoundTrip.timeThere"
                      values={{
                        duration: (
                          <FormattedDuration
                            duration={ensureAtLeastOneMinute(
                              timeAtDestinationMs(itinerary, option) / 1000
                            )}
                            includeSeconds={false}
                          />
                        )
                      }}
                    />
                  </OptionStay>
                )}
              </OptionButton>
            )
          })}
        </Options>
      )}
    </Panel>
  )
}

const mapStateToProps = (state: any) => ({
  homeTimezone: state.otp.config.homeTimezone,
  returnPlan: state.otp.roundTrip?.returnPlan || null,
  stayMinutes: Number(state.otp.currentQuery.stayMinutes)
})

const mapDispatchToProps = {
  planReturnTrip,
  selectReturnItinerary
}

export default connect(mapStateToProps, mapDispatchToProps)(ReturnTripPanel)
