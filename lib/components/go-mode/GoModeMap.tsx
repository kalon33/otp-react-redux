import { Layer, Marker, Source, useMap } from 'react-map-gl/maplibre'
import polyline from '@mapbox/polyline'
import React, { useEffect, useMemo, useRef } from 'react'
import styled, { keyframes } from 'styled-components'
import type { Itinerary } from '@opentripplanner/types'

import DefaultMap from '../map/default-map'
import type { RouteMatchResult } from '../../util/go-mode/position-matching'

import { DeviationWarning, MapContainer } from './styled'

const pulseGlow = keyframes`
  0% {
    box-shadow: 0 0 0 0 rgba(33, 150, 243, 0.7);
  }
  70% {
    box-shadow: 0 0 0 15px rgba(33, 150, 243, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(33, 150, 243, 0);
  }
`

const UserDot = styled.div`
  animation: ${pulseGlow} 2s infinite;
  background-color: #2196f3;
  border: 3px solid white;
  border-radius: 50%;
  box-shadow: 0 0 10px rgba(33, 150, 243, 0.5);
  height: 20px;
  width: 20px;
`

interface Props {
  activeLegIndex: number | null
  currentLegIndex: number
  currentPosition: GeolocationPosition | null
  followUser: boolean
  itinerary: Itinerary
  routeMatch: RouteMatchResult | null
}

/**
 * Bounding box of every LineString in a set of features, as maplibre's
 * [[minLng, minLat], [maxLng, maxLat]], or null when there's nothing to fit.
 */
function bboxOf(
  features: GeoJSON.Feature[]
): [[number, number], [number, number]] | null {
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const feature of features) {
    const geom = feature.geometry
    if (geom.type === 'LineString') {
      for (const coord of geom.coordinates) {
        const [lng, lat] = coord
        if (lng < minLng) minLng = lng
        if (lng > maxLng) maxLng = lng
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
      }
    }
  }
  if (minLng === Infinity) return null
  return [
    [minLng, minLat],
    [maxLng, maxLat]
  ]
}

/**
 * Get a line color for a given leg mode, with optional route color.
 */
function getLegColor(leg: { mode: string; routeColor?: string }): string {
  if (leg.routeColor) return `#${leg.routeColor.replace(/^#/, '')}`
  switch (leg.mode) {
    case 'BUS':
      return '#1565C0'
    case 'RAIL':
    case 'SUBWAY':
      return '#B71C1C'
    case 'TRAM':
      return '#00695C'
    case 'FERRY':
      return '#0277BD'
    case 'BICYCLE':
      return '#2E7D32'
    case 'WALK':
    default:
      return '#757575'
  }
}

function isWalkLike(mode: string): boolean {
  return mode === 'WALK' || mode === 'BICYCLE'
}

/**
 * Overlay component rendered inside the map context.
 * Uses useMap() hook to access the map for panning and renders
 * Source/Layer/Marker as map children via the react-map-gl context.
 */
