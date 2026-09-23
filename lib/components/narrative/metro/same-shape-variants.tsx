import { FormattedMessage, useIntl } from 'react-intl'
import { humanizeDistanceString } from '@opentripplanner/humanize-distance'
import { Place } from '@opentripplanner/types'
import React, { MouseEvent, useCallback, useMemo, useState } from 'react'
import styled from 'styled-components'

import { ItineraryWithIndex } from '../../../util/itinerary'
import InvisibleA11yLabel from '../../util/invisible-a11y-label'

import { SetActiveItineraryHandler } from './departure-times-list'

/**
 * Itineraries that ride the same routes in the same order are merged into one
 * result row (see mergeByRouteSignature), because OTP returns that chain
 * several times over and three near-identical rows push genuinely different
 * trips off the bottom of the list. The row's "You leave 9:12, 9:36 or
 * 10:06 AM" sentence (departure-times-list.tsx) already offers the other
 * DEPARTURES from the row's own stops. What it cannot offer is the other
 * STOPS: runs of the same routes that put the rider on or off a stop or two
 * away, which can be a mile of biking either way.
 *
 * That is all this control is for. On 2026-09-23 the rider called the
 * previous version, which counted other times and named one other stop, "a
 * completely redundant dropdown of 'other times'. it should be other boarding
 * and egress stops, just like you can choose other egress stops in the
 * 'already on the bus' flow", and "description on button is just other stops.
 * dont clutter with text everywhere" (backlog 21.5). So:
 *
 *  - the button says "Other stops" and nothing else;
 *  - behind it is one entry per distinct get-on / get-off pair, the row's own
 *    pair first, each captioned ON <stop> / OFF <stop> like the onboard
 *    list's "Off at" caption, with the distance and the next departure;
 *  - when every run gets on and off where the row already does, there is no
 *    button at all ("you dont need to clarify if there are no options").
 *
 * Earlier history: until 16.6 (2026-09-15) this was a grey "3 options" link
 * beside "(departs 8:14 AM)" that the rider never found.
 */
/**
 * `offStopName` overrides where a variant is said to get the rider off. The
 * planner passes none: there the last transit leg's alight stop is the answer.
 * Go Mode's onboard list passes the stop the rider leaves the CURRENT bus at,
 * because that is the choice being made there, and a variant that transfers
 * afterwards would otherwise be named by its final stop, which may be the same
 * for every variant in the row.
 */
export type VariantItinerary = ItineraryWithIndex & { offStopName?: string }

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

  /* itinerary.css strips a result row's button padding to 2 px, so the gap
     between two ON/OFF entries has to come from the list items. */
  li + li {
    margin-top: 8px;
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
    color: #555;
    display: block;
    font-size: 13px;
    margin-top: 2px;
  }
`

/**
 * ON / OFF, in the onboard list's "Off at" caption style (OffAtLabel in
 * OnboardItineraryList.tsx: green, 13 px, bold), because that list is the one
 * the rider pointed at: "just like you can choose other egress stops in the
 * 'already on the bus' flow".
 */
const StopCaption = styled.span`
  color: #2e7d32;
  display: block;
  font-size: 13px;
  font-weight: 700;

  .stop-line {
    display: flex;
    gap: 6px;
  }

  .stop-role {
    color: #767676;
    flex: 0 0 34px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    line-height: 17px;
    text-transform: uppercase;
  }

  .stop-name {
    min-width: 0;
  }
