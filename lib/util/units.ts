import { IntlShape } from 'react-intl'

/** The app's unit system, from otpConfig.units. */
export type Units = 'imperial' | 'metric'

/** Metres per second to kilometres per hour. */
const MPS_TO_KMH = 3.6
/** Metres per second to miles per hour. */
const MPS_TO_MPH = 2.23693629
const METERS_PER_MILE = 1609.344

// The TS lib's Intl.NumberFormatOptions predates the ICU `unit` style, but
// @formatjs (which react-intl delegates to) fully supports it at runtime —
// so the options are cast to the parameter type instead of the lib type.
type UnitFormatOptions = Record<string, unknown>

/**
 * A rider-readable speed, unit included, in the app's unit system:
 * "24,1 km/h" in metric French, "15 mph" in imperial English.
 * The number itself is localised by the ICU unit formatting built into
 * react-intl, so the decimal separator follows the locale too.
 */
export function formatSpeed(
  intl: IntlShape,
  mps: number,
  units: Units = 'imperial',
  options: Intl.NumberFormatOptions = { maximumFractionDigits: 1 }
): string {
  return intl.formatNumber(
    mps * (units === 'metric' ? MPS_TO_KMH : MPS_TO_MPH),
    {
      maximumFractionDigits: 1,
      ...options,
      style: 'unit',
      unit: units === 'metric' ? 'kilometer-per-hour' : 'mile-per-hour',
      unitDisplay: 'short'
    } as unknown as Parameters<IntlShape['formatNumber']>[1]
  )
}

/**
 * A rider-readable distance (e.g. the bike ceiling), unit included, in the
 * app's unit system: "23 km" metric, "14 mi" imperial.
 */
export function formatDistance(
  intl: IntlShape,
  meters: number,
  units: Units = 'imperial',
  options: Intl.NumberFormatOptions = { maximumFractionDigits: 0 }
): string {
  return units === 'metric'
    ? intl.formatNumber(
        meters / 1000,
        {
          maximumFractionDigits: 0,
          ...options,
          style: 'unit',
          unit: 'kilometer',
          unitDisplay: 'short'
        } as unknown as Parameters<IntlShape['formatNumber']>[1]
      )
    : intl.formatNumber(
        meters / METERS_PER_MILE,
        {
          maximumFractionDigits: 0,
          ...options,
          style: 'unit',
          unit: 'mile',
          unitDisplay: 'short'
        } as unknown as Parameters<IntlShape['formatNumber']>[1]
      )
}
