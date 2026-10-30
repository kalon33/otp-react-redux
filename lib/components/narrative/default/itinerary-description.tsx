import { FormattedMessage, IntlShape } from 'react-intl'
import { Itinerary, Leg } from '@opentripplanner/types'
import coreUtils from '@opentripplanner/core-utils'
import React, { useContext } from 'react'

import { ComponentContext } from '../../../util/contexts'
import { getFormattedMode } from '../../../util/i18n'
import { itineraryAccessModeId } from '../../../util/itinerary'
import FormattedMode from '../../util/formatted-mode'

const { isRideshareLeg } = coreUtils.itinerary

const { isBicycle, isMicromobility, isTransitLeg } = coreUtils.itinerary

type Props = {
  combineTransitModes?: boolean
  itinerary: Itinerary
}

/**
 * Whether this leg names the transit half of the description: the longest
 * transit leg, and failing that the first. Only a leg LONGER than the best so
 * far used to qualify, starting from 0 s, so a bus ride the GTFS times at
 * 0 seconds (two consecutive stops in the same minute) never did — the card
 * read "Walk" or "Bike" and was filed under that heading, not "+ Transit"
 * (75.14: the 22 and 48 on a 50 m search, 191 itineraries in 52 searches).
 */
function isPrimaryTransitLeg(
  leg: Leg,
  transitModeSoFar: unknown,
  primaryTransitDuration: number
): boolean {
  return (
    isTransitLeg(leg) &&
    (transitModeSoFar === undefined || leg.duration > primaryTransitDuration)
  )
}

/**
 * Obtains the description of an itinerary in the given locale.
 */
export function getMainItineraryModes({
  combineTransitModes,
  intl,
  itinerary
}: Props & { intl: IntlShape }): {
  mainMode: string
  transitMode?: string
} {
  let primaryTransitDuration = 0
  let transitMode: string | undefined
  itinerary.legs.forEach((leg) => {
    const { duration, mode } = leg
    if (isPrimaryTransitLeg(leg, transitMode, primaryTransitDuration)) {
      primaryTransitDuration = duration
      transitMode = getFormattedMode(
        combineTransitModes ? 'transit' : mode.toLowerCase(),
        intl
      )
    }
  })

  // The access half of the heading now comes from the shared helper, because
  // doMergeItineraries uses the SAME function to decide whether two itineraries
  // may fold into one card. When the two disagreed, a bike itinerary could be
  // merged away under a walk heading (2026-09-08 rider report).
  return {
    mainMode: getFormattedMode(itineraryAccessModeId(itinerary), intl),
    transitMode
  }
}

/**
 * Obtains the description of an itinerary in the given locale.
 */
export function ItineraryDescription({ itinerary }: Props): JSX.Element {
  // FIXME: type context
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const { TransitModes } = useContext(ComponentContext)

  let primaryTransitDuration = 0
  let accessModeId = 'walk'
  let transitMode: JSX.Element | undefined
  itinerary.legs.forEach((leg) => {
    const { duration, mode, rentedBike, rentedVehicle } = leg
    if (isPrimaryTransitLeg(leg, transitMode, primaryTransitDuration)) {
      primaryTransitDuration = duration

      // If custom TransitModes have been defined for the given mode/leg, attempt to use them,
      // otherwise fall back on built-in mode rendering.
      transitMode = TransitModes ? (
        <TransitModes leg={leg} />
      ) : (
        <FormattedMode mode={mode} />
      )
    }

    if (isBicycle(mode)) accessModeId = 'bicycle'
    if (rentedBike) accessModeId = 'bicycle_rent'
    if (isMicromobility(mode)) accessModeId = 'micromobility'
    if (rentedVehicle) accessModeId = 'micromobility_rent'
    if (mode === 'CAR') accessModeId = 'drive'
    if (isRideshareLeg(leg)) accessModeId = 'ride'
  })

  const mainMode = <FormattedMode mode={accessModeId} />
  return transitMode ? (
    <FormattedMessage
      id="components.DefaultItinerary.multiModeSummary"
      values={{ accessMode: mainMode, transitMode }}
    />
  ) : (
    mainMode
  )
}

export function getItineraryDescription(
  props: Props & { intl: IntlShape }
): string {
  const { intl } = props
  const { mainMode, transitMode } = getMainItineraryModes(props)

  return transitMode
    ? intl.formatMessage(
        { id: 'components.DefaultItinerary.multiModeSummary' },
        {
          accessMode: mainMode,
          transitMode
        }
      )
    : mainMode
}
