import fs from 'fs'
import path from 'path'

import {
  acceptAutoReplan,
  accessBoardOverrunMs,
  liveBoardForCandidate
} from '../../../lib/util/go-mode/replan-acceptance'
import { spliceAccessOntoItinerary } from '../../../lib/util/go-mode/access-splice'

/**
 * 2026-09-23, backlog 29.1 — `access-misses-board` measured the candidate's
 * access leg against the bus leg's `startTime`, the prediction frozen when the
 * plan was fetched (15:53:42 = timetable 15:45:00 + 522 s), while the card and
 * `DEPARTURE_CHANGED` showed the live board time. Two feasible re-plans were
 * refused by 18 s and 32 s against 15 s of slack:
 *
 *   15:49:33  bike 1070 m ending 15:54:00; live board 15:57:22 (15:49:12/33)
 *   15:50:08  bike  900 m ending 15:54:14; live board 15:58:03 (15:49:53)
 *
 * Both SET_LIVE_LEG_TIMES records were `boardRealtime: true, boardIsFloor:
 * false, boardSource: 'stop'` (debug-2026-09-23.jsonl, `muek9u3n-n8e67r`).
 * The 15:55:44 refusal must stand: its candidate ends 15:56:09, and the live
 * record it saw (15:54:12) had just gone `boardRealtime: false, boardIsFloor:
 * true`, so there is no live yardstick and the bus had gone.
 */

const TRIP = '1:1346795'
const STOP = '1:56831'
const BOARD_PLANNED = 1790196822000 // 15:53:42, the frozen plan-time prediction
const ALIGHT = 1790197439000 // 16:03:59
const LIVE_1549 = 1790197042000 // 15:57:22
const LIVE_1550 = 1790197083000 // 15:58:03
const END_1549 = 1790196840000 // 15:54:00
const END_1550 = 1790196854000 // 15:54:14

const busLeg = {
  endTime: ALIGHT,
  from: { lat: 44.8259, lon: -93.2908, name: 'Stop', stopId: STOP },
  mode: 'BUS',
  startTime: BOARD_PLANNED,
  transitLeg: true,
  tripId: TRIP
} as any

const bike = (startTime: number, endTime: number, lon = -93.2984) =>
  ({
    endTime,
    from: { lat: 44.8227, lon, name: 'Current location' },
    mode: 'BICYCLE',
    startTime,
    to: { lat: 44.8259, lon: -93.2908 },
    transitLeg: false
  } as any)

const plan = (access: any) =>
  ({
    endTime: ALIGHT,
    legs: [access, busLeg],
    startTime: access.startTime
  } as any)

/** The plan in hand after the 15:48:47 splice: bike ending 15:53:18. */
const held = plan(bike(1790196527000, 1790196798000, -93.3012))
const cand1549 = plan(bike(1790196573000, END_1549))
const cand1550 = plan(bike(1790196608000, END_1550, -93.2963))

const live = (boardEpoch: number, extra: any = {}) => ({
  1: {
    alightEpoch: null,
    boardEpoch,
    boardIsFloor: false,
    boardRealtime: true,
    boardSource: 'stop' as const,
    realtime: true,
    ...extra
  }
})

const verdict = (candidate: any, liveLegTimes: any) => {
  const lb = liveBoardForCandidate(candidate, held, liveLegTimes)
  return acceptAutoReplan(candidate, held, {
    liveBoardEpochMs: lb?.epochMs ?? null,
    liveBoardTripId: lb?.tripId ?? null
  })
}

