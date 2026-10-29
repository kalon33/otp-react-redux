import '../../test-utils/mock-window-url'

/**
 * A STOP ALWAYS WINS — the native watcher may not outlive the trip that armed
 * it (backlog 75.21).
 *
 * `restartNativeGps` (the GPS watchdog, after 45 s of silence) and
 * `setNativeGpsDistanceFilter` (arrival, every swap) both tear the watcher down
 * and then arm a new one, awaiting the plugin's `removeWatcher` in between. On
 * otprr main 3a7050816 a Stop that landed inside that round trip lost:
 * `endGoMode`'s `stopNativeGps()` found `watcherId` already null and nothing
 * arming and returned, and the restart then resumed and armed a fresh watcher
 * for a trip that no longer existed — the iOS location indicator and the
 * battery draw until the next trip or an app kill, every fix it delivered fed
 * into `handlePositionUpdate`. The mirror case: a stop awaiting an in-flight
 * start removed the watcher a NEW trip's start (`handleRetry` = `endGoMode()`
 * then `beginGoMode()`) had just been handed, leaving that trip with no stream
 * until its own watchdog restarted one at least 45 s later.
 *
 * The plugin is modelled with real latencies on fake timers: `addWatcher`
 * answers after ADD_MS, `removeWatcher` after REMOVE_MS (not measured on a
 * phone — the row says so; the numbers only have to be non-zero). `live` is
 * the plugin's own view: a watcher is live from the moment it is added until
 * its removal completes.
 */

const ADD_MS = 30
const REMOVE_MS = 120

type NativeGps = typeof import('../../../lib/util/go-mode/native-gps')

const installTimedBridge = () => {
  const live = new Set<string>()
  const callbacks = new Map<string, any>()
  let n = 0
  const addWatcher = jest.fn(
    (_opts: any, cb: any) =>
      new Promise<string>((resolve) => {
        const id = `watcher-${++n}`
        callbacks.set(id, cb)
        live.add(id)
        setTimeout(() => resolve(id), ADD_MS)
      })
  )
  const removeWatcher = jest.fn(
    ({ id }: { id: string }) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          live.delete(id)
          resolve()
        }, REMOVE_MS)
      })
  )
  ;(window as any).Capacitor = {
    isNativePlatform: () => true,
    Plugins: { BackgroundGeolocation: { addWatcher, removeWatcher } }
  }
  return { addWatcher, callbacks, live, removeWatcher }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Advance the fake clock in small steps, letting promise chains run between. */
const advance = async (ms: number) => {
  for (let t = 0; t < ms; t += 5) {
    jest.advanceTimersByTime(5)
    await flush()
  }
}

const fix = (lat: number) => ({
  accuracy: 8,
  altitude: null,
  altitudeAccuracy: null,
  bearing: null,
  latitude: lat,
  longitude: -93.265,
  simulated: false,
  speed: 4,
  time: 1793304000000
})

