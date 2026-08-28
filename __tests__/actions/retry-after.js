import { retryAfterMs } from '../../lib/actions/api'

// nginx answers a rate-limited /otp request with `Retry-After: 2` (see
// otp-minneapolis config/nginx/otp-common.conf, the @cors429 location).
describe('actions > retryAfterMs', () => {
  it('reads the seconds form nginx actually sends', () => {
    expect(retryAfterMs('2')).toBe(2000)
  })

  it('reads the HTTP-date form', () => {
    const when = new Date(Date.now() + 5000).toUTCString()
    const ms = retryAfterMs(when)
    expect(ms).toBeGreaterThanOrEqual(1000)
    expect(ms).toBeLessThanOrEqual(6000)
  })

  it('falls back to the floor when the header is missing or junk', () => {
    expect(retryAfterMs(undefined)).toBe(1000)
    expect(retryAfterMs(null)).toBe(1000)
    expect(retryAfterMs('soon')).toBe(1000)
    expect(retryAfterMs('')).toBe(1000)
  })

  it('clamps a value that would strand the request', () => {
    // A hostile or misconfigured header must not park the app for an hour.
    expect(retryAfterMs('3600')).toBe(30000)
    expect(retryAfterMs('-5')).toBe(1000)
  })
})
