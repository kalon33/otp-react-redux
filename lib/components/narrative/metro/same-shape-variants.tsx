import { FormattedMessage, FormattedTime, useIntl } from 'react-intl'
import { humanizeDistanceString } from '@opentripplanner/humanize-distance'
import React, { MouseEvent, useCallback, useMemo, useState } from 'react'
import styled from 'styled-components'

import { ItineraryWithIndex } from '../../../util/itinerary'
import InvisibleA11yLabel from '../../util/invisible-a11y-label'

import { getFirstTransitLegStop } from './attribute-utils'
import { SetActiveItineraryHandler } from './departure-times-list'

/**
 * Itineraries that ride the same routes in the same order are merged into one
 * result row (see mergeByRouteSignature), because OTP returns that chain
 * several times over and three near-identical rows push genuinely different
 * trips off the bottom of the list. The variants are still real choices
 * though — they board or alight a stop or two apart, which can be a mile of
 * biking either way — so the row offers a way back to them.
 *
 * It offered that way back as a grey underlined "3 options" link tucked in
 * beside "(departs 8:14 AM)", and on 2026-09-15 the rider ran three searches
 * and started Go Mode four times in two minutes hunting for a different
 * boarding stop on the same route without ever finding it, then asked "How do
 * I get to the other similar options on each route?" (backlog 16.6). So the
 * affordance is now a full-width control under the row's summary, sized for a
 * thumb on a bike, that says what is behind it — how many other departures,
 * and, when the variants board somewhere else, the NAME of that stop, because
 * "a different stop" was the thing the rider was actually hunting for and a
 * bare count never said it.
 */
/**
 * A variant may carry a one-word caption naming the axis it varies on. The
 * planner passes none — there the row IS the journey and the times and
 * distances say everything. Go Mode's onboard list passes the alight stop,
 * because there "which stop do I get off at" is the whole choice being made
 * and two variants can otherwise read as the same trip twice.
 */
export type VariantItinerary = ItineraryWithIndex & { variantLabel?: string }

type Props = {
  className?: string
  itinerary: ItineraryWithIndex & {
    sameShapeVariants?: VariantItinerary[]
  }
  setActiveItinerary: SetActiveItineraryHandler
}

const Toggle = styled.button`
  align-items: center;
  background: #eef1f6;
  border: 1px solid #c9d0dc;
  border-radius: 8px;
  color: #17314d;
  cursor: pointer;
  display: flex;
  font-size: 14px;
  font-weight: 600;
  gap: 8px;
  justify-content: space-between;
  /* A thumb on a handlebar, not a 90%-size grey link. */
  min-height: 44px;
  padding: 8px 12px;
  text-align: left;
  width: 100%;

  &:hover,
  &[aria-expanded='true'] {
    background: #e2e7f0;
  }
`

const Chevron = styled.span`
  flex: 0 0 auto;
  font-size: 11px;
  line-height: 1;
  transition: transform 0.15s ease-out;

  &.open {
    transform: rotate(90deg);
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
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    display: block;
    font-size: 13px;
    /* Same thumb target as the control that opened the list. */
    min-height: 44px;
    padding: 6px 10px;
    text-align: left;
    width: 100%;
  }

  button:hover {
    background: #f4f6fa;
  }

  button.active {
    border-color: #c9d0dc;
    font-weight: 600;
  }

  .variant-detail {
    display: block;
    opacity: 0.8;
  }
`

/** Metres of a given mode across the whole itinerary. */
function distanceByMode(itinerary: ItineraryWithIndex, mode: string): number {
  return itinerary.legs
    .filter((leg) => leg.mode === mode)
    .reduce((total, leg) => total + (leg.distance || 0), 0)
}

/** The minute a variant leaves, which is the grain the row's times are shown at. */
function startMinute(itinerary: ItineraryWithIndex): number {
  return Math.floor(itinerary.startTime / 60000)
}

