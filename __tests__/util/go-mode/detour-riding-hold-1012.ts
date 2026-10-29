/* globals describe, expect, it, jest */
import '../../test-utils/mock-window-url'

import fs from 'fs'
import path from 'path'

import { applyMiddleware, combineReducers, createStore } from 'redux'
import FakeTimers from '@sinonjs/fake-timers'
import thunk from 'redux-thunk'

import * as vehicleCompany from '../../../lib/util/go-mode/vehicle-company'
import {
  checkRouteDeviation,
  nextDeviationHandledAtMs
} from '../../../lib/util/go-mode/notification-service'
import {
  COMPANY_APART_FRAMES,
  COMPANY_APART_M,
  COMPANY_HIGH_SUSTAIN_FRAMES,
  COMPANY_SILENCE_CAP_MS,
  COMPANY_TOGETHER_M,
  pushRiderFix,
  riderPositionAt,
  ridingHeldByVehicle,
  trackRidingCompany,
  trackVehicleCompany
} from '../../../lib/util/go-mode/vehicle-company'
import {
  confirmVehicleSelection,
  replayTrip,
  stopReplay
} from '../../../lib/actions/go-mode'
import { decideRiding } from '../../../lib/util/go-mode/riding'
import { determineTripStatus } from '../../../lib/util/go-mode/progress-calculator'
import { matchUserToVehicle } from '../../../lib/util/go-mode/vehicle-matching'
import {
  refreshConfirmedMatch,
  RIDING_REBIND_MIN_FRAMES
} from '../../../lib/util/go-mode/transit-trust'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'
import type { RidingState } from '../../../lib/util/go-mode/types'
import type { VehicleMatchResult } from '../../../lib/util/go-mode/vehicle-matching'

/**
 * jest maps `*.graphql` to an empty string, so core-utils' `generateOtp2Query`
 * cannot `print()` its default document — same stub as
 * boarded-earlier-once-0729.ts, since this replay runs the real tick.
 */
jest.mock('@opentripplanner/core-utils', () => {
  const actual = jest.requireActual('@opentripplanner/core-utils')
  const { parse } = jest.requireActual('graphql')
  const stub = parse('query Plan { plan { itineraries { duration } } }')
  const core = actual.default || actual
  const patched = {
    ...core,
    queryGen: {
      ...core.queryGen,
      generateOtp2Query: (params: unknown) =>
        core.queryGen.generateOtp2Query(params, stub)
    }
  }
  return { ...actual, __esModule: true, default: patched }
})

/**
 * BACKLOG 47.1 — a bus on a road detour, with the rider in it.
 *
 * 2026-10-12 16:17, session `mv5q7id5-who0wz`, DEV `2026.1012.2`. The rider
 * tapped "I'm on the bus" for Orange Line 8143 (trip 1:1364433) at 16:17:26 and
 * rode it to Lake St. 16:22:58-16:32:02 the bus detoured ~750 m east of the
 * leg's shape. On the phone: a high-priority "Off route — 261m" card at
 * 16:23:01, `CLEAR_RIDING` 16:24:31 (the 90 s off-route clock), status
 * `deviated` to ~16:32, and riding re-established at 16:31:43 with its board
 * time re-stamped.
 *
 * Replayed through the real store and tick from
 * lib/util/go-mode/replay/fixtures/who0wz-1617-detour.json, with the rider's
 * tap dispatched at its recorded moment. The replay reproduces the ride on
 * main (`913b86589`): ROUTE_DEVIATION high 16:23:02, CLEAR_RIDING 16:24:31,
 * `deviated` 16:23:01-16:31:43, SET_RIDING 16:31:43 with boardedAt 16:31:44.
 * Since 75.29 every fix plays at its own recorded time (each used to carry
 * the gap after it), and the same replay reads: ROUTE_DEVIATION 16:23:01 and
 * `deviated` from 16:23:00, as the phone; CLEAR_RIDING 16:24:30 and riding
 * back at 16:31:42, one fix before the phone's 16:24:31 / 16:31:43 — the
 * phone ran those thresholds on its handling clock (the 90 s off-route clock
 * from 16:23:00.085, tens of ms after the fix), which a replay of the fixes
 * alone cannot carry.
 * (The replay's own riding fact is established by the matcher before the
 * tap, so its board time is 16:17:15 — the tap keeps an evidenced board
 * time, as on the phone. It read 16:17:17 until 54.6 aged the replay's frames
 * against the sim clock, which lets the matcher age-correct them as it does
 * on a live ride.)
 *
 * 2026-10-29 (R14 of the isolated stress-test session): replayed WITHOUT the
 * tap, the match is `high` from 16:17:15 and never `confirmed` — which is
 * every ordinary boarding — and on main `3a7050816` the hold never engaged:
 * "Off route" high 16:23:02, CLEAR_RIDING 16:24:31, then "Missed bus · next
 * departure", an autoApply missed-bus re-plan and "Leave in 1 min" at
 * 16:24:49-50, all to the rider on the detouring bus. `tap: false` below.
 */
