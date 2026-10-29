/* eslint-disable @typescript-eslint/no-explicit-any */
import '../../test-utils/mock-window-url'
import { createStore } from 'redux'
import { IntlProvider } from 'react-intl'
import { mount } from 'enzyme'
import { Provider } from 'react-redux'
import clone from 'clone'
import React from 'react'
import type { ReactWrapper } from 'enzyme'

import { getMockInitialState } from '../../test-utils/mock-data/store'
import { MobileScreens } from '../../../lib/actions/ui-constants'
import { updatePosition, updateProgress } from '../../../lib/actions/go-mode'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'
import ReturnToTripBanner from '../../../lib/components/app/return-to-trip-banner'

// The banner's mobile safety net is phone-only; force the phone branch.
jest.mock('@opentripplanner/core-utils/lib/ui', () => ({
  ...jest.requireActual('@opentripplanner/core-utils/lib/ui'),
  isMobile: () => true
}))

// Count the deep clone `liveArrivalMs` → `buildLiveItinerary` runs.
jest.mock('clone', () => {
  const actual = jest.requireActual('clone')
  return jest.fn((...args: unknown[]) => actual(...args))
})
const cloneSpy = clone as unknown as jest.Mock

/**
 * Backlog 66.10 (perf agent P7, 2026-10-29): `ReturnToTripBanner` was
 * connected to the whole `goMode` slice, so every Go Mode dispatch re-rendered
 * it, and every render ran `liveArrivalMs` → `buildLiveItinerary` → a deep
 * `clone` of the active itinerary before `visible` gated the JSX. It is
 * mounted on every screen (navigation-bar, desktop-nav), so in foreground Go
 * Mode — where it is hidden — it still paid that on every tick: 35.1 ms self /
 * 106.5 ms total over 30 ticks of gold-74-1105 at 1x (~3.5 ms a tick, ~14 ms
 * at 4x CPU).
 *
 * A tick here is what `handlePositionUpdate` dispatches every fix:
 * UPDATE_POSITION, then UPDATE_PROGRESS with a fresh progress object.
 */

const BASE = 1788884400000
const MIN = 60000

/** Bus → walk → 8-minute wait → 546 (the 12.8 / 12.22 shape). */
const itinerary = {
  duration: 37 * 60,
  endTime: BASE + 37 * MIN,
  legs: [
    {
      duration: 20 * 60,
      endTime: BASE + 20 * MIN,
      mode: 'BUS',
      startTime: BASE,
      transitLeg: true
    },
    {
      duration: 2 * 60,
      endTime: BASE + 22 * MIN,
      mode: 'WALK',
      startTime: BASE + 20 * MIN
    },
    {
      duration: 7 * 60,
      endTime: BASE + 37 * MIN,
      mode: 'BUS',
      startTime: BASE + 30 * MIN,
      transitLeg: true
    }
  ],
  startTime: BASE
}

const liveLegTimes = {
  0: { alightEpoch: BASE + 21 * MIN, alightRealtime: true, realtime: true }
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  })

const TICKS = 30

const position = (i: number) =>
  ({
    coords: {
      accuracy: 5,
      latitude: 44.95 + i * 1e-4,
      longitude: -93.27,
      speed: 10
    },
    timestamp: BASE + 5 * MIN + i * 1000
  } as unknown as GeolocationPosition)

/** A fresh progress object every tick, as the progress calculator makes. */
const progress = (i: number, nextStopName = 'I-35W & 66th St Station') =>
  ({
    currentLegIndex: 0,
    estimatedArrival: new Date(BASE + 30 * MIN + i * 1000),
    nextStopName,
    timeRemaining: 25 * 60 - i
  } as any)

let wrappers: ReactWrapper[] = []

/**
 * A REAL store (the otp reducer, not redux-mock-store), so the tick actions
 * change `goMode` the way they do on a ride, and a Profiler around the banner
 * counts the commits it takes part in.
 */
