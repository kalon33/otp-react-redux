/* globals describe, expect, it, jest */
import '../../test-utils/mock-window-url'

import * as vehicleCompany from '../../../lib/util/go-mode/vehicle-company'
import {
  aboardBeforeLegStart,
  PRE_LEG_PROGRESS_MAX,
  ridingTransitLegIndex
} from '../../../lib/util/go-mode/riding'
import {
  calculateTripProgress,
  determineTripStatus
} from '../../../lib/util/go-mode/progress-calculator'
import { checkRouteDeviation } from '../../../lib/util/go-mode/notification-service'
import {
  hhmmss as clockOf,
  confirmAndReplay
} from '../../test-utils/onboard-confirm-replay'
import { matchPositionToRoute } from '../../../lib/util/go-mode/position-matching'
import type { RidingState } from '../../../lib/util/go-mode/types'

/** Same stub as detour-riding-hold-1012.ts: the full-tick block runs the tick. */
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
 * 2026-09-21 ride 2, session `mubbbiy9-6zjoq9` — backlog 22.1.
 *
 * Rider note 09:24:56: *"I used already on the bus flow but it's showing like
 * I'm not!"* The screenshot has the header reading **"On Bus #8228"** and the
 * map banner reading **"2379m from route"** on the same screen, with the
 * orange line starting south of the dot.
 *
 * Nothing about the aboard state was wrong. `goMode.riding` held Orange Line
 * trip `1:1268952` and `UPDATE_VEHICLE_MATCH.match.confidence` was `confirmed`
 * on every tick. What was wrong was everything computed from the leg's
 * GEOMETRY: `buildOnboardItinerary` anchors the built bus leg at the vehicle's
 * NEXT stop (`findAnchorIndex`, alight-optimizer.ts:484-490) — I-35W & 66th St,
 * `[44.883158, -93.296483]` — while the rider was 2.58 km north of it doing
 * 28 m/s down I-35W. So the matcher projected them onto the leg's first vertex,
 * `determineTripStatus` returned `deviated` on `!isOnRoute`
 * (progress-calculator.ts:536-538), and `checkRouteDeviation` raised a
 * high-priority card at 09:24:47.
 *
 * Measured here on the ride's own recording, not on the note: the fixture is
 * replayed through the real matcher, and the first block below is the
 * behaviour as it shipped.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fx: any = require('../../../lib/util/go-mode/replay/fixtures/0921-0924-orange-onboard.json')

/** `START_GO_MODE` 09:24:21.322 — the onboard splice becoming the trip. */
const START_MS: number = fx.meta.startMs
/** The window the row names: the first two minutes of it. */
const WINDOW_MS = 120_000

const ITINERARY = fx.itinerary
const LEGS: any[] = ITINERARY.legs

/** The bus the rider was on, exactly as `CONFIRM_VEHICLE` had it. */
const RIDING: RidingState = {
  boardedAt: 1790000638000,
  headsign: 'ORANGE Burnsville',
  legIndex: 0,
  offRouteSince: null,
  routeId: '1:904',
  routeShortName: null,
  tripId: '1:1268952',
  vehicleId: '1:8228'
}

/** 8228's own next stop for the whole window — the leg's first call. */
const NEXT_STOP_ID = '1:52719'

interface Tick {
  deviationCard: boolean
  distanceFromRoute: number
  exempt: boolean
  isOnRoute: boolean
  legIndex: number
  progressAlongLeg: number
  status: string
  tMs: number
}

/**
 * Replay the window through the real matcher, status and deviation check.
 * `aboard` chooses whether the 22.1 exemption is offered at all, so the same
 * code path produces both the before and the after.
 */