const FIXTURE = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/who0wz-1617-detour.json'
)
const fixture: any = fs.existsSync(FIXTURE)
  ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  : null

const CONFIG = {
  api: { host: 'http://mock-host.com', path: '/api', port: 80 },
  homeTimezone: 'America/Chicago',
  itinerary: {},
  modes: {
    initialState: { enabledModeButtons: ['transit', 'bicycle'] },
    modeButtons: [
      { key: 'transit', modes: [{ mode: 'TRANSIT' }] },
      { key: 'bicycle', modes: [{ mode: 'BICYCLE' }] }
    ],
    transitModes: []
  },
  persistence: { enabled: false }
}

/** `CONFIRM_VEHICLE` 1:8143 — the rider's tap on the boarding prompt. */
const RIDER_TAP_MS = 1_791_839_846_309
const VEHICLE = '1:8143'
const TRIP = '1:1364433'

const hhmmss = (ms: number | null | undefined) =>
  ms == null
    ? 'n/a'
    : new Date(ms).toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: 'America/Chicago'
      })

/** 2026-10-12 HH:MM:SS CDT as epoch ms. */
const at = (hms: string) => Date.parse(`2026-10-12T${hms}-05:00`)

interface Recorded {
  p: any
  t: number
  type: string
}

async function replay(fx: any, { tap = true }: { tap?: boolean } = {}) {
  const globalScope: any = global
  globalScope.fetch = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({}), ok: true, status: 200 })
  )
  const clock = FakeTimers.install({ now: 1791839800000 })
  const events: Recorded[] = []
  const statuses: Array<{ s: string; t: number }> = []
  let lastSim = 0
  const keep = new Set([
    'ADD_NOTIFICATION',
    'CLEAR_RIDING',
    'CONFIRM_VEHICLE',
    'RIDING_VEHICLE_HOLD',
    'SET_RIDING',
    'START_REROUTE',
    'TRANSITION_LEG'
  ])
  const recorder = () => (next: any) => (action: any) => {
    if (action && typeof action === 'object' && keep.has(action.type)) {
      events.push({ p: action.payload, t: lastSim, type: action.type })
    }
    return next(action)
  }
  const store = createStore(
    combineReducers({ otp: createOtpReducer(CONFIG as any) }),
    applyMiddleware(thunk, recorder)
  )
  let tapped = !tap
  store.subscribe(() => {
    const g = store.getState().otp.goMode
    if (!g || g.simulation?.status !== 'running') return
    if (g.progress?.currentTime) {
      const t = new Date(g.progress.currentTime).getTime()
      if (t !== lastSim) {
        lastSim = t
        statuses.push({ s: g.progress.status, t })
      }
    }
    if (!tapped && lastSim >= RIDER_TAP_MS) {
      tapped = true
      store.dispatch(confirmVehicleSelection(VEHICLE) as any)
    }
  })
  await store.dispatch(replayTrip(fx, { speedMultiplier: 4 }) as any)
  for (let i = 0; i < 10000; i++) {
    await clock.tickAsync(1000)
    if (store.getState().otp.goMode.simulation.status !== 'running') break
  }
  store.dispatch(stopReplay() as any)
  clock.uninstall()

  const of = (type: string) => events.filter((e) => e.type === type)
  const deviated = statuses.filter((s) => s.s === 'deviated').map((s) => s.t)
  return {
    clears: of('CLEAR_RIDING').map((e) => e.t),
    confirms: of('CONFIRM_VEHICLE').map((e) => e.t),
    deviated,
    holds: of('RIDING_VEHICLE_HOLD'),
    notifications: of('ADD_NOTIFICATION').map((e) => ({
      priority: e.p?.priority,
      t: e.t,
      type: e.p?.type
    })),
    offRoute: of('ADD_NOTIFICATION')
      .filter((e) => e.p?.type === 'ROUTE_DEVIATION')
      .map((e) => ({ priority: e.p.priority, t: e.t })),
    reroutes: of('START_REROUTE').map((e) => ({
      reason: e.p?.reason,
      t: e.t
    })),
    sets: of('SET_RIDING'),
    transitions: of('TRANSITION_LEG')
  }
}