describe('75.21 — a stop that lands mid-re-arm ends the stream', () => {
  let gps: NativeGps
  let plugin: ReturnType<typeof installTimedBridge>

  beforeEach(() => {
    jest.useFakeTimers()
    // Fresh module state per test: the watcher bookkeeping is module-level.
    jest.resetModules()
    plugin = installTimedBridge()
    gps = require('../../../lib/util/go-mode/native-gps')
  })

  afterEach(() => {
    jest.useRealTimers()
    delete (window as any).Capacitor
  })

  /** The trip's own watcher, live and published. */
  const armTrip = async (onPosition = jest.fn()) => {
    const started = gps.startNativeGps(onPosition, jest.fn())
    await advance(ADD_MS + 5)
    expect(await started).toBe(true)
    expect(plugin.live.size).toBe(1)
    return onPosition
  }

  it('the watchdog restart does not re-arm after endGoMode stopped the stream', async () => {
    await armTrip()
    // The watchdog fires restartNativeGps un-awaited from its interval...
    const restart = gps.restartNativeGps(jest.fn(), jest.fn(), {
      distanceFilter: 0
    })
    await advance(50)
    // ...and the rider taps Stop inside the removeWatcher round trip.
    // endGoMode: stopGpsWatchdog() (the interval, not this restart), then
    // stopNativeGps().
    await flush()
    const stop = gps.stopNativeGps()
    await advance(REMOVE_MS + ADD_MS + 50)
    await stop

    // Before: the restart resumed and armed watcher-2 for the ended trip.
    expect(Array.from(plugin.live)).toEqual([])
    expect(plugin.addWatcher).toHaveBeenCalledTimes(1)
    expect(await restart).toBe(false)
    expect(gps.nativeGpsDistanceFilter()).toBeNull()
  })

  it('the arrival filter change does not re-arm after a stop either', async () => {
    await armTrip()
    const rearm = gps.setNativeGpsDistanceFilter(50, jest.fn(), jest.fn())
    await advance(40)
    const stop = gps.stopNativeGps()
    await advance(REMOVE_MS + ADD_MS + 50)
    await stop

    expect(Array.from(plugin.live)).toEqual([])
    expect(plugin.addWatcher).toHaveBeenCalledTimes(1)
    expect(await rearm).toBe(false)
    expect(gps.nativeGpsDistanceFilter()).toBeNull()
  })

  it('a stop while the restart is RE-ADDING removes the new watcher too', async () => {
    await armTrip()
    const restart = gps.restartNativeGps(jest.fn(), jest.fn(), {
      distanceFilter: 0
    })
    // Past the teardown: the restart's addWatcher is now in flight.
    await advance(REMOVE_MS + 10)
    expect(plugin.addWatcher).toHaveBeenCalledTimes(2)
    const stop = gps.stopNativeGps()
    await advance(ADD_MS + REMOVE_MS + 50)
    await stop
    await restart

    expect(plugin.live.size).toBe(0)
    expect(gps.nativeGpsDistanceFilter()).toBeNull()
  })

  it('a fix the stopped watcher delivers before its removal completes reaches nobody', async () => {
    const onPosition = await armTrip()
    const emit = plugin.callbacks.get('watcher-1')
    emit(fix(44.97), null)
    expect(onPosition).toHaveBeenCalledTimes(1)

    const stop = gps.stopNativeGps()
    // The plugin has not answered removeWatcher yet; the watcher still fires.
    await advance(20)
    expect(plugin.live.has('watcher-1')).toBe(true)
    emit(fix(44.971), null)
    emit(undefined, { code: 'NOT_AUTHORIZED', message: 'late' })
    await advance(REMOVE_MS)
    await stop

    expect(onPosition).toHaveBeenCalledTimes(1)
  })

  it("Retry (endGoMode then beginGoMode inside addWatcher's latency) leaves the new trip ONE live watcher", async () => {
    // Trip 1's start is still arming when the rider retries.
    const trip1 = jest.fn()
    const trip2 = jest.fn()
    const first = gps.startNativeGps(trip1, jest.fn())
    await advance(10)
    const stop = gps.stopNativeGps()
    const second = gps.startNativeGps(trip2, jest.fn())
    await advance(ADD_MS + REMOVE_MS + 50)
    await stop

    // Before: `second` shared trip 1's start, the stop then removed it, and
    // the new trip had no stream at all.
    expect(plugin.live.size).toBe(1)
    expect(await second).toBe(true)
    expect(await first).toBe(false)
    expect(gps.nativeGpsDistanceFilter()).toBe(0)
    // ...and it is the new trip's watcher, delivering to the new trip.
    const [liveId] = Array.from(plugin.live)
    plugin.callbacks.get(liveId)(fix(44.98), null)
    expect(trip2).toHaveBeenCalledTimes(1)
    expect(trip1).not.toHaveBeenCalled()
  })

  it('a restart with no stop still re-arms (the watchdog keeps working)', async () => {
    const onPosition = jest.fn()
    await armTrip()
    const restart = gps.restartNativeGps(onPosition, jest.fn(), {
      distanceFilter: 0
    })
    await advance(REMOVE_MS + ADD_MS + 50)
    expect(await restart).toBe(true)
    expect(plugin.addWatcher).toHaveBeenCalledTimes(2)
    expect(plugin.live.size).toBe(1)
    expect(gps.nativeGpsDistanceFilter()).toBe(0)
  })
})
