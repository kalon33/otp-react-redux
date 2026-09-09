import '../../test-utils/mock-window-url'
import React from 'react'
import type { ReactWrapper } from 'enzyme'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { MobileScreens } from '../../../lib/actions/ui-constants'
import ReturnToTripBanner, {
  BANNER_HEIGHT_VAR
} from '../../../lib/components/app/return-to-trip-banner'

// The banner's mobile safety net is phone-only; force the phone branch.
jest.mock('@opentripplanner/core-utils/lib/ui', () => ({
  ...jest.requireActual('@opentripplanner/core-utils/lib/ui'),
  isMobile: () => true
}))

const BASE = 1788884400000
const MIN = 60000

/** Bus → walk → 8-minute wait → 546, with the first bus a minute late. */
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

/** The clock the banner should print, formatted exactly as the banner does. */
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  })

let wrappers: ReactWrapper[] = []

function render({
  backgrounded = true,
  mobileScreen = MobileScreens.RESULTS_SUMMARY,
  withProgress = true
}: {
  backgrounded?: boolean
  mobileScreen?: number
  withProgress?: boolean
} = {}) {
  const state = getMockInitialState()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const otp = state.otp as any
  otp.goMode = {
    ...(otp.goMode || {}),
    activeItinerary: itinerary,
    arrivedAt: null,
    isActive: true,
    liveLegTimes,
    progress: withProgress
      ? {
          // What progress-calculator produced on 2026-09-08: live alight plus
          // the MOVING time of the remaining legs, so seven minutes early.
          estimatedArrival: new Date(BASE + 30 * MIN),
          nextStopName: 'I-35W & 66th St Station'
        }
      : null,
    ui: { ...(otp.goMode?.ui || {}), backgrounded }
  }
  otp.ui = { ...otp.ui, mobileScreen }
  const mounted = mockWithProvider(ReturnToTripBanner, {}, state)
  wrappers.push(mounted.wrapper)
  return mounted
}

describe('components > ReturnToTripBanner (12.8, 2026-09-08)', () => {
  let rectSpy: jest.SpyInstance

  beforeEach(() => {
    // jsdom lays nothing out, so the banner would measure 0. Give it the two
    // lines it actually wrapped to on the rider's phone.
    rectSpy = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ height: 44, width: 390 } as DOMRect)
    document.documentElement.style.removeProperty(BANNER_HEIGHT_VAR)
  })

  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    wrappers = []
    rectSpy.mockRestore()
    document.documentElement.style.removeProperty(BANNER_HEIGHT_VAR)
  })

  describe('layout: the banner owns its strip instead of covering it', () => {
    it('publishes its measured height so the screens below start under it', () => {
      // FAILS BEFORE: the banner was `position: absolute; top: 50px` and
      // nothing below knew it was there, so it sat on the mobile results
      // header — the from/to fields and the Edit button — and the rider could
      // not edit the trip while it was backgrounded.
      render()
      expect(
        document.documentElement.style.getPropertyValue(BANNER_HEIGHT_VAR)
      ).toBe('44px')
    })

    it('gives the space back when no trip is backgrounded', () => {
      render({ backgrounded: false, mobileScreen: MobileScreens.GO_MODE })
      expect(
        document.documentElement.style.getPropertyValue(BANNER_HEIGHT_VAR)
      ).toBe('0px')
    })

    it('stays a tappable button', () => {
      const { wrapper } = render()
      expect(wrapper.find('button.return-to-trip-banner').length).toBe(1)
    })
  })

  describe('arrival: the same figure the trip sheet prints', () => {
    it('reads the live itinerary end, not now + timeRemaining', () => {
      // FAILS BEFORE: rendered progress.estimatedArrival — 11:50 AM against a
      // sheet saying 11:57 and an actual 11:58:08.
      const { wrapper } = render()
      const text = wrapper.find('button.return-to-trip-banner').text()
      expect(text).toContain(clock(BASE + 37 * MIN))
      expect(text).not.toContain(clock(BASE + 30 * MIN))
      expect(text).toContain('I-35W & 66th St Station')
    })

    it('says nothing about a clock it cannot compute', () => {
      const { wrapper } = render({ withProgress: false })
      const text = wrapper.find('button.return-to-trip-banner').text()
      expect(text).not.toContain(clock(BASE + 37 * MIN))
    })
  })
})
