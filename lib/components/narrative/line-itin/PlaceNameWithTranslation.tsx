import { useIntl } from 'react-intl'
import React from 'react'
import type { Place } from '@opentripplanner/types'

import { formatPlaceName } from '../../../util/format-place-name'

interface PlaceNameWithTranslationProps {
  name?: string
}

/**
 * A wrapper around place names that handles translation for known static names
 * like "Current location" or "(Current Location)".
 * This ensures that place names are properly localized in all contexts.
 */
export default function PlaceNameWithTranslation({
  name
}: PlaceNameWithTranslationProps): React.ReactElement {
  const intl = useIntl()
  
  if (!name) {
    return <span />
  }

  // Format the place name, which will translate known static names
  const displayName = formatPlaceName(name, intl)

  return <span>{displayName}</span>
}
