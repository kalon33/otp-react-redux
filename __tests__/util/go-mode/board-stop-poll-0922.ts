import {
  anchorBoardingStopId,
  boardingStopToPoll
} from '../../../lib/util/go-mode/departure-anchor'
import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import {
  demoteSpentBoardPoint,
  publishedBoardSource,
  realtimeBoardIsSpent,
  resolveBoardDeparture,
  tripQueryBoardPoint
} from '../../../lib/util/go-mode/board-departure'
import {
  findVehicleForTrip,
  RIDER_AT_BOARD_STOP_M,
  tripStopIdsInOrder,
  vehiclePassedStopOnTrip
} from '../../../lib/util/go-mode/transit-trust'
import { liveBoardEpochFor } from '../../../lib/util/go-mode/notification-service'
import {
  liveStopArrival,
  mergeLiveTimePoint
} from '../../../lib/util/go-mode/alight-optimizer'
import { waitingAtBoardingStop } from '../../../lib/util/go-mode/waiting-at-stop'
import fixture from '../../test-utils/mock-data/board-stop-poll-0922.json'
import type { LiveTimePoint } from '../../../lib/util/go-mode/alight-optimizer'

/**
 * Backlog 26.1 — the boarding stop stops being polled the instant the trip
 * steps onto the transit leg.
 *
 * Session `mucordp1-jqcrp2`, 2026-09-22, dev `2026.0921.1` (web `d3f11d03e`).
 * The fixture beside this test (`test-utils/mock-data/board-stop-poll-0922.json`)
 * is distilled by `test-utils/mock-data/board-stop-poll-0922.py` out of the
 * uncommitted 18 MB replay fixture `orange-stall-0922-0804.json` and the day
 * file `~/otp-debug-logs/debug-2026-09-22.jsonl`, window 08:18:30-08:39:00
 * America/Chicago. Only the fields these rules read are kept; no value is
 * edited.
 *
 * The recording, leg 1 (METRO Orange Line, trip `1:1346857`, boarding at
 * I-35W & 98th St Station `1:56831`):
 *
 *   08:19:05  last FIND_STOP_TIMES_FOR_STOP for 1:56831 — the trip UPDATED,
 *             realtimeDeparture 08:24:39 (scheduled 08:15:00)
 *   08:19:21  TRANSITION_LEG {legIndex: 1} — rider at the platform, no bus
 *   08:22:09  SET_LIVE_LEG_TIMES leg 1 boardEpoch 08:15:00, boardSource 'trip',
 *             boardRealtime true — and held for all 50 dispatches to 08:38:55
 *   08:39:16  next stop poll (the missed-bus replan put a BICYCLE leg back at
 *             index 0) — the trip is now SCHEDULED 08:15:00 in the stop feed
 *
 * Why 08:15:00 was "realtime": the trip query asks for ARRIVAL fields only,
 * and from 08:09:46 to the end of the ride it answered the boarding stop
 * `UPDATED, arrivalDelay 0, realtimeArrival == scheduledArrival` — the stop
 * before it SCHEDULED, the stop after it +496 s at 08:19:05 and climbing.
 * The bus (vehicle 1:8148) sat ~6 km south with `nextStopId 1:56831` for the
 * whole wait.
 *
 * The replay below drives the ride's own refresh instants (every trip-query
 * response for 1:1346857) through the same rules `refreshLiveLegTimes` runs,
 * in the same order: trip point -> resolveBoardDeparture (21.1) ->
 * realtimeBoardIsSpent (17.18) -> mergeLiveTimePoint -> publishedBoardSource.
 */

const f: any = fixture

const TRIP = '1:1346857'
const STOP = '1:56831'
const leg1: any = f.legs[1]

