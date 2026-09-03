import '../../test-utils/mock-window-url'
import React from 'react'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { MobileScreens } from '../../../lib/actions/ui-constants'
import ReturnToTripBanner from '../../../lib/components/app/return-to-trip-banner'

// The banner's mobile safety net is phone-only; force the phone branch.
jest.mock('@opentripplanner/core-utils/lib/ui', () => ({
  ...jest.requireActual('@opentripplanner/core-utils/lib/ui'),
  isMobile: () => true
}))

function render({
  backgrounded,
  mobileScreen
}: {
  backgrounded: boolean
  mobileScreen: number
}) {
  const state = getMockInitialState()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const otp = state.otp as any
  otp.goMode = {
    ...(otp.goMode || {}),
    activeItinerary: { legs: [] },
    arrivedAt: null,
    isActive: true,
    progress: null,
    ui: { ...(otp.goMode?.ui || {}), backgrounded }
  }
  otp.ui = { ...otp.ui, mobileScreen }
  return mockWithProvider(ReturnToTripBanner, {}, state)
}

/**
 * 6.54. Session mtlutz2c-mfb2nx (2026-09-03 18:24:39Z) ended with `go.on`
 * true, `go.leg` 1 and mobileScreen 3 (SEARCH_FORM) — a running trip on the
 * bare search form. No SET_GO_MODE_BACKGROUNDED was ever dispatched, so the
 * banner's only condition was unmet and the rider had no route back.
 */
describe('components > ReturnToTripBanner, stranded live trip', () => {
  it('shows on a phone whenever a live trip is not on the Go Mode screen', () => {
    // FAILS BEFORE: visibility required goMode.ui.backgrounded, which nothing
    // on this path ever set.
    const { wrapper } = render({
      backgrounded: false,
      mobileScreen: MobileScreens.SEARCH_FORM
    })
    expect(wrapper.find('button.return-to-trip-banner').length).toBe(1)
  })

  it('stays hidden while the rider is on the Go Mode screen', () => {
    const { wrapper } = render({
      backgrounded: false,
      mobileScreen: MobileScreens.GO_MODE
    })
    expect(wrapper.find('button.return-to-trip-banner').length).toBe(0)
  })

  it('still shows for a deliberately backgrounded trip', () => {
    const { wrapper } = render({
      backgrounded: true,
      mobileScreen: MobileScreens.RESULTS_SUMMARY
    })
    expect(wrapper.find('button.return-to-trip-banner').length).toBe(1)
  })
})
