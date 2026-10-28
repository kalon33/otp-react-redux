import {
  CaretToggle,
  TransitLegSummary as SummaryButton
} from '@opentripplanner/itinerary-body/lib/styled'
import { FormattedMessage } from 'react-intl'
import { Leg } from '@opentripplanner/types'
import React, { MouseEventHandler } from 'react'

import FormattedDuration from '../../util/formatted-duration'

interface Props {
  leg: Leg
  onClick: MouseEventHandler<HTMLButtonElement>
  stopsExpanded: boolean
}

/**
 * The transit leg's "Ride 18 min · 9 stops ▾" toggle (mobile overhaul): the
 * package default's button and behaviour, with a middle dot instead of the
 * slash. Toggles the intermediate-stop list; aria-expanded carries the
 * state the package's "(Expand details)" text used to.
 */
export default function TransitLegSummary({
  leg,
  onClick,
  stopsExpanded
}: Props): JSX.Element {
  // The package rounds a sub-minute ride up to one minute; so does this.
  const seconds = Math.max(60, leg.duration || 0)
  return (
    <SummaryButton
      aria-expanded={stopsExpanded}
      className="transit-leg-summary"
      onClick={onClick}
    >
      <FormattedMessage
        // The default keeps standalone IntlProviders (the Go Mode gallery)
        // readable; the app's catalogue carries the same string.
        defaultMessage="Ride {duration}{numStops, plural, =1 {} other { · # stops}}"
        id="components.TransitLegSummary.rideAndStops"
        values={{
          duration: (
            <FormattedDuration duration={seconds} includeSeconds={false} />
          ),
          numStops: (leg.intermediateStops?.length || 0) + 1
        }}
      />
      {leg.intermediateStops && <CaretToggle expanded={stopsExpanded} />}
    </SummaryButton>
  )
}
