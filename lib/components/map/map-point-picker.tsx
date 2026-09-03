import { connect } from 'react-redux'
import { FormattedMessage, useIntl } from 'react-intl'
import { useMap } from 'react-map-gl/maplibre'
import LocationIcon from '@opentripplanner/location-icon'
import React, { useCallback, useEffect, useState } from 'react'
import styled from 'styled-components'

import * as mapActions from '../../actions/map'
import * as uiActions from '../../actions/ui'
import { renderCoordinates } from '../../util/i18n'
import {
  RerouteActions,
  RerouteBar,
  RerouteCard,
  RerouteCardTitle,
  RerouteKeepButton,
  RerouteSummary,
  RerouteSwitchButton
} from '../go-mode/styled'

type Coordinates = { lat: number; lon: number }

type PickerProps = {
  center?: Coordinates | null
  locationType: 'from' | 'to'
  onCancel: () => void
  onConfirm: (center: Coordinates) => void
}

/**
 * The pin sits over the exact middle of the map and does not move: the rider
 * drags the map under it. `translate(-50%, -100%)` puts the *point* of the
 * marker on the centre pixel rather than its middle, and the hairline below it
 * marks that pixel exactly.
 */
const CentrePin = styled.div`
  left: 50%;
  pointer-events: none;
  position: absolute;
  top: 50%;
  transform: translate(-50%, -100%);
  z-index: 1100;
`

const CentreDot = styled.div`
  background: #333;
  border: 2px solid #fff;
  border-radius: 50%;
  height: 9px;
  left: 50%;
  pointer-events: none;
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 9px;
  z-index: 1100;
`

/**
 * The confirm bar shown while the rider is choosing a point on the map
 * (rider ask, backlog 3.9). Presentational on purpose so it can be mounted in
 * a test without a live MapLibre instance; the connected default export below
 * supplies the map centre.
 */
export function MapPointPicker({
  center,
  locationType,
  onCancel,
  onConfirm
}: PickerProps): JSX.Element {
  const intl = useIntl()
  const confirm = useCallback(() => {
    if (center) onConfirm(center)
  }, [center, onConfirm])

  return (
    <>
      <CentrePin className="map-pick-pin">
        <LocationIcon size={30} type={locationType} />
      </CentrePin>
      <CentreDot className="map-pick-dot" />
      <RerouteBar className="map-pick-bar">
        <RerouteCard>
          <RerouteCardTitle>
            {locationType === 'to' ? (
              <FormattedMessage id="components.MapPointPicker.titleTo" />
            ) : (
              <FormattedMessage id="components.MapPointPicker.titleFrom" />
            )}
          </RerouteCardTitle>
          <RerouteSummary>
            {center ? (
              <FormattedMessage
                id="common.coordinates"
                values={renderCoordinates(intl, center)}
              />
            ) : (
              <FormattedMessage id="components.MapPointPicker.instructions" />
            )}
          </RerouteSummary>
          <RerouteActions>
            <RerouteSwitchButton
              className="map-pick-confirm"
              disabled={!center}
              onClick={confirm}
              type="button"
            >
              {locationType === 'to' ? (
                <FormattedMessage id="components.MapPointPicker.setAsDestination" />
              ) : (
                <FormattedMessage id="components.MapPointPicker.setAsStart" />
              )}
            </RerouteSwitchButton>
            <RerouteKeepButton
              className="map-pick-cancel"
              onClick={onCancel}
              type="button"
            >
              <FormattedMessage id="components.MapPointPicker.cancel" />
            </RerouteKeepButton>
          </RerouteActions>
        </RerouteCard>
      </RerouteBar>
    </>
  )
}

type ConnectedProps = {
  cancelMapPick: () => void
  mapPickLocationType: 'from' | 'to' | null
  setLocation: (payload: Record<string, unknown>) => void
}

function ConnectedMapPointPicker({
  cancelMapPick,
  mapPickLocationType,
  setLocation
}: ConnectedProps): JSX.Element | null {
  const { default: map } = useMap()
  const [center, setCenter] = useState<Coordinates | null>(null)
  const active = mapPickLocationType === 'from' || mapPickLocationType === 'to'

  useEffect(() => {
    if (!active || !map) return undefined
    const update = () => {
      const c = map.getCenter()
      setCenter({ lat: c.lat, lon: c.lng })
    }
    update()
    map.on('move', update)
    return () => {
      map.off('move', update)
    }
  }, [active, map])

  const onConfirm = useCallback(
    (point: Coordinates) => {
      setLocation({
        location: {
          lat: point.lat,
          lon: point.lon,
          // Replaced by the reverse-geocoded name when the geocoder answers;
          // mapActions.setLocation keeps this one if it doesn't.
          name: `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`
        },
        locationType: mapPickLocationType,
        reverseGeocode: true
      })
      cancelMapPick()
    },
    [cancelMapPick, mapPickLocationType, setLocation]
  )

  if (!active) return null

  return (
    <MapPointPicker
      center={center}
      locationType={mapPickLocationType as 'from' | 'to'}
      onCancel={cancelMapPick}
      onConfirm={onConfirm}
    />
  )
}

const mapStateToProps = (state: any) => ({
  mapPickLocationType: state.otp.ui.mapPickLocationType
})

const mapDispatchToProps = {
  cancelMapPick: uiActions.cancelMapPick,
  setLocation: mapActions.setLocation
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(ConnectedMapPointPicker)
