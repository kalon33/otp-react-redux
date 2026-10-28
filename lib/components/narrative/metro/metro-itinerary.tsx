import { AccessibilityRating } from '@opentripplanner/itinerary-body'
import { connect } from 'react-redux'
import { FareProductSelector, Itinerary, Leg } from '@opentripplanner/types'
import {
  FormattedMessage,
  FormattedNumber,
  FormattedTime,
  injectIntl,
  IntlShape
} from 'react-intl'
import { humanizeDistanceString } from '@opentripplanner/humanize-distance'
import { Leaf } from '@styled-icons/fa-solid/Leaf'
import coreUtils from '@opentripplanner/core-utils'
import React from 'react'
import styled, { keyframes } from 'styled-components'

import * as goModeActions from '../../../actions/go-mode'
import * as uiActions from '../../../actions/ui'
import { AppReduxState } from '../../../util/state-types'
import {
  buildMultiStopPlan,
  itineraryDistanceM,
  itineraryStopNames,
  itineraryStopTimes,
  MultiStopPlan
} from '../../../util/multi-stop'
import {
  buildRoundTripPlan,
  RoundTripPlan
} from '../../../util/go-mode/round-trip'
import { ComponentContext } from '../../../util/contexts'
import { DARK_TEXT_GREY } from '../../util/colors'
import { firstTransitLegIsRealtime } from '../../../util/viewer'
import { FlexIndicator } from '../default/flex-indicator'
import { getActiveSearch } from '../../../util/state'
import { getFare } from '../../../util/itinerary'
import { IconWithText } from '../../util/styledIcon'
import { ItineraryDescription } from '../default/itinerary-description'
import { itineraryHasAccessibilityScore } from '../../../util/accessibility-routing'
import { ItineraryView } from '../../../util/ui'
import { localizeGradationMap } from '../utils'
import { lookupOtherStops } from '../../../actions/other-stops-lookup'
import { MobileScreens } from '../../../actions/ui-constants'
import { outboundKeyOf, ReturnPlanState } from '../../../actions/round-trip'
import AutoArmControl from '../../go-mode/AutoArmControl'
import FormattedDuration from '../../util/formatted-duration'
import ItineraryBody from '../line-itin/connected-itinerary-body'
import NarrativeItinerary from '../narrative-itinerary'
import SimpleRealtimeAnnotation from '../simple-realtime-annotation'

import {
  getFirstTransitLeg,
  getFirstTransitLegStop,
  getFlexAttributes
} from './attribute-utils'
import DefaultRouteRenderer from './default-route-renderer'
import DepartureTimesList, {
  ItineraryWithStartTimes,
  LATE_DEPARTURE_CONFIRM_MINUTES,
  minutesAfterRowDeparture,
  rowDepartureTime,
  SetActiveItineraryHandler
} from './departure-times-list'
import MetroItineraryRoutes from './metro-itinerary-routes'
import ReturnTripPanel from './return-trip-panel'
import RouteBlock from './route-block'
import RouteBlockWithModeDecoration from './route-block-with-mode-decoration'
import SameShapeVariants, { LookupStatus } from './same-shape-variants'

const { ensureAtLeastOneMinute } = coreUtils.time

// Styled components
//
// The result card (mobile overhaul, 2026-10-26): row 1 is the leg chain with
// the duration hero on the right; row 2 is when it leaves (live glyph) and
// arrives, with the row's other departures as small chips; row 3 is the
// biking / walking and wait line. Colours are the design tokens, so the card
// follows the phone's dark mode; the card chrome itself (surface, radius 16,
// shadow, one card per result) is applied under `:is(.otp.mobile, .tn-gomode)` only, so the
// desktop sidebar and Go Mode's lists keep their own framing.
const ItineraryWrapper = styled.div.attrs((props) => {
  return { 'aria-label': props['aria-label'] }
})`
  background-color: var(--tn-surface);
  border-bottom: 1px solid var(--tn-border);
  color: var(--tn-text);
  display: grid; /* We don't use grid here, but "block" and "inline" cause problems with Firefox */
  padding: 0;

  /* itinerary.css frames the rows as one joined list (white, 10 px corners on
     the first and last); on the phone every result is its own card. */
  .otp.mobile .option.metro-itin div.header &&,
  .tn-gomode .option.metro-itin div.header && {
    background-color: var(--tn-surface);
    border: 0;
    border-radius: var(--tn-radius);
    box-shadow: var(--tn-shadow);
  }
  .otp.mobile .option.metro-itin div.header &&:hover,
  .tn-gomode .option.metro-itin div.header &&:hover {
    background-color: var(--tn-surface);
  }
  .otp.mobile .option.metro-itin.expanded div.header &&,
  .tn-gomode .option.metro-itin.expanded div.header && {
    border-radius: 0;
    box-shadow: none;
  }
`

