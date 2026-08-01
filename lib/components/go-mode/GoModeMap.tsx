import {
  Layer,
  Marker,
  Source,
  useControl,
  useMap
} from 'react-map-gl/maplibre'
import { useIntl } from 'react-intl'
import polyline from '@mapbox/polyline'
import React, { useEffect, useMemo, useRef } from 'react'
import styled, { keyframes } from 'styled-components'
import type { IControl } from 'maplibre-gl'
import type { Itinerary } from '@opentripplanner/types'

import {
  decideFollowCamera,
  FOLLOW_EASE_MS,
  FOLLOW_ENGAGE_DELAY_MS,
  isTransitLegMode
} from '../../util/go-mode/follow-camera'
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
  currentLegMode: string | null
  currentPosition: GeolocationPosition | null
  followUser: boolean
  itinerary: Itinerary
  onSetFollow: (value: boolean) => void
  onToggleFollow: () => void
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

// Google Maps-style navigation arrow, drawn to sit centered in maplibre's
// native 29x29 control button. Fill is swapped imperatively by setActive.
const FOLLOW_ARROW_SVG =
  '<svg width="29" height="29" viewBox="0 0 29 29" xmlns="http://www.w3.org/2000/svg" fill="#333333" style="display:block"><path d="M14.5 5.5L22 23l-7.5-3.6L7 23z"/></svg>'

/**
 * Follow-toggle button as a native MapLibre control: it stacks in a
 * `maplibregl-ctrl-group` beneath the existing locate crosshair (top-left) and
 * inherits the exact button chrome the other map controls have. The DOM is
 * imperative (IControl contract), so active state and label are synced from
 * React via setActive/setLabel.
 */
class FollowButtonControl implements IControl {
  button: HTMLButtonElement | null = null
  container: HTMLDivElement | null = null
  private readonly handleClick: () => void

  constructor(handleClick: () => void) {
    this.handleClick = handleClick
  }

  onAdd(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group'
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-testid', 'go-mode-follow-toggle')
    button.setAttribute('aria-pressed', 'false')
    button.innerHTML = FOLLOW_ARROW_SVG
    button.addEventListener('click', this.handleClick)
    container.appendChild(button)
    this.button = button
    this.container = container
    return container
  }

  onRemove(): void {
    this.button?.removeEventListener('click', this.handleClick)
    this.container?.remove()
    this.button = null
    this.container = null
  }

  setActive(active: boolean): void {
    if (!this.button) return
    this.button.setAttribute('aria-pressed', active ? 'true' : 'false')
    // MapLibre's own geolocate-active blue, so engaged reads the same as the
    // native controls' active states.
    const svg = this.button.querySelector('svg')
    if (svg) svg.setAttribute('fill', active ? '#33b5e5' : '#333333')
  }

  setLabel(label: string): void {
    if (!this.button) return
    this.button.setAttribute('aria-label', label)
    this.button.title = label
  }
}

const FollowToggleControl = ({
  active,
  onToggle
}: {
  active: boolean
  onToggle: () => void
}) => {
  const intl = useIntl()
  // useControl constructs the control exactly once; route clicks through a
  // ref so the latest handler is always the one invoked.
  const onToggleRef = useRef(onToggle)
  onToggleRef.current = onToggle
  const control = useControl<FollowButtonControl>(
    () => new FollowButtonControl(() => onToggleRef.current()),
    { position: 'top-left' }
  )
  const label = intl.formatMessage({
    defaultMessage: 'Follow my location',
    id: 'components.GoMode.followToggle'
  })
  useEffect(() => {
    control.setActive(active)
    control.setLabel(label)
  }, [control, active, label])
  return null
}

/**
 * Overlay component rendered inside the map context.
 * Uses useMap() hook to access the map for panning and renders
 * Source/Layer/Marker as map children via the react-map-gl context.
 */
