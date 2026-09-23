/* globals afterEach, beforeEach, describe, expect, it, jest */
import FakeTimers from '@sinonjs/fake-timers'

import {
  confirmVehicleSelection,
  endGoMode,
  handlePositionUpdate
} from '../../../lib/actions/go-mode'
import {
  decideRiding,
  ridingTransitLegIndex
} from '../../../lib/util/go-mode/riding'
import { findTrip } from '../../../lib/actions/apiV2'
import goMode from '../../../lib/reducers/go-mode'
import type { RidingState } from '../../../lib/util/go-mode/types'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(
    () => () => Promise.resolve({ error: false, itineraries: [] })
  ),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * 2026-09-21 ride 1, session `mubbbiy9-6zjoq9` — backlog 23.2.
 *
 * Rider note 09:21:52: *"if I'm waiting at the stop and then I begin moving
 * rapidly away…. It's pretty safe to assume I'm on the bus. What went wrong
 * here?"*
 *
 * The plan had them cycling to I-35W & Lake St for a 10:12 Orange Line
 * (trip `1:1348464`). The bus that actually came was the 09:15 run —
 * `1:1268952`, vehicle 8228 — and they got on it. What followed, on
 * `0e91867ef`:
 *
 *  - `SHOW_BOARDING_PROMPT` 09:22:08.557 -> `CONFIRM_VEHICLE {1:8228, trip
 *    1:1268952, confirmed, 215.7 m}` 09:22:10.536. The tap worked. But
 *    `SET_RIDING` carried **`legIndex: 0`** — the BIKE leg, because
 *    `confirmVehicleSelection` stamps `goMode.routeMatch.legIndex`.
 *  - the aboard re-plan refused it outright: `go-mode.ts:7078-7081`,
 *    `const ridingLeg = itinerary.legs[riding.legIndex]; if
 *    (!ridingLeg?.transitLeg) return false`. So
 *    `replanFromAboard({reason:'boarded-earlier'})` never fired and the
 *    confirmed bus was never spliced in.
 *  - and the fact then died on the wrong geometry: `decideRiding` counts
 *    `offRouteSince` against the leg the MATCHER favours — the bike leg, which
 *    the rider was 192 m -> 1,166 m from because they were on a bus doing
 *    28 m/s down I-35W — and clears after `RIDING_OFFROUTE_CLEAR_MS` (90 s):
 *    `offRouteSince` 09:22:11.077 -> `CLEAR_RIDING` 09:23:42.054. The rider
 *    killed the trip three seconds later.
 *
 * Everything below runs the real tick over the ride's own recorded fixes and
 * vehicle snapshots. Measured on `0e91867ef` before the fix, by the same
 * harness: **zero** `START_REROUTE` of any reason in the window, and
 * `CLEAR_RIDING` at 09:23:42 — 91.0 s after the confirmation.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fx: any = require('../../../lib/util/go-mode/replay/fixtures/0921-0902-orange-lake-st.json')

const ROUTE_ID = '1:904'
const RIDDEN_TRIP = '1:1268952'
const PLANNED_TRIP = '1:1348464'
const VEHICLE_ID = '1:8228'

/** `CONFIRM_VEHICLE` 09:22:10.536. */
const CONFIRM_MS = 1790000530536
/** `CLEAR_RIDING` 09:23:42.054 — what the ride actually did. */
const CLEARED_MS = 1790000622054
/** The itinerary in force at the confirmation: the 09:21:17 quiet re-plan. */
const ITINERARY = fx.itinerarySwaps[2].itinerary
const LEGS: any[] = ITINERARY.legs

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

/** Every recorded fix in [from, to], in order. */
const fixesBetween = (fromMs: number, toMs: number) =>
  fx.gpsTrack.filter((p: any) => p.tMs >= fromMs && p.tMs <= toMs)

