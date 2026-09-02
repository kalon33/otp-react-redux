import { act } from 'react-dom/test-utils'
import { encode } from '@mapbox/polyline'
import React from 'react'
import ReactDOM from 'react-dom'

import '../../test-utils/mock-window-url'
import {
  ARRIVED_DISTANCE_FILTER_METERS,
  LIVE_DISTANCE_FILTER_METERS,
  nativeGpsDistanceFilterFor,
  shouldRestartNativeWatcher,
  shouldReuseGoModePosition,
  shouldSeedProgressFromLastFix
} from '../../../lib/util/go-mode/tracking-gates'
import {
  nativeGpsDistanceFilter,
  setNativeGpsDistanceFilter,
  startNativeGps,
  stopNativeGps
} from '../../../lib/util/go-mode/native-gps'
import { refreshCurrentPosition } from '../../../lib/actions/location'
import { restoreDateNowBehavior, setTestTime } from '../../test-utils'
import {
  startGoModeTracking,
  startPositionTracking
} from '../../../lib/actions/go-mode'
import goModeReducer from '../../../lib/reducers/go-mode'
import useActiveTripGuards from '../../../lib/components/go-mode/use-active-trip-guards'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchRerouteSnapshotPlan: jest.fn(() => () => Promise.resolve(null)),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve(null))
}))

/**
 * IDLING THE RADIO, NOT JUST ITS CONSUMERS — and the blank screen that came
 * with the same fault.
 *
 * Session 1.3 tapered the post-arrival stream where the fixes LAND: a funnel in
 * `handlePositionUpdate` drops anything closer together than
 * `ARRIVED_TRACKING_INTERVAL_MS`, which removed ~15,955 of one ride's 16,740
 * post-arrival actions. The chip never heard about it. `native-gps.ts` armed
 * `addWatcher` with `distanceFilter: 0` and `stopNativeGps` was called only
 * from `endGoMode`, so a phone whose rider had arrived kept producing ~1 fix/s
 * for as long as the trip stayed open — 5,318 of them across 88 parked minutes
 * on 2026-08-28 — and the battery cost was exactly what it had always been.
 *
 * Idling it is one line of plugin config and one genuine coupling: a parked
 * phone under a distance filter delivers NOTHING, and nothing is precisely what
 * `GPS_WATCHDOG_MS` is built to treat as a wedged watcher. Left alone the
 * watchdog would tear the idled watcher down and rebuild it every window
 * forever, which costs more than never idling at all. So arrival has to
 * suppress the restart in the same change — that coupling is why 1.3 left this
 * out rather than bolting it on.
 *
 * The 2026-08-31 ride (session `mthnk1al-x7m0iv`) supplies the other half.
 * A wedged watcher, the watchdog, and a replan landed on the same second:
 *
 *   17:15:01  UPDATE_POSITION (accuracy 1254.7 m)  <- last fix for a minute
 *   17:15:01  START_GO_MODE (boarded-earlier auto-replan) -> progress: null
 *   17:16:01  console.warn "GPS watchdog: no fix for 60s — restarting"
 *   17:16:01  UPDATE_POSITION (accuracy 1615.3 m)  <- one fix, then quiet again
 *   17:17:01  console.warn "GPS watchdog: no fix for 60s — restarting"
 *   17:17:12  UPDATE_POSITION (accuracy 1414.0 m)  <- stream back
 *
 * The rider was on a platform reading "Starting Trip… / Acquiring GPS signal…"
 * and wrote "What's going on / Why don't you answer me". Three separate things
 * are wrong in those six lines: a 45 s rule that fires at 60 s because the
 * check runs every 30 s; a restart nobody re-checks, so an unproven one costs a
 * second full window; and a boot card shown to a rider whose position the app
 * had in the store the whole time.
 */

const NOW = Date.UTC(2026, 7, 31, 22, 15, 1)

describe('the distance filter the watcher should be holding', () => {
  it('streams every fix while the trip is live', () => {
    expect(nativeGpsDistanceFilterFor(false)).toBe(LIVE_DISTANCE_FILTER_METERS)
    expect(nativeGpsDistanceFilterFor(false)).toBe(0)
  })

  it('goes coarse once the rider has arrived', () => {
    expect(nativeGpsDistanceFilterFor(true)).toBe(
      ARRIVED_DISTANCE_FILTER_METERS
    )
    // Gentle on purpose: far enough that a parked phone produces nothing, near
    // enough that walking back out re-establishes the stream within a block.
    expect(ARRIVED_DISTANCE_FILTER_METERS).toBe(50)
  })
})