`

/** Metres of a given mode across the whole itinerary. */
function distanceByMode(itinerary: ItineraryWithIndex, mode: string): number {
  return itinerary.legs
    .filter((leg) => leg.mode === mode)
    .reduce((total, leg) => total + (leg.distance || 0), 0)
}

/** A stop's identity: its GTFS id when OTP gave one, else its name. */
function stopIdentity(place: Place | undefined): string {
  return place?.stop?.gtfsId || place?.stopId || place?.name || ''
}

/** One place to get on and one to get off, and every run that uses them. */
export type StopPair = {
  /** Identity of the pair: boarding stop id, then alight stop id or name. */
  key: string
  /** The earliest-leaving run of this pair; tapping the entry selects it. */
  next: VariantItinerary
  offName?: string
  onName?: string
  variants: VariantItinerary[]
}

/**
 * The pair a run is identified by: where it boards its FIRST transit leg and
 * where it alights its LAST, so a chain with a transfer is one pair however
 * it gets between the two. Stops compare by `stop.gtfsId` (or `stopId`) and
 * fall back to the name when OTP sent neither.
 */
export function stopPairOf(variant: VariantItinerary): {
  key: string
  offName?: string
  onName?: string
} {
  const transitLegs = (variant.legs || []).filter((leg) => leg.transitLeg)
  const first = transitLegs[0]
  const last = transitLegs[transitLegs.length - 1]
  const offName = variant.offStopName || last?.to?.name
  const offKey = variant.offStopName
    ? `name:${variant.offStopName}`
    : stopIdentity(last?.to)
  return {
    key: `${stopIdentity(first?.from)}|${offKey}`,
    offName,
    onName: first?.from?.name
  }
}

/**
 * Every distinct get-on / get-off pair among the runs folded into this row,
 * the row's own pair first and the rest by their next departure. Empty when
 * there is nothing to choose: no folded runs, or every run gets on and off
 * where the row already does.
 */
export function stopPairs(
  itinerary: ItineraryWithIndex & { sameShapeVariants?: VariantItinerary[] }
): StopPair[] {
  const variants = itinerary.sameShapeVariants || []
  const byKey = new Map<string, StopPair>()
  variants.forEach((variant) => {
    const { key, offName, onName } = stopPairOf(variant)
    const pair = byKey.get(key)
    if (!pair) {
      byKey.set(key, {
        key,
        next: variant,
        offName,
        onName,
        variants: [variant]
      })
      return
    }
    pair.variants.push(variant)
    if (variant.startTime < pair.next.startTime) pair.next = variant
  })
  // The row's own pair is the one its representative sits in. By index first,
  // because a caller may name the get-off stop on the variants only (the
  // onboard list's offStopName); by the stops themselves as a fallback.
  const ownVariant = variants.find(
    (variant) => variant.index === itinerary.index
  )
  const own = byKey.get(stopPairOf(ownVariant || itinerary).key)
  if (!own || byKey.size < 2) return []
  const others = Array.from(byKey.values())
    .filter((pair) => pair !== own)
    .sort((a, b) => a.next.startTime - b.next.startTime)
  return [own, ...others]
}

const SameShapeVariants = ({
  className,
  itinerary,
  setActiveItinerary
}: Props): JSX.Element | null => {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const pairs = useMemo(() => stopPairs(itinerary), [itinerary])
  const toggle = useCallback((e: MouseEvent) => {
    setOpen((wasOpen) => !wasOpen)
    // MetroItinerary's own click handler would make this row active.
    e.stopPropagation()
  }, [])
  const choose = useCallback(
    (e: MouseEvent) => {
      const key = e.currentTarget.getAttribute('data-pair')
      const chosen = pairs.find((pair) => pair.key === key)
      if (chosen) setActiveItinerary(chosen.next)
      e.stopPropagation()
    },
    [pairs, setActiveItinerary]
  )

  // Every run gets on and off where this row does: nothing to offer, and no
  // button saying so.
  if (pairs.length < 2) return null

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
        <span>
          <FormattedMessage id="components.MetroUI.otherStops" />
        </span>
        <Chevron aria-hidden className={open ? 'open' : undefined}>
          ▶
        </Chevron>
      </Toggle>
      {open && (
        <VariantList>
          {pairs.map((pair, i) => {
            const shown = i === 0
            const bike = distanceByMode(pair.next, 'BICYCLE')
            const walk = distanceByMode(pair.next, 'WALK')
            const distance =
              bike > 0
                ? intl.formatMessage(
                    { id: 'components.MetroUI.variantBiking' },
                    { distance: humanizeDistanceString(bike, false, intl) }
                  )
                : walk > 0
                ? intl.formatMessage(
                    { id: 'components.MetroUI.variantWalking' },
                    { distance: humanizeDistanceString(walk, false, intl) }
                  )
                : null
            const next = intl.formatMessage(
              { id: 'components.MetroUI.variantNext' },
              { time: intl.formatTime(pair.next.startTime) }
            )
            return (
              <li key={pair.key}>
                <button
                  className={shown ? 'active' : undefined}
                  data-pair={pair.key}
                  onClick={choose}
                >
                  <StopCaption>
                    <span className="stop-line">
                      <span className="stop-role">
                        <FormattedMessage id="components.MetroUI.variantOn" />
                      </span>
                      <span className="stop-name">{pair.onName}</span>
                    </span>
                    <span className="stop-line">
                      <span className="stop-role">
                        <FormattedMessage id="components.MetroUI.variantOff" />
                      </span>
                      <span className="stop-name">{pair.offName}</span>
                    </span>
                  </StopCaption>
                  <span className="variant-detail">
                    {[distance, next].filter(Boolean).join(' · ')}
                    {/* Inside the detail line: after a block it would open a
                        line box of its own and push the next entry down. */}
                    {shown && (
                      <InvisibleA11yLabel>
                        {' '}
                        <FormattedMessage id="components.MetroUI.variantShown" />
                      </InvisibleA11yLabel>
                    )}
                  </span>
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
