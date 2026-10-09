import polyline from '@mapbox/polyline'

import {
  bearingBetween,
  buildTurnGeometry,
  clampTurnZoom,
  shouldShowTurnView,
  TURN_DRAW_AFTER_M,
  TURN_DRAW_BEFORE_M,
  TURN_VIEW_ENGAGE_BIKE_M,
  TURN_VIEW_ENGAGE_WALK_M,
  TURN_VIEW_MAX_ZOOM,
  TURN_VIEW_MIN_ZOOM,
  TURN_VIEW_RELEASE_SLACK_M,
  turnGeoJson,
  turnViewBounds
} from '../../../lib/util/go-mode/turn-view'
import { calculateDistance } from '../../../lib/util/go-mode/position-matching'

/**
 * Backlog 44.3, the map half. Rider, 2026-10-08: "Both" — the map zooming and
 * turning to the next corner with the turn drawn on it.
 *
 * An L-shaped bike leg: ~300 m due north up Girard, then ~200 m due east. The
 * corner sits at the bend; a rider coming up to it should see the map turned
 * so north (the street they are on) points up, and the drawn turn should run
 * up to the corner and off to the east, ending in an arrowhead.
 */
const SOUTH: [number, number] = [44.94, -93.29]
const CORNER: [number, number] = [44.9427, -93.29]
const EAST: [number, number] = [44.9427, -93.2875]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const leg: any = {
  legGeometry: { points: polyline.encode([SOUTH, CORNER, EAST]) },
  mode: 'BICYCLE'
}
const cornerOffset = calculateDistance(...SOUTH, ...CORNER)

