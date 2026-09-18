import '../../test-utils/mock-window-url'
import { ARRIVED_DISTANCE_FILTER_METERS } from '../../../lib/util/go-mode/tracking-gates'
import {
  nativeGpsDistanceFilter,
  nativeGpsWatcherSerial,
  restartNativeGps,
  setNativeGpsDistanceFilter,
  startNativeGps,
  stopNativeGps
} from '../../../lib/util/go-mode/native-gps'
import {
  POSITION_SOURCE_BROWSER,
  tagBrowserPosition
} from '../../../lib/util/go-mode/position-source'

/**
 * TWO POSITION STREAMS — the tag that will name them, and the guard that
 * stops this file producing them (backlog 18.2).
 *
 * On 2026-09-17 ride 1 (session `mu63yfrb-ekv1fl`, 2380 fixes) the phone
 * delivered fixes that alternated between two tracks 200–310 m apart for at
 * least two minutes: ten consecutive-fix jumps over 100 m, every one of them
 * with a timestamp within 0.1 s of receipt and 9–22 m of reported accuracy,
 * both tracks advancing at bike speed and both stopping at the same red light
 * 293 m apart. It manufactured a deviation replan at 18:26:55 on a rider who
 * had not left the route, rewrote the turn card, and left progress frozen for
 * 24 ticks while the gate absorbed the flip back.
 *
 * Nothing in the telemetry could say WHERE the second stream came from,
 * because `UPDATE_POSITION` carried `{ coords, timestamp }` and nothing else.
 * Hence two changes, in this order:
 *
 *  1. every emitted fix names its producer, so the next ride's day file is
 *     counted rather than interpreted;
 *  2. `startNativeGps` shares one in-flight start, so this file cannot be the
 *     producer of the second one.
 *
 * The guard is for a window that is real but was NOT what fired on that ride —
 * see the tests below for what it does and does not cover.
 */

/**
 * A bridge whose `addWatcher` resolves only when told to — the latency the
 * early-return cannot see. `removeWatcher` resolves on its own, because a
 * teardown that never finishes is not the window under test.
 */
