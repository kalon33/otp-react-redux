import { ArrowsAlt } from '@styled-icons/fa-solid/ArrowsAlt'
import { connect } from 'react-redux'
import { FormattedMessage, useIntl } from 'react-intl'
import { ListUl } from '@styled-icons/fa-solid/ListUl'
import React, { useRef, useState } from 'react'
import type { Itinerary, Leg } from '@opentripplanner/types'

import * as goModeActions from '../../actions/go-mode'
import * as routingProfileActions from '../../actions/routing-profiles'
import {
  BOARDING_CONFIRM,
  resolveBoardingOffer
} from '../../util/go-mode/boarding-confirmation'
import { buildLiveItinerary } from '../../util/go-mode/live-itinerary'
import { formatPlaceName } from '../../util/format-place-name'
import { getModeIcon } from '../../util/go-mode/mode-icon'
import { IconWithText } from '../util/styledIcon'
import ItineraryBody from '../narrative/line-itin/connected-itinerary-body'
import type { LiveLegTime, RidingState } from '../../util/go-mode/types'
import type { TripProgress } from '../../util/go-mode/progress-calculator'

import {
  BoardingOverlay,
  BoardingSheet,
  BoardingTitle,
  LegIcon,
  LegInfo,
  LegRow,
  LegSubtitle,
  LegTitle,
  RerouteButton,
  RerouteChip,
  RerouteChips,
  RerouteNlError,
  RerouteNlInput,
  RerouteNlRow,
  RerouteSendButton,
  SheetCloseButton,
  SheetExpandButton,
  SheetHeader,
  SheetSectionTitle,
  StopDot,
  StopList,
  StopRow,
  WaitNote
} from './styled'

// Quick mid-trip re-route options; each maps to a pre-built routing profile.
const REROUTE_CHIPS = [
  { labelId: 'components.GoMode.lessWalking', profileId: 'minimize-walking' },
  { labelId: 'components.GoMode.fewerTransfers', profileId: 'stay-seated' },
  { labelId: 'components.GoMode.avoidBiking', profileId: 'avoid-biking' },
  { labelId: 'components.GoMode.fastest', profileId: 'fastest' }
]

const TRANSIT_MODES = new Set(['BUS', 'FERRY', 'RAIL', 'SUBWAY', 'TRAM'])

interface Props {
  activeItinerary: Itinerary | null
  activeLeg: number | null
  browseFromCurrentPosition: (options?: {
    preferences?: any
    profileId?: string
  }) => void
  confirmBoardingByRider: () => void
  denyBoardingByRider: () => void
  fetchPreferencesFromText: (text: string) => Promise<any>
  liveLegTimes: Record<number, LiveLegTime>
  matchedVehicleId: string | null
  onClose: () => void
  progress: TripProgress | null
  riding: RidingState | null
  setGoModeActiveLeg: (index: number | null) => void
}

/**
 * Slide-up sheet the rider opens mid-trip to (a) see the rest of their journey
 * and (b) look for another way — all without leaving the active Go Mode route,
 * which keeps running on the map underneath. Closing the sheet never tears down
 * the trip.
 *
 * The journey itself is rendered by the SAME ItineraryBody the trip planner
 * uses (the component the rider tapped to start this trip), fed a live-times
 * clone of the itinerary — so the leg breakdown, realtime styling and
 * tap-a-leg-to-zoom are the app's own, not a Go Mode re-implementation. The
 * two things only Go Mode knows — which leg is happening right now, and how
 * long the wait at the next stop is — are layered on top as a "Right now" card.
 */