describe('util > go-mode > turn-view (44.3)', () => {
  describe('buildTurnGeometry', () => {
    const turn = buildTurnGeometry(leg, {
      lat: CORNER[0],
      lon: CORNER[1],
      offsetMeters: cornerOffset
    })

    it('turns the camera to face the street into the corner', () => {
      expect(turn).not.toBeNull()
      // Due north, within a degree.
      const b = turn?.approachBearing as number
      expect(Math.min(b, 360 - b)).toBeLessThan(1)
    })

    it('draws the route from before the corner to after it', () => {
      const shaft = turn?.shaft as [number, number][]
      const [startLng, startLat] = shaft[0]
      const [endLng, endLat] = shaft[shaft.length - 1]
      // Starts TURN_DRAW_BEFORE_M south of the corner, on the same street.
      expect(
        calculateDistance(startLat, startLng, CORNER[0], CORNER[1])
      ).toBeCloseTo(TURN_DRAW_BEFORE_M, 0)
      // Passes through the corner vertex itself.
      expect(shaft).toContainEqual([CORNER[1], CORNER[0]])
      // Ends TURN_DRAW_AFTER_M east of it.
      expect(
        calculateDistance(endLat, endLng, CORNER[0], CORNER[1])
      ).toBeCloseTo(TURN_DRAW_AFTER_M, 0)
      expect(endLng).toBeGreaterThan(CORNER[1])
    })

    it('puts the arrowhead on the exit, pointing east', () => {
      const head = turn?.head as [number, number][]
      expect(head).toHaveLength(4)
      expect(head[0]).toEqual(head[3]) // a closed ring
      const shaft = turn?.shaft as [number, number][]
      const [endLng, endLat] = shaft[shaft.length - 1]
      const [tipLng, tipLat] = head[1]
      const b = bearingBetween([endLat, endLng], [tipLat, tipLng])
      expect(Math.abs(b - 90)).toBeLessThan(2)
    })

    it('reads the approach, not a 14 m connector jog just before the corner', () => {
      // 10-08 bike leg, West 106th St: a folded 14 m service-road jog sat in
      // the last metres before the corner, and a 15 m baseline turned the map
      // to the jog (sideways to the street the rider was on).
      const jogEnd: [number, number] = [
        CORNER[0],
        CORNER[1] + 14 / (111_320 * Math.cos((CORNER[0] * Math.PI) / 180))
      ]
      const north: [number, number] = [CORNER[0] + 0.0018, jogEnd[1]]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jogLeg: any = {
        legGeometry: {
          points: polyline.encode([SOUTH, CORNER, jogEnd, north])
        },
        mode: 'BICYCLE'
      }
      const g = buildTurnGeometry(jogLeg, {
        lat: jogEnd[0],
        lon: jogEnd[1],
        offsetMeters: cornerOffset + 14
      })
      // Mostly north (the street), never the jog's due east.
      expect(g?.approachBearing as number).toBeLessThan(30)
    })

    it('clamps a corner at the very end of the leg instead of overrunning', () => {
      const last = buildTurnGeometry(leg, {
        lat: EAST[0],
        lon: EAST[1],
        offsetMeters: 10_000
      })
      expect(last).not.toBeNull()
      const shaft = last?.shaft as [number, number][]
      expect(shaft[shaft.length - 1][0]).toBeCloseTo(EAST[1], 6)
    })

    it('gives up quietly on a leg with no geometry', () => {
      expect(
        buildTurnGeometry({ mode: 'BICYCLE' } as never, {
          lat: 0,
          lon: 0,
          offsetMeters: 0
        })
      ).toBeNull()
      expect(
        buildTurnGeometry(null, { lat: 0, lon: 0, offsetMeters: 0 })
      ).toBeNull()
    })

    it('becomes a two-feature GeoJSON for the map source', () => {
      const fc = turnGeoJson(turn)
      expect(fc.features.map((f) => f.properties?.part)).toEqual([
        'shaft',
        'head'
      ])
      expect(turnGeoJson(null).features).toEqual([])
    })

    it('frames the rider and the whole drawn turn', () => {
      const rider = { lat: 44.9415, lng: -93.29 }
      const [[minLng, minLat], [maxLng, maxLat]] = turnViewBounds(
        turn as NonNullable<typeof turn>,
        rider
      )
      expect(minLat).toBeLessThanOrEqual(rider.lat)
      expect(maxLat).toBeGreaterThanOrEqual(CORNER[0])
      expect(maxLng).toBeGreaterThan(CORNER[1])
      expect(minLng).toBeLessThanOrEqual(rider.lng)
    })
  })

  describe('shouldShowTurnView', () => {
    const base = {
      arrived: false,
      cue: { index: 2 },
      distanceToNextTurn: 150,
      engagedCueIndex: null as number | null,
      legMode: 'BICYCLE'
    }

    it('turns to a corner inside the bike engage distance', () => {
      expect(shouldShowTurnView(base)).toBe(true)
      expect(
        shouldShowTurnView({
          ...base,
          distanceToNextTurn: TURN_VIEW_ENGAGE_BIKE_M + 1
        })
      ).toBe(false)
    })

    it('uses the shorter walk distance on foot', () => {
      expect(
        shouldShowTurnView({
          ...base,
          distanceToNextTurn: TURN_VIEW_ENGAGE_WALK_M + 1,
          legMode: 'WALK'
        })
      ).toBe(false)
      expect(
        shouldShowTurnView({
          ...base,
          distanceToNextTurn: TURN_VIEW_ENGAGE_WALK_M - 1,
          legMode: 'WALK'
        })
      ).toBe(true)
    })

    it('holds the same turn through a GPS wobble past the engage line', () => {
      const wobble = TURN_VIEW_ENGAGE_BIKE_M + TURN_VIEW_RELEASE_SLACK_M - 1
      expect(
        shouldShowTurnView({
          ...base,
          distanceToNextTurn: wobble,
          engagedCueIndex: 2
        })
      ).toBe(true)
      // …but not for a NEW turn just because the last one was engaged.
      expect(
        shouldShowTurnView({
          ...base,
          cue: { index: 3 },
          distanceToNextTurn: wobble,
          engagedCueIndex: 2
        })
      ).toBe(false)
    })

    it('never on a bus, after arrival, or with no turn', () => {
      expect(shouldShowTurnView({ ...base, legMode: 'BUS' })).toBe(false)
      expect(shouldShowTurnView({ ...base, arrived: true })).toBe(false)
      expect(shouldShowTurnView({ ...base, cue: null })).toBe(false)
      expect(
        shouldShowTurnView({ ...base, distanceToNextTurn: undefined })
      ).toBe(false)
      expect(
        shouldShowTurnView({ ...base, distanceToNextTurn: Infinity })
      ).toBe(false)
    })
  })

  it('keeps the fitted zoom in the street-level band', () => {
    expect(clampTurnZoom(12)).toBe(TURN_VIEW_MIN_ZOOM)
    expect(clampTurnZoom(21)).toBe(TURN_VIEW_MAX_ZOOM)
    expect(clampTurnZoom(17.2)).toBe(17.2)
    expect(clampTurnZoom(undefined)).toBe(TURN_VIEW_MAX_ZOOM - 0.5)
  })
})
