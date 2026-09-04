import { accessSecondsToBoardStop } from '../../../lib/util/go-mode/progress-calculator'
import {
  BOARD_REACH_MARGIN_SECONDS,
  checkBoardVehicleApproach,
  getEffectiveBoardTimeMs,
  overrideNamesAnotherRun,
  SAME_RUN_TOLERANCE_MS
} from '../../../lib/util/go-mode/notification-service'

/**
 * The 2026-09-04 kerb ride (session `mtn4ui3s-xfjx8m`, fixture
 * `params-drop-1052.json`). The rider planned BICYCLE -> 537 -> BICYCLE to
 * Southdale, then stood at the origin for the whole trip: 6.5 m of movement
 * in 30 minutes, `currentLegProgress` stuck at 0.09 %.
 *
 * At 11:00:24 they picked the 12:13 departure of the same route
 * (`SET_DEPARTURE_OVERRIDE 1788541980000`). Two boarding alerts fired anyway,
 * for the 11:15:30 run the itinerary still carried:
 *
 *   11:10:52  ADD_NOTIFICATION BOARD_BUS_APPROACHING_1:57525_1:1136242
 *   11:15:29  ADD_NOTIFICATION BOARD_BUS_ARRIVING_1:57525_1:1136242
 *
 * Rider, 11:13:15: "Pointless notification about a bus stop I'm not at yet
 * and a bus before the one on the plan."
 *
 * Both are real records of a real bus — vehicle `1:SL-60145` on trip
 * `1:1136242`, 1,767 m from the stop at 11:10:40 and at the stop by 11:15:28.
 * The alerts were wrong for two independent reasons, and each gate here is
 * enough on its own.
 */

const PLANNED_BOARD_MS = 1788538530000 // 11:15:30
const OVERRIDE_MS = 1788541980000 // 12:13:00 — the run the rider picked
const APPROACH_MS = 1788538252076 // 11:10:52.076, the first alert
const ARRIVING_MS = 1788538529063 // 11:15:29.063, the second

// The itinerary as START_GO_MODE recorded it at 10:52:51.
const legs: any[] = [
  {
    distance: 4447.27,
    duration: 1082,
    endTime: PLANNED_BOARD_MS,
    mode: 'BICYCLE',
    startTime: 1788537448000
  },
  {
    distance: 3730.16,
    duration: 352,
    endTime: 1788538882000,
    from: {
      lat: 44.8695,
      lon: -93.3288,
      name: 'France Ave S & 90th St W',
      stop: { gtfsId: '1:57525' }
    },
    mode: 'BUS',
    routeShortName: '537',
    startTime: PLANNED_BOARD_MS,
    to: {
      lat: 44.8992,
      lon: -93.3289,
      name: 'France Ave S & 70th St W',
      stop: { gtfsId: '1:57523' }
    },
    transitLeg: true,
    trip: { gtfsId: '1:1136242' }
  },
  { distance: 2621.38, duration: 691, mode: 'BICYCLE' }
]
const boardLeg = legs[1]

// currentLegProgress at both alerts, to the digit UPDATE_PROGRESS carried.
const LEG_PROGRESS_PCT = 0.09187082206684626

// The rider never moved, so rider-speed.ts answered null all ride: the plan's
// own pace (4447.27 m / 1082 s = 4.11 m/s) is what Gate B measures against.
const secondsToBoardStop = accessSecondsToBoardStop(
  legs,
  0,
  LEG_PROGRESS_PCT,
  null
)

