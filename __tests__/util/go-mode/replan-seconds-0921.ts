/* globals afterEach, beforeEach, describe, expect, it, jest */
import { existsSync, readFileSync } from 'fs'
import path from 'path'

import FakeTimers from '@sinonjs/fake-timers'

import {
  captureRerouteSnapshot,
  refreshReturnPlan,
  startReturnTrip
} from '../../../lib/actions/go-mode'
import {
  fetchOnboardCandidatePlan,
  fetchRerouteSnapshotPlan
} from '../../../lib/actions/apiV2'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(
    () => () => Promise.resolve({ error: false, itineraries: [] })
  ),
  fetchRerouteSnapshotPlan: jest.fn(
    () => () => Promise.resolve({ query: {}, response: null, variables: {} })
  ),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  }))
}))

/**
 * Backlog 18.4 — every now-anchored re-plan asks OTP for the exact second.
 *
 * `coreUtils.time.OTP_API_TIME_FORMAT` is `"HH:mm"`, so the request itself
 * asked for the floored minute and OTP answered the question it was asked. The
 * plan was 0-59 s stale before it was rendered, and `determineTripStatus` /
 * `computeCurrentDelay` charged the rider for it.
 *
 * ## OTP is innocent, measured twice
 *
 * Desktop OTP (127.0.0.1:8090, 2026-09-18, bike-only, numItineraries 1):
 * `"18:26"` -> 18:26:00, `"18:26:55"` -> 18:26:55, `"18:26:30"` -> 18:26:30.
 *
 * PRODUCTION (2026-09-22, one read-only serial probe each, bike-only,
 * numItineraries 1, `POST https://api.transit-nav.com:9966/otp/gtfs/v1`,
 * 44.82517,-93.290862 -> 44.816546,-93.30986, date 2026-09-22):
 *
 *   time "14:26"     -> itinerary startTime 1790105160000 = 14:26:00
 *   time "14:26:55"  -> itinerary startTime 1790105215000 = 14:26:55
 *
 * Only the desktop had been measured when the row was settled; production
 * honours the seconds too, so the fix is client-side and complete.
 */

const FIXTURE_DIR = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)
const EVENING = path.join(FIXTURE_DIR, '0921-1605-465-wrongdir.json')
const LATER = path.join(FIXTURE_DIR, '0921-1727-newbundle.json')
const hasFixtures = existsSync(EVENING) && existsSync(LATER)
const describeRide = hasFixtures ? describe : describe.skip

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

describeRide(
  'util > go-mode > 18.4: what the flooring cost, on the rides',
  () => {
    it('every quiet re-plan installed a plan starting in the past', () => {
      const rides = [
        { fx: JSON.parse(readFileSync(EVENING, 'utf8')), skip: 3 },
        { fx: JSON.parse(readFileSync(LATER, 'utf8')), skip: 0 }
      ]
      const rows: Array<{
        asked: string
        openedBehindS: number
        startTime: string
      }> = []
      rides.forEach(({ fx, skip }) => {
        const fulls = (fx.quietReplanPlans || []).filter(
          (p: any) => p.reason === 'quiet-replan-full'
        )
        const swaps = (fx.itinerarySwaps || []).slice(skip)
        fulls.forEach((plan: any, i: number) => {
          const swap = swaps[i]
          const startMs = new Date(swap.itinerary.startTime).getTime()
          rows.push({
            asked: plan.request.variables.time,
            openedBehindS: Math.round(swap.tMs - startMs) / 1000,
            startTime: hhmmss(startMs)
          })
        })
      })

      // Five re-plans, five requests floored to the minute...
      expect(rows.map((r) => r.asked)).toEqual([
        '16:37',
        '16:38',
        '16:38',
        '17:34',
        '17:35'
      ])
      // ...and five itineraries starting exactly on that minute. OTP answered
      // the question it was asked, every time.
      expect(rows.map((r) => r.startTime)).toEqual([
        '16:37:00',
        '16:38:00',
        '16:38:00',
        '17:34:00',
        '17:35:00'
      ])
      // The gap between the plan's own start and the instant it was installed:
      // this is the `behind` the rider read from the plan's first tick.
      expect(rows.map((r) => r.openedBehindS)).toEqual([
        65.029, 41.108, 65.857, 42.701, 66.519
      ])

      // 24.3 (projected origin, format untouched) moved 3 of the 5 across a
      // minute boundary and left 2 alone — 5.029 / 41.108 / 5.857 / 42.701 /
      // 6.519 s. What is left in every one of them is the flooring, and every
      // one of them is under a minute: nothing else is in this number.
      rows.forEach((r) => expect(r.openedBehindS).toBeLessThan(67))
    })
  }
)

