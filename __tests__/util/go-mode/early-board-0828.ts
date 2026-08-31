import {
  findVehicleById,
  shouldReplanBoardedEarlier
} from '../../../lib/util/go-mode/transit-trust'
import fixture from '../../../lib/util/go-mode/replay/fixtures/orange-early-board-0828.json'

/**
 * The 2026-08-28 afternoon ride (session mtdh67f3-0z5p24), driven from its own
 * recorded feed.
 *
 * Bloomington -> the State Fairgrounds. The rider bikes to I-35W & 98th St
 * Station and boards the Orange Line the itinerary planned — trip 1:1273995,
 * vehicle 8224, the right headsign, the right bus. Go Mode then replaced the
 * itinerary underneath them: a leg re-index and a high-priority push, mid-ride,
 * on the bus they were supposed to be on. ride-watch paged it as `aboard-swap`.
 *
 * The cause is entirely in the clock. `shouldReplanBoardedEarlier` proved "you
 * caught an earlier run" by comparing now against the PLAN's board time, and
 * the plan's board time never moves. Metro Transit was running this Orange Line
 * 284 s ahead of the itinerary's figure — 319 s at the moment of boarding, when
 * the feed briefly predicted it earlier still — and EARLY_BOARD_MIN_MS is only
 * 120 s. So from the moment the doors closed, the rider's own bus looked like a
 * bus that could not possibly have arrived yet.
 *
 * These drive the real function with the real recorded stop times rather than a
 * hand-built approximation. Validated against the unfixed code: the aboard
 * moment below returned true, which is the replan that fired.
 */

const BUS_LEG: any = (fixture as any).itinerary.legs[1]
const PLANNED_TRIP_ID: string = BUS_LEG.trip.gtfsId
const BOARD_STOP_ID: string = BUS_LEG.from.stopId
/** What the itinerary said the boarding was. Frozen at plan time. */
const PLANNED_BOARD_MS = Number(BUS_LEG.startTime)

/** The vehicle the feed had on the planned trip for this whole ride. */
const RIDDEN_VEHICLE_ID = '1:8224'

/**
 * The feed's own board epoch for the planned leg's boarding stop, as of `tMs` —
 * the number refreshLiveLegTimes turns into liveLegTimes[i].boardEpoch.
 */
const liveBoardEpochAt = (tMs: number): number | null => {
  const snap = (fixture as any).tripSnapshots
    .filter((s: any) => s.tMs <= tMs)
    .sort((a: any, b: any) => b.tMs - a.tMs)[0]
  const st = snap?.payload?.stopTimes?.find(
    (s: any) => s.stop.id === BOARD_STOP_ID
  )
  if (!st) return null
  return (st.serviceDay + (st.realtimeDeparture ?? st.realtimeArrival)) * 1000
}

/** The recorded feed rows for the Orange Line at `tMs`. */
const vehiclesAt = (tMs: number) =>
  (fixture as any).vehicleSnapshots
    .filter((s: any) => s.tMs <= tMs)
    .sort((a: any, b: any) => b.tMs - a.tMs)[0]?.payload?.vehicles ?? []

/** A recorded moment with the rider aboard: after the bus really departed, and
 * still more than EARLY_BOARD_MIN_MS before the plan claims it boards. This is
 * the window the defect lived in. */
const ABOARD_MS: number = (fixture as any).tripSnapshots
  .map((s: any) => s.tMs)
  .filter(
    (t: number) =>
      t >= (liveBoardEpochAt(t) ?? Infinity) && t < PLANNED_BOARD_MS - 120000
  )
  .sort((a: number, b: number) => a - b)[0]