describe('the watchdog decision', () => {
  const base = {
    arrived: false,
    maxFastRetries: 2,
    restartsSinceLastFix: 0,
    retryMs: 20000,
    silenceMs: 0,
    watchdogMs: 45000
  }

  it('leaves a healthy stream alone', () => {
    expect(shouldRestartNativeWatcher({ ...base, silenceMs: 30000 })).toBe(
      false
    )
  })

  it('restarts a wedged watcher after the ordinary budget', () => {
    expect(shouldRestartNativeWatcher({ ...base, silenceMs: 46000 })).toBe(true)
  })

  it('never restarts after arrival — the silence is the point', () => {
    // The idled watcher is under a 50 m filter and the rider is standing at
    // their door. Ten minutes of nothing is success, not a wedge.
    expect(
      shouldRestartNativeWatcher({
        ...base,
        arrived: true,
        silenceMs: 600000
      })
    ).toBe(false)
  })

  it('re-checks an unproven restart on the short window', () => {
    // 2026-08-31 17:16:01: the restart delivered one cell-tower fix and wedged
    // again. Under the old rule the rider waited until 17:17:01 for the retry.
    expect(
      shouldRestartNativeWatcher({
        ...base,
        restartsSinceLastFix: 1,
        silenceMs: 21000
      })
    ).toBe(true)
  })

  it('backs off once the fast retries are spent', () => {
    // A radio that is genuinely dead must not be torn down every 20 s for the
    // rest of the trip.
    expect(
      shouldRestartNativeWatcher({
        ...base,
        restartsSinceLastFix: 3,
        silenceMs: 21000
      })
    ).toBe(false)
    expect(
      shouldRestartNativeWatcher({
        ...base,
        restartsSinceLastFix: 3,
        silenceMs: 46000
      })
    ).toBe(true)
  })
})

describe('the boot-card seed decision', () => {
  const base = {
    hasProgress: false,
    lastPositionMs: NOW - 1000,
    maxAgeMs: 120000,
    nowMs: NOW
  }

  it('fills the card from the fix that was already in the store', () => {
    expect(shouldSeedProgressFromLastFix(base)).toBe(true)
  })

  it('leaves a screen that already has progress alone', () => {
    expect(shouldSeedProgressFromLastFix({ ...base, hasProgress: true })).toBe(
      false
    )
  })

  it('will not place the rider at a stale fix', () => {
    expect(
      shouldSeedProgressFromLastFix({ ...base, lastPositionMs: NOW - 600000 })
    ).toBe(false)
    expect(
      shouldSeedProgressFromLastFix({ ...base, lastPositionMs: null })
    ).toBe(false)
  })

  it('ignores a fix from the future — a stepped device clock is not evidence', () => {
    expect(
      shouldSeedProgressFromLastFix({ ...base, lastPositionMs: NOW + 5000 })
    ).toBe(false)
  })
})

describe('the planner poll decision', () => {
  const base = {
    lastPositionMs: NOW - 1000,
    maxAgeMs: 60000,
    nowMs: NOW,
    trackingActive: true
  }

  it('answers from Go Mode’s own stream during a trip', () => {
    expect(shouldReuseGoModePosition(base)).toBe(true)
  })

  it('asks the radio when there is no trip', () => {
    expect(shouldReuseGoModePosition({ ...base, trackingActive: false })).toBe(
      false
    )
  })

  it('asks the radio when Go Mode’s own fix has gone stale', () => {
    // A wedged watcher is exactly when the planner SHOULD spend an acquisition.
    expect(
      shouldReuseGoModePosition({ ...base, lastPositionMs: NOW - 90000 })
    ).toBe(false)
  })
})

