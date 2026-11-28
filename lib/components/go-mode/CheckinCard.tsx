import { connect } from 'react-redux'
import { FormattedMessage, useIntl } from 'react-intl'
import React, { useEffect, useRef, useState } from 'react'

import {
  checkinLeg,
  isTransitLeg,
  travelynxCheckin,
  trawellingCheckin
} from '../../util/checkin'
import { readCheckinSettings } from '../../util/checkin-settings'
import type { CheckinResult, LegForCheckin } from '../../util/checkin'

import { CheckinCardBanner } from './styled'

/**
 * Träwelling/travelynx inside Go Mode.
 *
 * - The AUTOMATIC check-in is armed HERE, per itinerary, with the switch on
 *   this card — it is never on just because a token exists. With it on, every
 *   transit run the rider is confirmed aboard is checked in as the boarding is
 *   confirmed (one check-in per boarded transport, both services in
 *   parallel).
 * - The MANUAL buttons check in the leg the rider is on (or, while still
 *   walking to it, the transit leg they are heading for) — one button per
 *   service, so the two can be used side by side.
 *
 * The card only appears when at least one service is enabled with a token in
 * Settings; the tokens are the authentication each API request carries
 * (Bearer for Träwelling, the token field for travelynx).
 */
interface Props {
  /** The leg the tick has the rider on (the walk counts, not just rides). */
  currentLegIndex: number
  /** The trip Go Mode is navigating; its identity resets the auto switch. */
  itinerary?: any
  /** The confirmed-aboard fact, when the rider is on a transit run. */
  riding?: { boardedAt?: any; legIndex?: number; tripId?: string } | null
}

interface ManualResult {
  ok: boolean
  text: string
}

const CheckinCard = ({
  currentLegIndex,
  itinerary,
  riding
}: Props): JSX.Element | null => {
  const intl = useIntl()
  const settings = readCheckinSettings()

  const services = (['trawelling', 'travelynx'] as const).filter(
    (key) => settings[key].enabled && !!settings[key].token
  )

  // The rider's per-itinerary arming of the automatic check-in: on this card,
  // off at the start of every trip, reset when the trip changes.
  const [autoOn, setAutoOn] = useState(false)
  const [manualBusy, setManualBusy] = useState<string | null>(null)
  const [manualResults, setManualResults] = useState<
    Record<string, ManualResult>
  >({})
  const tripKey = itinerary?.startTime ?? null
  useEffect(() => {
    setAutoOn(false)
    setManualResults({})
  }, [tripKey])

  const legs: any[] = itinerary?.legs ?? []
  // What a manual check-in targets: the run being ridden, the transit leg
  // underway, or failing that the transit leg the rider is heading for.
  const targetLegIndex =
    riding?.legIndex != null && riding.legIndex >= 0
      ? riding.legIndex
      : currentLegIndex
  const currentLeg =
    targetLegIndex >= 0 && targetLegIndex < legs.length
      ? legs[targetLegIndex]
      : undefined
  const nextLegIndex = legs.findIndex(
    (leg, i) =>
      i > (targetLegIndex >= 0 ? targetLegIndex : -1) && isTransitLeg(leg)
  )
  const manualLeg = isTransitLeg(currentLeg ?? {})
    ? currentLeg
    : nextLegIndex >= 0
    ? legs[nextLegIndex]
    : undefined

  // The automatic check-in itself: once per confirmed boarding, on this
  // trip's switch only.
  const ridingKey = riding
    ? `${riding.tripId ?? ''}|${riding.legIndex ?? -1}|${String(
        riding.boardedAt ?? ''
      )}`
    : null
  const autoDoneRef = useRef<string | null>(null)
  useEffect(() => {
    if (!autoOn || !ridingKey || !manualLeg) return
    if (autoDoneRef.current === ridingKey) return
    autoDoneRef.current = ridingKey
    checkinLeg(settings, manualLeg).catch(() => {
      // A failed automatic check-in must never disturb the ride; the manual
      // buttons are right there.
    })
    // The riding fact is the request; the leg is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOn, ridingKey])

  const onManual = async (service: string) => {
    if (!manualLeg || manualBusy) return
    setManualBusy(service)
    let result: CheckinResult
    if (service === 'trawelling') {
      result = await trawellingCheckin(
        settings.trawelling,
        manualLeg as LegForCheckin
      ).catch(() => ({ ok: false } as CheckinResult))
    } else {
      result = await travelynxCheckin(
        settings.travelynx,
        manualLeg as LegForCheckin
      ).catch(() => ({ ok: false } as CheckinResult))
    }
    setManualResults({
      ...manualResults,
      [service]: {
        ok: result.ok,
        text: result.ok
          ? result.sent
            ? intl.formatMessage({ id: 'components.CheckinButton.sent' })
            : intl.formatMessage({ id: 'components.GoMode.checkinOk' })
          : result.error ||
            intl.formatMessage({ id: 'components.CheckinButton.failed' })
      }
    })
    setManualBusy(null)
  }

  if (services.length === 0) return null

  return (
    <CheckinCardBanner>
      <strong>
        <FormattedMessage id="components.GoMode.checkinTitle" />
      </strong>{' '}
      <label htmlFor="tn-checkin-auto">
        <input
          checked={autoOn}
          id="tn-checkin-auto"
          onChange={() => setAutoOn(!autoOn)}
          type="checkbox"
        />{' '}
        <FormattedMessage id="components.GoMode.checkinAutoLabel" />
      </label>{' '}
      {services.map((service) => {
        const result = manualResults[service]
        return (
          <button
            disabled={!manualLeg || manualBusy === service}
            key={service}
            onClick={() => onManual(service)}
            type="button"
          >
            {manualBusy === service ? (
              <FormattedMessage id="components.GoMode.checkinBusy" />
            ) : result ? (
              result.text
            ) : (
              intl.formatMessage(
                {
                  defaultMessage: '{service}: check in now',
                  id: 'components.GoMode.checkinManual'
                },
                { service }
              )
            )}
          </button>
        )
      })}
    </CheckinCardBanner>
  )
}

const mapStateToProps = (state: any) => {
  const goMode = state.otp?.goMode
  return {
    currentLegIndex: goMode?.progress?.currentLegIndex ?? -1,
    itinerary: goMode?.activeItinerary,
    riding: goMode?.riding ?? null
  }
}

export default connect(mapStateToProps)(CheckinCard)
