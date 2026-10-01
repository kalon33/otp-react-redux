/* globals afterEach, beforeEach, describe, expect, it, jest */
import FakeTimers from '@sinonjs/fake-timers'

import {
  ACCESS_BOARD_MIN_MS,
  ACCESS_BOARD_MIN_SPEED_MPS,
  ACCESS_BOARD_MIN_TICKS,
  accessBoardEstablished,
  accessBoardGates,
  BOARD_AUTO_CONFIRM_MIN_CONSECUTIVE,
  RIDING_ESTABLISH_MAX_ACCURACY_M,
  RIDING_ESTABLISH_MAX_DISTANCE_M,
  trackAccessBoard
} from '../../../lib/util/go-mode/riding'
import {
  denyBoardingByRider,
  endGoMode,
  handlePositionUpdate
} from '../../../lib/actions/go-mode'
import { findTrip } from '../../../lib/actions/apiV2'
import goMode from '../../../lib/reducers/go-mode'
import type { AccessBoardSample } from '../../../lib/util/go-mode/riding'

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
 * ─────────────────────────────────────────────────────────────────────────────
 * Backlog 23.6 — the app noticing, by itself, that the rider got on a bus
 * while the plan still had them on an access (bike/walk) leg.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE ASK. The rider, 2026-09-21 09:21:52, mid-ride: *"if I'm waiting at the
 * stop and then I begin moving rapidly away…. It's pretty safe to assume I'm
 * on the bus. What went wrong here? Do deep analysis"*.
 *
 * WHAT WAS THERE. Nothing that could answer. `decideRiding` opens with
 * `onTransit = routeMatch.isOnRoute && matchedLeg.transitLeg` and returns
 * before it evaluates anything when that is false. The other automatic path,
 * `performVehicleMatching`'s auto-confirm, is reachable only through
 * `shouldShowBoardingPrompt`, which refuses while
 * `boardingPrompt.transitLegEnteredAt` is null — and the only writer of that
 * stamp is `startVehicleTracking`, armed on transit legs. And until this
 * branch nothing even POLLED a match on an access leg unless a riding fact
 * already existed (23.2a). So on 09-21 the rider did 12–30 m/s down I-35W for
 * two minutes with vehicle 8228 sitting in the polled feed, and the app
 * learned it only when they tapped "I'm on the bus" at 09:22:08.
 *
 * WHY IT IS NOT JUST A MATTER OF LOWERING A GATE. Every automatic boarding
 * heuristic this app has ever had fired on proximity and had to be ripped out:
 *
 *   - 2026-08-27: a cyclist on a street 248 m from a parallel bus route
 *     crossed `RIDING_MIN_PROGRESS` and was declared aboard; the
 *     boarded-earlier replan then deleted the bike leg they were on.
 *   - 2026-09-01 ride 1, 08:26:26: ONE poll (`consecutiveMatches: 1`,
 *     confidence `medium`) of a bus 135 m away whose own `nextStopId` was
 *     still the rider's platform — it had not arrived — minted `confirmed`
 *     and SET_RIDING 3 ms later.
 *   - 2026-09-01 ride 2, 10:47:15: 8.01 m/s, **4.3 km** from the boarding
 *     stop, `vehicleId: null`, `confidence: "none"`, zero vehicles in the
 *     feed. The only quantity that moved on the deciding tick was
 *     `distanceFromRoute` crossing 100 m as a bike path converged on the
 *     Orange Line's shape.
 *   - 2026-08-31 17:15:01: a fix reporting 1,254.7 m of accuracy and no speed.
 *
 * So the rider's standing rule — *bus detection uses route geometry and live
 * vehicles, never stop proximity* — and this design's rule: it may only ever
 * ADD requirements to the ones those incidents bought.
 *
 * THE DESIGN. On an access leg, with no riding fact, four facts must hold on
 * the SAME tick, for {@link ACCESS_BOARD_MIN_TICKS} consecutive ticks spanning
 * {@link ACCESS_BOARD_MIN_MS}, all naming ONE vehicle:
 *
 *   1. TRANSIT-PACE MOTION — `riderSpeedMps >= ACCESS_BOARD_MIN_SPEED_MPS`
 *      (12 m/s = 27 mph). Not `RIDING_ESTABLISH_MIN_SPEED_MPS` (3 m/s): that
 *      number separates a rider at a kerb from one being carried, and it is
 *      allowed to be low because other gates carry it. This one has to
 *      separate a BICYCLE from a bus. 12 m/s is the ride-watch daemon's own
 *      `ACCESS_TRANSIT_SPEED_MPS`, picked against the same evidence — above
 *      any bicycle, above the 5.9 m/s `early-leg-transition` measured on a
 *      rider genuinely sprinting for a station, below a freeway — and its rule
 *      fired on this very ride at 09:20:25.
 *   2. THE RIDER'S TRACK ON THE NEXT TRANSIT LEG'S CORRIDOR — their own fix
 *      projected onto the BUS leg's shape (`matchPositionToRoute`), `isOnRoute`
 *      and within {@link RIDING_ESTABLISH_MAX_DISTANCE_M} (100 m) of it. Route
 *      geometry, never stop proximity; and the tight ESTABLISH bound, not the
 *      matcher's 250 m usable corridor, because 250 m is what the 8/27
 *      parallel-street board came in under.
 *   3. A VEHICLE OF THAT ROUTE MATCHING THE RIDER, on the ordinary terms —
 *      `confidence` high or confirmed, `matchDescribesLeg` (it is about this
 *      route), `matchServesLegStops` (it is going somewhere this leg goes),
 *      `vehicleReachedBoardStop` (a bus still naming the rider's own stop has
 *      not arrived), and {@link BOARD_AUTO_CONFIRM_MIN_CONSECUTIVE} (3)
 *      consecutive polls. Every one of those is a rule `decideRiding` already
 *      applies to a first establishment. There is deliberately NO second
 *      matcher.
 *   4. A FIX GOOD ENOUGH TO PLACE THE RIDER —
 *      {@link RIDING_ESTABLISH_MAX_ACCURACY_M} (100 m).
 *
 * On establish the app calls `confirmVehicleSelection` — the very thunk the
 * rider's own "I'm on the bus" tap calls — so 23.2's aboard re-plan trigger
 * reads exactly the fact it already knows how to read, and the plan re-targets
 * the way a tap makes it re-target. One way to board, not two. A rider's
 * standing "Not on the bus" (`BOARDING_DENIAL_HOLD_MS`, 3 min) outranks it.
 *
 * WHAT IT WILL NOT DO, said plainly: a local bus crawling through city traffic
 * never reaches 27 mph, so this never notices that boarding. The tap does.
 *
 * MEASURED, all four gates at once, over the recorded rides (see the replays
 * below for the numbers this file asserts).
 */

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

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

