import { existsSync, readFileSync } from 'fs'
import path from 'path'

import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import { classifyMissedBus } from '../../../lib/util/go-mode/notification-service'
import {
  DEGENERATE_ACCESS_LEG_M,
  dropDegenerateAccessLeg
} from '../../../lib/util/go-mode/access-splice'
import {
  findVehicleForTrip,
  tripStopIdsInOrder,
  VEHICLE_RECORD_STALE_SEC,
  vehiclePassedStopOnTrip
} from '../../../lib/util/go-mode/transit-trust'
import { resolveBoardDeparture } from '../../../lib/util/go-mode/board-departure'
import goMode from '../../../lib/reducers/go-mode'

/**
 * Backlog 25.1. Session `mubq7tfx-8dz3ar`, 2026-09-21 ride 2.
 *
 * Rider note 17:06:53: *"I'm sick of the negative minute wait notifications.
 * Please determine if I'm at the bus stop or not with reasonable measures."*
 *
 * What the stream says, verbatim (`~/otp-debug-logs/debug-2026-09-21.jsonl`,
 * and the same records in the fixture):
 *
 *   17:05:44.176  REALTIME_VEHICLE_POSITIONS_RESPONSE  route 1:904, vehicles: []
 *   17:05:45.083  START_REROUTE {reason: 'missed-bus', autoApply: true}
 *   17:06:05.133  REALTIME_VEHICLE_POSITIONS_RESPONSE  route 1:904, vehicles: []
 *   17:06:06.043  START_REROUTE {reason: 'missed-bus', autoApply: true}
 *   17:08:19.065  SET_RIDING {tripId: '1:1273254', vehicleId: '1:8142'}
 *
 * Every OTHER poll in 17:03-17:10 carried 12 vehicles, the planned trip
 * `1:1273254` among them with `nextStopId: '1:17781'` — the boarding stop —
 * from 17:04:22 onward. The bus was 2,527 m north at 17:05:03, 2,145 m at
 * 17:06:25, 1,688 m at 17:06:46, and it picked the rider up at 17:08:18. The
 * rider had not moved since 16:57 and sat 14-23 m from the boarding stop's own
 * coordinate throughout (the row's "1-6 m" is the distance to the station, not
 * to the point classifyMissedBus measures against; both are well inside
 * MISSED_BUS_AT_STOP_RADIUS_M).
 *
 * So the bus-still-coming guard did not fail to recognise the record — there
 * WAS no record. `REALTIME_VEHICLE_POSITIONS_RESPONSE` `$set`s the route's
 * vehicle list (create-otp-reducer :933), an empty response erases it, and
 * `findVehicleForTrip([], ...)` is null. 15 of this ride's 124 polls were
 * empty; the two misses landed 0.9 s after two of them.
 *
 * The fixture is 15 MB and is not committed, so everything here skips when it
 * is absent.
 */

const FIXTURE_PATH = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/0921-1646-orange-missedbus.json'
)
const fx: any = existsSync(FIXTURE_PATH)
  ? JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
  : null
const withFixture = fx ? describe : describe.skip

const ROUTE_ID = '1:904'
const TRIP_ID = '1:1273254'
const VEHICLE_ID = '1:8142'
const BOARD_STOP_ID = '1:17781'

/** 17:04:00 -> 17:09:00 local, the window the row names. */
const FROM_MS = 1790028240000
const TO_MS = 1790028540000
/** The two START_REROUTE {reason:'missed-bus'} instants. */
const MISS_1_MS = 1790028345083
const MISS_2_MS = 1790028366043
/** SET_RIDING on the planned trip. */
const BOARDED_MS = 1790028499065
/** The board epoch every SET_LIVE_LEG_TIMES carried: 17:03:00. */
const TRIP_BOARD_EPOCH = 1790028180000
/** What the boarding stop's own poll said in the same second: 17:07:50. */
const STOP_BOARD_EPOCH = 1790028470000

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

/** Latest recorded entry at or before `ms`, else the earliest one. */
const atOrBefore = <T extends { tMs: number }>(
  rows: T[],
  ms: number
): T | null => {
  let best: T | null = null
  for (const row of rows) {
    if (row.tMs <= ms && (!best || row.tMs > best.tMs)) best = row
  }
  return best ?? rows[0] ?? null
}

const vehicleSnapshots = (): any[] =>
  (fx.vehicleSnapshots || []).filter((s: any) => s.routeId === ROUTE_ID)

const tripSnapshots = (): any[] =>
  (fx.tripSnapshots || []).filter((s: any) => s.tripId === TRIP_ID)

