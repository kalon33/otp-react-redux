import { Button } from 'react-bootstrap'
import { Check } from '@styled-icons/fa-solid/Check'
import { ExclamationTriangle } from '@styled-icons/fa-solid/ExclamationTriangle'
import { FormattedMessage, useIntl } from 'react-intl'
import { Train } from '@styled-icons/fa-solid/Train'
import React, { useMemo, useState } from 'react'

import { checkinLeg, isTransitLeg } from '../../util/checkin'
import { IconWithText } from '../util/styledIcon'
import { readCheckinSettings } from '../../util/checkin-settings'

interface CheckinButtonProps {
  /** The itinerary being shown, from the search results. */
  itinerary?: any
}

interface CheckinOutcome {
  ok: boolean
  service: string
  text: string
}

/**
 * Check the trip into Träwelling/travelynx, from the itinerary search
 * results. One button for both services: whichever the rider enabled in
 * Settings receives a check-in for every transit leg of this itinerary —
 * across services in parallel, within a service in travel order.
 *
 * Rendered by TripTools' CHECKIN button type, so it inherits the same
 * `tool-button` look as Print/Copy link, and it stays hidden until the rider
 * has enabled a service in Settings and the itinerary has transit legs.
 */
export default function CheckinButton({
  itinerary
}: CheckinButtonProps): JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<CheckinOutcome[]>([])
  const intl = useIntl()
  const settings = readCheckinSettings()

  const transitLegs = useMemo(
    () => (itinerary?.legs ?? []).filter(isTransitLeg),
    [itinerary]
  )
  const configured =
    (settings.trawelling.enabled && !!settings.trawelling.token) ||
    (settings.travelynx.enabled && !!settings.travelynx.token)
  if (!configured || transitLegs.length === 0) return null

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    setResults([])
    const outcomes: CheckinOutcome[] = []
    for (const leg of transitLegs) {
      // eslint-disable-next-line no-await-in-loop
      const perService = await checkinLeg(settings, leg)
      for (const [service, result] of Object.entries(perService)) {
        outcomes.push({
          ok: result.ok,
          service,
          text: result.ok
            ? result.sent
              ? intl.formatMessage({ id: 'components.CheckinButton.sent' })
              : intl.formatMessage({ id: 'components.CheckinButton.checkedIn' })
            : result.error ||
              intl.formatMessage({ id: 'components.CheckinButton.failed' })
        })
      }
    }
    setResults(outcomes)
    setBusy(false)
  }

  const allOk = results.length > 0 && results.every((r) => r.ok)
  const failedSummary = results
    .filter((r) => !r.ok)
    .map((r) => `${r.service}: ${r.text}`)
    .join(' · ')

  return (
    <div>
      <Button className="tool-button" disabled={busy} onClick={onClick}>
        {allOk ? (
          <IconWithText Icon={Check}>
            <FormattedMessage id="components.CheckinButton.checkedIn" />
          </IconWithText>
        ) : failedSummary ? (
          <IconWithText Icon={ExclamationTriangle}>
            {failedSummary}
          </IconWithText>
        ) : (
          <IconWithText Icon={Train}>
            {busy ? (
              <FormattedMessage id="components.CheckinButton.checkingIn" />
            ) : (
              <FormattedMessage id="components.CheckinButton.checkIn" />
            )}
          </IconWithText>
        )}
      </Button>
    </div>
  )
}
