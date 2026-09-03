import { IntlShape, useIntl } from 'react-intl'
import {
  LocationFieldProps,
  LocationSelectedEvent
} from '@opentripplanner/location-field/lib/types'
import { MapMarkedAlt } from '@styled-icons/fa-solid/MapMarkedAlt'
import { MapPin } from '@styled-icons/fa-solid/MapPin'
import React, { useCallback, useContext, useMemo, useState } from 'react'

import * as formActions from '../../actions/form'
import * as mapActions from '../../actions/map'
import * as uiActions from '../../actions/ui'
import { ComponentContext } from '../../util/contexts'
import { IconWrapper } from '../user/places/place'

import { StyledLocationField } from './styled'
import connectLocationField from './connect-location-field'

type Props = Omit<
  LocationFieldProps,
  'geocoderConfig' | 'getCurrentPosition'
> & {
  handleLocationSelected: (intl: IntlShape, e: LocationSelectedEvent) => void
  selfValidate?: boolean
  startMapPick: (locationType: string) => void
}

const MAP_PICK_ICON_SIZE = 13

const ConnectedLocationField = connectLocationField(StyledLocationField, {
  includeLocation: true
})

export function GeocodedOptionIcon({
  feature = {}
}: {
  feature: {
    properties?: { modes?: string[]; source: string }
  }
}): React.ReactElement {
  // FIXME: add types to context
  // @ts-expect-error No type on ComponentContext
  const { ModeIcon } = useContext(ComponentContext)

  const { properties } = feature
  if (feature && properties) {
    const { modes } = properties
    if (modes && modes.length > 0) {
      return (
        <IconWrapper>
          {/* role="img" is syntactically incorrect, but is needed for correct rendering in Webkit */}
          <ModeIcon aria-hidden mode={modes[0].toLowerCase()} role="img" />
        </IconWrapper>
      )
    }
  }
  return <MapPin size={13} />
}

/**
 * Wrapper component around LocationField that handles onLocationSelected.
 */
const LocationFieldWithHandler = ({
  clearLocation,
  handleLocationSelected,
  selfValidate,
  startMapPick,
  ...otherProps
}: Props) => {
  const intl = useIntl()
  const [fieldChanged, setFieldChanged] = useState(false)
  const { locationType } = otherProps

  // Rider ask (backlog 3.9): an explicit way into the map, right under Current
  // Location. Upstream only offers set-from-map through the map's long-press
  // popup, which nothing on the screen advertises.
  const mapPickOption = useMemo(
    () => ({
      icon: <MapMarkedAlt size={MAP_PICK_ICON_SIZE} />,
      onClick: () => startMapPick(locationType),
      title: intl.formatMessage({ id: 'components.LocationSearch.chooseOnMap' })
    }),
    [intl, locationType, startMapPick]
  )

  const onLocationSelected = useCallback(
    (e: LocationSelectedEvent) => {
      setFieldChanged(true)
      handleLocationSelected(intl, e)
    },
    [intl, handleLocationSelected, setFieldChanged]
  )

  const onClearLocation = useCallback(
    (e) => {
      setFieldChanged(true)
      clearLocation && clearLocation(e)
    },
    [clearLocation, setFieldChanged]
  )

  return (
    <ConnectedLocationField
      {...otherProps}
      clearLocation={onClearLocation}
      GeocodedOptionIconComponent={GeocodedOptionIcon}
      mapPickOption={mapPickOption}
      onLocationSelected={onLocationSelected}
      // Rider ask (backlog 3.10): Current Location leads the list every time the
      // field is open, typed into or not. Upstream builds it last, so it sat
      // under the recents, the saved places and every geocoder result.
      pinCurrentLocationFirst
      selfValidate={selfValidate || fieldChanged}
    />
  )
}

export default connectLocationField(LocationFieldWithHandler, {
  actions: {
    clearLocation: formActions.clearLocation,
    handleLocationSelected: mapActions.onLocationSelected,
    startMapPick: uiActions.startMapPick
  },
  includeLocation: true
})