const clone = (x: any) => JSON.parse(JSON.stringify(x))

jest.setTimeout(600000)
;(fixture ? describe : describe.skip)(
  'the 2026-10-12 detour, replayed (47.1)',
  () => {
    it('without the hold reproduces the ride (and keeps the board time)', async () => {
      // Today's riding decision exactly: nothing ever reads as held. Item (7)
      // is independent of the hold, so the re-established fact keeps 16:17:15
      // here where main re-stamped it 16:31:44.
      const spy = jest
        .spyOn(vehicleCompany, 'ridingHeldByVehicle')
        .mockReturnValue(false)
      const r = await replay(fixture)
      spy.mockRestore()
      expect(r.offRoute.map((n) => [hhmmss(n.t), n.priority])).toEqual([
        ['16:23:01', 'high']
      ])
      expect(r.clears.map(hhmmss)).toEqual(['16:24:30'])
      expect(hhmmss(r.deviated[0])).toBe('16:23:00')
      const back = r.sets.find((e) => e.t > at('16:24:31'))
      expect(hhmmss(back?.t)).toBe('16:31:42')
      expect(back?.p.vehicleId).toBe(VEHICLE)
      expect(hhmmss(back?.p.boardedAt)).toBe('16:17:15')
      expect(r.holds).toEqual([])
    })

    it('holds the rider on 8143 through the detour', async () => {
      const r = await replay(fixture)
      // No clear, from boarding to the BICYCLE transition at Lake St.
      expect(r.clears).toEqual([])
      const bike = r.transitions.find((e) => e.p?.legIndex === 2)
      expect(hhmmss(bike?.t)).toBe('16:45:33')
      // Every riding fact the trip wrote is 8143, boarded at 16:17:15.
      for (const s of r.sets) {
        expect(s.p.vehicleId).toBe(VEHICLE)
        expect(s.p.tripId).toBe(TRIP)
        expect(hhmmss(s.p.boardedAt)).toBe('16:17:15')
      }
      // The hold engages as the bus leaves the shape and lets go as it
      // rejoins, with the bus a few metres from the rider both times.
      expect(r.holds.map((h) => [hhmmss(h.t), h.p.on, h.p.verdict])).toEqual([
        ['16:22:59', true, 'together'],
        ['16:31:42', false, 'together']
      ])
      expect(r.holds[0].p.vehicleDistanceM).toBeLessThanOrEqual(30)
      // Not deviated anywhere on the detour (it was 16:23:00-16:31:42).
      expect(
        r.deviated.filter((t) => t >= at('16:22:00') && t <= at('16:45:00'))
      ).toEqual([])
      // The rider's answer (Q1 "C"): the card still goes out, once for the
      // whole excursion, at medium priority.
      expect(r.offRoute.map((n) => [hhmmss(n.t), n.priority])).toEqual([
        ['16:23:01', 'medium']
      ])
    })

    it('holds a rider the matcher only ever called `high` (R14, 2026-10-29)', async () => {
      // No tap: the ordinary boarding — nothing confirms 8143 at any point.
      const r = await replay(fixture, { tap: false })
      // Main 3a7050816: CLEAR_RIDING 16:24:31, then at 16:24:49-50 MISSED_BUS,
      // a missed-bus autoApply re-plan, TRIP_UPDATED and LEAVE_SOON.
      expect(r.clears.map(hhmmss)).toEqual([])
      expect(r.reroutes.map((e) => [hhmmss(e.t), e.reason])).toEqual([])
      const pushed = r.notifications
        .filter((n) =>
          ['LEAVE_SOON', 'MISSED_BUS', 'TRIP_UPDATED'].includes(n.type)
        )
        .map((n) => [hhmmss(n.t), n.type])
      expect(pushed).toEqual([])
      expect(r.confirms).toEqual([])
      // One riding fact, 8143, from 16:17:15 to the BICYCLE transition. Every
      // time below is one fix earlier than 47.1 measured it on its own tree
      // (16:17:16, 16:45:34, 16:23:00/16:31:43, 16:23:02): since 75.29 each
      // fix plays at its own recorded time, the same shift the tapped cases
      // above took.
      for (const s of r.sets) {
        expect(s.p.vehicleId).toBe(VEHICLE)
        expect(s.p.tripId).toBe(TRIP)
        expect(hhmmss(s.p.boardedAt)).toBe('16:17:15')
      }
      const bike = r.transitions.find((e) => e.p?.legIndex === 2)
      expect(hhmmss(bike?.t)).toBe('16:45:33')
      // The hold engages and lets go exactly as for the confirmed rider, on a
      // `high` match resting on well over the sustain.
      expect(
        r.holds.map((h) => [
          hhmmss(h.t),
          h.p.on,
          h.p.verdict,
          h.p.matchConfidence
        ])
      ).toEqual([
        ['16:22:59', true, 'together', 'high'],
        ['16:31:42', false, 'together', 'high']
      ])
      expect(r.holds[0].p.vehicleDistanceM).toBeLessThanOrEqual(30)
      expect(r.holds[0].p.togetherFrames).toBeGreaterThanOrEqual(
        COMPANY_HIGH_SUSTAIN_FRAMES
      )
      expect(
        r.deviated.filter((t) => t >= at('16:22:00') && t <= at('16:45:00'))
      ).toEqual([])
      expect(r.offRoute.map((n) => [hhmmss(n.t), n.priority])).toEqual([
        ['16:23:01', 'medium']
      ])
    })

    // Both release paths hold for a `high` rider exactly as for a confirmed
    // one (R14): the riding bus's own frames still break company, and its
    // silence still ages the hold out.
    const vouches: Array<[string, boolean]> = [
      ['confirmed (tapped)', true],
      ['high (never confirmed)', false]
    ]

    it.each(vouches)(
      'lets go when the rider walks off the bus off the shape — %s',
      async (_label, tap) => {
        // The rider steps off at 16:24:00 mid-detour and stays put; the bus
        // goes on. The recording after that moment is the bus's alone. 8143
        // crawled here: its frames against the standing rider read 2 m
        // (16:24:16), 79, 87, 122 (grey), then 154 m (16:26:05, polled 16:26:40)
        // and 203 m (16:26:12, polled 16:26:56) — the two apart frames.
        const fx = clone(fixture)
        const off = at('16:24:00')
        const stand = fx.gpsTrack.reduce((best: any, g: any) =>
          Math.abs(g.tMs - off) < Math.abs(best.tMs - off) ? g : best
        )
        fx.gpsTrack = fx.gpsTrack.map((g: any) =>
          g.tMs > off
            ? { ...g, heading: null, lat: stand.lat, lon: stand.lon, speed: 0 }
            : g
        )
        const r = await replay(fx, { tap })
        const released = r.holds.find((h) => h.p.on === false)
        expect(released?.p.verdict).toBe('apart')
        expect(released?.p.vehicleDistanceM).toBeGreaterThan(COMPANY_APART_M)
        // Within a poll of the second apart frame reaching the feed (the
        // replay's own poll cadence reads it at 16:26:58).
        expect(hhmmss(released?.p.tMs)).toBe('16:26:58')
        // ...and the 90 s clock then clears the fact as it always did.
        expect(r.clears).toHaveLength(1)
        expect(r.clears[0] - released!.p.tMs).toBeGreaterThanOrEqual(89000)
        expect(r.clears[0] - released!.p.tMs).toBeLessThan(95000)
      }
    )

    it.each(vouches)(
      'resumes the clock when the bus goes silent past the cap — %s',
      async (_label, tap) => {
        // 8143 vanishes from every snapshot from 16:19:30 on. Its last frame
        // (16:18:42) is older than COMPANY_SILENCE_CAP_MS at 16:28:43, still on
        // the detour: the hold lets go then and the clock clears at 16:30:12.
        const fx = clone(fixture)
        const cutoff = at('16:19:30')
        for (const s of fx.vehicleSnapshots) {
          if (s.tMs < cutoff) continue
          s.payload.vehicles = (s.payload.vehicles || []).filter(
            (v: any) => v.vehicleId !== VEHICLE
          )
        }
        const r = await replay(fx, { tap })
        const released = r.holds.find((h) => h.p.on === false)
        expect(released).toBeDefined()
        expect(released!.p.verdict).toBe('together')
        expect(released!.p.tMs - released!.p.togetherAtMs).toBeGreaterThan(
          COMPANY_SILENCE_CAP_MS
        )
        expect(released!.p.tMs).toBeLessThan(at('16:31:43'))
        expect(r.clears).toHaveLength(1)
        expect(r.clears[0] - released!.p.tMs).toBeGreaterThanOrEqual(89000)
        expect(r.clears[0] - released!.p.tMs).toBeLessThan(95000)
        expect(hhmmss(released!.p.tMs)).toBe('16:28:43')
        expect(hhmmss(r.clears[0])).toBe('16:30:12')
      }
    )
  }
)

