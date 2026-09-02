import { connect } from 'react-redux'
import { Itinerary } from '@opentripplanner/types'
import { Layer, Source } from 'react-map-gl/maplibre'
import polyline from '@mapbox/polyline'
import React, { useEffect, useMemo } from 'react'

import { AppReduxState } from '../../util/state-types'
import { DEFAULT_ROUTE_COLOR } from '../util/colors'
import { findRouteIfNeeded } from '../../actions/api'
import {
  riddenPatterns,
  riddenPatternShapes,
  transitLegRouteIds
} from '../../util/go-mode/ridden-pattern'

/**
 * Rider ask #21, second half: "a lighter shade for the route before boarding
 * and after alighting."
 *
 * A leg's `legGeometry` runs board stop → alight stop and stops there, so the
 * rest of the line is not in the itinerary at all. This draws the ridden
 * PATTERN's whole shape — the line's first stop to its last — as a faint line
 * underneath everything else on the map. The ridden hop is then painted over
 * at full strength by the Go Mode route line (GoModeMapOverlay renders into
 * DefaultMap's `children`, which mount last and so paint on top), so what
 * stays faint is exactly the run-in before boarding and the run-out after
 * alighting. No clipping and no geometry arithmetic — just paint order.
 *
 * Mounted alongside RoutePreviewOverlay in default-map.tsx, i.e. ahead of the
 * transitive layer, because the ordering IS the shading.
 *
 * Off with `map.goMode.fullRouteShape: false` (the rider asked for a switch and
 * named the clutter risk himself).
 */

interface Props {
  findRouteIfNeeded: (params: { routeId: string }) => void
  itinerary: Itinerary | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  routes: Record<string, any> | null
  visible: boolean
}

/** Opacity of the un-ridden run-in / run-out. Present, never competing. */
export const RIDDEN_SHAPE_OPACITY = 0.35

const RiddenRouteShapeOverlay = ({
  findRouteIfNeeded: fetchRoute,
  itinerary,
  routes,
  visible
}: Props): JSX.Element => {
  const routeIds = useMemo(
    () => (visible ? transitLegRouteIds(itinerary) : []),
    [visible, itinerary]
  )

  // The pattern geometry lives behind `findRoute`, which nothing else on the
  // Go Mode screen dispatches. findRouteIfNeeded is itself the cache: it
  // returns early once the route has patterns or a request in flight
  // (lib/actions/api.js), so this costs one query per transit leg per trip.
  useEffect(() => {
    routeIds.forEach((routeId) => fetchRoute({ routeId }))
  }, [routeIds, fetchRoute])

  const geojson = useMemo((): GeoJSON.FeatureCollection | null => {
    if (!visible) return null
    const shapes = riddenPatternShapes(riddenPatterns(itinerary, routes))
    if (!shapes.length) return null
    try {
      return {
        features: shapes.map((shape) => ({
          geometry: polyline.toGeoJSON(shape.points),
          properties: { color: shape.color || DEFAULT_ROUTE_COLOR },
          type: 'Feature' as const
        })),
        type: 'FeatureCollection'
      }
    } catch (error) {
      return null
    }
  }, [visible, itinerary, routes])

  if (!geojson) return <></>

  return (
    <Source data={geojson} id="ridden-route-shape-source" type="geojson">
      <Layer
        id="ridden-route-shape"
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        paint={{
          'line-color': ['get', 'color'],
          'line-opacity': RIDDEN_SHAPE_OPACITY,
          'line-width': 4
        }}
        type="line"
      />
    </Source>
  )
}

const mapStateToProps = (state: AppReduxState) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { config, goMode, transitIndex } = state.otp as any
  const enabled = config?.map?.goMode?.fullRouteShape !== false
  const itinerary = goMode?.isActive ? goMode?.activeItinerary ?? null : null
  return {
    itinerary,
    routes: transitIndex?.routes ?? null,
    visible: !!(enabled && itinerary)
  }
}

const mapDispatchToProps = { findRouteIfNeeded }

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(RiddenRouteShapeOverlay)
