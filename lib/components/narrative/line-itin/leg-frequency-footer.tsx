import { FormattedMessage, FormattedTime } from 'react-intl'
import { useDispatch, useSelector } from 'react-redux'
import React, { useEffect } from 'react'
import styled from 'styled-components'
import type { Leg } from '@opentripplanner/types'

import {
  describeLegFrequency,
  LegFrequencyEntry,
  LegFrequencyLine,
  legFrequencyQuestion,
  legTripId
} from '../../../util/leg-frequency'
import { fetchLegFrequency } from '../../../actions/leg-frequency'

/**
 * The line sits inside the leg body (`TransitLegBody`'s LegBody), between the
 * route description and the leg's details, and takes that body's own grey
 * 13 px type — the same text the "Ride N min / N stops" line under it uses.
 */
const FooterLine = styled.div`
  margin-top: 4px;
`

const Time = ({ ms }: { ms: number }) => (
  <FormattedTime timeStyle="short" value={ms} />
)

/** The copy for one line (ids `components.LegFrequency.*`). */
export const LegFrequencyText = ({
  line,
  renderTime = (ms: number) => <Time ms={ms} />
}: {
  line: LegFrequencyLine
  /** How a time renders: the planner's FormattedTime by default. */
  renderTime?: (ms: number, live: boolean) => React.ReactNode
}): JSX.Element => {
  switch (line.kind) {
    case 'every':
      return (
        <FormattedMessage
          defaultMessage="Every {minutes} min, next {time}"
          id="components.LegFrequency.every"
          values={{
            minutes: line.minutes,
            time: renderTime(line.next.ms, line.next.live)
          }}
        />
      )
    case 'nextTwo':
      return (
        <FormattedMessage
          defaultMessage="Next {first}, {second}"
          id="components.LegFrequency.nextTwo"
          values={{
            first: renderTime(line.first.ms, line.first.live),
            second: renderTime(line.second.ms, line.second.live)
          }}
        />
      )
    case 'nextOne':
      return (
        <FormattedMessage
          defaultMessage="Next {time}"
          id="components.LegFrequency.nextOne"
          values={{ time: renderTime(line.next.ms, line.next.live) }}
        />
      )
    default:
      return (
        <FormattedMessage
          defaultMessage="No later run before {time}"
          id="components.LegFrequency.noneBefore"
          values={{ time: renderTime(line.untilMs, false) }}
        />
      )
  }
}

/**
 * One line under a transit leg of an opened trip — the planner's trip
 * details and Go Mode's trip sheet both render this body — saying how often
 * the leg's route runs after the rider's run (backlog 58.1). The leg's runs
 * are asked for once, lazily, when the leg first renders; with no answer
 * there is no line.
 */
const LegFrequencyFooter = ({ leg }: { leg: Leg }): JSX.Element | null => {
  const dispatch = useDispatch()
  const question = legFrequencyQuestion(leg)
  const key = question?.key
  const entry: LegFrequencyEntry | undefined = useSelector((state: any) =>
    key ? state.otp?.legFrequency?.[key] : undefined
  )
  useEffect(() => {
    if (key) dispatch(fetchLegFrequency(leg))
    // The question's key is what identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, dispatch])

  if (!question || entry?.status !== 'done') return null
  const line = describeLegFrequency({
    baseMs: question.boardMs,
    excludeTripId: legTripId(leg),
    runs: entry.runs,
    windowEndMs: entry.windowEndMs
  })
  if (!line) return null
  return (
    <FooterLine className="leg-frequency" data-testid="leg-frequency">
      <LegFrequencyText line={line} />
    </FooterLine>
  )
}

export default LegFrequencyFooter