describe('util > go-mode > vehicle-company', () => {
  const T0 = 1_791_840_000_000
  // Due north, ~1.11 m per 1e-5 degree of latitude.
  const fix = (s: number, northM: number) => ({
    lat: 44.85 + northM / 111_195,
    lon: -93.28,
    tMs: T0 + s * 1000
  })
  const ringOf = (fixes: Array<ReturnType<typeof fix>>) =>
    fixes.reduce((r: any, f) => pushRiderFix(r, f), [])
  const frame = (s: number, northM: number) => ({
    frameLat: 44.85 + northM / 111_195,
    frameLon: -93.28,
    frameSeconds: (T0 + s * 1000) / 1000,
    vehicleId: VEHICLE
  })

  it('keeps only the last 120 s of fixes, in order', () => {
    let ring = ringOf([fix(0, 0), fix(60, 0), fix(121, 0)])
    expect(ring.map((f: any) => (f.tMs - T0) / 1000)).toEqual([60, 121])
    ring = pushRiderFix(ring, fix(100, 0))
    expect(ring).toHaveLength(2)
  })

  it('interpolates the rider at a frame time, and refuses a gap', () => {
    const ring = ringOf([fix(0, 0), fix(10, 100), fix(60, 100)])
    const p = riderPositionAt(ring, T0 + 5000) as any
    expect((p.lat - 44.85) * 111_195).toBeCloseTo(50, 0)
    // 10 s -> 60 s is wider than 30 s: no honest position in between.
    expect(riderPositionAt(ring, T0 + 30000)).toBeNull()
    expect(riderPositionAt(ring, T0 - 60000)).toBeNull()
  })

  it('reads a frame against the rider THEN, not now', () => {
    // Rider and bus both moving north at 15 m/s; the frame is 40 s old. Now
    // the rider is 600 m past it — at the frame's moment they were together.
    const ring = ringOf(Array.from({ length: 41 }, (_, i) => fix(i, i * 15)))
    const c = trackVehicleCompany(null, frame(0, 10), ring)
    expect(c?.verdict).toBe('together')
    expect(c?.lastDistanceM).toBeLessThan(COMPANY_TOGETHER_M)
  })

  it('needs two apart frames to break, and a grey frame proves nothing', () => {
    const ring = ringOf(Array.from({ length: 100 }, (_, i) => fix(i, 0)))
    let c = trackVehicleCompany(null, frame(0, 5), ring)
    expect(c?.verdict).toBe('together')
    c = trackVehicleCompany(c, frame(20, 400), ring)
    expect(c?.verdict).toBe('together')
    expect(c?.apartFrames).toBe(1)
    // The same frame again (the matcher ticks every second) changes nothing.
    expect(trackVehicleCompany(c, frame(20, 400), ring)).toBe(c)
    c = trackVehicleCompany(c, frame(40, 100), ring)
    expect(c?.verdict).toBe('together')
    expect(c?.apartFrames).toBe(1)
    c = trackVehicleCompany(c, frame(60, 400), ring)
    expect(c?.apartFrames).toBe(COMPANY_APART_FRAMES)
    expect(c?.verdict).toBe('apart')
    // Together again resets it.
    c = trackVehicleCompany(c, frame(80, 0), ring)
    expect(c?.verdict).toBe('together')
    expect(c?.apartFrames).toBe(0)
  })

  it('starts over for a different vehicle', () => {
    const ring = ringOf([fix(0, 0), fix(10, 0)])
    const c = trackVehicleCompany(null, frame(5, 0), ring)
    const d = trackVehicleCompany(
      c,
      { ...frame(5, 0), vehicleId: '1:8150' },
      ring
    )
    expect(d?.vehicleId).toBe('1:8150')
    expect(trackVehicleCompany(c, null, ring)).toBeNull()
  })

  const riding: RidingState = {
    boardedAt: T0 - 600000,
    headsign: 'ORANGE Downtown Minneapolis',
    legIndex: 1,
    offRouteSince: null,
    routeId: '1:904',
    routeShortName: null,
    tripId: TRIP,
    vehicleId: VEHICLE
  }
  const match = {
    confidence: 'confirmed',
    distanceMeters: 900,
    label: '8143',
    lastSeen: T0,
    tripId: TRIP,
    vehicleId: VEHICLE
  } as VehicleMatchResult
  // One together frame of a bus only ever confirmed: what a tap gives.
  const together = {
    apartFrames: 0,
    lastDistanceM: 8,
    lastFrameSeconds: T0 / 1000,
    lastTogetherAtMs: T0,
    matchedHigh: true,
    togetherFrames: 1,
    vehicleId: VEHICLE,
    verdict: 'together' as const
  }

  it('holds only a real bus, confirmed, with the rider, not silent past the cap', () => {
    const held = (over: any = {}) =>
      ridingHeldByVehicle({
        company: together,
        match,
        nowMs: T0 + 60000,
        riding,
        ...over
      })
    expect(held()).toBe(true)
    // ~330 s silent mid-detour on the ride: still held.
    expect(held({ nowMs: T0 + 330000 })).toBe(true)
    expect(held({ nowMs: T0 + COMPANY_SILENCE_CAP_MS + 1 })).toBe(false)
    // A confirmed match naming another bus, or none at all (taken away by
    // "not on the bus", an early alight, a new route): nothing held.
    expect(held({ match: { ...match, vehicleId: '1:8150' } })).toBe(false)
    expect(held({ match: null })).toBe(false)
    expect(held({ riding: { ...riding, vehicleId: 'route:1:904' } })).toBe(
      false
    )
    expect(held({ riding: { ...riding, tripId: null } })).toBe(false)
    expect(held({ company: { ...together, verdict: 'apart' } })).toBe(false)
    expect(held({ company: null })).toBe(false)
  })

  it('holds on a `high` match only once the bus is together on the sustain (R14)', () => {
    // The 35.1 rebind floor, deliberately: keeping a fact on a bus takes no
    // less evidence than moving it to one.
    expect(COMPANY_HIGH_SUSTAIN_FRAMES).toBe(RIDING_REBIND_MIN_FRAMES)
    const high = { ...match, confidence: 'high' as const }
    const sustained = {
      ...together,
      togetherFrames: COMPANY_HIGH_SUSTAIN_FRAMES
    }
    const held = (over: any = {}) =>
      ridingHeldByVehicle({
        company: sustained,
        match: high,
        nowMs: T0 + 60000,
        riding,
        ...over
      })
    expect(held()).toBe(true)
    // Under the sustain: not yet.
    expect(
      held({
        company: {
          ...sustained,
          togetherFrames: COMPANY_HIGH_SUSTAIN_FRAMES - 1
        }
      })
    ).toBe(false)
    // A bus the matcher never called better than `medium` vouches for nothing.
    expect(held({ company: { ...sustained, matchedHigh: false } })).toBe(false)
    // The poll the bus missed (16:28:32-16:32:48 on the ride): the matcher
    // names nobody, or another bus, and the record still speaks...
    const none = {
      confidence: 'none' as const,
      distanceMeters: null,
      label: null,
      lastSeen: T0,
      vehicleId: null
    }
    expect(held({ match: none })).toBe(true)
    expect(held({ match: { ...high, vehicleId: '1:8121' } })).toBe(true)
    // ...until the cap, or until the bus's own frames break company.
    expect(held({ match: none, nowMs: T0 + COMPANY_SILENCE_CAP_MS + 1 })).toBe(
      false
    )
    expect(held({ company: { ...sustained, verdict: 'apart' } })).toBe(false)
    // Still a REAL bus only.
    expect(held({ riding: { ...riding, vehicleId: 'route:1:904' } })).toBe(
      false
    )
  })

  it('counts together frames, and only a broken company starts them again', () => {
    const ring = ringOf(Array.from({ length: 120 }, (_, i) => fix(i, 0)))
    const high = (s: number, northM: number) => ({
      ...frame(s, northM),
      confidence: 'high' as const
    })
    let c = trackVehicleCompany(
      null,
      { ...frame(0, 5), confidence: 'medium' },
      ring
    )
    expect(c?.togetherFrames).toBe(1)
    expect(c?.matchedHigh).toBe(false)
    c = trackVehicleCompany(c, high(20, 5), ring)
    expect(c?.togetherFrames).toBe(2)
    expect(c?.matchedHigh).toBe(true)
    // The same frame again counts nothing; a grey frame and one apart frame
    // prove nothing either way.
    expect(trackVehicleCompany(c, high(20, 5), ring)).toBe(c)
    c = trackVehicleCompany(c, high(40, 100), ring)
    c = trackVehicleCompany(c, high(60, 400), ring)
    expect(c?.verdict).toBe('together')
    expect(c?.togetherFrames).toBe(2)
    c = trackVehicleCompany(c, high(80, 5), ring)
    expect(c?.togetherFrames).toBe(3)
    // Broken: back to nothing.
    c = trackVehicleCompany(c, high(100, 400), ring)
    c = trackVehicleCompany(c, high(110, 400), ring)
    expect(c?.verdict).toBe('apart')
    expect(c?.togetherFrames).toBe(0)
    // A frame with no confidence (read from the feed) does not vouch.
    const fromFeed = trackVehicleCompany(null, frame(0, 5), ring)
    expect(fromFeed?.matchedHigh).toBe(false)
  })

  it("keeps the riding bus's record when the matcher names another bus or none", () => {
    const ring = ringOf(Array.from({ length: 120 }, (_, i) => fix(i, 0)))
    const own = (s: number, northM: number) => ({
      heading: 0,
      label: '8143',
      lat: 44.85 + northM / 111_195,
      lon: -93.28,
      nextStopId: '1:51110',
      nextStopName: '',
      patternId: 'p',
      seconds: (T0 + s * 1000) / 1000,
      speed: 14,
      stopStatus: 'IN_TRANSIT_TO',
      tripId: TRIP,
      vehicleId: VEHICLE
    })
    const prev = trackVehicleCompany(
      null,
      { ...frame(0, 5), confidence: 'high' },
      ring
    ) as any
    const none = {
      confidence: 'none' as const,
      distanceMeters: null,
      label: null,
      lastSeen: T0,
      vehicleId: null
    }
    const other = {
      ...none,
      confidence: 'high' as const,
      vehicleId: '1:8121'
    }
    // Absent from the poll: the record stands as it was.
    expect(
      trackRidingCompany(prev, { match: none, riding, ring, vehicles: [] })
    ).toBe(prev)
    // In the poll while the matcher names 8121: 8143's own frame is judged,
    // and its record is not handed to 8121.
    const judged = trackRidingCompany(prev, {
      match: other,
      riding,
      ring,
      vehicles: [own(20, 400)]
    })
    expect(judged?.vehicleId).toBe(VEHICLE)
    expect(judged?.apartFrames).toBe(1)
    expect(judged?.matchedHigh).toBe(true)
    // A match taken away, or no fact to keep: trackVehicleCompany exactly.
    expect(
      trackRidingCompany(prev, { match: null, riding, ring, vehicles: [] })
    ).toBeNull()
    expect(
      trackRidingCompany(prev, {
        match: other,
        riding: null,
        ring,
        vehicles: [own(20, 5)]
      })?.vehicleId
    ).toBe('1:8121')
  })

  it('carries the frame on a matcher result too (R14)', () => {
    const v = {
      directionId: 0,
      heading: 0,
      label: '8143',
      lat: 44.8512,
      lon: -93.2885,
      nextStopId: '1:51110',
      nextStopName: '',
      patternId: '1:904:0:01',
      routeId: '1:904',
      seconds: 1791840150,
      speed: 0,
      stopStatus: 'STOPPED_AT',
      tripId: TRIP,
      vehicleId: VEHICLE
    }
    const m = matchUserToVehicle(
      44.8512,
      -93.2886,
      null,
      [v],
      '1:904',
      null,
      80,
      0,
      null,
      { nowMs: 1791840160000 }
    )
    expect(m.vehicleId).toBe(VEHICLE)
    expect(m.frameLat).toBe(44.8512)
    expect(m.frameLon).toBe(-93.2885)
    expect(m.frameSeconds).toBe(1791840150)
  })

  it('carries the frame on a refreshed confirmed match', () => {
    const refreshed = refreshConfirmedMatch(
      match,
      [
        {
          heading: 0,
          label: '8143',
          lat: 44.8512,
          lon: -93.2885,
          nextStopId: '1:51110',
          nextStopName: '',
          patternId: 'p',
          seconds: 1791840150,
          speed: 14,
          stopStatus: 'IN_TRANSIT_TO',
          tripId: TRIP,
          vehicleId: VEHICLE
        }
      ],
      44.86,
      -93.2885,
      1791840190000
    ) as VehicleMatchResult
    expect(refreshed.frameLat).toBe(44.8512)
    expect(refreshed.frameLon).toBe(-93.2885)
    expect(refreshed.frameSeconds).toBe(1791840150)
  })
})

