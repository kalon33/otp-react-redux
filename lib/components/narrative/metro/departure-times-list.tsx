import { Itinerary } from '@opentripplanner/types'
import { useIntl } from 'react-intl'
import React, { MouseEvent, useCallback } from 'react'

import { firstTransitLegIsRealtime } from '../../../util/viewer'
import {
  getFirstLegStartTime,
  getLastLegEndTime,
  ItineraryStartTime,
  ItineraryWithIndex
} from '../../../util/itinerary'
import InvisibleA11yLabel from '../../util/invisible-a11y-label'

export type SetActiveItineraryHandler = (payload: { index: number }) => void

/** A result row carries every departure that folded into it. */
export type ItineraryWithStartTimes = Itinerary & {
  allStartTimes?: ItineraryStartTime[]
}

/**
 * How much later than the row's own departure a chosen trip has to be before
 * starting it asks the rider first.
 *
 * Twenty minutes is the rider's own number (2026-09-21 board answer A). It
 * comes from that morning: at 09:00:51 they started the 09:07 bike to the
 * 09:14 Orange Line; at 09:02:04 one tap on a chip inside the SAME row made
 * the 10:04 / 10:12 departure active, and 1.15 s later they started it
 * (09:02:05.246 START_GO_MODE, trip 1:1348464). The row had folded eight
 * departures spanning an hour and a half into one card, so the tap that looked
 * like "open this result" was in fact "choose a bus 58 minutes later" — and
 * nothing on the way to Start Trip said so. Note 2 at 09:12:57, "Look at the
 * times!!", is the rider finding out.
 */
export const LATE_DEPARTURE_CONFIRM_MINUTES = 20

/**
 * The time this row advertises: the earliest departure folded into it, which
 * is the representative the collapsed list shows. Null when the row carries a
 * single departure — then the row IS the trip and there is nothing to mistake
 * it for.
 */
export function rowDepartureTime(
  itinerary: ItineraryWithStartTimes
): number | null {
  const times = itinerary?.allStartTimes
  if (!times?.length) return null
  return Math.min(...times.map((time) => getFirstLegStartTime(time.legs)))
}

/**
 * Minutes between the departure the row advertises and the one that is about
 * to be started. Zero for a row with one departure, or when the chosen trip is
 * the row's own.
 */
export function minutesAfterRowDeparture(
  itinerary: ItineraryWithStartTimes
): number {
  const rowTime = rowDepartureTime(itinerary)
  if (rowTime === null || !itinerary?.legs?.length) return 0
  return Math.round((getFirstLegStartTime(itinerary.legs) - rowTime) / 60000)
}

type DepartureTimesProps = {
  expanded?: boolean
  itinerary: ItineraryWithIndex & {
    allStartTimes?: ItineraryStartTime[]
  }
  setActiveItinerary: SetActiveItineraryHandler
  showArrivals?: boolean
}

interface TimeButtonProps {
  active?: boolean
  chip?: boolean
  displayedTime: number
  itinerary: ItineraryWithIndex
  realTime?: boolean
  setActiveItinerary?: SetActiveItineraryHandler
}

const TimeButton = ({
  active,
  chip,
  displayedTime,
  itinerary,
  realTime,
  setActiveItinerary
}: TimeButtonProps) => {
  const intl = useIntl()
  const classNames = ['timeInfo']
  // A chip is one of several departures sharing a card, so it is a target in
  // its own right (44 px, itinerary.css) rather than a word in a sentence.
  if (chip) classNames.push('departure-chip')
  if (realTime) classNames.push('realtime')
  if (active) classNames.push('active')
  const timeString = intl.formatTime(displayedTime)
  const realtimeStatus = realTime
    ? intl.formatMessage({ id: 'components.StopTimeCell.realtime' })
    : intl.formatMessage({ id: 'components.StopTimeCell.scheduled' })
  const label = `${timeString} (${realtimeStatus})`

  const handleClick = useCallback(
    (e: MouseEvent) => {
      setActiveItinerary && setActiveItinerary(itinerary)
      // Don't let MetroItinerary.handleClick execute, it will set another itinerary as active.
      e.stopPropagation()
    },
    [itinerary, setActiveItinerary]
  )
  // If setActiveItinerary is set, use a button, otherwise render the time as span without interaction.
  const Wrapper = setActiveItinerary ? 'button' : 'span'

  return (
    <Wrapper
      className={classNames.length ? classNames.join(' ') : undefined}
      onClick={setActiveItinerary ? handleClick : undefined}
      title={label}
    >
      {timeString}
      <InvisibleA11yLabel> ({realtimeStatus})</InvisibleA11yLabel>
    </Wrapper>
  )
}

/**
 * The departures a result row offers.
 *
 * One departure stays inline: the row is that trip, and the whole card is the
 * tap target. Several are laid out as chips — a wrapped row of 44 px buttons,
 * the size the variants control beside them uses — because until 2026-09-21
 * they were rendered as `9:12 AM, 9:36 AM, or 10:49 AM`, inline-text-sized
 * buttons inside a disjunction list, and a thumb on a bike cannot tell one
 * from the next (backlog 23.1).
 */
const DepartureTimesList = ({
  expanded,
  itinerary,
  setActiveItinerary,
  showArrivals
}: DepartureTimesProps): JSX.Element => {
  if (!itinerary.allStartTimes) {
    return (
      <TimeButton
        active
        displayedTime={showArrivals ? itinerary.endTime : itinerary.startTime}
        itinerary={itinerary}
        realTime={firstTransitLegIsRealtime(itinerary)}
        setActiveItinerary={expanded ? undefined : setActiveItinerary}
      />
    )
  }

  return (
    <span className="departure-chips">
      {itinerary.allStartTimes.map((time) => {
        const { itinerary: itinOption, legs, realtime } = time
        const displayedTime = showArrivals
          ? getLastLegEndTime(legs)
          : getFirstLegStartTime(legs)
        return (
          <TimeButton
            active={itinOption.index === itinerary.index}
            chip
            displayedTime={displayedTime}
            itinerary={itinOption}
            key={displayedTime}
            realTime={realtime}
            setActiveItinerary={setActiveItinerary}
          />
        )
      })}
    </span>
  )
}

export default DepartureTimesList