describe('29.1: the access gate measures against the live board time', () => {
  it('measured the two refusals at 18 s and 32 s against the frozen startTime', () => {
    expect(accessBoardOverrunMs(cand1549)).toBe(18000)
    expect(accessBoardOverrunMs(cand1550)).toBe(32000)
    expect(verdict(cand1549, {})).toEqual({
      accept: false,
      reason: 'access-misses-board'
    })
    expect(verdict(cand1550, {})).toEqual({
      accept: false,
      reason: 'access-misses-board'
    })
  })

  it('accepts both with the live board the card was showing', () => {
    expect(
      accessBoardOverrunMs(cand1549, { epochMs: LIVE_1549, tripId: TRIP })
    ).toBe(-202000) // 3m22s early
    expect(
      accessBoardOverrunMs(cand1550, { epochMs: LIVE_1550, tripId: TRIP })
    ).toBe(-229000) // 3m49s early
    expect(verdict(cand1549, live(LIVE_1549))).toEqual({ accept: true })
    expect(verdict(cand1550, live(LIVE_1550))).toEqual({ accept: true })
  })

  it('ignores a board time that is not live, or is a floor', () => {
    expect(
      verdict(cand1549, live(LIVE_1549, { boardRealtime: false }))
    ).toEqual({ accept: false, reason: 'access-misses-board' })
    expect(verdict(cand1549, live(LIVE_1549, { boardIsFloor: true }))).toEqual({
      accept: false,
      reason: 'access-misses-board'
    })
    expect(
      liveBoardForCandidate(
        cand1549,
        held,
        live(LIVE_1549, { boardEpoch: null })
      )
    ).toBeNull()
  })

  it('applies the live time only to the same run from the same stop', () => {
    const otherTrip = plan(bike(1790196573000, END_1549))
    otherTrip.legs[1] = { ...busLeg, tripId: '1:1346760' }
    expect(liveBoardForCandidate(otherTrip, held, live(LIVE_1549))).toBeNull()
    const otherStop = plan(bike(1790196573000, END_1549))
    otherStop.legs[1] = {
      ...busLeg,
      from: { ...busLeg.from, stopId: '1:99999' }
    }
    expect(liveBoardForCandidate(otherStop, held, live(LIVE_1549))).toBeNull()
    // A context whose trip does not match the itinerary is not applied.
    expect(
      accessBoardOverrunMs(cand1549, { epochMs: LIVE_1549, tripId: '1:x' })
    ).toBe(18000)
  })

  it('finds the held leg by trip when the candidate board leg sits at another index', () => {
    const walkBikeWalk = {
      endTime: ALIGHT,
      legs: [
        { ...bike(1790196573000, 1790196600000), mode: 'WALK' },
        bike(1790196600000, 1790196820000),
        { ...bike(1790196820000, END_1549), mode: 'WALK' },
        busLeg
      ],
      startTime: 1790196573000
    } as any
    expect(liveBoardForCandidate(walkBikeWalk, held, live(LIVE_1549))).toEqual({
      epochMs: LIVE_1549,
      tripId: TRIP
    })
  })

  it('still refuses the 15:55:44 candidate: floor record, bus gone', () => {
    const late = plan(bike(1790196944000, 1790196969000)) // ends 15:56:09
    expect(
      verdict(
        late,
        live(1790196852000, { boardIsFloor: true, boardRealtime: false })
      )
    ).toEqual({ accept: false, reason: 'access-misses-board' })
    // ...and would refuse even had the 15:55:23 live record (15:54:12) stood.
    expect(verdict(late, live(1790196852000))).toEqual({
      accept: false,
      reason: 'access-misses-board'
    })
  })
})

/**
 * 16.2's 09-15 cases (`mu2rh9og-fw6prf`) under the live board they had then,
 * from debug-2026-09-15.jsonl. Board leg 1:1348203 startTime 09:54:02.
 *
 *   09:43:37 swap #5 bike ending 09:57:07 — last SET_LIVE_LEG_TIMES 09:43:29:
 *            boardEpoch 09:54:07, boardRealtime FALSE
 *   09:49:39 swap #8 bike ending 09:54:51 — last SET_LIVE_LEG_TIMES 09:49:37:
 *            boardEpoch 09:53:00, boardRealtime FALSE
 *
 * Neither had a live board, so both fall back to startTime and refuse exactly
 * as before (3m05s, 49 s). For #5 even the last LIVE value it had seen
 * (09:54:07 at 09:43:08) overruns by 3m00s.
 */
