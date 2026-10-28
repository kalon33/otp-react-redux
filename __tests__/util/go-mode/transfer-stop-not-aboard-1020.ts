import { existsSync } from 'fs'
import path from 'path'

import FakeTimers from '@sinonjs/fake-timers'

import '../../test-utils/mock-window-url'
import { browseFromCurrentPosition } from '../../../lib/actions/go-mode'
import {
  calculateDistance,
  decodeLegGeometry
} from '../../../lib/util/go-mode/position-matching'
import {
  riderLeftRiddenLeg,
  RIDING_ESTABLISH_MIN_SPEED_MPS
} from '../../../lib/util/go-mode/riding'
import { ridingRoutePreferred } from '../../../lib/actions/apiV2'
import goMode from '../../../lib/reducers/go-mode'
import slice from '../../../lib/util/go-mode/replay/fixtures/slices/ride-1020-1629-transfer-slice.json'

// setQueryParam(patch, searchId) dispatches routingQuery(searchId): count it,
// do not run it.
jest.mock('../../../lib/actions/api', () => ({
  ...jest.requireActual('../../../lib/actions/api'),
  routingQuery: (searchId: string) => ({
    payload: searchId,
    type: 'TEST_ROUTING_QUERY'
  })
}))

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(
    () => () => Promise.resolve({ error: false, itineraries: [] })
  ),
  fetchRerouteSnapshotPlan: jest.fn(() => () => Promise.resolve(null)),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve(null))
}))

/**
 * Backlog 70.3 — at a bus-to-bus transfer stop the app still had the rider
 * "on the Gold Line" after they got off.
 *
 * 2026-10-20, session `mvh6ypt8-rtb6ih` (DEV 2026.1020.5), day file
 * debug-2026-10-20.jsonl, slice 16:29:00-16:34:00 CDT. The 16:29:34 onboard
 * Confirm planned Gold Line bus 1:8233 (trip 1:1345472) 6th St & Minnesota ->
 * 6th St & Washington, then the 94 at 16:37:28. Leg 0 read 100 % /
 * stopsRemaining 0 from 16:30:52; the board-time gate held TRANSITION_LEG (the
 * 94 was > 5 min out), so `riding` stayed 8233. The rider stood 3-22 m from
 * the stop at 0-0.6 m/s. Bus 8233's records:
 *   rx 16:31:21.646  frame 16:30:36  STOPPED_AT 6th St & Washington
 *   rx 16:31:36.656  frame 16:30:44  STOPPED_AT 6th St & Washington
 *   rx 16:31:51.649  frame 16:31:16  IN_TRANSIT_TO Smith Ave & 5th St (~200 m on)
 * The reroute tap at 16:32:03.962 handed off to the aboard flow and offered
 * the Gold Line's stops; the pick started a trip 431 m up the line.
 */

const s: any = slice
const ITIN = s.itinerary
const RIDING = s.riding.riding
const ROUTE = RIDING.routeId
const TAP_MS = 1792531923962 // 16:32:03.962 START_REROUTE
const SWAP_MS = 1792531941448 // 16:32:21.448 START_GO_MODE (the bad pick)
const CONFIRM_MS = 1792531774927 // 16:29:34.927 START_GO_MODE (this plan)
const BUS_PAST_RX_MS = 1792531911649 // 16:31:51.649 — first record past Washington

const initial = goMode(undefined, { type: '@@INIT' })

const lastAtOrBefore = (list: any[], t: number) => {
  let hit: any = null
  for (const x of list) {
    if (x.tMs <= t) hit = x
    else break
  }
  return hit
}

const posOf = (g: any): GeolocationPosition =>
  ({
    coords: {
      accuracy: g.accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: g.heading,
      latitude: g.lat,
      longitude: g.lon,
      speed: g.speed
    },
    timestamp: g.tMs
  } as any)

