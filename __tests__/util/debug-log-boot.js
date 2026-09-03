/**
 * The boot crash path (backlog 6.49).
 *
 * On 2026-09-02 an OTA bundle white-screened the rider's iPhone and the device
 * wrote ZERO records to the sink — no error, not even the `start` session
 * event — because the only error handler the app had was installed by a
 * STATEMENT in main.js (after every import had already been evaluated) and its
 * stream is buffered for 3 s behind an interval that a force-quit never
 * reaches. These cases pin down the shape of the record that has to survive
 * that: one beacon, sent the instant the error fires, before React has mounted
 * anything at all.
 */

const ENDPOINT = 'https://api.example.test/api/debug-log'
const BUILD = '1.0.54 web:6597af53'

let beacons
let sendBeacon

/** The module mints a session id and reads the device id at evaluation, so
 * every case gets a fresh copy after localStorage has been arranged. */
function load() {
  let mod
  jest.isolateModules(() => {
    mod = require('../../lib/util/debug-log-boot')
  })
  return mod
}

function install(mod) {
  mod.installBootCrashCapture({ build: BUILD, endpoint: ENDPOINT })
}

function bodyOf(beacon) {
  return JSON.parse(beacon.blob.parts[0])
}

function throwDuringBoot(message = 'TypeError: undefined is not an object') {
  window.dispatchEvent(
    new ErrorEvent('error', {
      colno: 4210,
      error: Object.assign(new Error(message), {
        stack: `${message}\n    at r (/assets/index-8f2a1c.js:1:98231)`
      }),
      filename: 'https://localhost/assets/index-8f2a1c.js',
      lineno: 1,
      message
    })
  )
}

class FakeBlob {
  constructor(parts, options) {
    this.parts = parts
    this.type = options?.type
  }
}