const stopSnapshots = (): any[] =>
  (fx.stopTimeSnapshots || []).filter((s: any) => s.stopId === BOARD_STOP_ID)

/** The itinerary Go Mode was showing at `ms` (the 17:05:46 replan swaps it). */
const itineraryAt = (ms: number): any => {
  let it = fx.itinerary
  for (const swap of [...(fx.itinerarySwaps || [])].sort(
    (a: any, b: any) => a.tMs - b.tMs
  )) {
    if (swap.tMs <= ms) it = swap.itinerary
  }
  return it
}

const boardLegOf = (itinerary: any): any =>
  (itinerary.legs || []).find((l: any) => l.transitLeg)

const fixesBetween = (fromMs: number, toMs: number): any[] =>
  (fx.gpsTrack || [])
    .filter((p: any) => p.tMs >= fromMs && p.tMs <= toMs)
    .sort((a: any, b: any) => a.tMs - b.tMs)

/**
 * The action layer's board-vehicle reading (go-mode.ts, the block feeding
 * classifyMissedBus and checkBoardVehicleApproach), run over the recording.
 *
 * `carryForward` is the only difference between main and this branch: whether
 * the last non-empty record of the boarding trip's own bus survives a poll
 * that came back empty.
 */
function replayMisses(options: {
  boardEpochAt: (ms: number) => { epoch: number; realtime: boolean }
  carryForward: boolean
  usePassedBoardStop: boolean
}) {
  const { boardEpochAt, carryForward, usePassedBoardStop } = options
  let lastBoardVehicle: { seenAtMs: number; vehicle: any } | null = null
  const definitiveTicks: number[] = []
  const anyCtxTicks: number[] = []
  let sawCarriedRecord = 0

  for (const fix of fixesBetween(FROM_MS, TO_MS)) {
    const nowMs = fix.tMs
    const itinerary = itineraryAt(nowMs)
    const legs = itinerary.legs || []
    const boardLeg = boardLegOf(itinerary)
    if (!boardLeg) continue
    const boardLegIndex = legs.indexOf(boardLeg)

    const snapshot = atOrBefore(vehicleSnapshots(), nowMs)
    const vehicles = snapshot?.payload?.vehicles || []
    const polled = findVehicleForTrip(vehicles, TRIP_ID, nowMs)
    if (polled) {
      lastBoardVehicle = { seenAtMs: nowMs, vehicle: polled.vehicle }
    } else if (
      lastBoardVehicle &&
      nowMs - lastBoardVehicle.seenAtMs > VEHICLE_RECORD_STALE_SEC * 1000
    ) {
      lastBoardVehicle = null
    }
    const record =
      polled ??
      (carryForward && lastBoardVehicle
        ? findVehicleForTrip([lastBoardVehicle.vehicle], TRIP_ID, nowMs)
        : null)
    if (!polled && record) sawCarriedRecord += 1

    const trip = atOrBefore(tripSnapshots(), nowMs)?.payload ?? null
    const boardVehicle = record
      ? {
          ageSec: record.ageSec,
          distanceToBoardStopM: calculateDistance(
            record.vehicle.lat,
            record.vehicle.lon,
            boardLeg.from.lat,
            boardLeg.from.lon
          ),
          nextStopId: record.vehicle.nextStopId ?? null,
          passedBoardStop: usePassedBoardStop
            ? vehiclePassedStopOnTrip(
                tripStopIdsInOrder(trip),
                boardLeg.from?.stop?.gtfsId ?? null,
                record.vehicle.nextStopId ?? null
              )
            : undefined
        }
      : null

    const board = boardEpochAt(nowMs)
    const ctx = classifyMissedBus({
      boardVehicle,
      currentLegIndex: 0,
      departureOverrideMs: null,
      legs,
      liveLegTimes: {
        [boardLegIndex]: {
          boardEpoch: board.epoch,
          boardRealtime: board.realtime,
          realtime: true
        }
      },
      nowMs,
      riderPosition: [fix.lat, fix.lon],
      riderSpeedMps: fix.speed ?? null,
      riding: null,
      vehicleConfidence: undefined
    })
    if (ctx) anyCtxTicks.push(nowMs)
    if (ctx?.definitive) definitiveTicks.push(nowMs)
  }
  return { anyCtxTicks, definitiveTicks, sawCarriedRecord }
}

/** The board epoch the ride actually published on every tick: 17:03:00. */
const recordedBoardEpoch = () => ({
  epoch: TRIP_BOARD_EPOCH,
  realtime: true
})

