import { FormattedMessage, FormattedTime, useIntl } from 'react-intl'
import { humanizeDistanceString } from '@opentripplanner/humanize-distance'
import React, { MouseEvent, useCallback, useState } from 'react'
import styled from 'styled-components'

import { ItineraryWithIndex } from '../../../util/itinerary'
import InvisibleA11yLabel from '../../util/invisible-a11y-label'

import { SetActiveItineraryHandler } from './departure-times-list'

/**
 * Itineraries that ride the same routes in the same order are merged into one
 * result row (see mergeByRouteSignature), because OTP returns that chain
 * several times over and three near-identical rows push genuinely different
 * trips off the bottom of the list. The variants are still real choices
 * though — they board or alight a stop or two apart, which can be a mile of
 * biking either way — so the row offers a way back to them.
 */
type Props = {
  itinerary: ItineraryWithIndex & {
    sameShapeVariants?: ItineraryWithIndex[]
  }
  setActiveItinerary: SetActiveItineraryHandler
}

const Toggle = styled.button`
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 90%;
  margin-left: 0.5ch;
  opacity: 0.8;
  padding: 0;
  text-decoration: underline;

  &:hover {
    opacity: 1;
  }
`

const VariantList = styled.ul`
  list-style: none;
  margin: 4px 0 0 0;
  padding: 0;

  li {
    margin: 0;
  }

  button {
    background: none;
    border: none;
    cursor: pointer;
    display: block;
    font-size: 90%;
    padding: 3px 0;
    text-align: left;
    width: 100%;
  }

  button.active {
    font-weight: 600;
  }
`

/** Metres of a given mode across the whole itinerary. */
function distanceByMode(itinerary: ItineraryWithIndex, mode: string): number {
  return itinerary.legs
    .filter((leg) => leg.mode === mode)
    .reduce((total, leg) => total + (leg.distance || 0), 0)
}

const SameShapeVariants = ({
  itinerary,
  setActiveItinerary
}: Props): JSX.Element | null => {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const variants = itinerary.sameShapeVariants
  const toggle = useCallback((e: MouseEvent) => {
    setOpen((wasOpen) => !wasOpen)
    // MetroItinerary's own click handler would make this row active.
    e.stopPropagation()
  }, [])
  const choose = useCallback(
    (e: MouseEvent) => {
      const index = Number(e.currentTarget.getAttribute('data-index'))
      const chosen = variants?.find((variant) => variant.index === index)
      if (chosen) setActiveItinerary(chosen)
      e.stopPropagation()
    },
    [setActiveItinerary, variants]
  )

  // Nothing folded into this row: no drill-down to offer.
  if (!variants || variants.length < 2) return null

  return (
    <>
      <Toggle
        aria-expanded={open}
        className="same-shape-variants-toggle"
        onClick={toggle}
      >
        <FormattedMessage
          id="components.MetroUI.sameShapeVariants"
          values={{ count: variants.length }}
        />
      </Toggle>
      {open && (
        <VariantList>
          {variants.map((variant) => {
            const bike = distanceByMode(variant, 'BICYCLE')
            const walk = distanceByMode(variant, 'WALK')
            const parts = [
              bike > 0 &&
                intl.formatMessage(
                  { id: 'components.MetroUI.variantBiking' },
                  { distance: humanizeDistanceString(bike, false, intl) }
                ),
              walk > 0 &&
                intl.formatMessage(
                  { id: 'components.MetroUI.variantWalking' },
                  { distance: humanizeDistanceString(walk, false, intl) }
                )
            ].filter(Boolean)
            return (
              <li key={variant.index}>
                <button
                  className={
                    variant.index === itinerary.index ? 'active' : undefined
                  }
                  data-index={variant.index}
                  onClick={choose}
                >
                  <FormattedTime value={variant.startTime} />
                  {' – '}
                  <FormattedTime value={variant.endTime} />
                  {parts.length > 0 && ` · ${parts.join(', ')}`}
                  {variant.index === itinerary.index && (
                    <InvisibleA11yLabel>
                      {' '}
                      <FormattedMessage id="components.MetroUI.variantShown" />
                    </InvisibleA11yLabel>
                  )}
                </button>
              </li>
            )
          })}
        </VariantList>
      )}
    </>
  )
}

export default SameShapeVariants
