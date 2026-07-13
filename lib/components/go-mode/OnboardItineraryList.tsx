import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import coreUtils from '@opentripplanner/core-utils'
import React, { useContext } from 'react'
import styled from 'styled-components'

import * as S from '../narrative/styled'
import { ComponentContext } from '../../util/contexts'
import type { OnboardAlightOption } from '../../reducers/go-mode'

// The itinerary rows alone can look identical (same routes, same duration) —
// the decision being made is WHICH STOP, so caption each row with it.
const OffAtLabel = styled.div`
  color: #2e7d32;
  font-size: 13px;
  font-weight: 700;
  padding: 8px 4px 0;
`

interface Props {
  onSelect: (option: OnboardAlightOption) => void
  options: OnboardAlightOption[]
  sort: any
  timeFormat: string
}

const noop = (): void => undefined

/**
 * Renders the onboard "best stop to get off" options through the SAME
 * itinerary component the normal search-results list uses (ComponentContext's
 * ItineraryBody inside the narrative list container, styled by the global
 * narrative.css) — instead of a bespoke card. Each row shows the option's
 * displayItinerary: the full trip a tap will start, current-bus leg included,
 * so times, transfer counts and bike distances match the outcome exactly.
 *
 * Taps are intercepted in the CAPTURE phase: the row is purely visual and the
 * itinerary component's own click machinery (active-search selection,
 * itinerary-view URL params) must never run here — there is no active search,
 * and selection means "start guidance to this stop".
 */
const OnboardItineraryList = ({
  onSelect,
  options,
  sort,
  timeFormat
}: Props) => {
  const intl = useIntl()
  // @ts-expect-error ComponentContext is untyped
  const { ItineraryBody, LegIcon } = useContext(ComponentContext)
  if (!ItineraryBody) return null

  return (
    <S.ULContainer role="list">
      {options.map((option, i) => {
        const itinerary = option.displayItinerary || option.itinerary
        if (!itinerary) return null
        return (
          <li
            className="result"
            key={`${option.stopId}-${i}`}
            onClickCapture={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onSelect(option)
            }}
          >
            <OffAtLabel>
              {intl.formatMessage(
                {
                  defaultMessage: 'Off at {stop}',
                  id: 'components.GoMode.offAtStop'
                },
                { stop: option.stopName }
              )}
            </OffAtLabel>
            <ItineraryBody
              active={false}
              activeLeg={null}
              activeStep={null}
              expanded={false}
              index={i}
              itinerary={itinerary}
              LegIcon={LegIcon}
              mini={false}
              routingType="ITINERARY"
              setActiveItinerary={noop}
              setActiveLeg={noop}
              setActiveStep={noop}
              setVisibleItinerary={noop}
              showRealtimeAnnotation={false}
              sort={sort}
              timeFormat={timeFormat}
              toggleDetailedItinerary={noop}
              visible={false}
            />
          </li>
        )
      })}
    </S.ULContainer>
  )
}

const mapStateToProps = (state: any) => ({
  sort: state.otp.filter?.sort || { direction: 'ASC', type: 'BEST' },
  timeFormat: coreUtils.time.getTimeFormat(state.otp.config)
})

export default connect(mapStateToProps)(OnboardItineraryList)
