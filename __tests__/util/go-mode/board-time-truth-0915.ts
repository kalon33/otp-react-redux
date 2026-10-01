import {
  demoteSpentBoardPoint,
  REALTIME_BOARD_SPENT_AFTER_MS,
  realtimeBoardIsSpent,
  resolveBoardDeparture
} from '../../../lib/util/go-mode/board-departure'
import {
  liveStopArrival,
  markStaleLegTimes,
  mergeLiveTimePoint
} from '../../../lib/util/go-mode/alight-optimizer'
import fixture from '../../test-utils/mock-data/board-time-0915.json'
import type { LiveTimePoint } from '../../../lib/util/go-mode/alight-optimizer'

/**
 * Backlog 17.18 + 17.19, measured 2026-09-22 on the 2026-09-15 ride.
 *
 * The fixture beside this test (`test-utils/mock-data/board-time-0915.json`) is
 * distilled straight out of `~/otp-debug-logs/debug-2026-09-15.jsonl`, session
 * `mu346i5y-ng2uqc`, 15:34:52-15:50:09 America/Chicago — the ride the rider
 * wrote "- minute waits make no sense" on at 15:37:32. Only the payload fields
 * these rules read are kept; no value is edited. The full 10 MB replay fixture
 * is not committed; rebuild it with
 *
 *   node lib/util/go-mode/replay/build-fixture.js --session mu346i5y-ng2uqc \
 *     --label board-time-0915 --since 2026-09-15T20:24:00Z \
 *     --until 2026-09-15T20:52:00Z
 *
 * WHAT THE MEASUREMENT FOUND, and how it corrects row 17.18:
 *
 *  - 16 dispatches in that window carried a board epoch flagged
 *    `boardRealtime: true` while sitting in the past. TWELVE of them are the
 *    three values the row names (15:26:00 at 15:36:33, 15:31:00 at 15:43:28,
 *    15:33:00 at 15:44:06) and ALL TWELVE landed with the riding fact standing
 *    — SET_RIDING 15:36:27, held to CLEAR_RIDING 15:46:22, re-set 15:46:25. The
 *    rider was aboard, so no surface quotes a boarding and none of them ever
 *    reached the wait math.
 *  - the four that DID reach it are a fourth value the row never names: leg 1's
 *    15:35:00, dispatched 15:35:15.354, 15:35:35.340, 15:35:56.351 and
 *    15:36:17.509, 15-78 s past, before the rider boarded.
 *  - and on this ride 21.1 already answers all four: the stop poll held the
 *    same trip at the same stop as `UPDATED, realtimeDeparture 15:40:38`.
 *
 * So 17.18's remaining job is the case 21.1 cannot reach — no live stop-level
 * entry, or a stop snapshot past STOP_SNAPSHOT_MAX_AGE_MS — and the window it
 * covers starts where classifyMissedBus's realtime grace ends.
 */

const f: any = fixture

/** SET_RIDING 15:36:27 -> CLEAR_RIDING 15:46:22 -> SET_RIDING 15:46:25. */
const T_1535_15 = 1789504515354
const T_1536_17 = 1789504577509
const T_1536_33 = 1789504593518
/** The board epochs those instants published. */
const E_1535 = 1789504500000
const E_1526 = 1789503960000
/** What the stop poll held for the same trip at the same instant. */
const STOP_EPOCH_1540_38 = 1789504838000