/** A stand-in for the Capacitor background-geolocation bridge. */
const installBridge = () => {
  const addWatcher = jest.fn(async () => 'watcher-1')
  const removeWatcher = jest.fn(async () => undefined)
  ;(window as any).Capacitor = {
    isNativePlatform: () => true,
    Plugins: { BackgroundGeolocation: { addWatcher, removeWatcher } }
  }
  return { addWatcher, removeWatcher }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('re-arming the native watcher', () => {
  let plugin: ReturnType<typeof installBridge>

  beforeEach(() => {
    plugin = installBridge()
  })

  afterEach(async () => {
    await stopNativeGps()
    delete (window as any).Capacitor
  })

  it('arms every fix by default', async () => {
    await startNativeGps(
      () => undefined,
      () => undefined
    )
    expect(plugin.addWatcher.mock.calls[0][0]).toMatchObject({
      distanceFilter: 0
    })
    expect(nativeGpsDistanceFilter()).toBe(0)
  })

  it('re-arms coarse when the filter changes — the plugin has no setter', async () => {
    await startNativeGps(
      () => undefined,
      () => undefined
    )
    const rearmed = await setNativeGpsDistanceFilter(
      ARRIVED_DISTANCE_FILTER_METERS,
      () => undefined,
      () => undefined
    )
    expect(rearmed).toBe(true)
    expect(plugin.removeWatcher).toHaveBeenCalledTimes(1)
    expect(plugin.addWatcher).toHaveBeenCalledTimes(2)
    expect(plugin.addWatcher.mock.calls[1][0]).toMatchObject({
      distanceFilter: 50
    })
    expect(nativeGpsDistanceFilter()).toBe(50)
  })

  it('does not churn a watcher that already holds the filter', async () => {
    await startNativeGps(
      () => undefined,
      () => undefined
    )
    await setNativeGpsDistanceFilter(
      ARRIVED_DISTANCE_FILTER_METERS,
      () => undefined,
      () => undefined
    )
    const again = await setNativeGpsDistanceFilter(
      ARRIVED_DISTANCE_FILTER_METERS,
      () => undefined,
      () => undefined
    )
    expect(again).toBe(false)
    expect(plugin.addWatcher).toHaveBeenCalledTimes(2)
    expect(plugin.removeWatcher).toHaveBeenCalledTimes(1)
  })
})

const initial = goModeReducer(undefined, { type: '@@INIT' })

const trackingStore = (goModeOverrides: any = {}) => {
  let goModeState: any = { ...initial, isActive: true, ...goModeOverrides }
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    goModeState = goModeReducer(goModeState, action)
    return action
  }
  return {
    arrive: (at: number) => {
      goModeState = { ...goModeState, arrivedAt: at }
    },
    run: (thunk: any) => thunk(dispatch, getState),
    types: () => actions.map((a) => a.type)
  }
}

