import '../../test-utils/mock-window-url'
import { encode } from '@mapbox/polyline'
import { readFileSync } from 'fs'
import path from 'path'

import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { restoreDateNowBehavior, setTestTime } from '../../test-utils'
import {
  startGoModeTracking,
  startPositionTracking
} from '../../../lib/actions/go-mode'
import { stopNativeGps } from '../../../lib/util/go-mode/native-gps'
import goModeReducer from '../../../lib/reducers/go-mode'
import GoModeScreen from '../../../lib/components/go-mode/GoModeScreen'

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
// Only the error / boot branches of the screen are drawn here.
jest.mock('../../../lib/components/mobile/navigation-bar', () => () => null)
jest.mock(
  '../../../lib/components/go-mode/use-active-trip-guards',
  () => () => undefined
)

/**
 * Backlog 75.10. Chaos agent C20 (2026-10-29, `chaos/s8-permissions.js
 * denied`, `$S/chaos/s8-permissions/result-denied_unavailable.json`): Start
 * Trip with location permission denied → +20 s "Starting Trip… / Acquiring GPS
 * signal…", `tracking.lastPosition null`, `progress null`, no
 * `SET_TRACKING_ERROR` at all; permission granted and a position set → +25 s
 * unchanged, though the planner's own poll got the fix (`POSITION_RESPONSE`
 * 00:39:23.038). On otprr main 3a7050816 `startGoModeTracking` read the
 * permission, saw `'denied'`, and simply did not start tracking — so the
 * screen's own "Location permission denied" card (it renders only on
 * `tracking.error`) was unreachable, and with no poll running nothing ever
 * asked again. The fix asks anyway: the poll's own PERMISSION_DENIED is the
 * card, and the same poll recovers the trip once location is allowed.
 *
 * The browser here behaves as Chrome and Safari do: with the permission
 * denied, `getCurrentPosition` answers at once with error code 1 (no prompt);
 * once granted, with a fix.
 */

/** Jest maps i18n/*.yml to {}, so read the shipped English copy. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flatten(node: any, prefix = '', out: Record<string, string> = {}) {
  Object.entries(node || {}).forEach(([key, value]) => {
    const id = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[id] = value
    else flatten(value, id, out)
  })
  return out
}
const messages = flatten(
  yaml.load(
    readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
  )
)

const NOW = 1793263163000 // 2026-10-29 00:39 CDT, the C20 run
const ORIGIN: [number, number] = [44.9205, -93.276]
const DEST: [number, number] = [44.9778, -93.2707]

const itinerary = {
  duration: 1800,
  endTime: NOW + 1800000,
  legs: [
    {
      distance: 3800,
      duration: 1800,
      endTime: NOW + 1800000,
      from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Test origin' },
      legGeometry: { points: encode([ORIGIN, DEST]) },
      mode: 'WALK',
      startTime: NOW,
      to: { lat: DEST[0], lon: DEST[1], name: 'Downtown Minneapolis' },
      transitLeg: false
    }
  ],
  startTime: NOW
}

const initial = goModeReducer(undefined, { type: '@@INIT' })

const tripStore = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let goModeState: any = {
    ...initial,
    activeItinerary: itinerary,
    isActive: true,
    progress: null
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    goModeState = goModeReducer(goModeState, action)
    return action
  }
  return {
    actions,
    goMode: () => goModeState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: (thunk: any) => thunk(dispatch, getState)
  }
}

let geolocation: { getCurrentPosition: jest.Mock }
let permission: PermissionState

/** A browser whose location permission is `state`, and can be changed. */
const installBrowser = (state: PermissionState) => {
  permission = state
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: jest.fn(async () => ({ state: permission })) }
  })
  geolocation = {
    getCurrentPosition: jest.fn((ok: any, fail: any) => {
      if (permission === 'denied') {
        fail({
          code: 1,
          message: 'User denied Geolocation',
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3
        })
        return
      }
      ok({
        coords: {
          accuracy: 10,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          latitude: ORIGIN[0],
          longitude: ORIGIN[1],
          speed: null
        },
        timestamp: Date.now()
      })
    })
  }
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: geolocation
  })
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const goModeState = (over: any = {}) => {
  const state = getMockInitialState()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const otp = state.otp as any
  otp.goMode = {
    ...initial,
    activeItinerary: itinerary,
    isActive: true,
    ...over
  }
  return state
}

describe('75.10 — location permission denied at Start Trip', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    setTestTime(NOW)
  })
  afterEach(async () => {
    jest.clearAllTimers()
    jest.useRealTimers()
    restoreDateNowBehavior()
    await stopNativeGps()
    delete (window as any).Capacitor
    delete (navigator as any).permissions
    delete (navigator as any).geolocation
  })

  it('asks anyway, and the refusal becomes the PERMISSION_DENIED tracking error', async () => {
    installBrowser('denied')
    const store = tripStore()
    await store.run(startGoModeTracking(itinerary as any))

    // Before: never asked, no SET_TRACKING_ERROR — the boot card forever.
    expect(geolocation.getCurrentPosition).toHaveBeenCalled()
    const errors = store.actions.filter((a) => a.type === 'SET_TRACKING_ERROR')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].payload.code).toBe(1)
    expect(store.goMode().tracking.error.code).toBe(1)
    expect(store.goMode().progress).toBeNull()
  })

  it("picks the trip up on the poll's next tick once the rider allows location", async () => {
    installBrowser('denied')
    const store = tripStore()
    await store.run(startGoModeTracking(itinerary as any))
    expect(store.goMode().tracking.error.code).toBe(1)

    // C20: permission granted at +20 s; before the fix nothing happened.
    permission = 'granted'
    jest.advanceTimersByTime(store.goMode().tracking.interval || 8000)

    const types = store.actions.map((a) => a.type)
    expect(types).toContain('UPDATE_POSITION')
    expect(store.goMode().tracking.error).toBeNull()
    expect(store.goMode().tracking.lastPosition.coords.latitude).toBe(ORIGIN[0])
    expect(store.goMode().progress).not.toBeNull()
  })

  it('a granted page starts tracking straight away, as before', async () => {
    installBrowser('granted')
    const store = tripStore()
    await store.run(startGoModeTracking(itinerary as any))
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1)
    expect(
      store.actions.filter((a) => a.type === 'SET_TRACKING_ERROR')
    ).toHaveLength(0)
    expect(store.goMode().progress).not.toBeNull()
  })
})

