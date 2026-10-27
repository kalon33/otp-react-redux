import { connect } from 'react-redux'
import { ExclamationCircle } from '@styled-icons/fa-solid/ExclamationCircle'
import { FormattedMessage, useIntl } from 'react-intl'
import { InfoCircle } from '@styled-icons/fa-solid/InfoCircle'
import { isTransitLeg } from '@opentripplanner/core-utils/lib/itinerary'
import { Times } from '@styled-icons/fa-solid/Times'
import React, { useState } from 'react'
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
 * Backlog 22.2. Not an OTP code — `util/state` raises it when a settled search
 * that DID run OTP's transit search came back with options and no transit leg
 * in any of them.
 *
 * It exists because of what the rider saw instead on 2026-09-21 09:25:58: one
 * 25 km bike card under "No stops in range — Destination is not near any
 * transit stops". That headline came from the walk-only call of the fan-out
 * (`routingErrors [{NO_STOPS_IN_RANGE, TO}]` at index 0, the app's own debug
 * log) and is honest about walking only; the panel shows it as a fact about
 * the search. Nine serial probes against production the same morning found 249
 * served stops within 15 km of that address, the nearest 5.2 km, and a
 * bike -> Orange Line -> bike itinerary at 74 min. So the address claim is
 * suppressed whenever this one is raised, and the line says only what is true:
 * no transit option was found for THIS SEARCH.
 */
const NO_TRANSIT_OPTION_FOUND = 'NO_TRANSIT_OPTION_FOUND'

/**
 * Backlog 14.2 (rider's answer (b), 2026-09-26). Not an OTP code either —
 * `util/state`'s `searchIsThinOnTransit` raises it when a settled search that
 * asked for transit found some, but fewer than five, even after 14.2's wider
 * top-up. It is what NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW (hidden below)
 * means to a rider, said as a fact about the hour and not about a window
 * setting they cannot change. No clock time: the app only learns when service
 * resumes by asking a wider question, which the rider chose not to add.
 */
const FEW_TRANSIT_ROUTES = 'FEW_TRANSIT_ROUTES'

/**
 * Error codes that render as one advisory line. Literal ids, so the i18n check
 * can see each key in use.
 */
const ADVISORY_LINES: Record<string, JSX.Element> = {
  [FEW_TRANSIT_ROUTES]: (
    <FormattedMessage id="components.OTP2ErrorRenderer.FEW_TRANSIT_ROUTES.advisory" />
  ),
  [NO_TRANSIT_OPTION_FOUND]: (
    <FormattedMessage id="components.OTP2ErrorRenderer.NO_TRANSIT_OPTION_FOUND.advisory" />
  )
}

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

/**
 * The results list's notices (mobile overhaul, 2026-10-26). `Container` above
 * stays as it was for the other IconMessageContainer callers (nearby view).
 *
 * - advisory: one line, accent tint — a fact about the trip, not a failure.
 * - compact: a failure while options ARE listed (one combination's search
 *   failed): one warn-tinted line, header then body, ellipsized until
 *   tapped, with a 44 px dismiss. It used to be a 230 px grey block above
 *   the options.
 */
const Notice = styled.li`
  align-items: center;
  background-color: var(--tn-accent-soft);
  border-radius: var(--tn-radius-sm);
  color: var(--tn-text);
  display: flex;
  font: var(--tn-type-sm);
  gap: var(--tn-space-2);
  list-style-type: none;
  margin: var(--tn-space-2) var(--tn-space-3) 0;
  min-height: 40px;
  padding: var(--tn-space-2) var(--tn-space-3);

  > span:first-child {
    color: var(--tn-accent);
    display: inline-flex;
    flex: none;
  }
  svg {
    height: 16px;
    margin: 0;
    width: 16px;
  }
  p {
    flex: 1;
    margin: 0;
    min-width: 0;
  }

  &.compact {
    background-color: var(--tn-warn-soft);
    padding-right: 0;
  }
  &.compact > span:first-child {
    color: var(--tn-warn);
  }
  &.compact p {
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  &.compact p.open {
    cursor: auto;
    white-space: normal;
  }
  &.compact strong {
    font-weight: 600;
  }
`

const DismissButton = styled.button`
  align-items: center;
  align-self: stretch;
  background: transparent;
  border: 0;
  border-radius: var(--tn-radius-sm);
  color: var(--tn-text-2);
  display: inline-flex;
  flex: none;
  justify-content: center;
  margin: -8px 0;
  min-height: var(--tn-tap);
  width: var(--tn-tap);

  svg {
    height: 14px;
    width: 14px;
  }
  &:active {
    background-color: var(--tn-border);
  }
`

