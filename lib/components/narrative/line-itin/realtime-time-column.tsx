import { FormattedMessage, FormattedTime } from 'react-intl'
import { isFlex, isTransitLeg } from '@opentripplanner/core-utils/lib/itinerary'
import { Leg } from '@opentripplanner/types'
import React, { ReactElement } from 'react'
import styled from 'styled-components'

import RealtimeStatusLabel, {
  DelayText,
  MainContent
} from '../../viewers/realtime-status-label'
import type { RiderStopMark } from '../../../util/multi-stop'

interface Props {
  isDestination: boolean
  leg: Leg
}

const StyledStatusLabel = styled(RealtimeStatusLabel)`
  ${MainContent} {
    font-size: 80%;
    line-height: 1em;
  }
  ${DelayText} {
    display: block;
  }
`
/** The "leave 11:19 AM" line under a rider's stop's arrival time. */
const LeaveLine = styled.div`
  color: #666;
  font-size: 80%;
  line-height: 1.1em;
`

/**
 * The row of a stop the rider added (backlog 58.3) is the row of the leg that
 * LEAVES it, so on its own the column showed the leave time and called it
 * nothing. With a stay, or any gap, it shows when the rider gets there and,
 * under it, when the plan leaves.
 */
function riderStopTimes(
  leg: Leg,
  isDestination: boolean
): { arrival: number; leave: number } | null {
  if (isDestination) return null
  const mark = (leg.from as { riderStop?: RiderStopMark })?.riderStop
  const arrival = Number(mark?.arrivalTime)
  const leave = Number(leg.startTime)
  if (!mark || !Number.isFinite(arrival) || !Number.isFinite(leave)) return null
  if (!mark.stayMinutes && leave - arrival < 60000) return null
  return { arrival, leave }
}

/**
 * This component displays the scheduled departure/arrival time for a leg,
 * and, for transit legs, displays any delays or earliness where applicable.
 */
function RealtimeTimeColumn({ isDestination, leg }: Props): ReactElement {
  if (typeof leg.startTime === 'string') {
    return <></>
  }

  const stop = riderStopTimes(leg, isDestination)
  if (stop) {
    return (
      <div className="rider-stop-times">
        <FormattedTime timeStyle="short" value={stop.arrival} />
        <LeaveLine>
          <FormattedMessage
            id="components.MultiStop.leaveAt"
            values={{
              time: <FormattedTime timeStyle="short" value={stop.leave} />
            }}
          />
        </LeaveLine>
      </div>
    )
  }

  const timeMillis = isDestination ? leg.endTime : leg.startTime
  const isRealtimeTransitLeg =
    !isDestination && isTransitLeg(leg) && leg.realTime

  // For non-transit legs show only the scheduled time.
  if (!isTransitLeg(leg)) {
    return (
      <div>
        <FormattedTime timeStyle="short" value={timeMillis} />
      </div>
    )
  }

  const delaySeconds = isDestination ? leg.arrivalDelay : leg.departureDelay
  const originalTimeMillis = timeMillis - delaySeconds * 1000

  return (
    <StyledStatusLabel
      delay={delaySeconds}
      isFlex={isFlex(leg)}
      isRealtime={isRealtimeTransitLeg}
      originalTime={originalTimeMillis}
      time={timeMillis}
    />
  )
}

export default RealtimeTimeColumn