describe('75.10 — the screen leaves "Acquiring GPS signal…"', () => {
  afterEach(() => {
    delete (window as any).Capacitor
  })

  it('shows the permission card and Retry for the state the denied start produces', async () => {
    jest.useFakeTimers()
    setTestTime(NOW)
    installBrowser('denied')
    const store = tripStore()
    await store.run(startGoModeTracking(itinerary as any))
    jest.clearAllTimers()
    jest.useRealTimers()
    restoreDateNowBehavior()

    const { wrapper } = mockWithProvider(
      GoModeScreen,
      {},
      goModeState({ tracking: store.goMode().tracking }),
      messages
    )
    const text = wrapper.text()
    // Before: "Starting Trip..." / "Acquiring GPS signal...".
    expect(text).not.toContain('Acquiring GPS signal')
    expect(text).toContain(
      'Location permission denied. Please enable location access in your browser settings.'
    )
    expect(wrapper.find('button').map((b) => b.text())).toEqual(['Retry'])
    delete (navigator as any).permissions
    delete (navigator as any).geolocation
  })

  it('inside the app shell, says Settings and offers to open them', () => {
    const openSettings = jest.fn(async () => undefined)
    ;(window as any).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        BackgroundGeolocation: {
          addWatcher: jest.fn(),
          openSettings,
          removeWatcher: jest.fn()
        }
      }
    }
    const { store, wrapper } = mockWithProvider(
      GoModeScreen,
      {},
      goModeState({
        tracking: {
          ...initial.tracking,
          error: Object.assign(new Error('Permission denied.'), { code: 1 })
        }
      }),
      messages
    )
    expect(wrapper.text()).toContain(
      'Location permission denied. Please allow location access in Settings.'
    )
    const buttons = wrapper.find('button')
    expect(buttons.map((b) => b.text())).toEqual(['Open Settings', 'Retry'])
    buttons.at(0).simulate('click')
    expect(openSettings).toHaveBeenCalledTimes(1)
    // Retry is still the trip's own retry.
    buttons.at(1).simulate('click')
    expect(store.getActions().map((a: any) => a.type)).toContain('STOP_GO_MODE')
  })

  it('a non-permission error in the shell keeps the plain Retry', () => {
    const plugin = {
      addWatcher: jest.fn(),
      openSettings: jest.fn(),
      removeWatcher: jest.fn()
    }
    ;(window as any).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { BackgroundGeolocation: plugin }
    }
    const { wrapper } = mockWithProvider(
      GoModeScreen,
      {},
      goModeState({
        tracking: { ...initial.tracking, error: { code: 3 } }
      }),
      messages
    )
    expect(wrapper.find('button').map((b) => b.text())).toEqual(['Retry'])
    expect(plugin.openSettings).not.toHaveBeenCalled()
  })
})

describe('75.10 — the native shell asks the OS, not WebKit', () => {
  const installNative = () => {
    const callbacks: any[] = []
    const addWatcher = jest.fn(async (_opts: any, cb: any) => {
      callbacks.push(cb)
      return `watcher-${callbacks.length}`
    })
    ;(window as any).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        BackgroundGeolocation: {
          addWatcher,
          openSettings: jest.fn(),
          removeWatcher: jest.fn(async () => undefined)
        }
      }
    }
    return { addWatcher, callbacks }
  }

  beforeEach(() => {
    jest.useFakeTimers()
    setTestTime(NOW)
  })
  afterEach(async () => {
    jest.clearAllTimers()
    jest.useRealTimers()
    restoreDateNowBehavior()
    await stopNativeGps()
    delete (window as any).Capacitor
    delete (navigator as any).permissions
    delete (navigator as any).geolocation
  })

  it("arms the native watcher even if WebKit's own answer is 'denied'", async () => {
    installBrowser('denied')
    const plugin = installNative()
    const store = tripStore()
    await store.run(startGoModeTracking(itinerary as any))
    await flush()
    // Before: the web permission check ran first on every platform and a
    // 'denied' there meant the native stream was never started.
    expect(plugin.addWatcher).toHaveBeenCalledTimes(1)
    expect((navigator as any).permissions.query).not.toHaveBeenCalled()
  })

  it("reports the plugin's NOT_AUTHORIZED as PERMISSION_DENIED", async () => {
    const plugin = installNative()
    const store = tripStore()
    store.run(startPositionTracking())
    await flush()
    plugin.callbacks[0](undefined, {
      code: 'NOT_AUTHORIZED',
      message: 'Permission denied.'
    })
    const error = store.goMode().tracking.error
    expect(error.code).toBe(1)
    expect(error.message).toBe('Permission denied.')
  })

  it('any other plugin error stays as it was', async () => {
    const plugin = installNative()
    const store = tripStore()
    store.run(startPositionTracking())
    await flush()
    plugin.callbacks[0](undefined, {
      message: 'The operation couldn’t be completed.'
    })
    expect(store.goMode().tracking.error.code).toBeUndefined()
  })
})