function replayWindow(aboard: boolean): Tick[] {
  const track = fx.gpsTrack.filter(
    (p: any) => p.tMs >= START_MS && p.tMs <= START_MS + WINDOW_MS
  )
  let previousMatch: any = null
  let sent: string[] = []
  const out: Tick[] = []
  for (const fix of track) {
    const match = matchPositionToRoute(
      [fix.lat, fix.lon],
      LEGS,
      0,
      previousMatch,
      {
        accuracyM: fix.accuracy,
        movedSinceFixM: null,
        nowMs: fix.tMs
      }
    )
    if (!match) continue
    previousMatch = match
    const exempt =
      aboard &&
      aboardBeforeLegStart({
        legs: LEGS,
        riding: RIDING,
        routeMatch: match,
        vehicleNextStopId: NEXT_STOP_ID
      })
    const progress = calculateTripProgress(
      new Date(fix.tMs),
      ITINERARY,
      match,
      null,
      undefined,
      fix.speed,
      null,
      null,
      [fix.lat, fix.lon],
      exempt
    )
    const card = checkRouteDeviation(
      match.distanceFromRoute,
      sent,
      LEGS[match.legIndex],
      {
        aboardBeforeLeg: exempt,
        nowMs: fix.tMs
      }
    )
    if (card) sent = [...sent, card.id]
    out.push({
      deviationCard: !!card,
      distanceFromRoute: match.distanceFromRoute,
      exempt,
      isOnRoute: match.isOnRoute,
      legIndex: match.legIndex,
      progressAlongLeg: match.progressAlongLeg,
      status: progress.status,
      tMs: fix.tMs
    })
  }
  return out
}

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

const BEFORE = replayWindow(false)
const AFTER = replayWindow(true)

describe('util > go-mode > the fixture is the ride the row describes', () => {
  it('is the onboard splice: leg 0 is the bus, anchored at 66th St', () => {
    expect(fx.meta.session).toBe('mubbbiy9-6zjoq9')
    expect(LEGS[0].transitLeg).toBe(true)
    expect(LEGS[0].trip.gtfsId).toBe('1:1268952')
    expect(LEGS[0].from.stopId).toBe(NEXT_STOP_ID)
    expect(LEGS[0].from.name).toBe('I-35W & 66th St Station')
    // …and the rider is 2.5 km north of it when the trip starts.
    expect(BEFORE[0].distanceFromRoute).toBeGreaterThan(2500)
  })

  it('the riding fact names the leg the matcher is measuring', () => {
    expect(ridingTransitLegIndex(LEGS, RIDING)).toBe(0)
    expect(BEFORE.every((t) => t.legIndex === 0)).toBe(true)
  })
})

describe('util > go-mode > aboard before the anchor, as it shipped (22.1)', () => {
  it('read deviated for 115 of the 120 ticks — the report says 116 s', () => {
    expect(BEFORE).toHaveLength(120)
    expect(BEFORE.filter((t) => t.status === 'deviated')).toHaveLength(115)
    // Every one of them is the same mis-read: off the shape, nothing else.
    expect(
      BEFORE.every((t) => (t.status === 'deviated') === !t.isOnRoute)
    ).toBe(true)
  })

  it('ends exactly where the ride ended it, at the 250 m buffer', () => {
    const firstOnRoute = BEFORE.find((t) => t.isOnRoute)
    expect(firstOnRoute).toBeDefined()
    expect(hhmmss(firstOnRoute!.tMs)).toBe('09:26:16')
    expect(firstOnRoute!.distanceFromRoute).toBeLessThan(250)
  })

  it('never moved off the leg start while it did so', () => {
    // The whole mis-read in one number: the projection is pinned to the leg's
    // first vertex for 2.5 km of real travel.
    expect(
      BEFORE.every((t) => t.progressAlongLeg <= PRE_LEG_PROGRESS_MAX)
    ).toBe(true)
    expect(BEFORE[0].distanceFromRoute).toBeGreaterThan(2500)
    expect(BEFORE[BEFORE.length - 1].distanceFromRoute).toBeLessThan(200)
  })

  it('pushed a high-priority ROUTE_DEVIATION at the rider', () => {
    const cards = BEFORE.filter((t) => t.deviationCard)
    expect(cards.length).toBeGreaterThan(0)
    expect(cards[0].distanceFromRoute).toBeGreaterThan(2000)
  })
})

describe('util > go-mode > aboard before the anchor, fixed (22.1)', () => {
  it('is never deviated while the bus is approaching 66th St', () => {
    expect(AFTER.some((t) => t.status === 'deviated')).toBe(false)
  })

  it('raises no ROUTE_DEVIATION card at all in the window', () => {
    expect(AFTER.filter((t) => t.deviationCard)).toHaveLength(0)
  })

  it('claims the exemption on exactly the 115 off-route ticks', () => {
    expect(AFTER.filter((t) => t.exempt)).toHaveLength(115)
    expect(AFTER.every((t) => t.exempt === !t.isOnRoute)).toBe(true)
    // …and the status is then the clock's answer, not the geometry's: the
    // ordinary ahead/behind/on_track comparison, which for this rider reads
    // `behind` early in the leg and `on_track` as the bus closes on 66th St.
    expect(new Set(AFTER.map((t) => t.status))).toEqual(
      new Set(['behind', 'on_track'])
    )
  })
})