/** What 21.1's resolveBoardDeparture makes of the same recording. */
const resolvedBoardEpoch = (nowMs: number) => {
  const stopData = atOrBefore(stopSnapshots(), nowMs)?.payload ?? null
  const point = resolveBoardDeparture({
    stopData,
    tripId: TRIP_ID,
    tripPoint: { epoch: TRIP_BOARD_EPOCH, realtime: true }
  }).point
  return {
    epoch: point?.epoch ?? TRIP_BOARD_EPOCH,
    realtime: !!point?.realtime
  }
}

withFixture('the fixture still carries the defect (25.1)', () => {
  it('has two EMPTY vehicle polls, 0.9 s before each missed-bus re-plan', () => {
    const inWindow = vehicleSnapshots().filter(
      (s: any) => s.tMs >= 1790028180000 && s.tMs <= 1790028600000
    )
    const empty = inWindow.filter((s: any) => !s.payload.vehicles.length)
    expect(empty.map((s: any) => hhmmss(s.tMs))).toEqual([
      '17:05:44',
      '17:06:05',
      '17:08:33',
      '17:08:48'
    ])
    // The two that matter are the ones a MISSED_BUS lands on top of.
    expect(MISS_1_MS - empty[0].tMs).toBeLessThan(1000)
    expect(MISS_2_MS - empty[1].tMs).toBeLessThan(1000)
    // …and they are a blip, not an outage: 12 vehicles either side.
    const before = atOrBefore(vehicleSnapshots(), empty[0].tMs - 1000) as any
    expect(before.payload.vehicles.length).toBe(12)
  })

  it('the bus was five stops SHORT of the boarding stop, not past it', () => {
    // The newest record the feed had actually published before the first
    // miss: the 17:05:24 poll, erased from the store 20 s later.
    const lastFull = atOrBefore(
      vehicleSnapshots().filter((s: any) => s.payload.vehicles.length),
      MISS_1_MS
    ) as any
    expect(hhmmss(lastFull.tMs)).toBe('17:05:24')
    const record = findVehicleForTrip(
      lastFull.payload.vehicles,
      TRIP_ID,
      MISS_1_MS
    )
    expect(record?.vehicle.vehicleId).toBe(VEHICLE_ID)
    expect(record?.vehicle.nextStopId).toBe(BOARD_STOP_ID)
    // 62 s old at 17:05:45 — inside VEHICLE_RECORD_STALE_SEC (120 s).
    expect(Math.round(record!.ageSec!)).toBe(62)
    expect(record!.ageSec!).toBeLessThan(VEHICLE_RECORD_STALE_SEC)
    const boardLeg = boardLegOf(fx.itinerary)
    expect(
      Math.round(
        calculateDistance(
          record!.vehicle.lat,
          record!.vehicle.lon,
          boardLeg.from.lat,
          boardLeg.from.lon
        )
      )
    ).toBeGreaterThan(2000)
    // Its own run puts Marquette & 11th five stops before I-35W & Lake St.
    const trip = atOrBefore(tripSnapshots(), 1790028345000)!.payload
    const stopIds = tripStopIdsInOrder(trip)!
    expect(stopIds.indexOf('1:53301')).toBeLessThan(
      stopIds.indexOf(BOARD_STOP_ID)
    )
    expect(vehiclePassedStopOnTrip(stopIds, BOARD_STOP_ID, '1:53301')).toBe(
      false
    )
    expect(vehiclePassedStopOnTrip(stopIds, BOARD_STOP_ID, '1:53543')).toBe(
      true
    )
  })

  it('the rider had not moved off the platform', () => {
    // The bike leg ends 17:04:09; from 17:05:00 to the second miss the fixes
    // sit 14.2-23.5 m from the leg's own `from` point, never above 0.59 m/s.
    // (The row says "1-6 m" — that is the distance to the station, not to the
    // coordinate classifyMissedBus measures against. Both are inside
    // MISSED_BUS_AT_STOP_RADIUS_M, which is the fact that matters.)
    const boardLeg = boardLegOf(fx.itinerary)
    const fixes = fixesBetween(1790028300000, MISS_2_MS)
    const distances = fixes.map((f: any) =>
      calculateDistance(f.lat, f.lon, boardLeg.from.lat, boardLeg.from.lon)
    )
    expect(Math.round(Math.min(...distances))).toBe(14)
    expect(Math.round(Math.max(...distances))).toBe(23)
    expect(Math.max(...distances)).toBeLessThan(50)
    expect(Math.max(...fixes.map((f: any) => f.speed ?? 0))).toBeLessThan(1)
  })
})