function legsAt(tMs: number) {
  let cur: any = null
  for (const s of f.swaps) if (s.tMs <= tMs) cur = s
  return cur?.legs ?? null
}
function stopDataAt(stopId: string, tMs: number) {
  let cur: any = null
  for (const p of f.stopPolls) if (p.stopId === stopId && p.tMs <= tMs) cur = p
  return cur ? { ...cur, fetchedAtMs: cur.tMs } : null
}
function tripQueryAt(tripId: string, tMs: number) {
  let cur: any = null
  for (const q of f.tripQueries) {
    if (q.tripId === tripId && q.tMs <= tMs) cur = q
  }
  return cur
}
/** The trip query's own answer for a leg's boarding stop at one instant. */
function tripPointAt(tMs: number, legIndex: number): LiveTimePoint | null {
  const leg = legsAt(tMs)?.[legIndex]
  const q = leg && tripQueryAt(leg.tripId, tMs)
  return q
    ? liveStopArrival(q.stopTimes, leg.fromStopId, leg.fromName, null)
    : null
}
/** Every recorded board-leg entry whose realtime epoch was already past. */
function pastRealtimeEntries(ridingWanted: boolean) {
  const out: Array<{ epoch: number; legIndex: number; tMs: number }> = []
  for (const e of f.boardStream) {
    if (e.boardLegIndex == null || !!e.riding !== ridingWanted) continue
    const v = e.legs[String(e.boardLegIndex)]
    if (!v) continue
    if (!(v.boardRealtime ?? v.realtime)) continue
    if (v.boardEpoch == null || v.boardEpoch >= e.tMs) continue
    out.push({ epoch: v.boardEpoch, legIndex: e.boardLegIndex, tMs: e.tMs })
  }
  return out
}
/** The evidence shape for a bus that has not reached the boarding stop. */
function busShortOfStop(nextStopId: string | null, metres: number) {
  return {
    ageSec: null,
    distanceToBoardStopM: metres,
    nextStopId,
    passedBoardStop: false
  }
}

