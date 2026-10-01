import {
  acceptAutoReplan,
  accessBoardOverrunMs,
  AUTO_REPLAN_ACCESS_BOARD_SLACK_MS
} from '../../../lib/util/go-mode/replan-acceptance'
import { spliceAccessOntoItinerary } from '../../../lib/util/go-mode/access-splice'

/**
 * 2026-09-15, backlog 16.2 — the app installed two itineraries whose access
 * leg ends AFTER the transit leg it feeds.
 *
 * There is no fixture for this ride, so every number below is the daemon's
 * (`itinerary-backwards`, page, 09:43:37, `byMs: 185000`) rather than an
 * invented one:
 *
 *   swap #5, 09:43:37 — leg 0 BICYCLE 09:43:00 -> 09:57:07 (1,173 m / 847 s)
 *                       leg 1 BUS METRO Orange Line 09:54:02 -> 10:16:25
 *                       the bus leaves 3m05s BEFORE the bike leg ends
 *   swap #8, 09:49:39 — leg 0 453 m / 351 s ending 09:54:51, 49 s after the
 *                       same 09:54:02 departure
 *
 * Both were auto-accepted (`START_GO_MODE`) for a stop the rider was ~345 m
 * from, and both stood in front of them as "you will miss the bus" until the
 * bus had gone. The rider reached the stop at 09:52:20 and boarded. No
 * MISSED_BUS ever fired: `checkMissedBus` measures the BUS against the stop,
 * so it cannot speak before the departure it is waiting on.
 *
 * `acceptAutoReplan` waved both through because its three checks looked at the
 * unchanged suffix's arrival (identical by construction — the splice reuses
 * the same leg objects), at the first leg's origin (75 m), and at token hops.
 * None of them looks inside the itinerary.
 */

const BIKE_START = 1789483380000 // 09:43:00
const BIKE_END_BAD = 1789484227000 // 09:57:07  (swap #5)
const BOARD = 1789484042000 // 09:54:02
const ALIGHT = 1789485385000 // 10:16:25
const BIKE_END_TIGHT = 1789484091000 // 09:54:51  (swap #8, +49 s)
const BIKE_END_OK = 1789483980000 // 09:53:00  (the feasible 09:53 access leg)

/** The rider's fix when swap #5 was applied — its own leg 0 origin. */
const RIDER: [number, number] = [44.85773, -93.24118]

const bikeLeg = (endTime: number, distance: number) =>
  ({
    distance,
    duration: (endTime - BIKE_START) / 1000,
    endTime,
    from: { lat: RIDER[0], lon: RIDER[1], name: 'Current location' },
    mode: 'BICYCLE',
    startTime: BIKE_START,
    to: { lat: 44.85472, lon: -93.24276, name: '98th St Station' },
    transitLeg: false
  } as any)

const busLeg = {
  distance: 12800,
  duration: (ALIGHT - BOARD) / 1000,
  endTime: ALIGHT,
  from: { lat: 44.85472, lon: -93.24276, name: '98th St Station' },
  mode: 'BUS',
  route: { gtfsId: '1:904' },
  startTime: BOARD,
  to: { lat: 44.9739, lon: -93.2673, name: 'Nicollet Mall' },
  transitLeg: true
} as any

/** A whole plan: access leg ending `endTime`, then the untouched Orange Line. */
const plan = (endTime: number, distance = 1173) =>
  ({
    duration: (ALIGHT - BIKE_START) / 1000,
    endTime: ALIGHT,
    legs: [bikeLeg(endTime, distance), busLeg],
    startTime: BIKE_START
  } as any)