describe('2026-09-04 kerb ride — boarding alerts for a declined, unreachable run', () => {
  it('measures the ground ahead at the plan pace: ~18 min, not "a few"', () => {
    // 4,443 m still in front of them on leg 0 at 4.11 m/s.
    expect(secondsToBoardStop).toBeGreaterThan(1000)
    expect(secondsToBoardStop).toBeLessThan(1150)
  })

  it('11:10:52 — says nothing about a run the rider stood down from', () => {
    const event = checkBoardVehicleApproach(
      boardLeg,
      {
        departureOverrideMs: OVERRIDE_MS,
        // liveLegTimes had boardEpoch 11:14:52, boardRealtime true.
        liveBoardEpochMs: 1788538492000,
        nowMs: APPROACH_MS,
        secondsToBoardStop,
        vehicle: {
          ageSec: 63,
          distanceToBoardStopM: 1767,
          nextStopId: '1:2069'
        }
      },
      []
    )
    expect(event).toBeNull()
  })

  it('11:15:29 — nor when that run is pulling into the stop', () => {
    const event = checkBoardVehicleApproach(
      boardLeg,
      {
        departureOverrideMs: OVERRIDE_MS,
        liveBoardEpochMs: 1788538480000,
        nowMs: ARRIVING_MS,
        secondsToBoardStop,
        // The vehicle's own next stop IS the boarding stop — the strongest
        // "your bus is here" evidence the app has, and still not their bus.
        vehicle: {
          ageSec: 40,
          distanceToBoardStopM: 290,
          nextStopId: '1:57525'
        }
      },
      []
    )
    expect(event).toBeNull()
  })

  it('Gate B alone silences it — no override, still 18 minutes away', () => {
    const event = checkBoardVehicleApproach(
      boardLeg,
      {
        departureOverrideMs: null,
        liveBoardEpochMs: 1788538480000,
        nowMs: ARRIVING_MS,
        secondsToBoardStop,
        vehicle: {
          ageSec: 40,
          distanceToBoardStopM: 290,
          nextStopId: '1:57525'
        }
      },
      []
    )
    expect(event).toBeNull()
  })

  it('Gate A alone silences it — at the stop, but on the wrong run', () => {
    const event = checkBoardVehicleApproach(
      boardLeg,
      {
        departureOverrideMs: OVERRIDE_MS,
        liveBoardEpochMs: 1788538480000,
        nowMs: ARRIVING_MS,
        // Standing at the stop: nothing left to cover.
        secondsToBoardStop: 0,
        vehicle: {
          ageSec: 40,
          distanceToBoardStopM: 290,
          nextStopId: '1:57525'
        }
      },
      []
    )
    expect(event).toBeNull()
  })

  it('still shouts for a rider who can actually make it', () => {
    // 150 m from the stop on foot, no departure pick, the bus two stops out
    // and inside the approach window: this is the 2026-08-27 ask, unchanged.
    const event = checkBoardVehicleApproach(
      boardLeg,
      {
        departureOverrideMs: null,
        liveBoardEpochMs: ARRIVING_MS + 180000,
        nowMs: ARRIVING_MS,
        secondsToBoardStop: 150 / 1.35,
        vehicle: {
          ageSec: 12,
          distanceToBoardStopM: 900,
          nextStopId: '1:57599'
        }
      },
      []
    )
    expect(event).not.toBeNull()
    expect(event!.type).toBe('BOARD_BUS_APPROACHING')
    // Copy unchanged: only the numbers the rider acts on.
    expect(event!.message).toBe(
      '537 is a few minutes from France Ave S & 90th St W'
    )
  })

  it('a bus running late on the SAME run is still their bus', () => {
    // The auto-anchor writes the planned run's own live time into the
    // override when it slips; that is one bus, re-timed, not a new one.
    const lateSameRun = PLANNED_BOARD_MS + 6 * 60 * 1000
    expect(overrideNamesAnotherRun(PLANNED_BOARD_MS, lateSameRun)).toBe(false)
    const event = checkBoardVehicleApproach(
      boardLeg,
      {
        departureOverrideMs: lateSameRun,
        liveBoardEpochMs: lateSameRun,
        nowMs: lateSameRun - 120000,
        secondsToBoardStop: 60,
        vehicle: { ageSec: 8, distanceToBoardStopM: 800, nextStopId: null }
      },
      []
    )
    expect(event).not.toBeNull()
  })

  it('leaves both gates open when the caller has nothing to measure', () => {
    // Callers that pass neither field behave exactly as they did before.
    const event = checkBoardVehicleApproach(
      boardLeg,
      {
        liveBoardEpochMs: null,
        nowMs: APPROACH_MS,
        vehicle: { ageSec: 10, distanceToBoardStopM: 1200, nextStopId: null }
      },
      []
    )
    expect(event).not.toBeNull()
  })

  it('margins the reachability test rather than shaving it', () => {
    // A boarding the rider is a minute and a half short of still fires: the
    // bus may be late, they may sprint. Two minutes is the allowance.
    const nearly = checkBoardVehicleApproach(
      boardLeg,
      {
        liveBoardEpochMs: ARRIVING_MS + 60000,
        nowMs: ARRIVING_MS,
        secondsToBoardStop: 60 + BOARD_REACH_MARGIN_SECONDS - 30,
        vehicle: { ageSec: 8, distanceToBoardStopM: 900, nextStopId: null }
      },
      []
    )
    expect(nearly).not.toBeNull()
  })
})