/** Nothing to show: the full-size card, on the tokens. */
const ErrorCard = styled.li`
  background-color: var(--tn-surface);
  border-radius: var(--tn-radius);
  box-shadow: var(--tn-shadow);
  color: var(--tn-text);
  column-gap: var(--tn-space-3);
  display: grid;
  grid-template-columns: max-content 1fr;
  list-style-type: none;
  margin: var(--tn-space-3);
  padding: var(--tn-space-4);

  > span {
    color: var(--tn-danger);
    grid-row: 1 / span 2;
  }
  svg {
    height: 24px;
    margin: 0;
    width: 24px;
  }
  h2 {
    font: var(--tn-type-lg);
    margin: 1px 0 4px;
  }
  p {
    color: var(--tn-text-2);
    font: var(--tn-type-sm);
    grid-column: 2;
    margin: 0;
  }
`

/** A failure that sits above listed options: see Notice. */
const CompactError = ({
  body,
  header,
  onDismiss
}: {
  body: React.ReactNode
  header: React.ReactNode
  onDismiss: () => void
}): JSX.Element => {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  return (
    <Notice className="compact results-error-notice" role="status">
      <Icon Icon={ExclamationCircle} size="lg" />
      <p
        className={open ? 'open' : undefined}
        onClick={() => setOpen(true)}
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        onKeyDown={() => {}}
        role="presentation"
      >
        <strong>{header}</strong> {body}
      </p>
      <DismissButton
        aria-label={intl.formatMessage({ id: 'common.forms.close' })}
        className="results-error-dismiss"
        onClick={onDismiss}
        type="button"
      >
        <Times aria-hidden />
      </DismissButton>
    </Notice>
  )
}

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
  // Failures the rider closed. The list is keyed on the search
  // (narrative-itineraries.js), so a new search brings them back.
  const [dismissed, setDismissed] = useState<string[]>([])

  return (
    <List className="results-errors">
      {Object.keys(errors)
        .filter((error: string) => {
          // The search window is hardcoded in otp-rr and can't be changed by the user.
          // Do not tell them what's happening as they can't act on the issue.
          if (error === 'NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW') {
            return false
          }

          // Don't show errors that have been muted in the config
          if (mutedErrors?.includes(error)) return false

          if (dismissed.includes(error)) return false

          // "not near any transit stops" is a claim about the address, and the
          // fan-out raises it from whichever single combination could not
          // reach a stop. When the search as a whole found no transit we say
          // that instead — see NO_TRANSIT_OPTION_FOUND above.
          if (
            error === 'NO_STOPS_IN_RANGE' &&
            NO_TRANSIT_OPTION_FOUND in errors
          ) {
            return false
          }

          return true
        })
        .filter((err: string, _: any, array: string[]) => {
          if (array.length > 1 && exclusiveErrors?.includes(err)) return false

          return true
        })
        .map((error: string) => {
          // One line, never a headline: there IS a card below it, and the only
          // thing each may say is what the search found (no transit, or few
          // routes at this hour).
          if (error in ADVISORY_LINES) {
            return (
              <Notice className="advisory" key={error}>
                <Icon Icon={InfoCircle} size="lg" />
                <p>{ADVISORY_LINES[error]}</p>
              </Notice>
            )
          }

          // Advisory errors ride above the results as one line whenever there
          // is anything to ride above. Rendering the big warning here is what
          // made a 9-minute walk look like the only answer to a trip that had
          // nine buses behind it.
          if (ADVISORY_ERRORS.includes(error) && itineraries.length > 0) {
            return (
              <Notice className="advisory" key={error}>
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
              </Notice>
            )
          }

          const localizedInputFieldList = Array.from(errors[error])?.map(
            (inputField) =>
              intl.formatMessage({
                id: `components.OTP2ErrorRenderer.inputFields.${inputField}`
              })
          )

          const body = (
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
          )
          const header = (
            <FormattedMessage
              id={`components.OTP2ErrorRenderer.${error}.header`}
            />
          )

          // Options are listed: the failure is one line above them, and the
          // rider can close it.
          if (itineraries.length > 0) {
            return (
              <CompactError
                body={body}
                header={header}
                key={error}
                onDismiss={() => setDismissed([...dismissed, error])}
              />
            )
          }

          return (
            <ErrorCard className="results-error-card" key={error}>
              <Icon Icon={ExclamationCircle} size="lg" />
              <h2>{header}</h2>
              <p>{body}</p>
            </ErrorCard>
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