const GoModeMapOverlay = ({
  activeLegIndex,
  currentLegMode,
  currentPosition,
  followUser,
  onSetFollow,
  onToggleFollow,
  routeGeoJson
}: {
  activeLegIndex: number | null
  currentLegMode: string | null
  currentPosition: GeolocationPosition | null
  followUser: boolean
  onSetFollow: (value: boolean) => void
  onToggleFollow: () => void
  routeGeoJson: GeoJSON.FeatureCollection | null
}) => {
  const { current: map } = useMap()
  const hasFitBounds = useRef(false)
  const fitBoundsAt = useRef(0)
  const prevFollowUser = useRef(followUser)
  // Follow-camera memory (see decideFollowCamera): last fix the camera
  // accepted, the once-rejected spike awaiting confirmation, and the leg type
  // the current zoom was chosen for.
  const prevAccepted = useRef<{
    lat: number
    lng: number
    timestampMs: number
  } | null>(null)
  const prevRejectedSpike = useRef<{ lat: number; lng: number } | null>(null)
  const prevLegTransit = useRef<boolean | null>(null)

  // Fit map to itinerary bounds on initial load
  useEffect(() => {
    if (hasFitBounds.current || !map || !routeGeoJson) return
    const bounds = bboxOf(routeGeoJson.features)
    if (bounds) {
      map.fitBounds(bounds, { duration: 600, padding: 40 })
      hasFitBounds.current = true
      // The follow camera waits FOLLOW_ENGAGE_DELAY_MS from here so this
      // trip-overview animation is never cut off mid-flight.
      fitBoundsAt.current = Date.now()
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
      // Explicit camera intent wins over follow: the button visibly reads
      // off, and one tap brings follow back.
      onSetFollow(false)
    }
  }, [activeLegIndex, map, routeGeoJson, onSetFollow])

  // A user gesture that moves the camera means the rider wants to look at
  // something — stop following (idempotent SET, so a drag never races the
  // button's toggle). Zoom is deliberately NOT wired: Google behavior is that
  // pinching adjusts zoom while still following, and per-fix eases omit zoom
  // so the chosen level sticks. Programmatic moves (fitBounds/easeTo) fire
  // neither handler.
  useEffect(() => {
    if (!map) return
    // dragstart fires only for user gestures (1- and 2-finger pan).
    const handleDragStart = () => onSetFollow(false)
    // rotatestart also fires for programmatic rotations; originalEvent marks
    // a real gesture.
    const handleRotateStart = (e: { originalEvent?: Event }) => {
      if (e.originalEvent) onSetFollow(false)
    }
    map.on('dragstart', handleDragStart)
    map.on('rotatestart', handleRotateStart)
    // reuseMaps (default-map.tsx) keeps this map instance alive across
    // remounts — without the symmetric off(), every background/return cycle
    // would stack another listener.
    return () => {
      map.off('dragstart', handleDragStart)
      map.off('rotatestart', handleRotateStart)
    }
  }, [map, onSetFollow])

  // Live follow (7/29 rider request): ease the camera to each accepted fix,
  // Google Maps style. All accept/reject/zoom decisions live in the pure
  // decideFollowCamera; this effect only executes them.
  useEffect(() => {
    const justEnabled = followUser && !prevFollowUser.current
    prevFollowUser.current = followUser
    if (justEnabled) {
      // Re-engage via the button eases to the current fix at leg zoom right
      // away (a fresh engage) instead of waiting for the next GPS tick.
      prevAccepted.current = null
      prevRejectedSpike.current = null
    }
    if (!followUser || !map || !currentPosition) return
    // Belt-and-braces on top of the leg-tap disengage: while a tapped leg is
    // selected its fitBounds owns the camera.
    if (activeLegIndex != null) return
    // Let the initial trip-overview fit land first.
    if (
      !hasFitBounds.current ||
      Date.now() - fitBoundsAt.current < FOLLOW_ENGAGE_DELAY_MS
    ) {
      return
    }
    const { coords, timestamp } = currentPosition
    const decision = decideFollowCamera({
      fix: {
        accuracyM: coords.accuracy ?? null,
        lat: coords.latitude,
        lng: coords.longitude,
        timestampMs: timestamp
      },
      legMode: currentLegMode,
      prevAccepted: prevAccepted.current,
      prevLegTransit: prevLegTransit.current,
      prevRejectedSpike: prevRejectedSpike.current
    })
    if (decision.move && decision.center) {
      // No `essential: true` — prefers-reduced-motion degrades the ease to a
      // jump, which is the right call for a camera that moves every second.
      map.easeTo({
        center: decision.center,
        duration: FOLLOW_EASE_MS,
        ...(decision.zoom != null && { zoom: decision.zoom })
      })
      prevAccepted.current = {
        lat: coords.latitude,
        lng: coords.longitude,
        timestampMs: timestamp
      }
      prevRejectedSpike.current = null
      prevLegTransit.current = isTransitLegMode(currentLegMode)
    } else if (decision.reason === 'spike-rejected') {
      prevRejectedSpike.current = {
        lat: coords.latitude,
        lng: coords.longitude
      }
    }
  }, [currentPosition, followUser, activeLegIndex, map, currentLegMode])

  return (
    <>
      {/* Follow toggle, stacked under the locate crosshair */}
      <FollowToggleControl active={followUser} onToggle={onToggleFollow} />

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
          <UserDot data-testid="go-mode-user-dot" />
        </Marker>
      )}
    </>
  )
}

const GoModeMap = ({
  activeLegIndex,
  currentLegIndex,
  currentLegMode,
  currentPosition,
  followUser,
  itinerary,
  onSetFollow,
  onToggleFollow,
  routeMatch
}: Props) => {
  // Two-tick smoothing for the deviation banner, symmetric with the
  // notification-side input (prevDistanceFromRoute in actions/go-mode): a
  // single off-route GPS spike used to flash "5246m from route" over the map
  // (7/29). Show only when the previous tick was also off-route, and show the
  // smaller of the two distances.
  const prevOffRouteDistanceRef = useRef<number | null>(null)
  const prevOffRouteDistance = prevOffRouteDistanceRef.current
  useEffect(() => {
    prevOffRouteDistanceRef.current =
      routeMatch && !routeMatch.isOnRoute ? routeMatch.distanceFromRoute : null
  }, [routeMatch])

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
          currentLegMode={currentLegMode}
          currentPosition={currentPosition}
          followUser={followUser}
          onSetFollow={onSetFollow}
          onToggleFollow={onToggleFollow}
          routeGeoJson={routeGeoJson}
        />
      </DefaultMap>

      {/* Deviation Warning */}
      {routeMatch && !routeMatch.isOnRoute && prevOffRouteDistance != null && (
        <DeviationWarning>
          {intl.formatMessage(
            {
              defaultMessage: '{distance}m from route',
              id: 'components.GoMode.deviationWarning'
            },
            { distance: Math.round(Math.min(routeMatch.distanceFromRoute, prevOffRouteDistance)) }
          )}
        </DeviationWarning>
      )}
    </MapContainer>
  )
}

export default GoModeMap
