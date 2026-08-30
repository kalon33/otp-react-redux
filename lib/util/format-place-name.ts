/**
 * Utility to format place names, translating known static names like "Current location"
 */
import type { IntlShape } from 'react-intl'

/**
 * Known static place names that need translation
 */
const STATIC_PLACE_NAMES: Record<string, string> = {
  '(Current Location)': 'components.GoMode.currentLocation',
  'Current location': 'components.GoMode.currentLocation'
}

/**
 * Format a place name, translating known static names using intl
 */
export function formatPlaceName(name: string, intl: IntlShape): string {
  if (!name) return name

  // Check if the name is a known static place name that needs translation
  const translationKey = STATIC_PLACE_NAMES[name]
  if (translationKey) {
    return intl.formatMessage({ id: translationKey })
  }

  // Return the original name if no translation is needed
  return name
}