describe('17.18 — a spent realtime board time is not a wait basis', () => {
  it('the recorded stream: 16 past realtime board epochs, 12 behind the riding fact', () => {
    const reaching = pastRealtimeEntries(false)
    const aboard = pastRealtimeEntries(true)
    expect(reaching).toHaveLength(4)
    expect(aboard).toHaveLength(12)
    // The four that reached the wait math are leg 1's 15:35:00, all of them.
    expect(reaching.every((e) => e.legIndex === 1 && e.epoch === E_1535)).toBe(
      true
    )
    expect(reaching[0].tMs).toBe(T_1535_15)
    expect(reaching[3].tMs).toBe(T_1536_17)
    // The twelve the row names are leg 0's, and the row's own rule exempts
    // them: aboard, there is no boarding left to quote.
    expect(aboard.every((e) => e.legIndex === 0)).toBe(true)
    expect(aboard[0]).toEqual({ epoch: E_1526, legIndex: 0, tMs: T_1536_33 })
  })

  it('21.1 already closes all four on this ride — the stop poll had 15:40:38', () => {
    for (const e of pastRealtimeEntries(false)) {
      const leg = legsAt(e.tMs)[e.legIndex]
      const res = resolveBoardDeparture({
        nowMs: e.tMs,
        stopData: stopDataAt(leg.fromStopId, e.tMs),
        tripId: leg.tripId,
        tripPoint: tripPointAt(e.tMs, e.legIndex)
      })
      expect(res.source).toBe('stop')
      // A future departure, not a past one: nothing left for 17.18 to catch.
      expect(res.point!.epoch).toBeGreaterThan(e.tMs)
    }
    // The first instant, in full: the trip query published the SCHEDULE under
    // an UPDATED flag while the stop poll held the +5m38s prediction.
    expect(tripPointAt(T_1535_15, 1)).toEqual({ epoch: E_1535, realtime: true })
    expect(
      resolveBoardDeparture({
        nowMs: T_1535_15,
        stopData: stopDataAt('1:56831', T_1535_15),
        tripId: '1:1346556',
        tripPoint: tripPointAt(T_1535_15, 1)
      }).point!.epoch
    ).toBe(STOP_EPOCH_1540_38)
  })

  it('with the stop poll blind it stays inert inside the missed-bus grace', () => {
    // Every leg the tick is not currently re-polling has a stop snapshot older
    // than STOP_SNAPSHOT_MAX_AGE_MS, and 21.1 is inert there. On this ride that
    // returns all four — but each is only 15-78 s past while the bus was 8-70 s
    // from the kerb, inside REALTIME_BOARD_SPENT_AFTER_MS. A boarding about to
    // happen is not a spent one.
    for (const e of pastRealtimeEntries(false)) {
      const leg = legsAt(e.tMs)[e.legIndex]
      const point = resolveBoardDeparture({
        nowMs: e.tMs,
        stopData: null,
        tripId: leg.tripId,
        tripPoint: tripPointAt(e.tMs, e.legIndex)
      }).point!
      expect(point.epoch).toBe(E_1535)
      expect(e.tMs - point.epoch).toBeLessThan(REALTIME_BOARD_SPENT_AFTER_MS)
      expect(
        realtimeBoardIsSpent(point, e.tMs, {
          boardStopId: leg.fromStopId,
          riderAtBoardStop: true,
          riding: false,
          vehicle: busShortOfStop(leg.fromStopId, 900)
        })
      ).toBe(false)
    }
  })

  it('the row’s own twelve, with the riding fact removed: 12 -> 0', () => {
    // 25.1's 09-21 Lake St shape — a realtime board ten minutes past while the
    // trip's own bus runs kilometres short of the boarding stop. This is the
    // window the guard exists for: past the missed-bus grace, where
    // classifyMissedBus would call the bus gone and 25.1's vehicle guard stops
    // it, and nothing until now said the epoch itself was worthless.
    let before = 0
    let after = 0
    for (const e of pastRealtimeEntries(true)) {
      const leg = legsAt(e.tMs)[e.legIndex]
      const point = resolveBoardDeparture({
        nowMs: e.tMs,
        stopData: null,
        tripId: leg.tripId,
        tripPoint: tripPointAt(e.tMs, e.legIndex)
      }).point!
      expect(point.realtime).toBe(true)
      expect(point.epoch).toBeLessThan(e.tMs)
      before++
      const evidence = {
        boardStopId: leg.fromStopId,
        riderAtBoardStop: true,
        riding: false,
        vehicle: busShortOfStop('1:53301', 2500)
      }
      expect(realtimeBoardIsSpent(point, e.tMs, evidence)).toBe(true)
      const out = demoteSpentBoardPoint(point)
      if (out.realtime) after++
      // Demoted, not deleted: the epoch survives as a bound, which is 17.6's
      // vocabulary and what every wait-quoting surface already refuses.
      expect(out).toEqual({
        epoch: point.epoch,
        isFloor: true,
        projected: false,
        realtime: false
      })
    }
    expect(before).toBe(12)
    expect(after).toBe(0)
  })

  it('the riding fact, and only positive vehicle evidence, hold it off', () => {
    const point: LiveTimePoint = { epoch: E_1526, realtime: true }
    const now = T_1536_33
    const base = {
      boardStopId: '1:56831',
      riderAtBoardStop: true,
      riding: false,
      vehicle: busShortOfStop('1:53301', 2500)
    }
    expect(realtimeBoardIsSpent(point, now, base)).toBe(true)
    // Aboard: nothing to wait for.
    expect(realtimeBoardIsSpent(point, now, { ...base, riding: true })).toBe(
      false
    )
    // No vehicle record is not a "no" — an absent record leaves the epoch alone.
    expect(realtimeBoardIsSpent(point, now, { ...base, vehicle: null })).toBe(
      false
    )
    // A stale record is no evidence either.
    expect(
      realtimeBoardIsSpent(point, now, {
        ...base,
        vehicle: { ...base.vehicle, ageSec: 400 }
      })
    ).toBe(false)
    // The bus really did pass the stop: the feed was right, keep the epoch (and
    // let classifyMissedBus call the miss definitively).
    expect(
      realtimeBoardIsSpent(point, now, {
        ...base,
        vehicle: { ...base.vehicle, passedBoardStop: true }
      })
    ).toBe(false)
    // A non-realtime point is none of this rule's business.
    expect(
      realtimeBoardIsSpent({ epoch: E_1526, realtime: false }, now, base)
    ).toBe(false)
    // Still in the future: a late bus, not a spent one.
    expect(
      realtimeBoardIsSpent({ epoch: now + 60000, realtime: true }, now, base)
    ).toBe(false)
  })
})

