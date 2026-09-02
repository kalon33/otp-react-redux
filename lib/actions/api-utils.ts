import { TransportMode } from '@opentripplanner/types'
import coreUtils from '@opentripplanner/core-utils'

// core-utils types SIMPLIFICATIONS as a closed object literal, so widen it to
// the lookup it actually is (mode name -> broad mode class).
const SIMPLIFICATIONS: Record<string, string | undefined> =
  coreUtils.queryGen.SIMPLIFICATIONS

export const countFlexModes = (modes: TransportMode[]): number =>
  modes.filter((m) => m.mode === 'FLEX').length

/** A plain transit mode (TRANSIT or a transit submode) with no qualifier. */
const isTransitMode = (m: TransportMode): boolean =>
  !m.qualifier && SIMPLIFICATIONS[m.mode] === 'TRANSIT'

/**
 * Anything that gets the rider to and from transit under their own power or in
 * a vehicle: BICYCLE/SCOOTER (PERSONAL), CAR, and everything qualified
 * (BICYCLE_RENT and the flex modes both simplify to SHARED).
 */
const isNonWalkAccessMode = (m: TransportMode): boolean =>
  !!m.qualifier ||
  SIMPLIFICATIONS[m.mode] === 'PERSONAL' ||
  SIMPLIFICATIONS[m.mode] === 'CAR' ||
  SIMPLIFICATIONS[m.mode] === 'SHARED'

/**
 * Drop the walk-access transit call from the mode fan-out (rider ask #48,
 * "turn off walk+bus options").
 *
 * Measured against the live graph on 2026-09-02 (Lyndale/38th -> downtown,
 * 12:00): the `[TRANSIT]` combination returned 11 itineraries, every one of
 * them WALK-BUS-WALK; the `[TRANSIT, BICYCLE]` combination returned 6, every
 * one of them BICYCLE-BUS-BICYCLE and not a single walk-access chain among
 * them. OTP does not mix walk-access results into a query that names a personal
 * access mode, so all of the walk+bus options come from exactly one of the four
 * calls the default transit+bicycle button pair generates. Dropping that
 * combination is therefore exact — no result-list post-filter is needed, and it
 * saves an OTP round trip rather than throwing one away after it returns.
 *
 * Returns the input untouched when the filter is off, and also when it would
 * leave nothing to ask (walk+transit is the rider's only option), so the toggle
 * can never turn a working search into an empty one.
 */
export function filterWalkAccessCombinations<
  T extends { modes?: TransportMode[] }
>(combinations: T[], hideWalkTransit?: boolean): T[] {
  if (!hideWalkTransit) return combinations
  const kept = combinations.filter((combo) => {
    const modes = combo.modes || []
    if (!modes.some(isTransitMode)) return true
    return modes.some(isNonWalkAccessMode)
  })
  return kept.length > 0 ? kept : combinations
}