const GoModeMapOverlay = ({
  activeLegIndex,
  currentPosition,
  followUser,
  routeGeoJson
}: {
  activeLegIndex: number | null
  currentPosition: GeolocationPosition | null
  followUser: boolean
  routeGeoJson: GeoJSON.FeatureCollection | null
}) => {
  const { current: map } = useMap()
  const hasFitBounds = useRef(false)
  const prevFollowUser = useRef(followUser)

  // Fit map to itinerary bounds on initial load
  useEffect(() => {
    if (hasFitBounds.current || !map || !routeGeoJson) return
    const bounds = bboxOf(routeGeoJson.features)
    if (bounds) {
      map.fitBounds(bounds, { duration: 600, padding: 40 })
      hasFitBounds.current = true
    }
  }, [map, routeGeoJson])

  // Tapping a leg in the trip sheet zooms to it, the same way tapping a leg in
  // the planner's itinerary does. Clearing the selection leaves the map where
  // it is rather than yanking back out — the rider chose that view.
  useEffect(() => {
    if (activeLegIndex == null || !map || !routeGeoJson) return
    const feature = routeGeoJson.features.find(
      (f) => f.properties?.index === activeLegIndex
    )
    const bounds = feature && bboxOf([feature])
    // maxZoom: a 200 m walk leg has a tiny bbox and would otherwise slam the
    // map to max zoom, where the rider can see the leg but none of its context.
    if (bounds) {
      map.fitBounds(bounds, { duration: 600, maxZoom: 16, padding: 40 })
    }
  }, [activeLegIndex, map, routeGeoJson])

  // Recenter on the user's position only as a one-shot when followUser is
  // *newly* enabled (i.e. the user pressed the locate button). We intentionally
  // do NOT pan on every position update — that made the map fight the user by
  // constantly yanking the view back to the live GPS point. Ongoing recentering
  // is handled by the map's built-in geolocate (blue dot) control.
  useEffect(() => {
    const justEnabled = followUser && !prevFollowUser.current
    prevFollowUser.current = followUser
    if (justEnabled && currentPosition && map) {
      map.panTo([
        currentPosition.coords.longitude,
        currentPosition.coords.latitude
      ])
    }
  }, [currentPosition, followUser, map])

  return (
    <>
      {/* Route Overlay */}
      {routeGeoJson && (
        <Source data={routeGeoJson} id="go-mode-route" type="geojson">
          {/* Solid transit legs */}
          <Layer
            filter={['!', ['get', 'isWalk']]}
            id="go-mode-route-transit"
            layout={{
              'line-cap': 'round',
              'line-join': 'round'
            }}
            paint={{
              'line-color': ['get', 'color'],
              // A tapped leg always reads as fully present, even if completed.
              'line-opacity': [
                'case',
                ['get', 'isActive'],
                1,
                ['get', 'isCompleted'],
                0.3,
                0.9
              ],
              'line-width': ['case', ['get', 'isActive'], 8, 5]
            }}
            type="line"
          />
          {/* Dashed walk/bike legs */}
          <Layer
            filter={['get', 'isWalk']}
            id="go-mode-route-walk"
            layout={{
              'line-cap': 'round',
              'line-join': 'round'
            }}
            paint={{
              'line-color': ['get', 'color'],
              'line-dasharray': [2, 2],
              'line-opacity': [
                'case',
                ['get', 'isActive'],
                1,
                ['get', 'isCompleted'],
                0.3,
                0.8
              ],
              'line-width': ['case', ['get', 'isActive'], 7, 4]
            }}
            type="line"
          />
        </Source>
      )}

      {/* User Position Marker */}
      {currentPosition && (
        <Marker
          latitude={currentPosition.coords.latitude}
          longitude={currentPosition.coords.longitude}
        >
          <UserDot />
        </Marker>
      )}
    </>
  )
}

const GoModeMap = ({
  activeLegIndex,
  currentLegIndex,
  currentPosition,
  followUser,
  itinerary,
  routeMatch
}: Props) => {
  // Build GeoJSON for route overlay, with per-leg styling properties.
  // `index` is the ORIGINAL leg index (legs without geometry are dropped), so
  // an active-leg lookup by index stays correct.
  const routeGeoJson = useMemo((): GeoJSON.FeatureCollection | null => {
    if (!itinerary?.legs) return null
    try {
      const features: GeoJSON.Feature[] = itinerary.legs
        .map((leg, index) => ({ index, leg }))
        .filter(({ leg }) => leg.legGeometry?.points)
        .map(({ index, leg }) => ({
          geometry: polyline.toGeoJSON(leg.legGeometry.points),
          properties: {
            color: getLegColor(leg),
            index,
            isActive: index === activeLegIndex,
            isCompleted: index < currentLegIndex,
            isWalk: isWalkLike(leg.mode)
          },
          type: 'Feature' as const
        }))
      return { features, type: 'FeatureCollection' }
    } catch {
      return null
    }
  }, [itinerary, currentLegIndex, activeLegIndex])

  return (
    <MapContainer>
      <DefaultMap>
        {/* Map overlays rendered inside BaseMap's react-map-gl context */}
        <GoModeMapOverlay
          activeLegIndex={activeLegIndex}
          currentPosition={currentPosition}
          followUser={followUser}
          routeGeoJson={routeGeoJson}
        />
      </DefaultMap>

      {/* Deviation Warning */}
      {routeMatch && !routeMatch.isOnRoute && (
        <DeviationWarning>
          {Math.round(routeMatch.distanceFromRoute)}m from route
        </DeviationWarning>
      )}
    </MapContainer>
  )
}

export default GoModeMap
