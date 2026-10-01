import '../../test-utils/mock-window-url'
import React from 'react'
import type { ReactWrapper } from 'enzyme'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { MobileScreens } from '../../../lib/actions/ui-constants'
import ReturnToTripBanner from '../../../lib/components/app/return-to-trip-banner'

jest.mock('@opentripplanner/core-utils/lib/ui', () => ({
  ...jest.requireActual('@opentripplanner/core-utils/lib/ui'),
  isMobile: () => true
}))

/**
 * Backlog 13.9, the half that was never built.
 *
 * The trip steps onto a transit leg before the bus leaves — 13.1 keeps the
 * transition early on purpose, because `advanceToLeg` is the only place
 * `startVehicleTracking` runs for a mid-trip transit leg — so for the whole
 * platform wait `progress.nextStopName` names the stop AFTER the boarding
 * stop. The current-leg card stopped stating that as a ride on 2026-09-17
 * (`gomode/card-truth` 7d0296b27); `return-to-trip-banner.tsx` kept saying
 * *"On trip · Next stop {stop} · Arrive {eta}"* with no riding gate at all.
 *
 * The rider's own note is 2026-09-11 08:26:21, typed 23 m from the stop and
 * 2m11s before the 08:27:31 bus.
 *
 * Both surfaces now read one predicate (`isWaitingForDeparture`), so they
 * cannot drift: the gate is the POSITIVE fact that the bus's own board time
 * is still ahead, not the absence of a riding fact.
 */

const BASE = 1789475191000 // 2026-09-11 08:26:31 America/Chicago
const MIN = 60000
const BOARD = BASE + 60000 // 08:27:31 — the bus the rider is standing for

/** Bike to I-35W & Lake St, then the ORANGE. The trip is on leg 1 already. */
const itinerary = {
  duration: 30 * 60,
  endTime: BASE + 25 * MIN,
  legs: [
    {
      distance: 2600,
      duration: 9 * 60,
      endTime: BASE,
      from: { lat: 44.92, lon: -93.28, name: 'Home' },
      mode: 'BICYCLE',
      startTime: BASE - 9 * MIN,
      to: { lat: 44.948, lon: -93.2795, name: 'I-35W & Lake St Station' }
    },
    {
      distance: 8000,
      duration: 19 * 60,
      endTime: BASE + 20 * MIN,
      from: { lat: 44.948, lon: -93.2795, name: 'I-35W & Lake St Station' },
      mode: 'BUS',
      routeShortName: 'ORANGE',
      startTime: BOARD,
      to: { lat: 44.97, lon: -93.27, name: 'Downtown' },
      transitLeg: true
    }
  ],
  startTime: BASE - 9 * MIN
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  })

let wrappers: ReactWrapper[] = []

function render({
  boardEpoch,
  boardIsFloor = false,
  riding = null
}: {
  boardEpoch?: number
  boardIsFloor?: boolean
  riding?: { legIndex: number } | null
} = {}) {
  const state = getMockInitialState()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const otp = state.otp as any
  otp.goMode = {
    ...(otp.goMode || {}),
    activeItinerary: itinerary,
    arrivedAt: null,
    isActive: true,
    liveLegTimes:
      boardEpoch != null
        ? {
            1: {
              boardEpoch,
              boardIsFloor,
              boardRealtime: !boardIsFloor,
              realtime: true
            }
          }
        : {},
    progress: {
      currentLegIndex: 1,
      estimatedArrival: new Date(BASE + 25 * MIN),
      nextStopName: 'I-35W & 46th St Station'
    },
    riding,
    ui: { ...(otp.goMode?.ui || {}), backgrounded: true }
  }
  otp.ui = { ...otp.ui, mobileScreen: MobileScreens.RESULTS_SUMMARY }
  const mounted = mockWithProvider(ReturnToTripBanner, {}, state)
  wrappers.push(mounted.wrapper)
  return mounted.wrapper.find('button.return-to-trip-banner').text()
}

describe('components > ReturnToTripBanner: the platform wait (13.9)', () => {
  let nowSpy: jest.SpyInstance
  let rectSpy: jest.SpyInstance

  beforeEach(() => {
    // 08:26:31 — one minute before the bus, the rider standing at the stop.
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(BASE)
    rectSpy = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ height: 44, width: 390 } as DOMRect)
  })

  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    wrappers = []
    nowSpy.mockRestore()
    rectSpy.mockRestore()
  })

  it('says where the rider is and when the bus goes', () => {
    // FAILS BEFORE: "On trip · Next stop I-35W & 46th St Station · Arrive …"
    const text = render()
    expect(text).toContain('Waiting at I-35W & Lake St Station')
    expect(text).toContain(clock(BOARD))
    expect(text).toContain('tap to return')
    expect(text).not.toContain('Next stop')
    expect(text).not.toContain('I-35W & 46th St Station')
  })

  it('prefers the live board time over the plan', () => {
    const late = BOARD + 4 * MIN
    const text = render({ boardEpoch: late })
    expect(text).toContain(clock(late))
    expect(text).not.toContain(clock(BOARD))
  })

  it('names the stop without a time when the epoch is only a floor (17.6)', () => {
    const text = render({ boardEpoch: BASE + 30000, boardIsFloor: true })
    expect(text).toBe('Waiting at I-35W & Lake St Station — tap to return')
  })

  it('goes back to the ride wording once the bus has left', () => {
    nowSpy.mockReturnValue(BOARD + 30000)
    const text = render()
    expect(text).toContain('Next stop I-35W & 46th St Station')
    expect(text).not.toContain('Waiting at')
  })

  it('never tells a rider the feed has aboard that they are waiting', () => {
    const text = render({ riding: { legIndex: 1 } })
    expect(text).toContain('Next stop I-35W & 46th St Station')
    expect(text).not.toContain('Waiting at')
  })
})