/** The route's live vehicles as the feed had them at `nowMs`. */
function vehiclesAt(nowMs: number): any[] {
  let best: any = null
  for (const snap of fx.vehicleSnapshots) {
    if (snap.routeId !== ROUTE_ID) continue
    if (snap.tMs <= nowMs && (!best || snap.tMs > best.tMs)) best = snap
  }
  return (best ?? fx.vehicleSnapshots[0])?.payload?.vehicles ?? []
}

const positionOf = (fix: any): GeolocationPosition =>
  ({
    coords: {
      accuracy: fix.accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: fix.heading,
      latitude: fix.lat,
      longitude: fix.lon,
      speed: fix.speed
    },
    timestamp: fix.tMs
  } as GeolocationPosition)

const mockedFindTrip = findTrip as jest.Mock
const initial = goMode(undefined, { type: '@@INIT' })

function makeStore() {
  let goModeState: any = {
    ...initial,
    activeItinerary: ITINERARY,
    isActive: true,
    tracking: { ...initial.tracking, lastPosition: null }
  }
  let nowMs = 0
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: {
        routes: { [ROUTE_ID]: { vehicles: vehiclesAt(nowMs) } },
        stops: {},
        trips: {}
      }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    goModeState = goMode(goModeState, action)
    return action
  }
  return {
    actions,
    dispatch,
    getGoMode: () => goModeState,
    setNow: (ms: number) => {
      nowMs = ms
    }
  }
}

describe('util > go-mode > the fixture is the ride the row describes', () => {
  it('has the rider cycling to Lake St for a bus an hour out', () => {
    expect(fx.meta.session).toBe('mubbbiy9-6zjoq9')
    expect(LEGS[0].transitLeg).toBeFalsy()
    expect(LEGS[0].mode).toBe('BICYCLE')
    expect(LEGS[1].transitLeg).toBe(true)
    expect(LEGS[1].trip.gtfsId).toBe(PLANNED_TRIP)
    expect(hhmmss(LEGS[1].startTime)).toBe('10:12:00')
  })

  it('and the bus they actually boarded in the feed, on another run', () => {
    const v = vehiclesAt(CONFIRM_MS).find(
      (x: any) => x.vehicleId === VEHICLE_ID
    )
    expect(v).toBeDefined()
    expect(v.tripId).toBe(RIDDEN_TRIP)
    expect(v.tripId).not.toBe(PLANNED_TRIP)
    expect(v.routeId).toBe(ROUTE_ID)
  })
})