const TripSheet = ({
  activeItinerary,
  activeLeg,
  browseFromCurrentPosition,
  confirmBoardingByRider,
  denyBoardingByRider,
  fetchPreferencesFromText,
  liveLegTimes,
  matchedVehicleId,
  onClose,
  progress,
  riding,
  setGoModeActiveLeg
}: Props) => {
  const intl = useIntl()
  const [rerouteText, setRerouteText] = useState('')
  const [nlBusy, setNlBusy] = useState(false)
  const [nlError, setNlError] = useState(false)
  // Starts tall (the list is what the rider opened the sheet for); tapping a
  // leg or the toggle drops it so the map — and the zoom — are visible.
  const [expanded, setExpanded] = useState(true)

  // ItineraryBody only re-renders when the ITINERARY changes
  // (ConnectedItineraryBody.shouldComponentUpdate), so the setActiveLeg it
  // holds is whichever closure it first received. Read the current selection
  // through a ref so that stale closure still toggles against the truth
  // instead of re-selecting the same leg forever.
  const activeLegRef = useRef<number | null>(activeLeg)
  activeLegRef.current = activeLeg

  const legs = activeItinerary?.legs || []
  const currentLegIndex = progress?.currentLegIndex ?? 0
  const currentLeg: Leg | undefined = legs[currentLegIndex]

  // Wait at a transit leg's boarding stop: the gap between reaching the stop
  // and the bus leaving. For the very next bus the rider is walking toward,
  // progress.waitTimeAtStop is the live figure (actual pace vs live departure);
  // for legs further out only the scheduled gap is known. Returns seconds, or
  // null when there's no meaningful wait to show.
  const waitSecondsBeforeLeg = (i: number): number | null => {
    const leg = legs[i]
    if (i === 0 || !leg || !TRANSIT_MODES.has(leg.mode)) return null
    if (i === currentLegIndex + 1 && progress?.waitTimeAtStop != null) {
      return progress.waitTimeAtStop
    }
    const board = Number(leg.startTime)
    const prevEnd = Number(legs[i - 1]?.endTime)
    if (!Number.isFinite(board) || !Number.isFinite(prevEnd)) return null
    return (board - prevEnd) / 1000
  }

  const legTitle = (leg: Leg): string => {
    if (TRANSIT_MODES.has(leg.mode)) {
      return leg.routeShortName || leg.routeLongName || leg.mode
    }
    if (leg.mode === 'WALK') {
      return intl.formatMessage(
        {
          defaultMessage: 'Walk',
          id: 'components.GoMode.legWalk'
        },
        { distance: Math.round(leg.distance || 0) }
      )
    }
    if (leg.mode === 'BICYCLE') {
      return intl.formatMessage(
        {
          defaultMessage: 'Bike',
          id: 'components.GoMode.legBike'
        },
        { distance: Math.round(leg.distance || 0) }
      )
    }
    return leg.mode
  }

  // For the current transit leg, list its remaining stops with the rider's
  // position highlighted. progress.stopsRemaining counts the stops still ahead
  // (intermediate + destination); a stop's position-from-end tells us whether
  // it's passed, the one being approached next, or still upcoming.
  const renderCurrentStops = (leg: Leg) => {
    const stops = leg.intermediateStops || []
    if (stops.length === 0) return null
    const k = stops.length
    const intl = useIntl()
    const remaining = progress?.stopsRemaining ?? k + 1
    return (
      <StopList>
        {stops.map((stop: any, i: number) => {
          const positionFromEnd = k - i + 1 // destination = 1
          const passed = positionFromEnd > remaining
          const next = positionFromEnd === remaining
          return (
            <StopRow $next={next} $passed={passed} key={i}>
              <StopDot $next={next} $passed={passed} />
              {formatPlaceName(stop.name, intl)}
            </StopRow>
          )
        })}
        <StopRow $next={remaining === 1}>
          <StopDot $next={remaining === 1} />
          {formatPlaceName(leg.to.name, intl)}
        </StopRow>
      </StopList>
    )
  }

  /**
   * The "Right now" card: the leg in progress, with the two facts the plain
   * itinerary can't know — live stops-remaining (the same figure as the header
   * above the map; the two must never disagree) and the wait before the next
   * bus.
   */
  const renderCurrentLegCard = () => {
    if (!currentLeg) return null
    const isTransit = TRANSIT_MODES.has(currentLeg.mode)
    const liveRemaining = progress?.stopsRemaining
    const stopCount =
      isTransit && liveRemaining != null && liveRemaining > 0
        ? liveRemaining
        : (currentLeg.intermediateStops?.length ?? 0) + 1
    // The wait that matters is the one the rider is about to sit through:
    // theirs on this leg if it's a bus, else the one before the next bus.
    const waitSecs = isTransit
      ? waitSecondsBeforeLeg(currentLegIndex)
      : waitSecondsBeforeLeg(currentLegIndex + 1)
    const waitMins = waitSecs != null ? Math.round(waitSecs / 60) : 0

    return (
      <LegRow $current>
        <LegIcon>{getModeIcon(currentLeg.mode)}</LegIcon>
        <LegInfo>
          <LegTitle>{legTitle(currentLeg)}</LegTitle>
          {waitMins >= 1 && (
            <WaitNote>
              {intl.formatMessage(
                {
                  defaultMessage: '🕒 {mins} min wait',
                  id: 'components.GoMode.legWait'
                },
                { mins: waitMins }
              )}
            </WaitNote>
          )}
          <LegSubtitle>
            {isTransit
              ? intl.formatMessage(
                  {
                    defaultMessage:
                      '{count, plural, one {# stop} other {# stops}} to {dest}',
                    id: 'components.GoMode.legStopsTo'
                  },
                  {
                    count: stopCount,
                    dest: formatPlaceName(currentLeg.to.name, intl)
                  }
                )
              : intl.formatMessage(
                  {
                    defaultMessage: 'to {dest}',
                    id: 'components.GoMode.legTo'
                  },
                  { dest: formatPlaceName(currentLeg.to.name, intl) }
                )}
          </LegSubtitle>
          {isTransit && renderCurrentStops(currentLeg)}
        </LegInfo>
      </LegRow>
    )
  }

  /**
   * The rider's own say on being aboard (6.10c). One chip, never a question:
   * the app already knows which bus is in the itinerary, and
   * `feedback_no_redundant_prompts` says it must not ask. Which chip — and
   * whether there is one at all — is decided in
   * util/go-mode/boarding-confirmation.ts.
   */
  const renderBoardingChip = () => {
    const { offer } = resolveBoardingOffer({
      currentLeg,
      matchedVehicleId,
      nextLeg: legs[currentLegIndex + 1],
      riding
    })
    if (!offer) return null
    const confirming = offer === BOARDING_CONFIRM
    return (
      <RerouteChips>
        <RerouteChip
          onClick={confirming ? confirmBoardingByRider : denyBoardingByRider}
          type="button"
        >
          {confirming
            ? intl.formatMessage({
                defaultMessage: "I'm on the bus",
                id: 'components.GoMode.boardingConfirm'
              })
            : intl.formatMessage({
                defaultMessage: 'Not on the bus',
                id: 'components.GoMode.boardingDeny'
              })}
        </RerouteChip>
      </RerouteChips>
    )
  }

  // Same toggle semantics as the planner's narrative list: tapping the active
  // leg again clears it. Selecting one drops the sheet so the zoom is visible.
  const handleLegClick = (index: number) => {
    const next = activeLegRef.current === index ? null : index
    activeLegRef.current = next
    setGoModeActiveLeg(next)
    if (next !== null) setExpanded(false)
  }

  const handleClose = () => {
    setGoModeActiveLeg(null)
    onClose()
  }

  const handleChip = (profileId: string) => {
    browseFromCurrentPosition({ profileId })
  }

  const handleSearchFromHere = () => {
    browseFromCurrentPosition()
  }

  const handleSendMessage = async () => {
    const text = rerouteText.trim()
    if (!text) return
    setNlBusy(true)
    setNlError(false)
    try {
      const prefs = await fetchPreferencesFromText(text)
      browseFromCurrentPosition({ preferences: prefs })
      setRerouteText('')
    } catch {
      setNlError(true)
    } finally {
      setNlBusy(false)
    }
  }

  const liveItinerary = activeItinerary
    ? buildLiveItinerary(activeItinerary, liveLegTimes)
    : null

  return (
    <>
      {/* Only dim the map when the sheet is tall — collapsed, the map is the
          point and must stay tappable. */}
      {expanded && (
        <BoardingOverlay
          className="go-mode-sheet-overlay"
          onClick={handleClose}
        />
      )}
      <BoardingSheet
        $expanded={expanded}
        aria-label={intl.formatMessage({
          defaultMessage: 'Trip overview',
          id: 'components.GoMode.tripSheetTitle'
        })}
        role="dialog"
      >
        <SheetHeader>
          <BoardingTitle>
            {intl.formatMessage({
              defaultMessage: 'Your trip',
              id: 'components.GoMode.tripSheetHeading'
            })}
          </BoardingTitle>
          <div>
            <SheetExpandButton
              onClick={() => setExpanded(!expanded)}
              type="button"
            >
              <IconWithText Icon={expanded ? ArrowsAlt : ListUl}>
                {expanded ? (
                  <FormattedMessage
                    defaultMessage="Expand map"
                    id="components.BatchResultsScreen.expandMap"
                  />
                ) : (
                  <FormattedMessage
                    defaultMessage="Show results"
                    id="components.BatchResultsScreen.showResults"
                  />
                )}
              </IconWithText>
            </SheetExpandButton>
            <SheetCloseButton
              aria-label={intl.formatMessage({ id: 'common.forms.close' })}
              onClick={handleClose}
              type="button"
            >
              ×
            </SheetCloseButton>
          </div>
        </SheetHeader>

        {/* Section A — the journey itself, rendered by the planner's own
            itinerary component with Go Mode's live times folded in. */}
        <SheetSectionTitle>
          {intl.formatMessage({
            defaultMessage: 'Rest of your trip',
            id: 'components.GoMode.restOfTrip'
          })}
        </SheetSectionTitle>
        {renderCurrentLegCard()}
        {renderBoardingChip()}
        {liveItinerary && (
          <ItineraryBody
            itinerary={liveItinerary}
            setActiveLeg={handleLegClick}
            showTripTools={false}
          />
        )}

        {/* Section B — find another way. This hands the rider the real trip
            planner (results screen, expand-map, "Switch to this trip") with
            the origin at where they actually are. */}
        <SheetSectionTitle>
          {intl.formatMessage({
            defaultMessage: 'Find another way',
            id: 'components.GoMode.findAnotherWay'
          })}
        </SheetSectionTitle>
        <RerouteButton onClick={handleSearchFromHere} type="button">
          {intl.formatMessage({
            defaultMessage: 'Search from here',
            id: 'components.GoMode.rerouteSearchHere'
          })}
        </RerouteButton>
        <RerouteChips>
          {REROUTE_CHIPS.map((chip) => (
            <RerouteChip
              key={chip.profileId}
              onClick={() => handleChip(chip.profileId)}
              type="button"
            >
              {intl.formatMessage({ id: chip.labelId })}
            </RerouteChip>
          ))}
        </RerouteChips>
        <RerouteNlRow>
          <RerouteNlInput
            aria-label={intl.formatMessage({
              defaultMessage: 'Describe what you need',
              id: 'components.GoMode.rerouteNlLabel'
            })}
            disabled={nlBusy}
            onChange={(e) => {
              setRerouteText(e.target.value)
              if (nlError) setNlError(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSendMessage()
            }}
            placeholder={intl.formatMessage({
              defaultMessage: 'e.g. avoid stairs today',
              id: 'components.GoMode.rerouteNlPlaceholder'
            })}
            value={rerouteText}
          />
          <RerouteSendButton
            disabled={nlBusy || !rerouteText.trim()}
            onClick={handleSendMessage}
            type="button"
          >
            {nlBusy
              ? '…'
              : intl.formatMessage({
                  defaultMessage: 'Go',
                  id: 'components.GoMode.rerouteNlSend'
                })}
          </RerouteSendButton>
        </RerouteNlRow>
        {nlError && (
          <RerouteNlError>
            {intl.formatMessage({
              defaultMessage: "Couldn't read that — try again.",
              id: 'components.GoMode.rerouteNlError'
            })}
          </RerouteNlError>
        )}
      </BoardingSheet>
    </>
  )
}

const mapStateToProps = (state: any) => {
  const goMode = state.otp.goMode
  return {
    activeItinerary: goMode?.activeItinerary || null,
    activeLeg: goMode?.ui?.activeLeg ?? null,
    liveLegTimes: goMode?.liveLegTimes || {},
    matchedVehicleId: goMode?.vehicleMatch?.match?.vehicleId || null,
    progress: goMode?.progress || null,
    riding: goMode?.riding || null
  }
}

const mapDispatchToProps = {
  browseFromCurrentPosition: goModeActions.browseFromCurrentPosition,
  confirmBoardingByRider: goModeActions.confirmBoardingByRider,
  denyBoardingByRider: goModeActions.denyBoardingByRider,
  fetchPreferencesFromText: routingProfileActions.fetchPreferencesFromText,
  setGoModeActiveLeg: goModeActions.setGoModeActiveLeg
}

export default connect(mapStateToProps, mapDispatchToProps)(TripSheet)