describe('util > go-mode > what the exemption refuses', () => {
  const offRoute = {
    distanceFromRoute: 2584.5,
    isOnRoute: false,
    legIndex: 0,
    matchedAtMs: START_MS,
    nearestPoint: [44.88316, -93.29642] as [number, number],
    progressAlongLeg: 0
  } as any

  it('a fact with no bus behind it — a GPS projection buys nothing', () => {
    expect(
      aboardBeforeLegStart({
        legs: LEGS,
        riding: { ...RIDING, vehicleId: null },
        routeMatch: offRoute,
        vehicleNextStopId: NEXT_STOP_ID
      })
    ).toBe(false)
    // A synthetic `route:` id is in no feed and is no evidence either.
    expect(
      aboardBeforeLegStart({
        legs: LEGS,
        riding: { ...RIDING, vehicleId: 'route:1:904' },
        routeMatch: offRoute,
        vehicleNextStopId: NEXT_STOP_ID
      })
    ).toBe(false)
  })

  it('a rider who has actually started down the leg — a real detour', () => {
    expect(
      aboardBeforeLegStart({
        legs: LEGS,
        riding: RIDING,
        routeMatch: { ...offRoute, progressAlongLeg: 0.2 },
        vehicleNextStopId: NEXT_STOP_ID
      })
    ).toBe(false)
  })

  it('a bus whose own next stop this leg never calls at', () => {
    expect(
      aboardBeforeLegStart({
        legs: LEGS,
        riding: RIDING,
        routeMatch: offRoute,
        vehicleNextStopId: '1:53543'
      })
    ).toBe(false)
    // …but a feed that publishes nothing is not evidence against.
    expect(
      aboardBeforeLegStart({
        legs: LEGS,
        riding: RIDING,
        routeMatch: offRoute,
        vehicleNextStopId: null
      })
    ).toBe(true)
  })

  it('a rider who is on the shape — nothing to exempt', () => {
    expect(
      aboardBeforeLegStart({
        legs: LEGS,
        riding: RIDING,
        routeMatch: { ...offRoute, isOnRoute: true },
        vehicleNextStopId: NEXT_STOP_ID
      })
    ).toBe(false)
  })

  it('leaves determineTripStatus alone when nothing is claimed', () => {
    expect(determineTripStatus(offRoute, 10, 10, null)).toBe('deviated')
    expect(determineTripStatus(offRoute, 10, 10, null, false)).toBe('deviated')
    expect(determineTripStatus(offRoute, 10, 10, null, true)).toBe('on_track')
    // Arrival still wins over everything, exemption or not.
    expect(determineTripStatus(offRoute, 10, 99, 5, true)).toBe('completed')
  })
})

/**
 * Cycle 33, measure-first (2026-10-20). Everything above feeds the exemption a
 * FIXED riding fact and never runs `decideRiding`, so it cannot say whether
 * the fact itself lives through the approach. On the phone it did not: the
 * 09:24:21.334 tick stamped `offRouteSince` and `CLEAR_RIDING` landed at
 * 09:25:52.081 (debug-2026-09-21.jsonl) — the 90 s clock, with the rider in
 * 8228 the whole time. The exemption only gates status, card and map; the
 * plan's question is whether today's holds (`ridingCorridor`, 47.1's
 * `heldByVehicle`) keep a fresh fact alive through the same 116 s, or whether
 * `decideRiding` needs the exemption as a third hold.
 *
 * Replayed through the REAL store and tick: the Confirm at 09:24:21.320 is
 * the rider's own (onboard-preview-confirm, 98th St), committed by
 * confirmOnboardAlightStop over the fact the 09:23:58 discovery wrote, so the
 * riding fact is exactly the one 64.3's Confirm writes.
 */
const CONFIRM_MS = 1790000661320

