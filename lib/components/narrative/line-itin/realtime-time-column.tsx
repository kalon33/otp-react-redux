import { FormattedMessage, FormattedTime } from 'react-intl'
import { isFlex, isTransitLeg } from '@opentripplanner/core-utils/lib/itinerary'
import { Leg } from '@opentripplanner/types'
import React, { ReactElement } from 'react'
import styled from 'styled-components'

import { RED_ON_WHITE } from '../../util/colors'
import RealtimeStatusLabel, {
  DelayText,
  MainContent
} from '../../viewers/realtime-status-label'
import type { RiderStopMark } from '../../../util/multi-stop'
import type { TransferArrivalMark } from '../../../util/transfer-times'

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

  /* Phone layout: the time 14px tabular, the delay 12px under it. */
  .tn-mobile & {
    font-variant-numeric: var(--tn-tabular);
  }
  .tn-mobile & .realtime-icon {
    font-weight: 600;
  }
  .tn-mobile & ${MainContent} {
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
    white-space: nowrap;
  }
  .tn-mobile & ${DelayText} {
    display: inline;
  }
`
/** The "leave 11:19 AM" line under a rider's stop's arrival time. */
const LeaveLine = styled.div`
  color: #666;
  font-size: 80%;
  line-height: 1.1em;

  .tn-mobile & {
    color: var(--tn-text-2);
    font-size: 12px;
    line-height: 16px;
  }
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

/** "misses by 3 min": the outgoing bus leaves before the rider arrives. */
const MissLine = styled.div`
  color: ${RED_ON_WHITE};
  font-size: 80%;
  line-height: 1.1em;

  .tn-mobile & {
    color: var(--tn-danger);
    font-size: 12px;
    line-height: 16px;
  }
`

/**
 * A transit→transit change (backlog 61.1): the row is the leaving leg's, so
 * the arriving bus's own arrival rides on `from.transferArrival`.
 */
function transferTimes(
  leg: Leg,
  isDestination: boolean
): { arrival: TransferArrivalMark; missedBy: number } | null {
  if (isDestination) return null
  const arrival = (leg.from as { transferArrival?: TransferArrivalMark })
    ?.transferArrival
  const leave = Number(leg.startTime)
  if (!arrival || !Number.isFinite(arrival.time) || !Number.isFinite(leave)) {
    return null
  }
  const gap = Math.floor(leave / 60000) - Math.floor(arrival.time / 60000)
  return { arrival, missedBy: gap < 0 ? -gap : 0 }
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

  const transfer = transferTimes(leg, isDestination)
  if (transfer) {
    const { arrival, missedBy } = transfer
    const leaveDelay = leg.departureDelay || 0
    return (
      <div className="transfer-times">
        {arrival.realtime ? (
          <StyledStatusLabel
            delay={arrival.delay}
            isFlex={false}
            isRealtime
            originalTime={arrival.time - arrival.delay * 1000}
            time={arrival.time}
          />
        ) : (
          // Schedule only: a plain time, no early/late/scheduled words.
          <div>
            <FormattedTime timeStyle="short" value={arrival.time} />
          </div>
        )}
        <LeaveLine>
          <FormattedMessage
            id="components.MultiStop.leaveAt"
            values={{
              time: <FormattedTime timeStyle="short" value={leg.startTime} />
            }}
          />
        </LeaveLine>
        {missedBy > 0 ? (
          <MissLine>
            <FormattedMessage
              id="components.MultiStop.missesBy"
              values={{ minutes: missedBy }}
            />
          </MissLine>
        ) : (
          <StyledStatusLabel
            delay={leaveDelay}
            isFlex={isFlex(leg)}
            isRealtime={!!leg.realTime}
            originalTime={Number(leg.startTime) - leaveDelay * 1000}
          />
        )}
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
