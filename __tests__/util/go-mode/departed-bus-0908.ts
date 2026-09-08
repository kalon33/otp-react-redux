import {
  anchorBoardingStopId,
  departureIsUnreachable,
  evaluateDepartureAnchor,
  getLegRouteId,
  getRouteDepartures,
  getSoonestCatchableMs
} from '../../../lib/util/go-mode/departure-anchor'
import { calculateTripProgress } from '../../../lib/util/go-mode/progress-calculator'
import { matchPositionToRoute } from '../../../lib/util/go-mode/position-matching'
import fixture from '../../../lib/util/go-mode/replay/fixtures/departed-bus-0908.json'
import type { RouteDeparture } from '../../../lib/util/go-mode/departure-anchor'

/**
 * 2026-09-08, session mtssjvee-mtc2dx: "Not true bus left".
 *
 * BICYCLE -> METRO Orange Line -> BICYCLE, boarding at I-35W & 66th St Station
 * (1:48084). The rider photographed the card at 10:09:49: it headlined
 * "10:07 AM / arrives in <1 min" while offering their real bus — the live 10:25
 * — as a "Later departures" row behind a "Use this" button. The 10:07 had gone.
 *
 * The mechanism, from the telemetry:
 *
 *  - The session opened at 09:57:39 with `departureOverride` already set to
 *    1788880053000 (10:07:33), restored from the saved Go Mode session — no
 *    SET_DEPARTURE_OVERRIDE is dispatched anywhere in the log that day.
 *  - The very first UPDATE_PROGRESS (09:57:40) carried
 *    `departureIsOverridden: true`, `effectiveDepartureMs: 1788880053000` and
 *    `waitTimeAtStop: -281` — the app had already measured that the rider could
 *    not reach that bus. OTP's own bike leg puts them at the stop at 10:12:59.
 *  - Nothing re-examined it. The anchor leaves alone any override it did not
 *    itself set (`departureOverride !== prev`, and `prev` is module state a
 *    resume rebuilds as null), START_GO_MODE (09:59:39) does not clear it, and
 *    classifyMissedBus deliberately ignores an override naming another run.
 *  - All 704 progress records of the ride carry the same
 *    `effectiveDepartureMs`. The last one, 10:09:22, has
 *    `timeUntilNextDeparture: -109` — and a negative countdown rounds to
 *    "<1 min", which is the sentence the rider photographed.
 *
 * The fix: the anchor releases an override the rider provably cannot reach, so
 * the display falls back to the soonest departure they CAN catch — the same
 * route's next run.
 */
const f: any = fixture
const legs = f.itinerary.legs
const accessLeg = legs[0]
const boardingLeg = legs[1]
const ROUTE_ID = getLegRouteId(boardingLeg)
const T0 = f.gpsTrack[0].tMs
const TLAST = f.gpsTrack[f.gpsTrack.length - 1].tMs

/**
 * The override that was in force for the whole ride. It is not in the fixture
 * because no action ever set it in this session — it came back from storage —
 * so it is pinned here from the UPDATE_PROGRESS stream that reported it (every
 * one of the 704 records of the ride, 09:57:40 through 10:09:22).
 */
const RESTORED_OVERRIDE = 1788880053000

/** The departures the feed published, as of a given moment in the ride. */
const departuresAt = (tMs: number): RouteDeparture[] => {
  const snap = [...f.stopTimeSnapshots].reverse().find((s: any) => s.tMs <= tMs)
  return snap ? getRouteDepartures(snap.payload, ROUTE_ID) : []
}

/** rideSecondsRemaining exactly as the tick computes it (actions/go-mode.ts). */
const rideSecondsAt = (fix: any): number | null => {
  const match = matchPositionToRoute([fix.lat, fix.lon], [accessLeg], 0)
  if (!match) return null
  const progress = calculateTripProgress(
    new Date(fix.tMs),
    f.itinerary,
    match,
    undefined,
    undefined,
    fix.speed
  )
  return Math.max(
    0,
    (accessLeg.duration || 0) * (1 - (progress.currentLegProgress || 0) / 100)
  )
}