describe('util > go-mode > a confirmed boarding on an access leg (23.2)', () => {
  let clock: FakeTimers.InstalledClock | undefined
  let store: ReturnType<typeof makeStore> | undefined

  const tick = (fix: any) => {
    clock?.setSystemTime(fix.tMs)
    store?.setNow(fix.tMs)
    store?.dispatch(handlePositionUpdate(positionOf(fix)))
  }

  beforeEach(() => {
    mockedFindTrip.mockClear()
    clock = FakeTimers.install({ now: CONFIRM_MS - 60000, toFake: ['Date'] })
    store = makeStore()
  })
  afterEach(() => {
    store?.dispatch(endGoMode())
    store = undefined
    clock?.uninstall()
    clock = undefined
  })

  /**
   * Run the window, tapping "I'm on the bus" at the recorded moment — unless
   * the app has already worked it out for itself by then (23.6), which from
   * this branch on it does. Either way the boarding lands through
   * `confirmVehicleSelection`, which is what this file is about.
   */
  const runWindow = () => {
    // From the 09:21:17 re-plan up to the last recorded fix, 09:23:43.
    for (const fix of fixesBetween(CONFIRM_MS - 50000, CLEARED_MS + 2000)) {
      if (fix.tMs >= CONFIRM_MS && !store?.getGoMode().riding) {
        clock?.setSystemTime(fix.tMs)
        store?.setNow(fix.tMs)
        store?.dispatch(confirmVehicleSelection(VEHICLE_ID))
      }
      tick(fix)
    }
  }

  it('reproduces the tap: SET_RIDING on the BIKE leg, naming the bus', () => {
    runWindow()
    const setRiding = store!.actions.filter((a) => a.type === 'SET_RIDING')
    expect(setRiding.length).toBeGreaterThan(0)
    const first = setRiding[0].payload as RidingState
    // The row's link (b), verbatim: the rider's tap works, and lands on leg 0.
    expect(first.legIndex).toBe(0)
    expect(first.tripId).toBe(RIDDEN_TRIP)
    expect(first.vehicleId).toBe(VEHICLE_ID)
    expect(LEGS[first.legIndex].transitLeg).toBeFalsy()
    // …and the leg the fact is ABOUT is the bus leg, one on.
    expect(ridingTransitLegIndex(LEGS, first)).toBe(1)
  })

  it('fires the aboard re-plan it could never fire before', () => {
    runWindow()
    const reroutes = store!.actions.filter((a) => a.type === 'START_REROUTE')
    expect(reroutes.length).toBeGreaterThan(0)
    expect(reroutes.every((a) => a.payload.reason === 'boarded-earlier')).toBe(
      true
    )
    expect(reroutes[0].payload.autoApply).toBe(true)
    // On 0e91867ef this window produced no START_REROUTE at all, of any
    // reason. With only 23.2 in place the first one landed at 09:22:10.999,
    // 463 ms after the rider's CONFIRM_VEHICLE — the tap being the only way
    // the app could learn it. 23.6 now reaches the same conclusion from the
    // same evidence without being asked: this window opens at 09:21:20, the
    // four access-board gates are already satisfied, and the twenty-second
    // bar is met at 09:21:44 — 26 s before the rider reached for the button.
    // Same reason, same route, same trip; only sooner.
    expect(hhmmss(reroutes[0].payload.startedAtMs)).toBe('09:21:44')

    // It splices from the trip the rider is ON. (The live-times refresh fetches
    // the PLANNED trip on its own schedule, so look for the id, not the order.)
    const fetched = mockedFindTrip.mock.calls.map((c: any[]) => c[0]?.tripId)
    expect(fetched).toContain(RIDDEN_TRIP)
    // …and it keeps the rider's own line: the route of the leg they have not
    // boarded yet, which here is the Orange Line itself.
    expect(reroutes[0].payload.keepRouteId).toBe(ROUTE_ID)

    // `findTrip` is mocked empty here, so every attempt settles as a failed
    // search and the caller is free to retry — bounded by
    // EARLY_BOARD_REPLAN_RETRY_MS and the three-attempt cap, which is why 83 s
    // of ticking yields two attempts and not eighty.
    expect(reroutes.length).toBeLessThanOrEqual(2)
  })

  it('keeps the riding fact alive past the 90 s the ride lost it at', () => {
    runWindow()
    expect(
      store!.actions.filter((a) => a.type === 'CLEAR_RIDING')
    ).toHaveLength(0)
    const riding = store!.getGoMode().riding
    expect(riding?.tripId).toBe(RIDDEN_TRIP)
    expect(riding?.vehicleId).toBe(VEHICLE_ID)
    // The clock ran well past RIDING_OFFROUTE_CLEAR_MS — the ride cleared at
    // 09:23:42.054, 91.0 s after the confirmation.
    expect(CLEARED_MS - CONFIRM_MS).toBeGreaterThan(90000)
  })

  it('never stamps offRouteSince off the bike leg while on the bus shape', () => {
    runWindow()
    const stamped = store!.actions.filter(
      (a) => a.type === 'SET_RIDING' && a.payload?.offRouteSince != null
    )
    expect(stamped).toHaveLength(0)
  })
})