describe('startPositionTracking on the native path', () => {
  let plugin: ReturnType<typeof installBridge>
  let warn: jest.SpyInstance
  let clock = NOW

  /**
   * The watchdog measures silence on the WALL clock and looks on a timer, so
   * both have to move together — advancing only the timers makes every check
   * see zero silence, and advancing only Date.now never runs a check.
   */
  const tick = async (ms: number) => {
    clock += ms
    jest.advanceTimersByTime(ms)
    await flush()
  }

  beforeEach(() => {
    jest.useFakeTimers()
    clock = NOW
    jest.spyOn(Date, 'now').mockImplementation(() => clock)
    plugin = installBridge()
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    jest.clearAllTimers()
    jest.useRealTimers()
    warn.mockRestore()
    ;(Date.now as jest.Mock).mockRestore()
    await stopNativeGps()
    delete (window as any).Capacitor
  })

  it('idles the radio when the trip it resumes has already arrived', async () => {
    // The path the 2026-08-31 18:52 mount took: a finished trip picked back up.
    // Before this change the watcher was armed at distanceFilter 0 and the
    // phone streamed 1 Hz for 104 minutes, parked 41 m from its door.
    const store = trackingStore({ arrivedAt: NOW - 60000 })
    store.run(startPositionTracking())
    await flush()
    expect(plugin.addWatcher.mock.calls[0][0]).toMatchObject({
      distanceFilter: 50
    })
  })

  it('idles the radio at arrival, on a watcher that is already streaming', async () => {
    const store = trackingStore()
    store.run(startPositionTracking())
    await flush()
    expect(plugin.addWatcher.mock.calls[0][0]).toMatchObject({
      distanceFilter: 0
    })

    // What the arrival branch of handlePositionUpdate does: set arrivedAt, then
    // re-enter startPositionTracking.
    store.arrive(NOW)
    store.run(startPositionTracking())
    await flush()
    expect(plugin.removeWatcher).toHaveBeenCalledTimes(1)
    expect(plugin.addWatcher.mock.calls[1][0]).toMatchObject({
      distanceFilter: 50
    })
  })

  it('leaves a healthy live watcher alone when nothing has changed', async () => {
    const store = trackingStore()
    store.run(startPositionTracking())
    await flush()
    store.run(startPositionTracking())
    await flush()
    expect(plugin.removeWatcher).not.toHaveBeenCalled()
    expect(plugin.addWatcher).toHaveBeenCalledTimes(1)
  })

  it('does not restart the idled watcher for being silent after arrival', async () => {
    const store = trackingStore({ arrivedAt: NOW - 60000 })
    store.run(startPositionTracking())
    await flush()
    plugin.addWatcher.mockClear()
    plugin.removeWatcher.mockClear()

    // Ten minutes of a parked phone under a 50 m filter: no fixes at all, which
    // is what the watchdog is built to read as a wedge.
    await tick(600000)

    expect(plugin.removeWatcher).not.toHaveBeenCalled()
    expect(plugin.addWatcher).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('restarts a wedged live watcher, then re-checks the restart quickly', async () => {
    const store = trackingStore()
    store.run(startPositionTracking())
    await flush()
    plugin.addWatcher.mockClear()

    // 45 s budget, 15 s poll: the first check past the budget is at 60 s of
    // silence at worst — the 08-31 number — and the restart is issued there.
    await tick(46000)
    expect(plugin.addWatcher).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)

    // The restart delivered nothing. Under the old single-budget rule the next
    // attempt was another 45+ s away; it is now 20.
    await tick(21000)
    expect(plugin.addWatcher).toHaveBeenCalledTimes(2)

    // ...and then it backs off: two fast retries, not an endless 20 s churn.
    await tick(21000)
    expect(plugin.addWatcher).toHaveBeenCalledTimes(3)
    await tick(21000)
    expect(plugin.addWatcher).toHaveBeenCalledTimes(3)
  })
})

describe('the planner’s 30-second current-location poll', () => {
  const intl: any = { formatMessage: () => '' }

  beforeEach(() => setTestTime(NOW))
  afterEach(restoreDateNowBehavior)

  const positionAt = (timestamp: number): any => ({
    coords: { accuracy: 8, latitude: 44.919, longitude: -93.274 },
    timestamp
  })

  const run = (goMode: any) => {
    const dispatched: any[] = []
    const getState = () => ({ otp: { goMode } })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      dispatched.push(action)
      return action
    }
    refreshCurrentPosition(intl)(dispatch, getState)
    return dispatched
  }

  it('answers out of the trip’s own stream instead of waking the chip', () => {
    const geolocation = { getCurrentPosition: jest.fn() }
    ;(navigator as any).geolocation = geolocation
    const actions = run({
      isActive: true,
      tracking: { lastPosition: positionAt(NOW - 1000) }
    })
    expect(geolocation.getCurrentPosition).not.toHaveBeenCalled()
    expect(actions.map((a) => a.type)).toEqual(['POSITION_RESPONSE'])
    expect(actions[0].payload.position.timestamp).toBe(NOW - 1000)
  })

  it('still asks the radio when no trip is running', () => {
    const geolocation = { getCurrentPosition: jest.fn() }
    ;(navigator as any).geolocation = geolocation
    const actions = run({
      isActive: false,
      tracking: { lastPosition: positionAt(NOW - 1000) }
    })
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1)
    expect(actions.map((a) => a.type)).toEqual(['POSITION_FETCHING'])
  })

  it('still asks the radio when the trip’s own fix has gone stale', () => {
    const geolocation = { getCurrentPosition: jest.fn() }
    ;(navigator as any).geolocation = geolocation
    const actions = run({
      isActive: true,
      tracking: { lastPosition: positionAt(NOW - 120000) }
    })
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1)
    expect(actions.map((a) => a.type)).toEqual(['POSITION_FETCHING'])
  })
})

const ORIGIN: [number, number] = [44.9199, -93.2748]
const DEST: [number, number] = [44.9, -93.29]

const walkItinerary = (endTime: number) => ({
  duration: 1800,
  endTime,
  legs: [
    {
      distance: 3800,
      duration: 1800,
      endTime,
      from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Origin' },
      legGeometry: { points: encode([ORIGIN, DEST]) },
      mode: 'WALK',
      startTime: endTime - 1800000,
      to: { lat: DEST[0], lon: DEST[1], name: 'Destination' },
      transitLeg: false
    }
  ],
  startTime: endTime - 1800000
})

const fixAt = (timestamp: number): any => ({
  coords: {
    accuracy: 8,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    latitude: ORIGIN[0],
    longitude: ORIGIN[1],
    speed: 1.2
  },
  timestamp
})

/**
 * The rider-facing half: "Starting Trip… / Acquiring GPS signal…" on a bus
 * platform, mid-ride, at 17:15:01 on 2026-08-31.
 */