describe('util > debug-log-boot', () => {
  let realBlob
  let listeners

  beforeEach(() => {
    // Each case loads a fresh copy of the module, but they all share ONE jsdom
    // window — so the handlers a case installs have to come back off it, or
    // every later case is answered by every earlier case's module too.
    listeners = []
    const addListener = window.addEventListener.bind(window)
    jest
      .spyOn(window, 'addEventListener')
      .mockImplementation((type, fn, opts) => {
        listeners.push([type, fn, opts])
        addListener(type, fn, opts)
      })
    window.localStorage.clear()
    // Consent: the browser path is opt-in. The native shell defaults on, which
    // is the case that actually matters, but it needs no stub here.
    window.localStorage.setItem('otpDebugLog', '1')
    beacons = []
    sendBeacon = jest.fn((url, blob) => {
      beacons.push({ blob, url })
      return true
    })
    navigator.sendBeacon = sendBeacon
    realBlob = global.Blob
    global.Blob = FakeBlob
  })

  afterEach(() => {
    jest.restoreAllMocks()
    for (const [type, fn, opts] of listeners) {
      window.removeEventListener(type, fn, opts)
    }
    global.Blob = realBlob
    delete navigator.sendBeacon
  })

  it('beacons one record for an error raised before React mounts', () => {
    const mod = load()
    install(mod)

    // The white screen itself: nothing has been rendered.
    expect(document.getElementById('main')).toBeNull()
    throwDuringBoot()

    expect(sendBeacon).toHaveBeenCalledTimes(1)
    expect(beacons[0].url).toBe(ENDPOINT)
    // A beacon cannot preflight, and text/plain is the only content type
    // allowed cross-origin — which the native app always is.
    expect(beacons[0].blob.type).toBe('text/plain')

    const body = bodyOf(beacons[0])
    expect(body.build).toBe(BUILD)
    expect(body.sessionId).toBe(mod.bootSessionId())
    expect(body.deviceId).toBe(mod.getDeviceId())
    expect(body.ua).toBe(navigator.userAgent)
    expect(body.entries).toHaveLength(1)

    const entry = body.entries[0]
    expect(entry.kind).toBe('boot-error')
    expect(entry.message).toBe('TypeError: undefined is not an object')
    expect(entry.source).toBe('https://localhost/assets/index-8f2a1c.js')
    expect(entry.line).toBe(1)
    expect(entry.col).toBe(4210)
    expect(entry.stack).toContain('index-8f2a1c.js')
    // Identity is minted here, like every other entry, so the sink can dedupe
    // a re-send against the stream that follows.
    expect(entry.id.startsWith(mod.bootSessionId())).toBe(true)
    expect(typeof entry.t).toBe('number')
    expect(typeof entry.sinceBootMs).toBe('number')
  })

  it('reports localStorage as key names and sizes, never values', () => {
    const value = '{"secret":"3322 Columbus"}'
    window.localStorage.setItem('otp.goModeSession', value)
    const mod = load()
    install(mod)
    throwDuringBoot()

    const raw = beacons[0].blob.parts[0]
    // The saved trip, the rider's places and their query history all live in
    // localStorage. The diagnosis needs to know which keys the boot was
    // reading and how big they were; it must never carry what they said.
    expect(raw).not.toContain('3322 Columbus')
    const { storage } = bodyOf(beacons[0]).entries[0]
    const saved = storage.find((s) => s.k === 'otp.goModeSession')
    expect(saved).toEqual({ k: 'otp.goModeSession', n: value.length })
  })

  it('sends nothing when the device has opted out', () => {
    window.localStorage.setItem('otpDebugLog', '0')
    const mod = load()
    install(mod)
    throwDuringBoot()

    expect(sendBeacon).not.toHaveBeenCalled()
    // The verdict reader is not gated on consent: withholding a bundle
    // confirmation is a safety decision, not telemetry.
    expect(mod.bootBroke()).toBe(true)
  })

  it('names the running bundle once the plugin has answered', () => {
    const mod = load()
    install(mod)
    mod.noteBundleVersion('2026.0902.3')
    throwDuringBoot()

    expect(bodyOf(beacons[0]).entries[0].bundle).toBe('2026.0902.3')
  })

  it('captures an unhandled rejection too', () => {
    const mod = load()
    install(mod)
    const event = new Event('unhandledrejection')
    event.reason = new Error('plan fetch failed')
    window.dispatchEvent(event)

    const entry = bodyOf(beacons[0]).entries[0]
    expect(entry.kind).toBe('boot-rejection')
    expect(entry.message).toBe('plan fetch failed')
    expect(mod.bootBroke()).toBe(true)
  })

  it('stops after a few beacons — a broken boot throws in a loop', () => {
    const mod = load()
    install(mod)
    for (let i = 0; i < 10; i++) throwDuringBoot(`boom ${i}`)

    // Enough to see the first failure and that it recurred; the rest is uplink
    // spent on a phone that is already in trouble.
    expect(sendBeacon).toHaveBeenCalledTimes(3)
    expect(mod.bootBroke()).toBe(true)
  })

  it('stands down once the bundle has been pronounced healthy', () => {
    const mod = load()
    install(mod)
    mod.sealBootCrashCapture()
    throwDuringBoot()

    // An error after a healthy boot is an ordinary in-app error, and the
    // buffered stream is running by then.
    expect(sendBeacon).not.toHaveBeenCalled()
  })

  it('carries a session event by beacon for callers that cannot wait', () => {
    const mod = load()
    install(mod)
    mod.sendBootSessionEvent('bundle_health', {
      confirmed: false,
      reason: 'not-rendered'
    })

    const entry = bodyOf(beacons[0]).entries[0]
    expect(entry).toMatchObject({
      confirmed: false,
      event: 'bundle_health',
      kind: 'session',
      reason: 'not-rendered'
    })
  })

  it('never throws when the browser has no sendBeacon', () => {
    delete navigator.sendBeacon
    const mod = load()
    install(mod)

    expect(() => throwDuringBoot()).not.toThrow()
    expect(mod.bootBroke()).toBe(true)
  })

  it('installs one set of handlers however many times it is called', () => {
    const mod = load()
    install(mod)
    install(mod)
    throwDuringBoot()

    expect(sendBeacon).toHaveBeenCalledTimes(1)
  })

  it('keeps entry ids dense across a session id adopted mid-ride', () => {
    const mod = load()
    install(mod)
    const first = mod.mintBootEntryId()
    expect(first.startsWith(mod.bootSessionId())).toBe(true)

    // A ride the app re-mounted inside keeps writing under the earlier id, but
    // the load tag has to keep the two loads' entry ids distinct or the sink's
    // dedupe drops the whole second load as a re-send.
    const loadTag = mod.bootSessionId()
    mod.setBootSessionId('mtbtyif4-axo9cm', loadTag)
    expect(mod.bootSessionId()).toBe('mtbtyif4-axo9cm')
    expect(mod.mintBootEntryId()).toBe(`mtbtyif4-axo9cm.${loadTag}-0`)
  })
})
