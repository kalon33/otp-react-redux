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
 * That last rule was wrong for the planner and lasted an hour. At 15:37 the
 * same day the rider's Orange Line row folded 13 runs, every one boarding at
 * 98th St and alighting at 66th St, so there was no button — "Why am I not
 * getting an option to get off at 46th st station???" OTP answers ONE alight
 * stop per connection; the list can only show what the answer holds. So in
 * the planner's list (`onLookup` given) a row with a transit leg always has
 * the button, and the first tap asks the planner about the other stops of
 * the bus it rides (actions/other-stops-lookup.ts). What comes back is folded
 * into the row as more pairs; while asking, one muted "Looking…"; when
 * nothing came back and there is still one pair, one muted "No other stops".
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

/** Where a row's "Other stops" lookup stands (actions/other-stops-lookup). */
export type LookupStatus = 'pending' | 'done' | 'failed'

type Props = {
  className?: string
  itinerary: ItineraryWithIndex & {
    sameShapeVariants?: VariantItinerary[]
  }
  /** This row's lookup, when it has started. */
  lookupStatus?: LookupStatus
  /**
   * Ask the planner for this row's other stops. Given only where the row is
   * a result of the active search (the planner's list); without it the
   * control is what it was before 2026-09-23 15:37 — shown only when the
   * answer already holds a second pair. Go Mode's onboard list does not pass
   * it: its rows are not in any search.
   */
  onLookup?: () => void
  setActiveItinerary: SetActiveItineraryHandler
}

/**
 * A disclosure row (mobile overhaul, 2026-10-26): 14 px accent text and a
 * chevron, no box of its own — the card around it is the box. Still a 44 px
 * row, "a thumb on a handlebar, not a 90%-size grey link".
 */
const Toggle = styled.button`
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: var(--tn-radius-sm);
  color: var(--tn-accent);
  cursor: pointer;
  display: flex;
  font: 600 14px/18px var(--tn-font);
  gap: 8px;
  justify-content: space-between;
  min-height: var(--tn-tap);
  padding: 0 var(--tn-space-3);
  text-align: left;
  width: 100%;

  &:active {
    background: var(--tn-accent-soft);
  }
  &:focus-visible {
    outline: 2px solid var(--tn-accent);
    outline-offset: -2px;
  }
`

/**
 * The ▶ stays in the DOM (it is the control's text in tests and in the
 * accessibility tree it is aria-hidden); what shows is a 7 px chevron drawn
 * from two borders, pointing down, and up once open.
 */
const Chevron = styled.span`
  flex: 0 0 auto;
  font-size: 0;
  line-height: 0;

  &::before {
    border-bottom: 2px solid currentColor;
    border-right: 2px solid currentColor;
    content: '';
    display: inline-block;
    height: 7px;
    transform: translateY(-2px) rotate(45deg);
    transition: transform 0.15s ease-out;
    width: 7px;
  }
  &.open::before {
    transform: translateY(2px) rotate(-135deg);
  }
`

/** "Looking…" / "No other stops": one small muted line, nothing more. */
const LookupLine = styled.p`
  color: var(--tn-text-2);
  font: var(--tn-type-sm);
  margin: 6px 0 0 0;
  padding: 0 10px;
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
    margin-top: 6px;
  }

  && button {
    background: none;
    border: 0;
    border-radius: var(--tn-radius-sm);
    color: var(--tn-text);
    cursor: pointer;
    display: block;
    font-size: 13px;
    /* Same thumb target as the control that opened the list. */
    min-height: var(--tn-tap);
    padding: 8px 10px;
    text-align: left;
    width: 100%;
  }

  && button:active {
    background: var(--tn-surface-2);
  }

  && button.active {
    background: var(--tn-surface-2);
    box-shadow: inset 0 0 0 1px var(--tn-border);
    font-weight: 600;
  }

  .variant-detail {
    color: var(--tn-text-2);
    display: block;
    font-size: 13px;
    font-variant-numeric: var(--tn-tabular);
    font-weight: 400;
    margin-top: 2px;
  }
`

/**
 * ON / OFF captions: the role as a small eyebrow, the stop name 14 px 600.
 * (They were the onboard list's green "Off at" caption; green is the realtime
 * colour now.)
 */