withFixture('the classifier, replayed 17:04-17:09', () => {
  it('BEFORE: the recorded 17:03:00 board epoch raises two definitive misses', () => {
    const before = replayMisses({
      boardEpochAt: recordedBoardEpoch,
      carryForward: false,
      usePassedBoardStop: false
    })
    expect(before.definitiveTicks.length).toBeGreaterThan(0)
    // Every definitive tick falls inside the BLIND window and nowhere else:
    // from the 17:05:44.176 empty poll to the 17:06:25.141 poll that refills
    // the route (the 17:06:05.133 empty poll extends it). Outside it the
    // guard has a record of the bus and says nothing.
    const blindFrom = 1790028344176
    const blindTo = 1790028385141
    expect(
      before.definitiveTicks.every((ms) => ms >= blindFrom && ms < blindTo)
    ).toBe(true)
    expect(hhmmss(before.definitiveTicks[0])).toBe('17:05:44')
    // …which is the tick the ride's own START_REROUTE landed on, and it
    // stays definitive for the whole 42-tick blackout, the second push
    // (17:06:06) among them.
    expect(MISS_1_MS - before.definitiveTicks[0]).toBeLessThan(1500)
    expect(before.definitiveTicks.length).toBe(42)
    expect(hhmmss(before.definitiveTicks[41])).toBe('17:06:24')
    expect(
      before.definitiveTicks.some((ms) => Math.abs(ms - MISS_2_MS) < 1000)
    ).toBe(true)
  })

  it('AFTER: carrying the record across the empty poll -> zero misses', () => {
    const after = replayMisses({
      boardEpochAt: recordedBoardEpoch,
      carryForward: true,
      usePassedBoardStop: true
    })
    expect(after.definitiveTicks).toEqual([])
    expect(after.anyCtxTicks).toEqual([])
    // It really did have to carry: the polls were empty for whole ticks.
    expect(after.sawCarriedRecord).toBeGreaterThan(30)
  })

  it('the carried record alone is enough — the upstream rule is the backstop', () => {
    const carriedOnly = replayMisses({
      boardEpochAt: recordedBoardEpoch,
      carryForward: true,
      usePassedBoardStop: false
    })
    // nextStopId was already the boarding stop, so the existing guard fires.
    expect(carriedOnly.definitiveTicks).toEqual([])
  })

  it('21.1 (already on main) independently removes this ride s trigger', () => {
    // resolveBoardDeparture reads the boarding stop s own poll, which held
    // 17:07:50 for this trip while the trip query published 17:03:00.
    const resolved = resolvedBoardEpoch(MISS_1_MS)
    expect(resolved.epoch).toBe(STOP_BOARD_EPOCH)
    expect(resolved.realtime).toBe(true)
    // A departure still four minutes away is not a miss on any rule.
    const on211 = replayMisses({
      boardEpochAt: resolvedBoardEpoch,
      carryForward: false,
      usePassedBoardStop: false
    })
    expect(on211.definitiveTicks).toEqual([])
  })

  it('the boarding at 17:08:18 is untouched', () => {
    // SET_RIDING fired at 17:08:19 on the trip the plan always had. Nothing
    // above changes the itinerary, the trip or the vehicle it names.
    const boardLeg = boardLegOf(itineraryAt(BOARDED_MS))
    expect(boardLeg.trip.gtfsId).toBe(TRIP_ID)
    expect(boardLeg.from.stop.gtfsId).toBe(BOARD_STOP_ID)
    const record = findVehicleForTrip(
      (atOrBefore(vehicleSnapshots(), BOARDED_MS) as any).payload.vehicles,
      TRIP_ID,
      BOARDED_MS
    )
    expect(record?.vehicle.vehicleId).toBe(VEHICLE_ID)
    expect(record?.vehicle.stopStatus).toBe('STOPPED_AT')
  })
})

