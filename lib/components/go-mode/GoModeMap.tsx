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
  currentLegIndex: number
  currentPosition: GeolocationPosition | null
  followUser: boolean
  itinerary: Itinerary
  routeMatch: RouteMatchResult | null
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
  currentLegIndex,
  currentPosition,
  followUser,
  routeGeoJson
}: {
  currentLegIndex: number
  currentPosition: GeolocationPosition | null
  followUser: boolean
  routeGeoJson: GeoJSON.FeatureCollection | null
}) => {
  const { current: map } = useMap()
  const hasFitBounds = useRef(false)

  // Fit map to itinerary bounds on initial load
  useEffect(() => {
    if (hasFitBounds.current || !map || !routeGeoJson) return

    // Compute bounding box from all GeoJSON coordinates
    let minLng = Infinity
    let minLat = Infinity
    let maxLng = -Infinity
    let maxLat = -Infinity

    for (const feature of routeGeoJson.features) {
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

    if (minLng !== Infinity) {
      map.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat]
        ],
        { duration: 600, padding: 40 }
      )
      hasFitBounds.current = true
    }
  }, [map, routeGeoJson])

  // Center map on user position when followUser is enabled
  useEffect(() => {
    if (followUser && currentPosition && map) {
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
              'line-opacity': ['case', ['get', 'isCompleted'], 0.3, 0.9],
              'line-width': 5
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
              'line-opacity': ['case', ['get', 'isCompleted'], 0.3, 0.8],
              'line-width': 4
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
  currentLegIndex,
  currentPosition,
  followUser,
  itinerary,
  routeMatch
}: Props) => {
  // Build GeoJSON for route overlay, with per-leg styling properties
  const routeGeoJson = useMemo((): GeoJSON.FeatureCollection | null => {
    if (!itinerary?.legs) return null
    try {
      const features: GeoJSON.Feature[] = itinerary.legs
        .filter((leg) => leg.legGeometry?.points)
        .map((leg, index) => ({
          geometry: polyline.toGeoJSON(leg.legGeometry.points),
          properties: {
            color: getLegColor(leg),
            index,
            isCompleted: index < currentLegIndex,
            isWalk: isWalkLike(leg.mode)
          },
          type: 'Feature' as const
        }))
      return { features, type: 'FeatureCollection' }
    } catch {
      return null
    }
  }, [itinerary, currentLegIndex])

  return (
    <MapContainer>
      <DefaultMap>
        {/* Map overlays rendered inside BaseMap's react-map-gl context */}
        <GoModeMapOverlay
          currentLegIndex={currentLegIndex}
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