/** 08:15:00 — the trip query's scheduled board time, published live. */
const E_0815 = 1790082900000
/** 08:24:39 — the stop poll's last live answer, 08:19:05. */
const E_0824_39 = 1790083479000
const T_0819_05_POLL = 1790083145204
const T_0819_21_TRANSITION = 1790083161120
/** STOP_SNAPSHOT_MAX_AGE_MS after the last poll: 08:22:05.204. */
const T_0822_05 = T_0819_05_POLL + 180000
/** The missed-bus replan's START_GO_MODE — the end of the window. */
const T_0838_56 = 1790084336593

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

const latestAtOrBefore = <T extends { tMs: number }>(
  rows: T[],
  t: number
): T | null => {
  let out: T | null = null
  for (const r of rows) if (r.tMs <= t) out = r
  return out
}

/** The refresh instants: every trip-query answer for the leg's trip. */
const refreshInstants: number[] = f.tripSnapshots
  .map((s: any) => s.tMs)
  .filter((t: number) => t > T_0819_05_POLL && t < T_0838_56)

interface Rules {
  /** Pretend the vehicle feed had nothing (17.18's evidence gone). */
  blindVehicle?: boolean
  /** 17.18's demote (on main since 2026.0922.2). */
  demote: boolean
  /** Stop snapshot to use instead of the recorded latest (and its stamp). */
  stopOverride?: (t: number) => { payload: any; tMs: number } | null
  /** 26.1 second half: tripQueryBoardPoint instead of liveStopArrival. */
  tripScheduleIsNotLive: boolean
}

interface Published {
  board: LiveTimePoint | null
  demoted: boolean
  source: 'stop' | 'trip' | undefined
  t: number
}

function riderAt(t: number): any {
  return latestAtOrBefore(f.ticks, t)
}

function vehicleEvidence(t: number, trip: any) {
  // session.lastBoardVehicle: the last record the vehicle poll held for this
  // trip, carried across an empty poll for up to VEHICLE_RECORD_STALE_SEC.
  const withRecord = f.vehicles.filter((v: any) => v.vehicle)
  const last = latestAtOrBefore(withRecord, t) as any
  if (!last || t - last.tMs > 120000) return null
  const found = findVehicleForTrip([last.vehicle], TRIP, t)
  if (!found) return null
  return {
    ageSec: found.ageSec,
    distanceToBoardStopM: calculateDistance(
      found.vehicle.lat,
      found.vehicle.lon,
      leg1.from.lat,
      leg1.from.lon
    ),
    nextStopId: found.vehicle.nextStopId ?? null,
    passedBoardStop: vehiclePassedStopOnTrip(
      tripStopIdsInOrder(trip),
      STOP,
      found.vehicle.nextStopId ?? null
    )
  }
}

function replay(rules: Rules, start: Published): Published[] {
  let prev = start
  const out: Published[] = []
  for (const t of refreshInstants) {
    const trip = latestAtOrBefore(f.tripSnapshots, t) as any
    const snap = rules.stopOverride
      ? rules.stopOverride(t)
      : (latestAtOrBefore(f.stopSnapshots, t) as any)
    const stopData = snap ? { ...snap.payload, fetchedAtMs: snap.tMs } : null
    const pointFn = rules.tripScheduleIsNotLive
      ? tripQueryBoardPoint
      : liveStopArrival
    const resolution = resolveBoardDeparture({
      nowMs: t,
      stopData,
      tripId: TRIP,
      tripPoint: pointFn(trip.stopTimes, STOP, leg1.from.name, null)
    })
    const rider = riderAt(t)
    const spent =
      rules.demote &&
      !!resolution.point &&
      realtimeBoardIsSpent(resolution.point, t, {
        boardStopId: STOP,
        riderAtBoardStop:
          !!rider &&
          calculateDistance(
            rider.lat,
            rider.lon,
            leg1.from.lat,
            leg1.from.lon
          ) <= RIDER_AT_BOARD_STOP_M,
        riding: false,
        vehicle: rules.blindVehicle ? null : vehicleEvidence(t, trip)
      })
    const point =
      spent && resolution.point
        ? demoteSpentBoardPoint(resolution.point)
        : resolution.point
    const board = mergeLiveTimePoint(prev.board, point, t)
    const next: Published = {
      board,
      demoted: spent,
      source: publishedBoardSource(board, resolution, prev.source),
      t
    }
    out.push(next)
    prev = next
  }
  return out
}

