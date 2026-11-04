/**
 * The Android backgrounding recovery on DefaultMap (see _onContextLost there).
 *
 * The failure being covered: after a while spent backgrounded among other
 * applications, the Android WebView reclaims the map's WebGL surface.
 * MapLibre 5.6.1 stops its render loop on webglcontextlost and only recovers
 * if the WebView fires webglcontextrestored — which it frequently never does —
 * so the canvas stayed black for the life of the page, and reuseMaps kept
 * handing the dead instance back on every remount.
 *
 * The recovery is asserted on the prototype, without a store or a live map:
 * the handlers only touch document.visibilityState, one timer and setState.
 */

// jsdom does not implement matchMedia, and the app's styled-components read it
// at import time (components/util/prefersReducedMotion). Stub it, then require
// the module — a static import would be hoisted above the stub.
window.matchMedia = window.matchMedia || (() => ({ matches: false }))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  CONTEXT_LOSS_RECOVERY_GRACE_MS,
  DefaultMap
} = require('../../../lib/components/map/default-map')

/**
 * A bare DefaultMap instance, not rendered: the recovery handlers are class
 * fields set by the constructor, and they touch nothing but the visibility
 * state, one timer and setState — so a constructed instance is enough.
 */
function makeMap() {
  const map = new DefaultMap({ mapConfig: {} })
  // React's own setState needs a mounted component; the handlers only need
  // to report their update.
  map.setState = jest.fn()
  return map
}

function visible() {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible'
  })
}

function hidden() {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'hidden'
  })
}

/** The one timer the recovery schedules, run to its end. */
function runGracePeriod() {
  jest.advanceTimersByTime(CONTEXT_LOSS_RECOVERY_GRACE_MS)
}

describe('components > map > webgl context-loss recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    visible()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('rebuilds the map when a lost context never comes back', () => {
    const map = makeMap()
    map._onContextLost()
    runGracePeriod()

    // One rebuild: a new generation for the BaseMap key, and contextLost held
    // true so the replacement mounts with reuseMaps off (a fresh canvas, not
    // the dead instance react-map-gl would hand back from its pool).
    expect(map.setState).toHaveBeenCalledTimes(1)
    const [update] = map.setState.mock.calls[0]
    expect(update).toBeInstanceOf(Function)
    expect(update({ mapGeneration: 3 })).toEqual({
      contextLost: true,
      mapGeneration: 4
    })
  })

  it('does not rebuild when the WebView restores the context in time', () => {
    const map = makeMap()
    map._onContextLost()
    map._onContextRestored()
    runGracePeriod()

    expect(map.setState).not.toHaveBeenCalled()
    expect(map._contextLost).toBe(false)
    expect(map._contextRecoveryTimer).toBeNull()
  })

  it('waits while hidden and rebuilds on the return to the foreground', () => {
    hidden()
    const map = makeMap()
    map._onContextLost()
    runGracePeriod()
    // Backgrounded: the rider is in another app; a rebuild would race the
    // resume, so nothing is scheduled.
    expect(map.setState).not.toHaveBeenCalled()

    visible()
    map._onVisibilityChangeForContextRecovery()
    runGracePeriod()
    expect(map.setState).toHaveBeenCalledTimes(1)
  })

  it('does not rebuild on a resume when the context is healthy', () => {
    const map = makeMap()
    visible()
    map._onVisibilityChangeForContextRecovery()
    runGracePeriod()

    expect(map.setState).not.toHaveBeenCalled()
  })
})