describe('the boot card after a mid-trip replan', () => {
  beforeEach(() => setTestTime(NOW))
  afterEach(restoreDateNowBehavior)

  const swapStore = (lastPositionMs: number | null) =>
    trackingStore({
      activeItinerary: walkItinerary(NOW + 1800000),
      progress: null,
      tracking: {
        ...initial.tracking,
        isTracking: true,
        lastPosition: lastPositionMs == null ? null : fixAt(lastPositionMs)
      }
    })

  it('draws the trip from the fix already in the store instead of a boot screen', async () => {
    // START_GO_MODE has just nulled progress. The last fix is one second old —
    // 17:15:01 — and the watcher is about to stay silent for a minute.
    const store = swapStore(NOW - 1000)
    await store.run(startGoModeTracking(walkItinerary(NOW + 1800000)))
    expect(store.types()).toContain('UPDATE_PROGRESS')
  })

  it('shows the honest card rather than a stale position', async () => {
    const store = swapStore(NOW - 600000)
    await store.run(startGoModeTracking(walkItinerary(NOW + 1800000)))
    expect(store.types()).not.toContain('UPDATE_PROGRESS')
  })

  it('shows the honest card when there is no fix at all', async () => {
    const store = swapStore(null)
    await store.run(startGoModeTracking(walkItinerary(NOW + 1800000)))
    expect(store.types()).not.toContain('UPDATE_PROGRESS')
  })
})

/**
 * Backlog 4.16. The wake lock failed exactly twice in a week of telemetry, both
 * on the 2026-08-31 18:52 mounts, both "NotAllowedError: Permission was
 * denied" — and those are the only two sessions in that week where Go Mode was
 * already active at page load. `cb453726` added the visibility and focus
 * retries; what neither can promise is that the shell fires either event on
 * the path that failed, because visibilityState was "visible" throughout and
 * whether WKWebView delivers a window `focus` on becoming active is not
 * something the log can answer. A short bounded ladder does not need to know.
 */
describe('wake lock: retrying a refusal at load (2026-08-31)', () => {
  let container: HTMLDivElement

  const Harness = () => {
    useActiveTripGuards(true)
    return null
  }

  beforeEach(() => {
    jest.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible'
    })
  })

  afterEach(() => {
    act(() => {
      ReactDOM.unmountComponentAtNode(container)
    })
    container.remove()
    delete (navigator as any).wakeLock
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  const installWakeLock = (results: any[]) => {
    const request = jest.fn(() => {
      const next = results.shift()
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next ?? { release: jest.fn() })
    })
    ;(navigator as any).wakeLock = { request }
    return request
  }

  const flushMicrotasks = async () => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const denied = () => {
    const err = new Error('Permission was denied')
    err.name = 'NotAllowedError'
    return err
  }

  it('asks again a few seconds later, without waiting for an event', async () => {
    const lock = { release: jest.fn() }
    const request = installWakeLock([denied(), lock])
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await act(async () => {
      ReactDOM.render(React.createElement(Harness), container)
    })
    await flushMicrotasks()
    expect(request).toHaveBeenCalledTimes(1)

    await act(async () => {
      jest.advanceTimersByTime(5000)
    })
    await flushMicrotasks()
    expect(request).toHaveBeenCalledTimes(2)
    ;(console.warn as jest.Mock).mockRestore()
  })

  it('stops asking once it holds a lock', async () => {
    const request = installWakeLock([denied(), { release: jest.fn() }])
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await act(async () => {
      ReactDOM.render(React.createElement(Harness), container)
    })
    await flushMicrotasks()
    await act(async () => {
      jest.advanceTimersByTime(30000)
    })
    await flushMicrotasks()
    // One refusal, one grant, and then silence — not a timer for the rest of
    // the trip.
    expect(request).toHaveBeenCalledTimes(2)
    ;(console.warn as jest.Mock).mockRestore()
  })

  it('gives up after a bounded ladder when the platform simply refuses', async () => {
    const request = installWakeLock([
      denied(),
      denied(),
      denied(),
      denied(),
      denied(),
      denied(),
      denied()
    ])
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await act(async () => {
      ReactDOM.render(React.createElement(Harness), container)
    })
    await flushMicrotasks()
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        jest.advanceTimersByTime(5000)
      })
      await flushMicrotasks()
    }
    // The first attempt plus WAKE_LOCK_RETRIES.
    expect(request).toHaveBeenCalledTimes(5)
    ;(console.warn as jest.Mock).mockRestore()
  })
})