describe('getEffectiveBoardTimeMs — which departure this leg boards', () => {
  const liveTime = (over: any) => ({
    boardEpoch: PLANNED_BOARD_MS,
    boardRealtime: false,
    realtime: false,
    ...over
  })

  it('reads the BOARD field flag, not the leg-level OR', () => {
    // 2026-09-04: the boarding's alight was live and its board was a schedule
    // time clamped forward to `now` once a second, so the leg-level
    // `realtime: true` made a fabricated "now" the effective departure.
    // classifyMissedBus could not conclude the bus had gone until 11:22:41,
    // off a board time of 11:20:00 that no feed ever published.
    const clampedToNow = liveTime({
      boardEpoch: 1788538650000, // 11:17:30, i.e. `now` on that tick
      boardRealtime: false,
      realtime: true // the OR of a live alight and a schedule board
    })
    expect(getEffectiveBoardTimeMs(boardLeg, clampedToNow, null)).toEqual({
      ms: PLANNED_BOARD_MS,
      realtime: false
    })
  })

  it('a live prediction for the same run still outranks the override', () => {
    const late = liveTime({
      boardEpoch: PLANNED_BOARD_MS + 240000,
      boardRealtime: true,
      realtime: true
    })
    expect(
      getEffectiveBoardTimeMs(boardLeg, late, PLANNED_BOARD_MS + 120000)
    ).toEqual({ ms: PLANNED_BOARD_MS + 240000, realtime: true })
  })

  it('an override naming a DIFFERENT run does not move this boarding', () => {
    // The planned run departs at 11:15:30 whatever the rider has picked for
    // 12:13. Answering 12:13 here is what left a trip that could no longer
    // be flown looking flyable for another hour.
    expect(getEffectiveBoardTimeMs(boardLeg, undefined, OVERRIDE_MS)).toEqual({
      ms: PLANNED_BOARD_MS,
      realtime: false
    })
    expect(overrideNamesAnotherRun(PLANNED_BOARD_MS, OVERRIDE_MS)).toBe(true)
  })

  it('an override inside the same-run window still stands in for the plan', () => {
    const sameRun = PLANNED_BOARD_MS + SAME_RUN_TOLERANCE_MS - 60000
    expect(getEffectiveBoardTimeMs(boardLeg, undefined, sameRun)).toEqual({
      ms: sameRun,
      realtime: false
    })
  })
})

describe('accessSecondsToBoardStop', () => {
  it('stops at the boarding, not at the destination', () => {
    // Leg 2 (2,621 m of bike after the bus) must not be counted.
    const wholeLeg = accessSecondsToBoardStop(legs, 0, 0, null)!
    expect(wholeLeg).toBeCloseTo(1082, 0)
  })

  it('prefers the pace the rider is actually keeping on a bike leg', () => {
    const observed = accessSecondsToBoardStop(legs, 0, 0, 7.7)!
    expect(observed).toBeCloseTo(4447.27 / 7.7, 0)
  })

  it('discounts the current leg by how far along it they are', () => {
    expect(accessSecondsToBoardStop(legs, 0, 50, null)!).toBeCloseTo(541, 0)
  })

  it('answers null when there is no access leg left to measure', () => {
    expect(accessSecondsToBoardStop(legs, 1, 0, null)).toBeNull()
    expect(accessSecondsToBoardStop([], 0, 0, null)).toBeNull()
    expect(accessSecondsToBoardStop(undefined, 0, 0, null)).toBeNull()
  })
})
