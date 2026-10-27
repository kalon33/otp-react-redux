/* globals describe, expect, it, jest, beforeEach, afterEach */
import FakeTimers from '@sinonjs/fake-timers'

import { findTrip } from '../../../lib/actions/apiV2'
import { itinerarySignature } from '../../../lib/util/go-mode/reroute-candidates'
import { liveTimesPlanStillCurrent } from '../../../lib/util/go-mode/live-times-plan'
import { refreshLiveLegTimes } from '../../../lib/actions/go-mode'
import fixture from '../../test-utils/mock-data/live-times-swap-1026.json'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * Backlog 72.1 — live times from the plan the trip had just swapped away from.
 *
 * Ride `mvpik996-01erej`, 2026-10-26, DEV `2026.1025.1`. Two START_GO_MODE in
 * one second: 12:14:00.795 the 12:53 D Line plan (trip `1:1397642`, plan 1),
 * then 12:14:00.947 the 12:20 plan (D Line `1:1384516` + 18 `1:1381301`,
 * plan 2). Plan 1's live-times refresh was still awaiting its trip queries
 * when plan 2 went in; its FIND_TRIP_RESPONSEs landed at 12:14:01.008/.609/
 * .719 and SET_LIVE_LEG_TIMES 12:14:01.722 wrote plan 1's times (leg 1 board
 * 12:53:20) onto plan 2's legs by index — "32 min late" for an on-time bus.
 * Plan 2's own refresh waited out the 20 s throttle: right times 12:14:25.120
 * (leg 1 board 12:20:43).
 *
 * The fixture beside this test is that recording, slimmed: plan 1 is the
 * recorded `itinerary`, plan 2 `itinerarySwaps[0]`, the trip payloads the
 * first six `tripSnapshots` (17:14:01.008–17:14:25.105Z), and the boarding
 * stop's 17:14:00.898Z poll cut to the two D Line runs. A replay cannot cover
 * this — live-time polls are skipped under isReplayActive().
 */

const f: any = fixture
const PLAN1: any = f.plan1
const PLAN2: any = f.swap.itinerary
const SWAP_MS: number = f.swap.tMs // 17:14:00.947Z
const BOARD_STOP = '1:81120'
const mockedFindTrip = findTrip as jest.Mock

/** 12:53:20 — plan 1's D Line at Portland & 52nd, published at 12:14:01. */
const E_125320 = 1793037200000
/** 12:20:43 — plan 2's D Line at the same stop, published at 12:14:25. */
const E_122043 = 1793035243000

const clone = (x: any) => JSON.parse(JSON.stringify(x))
const snapFor = (tripId: string, afterMs: number) =>
  f.tripSnapshots.find((s: any) => s.tripId === tripId && s.tMs >= afterMs)

const blankLeg1Geometry = (plan: any) => {
  const p = clone(plan)
  p.legs[1].legGeometry = { length: 0, points: '' }
  return p
}

type Harness = {
  actions: any[]
  findTripCalls: string[]
  published: any[]
  state: any
}

/**
 * Run one refreshLiveLegTimes against a mutable store. `onFetch` runs inside
 * each findTrip, after its payload has been cached — the moment the real
 * response lands — so it can install a new plan the way START_GO_MODE does.
 */
const run = async ({
  itinerary,
  onFetch,
  snapshotsAfterMs
}: {
  itinerary: any
  onFetch?: (tripId: string, h: Harness) => void
  snapshotsAfterMs: number
}): Promise<Harness> => {
  const h: Harness = {
    actions: [],
    findTripCalls: [],
    published: [],
    state: {
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        goMode: {
          activeItinerary: itinerary,
          isActive: true,
          liveLegTimes: {},
          riding: null,
          routeMatch: { legIndex: 0 },
          tracking: {
            lastPosition: { coords: { latitude: 44.9294, longitude: -93.2672 } }
          },
          vehicleMatch: null
        },
        transitIndex: {
          stops: { [BOARD_STOP]: clone(f.stopSnapshot.payload) },
          trips: {}
        }
      }
    }
  }
  mockedFindTrip.mockImplementation(
    ({ tripId }: { tripId: string }) =>
      async () => {
        h.findTripCalls.push(tripId)
        const snap = snapFor(tripId, snapshotsAfterMs)
        if (snap) h.state.otp.transitIndex.trips[tripId] = clone(snap.payload)
        onFetch?.(tripId, h)
      }
  )
  const getState = () => h.state
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    h.actions.push(action)
    if (action.type === 'SET_LIVE_LEG_TIMES') h.published.push(action.payload)
    return action
  }
  await dispatch(refreshLiveLegTimes())
  return h
}