describe('util > go-mode > the departed bus of 2026-09-08', () => {
  it('reads the ride it claims to', () => {
    expect(f.meta.session).toBe('mtssjvee-mtc2dx')
    expect(ROUTE_ID).toBe('1:904')
    expect(anchorBoardingStopId(accessLeg, boardingLeg)).toBe('1:48084')
    // The plan boards at 10:22:54; the override named a bus 15m21s earlier.
    expect(Number(boardingLeg.startTime)).toBe(1788880974000)
    expect(Number(boardingLeg.startTime) - RESTORED_OVERRIDE).toBe(921000)
    // A live feed, not an empty list — otherwise every assertion is vacuous.
    // The first stop-times poll lands 17 s into the ride, so T0 itself has
    // none: the release below is deliberately not conditional on having them.
    expect(departuresAt(T0)).toHaveLength(0)
    expect(departuresAt(TLAST).length).toBeGreaterThan(30)
    expect(f.gpsTrack).toHaveLength(584)
    expect(f.stopTimeSnapshots).toHaveLength(28)
  })

  it('the override named a bus that was gone before the ride ended', () => {
    // 10:09:22 was the rider's last fix; the note came 15 s later.
    expect(RESTORED_OVERRIDE).toBeLessThan(TLAST)
    expect(Math.round((TLAST - RESTORED_OVERRIDE) / 1000)).toBe(109)
    // ...which is what the card rounded to "<1 min": Math.round(-109/60) = -2.
    expect(Math.round((RESTORED_OVERRIDE - TLAST) / 60000)).toBeLessThanOrEqual(
      0
    )
  })

  it('releases the unreachable override, on the very first fix of the ride', () => {
    const fix = f.gpsTrack[0]
    const ride = rideSecondsAt(fix)
    expect(ride).not.toBeNull()
    // 13m59s of bike leg still to ride, for a bus 7m54s away.
    expect(ride).toBeGreaterThan(600)
    expect(
      departureIsUnreachable(RESTORED_OVERRIDE, fix.tMs, ride as number)
    ).toBe(true)

    const d = evaluateDepartureAnchor(null, {
      departureOverride: RESTORED_OVERRIDE,
      departures: departuresAt(fix.tMs),
      manualLock: false,
      nowMs: fix.tMs,
      plannedBoardMs: boardingLeg.startTime,
      rideSecondsRemaining: ride as number
    })
    // Pre-fix this returned { anchorMs: null, next: null } — "an override I did
    // not set, leave it alone" — and the card kept 10:07 for another 9m49s.
    expect(d.clear).toBe(true)
    expect(d.anchorMs).toBeNull()
    expect(d.next).toBeNull()
  })

  it('hands the rider back their own bus, never one in the past', () => {
    // With the override gone the display and the anchor both read
    // getSoonestCatchableMs — the soonest run of the SAME route the rider can
    // still reach. Over every fix of the ride it is a real, future departure.
    let ticks = 0
    let earliest: number | null = null
    f.gpsTrack.forEach((fix: any) => {
      const ride = rideSecondsAt(fix)
      if (ride == null) return
      const soonest = getSoonestCatchableMs(
        departuresAt(fix.tMs),
        fix.tMs,
        ride
      )
      if (soonest == null) return
      ticks += 1
      expect(soonest).toBeGreaterThan(fix.tMs)
      expect(soonest).not.toBe(RESTORED_OVERRIDE)
      if (earliest == null || soonest < earliest) earliest = soonest
    })
    expect(ticks).toBeGreaterThan(500)
    // The soonest ever offered is the 10:23 run — the bus the rider was
    // planned onto (10:22:54) and the one the card demoted to a "Use this"
    // row; the feed's live prediction for it was 10:22:51 early in the ride
    // and had slipped to 10:25:02 by the last poll.
    expect(earliest).toBe(1788880971000)
  })

  it('does not re-adopt the released departure on the next tick', () => {
    const fix = f.gpsTrack[0]
    const ride = rideSecondsAt(fix) as number
    const again = evaluateDepartureAnchor(null, {
      departureOverride: null,
      departures: departuresAt(fix.tMs),
      manualLock: false,
      nowMs: fix.tMs,
      plannedBoardMs: boardingLeg.startTime,
      rideSecondsRemaining: ride
    })
    expect(again.clear).toBeFalsy()
    expect(again.anchorMs).not.toBe(RESTORED_OVERRIDE)
    // The plan already targets the soonest catchable run, so nothing moves.
    expect(again.anchorMs).toBeNull()
  })

  // The 7/22 protection, restated against this ride's own feed: a rider
  // STANDING at the stop has no travel-time deficit to measure, so an overdue
  // departure there means a late bus, not a missed one, and must be held.
  it('holds an overdue departure for a rider already at the stop', () => {
    const atStop = RESTORED_OVERRIDE + 40000
    expect(departureIsUnreachable(RESTORED_OVERRIDE, atStop, 0)).toBe(false)
    expect(departureIsUnreachable(RESTORED_OVERRIDE, atStop, 45)).toBe(false)
    const d = evaluateDepartureAnchor(null, {
      departureOverride: RESTORED_OVERRIDE,
      departures: departuresAt(TLAST),
      manualLock: false,
      nowMs: atStop,
      plannedBoardMs: boardingLeg.startTime,
      rideSecondsRemaining: 0
    })
    expect(d.clear).toBeFalsy()
    expect(d.anchorMs).toBeNull()
  })

  it('still never fights a departure the rider chose by hand', () => {
    const fix = f.gpsTrack[0]
    const d = evaluateDepartureAnchor(null, {
      departureOverride: RESTORED_OVERRIDE,
      departures: departuresAt(fix.tMs),
      manualLock: true,
      nowMs: fix.tMs,
      plannedBoardMs: boardingLeg.startTime,
      rideSecondsRemaining: rideSecondsAt(fix) as number
    })
    expect(d.clear).toBeFalsy()
    expect(d.anchorMs).toBeNull()
  })
})
