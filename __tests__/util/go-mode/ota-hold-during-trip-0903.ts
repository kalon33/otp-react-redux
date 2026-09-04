import {
  endGoMode,
  resumeGoModeTrip,
  startGoModeTracking
} from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'
import type { Itinerary } from '@opentripplanner/types'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * The live-update plugin installs a queued bundle whenever the app is
 * BACKGROUNDED — `installNext()` from `appMovedToBackground` /
 * `onActivityStopped` (CapacitorUpdaterPlugin.java:5302-5303, .swift:4674-4675)
 * — and it has no idea whether a rider is mid-ride. Measured on the genuine
 * Play build on 2026-09-03 with a live restored trip in the store: `App moved
 * to background` → `Setting next active bundle` → `Reloading:`, the new bundle
 * loaded 14 ms after the phone was pocketed. A rider following turn-by-turn
 * with the screen locked is precisely that case.
 *
 * The web-layer gate (`applyPendingBundleWhenSafe`, backlog 3.11) only declines
 * to apply EARLY; nothing in JS runs between the background event and the
 * install. The only lever is the plugin's own delay list, which `installNext()`
 * consults before doing anything (java:5114-5118, swift:4524-4533).
 *
 * So Go Mode's lifecycle owns the hold: armed at every door into a live trip,
 * released when the trip is over. These cases fail against the unfixed source
 * because nothing called the plugin at all.
 */
describe('util > go-mode > the updater is held for the length of a trip', () => {
  const walkLeg = {
    endTime: 1_769_616_600_000,
    mode: 'WALK',
    startTime: 1_769_616_000_000,
    transitLeg: false
  }
  const itinerary = { legs: [walkLeg] } as unknown as Itinerary

  let cancelDelay: jest.Mock
  let setMultiDelay: jest.Mock
  // One timeline for the plugin calls AND the dispatched actions, so an
  // ordering claim is an ordering claim and not two counters.
  let timeline: string[]

  beforeEach(() => {
    timeline = []
    cancelDelay = jest.fn(async () => {
      timeline.push('cancelDelay')
    })
    setMultiDelay = jest.fn(async () => {
      timeline.push('setMultiDelay')
    })
    ;(window as any).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        CapacitorUpdater: {
          cancelDelay,
          current: async () => ({ bundle: { id: 'x' } }),
          notifyAppReady: async () => undefined,
          setMultiDelay
        }
      }
    }
  })

  afterEach(() => {
    delete (window as any).Capacitor
  })

  const makeStore = (initial: Record<string, unknown> = {}) => {
    let state: any = {
      ...goMode(undefined, { type: '@@INIT' }),
      ...initial
    }
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: {},
        goMode: state
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      timeline.push(action.type)
      state = goMode(state, action)
      return action
    }
    return { dispatch, getState }
  }

  it('holds the updater off as soon as a trip starts tracking', async () => {
    const store = makeStore({ activeItinerary: itinerary, isActive: true })
    await store.dispatch(startGoModeTracking(itinerary, { replay: true }))

    // `kill` is the only condition kind that survives a background AND the
    // foreground after it on both platforms (DelayUpdateUtils.java:89-99,
    // .swift:88-95). A `background` condition is dropped by Android's next
    // foreground whatever its value (java:50-88).
    expect(setMultiDelay).toHaveBeenCalledWith({
      delayConditions: [{ kind: 'kill' }]
    })
    await store.dispatch(endGoMode())
  })

  it('releases the hold when the trip ends', async () => {
    const store = makeStore({ activeItinerary: itinerary, isActive: true })
    await store.dispatch(startGoModeTracking(itinerary, { replay: true }))
    expect(cancelDelay).not.toHaveBeenCalled()

    store.dispatch(endGoMode())
    expect(cancelDelay).toHaveBeenCalledTimes(1)
  })

  it('holds before a resumed trip re-arms any of its tracking', async () => {
    // The plugin clears every `kill` condition from its own `load()`
    // (java:934, swift:460), so a process killed mid-ride comes back with NO
    // hold — and the rider's next pocketing installs the bundle. A boot that
    // picks a live trip back up has to close that window before it does
    // anything else.
    const store = makeStore({ activeItinerary: itinerary, isActive: true })
    await store.dispatch(resumeGoModeTrip())

    expect(setMultiDelay).toHaveBeenCalledWith({
      delayConditions: [{ kind: 'kill' }]
    })
    // ...and before the tracking machinery armed. UPDATE_TRACKING_INTERVAL is
    // what startGoModeTracking dispatches once it starts arming the trip; the
    // hold has to be in place by then, not after it.
    expect(timeline).toContain('UPDATE_TRACKING_INTERVAL')
    expect(timeline.indexOf('setMultiDelay')).toBeLessThan(
      timeline.indexOf('UPDATE_TRACKING_INTERVAL')
    )
    store.dispatch(endGoMode())
  })
})