const StopCaption = styled.span`
  color: var(--tn-text);
  display: block;
  font: 600 14px/19px var(--tn-font);

  .stop-line {
    display: flex;
    gap: 6px;
  }

  .stop-role {
    color: var(--tn-text-3);
    flex: 0 0 30px;
    font: var(--tn-type-xs);
    letter-spacing: var(--tn-tracking-xs);
    line-height: 19px;
    text-transform: uppercase;
  }

  .stop-name {
    min-width: 0;
  }
`

/** A group's heading in the planner's list: an eyebrow. */
const GroupHeading = styled.h4`
  color: var(--tn-text-2);
  font: var(--tn-type-xs);
  letter-spacing: var(--tn-tracking-xs);
  margin: 12px 0 2px 0;
  padding: 0 10px;
  text-transform: uppercase;
`

/** The planner's two groups, in order (49.1, rider's answer Q2 = B). */
const GROUPS: Array<{ group: PairGroup; heading: JSX.Element }> = [
  {
    group: 'on',
    heading: <FormattedMessage id="components.MetroUI.otherStopsGetOn" />
  },
  {
    group: 'off',
    heading: <FormattedMessage id="components.MetroUI.otherStopsGetOff" />
  }
]

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

/**
 * Which heading a pair sits under in the planner's list (backlog 49.1): the
 * row's own pair, a different place to get ON (the row's get-off stop, or —
 * only when OTP itself returned such a run — another one too), or the same
 * get-on stop and a different place to get OFF.
 */
export type PairGroup = 'own' | 'on' | 'off'

/** One place to get on and one to get off, and every run that uses them. */
export type StopPair = {
  /** Where this pair differs from the row's own (set by `stopPairs`). */
  group?: PairGroup
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
  offKey: string
  offName?: string
  onKey: string
  onName?: string
} {
  const transitLegs = (variant.legs || []).filter((leg) => leg.transitLeg)
  const first = transitLegs[0]
  const last = transitLegs[transitLegs.length - 1]
  const offName = variant.offStopName || last?.to?.name
  const offKey = variant.offStopName
    ? `name:${variant.offStopName}`
    : stopIdentity(last?.to)
  const onKey = stopIdentity(first?.from)
  return {
    key: `${onKey}|${offKey}`,
    offKey,
    offName,
    onKey,
    onName: first?.from?.name
  }
}

/**
 * Least biking first, then least walking, then the earliest arrival (backlog
 * 49.1, Q3 = A: "in order of minimized biking").
 */
function byLeastBiking(a: StopPair, b: StopPair): number {
  return (
    distanceByMode(a.next, 'BICYCLE') - distanceByMode(b.next, 'BICYCLE') ||
    distanceByMode(a.next, 'WALK') - distanceByMode(b.next, 'WALK') ||
    a.next.endTime - b.next.endTime ||
    a.next.startTime - b.next.startTime
  )
}

/**
 * Every distinct get-on / get-off pair among the runs folded into this row,
 * the row's own pair first. Empty when there is nothing to choose: no folded
 * runs, or every run gets on and off where the row already does.
 *
 * `grouped` (the planner's list, backlog 49.1): after the row's own pair,
 * the "get on somewhere else" pairs, then the "get off somewhere else" ones,
 * each group least biking first. Without it (Go Mode's onboard list) the
 * rest follow by their next departure, as before 49.1.
 */
