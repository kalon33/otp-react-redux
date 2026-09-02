import generateOTP2TileLayers from '@opentripplanner/otp2-tile-overlay'

import { getVectorTilesPath } from '../../../lib/util/config'

// The three things that have to line up for stops to appear on the map, and
// which failed independently and silently before 2026-09-02:
//
//   1. the tile endpoint the frontend builds (getVectorTilesPath, was
//      "undefined/vectorTiles" because api.path is unset under OTP2),
//   2. each layer's `type`, which becomes the layer list in the tilejson
//      request path and must equal the layer `name` in the OTP server's
//      router-config.json `vectorTiles.layers`, and
//   3. `initiallyVisible`, which becomes the `visible` prop that
//      @opentripplanner/base-map uses to decide the layer's starting state:
//      every child whose `visible` is falsy goes straight into its hidden set.
//
// This exercises the real @opentripplanner/otp2-tile-overlay against the config
// that transitnav-ios/web-config/app-config.yml actually ships, so a change to
// either end shows up here. generateOTP2TileLayers only builds elements, so no
// map, WebGL or DOM is needed to inspect what it would render.

// Verbatim from transitnav-ios/web-config/app-config.yml `api:`.
const SHIPPED_API = {
  basePath: '/otp',
  host: 'https://api.transit-nav.com',
  port: 9966,
  v2: true
}
// Verbatim from that file's `map.overlays[0].layers`.
const SHIPPED_LAYERS = [
  { initiallyVisible: true, type: 'stops' },
  { initiallyVisible: true, minZoom: 12, type: 'stations' }
]

// What default-map.tsx composes: assembleBasePath(config) + getVectorTilesPath.
const endpoint = `${SHIPPED_API.host}:${SHIPPED_API.port}${getVectorTilesPath(
  SHIPPED_API
)}`

describe('map > OTP2 stop and station tile layers', () => {
  const elements = generateOTP2TileLayers(
    SHIPPED_LAYERS.map((l) => ({ ...l, name: l.type })),
    endpoint,
    null,
    null,
    null,
    undefined,
    undefined,
    undefined
  )
  const [source, ...layers] = elements

  it('requests the tilejson from the OTP2 router path, not "undefined"', () => {
    // Verified by hand against the house OTP on 2026-09-02: this exact URL
    // returns 200 with a tiles[] array, and one tile is ~21 kB of protobuf.
    expect(source.props.url).toBe(
      'https://api.transit-nav.com:9966/otp/routers/default/vectorTiles/stops,stations/tilejson.json'
    )
    expect(source.props.url).not.toContain('undefined')
  })

  it('asks for exactly the layer names the server declares', () => {
    // config/router-config.json vectorTiles.layers[].name on the OTP side.
    expect(source.props.url).toContain('/stops,stations/')
    expect(layers.map((l) => l.props.type)).toEqual(['stops', 'stations'])
  })

  it('starts both layers visible', () => {
    // base-map puts every layer with a falsy `visible` into hiddenLayers, so a
    // layer without initiallyVisible ships switched off with no way to tell it
    // apart from a layer that failed to load.
    expect(layers.map((l) => l.props.visible)).toEqual([true, true])
  })

  it('draws stations from the zoom level the server serves them at', () => {
    // router-config.json gives stations minZoom 12 and stops minZoom 14; the
    // overlay defaults to 14 when the config omits it.
    expect(layers[1].props.minZoom).toBe(12)
  })
})