describe('util > go-mode > a held fact on a detour (47.1)', () => {
  const NOW = 1_791_840_200_000
  const leg: any = {
    headsign: 'ORANGE Downtown Minneapolis',
    mode: 'BUS',
    route: { gtfsId: '1:904' },
    routeId: '1:904',
    transitLeg: true,
    trip: { gtfsId: TRIP }
  }
  const prev: RidingState = {
    boardedAt: NOW - 400000,
    headsign: leg.headsign,
    legIndex: 1,
    offRouteSince: null,
    routeId: '1:904',
    routeShortName: null,
    tripId: TRIP,
    vehicleId: VEHICLE
  }
  const offShape: any = {
    distanceFromRoute: 700,
    isOnRoute: false,
    legIndex: 1,
    progressAlongLeg: 0.05
  }
  const base = {
    matchedLeg: leg,
    nowMs: NOW,
    offRouteClearMs: 90000,
    riderSpeedMps: 15,
    routeMatch: offShape,
    vehicleMatch: null
  }

  it('does not start the clock while the bus holds the fact', () => {
    expect(
      decideRiding({ ...base, heldByVehicle: true, prevRiding: prev }).kind
    ).toBe('none')
    // A clock already running is stopped.
    const d = decideRiding({
      ...base,
      heldByVehicle: true,
      prevRiding: { ...prev, offRouteSince: NOW - 80000 }
    }) as any
    expect(d.kind).toBe('set')
    expect(d.riding.offRouteSince).toBeNull()
  })

  it('runs the clock as before when the bus does not hold it', () => {
    expect(decideRiding({ ...base, prevRiding: prev }).kind).toBe(
      'markOffRoute'
    )
    expect(
      decideRiding({
        ...base,
        heldByVehicle: false,
        prevRiding: { ...prev, offRouteSince: NOW - 91000 }
      }).kind
    ).toBe('clear')
    // A synthetic id is no bus: no hold even if the caller says so.
    expect(
      decideRiding({
        ...base,
        heldByVehicle: true,
        prevRiding: { ...prev, vehicleId: 'route:1:904' }
      }).kind
    ).toBe('markOffRoute')
  })

  it('keeps the board time when the same trip, bus and leg come back', () => {
    const onShape: any = {
      distanceFromRoute: 3,
      isOnRoute: true,
      legIndex: 1,
      progressAlongLeg: 0.3
    }
    const confirmed = {
      consecutiveMatches: 5,
      match: {
        confidence: 'confirmed',
        distanceMeters: 9,
        label: '8143',
        lastSeen: NOW,
        routeId: '1:904',
        tripId: TRIP,
        vehicleId: VEHICLE
      } as VehicleMatchResult
    }
    const back = (cleared: RidingState) =>
      (
        decideRiding({
          ...base,
          clearedRiding: cleared,
          prevRiding: null,
          routeMatch: onShape,
          vehicleMatch: confirmed
        }) as any
      ).riding.boardedAt
    expect(back(prev)).toBe(prev.boardedAt)
    // A different bus, trip or leg is a different boarding.
    expect(back({ ...prev, vehicleId: '1:8150' })).toBe(NOW)
    expect(back({ ...prev, tripId: '1:999' })).toBe(NOW)
    expect(back({ ...prev, legIndex: 3 })).toBe(NOW)
  })

  it('is not deviated while held, and is without it', () => {
    expect(determineTripStatus(offShape, 40, 5, 9000)).toBe('deviated')
    expect(
      determineTripStatus(offShape, 40, 5, 9000, false, null, false, true)
    ).toBe('behind')
  })

  it('still says "Off route", at medium priority, on the same cooldowns', () => {
    const gate = { nowMs: NOW, ridingHeldByVehicle: true }
    const card = checkRouteDeviation(261, [], leg, gate)
    expect(card?.type).toBe('ROUTE_DEVIATION')
    expect(card?.title).toBe('Off route')
    expect(card?.message).toBe('261m from the route')
    expect(card?.priority).toBe('medium')
    // Unheld: today's high.
    expect(checkRouteDeviation(261, [], leg, { nowMs: NOW })?.priority).toBe(
      'high'
    )
    // Within 120 s of the last one, nothing — held or not.
    expect(
      checkRouteDeviation(261, [], leg, { ...gate, handledAtMs: NOW - 60000 })
    ).toBeNull()
    // And the cooldown is held open for the whole excursion, so a nine-minute
    // detour is one card.
    expect(
      nextDeviationHandledAtMs({
        alerted: false,
        currentLeg: leg,
        distanceFromRoute: 700,
        handledAtMs: NOW - 100000,
        nowMs: NOW,
        replanImminent: false
      })
    ).toBe(NOW)
  })
})