/**
 * What is actually different about the itineraries folded into this row —
 * the two axes worth naming on the closed control.
 *
 * Both are counted against the REPRESENTATIVE (the itinerary the row already
 * shows), not against each other: the control answers "what else is in here
 * that isn't what you are looking at", so a variant leaving at the same minute
 * from the same stop (it differs only in closing bike distance) adds to
 * neither count and the row falls back to the plain "N options".
 */
export function describeVariants(
  itinerary: ItineraryWithIndex & { sameShapeVariants?: VariantItinerary[] }
): {
  otherStops: string[]
  otherTimeCount: number
  variants: VariantItinerary[]
} {
  const variants = itinerary.sameShapeVariants || []
  const others = variants.filter((variant) => variant.index !== itinerary.index)
  const shownMinute = startMinute(itinerary)
  const shownStop = getFirstTransitLegStop(itinerary)

  const otherMinutes = new Set<number>()
  const otherStops: string[] = []
  others.forEach((variant) => {
    const minute = startMinute(variant)
    if (minute !== shownMinute) otherMinutes.add(minute)
    const stop = getFirstTransitLegStop(variant)
    if (stop && stop !== shownStop && !otherStops.includes(stop)) {
      otherStops.push(stop)
    }
  })

  return { otherStops, otherTimeCount: otherMinutes.size, variants }
}

const SameShapeVariants = ({
  className,
  itinerary,
  setActiveItinerary
}: Props): JSX.Element | null => {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const { otherStops, otherTimeCount, variants } = useMemo(
    () => describeVariants(itinerary),
    [itinerary]
  )
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

  const labelParts: string[] = []
  if (otherTimeCount > 0) {
    labelParts.push(
      intl.formatMessage(
        { id: 'components.MetroUI.variantsOtherTimes' },
        { count: otherTimeCount }
      )
    )
  }
  if (otherStops.length === 1) {
    labelParts.push(
      intl.formatMessage(
        { id: 'components.MetroUI.variantsOtherStop' },
        { stop: otherStops[0] }
      )
    )
  } else if (otherStops.length > 1) {
    // Name one and count the rest: "a different stop" was the ask, and a name
    // is the only part of it a rider can act on at a glance.
    labelParts.push(
      intl.formatMessage(
        { id: 'components.MetroUI.variantsOtherStopsNamed' },
        { count: otherStops.length - 1, stop: otherStops[0] }
      )
    )
  }
  // Same minute, same stop: the variants differ only in how far they make the
  // rider ride at the far end. Nothing to name, so say how many there are.
  const label =
    labelParts.length > 0
      ? labelParts.join(' · ')
      : intl.formatMessage(
          { id: 'components.MetroUI.sameShapeVariants' },
          { count: variants.length }
        )

  return (
    <div
      className={
        className ? `same-shape-variants ${className}` : 'same-shape-variants'
      }
    >
      <Toggle
        aria-expanded={open}
        className="same-shape-variants-toggle"
        onClick={toggle}
      >
        <span>{label}</span>
        <Chevron aria-hidden className={open ? 'open' : undefined}>
          ▶
        </Chevron>
      </Toggle>
      {open && (
        <VariantList>
          {variants.map((variant) => {
            const bike = distanceByMode(variant, 'BICYCLE')
            const walk = distanceByMode(variant, 'WALK')
            const stop = getFirstTransitLegStop(variant)
            const parts = [
              // Only worth a line when the rider has a choice of stop at all;
              // otherwise every variant repeats the row's own boarding stop.
              otherStops.length > 0 &&
                stop &&
                intl.formatMessage(
                  { id: 'components.MetroUI.variantBoardAt' },
                  { stop }
                ),
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
                  <span>
                    {variant.variantLabel && `${variant.variantLabel} · `}
                    <FormattedTime value={variant.startTime} />
                    {' – '}
                    <FormattedTime value={variant.endTime} />
                  </span>
                  {parts.length > 0 && (
                    <span className="variant-detail">{parts.join(' · ')}</span>
                  )}
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
    </div>
  )
}

export default SameShapeVariants
