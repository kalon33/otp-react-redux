import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import coreUtils from '@opentripplanner/core-utils'
import React, { useContext, useMemo } from 'react'
import styled from 'styled-components'

import * as S from '../narrative/styled'
import { ComponentContext } from '../../util/contexts'
import { groupAlightOptionsByRoute } from '../../util/go-mode/alight-optimizer'
import SameShapeVariants, {
  VariantItinerary
} from '../narrative/metro/same-shape-variants'
import type { OnboardAlightOption } from '../../reducers/go-mode'

// The itinerary rows alone can look identical (same routes, same duration) —
// the decision being made is WHICH STOP, so caption each row with it.
//
// `alightStopName` first, `stopName` only as the fallback: the option's
// stopName is the stop its onward plan was PLANNED from, and when that plan
// opens with the boarded trip continuing the legs merge and the ride runs on
// past it (see decorateAlightOptions). Captioning the anchor there promised a
// stop the rider is carried straight through — 6.44, live 2026-09-02.
const OffAtLabel = styled.div`
  color: #2e7d32;
  font-size: 13px;
  font-weight: 700;
  padding: 8px 4px 0;
`

// The drill-down sits OUTSIDE the tap target below, so opening it cannot be
// read as choosing the row. Same padding as the caption so the two line up.
const VariantsRow = styled.div`
  padding: 0 4px 8px;
`

interface Props {
  onSelect: (option: OnboardAlightOption) => void
  options: OnboardAlightOption[]
  sort: any
  timeFormat: string
  tokenTransitHopMeters?: number
  tokenTransitHopToleranceMinutes?: number
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
 * Options that ride the SAME chain of routes are stacked into one row, with
 * the alternatives behind the planner's own "N options" drill-down — the rider
 * asked for this on 2026-08-27 ("on the already on the bus search they aren't
 * stacked, just a list of the same routes"), and the planner has done it since
 * `0d37eed2`. See groupAlightOptionsByRoute; the ordering it applies
 * (demoteTokenTransitHops) is the one narrative-itineraries.js applies to its
 * own rows.
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
  timeFormat,
  tokenTransitHopMeters,
  tokenTransitHopToleranceMinutes
}: Props) => {
  const intl = useIntl()
  // @ts-expect-error ComponentContext is untyped
  const { ItineraryBody, LegIcon } = useContext(ComponentContext)

  const groups = useMemo(
    () =>
      groupAlightOptionsByRoute(options, {
        maxHopMeters: tokenTransitHopMeters,
        toleranceMs:
          tokenTransitHopToleranceMinutes != null
            ? tokenTransitHopToleranceMinutes * 60000
            : undefined
      }),
    [options, tokenTransitHopMeters, tokenTransitHopToleranceMinutes]
  )

  if (!ItineraryBody) return null

  return (
    <S.ULContainer role="list">
      {groups.map((group, i) => {
        const { option, variants } = group
        const itinerary = option.displayItinerary || option.itinerary
        if (!itinerary) return null

        // SameShapeVariants addresses its members by `index`; here that is the
        // member's position within this row, and choosing one selects the
        // option it came from.
        const variantItineraries: VariantItinerary[] = variants.map(
          (variant, index) =>
            Object.assign({}, variant.displayItinerary || variant.itinerary, {
              index,
              variantLabel: variant.alightStopName || variant.stopName
            })
        )

        return (
          <li className="result" key={`${option.stopId}-${i}`}>
            <div
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
                  { stop: option.alightStopName || option.stopName }
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
            </div>
            {variants.length > 1 && (
              <VariantsRow>
                <SameShapeVariants
                  itinerary={Object.assign({}, itinerary, {
                    index: 0,
                    sameShapeVariants: variantItineraries
                  })}
                  setActiveItinerary={({ index }) => {
                    const chosen = variants[index]
                    if (chosen) onSelect(chosen)
                  }}
                />
              </VariantsRow>
            )}
          </li>
        )
      })}
    </S.ULContainer>
  )
}

const mapStateToProps = (state: any) => ({
  sort: state.otp.filter?.sort || { direction: 'ASC', type: 'BEST' },
  timeFormat: coreUtils.time.getTimeFormat(state.otp.config),
  tokenTransitHopMeters: state.otp.config?.itinerary?.tokenTransitHopMeters,
  tokenTransitHopToleranceMinutes:
    state.otp.config?.itinerary?.tokenTransitHopToleranceMinutes
})

export default connect(mapStateToProps)(OnboardItineraryList)