withFixture('the replan that followed (25.1 c and d)', () => {
  it('landed on the SAME trip and departure it had just called missed', () => {
    const replan = fx.itinerarySwaps[0]
    expect(hhmmss(replan.tMs)).toBe('17:05:46')
    const boardLeg = boardLegOf(replan.itinerary)
    expect(boardLeg.trip.gtfsId).toBe(TRIP_ID)
    expect(boardLeg.from.stop.gtfsId).toBe(BOARD_STOP_ID)
    // Same bus, same stop: the MISSED_BUS id is identical, so keeping it
    // across the swap is what stops the second push.
    expect(boardLeg.startTime).toBe(STOP_BOARD_EPOCH)
  })

  it('opened on a 3.33 m, one-second bike leg to a stop the rider was on', () => {
    const replanned = fx.itinerarySwaps[0].itinerary
    const lead = replanned.legs[0]
    expect(lead.mode).toBe('BICYCLE')
    expect(lead.distance).toBeCloseTo(3.33, 2)
    expect(lead.endTime - lead.startTime).toBe(1000)
    expect(lead.distance).toBeLessThan(DEGENERATE_ACCESS_LEG_M)

    const trimmed = dropDegenerateAccessLeg(replanned)
    expect(trimmed.legs.length).toBe(replanned.legs.length - 1)
    expect(trimmed.legs[0].mode).toBe('BUS')
    expect(trimmed.startTime).toBe(STOP_BOARD_EPOCH)
    expect(trimmed.endTime).toBe(replanned.endTime)
    expect(trimmed.duration).toBe(
      (Number(replanned.endTime) - STOP_BOARD_EPOCH) / 1000
    )
    // The real access legs of the same plan are untouched.
    expect(trimmed.legs.map((l: any) => Math.round(l.distance))).toEqual([
      10955, 832, 4071, 1344
    ])
  })

  it('leaves a real access leg, and a transit-first plan, alone', () => {
    // The trip's own opening leg is a 1,520 m ride — not a stub.
    expect(dropDegenerateAccessLeg(fx.itinerary)).toBe(fx.itinerary)
    // The 17:11 swap starts on the bus.
    const transitFirst = fx.itinerarySwaps[1].itinerary
    expect(dropDegenerateAccessLeg(transitFirst)).toBe(transitFirst)
  })
})

describe('MISSED_BUS survives its own recovery (25.1 c)', () => {
  const initial: any = goMode(undefined, { type: '@@INIT' } as any)
  const swap = (sentNotifications: string[]) =>
    goMode(
      {
        ...initial,
        isActive: true,
        notifications: {
          ...initial.notifications,
          recentNotifications: [],
          sentNotifications
        }
      } as any,
      {
        payload: { itinerary: { legs: [] } },
        type: 'START_GO_MODE'
      } as any
    ).notifications.sentNotifications

  it('keeps the id a missed-bus re-plan would otherwise wipe', () => {
    const id = `MISSED_BUS_ORANGE_I-35W & Lake St Station_${TRIP_BOARD_EPOCH}_${MISS_1_MS}`
    expect(swap([id])).toContain(id)
  })

  it('still clears the ids that belong to the trip that changed', () => {
    const kept = swap([
      'BOARD_BUS_APPROACHING_x_1',
      'LEAVE_SOON_x_1',
      'MISSED_BUS_x_1',
      'CONNECTION_WARNING_x_1',
      'UPCOMING_TURN_x_1'
    ])
    expect(kept).toEqual([
      'BOARD_BUS_APPROACHING_x_1',
      'LEAVE_SOON_x_1',
      'MISSED_BUS_x_1'
    ])
  })
})

describe('vehiclePassedStopOnTrip says "no evidence" rather than "no"', () => {
  const order = ['1:a', '1:b', '1:c']
  it('answers null when it cannot tell', () => {
    expect(vehiclePassedStopOnTrip(null, '1:b', '1:c')).toBeNull()
    expect(vehiclePassedStopOnTrip([], '1:b', '1:c')).toBeNull()
    expect(vehiclePassedStopOnTrip(order, null, '1:c')).toBeNull()
    expect(vehiclePassedStopOnTrip(order, '1:b', null)).toBeNull()
    // A stop that is not on this run at all.
    expect(vehiclePassedStopOnTrip(order, '1:b', '1:zz')).toBeNull()
  })
  it('answers the ordering when it can', () => {
    expect(vehiclePassedStopOnTrip(order, '1:b', '1:a')).toBe(false)
    expect(vehiclePassedStopOnTrip(order, '1:b', '1:b')).toBe(false)
    expect(vehiclePassedStopOnTrip(order, '1:b', '1:c')).toBe(true)
  })
  it('reads the trip record the store actually holds', () => {
    expect(
      tripStopIdsInOrder({
        stopTimes: [{ stop: { id: '1:a' } }, { stop: { gtfsId: '1:b' } }]
      } as any)
    ).toEqual(['1:a', '1:b'])
    expect(tripStopIdsInOrder(null)).toBeNull()
    expect(tripStopIdsInOrder({ stopTimes: [] } as any)).toBeNull()
  })
})
