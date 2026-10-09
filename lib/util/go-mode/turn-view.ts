import type { LatLngArray, Leg } from '@opentripplanner/types'

import {
  calculateCumulativeDistances,
  decodeLegGeometry
} from './position-matching'
import type { StepCue } from './turn-by-turn'

/**
 * turn-view.ts — the map half of backlog 44.3.
 *
 * Rider, 2026-10-08 18:04:32 (note `c-1791500672495`): "visual directions
 * instead of words on the bike routing". Asked which, they answered "Both":
 * a big arrow on the card, AND the map zooming and turning to the next corner
 * with the turn drawn on it. This module is the second half, kept pure so
 * every number is jest-testable; GoModeMap only executes what it decides.
 *
 * Why the camera's bearing comes from the ROUTE and not from the fix's
 * heading: follow-camera.ts stays north-up because heading is null when the
 * rider stops and noisy at walking speed, so heading-up at ~1 Hz is constant
 * micro-rotation. The bearing here is the leg's own geometry running INTO the
 * corner — one number per turn, so the map turns once as a corner comes up
 * and holds still until the next one.
 */

/**
 * How close the next turn has to be before the map turns to it, in metres.
 * About 40 s of riding at the 5 m/s the 10-08 rides cruised at, and about
 * 85 s of walking — enough to see the corner coming, short enough that the
 * map is not zoomed in on a street the rider is minutes from.
 */
export const TURN_VIEW_ENGAGE_BIKE_M = 200
export const TURN_VIEW_ENGAGE_WALK_M = 120
/**
 * Hysteresis: once engaged on a turn, it holds until the turn is this much
 * further away than the engage line, so a GPS wobble at 199/201 m does not
 * swing the map back and forth.
 */
export const TURN_VIEW_RELEASE_SLACK_M = 40
/** The turn drawn on the map: this much route before the corner… */
export const TURN_DRAW_BEFORE_M = 35
/** …and this much after it, ending in the arrowhead. */
export const TURN_DRAW_AFTER_M = 30
/** How far back up the route the camera's bearing is measured from. */
export const TURN_APPROACH_BASELINE_M = 50
/** Arrowhead length and width, metres on the ground. */
export const TURN_HEAD_LENGTH_M = 12
export const TURN_HEAD_WIDTH_M = 14
/** Zoom bounds for the turn view: street-level, never so close it loses the block. */
export const TURN_VIEW_MIN_ZOOM = 16
export const TURN_VIEW_MAX_ZOOM = 18
/** Screen padding around the framed turn, so the corner never sits on an edge. */
export const TURN_VIEW_PADDING_PX = 56

/** Colours of the drawn turn: the follow toggle's blue, with a white casing. */
export const TURN_ARROW_COLOR = '#1565c0'
export const TURN_ARROW_CASING = '#ffffff'

const EARTH_M_PER_DEG_LAT = 111_320

const toRad = (deg: number) => (deg * Math.PI) / 180
const toDeg = (rad: number) => (rad * 180) / Math.PI

