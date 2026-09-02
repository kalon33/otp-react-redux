import { connect } from 'react-redux'
import { Itinerary } from '@opentripplanner/types'
import { Layer } from 'react-map-gl/maplibre'
import React, { useMemo } from 'react'
import type { FilterSpecification } from 'maplibre-gl'

import { AppReduxState } from '../../util/state-types'
import { DEFAULT_ROUTE_COLOR } from '../util/colors'
import {
  riddenPatterns,
  riddenPatternStopIds
} from '../../util/go-mode/ridden-pattern'

/**
 * Rider ask #38 / #21, first half, finished: every stop on the line stays on
 * the map, and the stops of the pattern the rider is actually riding are drawn
 * larger and in the route's colour so they stand out from the rest.
 *
 * Why this is a hand-written layer and not a prop on the tile overlay:
 * `@opentripplanner/otp2-tile-overlay` has exactly one hook for picking stops,
 * `stopsWhitelist`, and it does not emphasise — it REPLACES the filter on
 * every layer of the call (`lib/index.js`:
 * `if (stopsWhitelist) { filter = ["in", ["get","gtfsId"], ["literal", stopsWhitelist]] }`)
 * and drops minzoom to 2, so using it during a trip would leave ONLY the
 * ridden pattern's stops on the map — the opposite of what was asked for. Nor
 * can a second `otp2` layer of `type: 'stops'` be added to the config: the
 * library derives each layer's id from its type, so two would collide on the
 * id "stops", and the tilejson path it builds is the joined type list, which
 * would become `stops,stops,stations`.
 *
 * So this mounts an ADDITIONAL maplibre circle layer against the source the
 * library already created (`otp2-tiles`, source layer `stops`), filtered to
 * the ridden pattern's stop ids. Every other stop keeps its own paint and
 * stays visible. Referencing a source this component does not own is safe:
 * react-map-gl's `createLayer` skips the `addLayer` when `map.getSource()`
 * returns nothing and re-runs on every `styledata` event, so the layer appears
 * as soon as the tile overlay's source does, and simply never appears when the
 * stops overlay is not configured.
 *
 * Off with `map.goMode.emphasizeRouteStops: false`.
 */

/** The source and source layer @opentripplanner/otp2-tile-overlay creates. */
export const OTP2_TILE_SOURCE_ID = 'otp2-tiles'
export const OTP2_STOPS_SOURCE_LAYER = 'stops'

/**
 * The zoom the OTP server serves stops from (router-config.json gives stops
 * minZoom 14). Matching it keeps the emphasis from being the only stop mark on
 * the map at low zoom, where the tile layer draws nothing.
 */
export const RIDDEN_STOPS_MIN_ZOOM = 14

interface RiddenStopsLayerProps {
  filter: FilterSpecification
  minzoom: number
  paint: Record<string, unknown>
}

/**
 * The maplibre layer this draws, as data — so a test can assert the filter
 * emphasises rather than whitelists without needing WebGL.
 */
export function riddenStopsLayerProps(
  stopIds: string[],
  color: string | null
): RiddenStopsLayerProps {
  return {
    // An `in` over the ridden pattern's ids. It is an ADDITIONAL layer, so it
    // narrows nothing: the tile overlay's own stops layer is untouched.
    filter: [
      'in',
      ['get', 'gtfsId'],
      ['literal', stopIds]
    ] as FilterSpecification,
    minzoom: RIDDEN_STOPS_MIN_ZOOM,
    paint: {
      // A ring, not a disc: the tile layer's own circle (radius 5, white,
      // #333 stroke) stays readable in the middle of it.
      'circle-color': 'transparent',
      'circle-opacity': 0,
      'circle-radius': 9,
      'circle-stroke-color': color || DEFAULT_ROUTE_COLOR,
      'circle-stroke-opacity': 0.9,
      'circle-stroke-width': 3
    }
  }
}

interface Props {
  itinerary: Itinerary | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  routes: Record<string, any> | null
  visible: boolean
}

const RiddenRouteStopsOverlay = ({
  itinerary,
  routes,
  visible
}: Props): JSX.Element => {
  const emphasis = useMemo(() => {
    if (!visible) return null
    const patterns = riddenPatterns(itinerary, routes)
    const stopIds = riddenPatternStopIds(patterns)
    if (!stopIds.length) return null
    return riddenStopsLayerProps(
      stopIds,
      patterns.find((p) => !!p.color)?.color ?? null
    )
  }, [visible, itinerary, routes])

  if (!emphasis) return <></>

  return (
    <Layer
      filter={emphasis.filter}
      id="ridden-route-stops"
      minzoom={emphasis.minzoom}
      paint={emphasis.paint}
      source={OTP2_TILE_SOURCE_ID}
      source-layer={OTP2_STOPS_SOURCE_LAYER}
      type="circle"
    />
  )
}

const mapStateToProps = (state: AppReduxState) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { config, goMode, transitIndex } = state.otp as any
  const enabled = config?.map?.goMode?.emphasizeRouteStops !== false
  const itinerary = goMode?.isActive ? goMode?.activeItinerary ?? null : null
  return {
    itinerary,
    routes: transitIndex?.routes ?? null,
    visible: !!(enabled && itinerary)
  }
}

export default connect(mapStateToProps)(RiddenRouteStopsOverlay)