/** What START_GO_MODE does to the slice: new plan, liveLegTimes emptied. */
const installPlan = (h: Harness, plan: any) => {
  h.state.otp.goMode = {
    ...h.state.otp.goMode,
    activeItinerary: plan,
    liveLegTimes: {}
  }
}

const types = (h: Harness) => h.actions.map((a) => a.type)

describe('72.1 the recorded plans', () => {
  it('plan 1 and plan 2 are the recorded two, with different signatures', () => {
    expect(PLAN1.legs[1].trip.gtfsId).toBe('1:1397642')
    expect(PLAN2.legs[1].trip.gtfsId).toBe('1:1384516')
    expect(PLAN2.legs[2].trip.gtfsId).toBe('1:1381301')
    expect(itinerarySignature(PLAN1)).not.toBe(itinerarySignature(PLAN2))
    // Same leg count: an index-keyed write of plan 1's times fits plan 2.
    expect(PLAN1.legs).toHaveLength(PLAN2.legs.length)
  })
})

describe('72.1 liveTimesPlanStillCurrent', () => {
  const sig = itinerarySignature(PLAN1)
  it('same plan, active: current', () => {
    expect(
      liveTimesPlanStillCurrent({ activeItinerary: PLAN1, isActive: true }, sig)
    ).toBe(true)
  })
  it('a new object with the same legs (geometry repair) is still current', () => {
    expect(
      liveTimesPlanStillCurrent(
        { activeItinerary: blankLeg1Geometry(PLAN1), isActive: true },
        sig
      )
    ).toBe(true)
  })
  it('a swapped plan is not', () => {
    expect(
      liveTimesPlanStillCurrent({ activeItinerary: PLAN2, isActive: true }, sig)
    ).toBe(false)
  })
  it('an ended trip or a missing plan is not', () => {
    expect(
      liveTimesPlanStillCurrent(
        { activeItinerary: PLAN1, isActive: false },
        sig
      )
    ).toBe(false)
    expect(
      liveTimesPlanStillCurrent({ activeItinerary: null, isActive: true }, sig)
    ).toBe(false)
    expect(liveTimesPlanStillCurrent(null, sig)).toBe(false)
  })
})

