import { DEFAULT_APP_TITLE } from './constants'

/** The product name shown in the app bar when the config names none. */
export const TN_BRAND_TITLE = 'TransitNav'

/**
 * The title for the app bar: the config.yml `title` when it names one, else
 * "TransitNav". The OTP default ("OpenTripPlanner", DEFAULT_APP_TITLE) counts
 * as unset — it is what an unconfigured deployment inherits, not a choice.
 */
export function getBrandTitle(configTitle?: string | null): string {
  const title = configTitle?.trim()
  return title && title !== DEFAULT_APP_TITLE ? title : TN_BRAND_TITLE
}