describe('util > go-mode > which geometry the off-route clock runs on', () => {
  const riding: RidingState = {
    boardedAt: CONFIRM_MS,
    headsign: 'ORANGE Burnsville',
    legIndex: 0,
    offRouteSince: null,
    routeId: ROUTE_ID,
    routeShortName: null,
    tripId: RIDDEN_TRIP,
    vehicleId: VEHICLE_ID
  }
  // The bike leg, as the matcher saw it once the rider was on the bus.
  const offTheBikeLeg = {
    distanceFromRoute: 1166,
    isOnRoute: false,
    legIndex: 0,
    matchedAtMs: CONFIRM_MS,
    nearestPoint: [44.9305658, -93.2747852] as [number, number],
    progressAlongLeg: 0.4
  } as any
  const base = {
    matchedLeg: LEGS[0],
    nowMs: CONFIRM_MS + 1000,
    offRouteClearMs: 90000,
    riderSpeedMps: 25.8,
    routeMatch: offTheBikeLeg,
    vehicleMatch: null
  }

  it('with no corridor it behaves exactly as it did — marks off route', () => {
    expect(decideRiding({ ...base, prevRiding: riding })).toEqual({
      kind: 'markOffRoute',
      riding: { ...riding, offRouteSince: base.nowMs }
    })
  })

  it('on the ridden bus shape the fact refreshes instead', () => {
    expect(
      decideRiding({
        ...base,
        prevRiding: riding,
        ridingCorridor: { isOnRoute: true }
      })
    ).toEqual({ kind: 'none' })
    expect(
      decideRiding({
        ...base,
        prevRiding: { ...riding, offRouteSince: CONFIRM_MS },
        ridingCorridor: { isOnRoute: true }
      })
    ).toEqual({ kind: 'set', riding: { ...riding, offRouteSince: null } })
  })

  it('off the ridden bus shape the clock still runs, and still clears', () => {
    const corridor = { isOnRoute: false }
    expect(
      decideRiding({ ...base, prevRiding: riding, ridingCorridor: corridor })
    ).toEqual({
      kind: 'markOffRoute',
      riding: { ...riding, offRouteSince: base.nowMs }
    })
    expect(
      decideRiding({
        ...base,
        nowMs: CONFIRM_MS + 91000,
        prevRiding: { ...riding, offRouteSince: CONFIRM_MS },
        ridingCorridor: corridor
      })
    ).toEqual({ kind: 'clear' })
  })

  it('a fact no real bus stands behind gets no corridor exemption', () => {
    expect(
      decideRiding({
        ...base,
        prevRiding: { ...riding, vehicleId: null },
        ridingCorridor: { isOnRoute: true }
      })
    ).toEqual({
      kind: 'markOffRoute',
      riding: { ...riding, offRouteSince: base.nowMs, vehicleId: null }
    })
  })
})

describe('util > go-mode > ridingTransitLegIndex', () => {
  const riding: RidingState = {
    boardedAt: CONFIRM_MS,
    headsign: 'ORANGE Burnsville',
    legIndex: 0,
    offRouteSince: null,
    routeId: ROUTE_ID,
    routeShortName: null,
    tripId: RIDDEN_TRIP,
    vehicleId: VEHICLE_ID
  }

  it('names the trip when the plan already carries it — the spliced leg', () => {
    const spliced = [
      LEGS[0],
      { ...LEGS[1], trip: { gtfsId: RIDDEN_TRIP } },
      LEGS[2]
    ]
    expect(ridingTransitLegIndex(spliced, riding)).toBe(1)
    // Which is what makes the aboard-replan trigger self-terminating: after a
    // successful splice the ridden leg IS the planned leg, and
    // shouldReplanBoardedEarlier short-circuits on that.
  })

  it('walks forward off an access leg to the bus on the same route', () => {
    expect(ridingTransitLegIndex(LEGS, riding)).toBe(1)
  })

  it('refuses to walk forward onto a DIFFERENT route', () => {
    const other = [
      LEGS[0],
      { ...LEGS[1], route: { gtfsId: '1:921' }, routeId: '1:921' },
      LEGS[2]
    ]
    expect(ridingTransitLegIndex(other, riding)).toBe(-1)
  })

  it('is -1 for a fact that names no trip at all', () => {
    expect(ridingTransitLegIndex(LEGS, { ...riding, tripId: null })).toBe(-1)
    expect(ridingTransitLegIndex(LEGS, null)).toBe(-1)
  })
})