describe('72.1 refreshLiveLegTimes across a plan swap', () => {
  let clock: any
  beforeEach(() => {
    mockedFindTrip.mockReset()
  })
  afterEach(() => clock?.uninstall())
  const at = (ms: number) => {
    clock = FakeTimers.install({ now: ms, toFake: ['Date'] })
  }

  it('control: plan 1 alone publishes its D Line at 12:53:20', async () => {
    at(SWAP_MS - 130) // 17:14:00.817Z, when plan 1's refresh began
    const h = await run({ itinerary: PLAN1, snapshotsAfterMs: SWAP_MS })
    expect(h.findTripCalls).toEqual(['1:1397642', '1:1381262', '1:1134930'])
    expect(h.published).toHaveLength(1)
    expect(h.published[0][1]).toMatchObject({
      boardEpoch: E_125320,
      boardRealtime: true,
      boardSource: 'stop'
    })
    expect(Object.keys(h.published[0]).sort()).toEqual(['1', '2', '4'])
  })

  it('control: plan 2 alone (12:14:25) publishes its D Line at 12:20:43', async () => {
    at(1793034865000)
    const h = await run({ itinerary: PLAN2, snapshotsAfterMs: 1793034865000 })
    expect(h.findTripCalls).toEqual(['1:1384516', '1:1381301', '1:1134930'])
    expect(h.published[0][1]).toMatchObject({
      boardEpoch: E_122043,
      boardSource: 'stop'
    })
  })

  it('a swap during the first trip query publishes nothing onto plan 2', async () => {
    at(SWAP_MS - 130)
    const h = await run({
      itinerary: PLAN1,
      onFetch: (tripId, hh) => {
        if (tripId === '1:1397642') installPlan(hh, PLAN2)
      },
      snapshotsAfterMs: SWAP_MS
    })
    // Recorded: SET_LIVE_LEG_TIMES leg 1 board 12:53:20 on plan 2.
    expect(h.published).toHaveLength(0)
    expect(types(h)).not.toContain('SET_LIVE_LEG_TIMES')
    expect(types(h)).not.toContain('BOARD_TIME_SOURCE_DISAGREEMENT')
    // ...and it stops asking for the old plan's trips.
    expect(h.findTripCalls).toEqual(['1:1397642'])
    expect(h.state.otp.goMode.liveLegTimes).toEqual({})
  })

  it('a swap during the first trip query repairs no geometry on plan 2', async () => {
    // Plan 1's D Line leg built with no shape (the onboard flow's failure
    // case): the refresh would heal it from the trip record — by INDEX, onto
    // whatever plan is installed by then.
    at(SWAP_MS - 130)
    const h = await run({
      itinerary: blankLeg1Geometry(PLAN1),
      onFetch: (tripId, hh) => {
        if (tripId === '1:1397642') installPlan(hh, PLAN2)
      },
      snapshotsAfterMs: SWAP_MS
    })
    expect(types(h)).not.toContain('REPAIR_LEG_GEOMETRY')
    expect(h.published).toHaveLength(0)
  })

  it('a swap during the LAST trip query still publishes nothing', async () => {
    at(SWAP_MS - 130)
    const h = await run({
      itinerary: PLAN1,
      onFetch: (tripId, hh) => {
        if (tripId === '1:1134930') installPlan(hh, PLAN2)
      },
      snapshotsAfterMs: SWAP_MS
    })
    expect(h.findTripCalls).toEqual(['1:1397642', '1:1381262', '1:1134930'])
    expect(h.published).toHaveLength(0)
  })

  it('a trip ended mid-fetch publishes nothing', async () => {
    at(SWAP_MS - 130)
    const h = await run({
      itinerary: PLAN1,
      onFetch: (tripId, hh) => {
        if (tripId === '1:1381262')
          hh.state.otp.goMode = { ...hh.state.otp.goMode, isActive: false }
      },
      snapshotsAfterMs: SWAP_MS
    })
    expect(h.published).toHaveLength(0)
  })

  it('a same-plan geometry repair mid-refresh still publishes', async () => {
    // REPAIR_LEG_GEOMETRY replaces the itinerary OBJECT (reducer :1082), so an
    // identity check would drop this refresh; the signature does not.
    at(SWAP_MS - 130)
    const blank = blankLeg1Geometry(PLAN1)
    const h = await run({
      itinerary: blank,
      onFetch: (tripId, hh) => {
        if (tripId === '1:1397642') {
          const it = hh.state.otp.goMode.activeItinerary
          const legs = it.legs.slice()
          legs[1] = { ...legs[1], legGeometry: PLAN1.legs[1].legGeometry }
          hh.state.otp.goMode = {
            ...hh.state.otp.goMode,
            activeItinerary: { ...it, legs }
          }
        }
      },
      snapshotsAfterMs: SWAP_MS
    })
    expect(h.state.otp.goMode.activeItinerary).not.toBe(blank)
    expect(h.published).toHaveLength(1)
    expect(h.published[0][1].boardEpoch).toBe(E_125320)
    expect(h.findTripCalls).toHaveLength(3)
  })
})