/**
 * The wire, on this branch. `GO_MODE_API_TIME_FORMAT` is not exported — what
 * matters is the string the query carries, so that is what is asserted.
 */
describe('util > go-mode > 18.4: now-anchored queries carry the second', () => {
  const SECONDS = /^\d{2}:\d{2}:\d{2}$/
  const MINUTES = /^\d{2}:\d{2}$/
  // 2026-09-21 16:38:05.018 America/Chicago — the instant the ride's first
  // quiet re-plan landed, seconds and all.
  const NOW = 1790026685018

  let clock: FakeTimers.InstalledClock
  beforeEach(() => {
    clock = FakeTimers.install({ now: NOW, toFake: ['Date'] })
    ;(fetchRerouteSnapshotPlan as jest.Mock).mockClear()
    ;(fetchOnboardCandidatePlan as jest.Mock).mockClear()
  })
  afterEach(() => clock.uninstall())

  const itinerary: any = {
    endTime: NOW + 20 * 60000,
    legs: [
      {
        distance: 1500,
        from: { lat: 44.948, lon: -93.2795 },
        mode: 'BICYCLE',
        to: { lat: 44.96, lon: -93.27, name: 'Home' }
      }
    ],
    startTime: NOW
  }

  const storeWith = (extra: any) => {
    const initial = goMode(undefined, { type: '@@INIT' })
    let state: any = {
      ...initial,
      activeItinerary: itinerary,
      isActive: true,
      tracking: {
        ...initial.tracking,
        lastPosition: {
          coords: { accuracy: 5, latitude: 44.948, longitude: -93.2795 },
          timestamp: NOW
        }
      },
      ...extra
    }
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: {},
        goMode: state,
        transitIndex: { routes: {}, stops: {}, trips: {} }
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      state = goMode(state, action)
      return action
    }
    return dispatch
  }

  it('the REROUTE_SNAPSHOT records the query the live path would send', async () => {
    // The snapshot exists to reproduce a re-route. A recording that floors the
    // search time asks a different question from the one the rider got.
    await storeWith({})(captureRerouteSnapshot())
    const combo = (fetchRerouteSnapshotPlan as jest.Mock).mock.calls[0][0]
    expect(combo.time).toMatch(SECONDS)
    expect(combo.time).toBe('16:38:05')
    expect(combo.date).toBe('2026-09-21')
    expect(combo.time).not.toMatch(MINUTES)
  })

  it('the return refresh does not floor a NOW-anchored departure', async () => {
    // `Math.max(nowMs, leaveByMs - RETURN_REFRESH_LEAD_MS)` lands on now
    // whenever the return is already due, and flooring that puts the refreshed
    // plan up to 59 s in the past.
    await storeWith({
      roundTrip: {
        destination: { lat: 44.948, lon: -93.2795, name: 'Stop' },
        leaveByMs: NOW,
        origin: { lat: 44.96, lon: -93.27, name: 'Home' },
        stayMinutes: 30
      }
    })(refreshReturnPlan())
    const combo = (fetchOnboardCandidatePlan as jest.Mock).mock.calls[0][0]
    expect(combo.time).toBe('16:38:05')
  })

  it('"go now" on the return trip means now, to the second', async () => {
    await storeWith({
      roundTrip: {
        destination: { lat: 44.948, lon: -93.2795, name: 'Stop' },
        leaveByMs: NOW + 600000,
        origin: { lat: 44.96, lon: -93.27, name: 'Home' },
        stayMinutes: 30
      }
    })(startReturnTrip())
    const combo = (fetchOnboardCandidatePlan as jest.Mock).mock.calls[0][0]
    expect(combo.time).toBe('16:38:05')
  })
})