function mountBanner({ backgrounded }: { backgrounded: boolean }) {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  const otpReducer = createOtpReducer({} as any)
  const state = getMockInitialState()
  const otp = state.otp as any
  otp.goMode = {
    ...otp.goMode,
    activeItinerary: itinerary,
    arrivedAt: null,
    isActive: true,
    liveLegTimes,
    progress: progress(0),
    ui: { ...otp.goMode?.ui, backgrounded }
  }
  otp.ui = {
    ...otp.ui,
    mobileScreen: backgrounded
      ? MobileScreens.RESULTS_SUMMARY
      : MobileScreens.GO_MODE
  }
  const store = createStore(
    (s: any, action: any) => ({ ...s, otp: otpReducer(s.otp, action) }),
    state as any
  )
  const commits = { count: 0 }
  const wrapper = mount(
    <IntlProvider defaultLocale="en-US" locale="en-US">
      <Provider store={store}>
        <React.Profiler
          id="banner"
          onRender={() => {
            commits.count++
          }}
        >
          <ReturnToTripBanner />
        </React.Profiler>
      </Provider>
    </IntlProvider>
  )
  wrappers.push(wrapper)
  return { commits, store, wrapper }
}

function tick(store: any, i: number, nextStopName?: string) {
  store.dispatch(updatePosition(position(i)))
  store.dispatch(updateProgress(progress(i, nextStopName)))
}

describe('components > ReturnToTripBanner: per-tick cost (66.10 / P7)', () => {
  let rectSpy: jest.SpyInstance

  beforeEach(() => {
    rectSpy = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ height: 44, width: 390 } as DOMRect)
  })

  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    wrappers = []
    rectSpy.mockRestore()
    jest.restoreAllMocks()
  })

  it('hidden (foreground Go Mode): 30 ticks clone nothing and render it at most once', () => {
    // FAILS BEFORE: 60 commits and 60 clones — one of each per dispatch.
    const { commits, store, wrapper } = mountBanner({ backgrounded: false })
    expect(wrapper.find('button.return-to-trip-banner').length).toBe(0)
    cloneSpy.mockClear()
    commits.count = 0

    for (let i = 1; i <= TICKS; i++) tick(store, i)

    expect(store.getState().otp.goMode.progress.timeRemaining).toBe(
      25 * 60 - TICKS
    )
    const seen = { clones: cloneSpy.mock.calls.length, commits: commits.count }
    expect(seen).toEqual({ clones: 0, commits: expect.any(Number) })
    expect(seen.commits).toBeLessThanOrEqual(1)
  })

  it('shown (backgrounded): the clock is the sheet’s (12.22) and is folded once, not per tick', () => {
    // FAILS BEFORE: one clone per dispatch (60), the itinerary and its live
    // times unchanged throughout.
    const { store, wrapper } = mountBanner({ backgrounded: true })
    const text = () => wrapper.find('button.return-to-trip-banner').text()
    expect(text()).toContain(clock(BASE + 37 * MIN))
    cloneSpy.mockClear()

    for (let i = 1; i <= TICKS; i++) {
      tick(store, i, i === TICKS ? 'I-35W & 76th St Station' : undefined)
    }
    wrapper.update()

    // Still live: the next stop follows the ticks...
    expect(text()).toContain('I-35W & 76th St Station')
    // ...the arrival is still the live itinerary's end, not now + timeRemaining
    expect(text()).toContain(clock(BASE + 37 * MIN))
    expect(text()).not.toContain(clock(BASE + 30 * MIN))
    expect(cloneSpy).toHaveBeenCalledTimes(0)
  })

  it('shown: new live leg times move the arrival on the next render', () => {
    const { store, wrapper } = mountBanner({ backgrounded: true })
    const text = () => wrapper.find('button.return-to-trip-banner').text()
    // The 546 now leaves late: board 11:31, alight 11:39 (live).
    store.dispatch({
      payload: {
        ...liveLegTimes,
        2: {
          alightEpoch: BASE + 39 * MIN,
          alightRealtime: true,
          boardEpoch: BASE + 31 * MIN,
          boardRealtime: true,
          realtime: true
        }
      },
      type: 'SET_LIVE_LEG_TIMES'
    })
    wrapper.update()
    expect(text()).toContain(clock(BASE + 39 * MIN))
  })
})