/** Initial compass bearing from a to b, 0-360 (0 = north, 90 = east). */
export function bearingBetween(a: LatLngArray, b: LatLngArray): number {
  const [lat1, lon1] = a.map(toRad)
  const [lat2, lon2] = b.map(toRad)
  const dLon = lon2 - lon1
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

/** The point `meters` from `from` on `bearing` (flat-earth; fine for metres). */
export function offsetPoint(
  from: LatLngArray,
  bearing: number,
  meters: number
): LatLngArray {
  const b = toRad(bearing)
  const dLat = (meters * Math.cos(b)) / EARTH_M_PER_DEG_LAT
  const dLon =
    (meters * Math.sin(b)) / (EARTH_M_PER_DEG_LAT * Math.cos(toRad(from[0])))
  return [from[0] + dLat, from[1] + dLon]
}

/** The point `offset` metres along `polyline`, clamped to its ends. */
function pointAt(
  polyline: LatLngArray[],
  cumulative: number[],
  offset: number
): LatLngArray {
  const total = cumulative[cumulative.length - 1]
  const d = Math.max(0, Math.min(total, offset))
  for (let i = 1; i < polyline.length; i++) {
    if (cumulative[i] >= d) {
      const span = cumulative[i] - cumulative[i - 1]
      const t = span > 0 ? (d - cumulative[i - 1]) / span : 0
      const [la1, lo1] = polyline[i - 1]
      const [la2, lo2] = polyline[i]
      return [la1 + (la2 - la1) * t, lo1 + (lo2 - lo1) * t]
    }
  }
  return polyline[polyline.length - 1]
}

/** The stretch of `polyline` between two offsets, vertices included. */
function sliceBetween(
  polyline: LatLngArray[],
  cumulative: number[],
  from: number,
  to: number
): LatLngArray[] {
  const out: LatLngArray[] = [pointAt(polyline, cumulative, from)]
  for (let i = 0; i < polyline.length; i++) {
    if (cumulative[i] > from && cumulative[i] < to) out.push(polyline[i])
  }
  out.push(pointAt(polyline, cumulative, to))
  return out
}

export interface TurnGeometry {
  /** Compass bearing of the route running INTO the corner — the camera's. */
  approachBearing: number
  /** The corner, [lat, lon]. */
  corner: LatLngArray
  /** Arrowhead ring, [lng, lat] (GeoJSON order), closed. */
  head: [number, number][]
  /** The drawn route through the corner, [lng, lat] (GeoJSON order). */
  shaft: [number, number][]
}

const lngLat = ([lat, lon]: LatLngArray): [number, number] => [lon, lat]

/**
 * The turn as something to draw: the route from TURN_DRAW_BEFORE_M before the
 * corner to TURN_DRAW_AFTER_M after it, with an arrowhead on the exit. Cut
 * from the leg's own polyline at the cue's offset, so the drawn turn lies on
 * the drawn route. Null when the leg has no geometry.
 */
export function buildTurnGeometry(
  leg: Leg | null | undefined,
  cue: Pick<StepCue, 'lat' | 'lon' | 'offsetMeters'>
): TurnGeometry | null {
  const polyline = leg ? decodeLegGeometry(leg) : []
  if (polyline.length < 2) return null
  const cumulative = calculateCumulativeDistances(polyline)
  const total = cumulative[cumulative.length - 1]
  if (!(total > 0)) return null

  const at = Math.max(0, Math.min(total, cue.offsetMeters))
  const from = Math.max(0, at - TURN_DRAW_BEFORE_M)
  const to = Math.min(total, at + TURN_DRAW_AFTER_M)
  const corner = pointAt(polyline, cumulative, at)
  const path = sliceBetween(polyline, cumulative, from, to)

  // The camera's bearing is the line from TURN_APPROACH_BASELINE_M back up
  // the route to the corner, not the last vertex pair: a polyline often has a
  // kink right at the node, and a folded connector jog (MICRO_STEP_METERS)
  // can sit in the last 14 m. Measured on the 10-08 bike leg's West 106th St
  // corner: a 15 m baseline read the 14 m service-road jog (191°) and put the
  // street the rider was on sideways across the screen; 50 m reads the
  // approach.
  const approachBearing =
    at > 0
      ? bearingBetween(
          pointAt(
            polyline,
            cumulative,
            Math.max(0, at - TURN_APPROACH_BASELINE_M)
          ),
          corner
        )
      : bearingBetween(
          corner,
          pointAt(
            polyline,
            cumulative,
            Math.min(total, TURN_APPROACH_BASELINE_M)
          )
        )
  const end = path[path.length - 1]
  const beforeEnd = pointAt(polyline, cumulative, Math.max(from, to - 8))
  const exitBearing =
    to > at && to - Math.max(from, to - 8) > 0.5
      ? bearingBetween(beforeEnd, end)
      : approachBearing

  const tip = offsetPoint(end, exitBearing, TURN_HEAD_LENGTH_M)
  const left = offsetPoint(end, exitBearing - 90, TURN_HEAD_WIDTH_M / 2)
  const right = offsetPoint(end, exitBearing + 90, TURN_HEAD_WIDTH_M / 2)

  return {
    approachBearing,
    corner,
    head: [left, tip, right, left].map(lngLat),
    shaft: path.map(lngLat)
  }
}

/** The turn view only makes sense on a leg the rider steers: walk or bike. */
export function isSteeredLegMode(mode: string | null | undefined): boolean {
  return mode === 'WALK' || mode === 'BICYCLE'
}

/**
 * Whether the map should be turned to the next corner right now.
 *
 * `engagedCueIndex` is the cue the view was engaged on last tick (null when it
 * was not): the release slack only applies to the SAME turn, so passing a
 * corner and finding the next one 230 m away on a bike releases the view
 * rather than holding it on the strength of the corner just passed.
 */
export function shouldShowTurnView(input: {
  arrived: boolean
  cue: Pick<StepCue, 'index'> | null | undefined
  distanceToNextTurn: number | null | undefined
  engagedCueIndex: number | null
  legMode: string | null | undefined
}): boolean {
  const { arrived, cue, distanceToNextTurn, engagedCueIndex, legMode } = input
  if (arrived || !cue || distanceToNextTurn == null) return false
  if (!isSteeredLegMode(legMode)) return false
  if (!Number.isFinite(distanceToNextTurn) || distanceToNextTurn < 0) {
    return false
  }
  const engageM =
    legMode === 'BICYCLE' ? TURN_VIEW_ENGAGE_BIKE_M : TURN_VIEW_ENGAGE_WALK_M
  const limit =
    engagedCueIndex != null && engagedCueIndex === cue.index
      ? engageM + TURN_VIEW_RELEASE_SLACK_M
      : engageM
  return distanceToNextTurn <= limit
}

/**
 * The bounds the turn view frames, [[minLng, minLat], [maxLng, maxLat]]:
 * the rider's fix and the whole drawn turn, so the rider sees themselves,
 * the corner and where the street goes after it.
 */
export function turnViewBounds(
  turn: TurnGeometry,
  rider: { lat: number; lng: number } | null
): [[number, number], [number, number]] {
  const pts: [number, number][] = [...turn.shaft, ...turn.head]
  if (rider) pts.push([rider.lng, rider.lat])
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  pts.forEach(([lng, lat]) => {
    minLng = Math.min(minLng, lng)
    minLat = Math.min(minLat, lat)
    maxLng = Math.max(maxLng, lng)
    maxLat = Math.max(maxLat, lat)
  })
  return [
    [minLng, minLat],
    [maxLng, maxLat]
  ]
}

/** Clamp a fitted zoom into the turn view's street-level band. */
export function clampTurnZoom(zoom: number | null | undefined): number {
  if (zoom == null || !Number.isFinite(zoom)) return TURN_VIEW_MAX_ZOOM - 0.5
  return Math.max(TURN_VIEW_MIN_ZOOM, Math.min(TURN_VIEW_MAX_ZOOM, zoom))
}

/** The drawn turn as GeoJSON for the map's `go-mode-turn` source. */
export function turnGeoJson(
  turn: TurnGeometry | null
): GeoJSON.FeatureCollection {
  if (!turn) return { features: [], type: 'FeatureCollection' }
  return {
    features: [
      {
        geometry: { coordinates: turn.shaft, type: 'LineString' },
        properties: { part: 'shaft' },
        type: 'Feature'
      },
      {
        geometry: { coordinates: [turn.head], type: 'Polygon' },
        properties: { part: 'head' },
        type: 'Feature'
      }
    ],
    type: 'FeatureCollection'
  }
}
