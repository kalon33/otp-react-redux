import { act } from 'react-dom/test-utils'
import { encode } from '@mapbox/polyline'
import React from 'react'
import ReactDOM from 'react-dom'

import '../../test-utils/mock-window-url'
import {
  clearGoModeSession,
  loadGoModeSession,
  saveGoModeSession
} from '../../../lib/util/go-mode/session-persistence'
import { getInitialState } from '../../../lib/reducers/create-otp-reducer'
import { handlePositionUpdate } from '../../../lib/actions/go-mode'
import { restoreDateNowBehavior, setTestTime } from '../../test-utils'
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
  }))
}))

const initial = goModeReducer(undefined, { type: '@@INIT' })

/**
 * 2026-08-31 18:52 (sessions mthw7svy-s4msqc and mthw8o2w-i8z1i6): the app
 * re-mounted twice, 41 s apart, onto a trip that was already FINISHED — leg 3,
 * progress frozen at 76.36%, status "completed", the rider standing within a
 * metre of one spot 41 m from their destination.
 *
 * Every ride-shaped subsystem restarted as if the trip had just begun, because
 * the one fact that says otherwise — goMode.arrivedAt — was neither saved nor
 * restored. Each mount re-derived its own arrival, replayed the whole
 * notification stack from an empty sentNotifications ("Board 546 to Old
 * Shakopee Rd" and "You have arrived at your destination!" in the same
 * second), and then tracked a stationary rider for 104 minutes: 6,100
 * position/route-match/progress triples and 68 reroute plan() calls, ending
 * only when the phone stopped reporting at 20:36:52.
 *
 * (The ride note read the 08-31 log alone and stopped at the UTC midnight file
 * boundary, so it counted 56 triples and 4 reroutes over 7m41s. The session
 * continues in debug-2026-09-01.jsonl.)
 *
 * The 2026-08-30 post-arrival funnel (74cfc095) was not at fault and was not
 * even present: neither 18:52 session emitted the `bundle` session event added
 * on 08-29, so both ran a web bundle older than the funnel by a day and a half.
 * What IS at fault is that a finished trip could be resumed as a live one at
 * all.
 */

const ORIGIN: [number, number] = [44.95, -93.29]
const DEST: [number, number] = [44.98, -93.27]

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

const fixAt = (
  [lat, lon]: [number, number],
  timestamp: number
): GeolocationPosition =>
  ({
    coords: {
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: lat,
      longitude: lon,
      speed: 0
    },
    timestamp
  } as GeolocationPosition)

/** Same minimal harness as arrival-quiesce-0828: real reducer, recorded thunks. */
const makeStore = (goModeOverrides: any = {}) => {
  let goModeState: any = { ...initial, ...goModeOverrides }
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
    if (typeof action === 'function') return undefined
    actions.push(action)
    goModeState = goModeReducer(goModeState, action)
    return action
  }
  return {
    actions: () => actions,
    getGoMode: () => goModeState,
    run: (thunk: any) => thunk(dispatch, getState),
    types: () => actions.map((a) => a.type)
  }
}

/** Write a saved Go Mode trip straight into storage, the way a real save left it. */
const storeSavedTrip = (now: number, arrivedAt: number | null) => {
  window.localStorage.setItem(
    'otp.goModeSession',
    JSON.stringify({
      activeItinerary: walkItinerary(now - 60_000),
      arrivedAt,
      departureOverride: null,
      originalFrom: null,
      riding: null,
      startedAt: now - 1_800_000,
      vehicleMatch: null
    })
  )
}

