/* globals describe, expect, it */
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
import { matchPositionToRoute } from '../../../lib/util/go-mode/position-matching'
import type { RidingState } from '../../../lib/util/go-mode/types'

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