/** The app's state as the slice recorded it at `t`. */
function stateAt(
  fixture: any,
  t: number,
  over: {
    itinerary?: any
    progress?: any
    riding?: any
    routeId?: string
  } = {}
) {
  const gps = [...fixture.gpsTrack].sort((a: any, b: any) => a.tMs - b.tMs)
  const routeId = over.routeId ?? ROUTE
  const snaps = (fixture.vehicleSnapshots || []).filter(
    (v: any) => (v.routeId ?? v.payload?.routeId) === routeId
  )
  const snap = lastAtOrBefore(snaps, t)
  const fix = lastAtOrBefore(gps, t)
  const progress =
    over.progress !== undefined
      ? over.progress
      : lastAtOrBefore(fixture.progressTrack || [], t)
  const routeMatch = lastAtOrBefore(fixture.routeMatchTrack || [], t)
  return {
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: {
        ...initial,
        activeItinerary: over.itinerary ?? fixture.itinerary,
        isActive: true,
        progress: progress
          ? { ...progress, currentTime: new Date(t) }
          : (null as any),
        riding: over.riding ?? RIDING,
        routeMatch: routeMatch
          ? { ...routeMatch, matchedAtMs: routeMatch.tMs }
          : null,
        tracking: {
          ...initial.tracking,
          isTracking: true,
          lastPosition: fix ? posOf(fix) : null,
          lastTrustedPosition: fix ? posOf(fix) : null
        }
      },
      location: { currentPosition: {} },
      transitIndex: {
        routes: { [routeId]: { vehicles: snap?.payload?.vehicles ?? [] } },
        stops: {},
        trips: {}
      }
    }
  }
}

describe('riderLeftRiddenLeg on the 2026-10-20 16:29 transfer (70.3)', () => {
  const ticks: number[] = s.progressTrack
    .map((p: any) => p.tMs)
    .filter((t: number) => t >= CONFIRM_MS && t < SWAP_MS)
  // The vehicle-record receipts are instants too: the flip belongs to one.
  const instants: number[] = [
    ...ticks,
    ...s.vehicleSnapshots
      .map((v: any) => v.tMs)
      .filter((t: number) => t >= CONFIRM_MS && t < SWAP_MS)
  ].sort((a, b) => a - b)

  it('measures one flip, false -> true, at the 16:31:51.649 record', () => {
    const verdicts = instants.map((t) => ({
      t,
      v: riderLeftRiddenLeg(stateAt(s, t), t)
    }))
    const flips = verdicts.filter((x, i) => i > 0 && x.v !== verdicts[i - 1].v)
    expect(flips).toEqual([{ t: BUS_PAST_RX_MS, v: true }])
  })

  it('is false while the bus is moving with the rider (16:29:32-16:30:48)', () => {
    const from = Date.parse('2026-10-20T21:29:32Z')
    const to = Date.parse('2026-10-20T21:30:48Z')
    const moving = instants.filter((t) => t >= from && t <= to)
    expect(moving.length).toBeGreaterThan(60)
    for (const t of moving) {
      expect(riderLeftRiddenLeg(stateAt(s, t), t)).toBe(false)
    }
  })

  it('is false while the bus dwells at Washington with the rider (frames 16:30:36 / 16:30:44)', () => {
    // Those frames arrived 16:31:21.646 and 16:31:36.656; they are the
    // freshest record until 16:31:51.649. The leg already reads finished and
    // the rider is parked 13-15 m from the stop — only the bus says "not gone".
    const dwell = instants.filter(
      (t) => t >= 1792531881646 && t < BUS_PAST_RX_MS
    )
    expect(dwell.length).toBeGreaterThan(20)
    for (const t of dwell) {
      const st: any = stateAt(s, t)
      expect(st.otp.goMode.progress.stopsRemaining).toBe(0)
      expect(riderLeftRiddenLeg(st, t)).toBe(false)
    }
  })

  it('is true from the 16:31:51 record through the 16:32:03.962 tap', () => {
    const after = instants.filter((t) => t >= BUS_PAST_RX_MS && t <= TAP_MS)
    expect(after.length).toBeGreaterThan(10)
    for (const t of after) {
      expect(riderLeftRiddenLeg(stateAt(s, t), t)).toBe(true)
    }
  })

  it('needs fresh evidence: no record, an undated record, or a stale one is false', () => {
    const st: any = stateAt(s, TAP_MS)
    const v = st.otp.transitIndex.routes[ROUTE].vehicles
    st.otp.transitIndex.routes[ROUTE].vehicles = v.filter(
      (x: any) => x.vehicleId !== RIDING.vehicleId
    )
    expect(riderLeftRiddenLeg(st, TAP_MS)).toBe(false)
    st.otp.transitIndex.routes[ROUTE].vehicles = v.map((x: any) =>
      x.vehicleId === RIDING.vehicleId ? { ...x, seconds: null } : x
    )
    expect(riderLeftRiddenLeg(st, TAP_MS)).toBe(false)
    // The same record, read 121 s after its frame.
    const frameMs = 1792531876000 // 16:31:16
    expect(riderLeftRiddenLeg(stateAt(s, TAP_MS), frameMs + 121_000)).toBe(
      false
    )
  })

  it('needs the rider parked at the alight stop on the finished leg', () => {
    const base: any = stateAt(s, TAP_MS)
    const fix = base.otp.goMode.tracking.lastPosition
    const withFix = (coords: any) => ({
      ...base,
      otp: {
        ...base.otp,
        goMode: {
          ...base.otp.goMode,
          tracking: {
            ...base.otp.goMode.tracking,
            lastPosition: { ...fix, coords: { ...fix.coords, ...coords } }
          }
        }
      }
    })
    expect(
      riderLeftRiddenLeg(
        withFix({ speed: RIDING_ESTABLISH_MIN_SPEED_MPS }),
        TAP_MS
      )
    ).toBe(false)
    expect(riderLeftRiddenLeg(withFix({ speed: null }), TAP_MS)).toBe(false)
    // 6th St & Minnesota, ~200 m back — not at the alight stop.
    expect(
      riderLeftRiddenLeg(
        withFix({ latitude: 44.9474, longitude: -93.0933 }),
        TAP_MS
      )
    ).toBe(false)
    const unfinished = stateAt(s, TAP_MS, {
      progress: {
        currentLegIndex: 0,
        currentLegProgress: 98.09,
        stopsRemaining: 1
      }
    })
    expect(riderLeftRiddenLeg(unfinished, TAP_MS)).toBe(false)
  })
})