const installDeferredBridge = () => {
  const callbacks: any[] = []
  const pendingAdds: Array<() => void> = []
  const addWatcher = jest.fn(
    (_opts: any, cb: any) =>
      new Promise<string>((resolve) => {
        const n = callbacks.push(cb)
        pendingAdds.push(() => resolve(`watcher-${n}`))
      })
  )
  const removeWatcher = jest.fn(async () => undefined)
  ;(window as any).Capacitor = {
    isNativePlatform: () => true,
    Plugins: { BackgroundGeolocation: { addWatcher, removeWatcher } }
  }
  return { addWatcher, callbacks, pendingAdds, removeWatcher }
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

/**
 * Drain the pending adds and let the continuations run — repeatedly, because a
 * re-arm only issues its `addWatcher` after the teardown's microtasks have run,
 * so the queue can refill after it has been drained once.
 */
const settle = async (queue: Array<() => void>) => {
  for (let round = 0; round < 5; round++) {
    await flush()
    while (queue.length) (queue.shift() as () => void)()
    await flush()
  }
}

/**
 * Deliver one plugin location through the watcher's own `(location, error)`
 * callback — the plugin's argument order, not node's.
 */
const fixFrom = (emit: any, lat: number, lon: number) =>
  emit(
    {
      accuracy: 9,
      altitude: null,
      altitudeAccuracy: null,
      bearing: null,
      latitude: lat,
      longitude: lon,
      simulated: false,
      speed: 5,
      time: 1789687540000
    },
    null
  )

describe('one watcher per start, however many callers arrive', () => {
  let plugin: ReturnType<typeof installDeferredBridge>

  beforeEach(() => {
    plugin = installDeferredBridge()
  })

  afterEach(async () => {
    await settle(plugin.pendingAdds)
    await stopNativeGps()
    delete (window as any).Capacitor
  })

  it('arms ONE watcher when two callers arrive inside addWatcher latency', async () => {
    // The hole: `if (watcherId) return true` cannot see a start that has not
    // resolved, and nothing else marks the attempt. Before the in-flight guard
    // both calls armed a watcher and the first was orphaned for the life of the
    // page — nothing holds its id, so stopNativeGps can never remove it.
    const first = startNativeGps(
      () => undefined,
      () => undefined
    )
    const second = startNativeGps(
      () => undefined,
      () => undefined
    )
    expect(plugin.addWatcher).toHaveBeenCalledTimes(1)
    await settle(plugin.pendingAdds)
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(plugin.addWatcher).toHaveBeenCalledTimes(1)
    expect(nativeGpsDistanceFilter()).toBe(0)
  })

  it('arms ONE watcher when a start lands inside a filter re-arm', async () => {
    // The widest window of the three, and the one a live trip actually opens:
    // setNativeGpsDistanceFilter clears watcherId itself and then awaits
    // removeWatcher, so for a whole bridge round trip nativeGpsDistanceFilter()
    // reads null and any re-entry of startPositionTracking starts its own.
    const start = startNativeGps(
      () => undefined,
      () => undefined
    )
    await settle(plugin.pendingAdds)
    await start
    expect(plugin.addWatcher).toHaveBeenCalledTimes(1)

    const rearm = setNativeGpsDistanceFilter(
      ARRIVED_DISTANCE_FILTER_METERS,
      () => undefined,
      () => undefined
    )
    await flush()
    // Mid-teardown: the stream reads as down, which is exactly what the
    // arrival branch of handlePositionUpdate re-enters on.
    expect(nativeGpsDistanceFilter()).toBeNull()
    const racer = startNativeGps(
      () => undefined,
      () => undefined
    )
    await settle(plugin.pendingAdds)
    await rearm
    await racer
    expect(plugin.addWatcher).toHaveBeenCalledTimes(2)
  })

  it('arms ONE watcher when a start lands inside the watchdog restart', async () => {
    const start = startNativeGps(
      () => undefined,
      () => undefined
    )
    await settle(plugin.pendingAdds)
    await start

    const restart = restartNativeGps(
      () => undefined,
      () => undefined
    )
    await flush()
    const racer = startNativeGps(
      () => undefined,
      () => undefined
    )
    await settle(plugin.pendingAdds)
    await restart
    await racer
    expect(plugin.addWatcher).toHaveBeenCalledTimes(2)
  })

  it('removes the watcher a stop raced, instead of orphaning it', async () => {
    // stopNativeGps used to fall through `!watcherId` and return, and the
    // watcher that arrived a moment later streamed for the life of the page.
    const start = startNativeGps(
      () => undefined,
      () => undefined
    )
    const stop = stopNativeGps()
    await settle(plugin.pendingAdds)
    await start
    await stop
    expect(plugin.removeWatcher).toHaveBeenCalledTimes(1)
    expect(plugin.removeWatcher.mock.calls[0][0]).toEqual({ id: 'watcher-1' })
    expect(nativeGpsDistanceFilter()).toBeNull()
  })

  it('reports a failed addWatcher instead of throwing into nobody', async () => {
    // No call site awaits startNativeGps, so a rejection here was an unhandled
    // rejection and a trip with neither a stream nor a tracking error.
    const boom = new Error('NOT_AUTHORIZED')
    ;(window as any).Capacitor.Plugins.BackgroundGeolocation.addWatcher =
      jest.fn(() => Promise.reject(boom))
    const errors: Error[] = []
    const ok = await startNativeGps(
      () => undefined,
      (e) => errors.push(e)
    )
    expect(ok).toBe(false)
    expect(errors).toEqual([boom])
    expect(nativeGpsDistanceFilter()).toBeNull()
  })
})

describe('every fix names the watcher that produced it', () => {
  let plugin: ReturnType<typeof installDeferredBridge>

  beforeEach(() => {
    plugin = installDeferredBridge()
  })

  afterEach(async () => {
    await settle(plugin.pendingAdds)
    await stopNativeGps()
    delete (window as any).Capacitor
  })

  it('tags native fixes with the arming serial, and re-arms get a new one', async () => {
    const seen: any[] = []
    const start = startNativeGps(
      (p) => seen.push(p),
      () => undefined
    )
    await settle(plugin.pendingAdds)
    await start
    const firstSerial = nativeGpsWatcherSerial()
    fixFrom(plugin.callbacks[0], 44.9499, -93.2376)

    const rearm = setNativeGpsDistanceFilter(
      ARRIVED_DISTANCE_FILTER_METERS,
      (p) => seen.push(p),
      () => undefined
    )
    await settle(plugin.pendingAdds)
    await rearm
    fixFrom(plugin.callbacks[1], 44.9502, -93.2371)

    expect(seen).toHaveLength(2)
    expect(seen[0].source).toBe(`native#${firstSerial}`)
    expect(seen[1].source).toBe(`native#${firstSerial + 1}`)
    // Which is the whole point: two streams would show two sources in one
    // ride's UPDATE_POSITION payloads, with no analysis at all.
    expect(seen[0].source).not.toEqual(seen[1].source)
  })

  it('keeps the position contract byte-compatible — the tag is additive', async () => {
    const seen: any[] = []
    const start = startNativeGps(
      (p) => seen.push(p),
      () => undefined
    )
    await settle(plugin.pendingAdds)
    await start
    fixFrom(plugin.callbacks[0], 44.9499, -93.2376)
    expect(Object.keys(seen[0].coords).sort()).toEqual([
      'accuracy',
      'altitude',
      'altitudeAccuracy',
      'heading',
      'latitude',
      'longitude',
      'speed'
    ])
    expect(seen[0].timestamp).toBe(1789687540000)
    // `build-fixture.js` reads coords by name, so a fixture built from a tagged
    // day file is identical to one built from an untagged one.
    expect(seen[0].coords.latitude).toBe(44.9499)
  })
})

describe('the browser path is tagged too, and survives stringify', () => {
  it('copies the fix rather than annotating it', () => {
    // A real GeolocationPosition defines toJSON(), which wins over own
    // properties in JSON.stringify — an attached tag would never reach the day
    // file, which is the only place it is any use. This is why 18.2 could not
    // rule the browser poll in or out from the telemetry it had.
    const live = {
      coords: {
        accuracy: 12,
        altitude: 259,
        altitudeAccuracy: 3,
        heading: 118,
        latitude: 44.9505,
        longitude: -93.2466,
        speed: 1.8
      },
      timestamp: 1789687530052,
      toJSON() {
        return { coords: this.coords, timestamp: this.timestamp }
      }
    } as unknown as GeolocationPosition

    const tagged = tagBrowserPosition(live)
    expect(tagged.source).toBe(POSITION_SOURCE_BROWSER)
    expect(JSON.parse(JSON.stringify(tagged)).source).toBe(
      POSITION_SOURCE_BROWSER
    )
    // ...and the original, annotated in place, would have lost it.
    expect(
      JSON.parse(JSON.stringify(Object.assign(live, { source: 'browser' })))
        .source
    ).toBeUndefined()
    expect(tagged.coords.latitude).toBe(44.9505)
    expect(tagged.timestamp).toBe(1789687530052)
  })
})
