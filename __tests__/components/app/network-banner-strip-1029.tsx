import '../../test-utils/mock-window-url'
import { IntlProvider } from 'react-intl'
import { mount } from 'enzyme'
import React from 'react'
import type { ReactWrapper } from 'enzyme'

import { FullScreenWrapper } from '../../../lib/components/go-mode/styled'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { MobileScreens } from '../../../lib/actions/ui-constants'
import { NetworkConnectionBanner } from '../../../lib/components/app/network-connection-banner'
import ReturnToTripBanner from '../../../lib/components/app/return-to-trip-banner'

// The return-to-trip banner's phone branch.
jest.mock('@opentripplanner/core-utils/lib/ui', () => ({
  ...jest.requireActual('@opentripplanner/core-utils/lib/ui'),
  isMobile: () => true
}))

/**
 * Backlog 75.16 (a), chaos agent C12, 2026-10-29: `window.dispatchEvent(new
 * Event('offline'))` → `SET_NETWORK_CONNECTION_LOST true` → the amber
 * "Network connection lost" strip at y 50–90 px OVER "Test origin → Downtown
 * Minneapolis … Edit" on the results screen, and in Go Mode over the card's
 * ← / route pill / headsign row, for as long as the phone was offline. The
 * strip was `position: absolute; top: 50px` and published nothing, so nothing
 * below it moved — unlike the return-to-trip banner in the same strip, which
 * publishes --return-to-trip-banner-height and every screen below adds it
 * (12.8). The network strip now publishes into the same sum.
 */
const NET_VAR = '--network-banner-height'
const STRIP_VAR = '--return-to-trip-banner-height'
const rootVar = (name: string) =>
  document.documentElement.style.getPropertyValue(name)
const css = () =>
  Array.from(document.querySelectorAll('style'))
    .map((s) => s.textContent)
    .join('\n')

const NetworkStrip = ({ lost }: { lost: boolean }) => (
  <IntlProvider defaultLocale="en-US" locale="en-US">
    <NetworkConnectionBanner networkConnectionLost={lost} />
  </IntlProvider>
)

const BASE = 1788884400000
function backgroundedTripState() {
  const state = getMockInitialState()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const otp = state.otp as any
  otp.goMode = {
    ...(otp.goMode || {}),
    activeItinerary: {
      endTime: BASE + 20 * 60000,
      legs: [
        {
          endTime: BASE + 20 * 60000,
          mode: 'BUS',
          startTime: BASE,
          transitLeg: true
        }
      ],
      startTime: BASE
    },
    arrivedAt: null,
    isActive: true,
    liveLegTimes: {},
    progress: null,
    ui: { ...(otp.goMode?.ui || {}), backgrounded: true }
  }
  otp.ui = { ...otp.ui, mobileScreen: MobileScreens.RESULTS_SUMMARY }
  return state
}

let wrappers: ReactWrapper[] = []
let rectSpy: jest.SpyInstance

beforeEach(() => {
  // jsdom lays nothing out: give every banner the 40 px strip it measured on
  // the phone (C12: "y 50–90 px (40 px)").
  rectSpy = jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ height: 40, width: 390 } as DOMRect)
  document.documentElement.style.removeProperty(NET_VAR)
  document.documentElement.style.removeProperty(STRIP_VAR)
})

afterEach(() => {
  wrappers.forEach((w) => w.unmount())
  wrappers = []
  rectSpy.mockRestore()
  document.documentElement.style.removeProperty(NET_VAR)
  document.documentElement.style.removeProperty(STRIP_VAR)
})

describe('components > app > the network-lost strip owns its band (75.16 C12)', () => {
  it('publishes its height while offline, into the sum the screens below read', () => {
    // FAILS BEFORE: the strip published nothing — both '' — so the results
    // summary card and the Go Mode card stayed where they were, under it.
    const w = mount(<NetworkStrip lost />)
    wrappers.push(w)
    expect(rootVar(NET_VAR)).toBe('40px')
    expect(rootVar(STRIP_VAR)).toBe('40px')
  })

  it('gives the band back when the connection returns', () => {
    const w = mount(<NetworkStrip lost />)
    wrappers.push(w)
    w.setProps({ lost: false })
    expect(rootVar(NET_VAR)).toBe('0px')
    expect(rootVar(STRIP_VAR)).toBe('0px')
  })

  it('stacks the return-to-trip banner under it, and the screens move by both', () => {
    // FAILS BEFORE: both banners sat at top: 50px, one over the other, and
    // the screens below moved by the return banner alone (40, not 80).
    const w = mount(<NetworkStrip lost />)
    wrappers.push(w)
    const trip = mockWithProvider(
      ReturnToTripBanner,
      {},
      backgroundedTripState()
    )
    wrappers.push(trip.wrapper)
    expect(trip.wrapper.find('button.return-to-trip-banner')).toHaveLength(1)
    expect(rootVar(STRIP_VAR)).toBe('80px')
    expect(css()).toMatch(
      /\.return-to-trip-banner\{[^}]*top:\s*calc\(50px \+ var\(--network-banner-height,\s*0px\)\)/
    )

    // Back online: the return banner keeps its own 40 and nothing else.
    w.setProps({ lost: false })
    expect(rootVar(STRIP_VAR)).toBe('40px')
  })

  it('Go Mode puts the strip under its 44 px bar and the card under the strip', () => {
    // FAILS BEFORE: the Go Mode layer read nothing — its bar is 44 px, the
    // strip sat at 50–90 over the card's eyebrow row (C12, 03-go-offline.png).
    const w = mount(
      <FullScreenWrapper>
        <header />
      </FullScreenWrapper>
    )
    wrappers.push(w)
    const text = css()
    expect(text).toMatch(
      />\s*header\s*\.network-connection-banner\{[^}]*top:\s*var\(--tn-tap\)/
    )
    expect(text).toMatch(
      />\s*header\{[^}]*margin-bottom:\s*var\(--network-banner-height,\s*0px\)/
    )
  })
})