describe('the 16:32:03.962 reroute tap (70.3)', () => {
  let clock: any
  beforeEach(() => {
    clock = FakeTimers.install({ now: TAP_MS, toFake: ['Date'] })
  })
  afterEach(() => clock.uninstall())

  function run(state: any) {
    const actions: any[] = []
    const getState = () => state
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      actions.push(action)
      return action
    }
    dispatch(browseFromCurrentPosition())
    return actions
  }

  it('runs a normal planner search from the rider, no aboard hand-off, no stay-seated levers', async () => {
    const st = stateAt(s, TAP_MS)
    const actions = run(st)
    await Promise.resolve()
    const types = actions.map((a) => a.type)
    expect(types).not.toContain('START_REROUTE')
    expect(types).not.toContain('SET_ONBOARD_VEHICLE')
    expect(types).toContain('TEST_ROUTING_QUERY')
    expect(types).toContain('SET_GO_MODE_BACKGROUNDED')
    const query = actions.find((a) => a.type === 'SET_QUERY_PARAM')?.payload
    expect(query).toBeTruthy()
    expect(query.routingPreferences).toBeUndefined()
    // The origin is where the rider is: 6th St & Washington (the leg's last
    // stop), never Smith Ave & 5th St up the Gold Line.
    expect(query.from.name).not.toMatch(/Smith/)
    const d = calculateDistance(
      query.from.lat,
      query.from.lon,
      ITIN.legs[0].to.lat,
      ITIN.legs[0].to.lon
    )
    expect(d).toBeLessThan(30)
    // ...and the search it fires carries no Gold Line bias.
    expect(ridingRoutePreferred(st, TAP_MS)).toBeUndefined()
  })

  it('before the bus left (16:31:40) the same tap still reads the rider as aboard', async () => {
    clock.setSystemTime(1792531900000)
    const st = stateAt(s, 1792531900000)
    const actions = run(st)
    await Promise.resolve()
    const types = actions.map((a) => a.type)
    expect(types).toContain('START_REROUTE')
    expect(types).not.toContain('SET_QUERY_PARAM')
    expect(ridingRoutePreferred(st, 1792531900000)).toEqual({
      otherThanPreferredRoutesPenalty: 900,
      routes: '1:905'
    })
  })
})