describe('17.19 — the floor is derived, not latched', () => {
  /**
   * The recorded cadence: a refresh poll every 20 s that rebuilds the entry
   * from a non-live epoch already in the past, and a 1 Hz stale-marking tick in
   * between. 725 s of it, the span the day file shows the latch flapping over
   * (15:37:39 -> 15:49:44).
   */
  function run() {
    const t0 = 1789504659000 // 15:37:39.000
    const staleBoard = 1789504677000 - 12 * 60000
    let record: any = null
    let relatches = 0
    let nowValued = 0
    let epochsSeen = new Set<number>()
    let prevFloor = false
    for (let s = 0; s <= 725; s++) {
      const now = t0 + s * 1000
      if (s % 20 === 0) {
        const merged = mergeLiveTimePoint(
          record
            ? {
                epoch: record.boardEpoch,
                isFloor: record.boardIsFloor,
                realtime: record.boardRealtime
              }
            : null,
          { epoch: staleBoard, realtime: false },
          now
        )
        record = {
          alightEpoch: null,
          boardEpoch: merged?.epoch ?? null,
          boardIsFloor: !!merged?.isFloor,
          boardRealtime: !!merged?.realtime,
          realtime: false
        }
      }
      const out = markStaleLegTimes({ 0: record }, now)
      if (out) record = out[0]
      const floored = !!record.boardIsFloor
      // A "re-latch" is the flag coming back after having been dropped — the
      // 15:38:00 … 15:49:00 flap the day file shows eleven times.
      if (floored && !prevFloor && s > 0) relatches++
      prevFloor = floored
      if (record.boardEpoch != null) {
        epochsSeen.add(record.boardEpoch)
        if (Math.abs(record.boardEpoch - now) <= 2000) nowValued++
      }
    }
    return { epochsSeen, nowValued, record, relatches }
  }

  it('725 s of the 09-15 cadence: 0 re-latches, 0 now-valued epochs, 1 epoch', () => {
    const { epochsSeen, nowValued, relatches } = run()
    // Before this change the same loop measured 12 re-latches and 123 epochs
    // equal to the current millisecond (the day file's own counts, at dispatch
    // granularity: 11 `boardClamped` flips and ~30 now-valued dispatches).
    expect(relatches).toBe(0)
    expect(nowValued).toBe(0)
    // One epoch for the whole run — the value the feed and the plan actually
    // put there, never re-valued to the clock.
    expect(epochsSeen.size).toBe(1)
  })

  it('the flag is set once and stays; the epoch never moves', () => {
    const { record } = run()
    expect(record.boardIsFloor).toBe(true)
    expect(record.boardEpoch).toBe(1789504677000 - 12 * 60000)
    expect('boardClamped' in record).toBe(false)
  })

  it('mergeLiveTimePoint keeps the kept epoch instead of raising it to now', () => {
    const now = 1789504659000
    const stale = now - 8 * 60000
    const merged = mergeLiveTimePoint(
      { epoch: stale, realtime: false },
      { epoch: stale, realtime: false },
      now
    )
    expect(merged).toEqual({
      epoch: stale,
      isFloor: true,
      projected: undefined,
      realtime: false
    })
    // Live data still wins outright, and a fresh projection still supersedes.
    expect(
      mergeLiveTimePoint({ epoch: stale, realtime: false }, null, now)!.epoch
    ).toBe(stale)
    expect(
      mergeLiveTimePoint(
        { epoch: stale, realtime: false },
        { epoch: now + 120000, realtime: true },
        now
      )
    ).toEqual({ epoch: now + 120000, realtime: true })
  })

  it('markStaleLegTimes marks and does not move, and reports no change twice', () => {
    const now = 1789504659000
    const times = {
      0: {
        alightEpoch: now - 300000,
        boardEpoch: now - 600000,
        realtime: false
      }
    }
    const out = markStaleLegTimes(times, now)!
    expect(out[0]).toEqual({
      alightEpoch: now - 300000,
      alightIsFloor: true,
      boardEpoch: now - 600000,
      boardIsFloor: true,
      realtime: false
    })
    // Nothing left to say on the next tick: no dispatch.
    expect(markStaleLegTimes(out, now + 1000)).toBeNull()
    // A value still inside the displayed minute is not stale.
    expect(
      markStaleLegTimes(
        { 0: { alightEpoch: null, boardEpoch: now - 1000, realtime: false } },
        now
      )
    ).toBeNull()
    // A live field is never touched.
    expect(
      markStaleLegTimes(
        {
          0: {
            alightEpoch: now - 600000,
            alightRealtime: true,
            boardEpoch: now - 600000,
            boardRealtime: true,
            realtime: true
          }
        },
        now
      )
    ).toBeNull()
  })
})
