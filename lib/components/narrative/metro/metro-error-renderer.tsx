import { connect } from 'react-redux'
import { ExclamationCircle } from '@styled-icons/fa-solid/ExclamationCircle'
import { FormattedMessage, useIntl } from 'react-intl'
import { InfoCircle } from '@styled-icons/fa-solid/InfoCircle'
import { isTransitLeg } from '@opentripplanner/core-utils/lib/itinerary'
import React from 'react'
import styled from 'styled-components'

import { AppReduxState } from '../../../util/state-types'
import { Icon } from '../../util/styledIcon'
import { LinkOpensNewWindow } from '../../util/externalLink'

type Error = Record<string, string[]>

type ItineraryForAdvisory = {
  duration?: number
  legs?: any[]
}

/**
 * Errors that describe a property of the trip rather than a failure of the
 * search. OTP raises WALKING_BETTER_THAN_TRANSIT whenever a street-only option
 * has a lower generalized-cost than every transit option; that is a fact worth
 * one line, not a full-width warning, and it must never be read as "there is
 * nothing to show". Fastest is not the only metric a trip is judged by.
 */
const ADVISORY_ERRORS = ['WALKING_BETTER_THAN_TRANSIT']

/**
 * How many whole minutes faster the quickest street-only itinerary is than the
 * quickest itinerary with a transit leg. Returns null when the comparison
 * cannot be made (no transit options came back, no street options came back, or
 * transit is not actually slower), in which case the advisory drops the number
 * instead of inventing one.
 */
export function streetFasterThanTransitByMinutes(
  itineraries: ItineraryForAdvisory[]
): number | null {
  const shortest = (wantTransit: boolean) => {
    const durations = itineraries
      .filter((itin) => !!itin?.legs?.some(isTransitLeg) === wantTransit)
      .map((itin) => itin?.duration)
      .filter((duration): duration is number => typeof duration === 'number')
    return durations.length > 0 ? Math.min(...durations) : null
  }
  const transit = shortest(true)
  const street = shortest(false)
  if (transit === null || street === null || transit <= street) return null
  return Math.round((transit - street) / 60)
}

const List = styled.ul`
  margin: 0;
  padding: 0;
`
const Container = styled.li`
  background: rgba(0, 0, 0, 0.1);
  display: grid;
  grid-template-columns: 1fr 3fr;
  grid-template-rows: 1fr max-content;
  list-style-type: none;
  margin: 0;
  padding: 0 1em;

  h2 {
    font-size: 24px;
    grid-column: 2;
    grid-row: 1;
  }

  span {
    grid-column: 1;
    grid-row: 1 / -1;
    place-self: center;
  }

  p {
    grid-column: 2;
    grid-row: 2;
    padding-bottom: 10px;
  }

  svg {
    margin: 0.25em;
  }

  /*
   * The advisory variant of the same banner: one row, body type, no headline.
   * It keeps the background, list-styling and horizontal padding so it still
   * reads as the same family of notice, just not as a failure.
   */
  &.advisory {
    align-items: center;
    display: flex;
    gap: 0.5em;
    padding: 0.6em 1em;

    p {
      font-size: 14px;
      grid-column: auto;
      grid-row: auto;
      margin: 0;
      padding: 0;
    }

    span {
      grid-column: auto;
      grid-row: auto;
      place-self: auto;
    }
  }
`

export const IconMessageContainer = ({
  body,
  header,
  icon = ExclamationCircle,
  iconSize = '3x'
}: {
  body?: React.ReactNode
  header: React.ReactNode
  icon?: React.ElementType
  iconSize?: string
}): JSX.Element => (
  <Container>
    <Icon Icon={icon} size={iconSize} />
    <h2>{header}</h2>
    {body && <p>{body}</p>}
  </Container>
)

const ErrorRenderer = ({
  errors,
  exclusiveErrors,
  itineraries = [],
  mutedErrors
}: {
  errors: Error
  exclusiveErrors?: string[]
  itineraries?: ItineraryForAdvisory[]
  mutedErrors?: string[]
}): JSX.Element => {
  const intl = useIntl()
  const minutesFaster = streetFasterThanTransitByMinutes(itineraries)

  return (
    <List>
      {Object.keys(errors)
        .filter((error: string) => {
          // The search window is hardcoded in otp-rr and can't be changed by the user.
          // Do not tell them what's happening as they can't act on the issue.
          if (error === 'NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW') {
            return false
          }

          // Don't show errors that have been muted in the config
          if (mutedErrors?.includes(error)) return false

          return true
        })
        .filter((err: string, _: any, array: string[]) => {
          if (array.length > 1 && exclusiveErrors?.includes(err)) return false

          return true
        })
        .map((error: string) => {
          // Advisory errors ride above the results as one line whenever there
          // is anything to ride above. Rendering the big warning here is what
          // made a 9-minute walk look like the only answer to a trip that had
          // nine buses behind it.
          if (ADVISORY_ERRORS.includes(error) && itineraries.length > 0) {
            return (
              <Container className="advisory" key={error}>
                <Icon Icon={InfoCircle} size="lg" />
                <p>
                  {minutesFaster === null ? (
                    <FormattedMessage id="components.OTP2ErrorRenderer.WALKING_BETTER_THAN_TRANSIT.advisory" />
                  ) : (
                    <FormattedMessage
                      id="components.OTP2ErrorRenderer.WALKING_BETTER_THAN_TRANSIT.advisoryWithTime"
                      values={{ minutes: minutesFaster }}
                    />
                  )}
                </p>
              </Container>
            )
          }

          const localizedInputFieldList = Array.from(errors[error])
            ?.filter((inputField): inputField is string => typeof inputField === 'string')
            ?.map((inputField) =>
              intl.formatMessage({
                id: `components.OTP2ErrorRenderer.inputFields.${inputField}`
              })
            )

          return (
            <IconMessageContainer
              body={
                <FormattedMessage
                  id={`components.OTP2ErrorRenderer.${error}.body`}
                  values={{
                    inputFields: intl.formatList(localizedInputFieldList),
                    inputFieldsCount: localizedInputFieldList.length,
                    link: (contents: JSX.Element) => (
                      <LinkOpensNewWindow
                        contents={contents}
                        inline
                        style={{ color: 'inherit' }}
                        url={intl.formatMessage({
                          id: `components.OTP2ErrorRenderer.${error}.link`
                        })}
                      />
                    )
                  }}
                />
              }
              header={
                <FormattedMessage
                  id={`components.OTP2ErrorRenderer.${error}.header`}
                />
              }
              icon={ExclamationCircle}
              key={error}
            />
          )
        })}
    </List>
  )
}

const mapStateToProps = (state: AppReduxState) => {
  const { itinerary } = state.otp.config
  return {
    exclusiveErrors: itinerary?.exclusiveErrors || ['NO_TRANSIT_CONNECTION'],
    mutedErrors: itinerary?.mutedErrors
  }
}
export default connect(mapStateToProps)(ErrorRenderer)

export type { Error }