const ridingOnThePlannedBus = () => {
  const v = vehiclesAt(ABOARD_MS).find(
    (x: any) => x.vehicleId === RIDDEN_VEHICLE_ID
  )
  return {
    nowMs: ABOARD_MS,
    ridingLeg: BUS_LEG,
    ridingTripId: PLANNED_TRIP_ID,
    vehicleMatchState: {
      consecutiveMatches: 8,
      match: {
        confidence: 'high' as const,
        distanceMeters: 30,
        label: v.label,
        lastSeen: ABOARD_MS,
        tripHeadsign: v.tripHeadsign,
        tripId: v.tripId,
        vehicleId: v.vehicleId
      }
    },
    vehicleRecord: findVehicleById(
      vehiclesAt(ABOARD_MS),
      RIDDEN_VEHICLE_ID,
      ABOARD_MS
    )
  }
}

describe('util > go-mode > the 8/28 early-board swap', () => {
  // Provenance. Everything below is meaningless if the fixture stops carrying
  // the defect's own input — a silently-passing gate is worse than none.
  it('the recorded feed really does run this bus ahead of the plan (8/28)', () => {
    expect(PLANNED_TRIP_ID).toBe('1:1273995')
    expect(BOARD_STOP_ID).toBe('1:56831')

    const live = liveBoardEpochAt(ABOARD_MS) as number
    expect(live).not.toBeNull()
    // 319 s at the moment of boarding: the feed briefly predicted this bus 35 s
    // earlier still (realtimeArrival 60265 against a 60300 timetable) than the
    // schedule, which already sat 284 s ahead of the itinerary's own figure.
    // Both are far past the 120 s that arms the early-board proof.
    expect((PLANNED_BOARD_MS - live) / 1000).toBeCloseTo(319, 0)
    expect(PLANNED_BOARD_MS - live).toBeGreaterThan(120000)

    // And the rider really is on the trip the itinerary named, on a bus whose
    // headsign matches the leg — every "is this someone else's bus" gate is
    // satisfied. Nothing about this boarding is wrong.
    const v = vehiclesAt(ABOARD_MS).find(
      (x: any) => x.vehicleId === RIDDEN_VEHICLE_ID
    )
    expect(v.tripId).toBe(PLANNED_TRIP_ID)
    expect(v.tripHeadsign).toBe(BUS_LEG.headsign)
  })

  it('the aboard moment sits in the window the defect lived in', () => {
    // After the bus actually left, and still >2 min before the plan says it
    // boards. On the unfixed code this is exactly where the replan fired.
    expect(ABOARD_MS).toBeGreaterThanOrEqual(
      liveBoardEpochAt(ABOARD_MS) as number
    )
    expect(PLANNED_BOARD_MS - ABOARD_MS).toBeGreaterThan(120000)
  })

  it('does not swap the itinerary out from under a rider on the planned bus', () => {
    expect(
      shouldReplanBoardedEarlier({
        ...ridingOnThePlannedBus(),
        liveBoardEpochMs: liveBoardEpochAt(ABOARD_MS)
      })
    ).toBe(false)
  })

  it('stays quiet on the planned trip even with the plan-only clock', () => {
    // The planned-trip short-circuit and the live board time are independent
    // fixes; either alone closes this ride. Without the live epoch the clock
    // still reads 4m44s early, and the answer must not change.
    expect(shouldReplanBoardedEarlier(ridingOnThePlannedBus())).toBe(false)
  })

  it('the live board time is what disarms the clock on any other trip', () => {
    // Take the same recorded moment but let the riding fact name a different
    // trip, so the short-circuit is out of the way and only the clock is left.
    const onSomeOtherTrip = {
      ...ridingOnThePlannedBus(),
      ridingTripId: '1:trip-earlier-run',
      vehicleMatchState: null,
      vehicleRecord: null
    }
    expect(
      shouldReplanBoardedEarlier({
        ...onSomeOtherTrip,
        liveBoardEpochMs: liveBoardEpochAt(ABOARD_MS)
      })
    ).toBe(false)
    // This is the assertion that fails on the unfixed code.
    expect(shouldReplanBoardedEarlier(onSomeOtherTrip)).toBe(true)
  })
})
