import { existsSync, readFileSync } from 'fs'
import path from 'path'

import {
  BOARD_ARRIVE_METRES,
  checkBoardVehicleApproach
} from '../../../lib/util/go-mode/notification-service'
import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import { findVehicleForTrip } from '../../../lib/util/go-mode/transit-trust'
import { resolveBoardDeparture } from '../../../lib/util/go-mode/board-departure'

/**
 * Backlog 26.3. Session `mucordp1-jqcrp2`, 2026-09-22 morning ride.
 *
 * "Bus here" (BOARD_BUS_ARRIVING, priority high) fired twice for buses that
 * were parked at the Burnsville terminus, 6 km south of I-35W & 98th St:
 *
 *   08:16:52.073  BOARD_BUS_ARRIVING_1:56831_1:1346857_arriving_…  (vehicle 8148)
 *   08:38:56.607  BOARD_BUS_ARRIVING_1:56831_1:1346052_arriving_…  (vehicle 8228)
 *
 * Both vehicles carried `nextStopId: '1:56831'` — the boarding stop — for the
 * whole window, because the terminus is the stop before it. `atStop` read
 * that as "the bus is here". This replays the fixture's own vehicle polls,
 * itinerary swaps and stop/trip snapshots through checkBoardVehicleApproach
 * across both windows.
 *
 * Gate B is left OPEN (secondsToBoardStop null) so the rider's position
 * cannot be what silences it: the only thing under test is what the bus's
 * own record says.
 *
 * The fixture is 18 MB and is not committed, so everything skips without it.
 */

const FIXTURE_PATH = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/orange-stall-0922-0804.json'
)
const fx: any = existsSync(FIXTURE_PATH)
  ? JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
  : null
const withFixture = fx ? describe : describe.skip

const ROUTE_ID = '1:904'
const BOARD_STOP_ID = '1:56831'

const FIRING_1_MS = 1790083012073 // 08:16:52.073
const FIRING_2_MS = 1790084336607 // 08:38:56.607
const WINDOWS: Array<[number, number]> = [
  [FIRING_1_MS - 120000, FIRING_1_MS + 120000],
  [FIRING_2_MS - 120000, FIRING_2_MS + 120000]
]

const atOrBefore = <T extends { tMs: number }>(
  rows: T[],
  ms: number
): T | null => {
  let best: T | null = null
  for (const row of rows) {
    if (row.tMs <= ms && (!best || row.tMs > best.tMs)) best = row
  }
  return best
}

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

/** The trip query's board-stop point, as liveStopArrival would read it. */
const tripPointAt = (tripId: string, ms: number) => {
  const snap = atOrBefore(
    (fx.tripSnapshots || []).filter((s: any) => s.tripId === tripId),
    ms
  ) as any
  const st = (snap?.payload?.stopTimes || []).find(
    (x: any) => (x.stop?.gtfsId ?? x.stop?.id) === BOARD_STOP_ID
  )
  if (!st || st.realtimeArrival == null) return null
  return {
    epoch: (st.serviceDay + st.realtimeArrival) * 1000,
    projected: false,
    realtime: st.realtimeState === 'UPDATED'
  }
}

interface Tick {
  distanceM: number | null
  event: any
  legacyAtStop: boolean
  nextStopId: string | null
  nowMs: number
  tripId: string
}