describe('29.1 keeps 16.2 refusing on 2026-09-15', () => {
  const TRIP_0915 = '1:1348203'
  const BOARD_0915 = 1789484042000 // 09:54:02
  const bus0915 = {
    ...busLeg,
    endTime: 1789485385000,
    startTime: BOARD_0915,
    tripId: TRIP_0915
  }
  const p0915 = (start: number, end: number) =>
    ({
      endTime: 1789485385000,
      legs: [bike(start, end), bus0915],
      startTime: start
    } as any)
  const held0915 = p0915(1789483320000, 1789483541000) // 09:42:00 -> 09:45:41
  const run = (candidate: any, liveLegTimes: any) => {
    const lb = liveBoardForCandidate(candidate, held0915, liveLegTimes)
    return acceptAutoReplan(candidate, held0915, {
      liveBoardEpochMs: lb?.epochMs ?? null,
      liveBoardTripId: lb?.tripId ?? null
    })
  }
  const swap5 = p0915(1789483380000, 1789484227000)
  const swap8 = p0915(1789483740000, 1789484091000)

  it('09:43:37 (3m05s) still refuses', () => {
    expect(
      run(
        swap5,
        live(1789484047000, { boardIsFloor: undefined, boardRealtime: false })
      )
    ).toEqual({ accept: false, reason: 'access-misses-board' })
    expect(run(swap5, live(1789484047000))).toEqual({
      accept: false,
      reason: 'access-misses-board'
    })
  })

  it('09:49:39 (49 s) still refuses', () => {
    expect(
      run(
        swap8,
        live(1789483980000, { boardIsFloor: undefined, boardRealtime: false })
      )
    ).toEqual({ accept: false, reason: 'access-misses-board' })
  })
})

const FIXTURE = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/ride-0923-1542.json'
)
const fixture: any = fs.existsSync(FIXTURE)
  ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  : null
const withFixture = fixture ? describe : describe.skip

withFixture('29.1 over ride-0923-1542.json', () => {
  // The itinerary swap applied at 15:48:47, the plan in hand for both refusals.
  const heldPlan = () =>
    fixture.itinerarySwaps.find(
      (s: any) => Math.abs(s.tMs - 1790196527000) < 1000
    ).itinerary
  const candidateAt = (hhmmss: string) => {
    const q = fixture.quietReplanPlans.find(
      (p: any) =>
        new Date(p.tMs).toLocaleTimeString('en-GB', {
          timeZone: 'America/Chicago'
        }) === hhmmss
    )
    const access = q.response.data.plan.itineraries[0]
    return spliceAccessOntoItinerary(heldPlan(), access, 1)
  }
  const judge = (candidate: any, liveLegTimes: any) => {
    const lb = liveBoardForCandidate(candidate, heldPlan(), liveLegTimes)
    return acceptAutoReplan(candidate, heldPlan(), {
      liveBoardEpochMs: lb?.epochMs ?? null,
      liveBoardTripId: lb?.tripId ?? null
    })
  }

  it('the held plan is the 15:48:47 splice onto trip 1:1346795 at 15:53:42', () => {
    const bus = heldPlan().legs[1]
    expect(bus.startTime).toBe(BOARD_PLANNED)
    expect(bus.trip?.gtfsId || bus.tripId).toBe(TRIP)
  })

  it.each([
    ['15:49:33', LIVE_1549, 18000],
    ['15:50:08', LIVE_1550, 32000]
  ])(
    '%s: refused without the live board, accepted with it',
    (t, liveMs, over) => {
      const candidate = candidateAt(t)
      expect(accessBoardOverrunMs(candidate)).toBe(over)
      expect(judge(candidate, {})).toEqual({
        accept: false,
        reason: 'access-misses-board'
      })
      expect(judge(candidate, live(liveMs))).toEqual({ accept: true })
    }
  )

  it('15:55:44: still refused (floor record, bus gone)', () => {
    const candidate = candidateAt('15:55:44')
    expect(
      judge(
        candidate,
        live(1790196852000, { boardIsFloor: true, boardRealtime: false })
      )
    ).toEqual({ accept: false, reason: 'access-misses-board' })
  })
})