export function stopPairs(
  itinerary: ItineraryWithIndex & { sameShapeVariants?: VariantItinerary[] },
  { grouped = false }: { grouped?: boolean } = {}
): StopPair[] {
  const variants = itinerary.sameShapeVariants || []
  const byKey = new Map<string, StopPair & { offKey: string; onKey: string }>()
  variants.forEach((variant) => {
    const { key, offKey, offName, onKey, onName } = stopPairOf(variant)
    const pair = byKey.get(key)
    if (!pair) {
      byKey.set(key, {
        key,
        next: variant,
        offKey,
        offName,
        onKey,
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
  const strip = ({
    offKey,
    onKey,
    ...pair
  }: StopPair & { offKey: string; onKey: string }): StopPair => pair
  const others = Array.from(byKey.values()).filter((pair) => pair !== own)
  if (!grouped) {
    return [
      strip(own),
      ...others.sort((a, b) => a.next.startTime - b.next.startTime).map(strip)
    ]
  }
  // A pair that boards elsewhere is a "get on" choice even when OTP's run
  // also gets off elsewhere (the lookup never makes such a pair; OTP can).
  const on = others.filter((pair) => pair.onKey !== own.onKey)
  const off = others.filter((pair) => pair.onKey === own.onKey)
  return [
    { ...strip(own), group: 'own' as const },
    ...on
      .map((p) => ({ ...strip(p), group: 'on' as const }))
      .sort(byLeastBiking),
    ...off
      .map((p) => ({ ...strip(p), group: 'off' as const }))
      .sort(byLeastBiking)
  ]
}

const SameShapeVariants = ({
  className,
  itinerary,
  lookupStatus,
  onLookup,
  setActiveItinerary
}: Props): JSX.Element | null => {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  // The planner's list (the one that can look stops up) groups its pairs under
  // "Get on somewhere else" / "Get off somewhere else" (49.1); Go Mode's
  // onboard list, where every choice is a get-off stop, keeps one list.
  const grouped = !!onLookup
  const pairs = useMemo(
    () => stopPairs(itinerary, { grouped }),
    [grouped, itinerary]
  )
  // 2026-09-23 15:37 (21.5, third sighting): OTP answers one alight stop per
  // connection, so "every run gets on and off here" said nothing about the
  // other stops the bus serves. A row with a transit leg can always look.
  const canLookUp =
    !!onLookup && (itinerary.legs || []).some((leg) => leg.transitLeg)
  const toggle = useCallback(
    (e: MouseEvent) => {
      // The first opening asks; the action itself refuses a second lookup
      // for the same row on the same search.
      if (!open && canLookUp && !lookupStatus && onLookup) onLookup()
      setOpen(!open)
      // MetroItinerary's own click handler would make this row active.
      e.stopPropagation()
    },
    [canLookUp, lookupStatus, onLookup, open]
  )
  const choose = useCallback(
    (e: MouseEvent) => {
      const key = e.currentTarget.getAttribute('data-pair')
      const chosen = pairs.find((pair) => pair.key === key)
      if (chosen) setActiveItinerary(chosen.next)
      e.stopPropagation()
    },
    [pairs, setActiveItinerary]
  )

  const renderPair = (pair: StopPair, i: number) => {
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
    // The time that tells the pairs apart. Get-off alternatives all
    // board the same bus, so "next <departure>" said the same thing on
    // every line (seen on the 2026-09-23 build); what differs is when
    // the rider ARRIVES. A get-on alternative leaves at another time
    // and arrives with the row, so it names its departure as well.
    const own = pairs[0].next
    const leaves =
      i > 0 && pair.next.startTime !== own.startTime
        ? intl.formatMessage(
            { id: 'components.MetroUI.variantLeaves' },
            { time: intl.formatTime(pair.next.startTime) }
          )
        : null
    const next = [
      leaves,
      intl.formatMessage(
        { id: 'components.MetroUI.variantArrives' },
        { time: intl.formatTime(pair.next.endTime) }
      )
    ]
      .filter(Boolean)
      .join(' · ')
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
  }

  // Every run gets on and off where this row does and there is no way to ask
  // for more: nothing to offer, and no button saying so.
  if (pairs.length < 2 && !canLookUp) return null
  const settled = lookupStatus === 'done' || lookupStatus === 'failed'

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
      {open && pairs.length >= 2 && !grouped && (
        <VariantList>{pairs.map(renderPair)}</VariantList>
      )}
      {open && pairs.length >= 2 && grouped && (
        <>
          <VariantList>{renderPair(pairs[0], 0)}</VariantList>
          {GROUPS.map(({ group, heading }) => {
            const members = pairs
              .map((pair, i) => ({ i, pair }))
              .filter(({ pair }) => pair.group === group)
            if (!members.length) return null
            return (
              <div className="variant-group" key={group}>
                <GroupHeading className="variant-group-heading">
                  {heading}
                </GroupHeading>
                <VariantList>
                  {members.map(({ i, pair }) => renderPair(pair, i))}
                </VariantList>
              </div>
            )
          })}
        </>
      )}
      {open && canLookUp && lookupStatus === 'pending' && (
        <LookupLine className="other-stops-looking">
          <FormattedMessage id="components.MetroUI.otherStopsLooking" />
        </LookupLine>
      )}
      {/* Found nothing (or could not ask) and there is still one pair: say
          so once, because an open control with nothing under it reads as
          broken. With a list showing, the list is the answer. */}
      {open && canLookUp && settled && pairs.length < 2 && (
        <LookupLine className="other-stops-none">
          <FormattedMessage id="components.MetroUI.otherStopsNone" />
        </LookupLine>
      )}
    </div>
  )
}

export default SameShapeVariants