/** What SET_LIVE_LEG_TIMES held at 08:19:05, the last good dispatch. */
const START: Published = {
  board: { epoch: E_0824_39, isFloor: false, realtime: true },
  demoted: false,
  source: 'stop',
  t: T_0819_05_POLL
}

const after = (rows: Published[], t: number) => rows.filter((r) => r.t > t)
const revertedTo0815 = (r: Published) => r.board?.epoch === E_0815

describe('26.1 — the recording, reproduced', () => {
  it('the window has the ride’s own refresh cadence', () => {
    expect(refreshInstants.length).toBe(58)
    expect(hhmmss(refreshInstants[0])).toBe('08:19:25')
    expect(hhmmss(refreshInstants[refreshInstants.length - 1])).toBe('08:38:55')
    // No stop poll between 08:19:05 and 08:39:16: the distilled window holds
    // exactly the polls either side of the gap.
    const polls = f.stopSnapshots.map((s: any) => hhmmss(s.tMs))
    expect(polls).toContain('08:19:05')
    expect(polls).toContain('08:39:16')
    expect(
      f.stopSnapshots.filter(
        (s: any) => s.tMs > T_0819_05_POLL && s.tMs < T_0838_56
      ).length
    ).toBe(0)
  })

  it('the trip query published the SCHEDULE under an UPDATED flag', () => {
    for (const s of f.tripSnapshots.filter((x: any) => x.tMs > 1790082586000)) {
      const st = s.stopTimes.find((x: any) => x.stop.id === STOP)
      expect(st.realtimeState).toBe('UPDATED')
      expect(st.arrivalDelay).toBe(0)
      expect(st.realtimeArrival).toBe(st.scheduledArrival)
      expect((st.serviceDay + st.realtimeArrival) * 1000).toBe(E_0815)
    }
  })

  it('AS SHIPPED on 2026.0921.1: 08:15:00 "live" from 08:22:09', () => {
    const rows = replay({ demote: false, tripScheduleIsNotLive: false }, START)
    const first = rows.find(revertedTo0815)!
    expect(hhmmss(first.t)).toBe('08:22:09')
    expect(first.t).toBeGreaterThan(T_0822_05)
    expect(first.source).toBe('trip')
    expect(first.board?.realtime).toBe(true)
    // ...and every dispatch after it, exactly as recorded.
    const reverted = rows.filter(revertedTo0815)
    expect(reverted.length).toBe(50)
    expect(reverted.every((r) => r.board?.realtime)).toBe(true)
    const recorded = f.recordedLiveLegTimes.filter(
      (r: any) => r.tMs > T_0819_05_POLL && r.tMs < T_0838_56
    )
    const recordedReverts = recorded.filter(
      (r: any) => r.boardEpoch === E_0815 && r.boardRealtime
    )
    expect(recordedReverts.length).toBe(reverted.length)
    expect(hhmmss(recordedReverts[0].tMs)).toBe('08:22:09')
  })
})