/** The live glyph (the pulsing "waves" itinerary.css draws), in --tn-live. */
const liveGlyph = `
  display: inline-block;
  content: '';
  background: var(--tn-live);
  animation: pulse-opacity 2s ease-in-out infinite;
  flex: none;
  height: 14px;
  margin-right: 3px;
  vertical-align: -1px;
  width: 7px;
  clip-path: path(
    'M3.7,4.1C3.1,4.9,3,6,3.4,7.2c0.1,0.3,0.5,0.6,0.8,0.6c0.3,0,0.5-0.2,0.4-0.5C4.3,6.4,4.4,5.5,4.9,4.9s1.2-1,2.2-1 c0.1,0,0.3-0.1,0.3-0.1c0.1-0.1,0.1-0.3,0-0.4C7.3,3,6.9,2.8,6.6,2.8C5.3,2.8,4.3,3.2,3.7,4.1z M5.6,0C3.5-0.1,1.8,0.7,0.8,2 s-1.1,3.2-0.3,5.2C0.6,7.5,1,7.8,1.3,7.8c0.3,0,0.5-0.2,0.4-0.5C1,5.6,1.1,4,2,2.8s2.3-1.8,4.1-1.7c0.2,0,0.3-0.1,0.3-0.1 c0.1-0.1,0.1-0.2,0-0.4C6.3,0.3,5.9,0,5.6,0z'
  );
`

/** Row 2: "You leave 9:42 PM · arrives 10:13 PM", then the other departures. */
const DepartureTimes = styled.div`
  align-items: center;
  color: var(--tn-text-2);
  column-gap: var(--tn-space-2);
  display: flex;
  flex-wrap: wrap;
  font: var(--tn-type-sm);
  font-variant-numeric: var(--tn-tabular);
  min-width: 0;
  row-gap: 6px;

  .active {
    cursor: auto;
  }

  .leave-line {
    min-width: 0;
  }

  .leave-time {
    color: var(--tn-text);
    font-weight: 600;
  }
  .leave-time.realtime {
    color: var(--tn-live);
  }
  &&& .realtime::before {
    ${liveGlyph}
  }

  div.header {
    background: none;
    border: none;
    display: inline;
    margin: 0;
    padding: 0;
    transition: all 0.1s ease-out;
  }
`

/**
 * The row's other departures (DepartureTimesList) as small chips: 28 px tall
 * with a 44 px hit area, never the 44 px buttons the rider asked to have
 * taken away on 2026-09-23 (21.5). font-size 0 drops the list's ", " / " or "
 * text from view (screen readers still read it); the departure the card is on
 * is the "You leave" time already, so its chip is not repeated.
 */
const OtherDepartures = styled.span`
  display: flex;
  flex-wrap: wrap;
  font-size: 0;
  gap: 6px;
  min-width: 0;

  /* itinerary.css resets every button in a result header to bare 2 px text. */
  &&& .timeInfo {
    align-items: center;
    background-color: var(--tn-surface-2);
    border: 0;
    border-radius: var(--tn-radius-pill);
    box-shadow: inset 0 0 0 1px var(--tn-border);
    color: var(--tn-text);
    display: inline-flex;
    font: 500 13px/16px var(--tn-font);
    font-variant-numeric: var(--tn-tabular);
    height: 28px;
    margin: 0;
    padding: 0 10px;
    position: relative;
    text-decoration: none;
    white-space: nowrap;
  }
  &&& button.timeInfo::after {
    bottom: -8px;
    content: '';
    left: -3px;
    position: absolute;
    right: -3px;
    top: -8px;
  }
  &&& button.timeInfo:active {
    background-color: var(--tn-border);
  }
  &&& .timeInfo.active {
    display: none;
  }
  /* ...and an opened card underlines every time that is not its own. */
  .metro-itin.expanded div.header &&& .timeInfo {
    text-decoration: none;
  }
`

/**
 * Row 1: the leg chain, and the duration hero floated right. A float rather
 * than a flex column, so a chain too long for one line wraps leg by leg
 * beside the duration and then runs the full width of the card below it.
 */
const TopRow = styled.div`
  display: flow-root;
  min-width: 0;
  position: relative;

  /* The chain's screen-reader heading: out of the flow, or its empty
     inline-block opens a blank line above the chain. */
  & > :not(ul):not(div) {
    position: absolute;
  }
`

const ItineraryDetails = styled.ul`
  float: right;
  list-style: none;
  margin: 0 0 0 var(--tn-space-3);
  max-width: 55%;
  padding: 0;
  text-align: right;
`
const PrimaryInfo = styled.li`
  color: var(--tn-text);
  font: 700 28px/32px var(--tn-font);
  font-variant-numeric: var(--tn-tabular);
  letter-spacing: -0.01em;
  text-align: right;
  white-space: nowrap;

  /* "1 hr 11 min" at 28 px takes half the card from the leg chain. */
  &.long {
    font-size: 24px;
  }
`

const SecondaryInfo = styled.li`
  color: var(--tn-text-2);
  font: 400 13px/16px var(--tn-font);
  text-align: right;
`

/** Row 3: "12 min biking · 4 min wait" (or walking), bike minutes dotted. */
const TripFacts = styled.div`
  align-items: center;
  color: var(--tn-text-2);
  display: flex;
  font: var(--tn-type-sm);
  font-variant-numeric: var(--tn-tabular);
  gap: 6px;
  min-width: 0;

  .bike-dot {
    background-color: var(--tn-bike);
    border-radius: 50%;
    flex: none;
    height: 8px;
    width: 8px;
  }
`