describe('accessBoardOverrunMs', () => {
  it('measures swap #5 at the daemon 3m05s', () => {
    expect(accessBoardOverrunMs(plan(BIKE_END_BAD))).toBe(185000)
  })

  it('measures swap #8 at 49 s', () => {
    expect(accessBoardOverrunMs(plan(BIKE_END_TIGHT))).toBe(49000)
  })

  it('is negative for a plan that reaches the stop in time', () => {
    expect(accessBoardOverrunMs(plan(BIKE_END_OK))).toBe(-62000)
  })

  it('declines to answer where the question does not arise', () => {
    // No transit leg at all (an all-bike plan has no bus to miss).
    expect(
      accessBoardOverrunMs({ legs: [bikeLeg(BIKE_END_OK, 1173)] } as any)
    ).toBeNull()
    // Starts ON transit: the plan begins at a stop, where it means to.
    expect(accessBoardOverrunMs({ legs: [busLeg] } as any)).toBeNull()
    // No legs / no itinerary / unusable times: fail open, like the rest of
    // this module.
    expect(accessBoardOverrunMs(null)).toBeNull()
    expect(accessBoardOverrunMs({ legs: [] } as any)).toBeNull()
    expect(
      accessBoardOverrunMs({
        legs: [{ ...bikeLeg(BIKE_END_BAD, 1173), endTime: undefined }, busLeg]
      } as any)
    ).toBeNull()
  })

  it('reads the LAST access leg, not the first (OTP returns walk-bike-walk)', () => {
    const walkIn = {
      distance: 60,
      endTime: BIKE_START + 60000,
      mode: 'WALK',
      startTime: BIKE_START,
      transitLeg: false
    } as any
    const ride = { ...bikeLeg(BIKE_END_BAD - 90000, 1100) }
    const walkOut = {
      distance: 80,
      endTime: BIKE_END_BAD,
      mode: 'WALK',
      startTime: BIKE_END_BAD - 90000,
      transitLeg: false
    } as any
    expect(
      accessBoardOverrunMs({ legs: [walkIn, ride, walkOut, busLeg] } as any)
    ).toBe(185000)
  })
})

describe('acceptAutoReplan refuses an access leg that cannot make its bus (16.2)', () => {
  const current = plan(BIKE_END_OK)

  it('accepts the feasible plan: the access chain ends before the bus leaves', () => {
    // The full re-plan 16 s before swap #5 offered a 453 m / 311 s access leg
    // reaching a 09:53 bus. Nothing about this one is refused.
    expect(
      acceptAutoReplan(plan(BIKE_END_OK, 453), current, { position: RIDER })
    ).toEqual({ accept: true })
  })

  it('refuses swap #5: the bike leg ends 3m05s after the bus has gone', () => {
    expect(
      acceptAutoReplan(plan(BIKE_END_BAD), current, { position: RIDER })
    ).toEqual({ accept: false, reason: 'access-misses-board' })
  })

  it('refuses swap #8 too: 49 s late is still a bus the rider cannot board', () => {
    // The tolerance has to sit under this one, which is why it is 15 s and not
    // the 60 s the arrival check uses.
    expect(49000).toBeGreaterThan(AUTO_REPLAN_ACCESS_BOARD_SLACK_MS)
    expect(
      acceptAutoReplan(plan(BIKE_END_TIGHT, 453), current, { position: RIDER })
    ).toEqual({ accept: false, reason: 'access-misses-board' })
  })

  it('allows a tight connection inside the tolerance', () => {
    // 10 s past a posted departure is a plan about a bus that is still at the
    // stop, not a plan about a bus that has left.
    expect(
      acceptAutoReplan(plan(BOARD + 10000), current, { position: RIDER })
    ).toEqual({ accept: true })
  })

  it('accepts when the plan in hand is ALREADY infeasible (not a regression)', () => {
    // Swap #8 offered against swap #5: still a bad plan, but a less bad one,
    // and refusing it would pin the rider to the 09:57:07 leg forever.
    expect(
      acceptAutoReplan(plan(BIKE_END_TIGHT, 453), plan(BIKE_END_BAD), {
        position: RIDER
      })
    ).toEqual({ accept: true })
  })

  it('accepts when the current plan is dead — the rider needs A plan', () => {
    expect(
      acceptAutoReplan(plan(BIKE_END_BAD), current, {
        currentPlanIsDead: true,
        position: RIDER
      })
    ).toEqual({ accept: true })
  })

  it('still refuses what the splice itself produces', () => {
    // End to end through the real splicer, because that is where these two
    // itineraries came from: the access end time is deliberately unclamped, so
    // the defect survives into the spliced object and this gate is the only
    // thing left between it and beginGoMode.
    const access = {
      duration: (BIKE_END_BAD - BIKE_START) / 1000,
      endTime: BIKE_END_BAD,
      legs: [bikeLeg(BIKE_END_BAD, 1173)],
      startTime: BIKE_START
    } as any
    const spliced = spliceAccessOntoItinerary(current, access, 1)
    // The splice keeps the suffix byte-identical, so arrival is unchanged —
    // which is exactly why the arrival check has nothing to say here.
    expect(spliced.endTime).toBe(current.endTime)
    expect(acceptAutoReplan(spliced, current, { position: RIDER })).toEqual({
      accept: false,
      reason: 'access-misses-board'
    })
  })
})
