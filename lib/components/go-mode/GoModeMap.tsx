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
import type { Itinerary, Leg } from '@opentripplanner/types'

import {
  buildTurnGeometry,
  clampTurnZoom,
  shouldShowTurnView,
  TURN_ARROW_CASING,
  TURN_ARROW_COLOR,
  TURN_VIEW_MAX_ZOOM,
  TURN_VIEW_PADDING_PX,
  turnGeoJson,
  turnViewBounds
} from '../../util/go-mode/turn-view'
import {
  decideFollowCamera,
  FOLLOW_EASE_MS,
  FOLLOW_ENGAGE_DELAY_MS,
  FOLLOW_ZOOM_ACCESS,
  FOLLOW_ZOOM_TRANSIT,
  isTransitLegMode
} from '../../util/go-mode/follow-camera'
import DefaultMap from '../map/default-map'
import type { RouteMatchResult } from '../../util/go-mode/position-matching'
import type { StepCue } from '../../util/go-mode/turn-by-turn'

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
  /**
   * The rider is aboard the bus this leg belongs to and has not reached the
   * stop it starts at — `aboardBeforeLegStart`, util/go-mode/riding.
   *
   * On 2026-09-21 ride 2 the onboard splice anchored the bus leg at the
   * vehicle's NEXT stop, 66th St, while the rider was 2.58 km north of it on
   * I-35W. The map drew the orange line starting 2 km ahead of the dot and
   * this banner read "2379m from route" — under a header saying "On Bus
   * #8228". Backlog 22.1.
   */
  aboardBeforeLeg?: boolean
  activeLegIndex: number | null
  /** Trip over (goMode.arrivedAt set): no turn to show (44.3). */
  arrived?: boolean
  currentLegIndex: number
  currentLegMode: string | null
  currentPosition: GeolocationPosition | null
  /** Metres to `nextTurnCue` (progress.distanceToNextTurn). */
  distanceToNextTurn?: number | null
  followUser: boolean
  itinerary: Itinerary
  /** The turn the card is announcing (progress.nextTurnCue), 44.3. */
  nextTurnCue?: StepCue | null
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

// Engaged/disengaged treatment for the follow toggle (backlog 21.4). The
// engaged look is a SOLID fill with a white arrow, deliberately not MapLibre's
// own active tint (#33b5e5, which only recolours the glyph on a white button):
// the rider read the tinted arrow as a second copy of the native locate
// crosshair stacked above it. Filled-vs-empty is the toggle affordance; the
// colour is the app's transit blue, not MapLibre's.
export const FOLLOW_ACTIVE_BG = '#1565c0'
export const FOLLOW_ACTIVE_ARROW = '#ffffff'
export const FOLLOW_IDLE_ARROW = '#333333'
export const FOLLOW_CLASS_ACTIVE =
  'go-mode-follow-toggle go-mode-follow-toggle--following'
export const FOLLOW_CLASS_IDLE =
  'go-mode-follow-toggle go-mode-follow-toggle--idle'

/**
 * Follow-toggle button as a native MapLibre control: it stacks in a
 * `maplibregl-ctrl-group` beneath the existing locate crosshair (top-left) and
 * inherits the exact button chrome the other map controls have. The DOM is
 * imperative (IControl contract), so active state and label are synced from
 * React via setActive/setLabel.
 */
export class FollowButtonControl implements IControl {
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
    button.className = FOLLOW_CLASS_IDLE
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
    // The button itself carries the state, not just the glyph: engaged is a
    // filled blue chip with a white arrow, disengaged the plain white control
    // chrome with a dark arrow. Neither is MapLibre's #33b5e5 active tint.
    this.button.className = active ? FOLLOW_CLASS_ACTIVE : FOLLOW_CLASS_IDLE
    this.button.style.backgroundColor = active ? FOLLOW_ACTIVE_BG : ''
    const svg = this.button.querySelector('svg')
    if (svg) {
      svg.setAttribute('fill', active ? FOLLOW_ACTIVE_ARROW : FOLLOW_IDLE_ARROW)
    }
  }

  setLabel(label: string): void {
    if (!this.button) return
    this.button.setAttribute('aria-label', label)
    this.button.title = label
  }
}

