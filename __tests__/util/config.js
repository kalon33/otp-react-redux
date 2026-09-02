import { getVectorTilesPath } from '../../lib/util/config'

// The shipped phone config, transitnav-ios/web-config/app-config.yml: `path` is
// commented out on purpose (it is the OTP1 REST path) and `basePath` is /otp.
const PHONE_API = {
  basePath: '/otp',
  host: 'https://api.transit-nav.com',
  port: 9966,
  v2: true
}

describe('util > config > getVectorTilesPath', () => {
  it('names the OTP2 router path when api.path is unset', () => {
    // Before the fix this read api.path and produced "undefined/vectorTiles",
    // so every stop-tile request went to a URL containing the literal string
    // "undefined" and the map's stop layer was permanently empty.
    expect(getVectorTilesPath(PHONE_API)).toBe(
      '/otp/routers/default/vectorTiles'
    )
  })

  it('never emits the string "undefined"', () => {
    expect(getVectorTilesPath(PHONE_API)).not.toContain('undefined')
    expect(getVectorTilesPath({})).not.toContain('undefined')
    expect(getVectorTilesPath(undefined)).not.toContain('undefined')
  })

  it('falls back to /otp when basePath is absent too', () => {
    expect(getVectorTilesPath({ host: 'https://example.com' })).toBe(
      '/otp/routers/default/vectorTiles'
    )
  })

  it('honours a non-default basePath for a differently proxied deployment', () => {
    expect(getVectorTilesPath({ basePath: '/transit/otp' })).toBe(
      '/transit/otp/routers/default/vectorTiles'
    )
  })

  it('still respects an explicitly configured api.path', () => {
    expect(getVectorTilesPath({ path: '/otp/routers/mn' })).toBe(
      '/otp/routers/mn/vectorTiles'
    )
  })
})