describe('26.1 — the baseline on main b0a8fc811 (17.18 in force)', () => {
  const rows = replay({ demote: true, tripScheduleIsNotLive: false }, START)

  it('17.18 already stops the revert: the bus was 6 km short with nextStopId = the stop', () => {
    expect(rows.filter(revertedTo0815).length).toBe(0)
    const demoted = rows.filter((r) => r.demoted)
    expect(demoted.length).toBe(50)
    expect(hhmmss(demoted[0].t)).toBe('08:22:09')
    // So `definitive`, and every push that quotes minutes, are already safe:
    // nothing after the stale-out is realtime.
    const stale = after(rows, T_0822_05)
    expect(stale.every((r) => !r.board?.realtime)).toBe(true)
    expect(
      stale.every(
        (r) =>
          liveBoardEpochFor({
            boardEpoch: r.board?.epoch,
            boardRealtime: r.board?.realtime
          }) == null
      )
    ).toBe(true)
  })

  it('...but the rider loses the live board time for the whole wait', () => {
    const stale = after(rows, T_0822_05)
    // The last live answer is carried, no longer live, then floored.
    expect(stale.every((r) => r.board?.epoch === E_0824_39)).toBe(true)
    expect(stale.every((r) => r.source === 'stop')).toBe(true)
    const floored = stale.filter((r) => r.board?.isFloor)
    expect(hhmmss(floored[0].t)).toBe('08:24:55')
    // Floored from 08:24:55 to 08:38:55 — the "Waiting at X · time" clock is
    // gone for the last 14 minutes of the wait (a floor is not printed).
    expect(floored.length).toBe(42)
  })

  it('...and with no vehicle evidence 17.18 is inert and 08:15:00 comes back live', () => {
    const blind = replay(
      { blindVehicle: true, demote: true, tripScheduleIsNotLive: false },
      START
    )
    const reverted = blind.filter(revertedTo0815)
    expect(reverted.length).toBe(50)
    expect(reverted.every((r) => r.board?.realtime)).toBe(true)
  })
})