// Exported for unit tests: the label the rider sees is asserted without a
// live MapLibre instance.
export const FollowToggleControl = ({
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
  // The label says which state the button is IN, so the tooltip and the
  // screen-reader name disambiguate it from the native locate control that
  // used to sit above it (backlog 21.4). Both are formatted unconditionally so
  // formatjs can extract them.
  const followingLabel = intl.formatMessage({
    defaultMessage: 'Following you',
    id: 'components.GoMode.followToggleOn'
  })
  const followLabel = intl.formatMessage({
    defaultMessage: 'Follow me',
    id: 'components.GoMode.followToggleOff'
  })
  const label = active ? followingLabel : followLabel
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
export const GoModeMapOverlay = ({
  activeLegIndex,
  arrived = false,
  currentLeg,
  currentLegMode,
  currentPosition,
  distanceToNextTurn,
  followUser,
  nextTurnCue,
  onSetFollow,
  onToggleFollow,
  routeGeoJson
}: {
  activeLegIndex: number | null
  arrived?: boolean
  currentLeg?: Leg | null
  currentLegMode: string | null
  currentPosition: GeolocationPosition | null
  distanceToNextTurn?: number | null
  followUser: boolean
  nextTurnCue?: StepCue | null
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
  // Turn view (44.3): the cue the camera is turned to (null = north-up
  // follow), and whether the map was left rotated so release knows to undo it.
  const turnViewCueIndex = useRef<number | null>(null)
  const turnViewRotated = useRef(false)

  // The next corner as something to draw, cut from the leg's own polyline.
  // Drawn whenever the card has a turn on a walk/bike leg — the camera only
  // turns to it when it is close (shouldShowTurnView).
  const showTurn =
    !arrived &&
    !!nextTurnCue &&
    (currentLegMode === 'WALK' || currentLegMode === 'BICYCLE')
  const cueOffset = nextTurnCue?.offsetMeters
  const cueLat = nextTurnCue?.lat
  const cueLon = nextTurnCue?.lon
  const turnGeometry = useMemo(
    () =>
      showTurn && cueOffset != null && cueLat != null && cueLon != null
        ? buildTurnGeometry(currentLeg, {
            lat: cueLat,
            lon: cueLon,
            offsetMeters: cueOffset
          })
        : null,
    [showTurn, currentLeg, cueOffset, cueLat, cueLon]
  )
  const turnData = useMemo(() => turnGeoJson(turnGeometry), [turnGeometry])

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
    const acceptFix = () => {
      prevAccepted.current = {
        lat: coords.latitude,
        lng: coords.longitude,
        timestampMs: timestamp
      }
      prevRejectedSpike.current = null
      prevLegTransit.current = isTransitLegMode(currentLegMode)
    }
    if (decision.reason === 'spike-rejected') {
      prevRejectedSpike.current = {
        lat: coords.latitude,
        lng: coords.longitude
      }
    }

    // Turn view (44.3, rider "Both", 2026-10-08): with the next corner close,
    // the camera frames the rider and the drawn turn, rotated so the street
    // into the corner points up the screen. One bearing per turn (the
    // route's, not the fix's heading), so the map turns once per corner.
    const turnView =
      !!turnGeometry &&
      shouldShowTurnView({
        arrived,
        cue: nextTurnCue,
        distanceToNextTurn,
        engagedCueIndex: turnViewCueIndex.current,
        legMode: currentLegMode
      })
    if (turnView && turnGeometry && nextTurnCue) {
      const cueChanged = turnViewCueIndex.current !== nextTurnCue.index
      // A stationary rider (dead-band) keeps the frame it has; a rejected
      // fix frames from the last good one.
      if (!cueChanged && !decision.move) return
      const rider = decision.move
        ? { lat: coords.latitude, lng: coords.longitude }
        : prevAccepted.current
      const camera = map.cameraForBounds(turnViewBounds(turnGeometry, rider), {
        bearing: turnGeometry.approachBearing,
        maxZoom: TURN_VIEW_MAX_ZOOM,
        padding: TURN_VIEW_PADDING_PX
      })
      if (!camera) return
      map.easeTo({
        bearing: turnGeometry.approachBearing,
        center: camera.center,
        duration: FOLLOW_EASE_MS,
        zoom: clampTurnZoom(camera.zoom)
      })
      turnViewCueIndex.current = nextTurnCue.index
      turnViewRotated.current = true
      if (decision.move) acceptFix()
      return
    }
    turnViewCueIndex.current = null

    // Leaving the turn view: back to plain north-up follow at the leg's
    // zoom, in one ease, even if the rider has not moved since.
    if (turnViewRotated.current) {
      const rider = decision.move
        ? { lat: coords.latitude, lng: coords.longitude }
        : prevAccepted.current
      if (rider) {
        map.easeTo({
          bearing: 0,
          center: [rider.lng, rider.lat],
          duration: FOLLOW_EASE_MS,
          zoom: isTransitLegMode(currentLegMode)
            ? FOLLOW_ZOOM_TRANSIT
            : FOLLOW_ZOOM_ACCESS
        })
        turnViewRotated.current = false
        if (decision.move) acceptFix()
        return
      }
    }

    if (decision.move && decision.center) {
      // No `essential: true` — prefers-reduced-motion degrades the ease to a
      // jump, which is the right call for a camera that moves every second.
      map.easeTo({
        center: decision.center,
        duration: FOLLOW_EASE_MS,
        ...(decision.zoom != null && { zoom: decision.zoom })
      })
      acceptFix()
    }
  }, [
    currentPosition,
    followUser,
    activeLegIndex,
    map,
    currentLegMode,
    arrived,
    nextTurnCue,
    distanceToNextTurn,
    turnGeometry
  ])

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

      {/* The next turn, drawn on the route (44.3): a white-cased blue
          stretch through the corner with an arrowhead on the exit. Above the
          route, below the rider's dot. */}
      {turnGeometry && (
        <Source data={turnData} id="go-mode-turn" type="geojson">
          <Layer
            filter={['==', ['get', 'part'], 'shaft']}
            id="go-mode-turn-casing"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': TURN_ARROW_CASING, 'line-width': 13 }}
            type="line"
          />
          <Layer
            filter={['==', ['get', 'part'], 'head']}
            id="go-mode-turn-head-casing"
            layout={{ 'line-join': 'round' }}
            paint={{ 'line-color': TURN_ARROW_CASING, 'line-width': 4 }}
            type="line"
          />
          <Layer
            filter={['==', ['get', 'part'], 'shaft']}
            id="go-mode-turn-shaft"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': TURN_ARROW_COLOR, 'line-width': 8 }}
            type="line"
          />
          <Layer
            filter={['==', ['get', 'part'], 'head']}
            id="go-mode-turn-head"
            paint={{ 'fill-color': TURN_ARROW_COLOR }}
            type="fill"
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
  aboardBeforeLeg = false,
  activeLegIndex,
  arrived = false,
  currentLegIndex,
  currentLegMode,
  currentPosition,
  distanceToNextTurn,
  followUser,
  itinerary,
  nextTurnCue,
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
    // The ridden leg, joined to the rider. While `aboardBeforeLeg` holds, the
    // leg's own geometry begins at a stop the bus has not reached, so drawn as
    // recorded it starts ahead of the dot with a gap between — the 2 km of
    // I-35W the rider's screenshot showed. Extending the SAME line back to the
    // fix closes it without touching the itinerary: the leg still ends where
    // it ends, and nothing downstream of the map reads this geometry.
    const ridingLegIndex = aboardBeforeLeg ? routeMatch?.legIndex ?? -1 : -1
    const riderPoint: [number, number] | null =
      currentPosition && ridingLegIndex >= 0
        ? [currentPosition.coords.longitude, currentPosition.coords.latitude]
        : null
    try {
      const features: GeoJSON.Feature[] = itinerary.legs
        .map((leg, index) => ({ index, leg }))
        .filter(({ leg }) => leg.legGeometry?.points)
        .map(({ index, leg }) => {
          const geometry = polyline.toGeoJSON(leg.legGeometry.points)
          if (
            riderPoint &&
            index === ridingLegIndex &&
            geometry.type === 'LineString'
          ) {
            geometry.coordinates = [riderPoint, ...geometry.coordinates]
          }
          return {
            geometry,
            properties: {
              color: getLegColor(leg),
              index,
              isActive: index === activeLegIndex,
              isCompleted: index < currentLegIndex,
              isWalk: isWalkLike(leg.mode)
            },
            type: 'Feature' as const
          }
        })
      return { features, type: 'FeatureCollection' }
    } catch {
      return null
    }
  }, [
    itinerary,
    currentLegIndex,
    activeLegIndex,
    aboardBeforeLeg,
    currentPosition,
    routeMatch
  ])

  return (
    <MapContainer>
      <DefaultMap>
        {/* Map overlays rendered inside BaseMap's react-map-gl context */}
        <GoModeMapOverlay
          activeLegIndex={activeLegIndex}
          arrived={arrived}
          currentLeg={itinerary?.legs?.[currentLegIndex] ?? null}
          currentLegMode={currentLegMode}
          currentPosition={currentPosition}
          distanceToNextTurn={distanceToNextTurn}
          followUser={followUser}
          nextTurnCue={nextTurnCue}
          onSetFollow={onSetFollow}
          onToggleFollow={onToggleFollow}
          routeGeoJson={routeGeoJson}
        />
      </DefaultMap>

      {/* Deviation Warning — never while the rider is aboard and simply has
          not reached this leg's first stop yet (22.1). */}
      {routeMatch &&
        !routeMatch.isOnRoute &&
        !aboardBeforeLeg &&
        prevOffRouteDistance != null && (
          <DeviationWarning>
            {Math.round(
              Math.min(routeMatch.distanceFromRoute, prevOffRouteDistance)
            )}
            m from route
          </DeviationWarning>
        )}
    </MapContainer>
  )
}

export default GoModeMap