describe('22.1 — the fresh fact through the approach, full tick', () => {
  const replayApproach = () => {
    const result = fx.onboard.result.payload
    return confirmAndReplay(
      fx,
      {
        confirmAtMs: CONFIRM_MS,
        // SET_RIDING 09:23:58.606 — the onboard discovery's fact.
        kept: {
          boardedAt: 1790000638606,
          headsign: 'ORANGE Burnsville',
          legIndex: -1,
          offRouteSince: null,
          routeId: '1:904',
          routeShortName: null,
          tripId: '1:1268952',
          vehicleId: '1:8228'
        },
        option: result.options[1],
        options: result.options,
        // SET_ONBOARD_VEHICLE 09:23:58.606.
        vehicle: {
          label: '8228',
          nextStopId: NEXT_STOP_ID,
          routeId: '1:904',
          tripId: '1:1268952',
          vehicleId: '1:8228'
        }
      },
      { commit: 'confirm', windowMs: 160_000 }
    )
  }
  const stampsOf = (sets: Array<{ p: any }>) => {
    let prev: number | null = null
    const stamps: number[] = []
    for (const e of sets) {
      const now = e.p?.offRouteSince ?? null
      if (prev == null && now != null) stamps.push(now)
      prev = now
    }
    return stamps
  }

  it('measures stamps and clears over the 116 s approach (and to 09:27)', async () => {
    const r = await replayApproach()
    expect(r.itinerary.legs[0].from.name).toBe('I-35W & 66th St Station')
    // Off-route stamps: SET_RIDING going from a clean clock to a stamped one.
    const stamps = stampsOf(r.sets)
    const holds = r.events
      .filter((e) => e.type === 'RIDING_VEHICLE_HOLD')
      .map((e) => [clockOf(e.t), e.p?.on, e.p?.verdict])
    expect(r.statuses.length).toBeGreaterThan(150)

    // MEASURED (cycle 33): one stamp, on the first tick — the rider 2.58 km
    // short of 66th St, exactly as on the phone (09:24:21.333)…
    expect(stamps.map(clockOf)).toEqual(['09:24:21'])
    // …but no CLEAR_RIDING at all, where the phone cleared at 09:25:52.
    expect(r.clears).toEqual([])
    // What saved it is 47.1's hold: 8228's frames put the bus with the rider,
    // the hold engaged at 09:25:07 and reset the clock — 46 s into the 90 —
    // and let go at 09:26:16, the tick the rider came onto the shape.
    expect(holds).toEqual([
      ['09:25:07', true, 'together'],
      ['09:26:16', false, 'together']
    ])
    expect(Date.parse('2026-09-21T09:25:07-05:00')).toBeLessThan(
      stamps[0] + 90_000
    )
    // Status read the clock's ahead/behind throughout (the cycle 1
    // exemption, now fed by a fact that exists): never deviated.
    expect(r.deviated).toEqual([])
    // At 09:27 the fact is still 8228 on leg 0, clock clean.
    expect(r.riding).toMatchObject({
      legIndex: 0,
      offRouteSince: null,
      tripId: '1:1268952',
      vehicleId: '1:8228'
    })
    // So: nothing more is needed in decideRiding for this ride — no third
    // hold. The margin is the hold's: it needs 8228's feed to put the bus
    // with the rider inside 90 s of the stamp, and here it took 47 s.
  }, 120_000)

  it('control: without the 47.1 hold the clock clears it, as on the phone', async () => {
    // The ride itself ran before 47.1 (2026-10-12) existed. Take the hold
    // away and the same replay drops the fact on the 90 s clock — the
    // phone's 09:25:52 CLEAR_RIDING — so the hold is the whole difference.
    const spy = jest
      .spyOn(vehicleCompany, 'ridingHeldByVehicle')
      .mockReturnValue(false)
    try {
      const r = await replayApproach()
      const stamps = stampsOf(r.sets)
      expect(stamps.map(clockOf)).toEqual(['09:24:21'])
      expect(r.clears).toHaveLength(1)
      expect(r.clears[0] - stamps[0]).toBeGreaterThan(90_000)
      expect(r.clears[0] - stamps[0]).toBeLessThan(92_000)
      // 09:25:51: the fix that tripped it, at its own time (75.29); the
      // phone logged the clear as it handled that fix.
      expect(clockOf(r.clears[0])).toBe('09:25:51')
    } finally {
      spy.mockRestore()
    }
  }, 120_000)
})