describe('26.1 — the fix', () => {
  // The route matcher's own ticks (UPDATE_ROUTE_MATCH + the position before
  // it), through the same waitingAtBoardingStop the tick publishes (18.6).
  const onLeg1 = f.ticks.filter(
    (k: any) =>
      k.legIndex === 1 && k.tMs >= T_0819_21_TRANSITION && k.tMs < T_0838_56
  )
  const pollFor = (k: any, gate: 'old' | 'new') => {
    const cur = f.legs[k.legIndex]
    const nxt = f.legs[k.legIndex + 1]
    if (gate === 'old') return anchorBoardingStopId(cur, nxt)
    const waiting = waitingAtBoardingStop({
      currentLegIndex: k.legIndex,
      legs: f.legs,
      progressAlongLeg: k.progressAlongLeg,
      riderPosition: [k.lat, k.lon],
      riderSpeedMps: k.speed,
      ridingLegIndex: null
    })
    return boardingStopToPoll(cur, nxt, waiting)
  }

  it('the boarding stop keeps being polled through the platform wait', () => {
    expect(onLeg1.length).toBe(1175)
    // Before: not one tick on leg 1 would poll.
    expect(onLeg1.filter((k: any) => pollFor(k, 'old')).length).toBe(0)
    // After: every one does, and it polls the right stop.
    const polled = onLeg1.filter((k: any) => pollFor(k, 'new') === STOP)
    expect(polled.length).toBe(onLeg1.length)
  })

  it('the anchor keeps its gate: no departure override is written on the transit leg', () => {
    // evaluateDepartureAnchor / retargetPlanToDeparture run only under
    // anchorBoardingStopId, which is null on every leg-1 tick.
    expect(
      onLeg1.every(
        (k: any) => anchorBoardingStopId(f.legs[1], f.legs[2]) == null
      )
    ).toBe(true)
  })

  it('the stop poll ends with the wait: aboard, or gone down the line', () => {
    const k = onLeg1[0]
    const aboard = waitingAtBoardingStop({
      currentLegIndex: 1,
      legs: f.legs,
      progressAlongLeg: k.progressAlongLeg,
      riderPosition: [k.lat, k.lon],
      riderSpeedMps: k.speed,
      ridingLegIndex: 1
    })
    expect(boardingStopToPoll(f.legs[1], f.legs[2], aboard)).toBeNull()
    const gone = waitingAtBoardingStop({
      currentLegIndex: 1,
      legs: f.legs,
      // 200 m down a 17 km leg.
      progressAlongLeg: 200 / Number(f.legs[1].distance),
      riderPosition: [k.lat, k.lon],
      riderSpeedMps: 12,
      ridingLegIndex: null
    })
    expect(boardingStopToPoll(f.legs[1], f.legs[2], gone)).toBeNull()
  })

  it('a trip-query schedule is never stamped boardRealtime (no stop poll, no vehicle)', () => {
    // The worst case the recording itself holds: the stop answer ages out and
    // the vehicle feed says nothing. 08:15:00 is handed on as the schedule it
    // is, the merge keeps the last stop answer, and nothing reverts.
    const rows = replay(
      { blindVehicle: true, demote: true, tripScheduleIsNotLive: true },
      START
    )
    expect(rows.filter(revertedTo0815).length).toBe(0)
    expect(rows.every((r) => r.source === 'stop')).toBe(true)
    expect(after(rows, T_0822_05).every((r) => !r.board?.realtime)).toBe(true)
  })

  it('on the recorded 08:39:16 answer (trip dropped to SCHEDULED) the stop cannot win and the schedule is still not live', () => {
    const poll0839 = f.stopSnapshots.find(
      (s: any) => hhmmss(s.tMs) === '08:39:16'
    )
    const t = poll0839.tMs + 1000
    const trip = latestAtOrBefore(f.tripSnapshots, t) as any
    const resolution = resolveBoardDeparture({
      nowMs: t,
      stopData: { ...poll0839.payload, fetchedAtMs: poll0839.tMs },
      tripId: TRIP,
      tripPoint: tripQueryBoardPoint(trip.stopTimes, STOP, leg1.from.name)
    })
    expect(resolution.source).toBe('trip')
    expect(resolution.point).toEqual({ epoch: E_0815, realtime: false })
    const board = mergeLiveTimePoint(START.board, resolution.point, t)
    expect(board?.epoch).toBe(E_0824_39)
    expect(board?.realtime).toBe(false)
  })

  it('with the poll running, a fresh stop answer keeps boardSource "stop" and live (mechanism)', () => {
    // NOT a measurement: nothing asked the stop between 08:19:05 and 08:39:16,
    // so what it would have said is unknown. This shows the rule the restored
    // poll feeds: an answer inside STOP_SNAPSHOT_MAX_AGE_MS wins over the trip
    // query at 08:22:09, the dispatch that reverted.
    const poll0819 = f.stopSnapshots.find(
      (s: any) => hhmmss(s.tMs) === '08:19:05'
    )
    const rows = replay(
      {
        demote: true,
        stopOverride: (t) => ({ payload: poll0819.payload, tMs: t - 20000 }),
        tripScheduleIsNotLive: true
      },
      START
    )
    const at0822 = rows.find((r) => hhmmss(r.t) === '08:22:09')!
    expect(at0822.source).toBe('stop')
    expect(at0822.board).toEqual({
      epoch: E_0824_39,
      projected: false,
      realtime: true
    })
  })

  it('leaves a genuinely delayed trip-query board time live', () => {
    // 08:04:58 on the same ride: +19 s at the board stop, a real prediction.
    const st = {
      arrivalDelay: 19,
      realtimeArrival: 29719,
      realtimeState: 'UPDATED',
      scheduledArrival: 29700,
      scheduledDeparture: 29700,
      serviceDay: 1790053200,
      stop: { id: STOP, name: leg1.from.name }
    }
    expect(tripQueryBoardPoint([st as any], STOP, leg1.from.name)).toEqual({
      epoch: (1790053200 + 29719) * 1000,
      realtime: true
    })
    // ...and passes a schedule-only row through untouched.
    expect(
      tripQueryBoardPoint(
        [{ ...st, realtimeState: 'SCHEDULED' } as any],
        STOP,
        leg1.from.name
      )
    ).toEqual({ epoch: (1790053200 + 29700) * 1000, realtime: false })
  })
})