/** A flex trip's booking note: its own full line, it can run long. */
const FlexLine = styled.div`
  color: var(--tn-warn);
  font: var(--tn-type-sm);
`

const ItineraryNote = styled.div`
  background: var(--tn-live-soft);
  color: var(--tn-live);
  font: var(--tn-type-sm);
  padding: 6px 16px;
  text-align: right;
`

const ItineraryGrid = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--tn-space-2);
  min-width: 0;
  padding: 14px var(--tn-space-4);

  svg {
    flex: none;
  }
`

/**
 * The leg chain: mode icons 18 px, route pills 26 px (at most 160 px, then an
 * ellipsis), a small text-3 dot between legs. Each leg is an inline unit, so
 * a long chain wraps a whole leg at a time (see TopRow).
 */
const CardRoutes = styled(MetroItineraryRoutes)`
  && {
    display: block;
    line-height: 32px;
    margin-top: 0 !important;
    min-height: 32px;
  }
  && svg {
    height: 18px;
    width: 18px;
  }
  && .route-block-leg-icon {
    align-items: center;
    color: var(--tn-text);
    display: inline-flex;
    height: 26px;
    max-width: 18px;
  }
  && .route-block-divider {
    color: var(--tn-text-3);
    font-size: 11px;
    line-height: 26px;
    margin: 0;
    opacity: 1;
  }
  /* A leg (dot, icon, pill) is one unit that may shrink: its pill gives way
     with an ellipsis before the leg overflows into the duration. */
  && .route-chain-item {
    align-items: center;
    column-gap: 4px;
    display: inline-flex;
    margin-right: 4px;
    max-width: 100%;
    min-width: 0;
    vertical-align: middle;
  }
  && .route-block-wrapper {
    align-items: center;
    column-gap: 4px;
    display: flex;
    margin-left: 0;
    min-width: 0;
    white-space: nowrap;
  }
  && .route-block-wrapper > span:not(.route-block-leg-icon) {
    min-width: 0;
  }
  && .route-block-wrapper span[title] {
    flex: 0 1 auto;
    font-size: 13px;
    max-width: 160px;
    min-width: 0;
  }