/** One tick per vehicle poll in the windows, the board-alert call replayed. */
function replay(): Tick[] {
  const ticks: Tick[] = []
  const sent: string[] = []
  const polls = (fx.vehicleSnapshots || [])
    .filter((s: any) => s.payload?.routeId === ROUTE_ID)
    .filter((s: any) =>
      WINDOWS.some(([from, to]) => s.tMs >= from && s.tMs <= to)
    )
    .sort((a: any, b: any) => a.tMs - b.tMs)
  for (const poll of polls) {
    const nowMs = poll.tMs
    const boardLeg = boardLegOf(itineraryAt(nowMs))
    const tripId = boardLeg?.trip?.gtfsId
    if (!tripId) continue
    const record = findVehicleForTrip(poll.payload.vehicles, tripId, nowMs)
    const vehicle = record
      ? {
          ageSec: record.ageSec,
          distanceToBoardStopM: calculateDistance(
            record.vehicle.lat,
            record.vehicle.lon,
            boardLeg.from.lat,
            boardLeg.from.lon
          ),
          nextStopId: record.vehicle.nextStopId ?? null
        }
      : null
    const stopData =
      (
        atOrBefore(
          (fx.stopTimeSnapshots || []).filter(
            (s: any) => s.stopId === BOARD_STOP_ID
          ),
          nowMs
        ) as any
      )?.payload ?? null
    const point = resolveBoardDeparture({
      stopData,
      tripId,
      tripPoint: tripPointAt(tripId, nowMs)
    }).point
    const event = checkBoardVehicleApproach(
      boardLeg,
      {
        departureOverrideMs: null,
        liveBoardEpochMs: point?.realtime ? point.epoch : null,
        nowMs,
        secondsToBoardStop: null,
        vehicle
      },
      sent
    )
    if (event) sent.push(event.id)
    ticks.push({
      distanceM: vehicle?.distanceToBoardStopM ?? null,
      event,
      // The predicate main shipped with: next stop OR distance.
      legacyAtStop:
        !!vehicle &&
        (vehicle.nextStopId === BOARD_STOP_ID ||
          (vehicle.distanceToBoardStopM != null &&
            vehicle.distanceToBoardStopM <= BOARD_ARRIVE_METRES)),
      nextStopId: vehicle?.nextStopId ?? null,
      nowMs,
      tripId
    })
  }
  return ticks
}

withFixture('"Bus here" for a bus 6 km away (26.3)', () => {
  const ticks = fx ? replay() : []
  const nearest = (ms: number) =>
    ticks.reduce((best, t) =>
      Math.abs(t.nowMs - ms) < Math.abs(best.nowMs - ms) ? t : best
    )

  it('the recording carries the defect: next stop = boarding stop, 6 km out', () => {
    for (const [ms, trip] of [
      [FIRING_1_MS, '1:1346857'],
      [FIRING_2_MS, '1:1346052']
    ] as Array<[number, string]>) {
      // The newest poll that carried this trip's own vehicle, within 25 s of
      // the firing (the 08:38:56 swap lands between polls, and the 08:38:54
      // and 08:39:10 polls came back without 8228).
      const t = ticks
        .filter(
          (x) =>
            x.tripId === trip &&
            x.distanceM != null &&
            Math.abs(x.nowMs - ms) <= 25000
        )
        .pop()!
      expect(t).toBeTruthy()
      expect(t.nextStopId).toBe(BOARD_STOP_ID)
      expect(t.distanceM!).toBeGreaterThan(6000)
      expect(t.distanceM!).toBeLessThan(6100)
      // Main's predicate called this "at the stop".
      expect(t.legacyAtStop).toBe(true)
    }
    expect(nearest(FIRING_1_MS).tripId).toBe('1:1346857')
  })

  it('the bus never came within 5 km of the stop in either window', () => {
    const measured = ticks.filter((t) => t.distanceM != null)
    expect(measured.length).toBeGreaterThan(20)
    // 5,177 m is 8148 at 08:38:38, pulling out of Burnsville 21 min late.
    expect(
      Math.min(...measured.map((t) => t.distanceM as number))
    ).toBeGreaterThan(5000)
    // Main's predicate said "at the stop" on every one of them.
    expect(measured.every((t) => t.legacyAtStop)).toBe(true)
  })

  it('AFTER: zero BOARD_BUS_ARRIVING across 08:14:52-08:18:52 and 08:36:56-08:40:56', () => {
    const fired = ticks.filter((t) => t.event).map((t) => t.event.type)
    expect(fired).not.toContain('BOARD_BUS_ARRIVING')
    // Nor a "Bus coming · 1 min" off the feed's past predictions (the trip
    // query still said 08:15:00 for 1:1346857 at 08:37) while those buses sat
    // 5-6 km out.
    expect(fired).toEqual([])
  })
})