describe('a synthetic dwell at an intermediate stop stays aboard (70.3)', () => {
  // The rider sits on a bus parked at an intermediate stop; its record says
  // the NEXT stop after it (the pull-out shape) and the bus is 300 m off in the
  // feed. The leg is not finished, so nothing about the alight stop applies.
  const leg = {
    from: { lat: 44.9, lon: -93.2, name: 'A', stopId: '1:1' },
    intermediatePlaces: [
      { lat: 44.91, lon: -93.2, name: 'B', stop: { gtfsId: '1:2' } },
      { lat: 44.92, lon: -93.2, name: 'C', stop: { gtfsId: '1:3' } }
    ],
    mode: 'BUS',
    routeId: '1:X',
    to: { lat: 44.93, lon: -93.2, name: 'D', stopId: '1:4' },
    transitLeg: true,
    tripId: '1:T'
  }
  const T = 1792531923962
  const riding = {
    ...RIDING,
    routeId: '1:X',
    tripId: '1:T',
    vehicleId: '1:V'
  }
  const fixAt = (lat: number) => ({
    coords: { accuracy: 8, latitude: lat, longitude: -93.2, speed: 0 },
    timestamp: T - 1000
  })
  const vehicle = (nextStopId: string, lat: number, tripId = '1:T') => ({
    lat,
    lon: -93.2,
    nextStopId,
    seconds: T / 1000 - 20,
    tripId,
    vehicleId: '1:V'
  })
  const st = (progress: any, fixLat: number, v: any) => ({
    otp: {
      goMode: {
        ...initial,
        activeItinerary: { legs: [leg] },
        isActive: true,
        progress,
        riding,
        tracking: { ...initial.tracking, lastPosition: fixAt(fixLat) }
      },
      transitIndex: { routes: { '1:X': { vehicles: [v] } } }
    }
  })

  it('is false at B with the bus record pointing at C', () => {
    expect(
      riderLeftRiddenLeg(
        st(
          { currentLegIndex: 0, currentLegProgress: 34, stopsRemaining: 2 },
          44.91,
          vehicle('1:3', 44.913)
        ),
        T
      )
    ).toBe(false)
  })

  it('is false at the alight stop while the bus is stopped there', () => {
    expect(
      riderLeftRiddenLeg(
        st(
          { currentLegIndex: 0, currentLegProgress: 100, stopsRemaining: 0 },
          44.93,
          vehicle('1:4', 44.9301)
        ),
        T
      )
    ).toBe(false)
  })

  it('is false when a record past the alight stop still sits with the rider (pull-out lag)', () => {
    expect(
      riderLeftRiddenLeg(
        st(
          { currentLegIndex: 0, currentLegProgress: 100, stopsRemaining: 0 },
          44.93,
          vehicle('1:5', 44.9305)
        ),
        T
      )
    ).toBe(false)
  })

  it('is true when the bus has gone on — past the stop, or onto its next run', () => {
    const done = {
      currentLegIndex: 0,
      currentLegProgress: 100,
      stopsRemaining: 0
    }
    expect(riderLeftRiddenLeg(st(done, 44.93, vehicle('1:5', 44.933)), T)).toBe(
      true
    )
    expect(
      riderLeftRiddenLeg(st(done, 44.93, vehicle('1:2', 44.94, '1:T2')), T)
    ).toBe(true)
  })
})

/**
 * Riders truly aboard, on real rides: at every fix of the ridden leg up to the
 * first one within 120 m of its alight stop, the predicate is false EVEN WITH
 * the progress forced to "finished" (the worst a lagging progress could say),
 * and the reroute button still hands off to the aboard flow mid-leg.
 */
const FIXTURE_DIR = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)
const load = (name: string) => {
  const p = path.join(FIXTURE_DIR, `${name}.json`)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return existsSync(p) ? require(p) : null
}

const ABOARD_CASES: {
  itinerary: (f: any) => any
  legIndex: number
  name: string
}[] = [
  {
    // The 94 Concordia -> 5th St & Cedar, on the 09:25:16 plan.
    itinerary: (f) => f.itinerarySwaps[f.itinerarySwaps.length - 1],
    legIndex: 0,
    name: 'ride-1020-0907'
  },
  { itinerary: (f) => f.itinerary, legIndex: 1, name: 'orange-1600-0928' },
  {
    itinerary: (f) => f.itinerary,
    legIndex: 0,
    name: '0921-0924-orange-onboard'
  }
]