/** The itinerary Go Mode was holding at `tMs`. */
function itineraryAt(fx: any, tMs: number): any {
  let best = fx.itinerary
  for (const s of fx.itinerarySwaps ?? []) if (s.tMs <= tMs) best = s.itinerary
  return best
}

/**
 * A store over one fixture: the real go-mode reducer, the ride's own recorded
 * vehicle snapshots, and the itinerary that was in force when the window
 * opened. `vehiclesAt` is memoised per snapshot because `getState()` is called
 * many times per tick.
 */
function makeStore(fx: any, itinerary: any, routeIds: string[]) {
  let goModeState: any = {
    ...initial,
    activeItinerary: itinerary,
    isActive: true,
    tracking: { ...initial.tracking, lastPosition: null }
  }
  let nowMs = 0
  const actions: any[] = []
  const snapCache = new Map<string, any[]>()
  const vehiclesAt = (routeId: string, at: number) => {
    let best: any = null
    for (const snap of fx.vehicleSnapshots ?? []) {
      if (snap.routeId !== routeId) continue
      if (snap.tMs <= at && (!best || snap.tMs > best.tMs)) best = snap
    }
    const key = `${routeId}:${best?.tMs ?? 0}`
    if (!snapCache.has(key)) {
      snapCache.set(key, best?.payload?.vehicles ?? [])
    }
    return snapCache.get(key) as any[]
  }
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: {
        routes: Object.fromEntries(
          routeIds.map((r) => [r, { vehicles: vehiclesAt(r, nowMs) }])
        ),
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

/**
 * Replay one window of one fixture through the REAL tick and report what the
 * automatic board did. `deny` stamps a rider "Not on the bus" first, which is
 * how the tap-only behaviour is reproduced for comparison.
 */
function replay(
  fx: any,
  fromMs: number,
  toMs: number,
  routeIds: string[],
  opts: { deny?: boolean; tapAtMs?: number; tapVehicleId?: string } = {}
) {
  const itinerary = itineraryAt(fx, fromMs)
  const clock = FakeTimers.install({ now: fromMs - 1000, toFake: ['Date'] })
  const store = makeStore(fx, itinerary, routeIds)
  try {
    if (opts.deny) {
      clock.setSystemTime(fromMs - 500)
      store.setNow(fromMs - 500)
      store.dispatch(denyBoardingByRider())
    }
    for (const fix of fx.gpsTrack) {
      if (fix.tMs < fromMs || fix.tMs > toMs) continue
      clock.setSystemTime(fix.tMs)
      store.setNow(fix.tMs)
      if (
        opts.tapAtMs != null &&
        fix.tMs >= opts.tapAtMs &&
        !store.getGoMode().riding
      ) {
        // The trip sheet's own button, which names whatever vehicle the
        // matcher holds — exactly what the rider pressed at 09:22:08.
        const { confirmVehicleSelection } =
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          require('../../../lib/actions/go-mode')
        store.dispatch(confirmVehicleSelection(opts.tapVehicleId as string))
      }
      store.dispatch(handlePositionUpdate(positionOf(fix)))
    }
    const confirms = store.actions.filter((a) => a.type === 'CONFIRM_VEHICLE')
    const setRiding = store.actions.filter((a) => a.type === 'SET_RIDING')
    const reroutes = store.actions.filter((a) => a.type === 'START_REROUTE')
    return {
      actions: store.actions,
      confirms,
      reroutes,
      riding: store.getGoMode().riding,
      setRiding
    }
  } finally {
    store.dispatch(endGoMode())
    clock.uninstall()
  }
}

// ─── the four gates, as pure functions ──────────────────────────────────────

describe('util > go-mode > the access-board gates (23.6)', () => {
  /** A tick on which all four hold: the 09-21 signature. */
  const good: AccessBoardSample = {
    boardLeg: {
      from: { stopId: '1:53311' },
      intermediateStops: [{ stopId: '1:52719' }, { stopId: '1:56832' }],
      route: { gtfsId: '1:904' },
      to: { stopId: '1:56832' },
      transitLeg: true
    } as any,
    boardLegIndex: 1,
    fixAccuracyM: 4.7,
    legIndex: 0,
    nowMs: 1790000400000,
    riderSpeedMps: 20.6,
    routeMatch: { distanceFromRoute: 3.4, isOnRoute: true },
    vehicleMatch: {
      consecutiveMatches: 12,
      match: {
        confidence: 'high',
        nextStopId: '1:52719',
        routeId: '1:904',
        tripId: '1:1268952',
        vehicleId: '1:8228'
      } as any
    }
  }

  it('passes every gate on the shape the rider actually produced', () => {
    expect(accessBoardGates(good)).toEqual({
      fixSound: true,
      onCorridor: true,
      transitPace: true,
      vehicleEvidence: true
    })
  })

  it('refuses a bicycle pace, however good everything else is', () => {
    // The 2026-09-01 ride-2 board: 8.01 m/s, and every other gate irrelevant.
    expect(accessBoardGates({ ...good, riderSpeedMps: 8.01 }).transitPace).toBe(
      false
    )
    expect(
      accessBoardGates({
        ...good,
        riderSpeedMps: ACCESS_BOARD_MIN_SPEED_MPS - 0.01
      }).transitPace
    ).toBe(false)
    expect(accessBoardGates({ ...good, riderSpeedMps: null }).transitPace).toBe(
      false
    )
  })

  it('refuses the matcher-usable corridor: 100 m, not 250', () => {
    // 2026-08-27: 248 m from a parallel bus route, isOnRoute true the whole
    // time, and that was enough to be declared aboard.
    expect(
      accessBoardGates({
        ...good,
        routeMatch: { distanceFromRoute: 248, isOnRoute: true }
      }).onCorridor
    ).toBe(false)
    expect(
      accessBoardGates({
        ...good,
        routeMatch: {
          distanceFromRoute: RIDING_ESTABLISH_MAX_DISTANCE_M,
          isOnRoute: true
        }
      }).onCorridor
    ).toBe(true)
    expect(
      accessBoardGates({
        ...good,
        routeMatch: { distanceFromRoute: 3, isOnRoute: false }
      }).onCorridor
    ).toBe(false)
    // "Cannot say" is a refusal, not a pass.
    expect(accessBoardGates({ ...good, routeMatch: null }).onCorridor).toBe(
      false
    )
  })

  it('refuses a vehicle that has not reached the rider, or is not theirs', () => {
    // 2026-09-01 ride 1: one poll, medium, nextStopId = the rider's own stop.
    expect(
      accessBoardGates({ ...good, vehicleMatch: { consecutiveMatches: 1 } })
        .vehicleEvidence
    ).toBe(false)
    expect(
      accessBoardGates({
        ...good,
        vehicleMatch: {
          consecutiveMatches: BOARD_AUTO_CONFIRM_MIN_CONSECUTIVE - 1,
          match: good.vehicleMatch?.match
        }
      }).vehicleEvidence
    ).toBe(false)
    expect(
      accessBoardGates({
        ...good,
        vehicleMatch: {
          consecutiveMatches: 12,
          match: { ...(good.vehicleMatch?.match as any), confidence: 'medium' }
        }
      }).vehicleEvidence
    ).toBe(false)
    // Its own next stop is still the leg's boarding stop: it has not arrived.
    expect(
      accessBoardGates({
        ...good,
        vehicleMatch: {
          consecutiveMatches: 12,
          match: { ...(good.vehicleMatch?.match as any), nextStopId: '1:53311' }
        }
      }).vehicleEvidence
    ).toBe(false)
    // 2026-07-29: the opposite-direction run, going to a stop this leg never
    // calls at.
    expect(
      accessBoardGates({
        ...good,
        vehicleMatch: {
          consecutiveMatches: 12,
          match: { ...(good.vehicleMatch?.match as any), nextStopId: '1:53542' }
        }
      }).vehicleEvidence
    ).toBe(false)
    // A different route entirely.
    expect(
      accessBoardGates({
        ...good,
        vehicleMatch: {
          consecutiveMatches: 12,
          match: { ...(good.vehicleMatch?.match as any), routeId: '1:921' }
        }
      }).vehicleEvidence
    ).toBe(false)
    expect(
      accessBoardGates({ ...good, vehicleMatch: null }).vehicleEvidence
    ).toBe(false)
  })

  it('refuses a fix too coarse to place the rider (the 8/31 1,254 m board)', () => {
    expect(accessBoardGates({ ...good, fixAccuracyM: 1254.74 }).fixSound).toBe(
      false
    )
    expect(
      accessBoardGates({
        ...good,
        fixAccuracyM: RIDING_ESTABLISH_MAX_ACCURACY_M
      }).fixSound
    ).toBe(true)
    // A device that publishes no accuracy is not evidence of a bad fix.
    expect(accessBoardGates({ ...good, fixAccuracyM: null }).fixSound).toBe(
      true
    )
  })

  it('needs BOTH the tick count and the elapsed span', () => {
    let w = null as any
    // 1 Hz: five ticks arrive in four seconds, which is not twenty.
    for (let i = 0; i < ACCESS_BOARD_MIN_TICKS; i++) {
      w = trackAccessBoard(w, { ...good, nowMs: good.nowMs + i * 1000 })
    }
    expect(w.ticks).toBe(ACCESS_BOARD_MIN_TICKS)
    expect(accessBoardEstablished(w)).toBe(false)
    // Two ticks twenty seconds apart is twenty seconds and two ticks.
    let s = trackAccessBoard(null, good)
    s = trackAccessBoard(s, { ...good, nowMs: good.nowMs + 20000 })
    expect(accessBoardEstablished(s)).toBe(false)
    // The real shape: 1 Hz for twenty seconds.
    let r = null as any
    for (let i = 0; i <= 20; i++) {
      r = trackAccessBoard(r, { ...good, nowMs: good.nowMs + i * 1000 })
    }
    expect(r.heldMs).toBe(ACCESS_BOARD_MIN_MS)
    expect(r.ticks).toBe(21)
    expect(accessBoardEstablished(r)).toBe(true)
  })

  it('caps what one tick may add, so a backgrounded gap buys nothing', () => {
    let w = trackAccessBoard(null, good)
    w = trackAccessBoard(w, { ...good, nowMs: good.nowMs + 240000 })
    expect(w?.heldMs).toBe(10000)
    expect(accessBoardEstablished(w)).toBe(false)
  })

  it('restarts on a different bus, a different leg, or one failed gate', () => {
    let w = null as any
    for (let i = 0; i <= 20; i++) {
      w = trackAccessBoard(w, { ...good, nowMs: good.nowMs + i * 1000 })
    }
    expect(accessBoardEstablished(w)).toBe(true)
    // A flap onto another vehicle is a new claim, not a continuation.
    const flapped = trackAccessBoard(w, {
      ...good,
      nowMs: good.nowMs + 21000,
      vehicleMatch: {
        consecutiveMatches: 12,
        match: { ...(good.vehicleMatch?.match as any), vehicleId: '1:8229' }
      }
    })
    expect(flapped?.ticks).toBe(1)
    expect(accessBoardEstablished(flapped)).toBe(false)
    // So is walking on to a different boarding.
    expect(
      trackAccessBoard(w, { ...good, boardLegIndex: 3, nowMs: good.nowMs + 1 })
        ?.ticks
    ).toBe(1)
    expect(
      trackAccessBoard(w, { ...good, legIndex: 2, nowMs: good.nowMs + 1 })
        ?.ticks
    ).toBe(1)
    // And one bad tick throws the whole run away — there is no such thing as
    // a partially-observed boarding.
    expect(
      trackAccessBoard(w, {
        ...good,
        nowMs: good.nowMs + 21000,
        riderSpeedMps: 6
      })
    ).toBeNull()
  })
})

// ─── the ride the rider asked about ─────────────────────────────────────────

/**
 * 2026-09-21 ride 1, session `mubbbiy9-6zjoq9`. The plan had them cycling to
 * I-35W & Lake St for a 10:12 Orange Line (trip `1:1348464`). The bus that
 * came was the 09:15 run — `1:1268952`, vehicle 8228 — and they got on it.
 */
describe('util > go-mode > the 09-21 boarding, noticed without the tap', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fx: any = require('../../../lib/util/go-mode/replay/fixtures/0921-0902-orange-lake-st.json')
  const ROUTE_ID = '1:904'
  const RIDDEN_TRIP = '1:1268952'
  const VEHICLE_ID = '1:8228'
  /** The rider's own tap. */
  const TAP_MS = 1790000530536
  /** The window the row names: from before the rider started moving. */
  const FROM_MS = 1790000370000 // 09:19:30
  const TO_MS = 1790000625000 // 09:23:45, the last recorded fix

  beforeEach(() => mockedFindTrip.mockClear())
  afterEach(() => mockedFindTrip.mockClear())

  it('boards the rider between 09:20:05 and 09:22:08, before they tap', () => {
    const r = replay(fx, FROM_MS, TO_MS, [ROUTE_ID])
    expect(r.confirms).toHaveLength(1)
    const at =
      r.confirms[0].payload.lastSeen ?? r.setRiding[0].payload.boardedAt
    expect(hhmmss(at)).toBe('09:20:38')
    expect(at).toBeGreaterThanOrEqual(1790000405000) // 09:20:05
    expect(at).toBeLessThan(TAP_MS - 60000)
    expect(r.confirms[0].payload.vehicleId).toBe(VEHICLE_ID)
    expect(r.confirms[0].payload.tripId).toBe(RIDDEN_TRIP)
  })

  it('and the riding fact it writes is the one the tap wrote', () => {
    const r = replay(fx, FROM_MS, TO_MS, [ROUTE_ID])
    const first = r.setRiding[0].payload
    // `confirmVehicleSelection` stamps the matcher's leg, which is the BIKE
    // leg — exactly as the rider's own tap did on the day (23.2b). The trip is
    // what says which leg it is about (`ridingTransitLegIndex`).
    expect(first.legIndex).toBe(0)
    expect(first.tripId).toBe(RIDDEN_TRIP)
    expect(first.vehicleId).toBe(VEHICLE_ID)
    expect(first.routeId).toBe(ROUTE_ID)
    expect(r.riding?.tripId).toBe(RIDDEN_TRIP)
    expect(r.riding?.vehicleId).toBe(VEHICLE_ID)
    // …and it survives to the end of the recording: on the day the fact was
    // dropped 91 s after the tap (CLEAR_RIDING 09:23:42).
    expect(r.actions.filter((a) => a.type === 'CLEAR_RIDING')).toHaveLength(0)
  })

  it('re-targets the plan the way the tap does — same trip, same route', () => {
    const auto = replay(fx, FROM_MS, TO_MS, [ROUTE_ID])
    mockedFindTrip.mockClear()
    const autoFetched = auto.reroutes.length
      ? (findTrip as jest.Mock).mock.calls.map((c: any[]) => c[0]?.tripId)
      : []
    expect(auto.reroutes.length).toBeGreaterThan(0)
    expect(
      auto.reroutes.every((a) => a.payload.reason === 'boarded-earlier')
    ).toBe(true)
    expect(auto.reroutes[0].payload.autoApply).toBe(true)
    expect(auto.reroutes[0].payload.keepRouteId).toBe(ROUTE_ID)
    expect(hhmmss(auto.reroutes[0].payload.startedAtMs)).toBe('09:20:38')
    expect(autoFetched).toBeDefined()

    // The control: the same window with the rider's "Not on the bus" standing,
    // so the automatic path is held off and the trip sheet's own button is
    // what boards them — i.e. the 23.2 behaviour, unchanged.
    mockedFindTrip.mockClear()
    const tapped = replay(fx, FROM_MS, TO_MS, [ROUTE_ID], {
      deny: true,
      tapAtMs: TAP_MS,
      tapVehicleId: VEHICLE_ID
    })
    expect(tapped.reroutes.length).toBeGreaterThan(0)
    expect(hhmmss(tapped.reroutes[0].payload.startedAtMs)).toBe('09:22:10')

    // Same target, reached 92 s earlier and without being asked.
    expect(auto.reroutes[0].payload.reason).toBe(
      tapped.reroutes[0].payload.reason
    )
    expect(auto.reroutes[0].payload.keepRouteId).toBe(
      tapped.reroutes[0].payload.keepRouteId
    )
    expect(auto.riding?.tripId).toBe(tapped.riding?.tripId)
    expect(auto.riding?.vehicleId).toBe(tapped.riding?.vehicleId)
    expect(auto.riding?.routeId).toBe(tapped.riding?.routeId)
    // …and it splices from the trip the rider is ON, which is the alighting
    // stop the tap produced: `replanFromAboard` resolves both from this id.
    const fetched = (findTrip as jest.Mock).mock.calls.map(
      (c: any[]) => c[0]?.tripId
    )
    expect(fetched).toContain(RIDDEN_TRIP)
  })

  it('a standing "Not on the bus" outranks the app noticing', () => {
    // Three minutes of hold (BOARDING_DENIAL_HOLD_MS) — the whole window.
    const r = replay(fx, FROM_MS, TAP_MS - 1000, [ROUTE_ID], { deny: true })
    expect(r.confirms).toHaveLength(0)
    expect(r.setRiding).toHaveLength(0)
    expect(r.riding).toBeNull()
  })
})

// ─── the false boards it must not repeat ────────────────────────────────────

/**
 * Each of these is a window in which the rider was NOT on a bus and the app of
 * the day said they were. The assertion is silence; the measurement reported
 * beside it is the closest the four gates came to firing, so a later session
 * can see the margin rather than take it on trust.
 */
describe('util > go-mode > the false boards it stays silent on (23.6)', () => {
  it('2026-09-01 ride 2: a cyclist at 8 m/s, 4.3 km from the stop', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fx: any = require('../../../lib/util/go-mode/replay/fixtures/bike-false-board-1029.json')
    // The whole of ride 2's access leg: from the 10:33:29 re-plan (the
    // itinerary in force) to the last recorded fix, 10:48:47. SET_RIDING
    // landed at 10:47:15 on the day.
    const r = replay(fx, 1788276809000, 1788277727635, ['1:904'])
    expect(r.confirms).toHaveLength(0)
    expect(r.setRiding).toHaveLength(0)
    expect(r.riding).toBeNull()
    expect(
      r.reroutes.filter((a) => a.payload.reason === 'boarded-earlier')
    ).toHaveLength(0)
  })

  it('2026-09-01 ride 3: the fact it began the trip already holding', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fx: any = require('../../../lib/util/go-mode/replay/fixtures/ride-1048-orange-bike.json')
    // 10:48:50 (trip start, where START_GO_MODE's reanchorRiding resumed ride
    // 2's fabricated fact) to 10:50:55, the moment the ride's own record first
    // named a real bus. The rider stands still at 0.1-0.2 m/s the whole way,
    // 4.4 km from the stop the stale plan still names.
    const r = replay(fx, 1788277730360, 1788277855088, ['1:904'])
    expect(r.confirms).toHaveLength(0)

    // MEASURED, and NOT this path's doing: there IS one SET_RIDING here, at
    // 10:49:55, naming 1:8216 / 1:1272543 on legIndex 1. The matcher put the
    // rider on the TRANSIT leg from the first tick of this ride
    // (TRANSITION_LEG at 10:48:51, distanceFromRoute 0 — they are standing on
    // the Orange Line's own shape, at a station the stale plan does not name),
    // so this is `decideRiding`'s ordinary transit-leg establishment on a
    // high-confidence match, and the access-leg path is never consulted at
    // all. Re-measured with ACCESS_BOARD_MIN_SPEED_MPS raised to 1e9 — i.e.
    // with 23.6 switched off — the same action lands at the same millisecond.
    expect(r.setRiding).toHaveLength(1)
    expect(hhmmss(r.setRiding[0].payload.boardedAt)).toBe('10:49:55')
    expect(r.setRiding[0].payload.legIndex).toBe(1)
  })

  it('2026-08-28: the four minutes the rider stood on the platform', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fx: any = require('../../../lib/util/go-mode/replay/fixtures/orange-early-board-0828.json')
    // 16:41:00 to 16:44:20: 0.0-1.5 m/s, 24-81 m from I-35W & 98th St Station,
    // projecting 1-14 m from the Orange Line's own shape the whole time (the
    // platform is on the busway) with the route's vehicles in the feed. Every
    // gate but one is satisfied for those four minutes; the rider is not
    // moving, so nothing fires.
    const r = replay(fx, 1787953260021, 1787953460000, ['1:904'])
    expect(r.confirms).toHaveLength(0)
    expect(r.setRiding).toHaveLength(0)
    expect(r.riding).toBeNull()
  })

  it('…and leaves the 16:44:20 boarding to the leg transition', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fx: any = require('../../../lib/util/go-mode/replay/fixtures/orange-early-board-0828.json')
    // The bus ran 284 s ahead of the plan and the rider was aboard from
    // ~16:44:20 — so this is a real boarding, not a false one. It is also the
    // ORDINARY case, and the ordinary machinery handles it: the rider is on
    // the leg the plan gave them, so `shouldTransitionToNextLeg` fires
    // (TRANSITION_LEG legIndex 1 at 16:44:44) and `decideRiding` establishes
    // on the transit leg two ticks later. The access-leg run never completes
    // — it opens at 16:44:11 (12.7 m/s, 77 m off the shape, 8224 at
    // consecutiveMatches 3) and resets at 16:44:21 when the projection goes
    // to 245 m as the bus accelerates off the platform.
    //
    // 23.6 is for the boarding the transition CANNOT see: a bus the plan does
    // not have the rider on, kilometres from the stop it names. That is 09-21.
    const r = replay(fx, 1787953260021, 1787953620000, ['1:904'])
    expect(r.confirms).toHaveLength(0)
    expect(r.setRiding.length).toBeGreaterThan(0)
    expect(hhmmss(r.setRiding[0].payload.boardedAt)).toBe('16:44:44')
    expect(r.setRiding[0].payload.legIndex).toBe(1)
    expect(r.setRiding[0].payload.vehicleId).toBe('1:8224')
    // With 23.6 switched off the same establishment lands at 16:44:46: the
    // access-leg poll this branch added had the matcher already tracking 8224
    // when the leg turned over, instead of starting from `consecutiveMatches`
    // 0. Two seconds earlier, same bus, same trip, same leg.
  })
})