describe('post-arrival resume — the trip that came back from the dead (2026-08-31)', () => {
  const NOW = Date.UTC(2026, 7, 31, 23, 52, 55)

  beforeEach(() => {
    window.localStorage.clear()
    clearGoModeSession()
    setTestTime(NOW)
  })

  afterEach(restoreDateNowBehavior)

  describe('what gets saved', () => {
    it('saves arrivedAt — the one fact that says the trip is over', () => {
      saveGoModeSession({
        ...initial,
        activeItinerary: walkItinerary(NOW - 60_000),
        arrivedAt: NOW - 30_000,
        isActive: true
      } as any)
      expect(loadGoModeSession()?.arrivedAt).toBe(NOW - 30_000)
    })

    it('saves null for a trip still under way', () => {
      saveGoModeSession({
        ...initial,
        activeItinerary: walkItinerary(NOW + 600_000),
        isActive: true
      } as any)
      expect(loadGoModeSession()?.arrivedAt).toBeNull()
    })
  })

  describe('what may be resumed', () => {
    it('resumes a trip that arrived moments ago — the arrival card is still what the rider expects', () => {
      storeSavedTrip(NOW, NOW - 20_000)
      expect(loadGoModeSession()).not.toBeNull()
    })

    it('refuses a trip that arrived long ago, and clears it', () => {
      // The 18:52 trip's schedule put its end at ~18:27 — inside both existing
      // staleness windows — so nothing stopped it resurrecting.
      storeSavedTrip(NOW, NOW - 20 * 60_000)
      expect(loadGoModeSession()).toBeNull()
      expect(
        (window as any).localStorage.getItem('otp.goModeSession')
      ).toBeNull()
    })

    it('still resumes a live trip of the same age', () => {
      storeSavedTrip(NOW, null)
      expect(loadGoModeSession()).not.toBeNull()
    })
  })

  describe('what gets restored', () => {
    it('brings arrivedAt back, so the trip resumes finished', () => {
      storeSavedTrip(NOW, NOW - 20_000)
      const restored = (getInitialState({} as any) as any).goMode
      expect(restored.isActive).toBe(true)
      expect(restored.arrivedAt).toBe(NOW - 20_000)
    })
  })

  describe('the first tick after a re-mount', () => {
    /** Restore the way the app does, then hand the result to the tick. */
    const restoredStore = () => {
      storeSavedTrip(NOW, NOW - 20_000)
      return makeStore((getInitialState({} as any) as any).goMode)
    }

    it('does not re-derive an arrival the trip already had', () => {
      const store = restoredStore()
      store.run(handlePositionUpdate(fixAt(DEST, 4_000_000_000_000)))
      expect(store.types()).not.toContain('SET_ARRIVED')
    })

    it('replays no notifications — no "board the 546" one second after "you have arrived"', () => {
      const store = restoredStore()
      store.run(handlePositionUpdate(fixAt(DEST, 4_000_100_000_000)))
      expect(store.types()).not.toContain('ADD_NOTIFICATION')
    })
  })

  describe('delay after arrival', () => {
    it('holds the measurement taken at arrival instead of counting wall clock', () => {
      const store = makeStore({
        activeItinerary: walkItinerary(NOW - 1_489_000),
        arrivedAt: NOW - 20_000,
        isActive: true,
        progress: { ...(initial as any).progress, delay: 1489 },
        tracking: { ...initial.tracking, lastPosition: fixAt(ORIGIN, 0) }
      })
      store.run(handlePositionUpdate(fixAt(DEST, 4_000_200_000_000)))
      const progressAction = store
        .actions()
        .find((a) => a.type === 'UPDATE_PROGRESS')
      expect(progressAction).toBeDefined()
      expect(progressAction.payload.delay).toBe(1489)
    })
  })
})

/**
 * Finding 7. The wake lock failed exactly twice in a week of telemetry — once
 * per 18:52 mount — and those are the only two sessions in that week where Go
 * Mode was ALREADY active at page load. Every trip the rider started by hand,
 * in a page that was already up, took the lock first time. A restored trip
 * requests it during load, before the iOS shell is active, and the request is
 * refused; visibilitychange never rescues it because visibilityState was
 * "visible" the whole time, so there is no change to hear.
 */
describe('wake lock on a restored trip (2026-08-31)', () => {
  let container: HTMLDivElement
  let visibility = 'visible'

  const Harness = () => {
    useActiveTripGuards(true)
    return null
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility
    })
  })

  afterEach(() => {
    act(() => {
      ReactDOM.unmountComponentAtNode(container)
    })
    container.remove()
    delete (navigator as any).wakeLock
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

  const flush = async () => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('retries when the app becomes active after a refusal at load', async () => {
    const denied = new Error('Permission was denied')
    denied.name = 'NotAllowedError'
    const lock = { release: jest.fn() }
    const request = installWakeLock([denied, lock])
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await act(async () => {
      ReactDOM.render(React.createElement(Harness), container)
    })
    await flush()
    expect(request).toHaveBeenCalledTimes(1)

    // The shell finishes launching; the page gains focus without ever having
    // been hidden, so visibilitychange has nothing to report.
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    ;(console.warn as jest.Mock).mockRestore()
  })

  it('does not ask while the document is hidden — there is no permission to grant', async () => {
    visibility = 'hidden'
    const request = installWakeLock([{ release: jest.fn() }])

    await act(async () => {
      ReactDOM.render(React.createElement(Harness), container)
    })
    await flush()
    expect(request).not.toHaveBeenCalled()
  })

  it('does not stack a second lock on top of one it already holds', async () => {
    const lock = { release: jest.fn() }
    const request = installWakeLock([lock, { release: jest.fn() }])

    await act(async () => {
      ReactDOM.render(React.createElement(Harness), container)
    })
    await flush()
    // A visibility event while the page never left the screen. Re-requesting
    // here is not free: each grant is a separate sentinel, and only the last
    // handle gets released on teardown.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
  })
})