for (const c of ABOARD_CASES) {
  const f = load(c.name)
  const maybe = f ? describe : describe.skip
  maybe(`truly aboard on ${c.name} (70.3 regression)`, () => {
    const swap = f && c.itinerary(f)
    const itinerary = swap?.itinerary ?? swap
    const leg = itinerary?.legs?.[c.legIndex]
    const routeId = leg?.routeId ?? leg?.route?.gtfsId
    const tripId = leg?.tripId ?? leg?.trip?.gtfsId
    const startMs = Math.max(leg?.startTime ?? 0, swap?.tMs ?? 0) + 60_000
    const gps = f ? [...f.gpsTrack].sort((a: any, b: any) => a.tMs - b.tMs) : []
    const nearEnd = gps.find(
      (g: any) =>
        g.tMs > startMs &&
        calculateDistance(g.lat, g.lon, leg.to.lat, leg.to.lon) <= 120
    )
    const window = gps.filter(
      (g: any) => g.tMs >= startMs && g.tMs < (nearEnd?.tMs ?? leg?.endTime)
    )
    let vehicleId: string | null = null
    for (const snap of f?.vehicleSnapshots || []) {
      const hit = (snap.payload?.vehicles || []).find(
        (v: any) => v.tripId === tripId
      )
      if (hit) {
        vehicleId = hit.vehicleId
        break
      }
    }
    const riding = {
      boardedAt: startMs - 60_000,
      headsign: null,
      legIndex: c.legIndex,
      offRouteSince: null,
      routeId,
      routeShortName: null,
      tripId,
      vehicleId
    }
    const finished = {
      currentLegIndex: c.legIndex,
      currentLegProgress: 100,
      stopsRemaining: 0
    }

    it('has a vehicle, a window and parked ticks to test', () => {
      expect(vehicleId).toBeTruthy()
      expect(decodeLegGeometry(leg).length).toBeGreaterThan(1)
      expect(window.length).toBeGreaterThan(100)
    })

    it('never reads the rider as having left, even with progress forced finished', () => {
      const lefts = window.filter((g: any) =>
        riderLeftRiddenLeg(
          stateAt(f, g.tMs, { itinerary, progress: finished, riding, routeId }),
          g.tMs
        )
      )
      expect(lefts).toEqual([])
    })

    it('stays false at every real stop dwell, with that stop made the alight stop', () => {
      // The hard case on real data: the rider parked aboard at a stop, the bus
      // records around them, and the leg cut short so THAT stop is where it
      // ends and progress says finished. Only the vehicle evidence is left to
      // answer — and it must not say "gone" while the rider is on it.
      const places = (leg.intermediatePlaces || []).filter(
        (p: any) => p?.lat != null
      )
      const calls = [...places, leg.to]
      let dwells = 0
      const lefts: number[] = []
      for (const g of window) {
        if (!(g.speed != null && g.speed < RIDING_ESTABLISH_MIN_SPEED_MPS)) {
          continue
        }
        const k = calls.findIndex(
          (p: any) => calculateDistance(g.lat, g.lon, p.lat, p.lon) <= 120
        )
        if (k < 0) continue
        dwells++
        const cut = {
          ...leg,
          intermediatePlaces: places.slice(0, k),
          to: { ...calls[k], stopId: calls[k].stopId ?? calls[k].stop?.gtfsId }
        }
        const legs = [...itinerary.legs]
        legs[c.legIndex] = cut
        const st = stateAt(f, g.tMs, {
          itinerary: { ...itinerary, legs },
          progress: finished,
          riding,
          routeId
        })
        if (riderLeftRiddenLeg(st, g.tMs)) lefts.push(g.tMs)
      }
      expect(dwells).toBeGreaterThan(0)
      expect(lefts).toEqual([])
    })

    it('hands the reroute button to the aboard flow mid-leg', async () => {
      const mid = window[Math.floor(window.length / 2)].tMs
      const clock = FakeTimers.install({ now: mid, toFake: ['Date'] })
      try {
        const st = stateAt(f, mid, {
          itinerary,
          progress: {
            currentLegIndex: c.legIndex,
            currentLegProgress: 50,
            stopsRemaining: 2
          },
          riding,
          routeId
        })
        const actions: any[] = []
        const dispatch: any = (a: any) => {
          if (typeof a === 'function') return a(dispatch, () => st)
          actions.push(a)
          return a
        }
        dispatch(browseFromCurrentPosition())
        await Promise.resolve()
        const types = actions.map((a) => a.type)
        expect(types).toContain('START_REROUTE')
        expect(types).not.toContain('SET_QUERY_PARAM')
        expect(ridingRoutePreferred(st, mid)).toEqual({
          otherThanPreferredRoutesPenalty: 900,
          routes: routeId
        })
      } finally {
        clock.uninstall()
      }
    })
  })
}