`

const ItineraryGridSmall = styled.button`
  background: transparent;
  border-radius: var(--tn-radius);
  color: var(--tn-text);
  display: grid;
  gap: 0 2px;
  grid-template-columns: 1fr 3fr;
  grid-template-rows: repeat(10, 8px);
  padding: 10px 1em;
  width: 100%;

  ${PrimaryInfo} {
    font-size: 17px;
    grid-column: 2;
    grid-row: 2 / 5;
    line-height: 1;
  }

  ${SecondaryInfo} {
    grid-column: 2;
    grid-row: 8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span.route-block-wrapper {
    grid-row: 2 / 5;
  }

  svg {
    /* Fix for safari, where svg needs explicit width to render */
    width: 28px;
  }
`

/**
 * "Other stops" (backlog 16.6, 21.5): a disclosure row along the bottom of
 * the card, edge to edge under a hairline — subtle, but a thumb-sized row the
 * rider finds without hunting.
 */
const VariantsRow = styled(SameShapeVariants)`
  && {
    margin: 0 calc(-1 * var(--tn-space-4)) -14px;
  }
  && > .same-shape-variants-toggle {
    border-radius: 0 0 var(--tn-radius) var(--tn-radius);
    box-shadow: inset 0 1px 0 var(--tn-border);
    padding: 0 var(--tn-space-4);
  }
  .metro-itin.expanded div.header && button {
    text-decoration: none;
  }
  && > :not(.same-shape-variants-toggle) {
    margin-left: 6px;
    margin-right: 6px;
  }
  && > :last-child:not(.same-shape-variants-toggle) {
    margin-bottom: var(--tn-space-3);
  }
`

/**
 * A multi-stop trip's overall line (backlog 43.1, "just want overall trip
 * stats"): where it stops and how far it goes in all. The duration, the fare
 * and the final arrival above are already the whole trip's.
 */
const StopsRow = styled.span`
  color: var(--tn-text-2);
  font-size: 13px;
`

/**
 * The same line on the small street-only tile (a bike or a walk through the
 * stops), which is too narrow for the distance: just where it stops. Placed
 * on rows the tile adds for it (MULTI_STOP_MINI_ROWS).
 */
const MiniStopsRow = styled.span`
  color: var(--tn-text-2);
  font-size: 12px;
  grid-column: 1 / span 2;
  grid-row: 10 / span 4;
  line-height: 1.2;
  text-align: left;
`
const MULTI_STOP_MINI_ROWS = { gridTemplateRows: 'repeat(14, 8px)' }

const BLUR_AMOUNT = 3
const blurAnimation = keyframes`
 0% { filter: blur(${BLUR_AMOUNT}px); }
 50% { filter: blur(${BLUR_AMOUNT + 1}px) }
`

const LoadingBlurred = styled.span.withConfig({
  shouldForwardProp: (prop) => String(prop) !== 'loading'
})<{ loading?: boolean }>`
  ${(props) => props.loading && `filter: blur(${BLUR_AMOUNT}px)`};
  animation-name: ${(props) => (props.loading ? blurAnimation : '')};
  animation-duration: 1s;
  animation-iteration-count: infinite;
  transition: all 0.2s ease-in-out;
`

/**
 * Start Trip: the primary pill (accent, 48 px, 16 px 600). Was a green 8 px
 * box — green is the realtime colour now, never an action.
 */
export const StartTripButton = styled.button`
  background-color: var(--tn-accent);
  border: none;
  border-radius: var(--tn-radius-pill);
  color: var(--tn-accent-ink);
  cursor: pointer;
  font: 600 16px/20px var(--tn-font);
  margin: 16px;
  min-height: var(--tn-control-h);
  padding: 14px 24px;
  width: calc(100% - 32px);
  transition: filter 0.12s ease;

  &:active {
    filter: brightness(0.92);
  }
  &:focus-visible {
    outline: 2px solid var(--tn-accent);
    outline-offset: 2px;
  }
`

// "Start when I leave" (65.2 B4): Start Trip's own button as the secondary
// pill — the second way to start the same trip, not a competing action.
// Inline rather than a new styled component, so no other component's
// generated class moves.
export const START_WHEN_I_LEAVE_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--tn-surface-2)',
  boxShadow: 'inset 0 0 0 1px var(--tn-border)',
  color: 'var(--tn-text)',
  marginTop: 0
}
type Props = {
  LegIcon: React.ReactNode
  accessibilityScoreGradationMap: { [value: number]: string }
  active: boolean
  beginGoMode?: (
    itinerary: Itinerary,
    options?: {
      multiStop?: MultiStopPlan | null
      newTrip?: boolean
      roundTrip?: RoundTripPlan | null
    }
  ) => void
  defaultFareType: FareProductSelector
  /** This is true when there is only one itinerary being shown and the itinerary-body is visible */
  expanded: boolean
  intl: IntlShape
  itinerary: Itinerary
  /** Ask the planner for this row's other stops (backlog 21.5). */
  lookupOtherStops?: (itinerary: Itinerary) => void
  mini?: boolean
  /**
   * Set by the planner's results list only: this row is a result of the
   * active search, so its "Other stops" may look the other stops up. Go
   * Mode's onboard list renders this component too, with rows that are in no
   * search, and leaves it off.
   */
  otherStopsLookup?: boolean
  /** Where this row's lookup stands on the active search. */
  otherStopsLookupStatus?: LookupStatus
  returnToGoMode?: () => void
  /** state.otp.roundTrip — the return options planned for this outbound. */
  roundTrip?: { returnPlan: ReturnPlanState | null }
  /** currentQuery.roundTrip: the rider asked for a way back too. */
  roundTripEnabled?: boolean
  setActiveItinerary: SetActiveItineraryHandler
  setActiveLeg: (leg: Leg) => void
  setItineraryView: (view: string) => void
  setMobileScreen?: (screen: number) => void
  showRealtimeAnnotation: () => void
  stayMinutes?: number
  /** True while a Go Mode trip is running (start button becomes a switch). */
  tripActive?: boolean
}

export class MetroItinerary extends NarrativeItinerary {
  static contextType = ComponentContext

  static ModesAndRoutes = MetroItineraryRoutes

  _onMouseEnter = () => {
    const { active, index, setVisibleItinerary, visible } = this.props
    // Set this itinerary as visible if not already visible.
    const isVisible = visible || active
    if (typeof setVisibleItinerary === 'function' && !isVisible) {
      setVisibleItinerary({ index })
    }
  }

  /**
   * The Via line's stops, each with when the rider gets there and the stay
   * asked for there as a minimum — "Perennial Cycle 10:59 AM (20 min+)"
   * (backlog 58.3; the rider's answer: times on the card and in the step
   * list). A stop without a usable time is just its name, as before.
   */
  _stopsText = (itinerary: Itinerary, stopNames: string[]): string => {
    const { intl } = this.props
    const times = itineraryStopTimes(itinerary)
    if (!times.length) return stopNames.join(' › ')
    return times
      .map(({ arrivalTime, name, stayMinutes }) => {
        if (!Number.isFinite(arrivalTime)) return name
        const time = intl.formatTime(arrivalTime)
        if (!stayMinutes) {
          return intl.formatMessage(
            { id: 'components.MultiStop.stopTime' },
            { stop: name, time }
          )
        }
        const stay = intl
          .formatMessage(
            { id: 'components.RoundTrip.stayOption' },
            { hours: Math.floor(stayMinutes / 60), minutes: stayMinutes % 60 }
          )
          .trim()
        return intl.formatMessage(
          { id: 'components.MultiStop.stopTimeStay' },
          { stay, stop: name, time }
        )
      })
      .join(' › ')
  }

  _lookupOtherStops = () => {
    const { itinerary, lookupOtherStops } = this.props
    if (lookupOtherStops) lookupOtherStops(itinerary)
  }

  _onMouseLeave = () => {
    const { setVisibleItinerary, visible } = this.props
    if (typeof setVisibleItinerary === 'function' && visible) {
      setVisibleItinerary({ index: null })
    }
  }

  /**
   * The return the rider picked, packaged for Go Mode. Null unless the toggle
   * is on AND a ready plan exists for THIS outbound — a plan left over from a
   * different itinerary would send Go Mode the wrong way home.
   */
  _roundTripPlan = (): RoundTripPlan | null => {
    const { itinerary, roundTrip, roundTripEnabled, stayMinutes } = this.props
    const returnPlan = roundTrip?.returnPlan
    if (
      !roundTripEnabled ||
      !returnPlan ||
      returnPlan.status !== 'ready' ||
      returnPlan.outboundKey !== outboundKeyOf(itinerary)
    ) {
      return null
    }
    const returnItinerary = returnPlan.itineraries[returnPlan.selectedIndex]
    if (!returnItinerary) return null
    return buildRoundTripPlan({
      outbound: itinerary,
      returnItinerary,
      stayMinutes: returnPlan.stayMinutes ?? stayMinutes ?? 0
    })
  }

  /**
   * A card can hold several departures of the same journey, so the trip about
   * to start is not always the one the card advertises: on 2026-09-21 the
   * rider's thumb landed on the 10:04 chip of a row whose own departure was
   * 09:07, and 1.15 s later Go Mode started the 10:12 Orange Line instead of
   * the 09:14 they had been riding towards (backlog 23.1).
   *
   * So when the chosen departure is more than LATE_DEPARTURE_CONFIRM_MINUTES
   * after the row's own, starting it asks first — naming the two times and
   * nothing else, because the two times are the whole of what went wrong.
   * Returns false when the rider says no.
   */
  _confirmLaterDeparture = (): boolean => {
    const { intl, itinerary } = this.props
    const rowTime = rowDepartureTime(itinerary)
    if (rowTime === null) return true
    if (minutesAfterRowDeparture(itinerary) <= LATE_DEPARTURE_CONFIRM_MINUTES) {
      return true
    }
    return window.confirm(
      intl.formatMessage(
        {
          defaultMessage: 'Start {chosen} instead of {row}?',
          id: 'components.MetroUI.confirmLaterDeparture'
        },
        {
          chosen: intl.formatTime(itinerary.startTime),
          row: intl.formatTime(rowTime)
        }
      )
    )
  }

  _handleStartTrip = () => {
    const { beginGoMode, intl, itinerary, returnToGoMode, tripActive } =
      this.props
    if (!beginGoMode) return
    if (!this._confirmLaterDeparture()) return
    const roundTripPlan = this._roundTripPlan()
    // A trip through the rider's stops runs one segment at a time (43.1): Go
    // Mode starts on the way to the first stop, and the return of a round trip
    // waits for the last segment.
    const multiStop = buildMultiStopPlan(itinerary, roundTripPlan)
    const startItinerary = multiStop ? multiStop.segments[0] : itinerary
    // Start Trip starts a trip — Auto (65.2) goes off even when this route
    // replaces one already running.
    const startOptions = multiStop
      ? { multiStop, newTrip: true, roundTrip: null }
      : { multiStop: null, newTrip: true, roundTrip: roundTripPlan }
    if (tripActive) {
      // A trip is already running (backgrounded behind the planner):
      // adopting an alternate is an explicit switch, so confirm — the current
      // guidance is replaced (riding state is preserved/reanchored).
      if (
        !window.confirm(
          intl.formatMessage({
            defaultMessage:
              'Switch your active trip to this route? Your current guidance will update.',
            id: 'components.MetroUI.confirmSwitchTrip'
          })
        )
      ) {
        return
      }
      beginGoMode(startItinerary, startOptions)
      returnToGoMode?.()
      return
    }
    beginGoMode(startItinerary, startOptions)
  }

  _renderMainRouteBlock = (legs: Leg[]) => {
    const { enableDot, LegIcon, showLegDurations } = this.props
    const mainLeg = legs
      // Sort to ensure non-walk leg is first
      .sort((a: Leg, b: Leg) => b.distance - a.distance)[0]
    return (
      <RouteBlock
        aria-hidden
        footer={
          showLegDurations &&
          mainLeg?.duration && (
            <FormattedDuration
              duration={ensureAtLeastOneMinute(mainLeg.duration)}
            />
          )
        }
        hideLongName
        leg={mainLeg}
        LegIcon={LegIcon}
        showDivider={enableDot}
      />
    )
  }

  // eslint-disable-next-line complexity
  render() {
    const {
      accessibilityScoreGradationMap,
      active,
      arrivesAt,
      beginGoMode,
      co2Config,
      defaultFareType,
      expanded,
      intl,
      itinerary,
      LegIcon,
      mini,
      pending,
      roundTripEnabled,
      setActiveItinerary,
      setActiveLeg,
      setItineraryView,
      setMobileScreen,
      showInlineItinerarySummary,
      showLegDurations,
      showRealtimeAnnotation,
      tripActive
    } = this.props
    const {
      FlexNoticeIcon,
      ItineraryPreviewSupplement,
      RouteRenderer,
      SvgIcon
    } = this.context
    const stopNames = itineraryStopNames(itinerary)
    const stopsText = this._stopsText(itinerary, stopNames)
    const Route = RouteRenderer || DefaultRouteRenderer

    const { isCallAhead, isContinuousDropoff, isFlexItinerary, phone } =
      getFlexAttributes(itinerary)

    const { fareCurrency, transitFare } = getFare(itinerary, defaultFareType)

    const roundedCo2VsBaseline = Math.round(itinerary.co2VsBaseline * 100)
    const emissionsNote = !mini &&
      Math.abs(roundedCo2VsBaseline) >= (co2Config?.cutoffPercentage || 0) &&
      (roundedCo2VsBaseline < 0 || co2Config?.showIfHigher) &&
      co2Config?.enabled && (
        <IconWithText Icon={Leaf}>
          <FormattedMessage
            id="common.itineraryDescriptions.relativeCo2"
            values={{
              co2: (
                <LoadingBlurred loading={pending}>
                  <FormattedNumber
                    // FormattedNumber style prop is not about CSS.
                    // eslint-disable-next-line react/style-prop-object
                    style="unit"
                    unit="percent"
                    unitDisplay="narrow"
                    value={Math.abs(roundedCo2VsBaseline)}
                  />
                </LoadingBlurred>
              ),
              isMore: roundedCo2VsBaseline > 0
            }}
          />
        </IconWithText>
      )
    const localizedGradationMapWithIcons = localizeGradationMap(
      intl,
      SvgIcon,
      accessibilityScoreGradationMap
    )

    const handleClick = () => {
      setActiveItinerary(itinerary)
      setActiveLeg(null, null)
      setItineraryView(ItineraryView.ITINERARY_OPEN)
      // Reset the scroll. Refs would be the more
      // appropriate way to do this, but they don't work
      setTimeout(
        () => document.querySelector('.itin-wrapper')?.scrollIntoView(),
        10
      )
    }
    const formattedFare = fareCurrency
      ? intl.formatNumber(transitFare, {
          currency: fareCurrency,
          currencyDisplay: 'narrowSymbol',
          style: 'currency'
        })
      : intl.formatNumber(transitFare)

    // No fare known: the card says nothing about fares (it used to say "No
    // fare information" on every row of a feed that publishes none).
    const fareKnown = !(
      transitFare === null ||
      transitFare === undefined ||
      transitFare < 0
    )
    let showFare = fareKnown
    let fareInfo =
      // Hide the fare information entirely if the defaultFareType isn't specified.
      !fareKnown ? (
        <FormattedMessage id="common.itineraryDescriptions.fareUnknown" />
      ) : (
        // TODO: re-implement TNC fares for metro UI?
        <FormattedMessage
          id="components.MetroUI.fare"
          values={{ fare: formattedFare }}
        />
      )

    if (
      // Display special message if there are multiple fare products, but no primary product configured
      itinerary.legs.some((leg: Leg) => leg.fareProducts?.length ?? 0 > 1) &&
      !defaultFareType
    ) {
      console.log("Missing DefaultFareType! Can't display default fare")
      fareInfo = (
        <FormattedMessage id="common.itineraryDescriptions.noDefaultFareTypeConfigured" />
      )
      showFare = true
    }

    // The row's other departures, shown as chips beside its own time.
    const hasOtherDepartures =
      ((itinerary as ItineraryWithStartTimes).allStartTimes?.length ?? 0) > 1

    // Use first leg's agency as a fallback
    return (
      <div
        className={
          'option metro-itin' +
          (active ? ' active' : '') +
          (expanded ? ' expanded' : '')
        }
      >
        <div
          className="header"
          onClick={expanded ? undefined : handleClick}
          // TODO: once this can be tabbed to, this behavior needs to be improved. Maybe it focuses the
          // first time?
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          onKeyDown={() => {}}
          onMouseEnter={expanded ? undefined : this._onMouseEnter}
          onMouseLeave={expanded ? undefined : this._onMouseLeave}
          // TODO: use _onHeaderClick for tap only -- this will require disabling
          // this onClick handler after a touchStart
          // TODO: CORRECT THIS ARIA ROLE
          role="presentation"
          // TODO test this with a screen reader
          // tabIndex={expanded ? 1 : 0}
        >
          <ItineraryWrapper className={'itin-wrapper' + (mini ? '-small' : '')}>
            {emissionsNote && <ItineraryNote>{emissionsNote}</ItineraryNote>}
            {itineraryHasAccessibilityScore(itinerary) && (
              <AccessibilityRating
                gradationMap={localizedGradationMapWithIcons}
                score={itinerary.accessibilityScore}
              />
            )}
            {!mini && (
              <ItineraryGrid className="itin-grid" role="group">
                {/* TODO: a11y: add aria-label to parent element */}
                {ItineraryPreviewSupplement && (
                  <ItineraryPreviewSupplement
                    active={active}
                    itinerary={itinerary}
                  />
                )}
                <TopRow className="itin-top-row">
                  <ItineraryDetails
                    aria-label={intl.formatMessage({
                      id: 'components.ItinerarySummary.itineraryDetails'
                    })}
                  >
                    <PrimaryInfo
                      className={
                        itinerary.duration >= 3600 ? 'long' : undefined
                      }
                    >
                      <FormattedDuration
                        duration={ensureAtLeastOneMinute(itinerary.duration)}
                        includeSeconds={false}
                      />
                    </PrimaryInfo>
                    {/* If inline summary is enabled, don't show fare in side.
                        No fare known: no line at all, not "No fare
                        information" on every card. */}
                    {showInlineItinerarySummary !== true && showFare && (
                      <SecondaryInfo>{fareInfo}</SecondaryInfo>
                    )}
                  </ItineraryDetails>
                  <CardRoutes
                    expanded={expanded}
                    itinerary={itinerary}
                    LegIcon={LegIcon}
                    showLegDurations={showLegDurations}
                  />
                </TopRow>
                <DepartureTimes className="itin-departures">
                  {showInlineItinerarySummary && getFirstTransitLeg(itinerary) && (
                    <Route
                      leg={getFirstTransitLeg(itinerary)}
                      style={{
                        margin: 0,
                        marginLeft: -8,
                        marginRight: -2,
                        transform: 'scale(50%)'
                      }}
                    />
                  )}
                  <span className="leave-line">
                    {arrivesAt ? (
                      <FormattedMessage id="components.MetroUI.arriveAt" />
                    ) : (
                      <FormattedMessage id="components.MetroUI.leaveAt" />
                    )}{' '}
                    <span
                      className={`leave-time${
                        firstTransitLegIsRealtime(itinerary) ? ' realtime' : ''
                      }`}
                    >
                      <FormattedTime
                        value={
                          arrivesAt ? itinerary.endTime : itinerary.startTime
                        }
                      />
                    </span>
                    {' · '}
                    {arrivesAt ? (
                      <FormattedMessage
                        defaultMessage="leaves {time}"
                        id="components.MetroUI.variantLeaves"
                        values={{ time: intl.formatTime(itinerary.startTime) }}
                      />
                    ) : (
                      <FormattedMessage
                        defaultMessage="arrives {time}"
                        id="components.MetroUI.variantArrives"
                        values={{ time: intl.formatTime(itinerary.endTime) }}
                      />
                    )}
                  </span>
                  {hasOtherDepartures && (
                    <OtherDepartures className="other-departures">
                      <DepartureTimesList
                        expanded={expanded}
                        itinerary={itinerary}
                        setActiveItinerary={setActiveItinerary}
                        showArrivals={arrivesAt}
                      />
                    </OtherDepartures>
                  )}
                  {showInlineItinerarySummary && (
                    <span>
                      <FormattedMessage
                        id="components.MetroUI.itinerarySummary"
                        values={{
                          cost: fareInfo,
                          stopName: getFirstTransitLegStop(itinerary)
                        }}
                      />
                    </span>
                  )}
                  {expanded && showInlineItinerarySummary && (
                    <div style={{ color: 'var(--tn-text)' }}>
                      <FormattedMessage id="components.TripSummary.leaveAt" />
                      <FormattedTime value={itinerary.startTime} />
                      <span style={{ marginLeft: '2ch' }}> </span>
                      <FormattedMessage id="components.TripSummary.arriveAt" />
                      <FormattedTime value={itinerary.endTime} />
                    </div>
                  )}
                </DepartureTimes>
                {(() => {
                  // Wait between buses (OTP waitingTime, stay-adjusted),
                  // only when there is at least a minute of it.
                  const waitSeconds = Number(itinerary.waitingTime)
                  const waitNote =
                    Number.isFinite(waitSeconds) && waitSeconds >= 60 ? (
                      <>
                        {' · '}
                        <FormattedMessage
                          id="components.MetroUI.timeWaiting"
                          values={{
                            time: (
                              <FormattedDuration
                                duration={waitSeconds}
                                includeSeconds={false}
                              />
                            )
                          }}
                        />
                      </>
                    ) : null
                  const bikeTime = itinerary.legs
                    .filter((leg: Leg) => leg.mode === 'BICYCLE')
                    .reduce((sum: number, leg: Leg) => sum + leg.duration, 0)
                  if (bikeTime > 0) {
                    return (
                      <TripFacts className="itin-facts">
                        <span aria-hidden className="bike-dot" />
                        <span>
                          <FormattedMessage
                            defaultMessage="{time} biking"
                            id="components.MetroUI.timeBiking"
                            values={{
                              time: (
                                <FormattedDuration
                                  duration={ensureAtLeastOneMinute(bikeTime)}
                                  includeSeconds={false}
                                />
                              )
                            }}
                          />
                          {waitNote}
                        </span>
                      </TripFacts>
                    )
                  }
                  return (
                    <TripFacts className="itin-facts">
                      <span>
                        <FormattedMessage
                          id="components.MetroUI.timeWalking"
                          values={{
                            time: (
                              <FormattedDuration
                                duration={
                                  itinerary.walkTime > 0
                                    ? ensureAtLeastOneMinute(itinerary.walkTime)
                                    : itinerary.walkTime
                                }
                                includeSeconds={false}
                              />
                            )
                          }}
                        />
                        {waitNote}
                      </span>
                    </TripFacts>
                  )
                })()}
                {isFlexItinerary && (
                  <FlexLine className="flex">
                    <FlexIndicator
                      isCallAhead={isCallAhead}
                      isContinuousDropoff={isContinuousDropoff}
                      phoneNumber={phone}
                      shrink={false}
                      textOnly
                    />
                  </FlexLine>
                )}
                {stopNames.length > 0 && (
                  <StopsRow className="multi-stop-summary">
                    <FormattedMessage
                      id="components.MultiStop.summary"
                      values={{
                        distance: humanizeDistanceString(
                          itineraryDistanceM(itinerary),
                          false,
                          intl
                        ),
                        stops: stopsText
                      }}
                    />
                  </StopsRow>
                )}
                {/*
                  The variants control is the card's last row, full width
                  under a hairline: anything inline lands mid-sentence and
                  reads as punctuation. Its own row is the only place on this
                  card a thumb finds without hunting (backlog 16.6).
                */}
                <VariantsRow
                  itinerary={itinerary}
                  lookupStatus={this.props.otherStopsLookupStatus}
                  onLookup={
                    this.props.otherStopsLookup
                      ? this._lookupOtherStops
                      : undefined
                  }
                  setActiveItinerary={setActiveItinerary}
                />
              </ItineraryGrid>
            )}
            {mini && (
              <ItineraryGridSmall
                className="other-itin"
                style={stopNames.length ? MULTI_STOP_MINI_ROWS : undefined}
              >
                <PrimaryInfo as="span">
                  <FormattedDuration
                    duration={ensureAtLeastOneMinute(itinerary.duration)}
                    includeSeconds={false}
                  />
                </PrimaryInfo>
                <SecondaryInfo as="span">
                  <ItineraryDescription itinerary={itinerary} />
                </SecondaryInfo>
                {this._renderMainRouteBlock(itinerary.legs)}
                {stopNames.length > 0 && (
                  <MiniStopsRow className="multi-stop-summary">
                    <FormattedMessage
                      id="components.MultiStop.via"
                      values={{ stops: stopsText }}
                    />
                  </MiniStopsRow>
                )}
              </ItineraryGridSmall>
            )}
          </ItineraryWrapper>
        </div>
        {active && expanded && (
          <>
            {showRealtimeAnnotation && <SimpleRealtimeAnnotation />}
            <ItineraryBody
              accessibilityScoreGradationMap={localizedGradationMapWithIcons}
              itinerary={itinerary}
              LegIcon={LegIcon}
              RouteDescriptionOverride={RouteBlockWithModeDecoration}
              setActiveLeg={setActiveLeg}
            />
            {roundTripEnabled && <ReturnTripPanel itinerary={itinerary} />}
            {beginGoMode && (
              <StartTripButton onClick={this._handleStartTrip}>
                {tripActive ? (
                  <FormattedMessage
                    defaultMessage="Switch to this trip"
                    id="components.MetroUI.switchTrip"
                  />
                ) : (
                  <FormattedMessage
                    defaultMessage="Start Trip"
                    id="components.MetroUI.startTrip"
                  />
                )}
              </StartTripButton>
            )}
            {/* "Start when I leave" (65.2 B4): a one-way trip planned with
                no trip running — not a trip through stops, nor a round trip
                (both are built around the plan as tapped). */}
            {beginGoMode &&
              !tripActive &&
              !roundTripEnabled &&
              !buildMultiStopPlan(itinerary, null) && (
                <AutoArmControl itinerary={itinerary}>
                  {(open) => (
                    <StartTripButton
                      className="start-when-i-leave"
                      onClick={open}
                      style={START_WHEN_I_LEAVE_STYLE}
                      type="button"
                    >
                      <FormattedMessage
                        defaultMessage="Start when I leave"
                        id="components.MetroUI.startWhenILeave"
                      />
                    </StartTripButton>
                  )}
                </AutoArmControl>
              )}
          </>
        )}
      </div>
    )
  }
}

const mapStateToProps = (state: AppReduxState, ownProps: Props) => {
  const activeSearch = getActiveSearch(state)

  return {
    accessibilityScoreGradationMap:
      state.otp.config.accessibilityScore?.gradationMap,
    arrivesAt: state.otp.filter.sort.type === 'ARRIVALTIME',
    co2Config: state.otp.config.co2,
    configCosts: state.otp.config.itinerary?.costs,
    defaultFareType: state.otp.config.itinerary?.defaultFareType,
    enableDot: !state.otp.config.itinerary?.disableMetroSeperatorDot,
    otherStopsLookupStatus: ownProps.otherStopsLookup
      ? // @ts-expect-error TODO: type activeSearch
        activeSearch?.otherStopsLookup?.[
          // @ts-expect-error the list hands rows an index
          ownProps.itinerary?.index
        ]?.status
      : undefined,
    // @ts-expect-error TODO: type activeSearch
    pending: activeSearch ? Boolean(activeSearch.pending) : false,
    roundTrip: state.otp.roundTrip,
    roundTripEnabled: !!state.otp.currentQuery.roundTrip,

    showInlineItinerarySummary:
      state.otp.config.itinerary?.showInlineItinerarySummary,
    showLegDurations: state.otp.config.itinerary?.showLegDurations,
    stayMinutes: Number(state.otp.currentQuery.stayMinutes),
    tripActive: Boolean(state.otp.goMode?.isActive)
  }
}

// TS TODO: correct redux types
const mapDispatchToProps = {
  beginGoMode: goModeActions.beginGoMode,
  lookupOtherStops,
  returnToGoMode: goModeActions.returnToGoMode,
  setItineraryView: uiActions.setItineraryView,
  setMobileScreen: uiActions.setMobileScreen
}

export default injectIntl(
  connect(mapStateToProps, mapDispatchToProps)(MetroItinerary)
)
