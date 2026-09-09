import { connect } from 'react-redux'
import { Itinerary, Location } from '@opentripplanner/types'
import { Layer, Source, useMap } from 'react-map-gl/maplibre'
import { util } from '@opentripplanner/base-map'
import polyline from '@mapbox/polyline'
import React, { useEffect } from 'react'

import { AppReduxState } from '../../util/state-types'
import { DARK_TEXT_GREY } from '../util/colors'
import {
  getActiveItinerary,
  getActiveSearch,
  getVisibleItineraryIndex
} from '../../util/state'

import { hidePlannerItineraryOverlay } from './connected-transitive-overlay'

type Props = {
  from: Location
  geometries: string[]
  hasNoMainPanelContent?: boolean
  to: Location
  visible?: boolean
}
/**
 * This overlay will display thin gray lines for a set of geometries. It's to be used
 * as a stopgap until we make full use of Transitive!
 */
const RoutePreviewOverlay = ({
  from,
  geometries,
  hasNoMainPanelContent,
  to,
  visible
}: Props) => {
  // Center the map over the endpoints when this overlay is shown.
  const { current: map } = useMap()
  useEffect(() => {
    if (visible && hasNoMainPanelContent && map) {
      util.fitMapToPoints(map, from, to, 0.2, 600)
    }
  }, [map, visible, hasNoMainPanelContent, from, to])

  if (!geometries || !visible) return <></>

  const uniqueGeometries = Array.from(new Set(geometries))
  try {
    const geojson: GeoJSON.FeatureCollection = {
      features: uniqueGeometries
        .filter((s) => !!s)
        .map((segment) => {
          return {
            geometry: polyline.toGeoJSON(segment),
            properties: [],
            type: 'Feature'
          }
        }),
      type: 'FeatureCollection'
    }
    return (
      <Source data={geojson} id="route-preview-source" type="geojson">
        <Layer
          id="route-preview"
          layout={{
            'line-cap': 'round',
            'line-join': 'round'
          }}
          paint={{
            'line-blur': 4,
            'line-color': DARK_TEXT_GREY,
            'line-dasharray': [1, 2],
            'line-opacity': 0.6,
            'line-width': 4
          }}
          type="line"
        />
      </Source>
    )
  } catch (error) {
    console.warn(`Can't create geojson from route ${geometries}: ${error}`)
    return <></>
  }
}

// Exported for unit tests (mirrors hidePlannerItineraryOverlay).
export const mapStateToProps = (state: AppReduxState) => {
  const { activeSearchId, config, ui } = state.otp
  // Only show this overlay if the metro UI is explicitly enabled
  if (config.itinerary?.showFirstResultByDefault !== false) {
    return {}
  }
  if (!activeSearchId) return {}

  // Same gate as the transitive overlay: GoModeMap wraps DefaultMap, which
  // mounts this layer unconditionally, so the planner's search kept painting
  // under the live trip. On 2026-09-08 (session mtsvo7ss-4nzccy) the rider
  // asked "are we still showing alternate routes?" at 11:55 about a pale line
  // under the 546 — this layer, drawing EVERY leg of EVERY itinerary in search
  // `bmf8dmidt` as a blurred dashed grey line for the 29 minutes since 11:26.
  // It is on precisely when nothing is selected, and a fresh ROUTING_REQUEST
  // resets the new search's `activeItinerary` to null (it did at 11:26:08,
  // 11:30:15 and 11:55:58, the last two from refreshStaleSearch), so the
  // rider's own SET_ACTIVE_ITINERARY did not hold it off. The search itself is
  // untouched: step back out to the planner (backgrounded true) and the lines,
  // the results list and "Switch to this trip" are all still there.
  // Note this also stops the `fitMapToPoints` in the component above from
  // yanking the camera off the rider mid-ride.
  if (hidePlannerItineraryOverlay(state.otp.goMode)) return {}

  const visibleItinerary = getVisibleItineraryIndex(state)
  const activeItinerary = getActiveItinerary(state)

  const activeSearch = getActiveSearch(state)
  // @ts-expect-error state is not typed
  const geometries = activeSearch?.response?.flatMap(
    (serverResponse: { plan?: { itineraries?: Itinerary[] } }) =>
      serverResponse?.plan?.itineraries?.flatMap((itinerary) => {
        return itinerary.legs?.map((leg) => leg.legGeometry.points)
      })
  )

  // @ts-expect-error state is not typed
  const query = activeSearch ? activeSearch?.query : state.otp.currentQuery
  const { from, to } = query

  return {
    from,
    geometries,
    hasNoMainPanelContent: ui.mainPanelContent === null,
    to,
    visible:
      // We need an explicit check for undefined and null because 0
      // is for us true
      (visibleItinerary === undefined || visibleItinerary === null) &&
      (activeItinerary === undefined || activeItinerary === null)
  }
}

export default connect(mapStateToProps)(RoutePreviewOverlay)
