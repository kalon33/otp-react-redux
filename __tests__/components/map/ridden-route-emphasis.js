import generateOTP2TileLayers from '@opentripplanner/otp2-tile-overlay'

import {
  OTP2_STOPS_SOURCE_LAYER,
  OTP2_TILE_SOURCE_ID,
  RIDDEN_STOPS_MIN_ZOOM,
  riddenStopsLayerProps
} from '../../../lib/components/map/ridden-route-stops-overlay'

// Backlog 3.3. The obvious way to make the ridden line's stops stand out is
// `stopsWhitelist`, which default-map.tsx already passes for the route viewer.
// It does not emphasise — it EXCLUDES, and it does so on every layer of the
// call. That is worth pinning against the real library rather than describing
// in a comment, because the day it changes is the day the whitelist becomes
// usable and this file should fail.
//
// generateOTP2TileLayers only builds elements, so no map, WebGL or DOM here.

const LAYERS = [
  { initiallyVisible: true, type: 'stops' },
  { initiallyVisible: true, minZoom: 12, type: 'stations' }
]
const ENDPOINT =
  'https://api.transit-nav.com:9966/otp/routers/default/vectorTiles'

// The 13 stops of the Orange Line's Downtown-bound pattern (house OTP,
// 2026-09-02) — what the ridden-pattern lookup hands this layer.
const RIDDEN_STOPS = [
  '1:56830',
  '1:56829',
  '1:56831',
  '1:51110',
  '1:56828',
  '1:48084',
  '1:53542',
  '1:17780',
  '1:53311',
  '1:53313',
  '1:53314',
  '1:19260',
  '1:56800'
]

const build = (whitelist) =>
  generateOTP2TileLayers(
    LAYERS.map((l) => ({ ...l, name: l.type })),
    ENDPOINT,
    null,
    null,
    whitelist,
    undefined,
    undefined,
    undefined
  )

describe('map > emphasising the ridden pattern’s stops', () => {
  describe('why stopsWhitelist cannot be reused for it', () => {
    const [, stopsLayer, stationsLayer] = build(RIDDEN_STOPS)

    it('hands the whitelist to EVERY layer in the call, not just stops', () => {
      // Both layers get it, so the stations would be culled to the same list.
      expect(stopsLayer.props.stopsWhitelist).toEqual(RIDDEN_STOPS)
      expect(stationsLayer.props.stopsWhitelist).toEqual(RIDDEN_STOPS)
    })

    it('is an exclusion, not a paint: the other stops are gone', () => {
      // @opentripplanner/otp2-tile-overlay lib/index.js:
      //   if (stopsWhitelist) { filter = ["in", ["get","gtfsId"],
      //                                  ["literal", stopsWhitelist]] }
      // — an assignment, replacing the default stops filter rather than adding
      // to it. There is no second filter or paint prop to reach for.
      const props = Object.keys(stopsLayer.props)
      expect(props).not.toContain('emphasize')
      expect(props).not.toContain('highlightStops')
      expect(props).not.toContain('extraFilter')
    })

    it('cannot be worked around with a second stops layer in the config', () => {
      // The library derives a layer's id from its type, and builds the
      // tilejson path by joining the types — so two 'stops' layers collide on
      // the id AND ask the server for a layer list it does not serve.
      const [source, ...layers] = generateOTP2TileLayers(
        [
          { name: 'stops', type: 'stops' },
          { name: 'ridden', type: 'stops' }
        ],
        ENDPOINT,
        null,
        null,
        null,
        undefined,
        undefined,
        undefined
      )
      expect(layers[0].props.id).toBe(layers[1].props.id)
      expect(source.props.url).toContain('/stops,stops/')
    })
  })

  describe('the additional layer this ships instead', () => {
    const layer = riddenStopsLayerProps(RIDDEN_STOPS, '#F68B1F')

    it('targets the source the tile overlay already created', () => {
      const [source] = build(null)
      expect(source.props.id).toBe(OTP2_TILE_SOURCE_ID)
      expect(source.props.url).toContain('/stops,stations/')
      expect(OTP2_STOPS_SOURCE_LAYER).toBe('stops')
    })

    it('filters to the ridden stops without touching any other layer', () => {
      expect(layer.filter).toEqual([
        'in',
        ['get', 'gtfsId'],
        ['literal', RIDDEN_STOPS]
      ])
    })

    it('draws a ring, so the ordinary stop dot stays readable inside it', () => {
      // The tile overlay's own stops paint is a filled circle (radius 5,
      // white, #333 stroke). A filled overlay would hide it; a ring reads as
      // emphasis.
      expect(layer.paint['circle-opacity']).toBe(0)
      expect(layer.paint['circle-radius']).toBeGreaterThan(5)
      expect(layer.paint['circle-stroke-color']).toBe('#F68B1F')
      expect(layer.paint['circle-stroke-width']).toBeGreaterThan(0)
    })

    it('keeps the server’s stop zoom instead of the whitelist’s minzoom 2', () => {
      // stopsWhitelist drops every layer to minzoom 2, which would leave the
      // emphasis rings floating alone on a map with no stops drawn under them.
      expect(layer.minzoom).toBe(RIDDEN_STOPS_MIN_ZOOM)
      expect(RIDDEN_STOPS_MIN_ZOOM).toBe(14)
    })

    it('falls back to a neutral colour when the feed publishes none', () => {
      expect(
        riddenStopsLayerProps(RIDDEN_STOPS, null).paint['circle-stroke-color']
      ).toBeTruthy()
    })
  })
})
