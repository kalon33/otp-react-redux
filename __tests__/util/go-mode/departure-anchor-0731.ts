import {
  anchorBoardingStopId,
  evaluateDepartureAnchor,
  getLegRouteId,
  getRouteDepartures
} from '../../../lib/util/go-mode/departure-anchor'
import { calculateTripProgress } from '../../../lib/util/go-mode/progress-calculator'
import { matchPositionToRoute } from '../../../lib/util/go-mode/position-matching'
import fixture from '../../../lib/util/go-mode/replay/fixtures/ride-2026-07-31.json'
import type { RouteDeparture } from '../../../lib/util/go-mode/departure-anchor'

/**
 * The auto-anchor, driven by a real recorded ride.
 *
 * The 7/31 trip is BICYCLE -> BUS(539) -> BICYCLE, and the recording carries 21
 * `findStopTimesForStop` snapshots of the boarding stop (1:1740) — exactly the
 * data the anchor reads out of the store after its poll. So this replays the
 * decision against the departures the feed really published that afternoon,
 * rather than departures invented for a test.
 *
 * The anchor's job is to make "your bus" mean the bus the rider will really
 * take: it watches for an earlier same-route departure they can still catch and
 * writes it into departureOverride, which progress, the pacing card and
 * missed-bus detection all read.
 */
const f: any = fixture
const legs = f.itinerary.legs
const accessLeg = legs[0]
const boardingLeg = legs[1]
const T0 = f.gpsTrack[0].tMs
const ROUTE_ID = getLegRouteId(boardingLeg)

/** The departures the feed actually published for the boarding route. */
const departures: RouteDeparture[] = getRouteDepartures(
  f.stopTimeSnapshots[0].payload,
  ROUTE_ID
)
/** The two real 539s either side of the rider's plan. */
const upcoming = departures.filter((d) => d.depMs > T0)
const THIS_BUS = upcoming[0].depMs
const NEXT_BUS = upcoming[1].depMs

const anchor = (
  prev: number | null,
  over: {
    departureOverride?: number | null
    manualLock?: boolean
    nowMs?: number
    plannedBoardMs?: number | string
    rideSecondsRemaining?: number
  } = {}
) =>
  evaluateDepartureAnchor(prev, {
    departureOverride: over.departureOverride ?? null,
    departures,
    manualLock: over.manualLock ?? false,
    nowMs: over.nowMs ?? T0,
    plannedBoardMs: over.plannedBoardMs ?? boardingLeg.startTime,
    rideSecondsRemaining: over.rideSecondsRemaining ?? accessLeg.duration
  })

describe('util > go-mode > the auto-anchor over the 7/31 ride', () => {
  it('reads the ride it claims to', () => {
    expect(anchorBoardingStopId(accessLeg, boardingLeg)).toBe('1:1740')
    expect(ROUTE_ID).toBe('1:539')
    // A live feed, not an empty list — otherwise every assertion below is vacuous.
    expect(departures.length).toBeGreaterThan(30)
    expect(f.stopTimeSnapshots).toHaveLength(21)
    // The plan boards the first 539 after the rider set off.
    expect(Number(boardingLeg.startTime)).toBe(THIS_BUS)
  })

  it('stays out of the way when the plan already has the right bus', () => {
    // The whole recorded ride, every fix, against the snapshot the store would
    // have been holding at that moment. The plan targets the soonest catchable
    // 539, so there is nothing to move the rider onto and the anchor must never
    // touch departureOverride.
    const snaps = f.stopTimeSnapshots
    let prev: number | null = null
    let anchored = 0
    let ticks = 0

    f.gpsTrack.forEach((fix: any) => {
      const snap = [...snaps].reverse().find((s: any) => s.tMs <= fix.tMs)
      if (!snap) return
      const match = matchPositionToRoute([fix.lat, fix.lon], [accessLeg], 0)
      if (!match) return
      const progress = calculateTripProgress(
        new Date(fix.tMs),
        f.itinerary,
        match,
        undefined,
        undefined,
        fix.speed
      )
      ticks += 1
      const d = evaluateDepartureAnchor(prev, {
        departureOverride: null,
        departures: getRouteDepartures(snap.payload, ROUTE_ID),
        manualLock: false,
        nowMs: fix.tMs,
        plannedBoardMs: boardingLeg.startTime,
        rideSecondsRemaining: Math.max(
          0,
          (accessLeg.duration || 0) *
            (1 - (progress.currentLegProgress || 0) / 100)
        )
      })
      prev = d.next
      if (d.anchorMs != null) anchored += 1
    })

    expect(ticks).toBeGreaterThan(300)
    expect(anchored).toBe(0)
    expect(prev).toBeNull()
  })

  it('moves the rider up when the plan boards a later bus', () => {
    // Same feed, same stop: had the itinerary targeted the NEXT 539 (a real
    // departure half an hour on), the rider can still make this one.
    const d = anchor(null, { plannedBoardMs: NEXT_BUS })
    expect(d.anchorMs).toBe(THIS_BUS)
    expect(d.next).toBe(THIS_BUS)
    expect(NEXT_BUS - THIS_BUS).toBeGreaterThan(120000)
  })

  it('anchors once, not on every tick that follows', () => {
    const first = anchor(null, { plannedBoardMs: NEXT_BUS })
    // The next tick sees its own override in force and leaves it alone.
    const again = anchor(first.next, {
      departureOverride: first.anchorMs,
      plannedBoardMs: NEXT_BUS
    })
    expect(again.anchorMs).toBeNull()
    expect(again.next).toBe(THIS_BUS)
  })

  it('never fights a departure the rider chose by hand', () => {
    const d = anchor(null, { manualLock: true, plannedBoardMs: NEXT_BUS })
    expect(d.anchorMs).toBeNull()
  })

  it('leaves an override it did not set alone', () => {
    // The rider tapped the later bus. Even without the lock, an override this
    // anchor does not recognise is not its to overwrite.
    const d = anchor(null, {
      departureOverride: NEXT_BUS,
      plannedBoardMs: NEXT_BUS
    })
    expect(d.anchorMs).toBeNull()
  })

  it('will not put the rider on a bus they cannot reach', () => {
    // Fifty minutes of riding still to do: this 539 is long gone by the time
    // they arrive, so the soonest catchable IS the planned one and nothing moves.
    const d = anchor(null, {
      plannedBoardMs: NEXT_BUS,
      rideSecondsRemaining: 3000
    })
    expect(d.anchorMs).toBeNull()
  })

  it('reads a planned board time that arrives as an ISO string', () => {
    // Itinerary times are `number | string`. Number('2026-...') is NaN, which
    // would silently disable the anchor — see time.ts / HANDOFF trap #5.
    const d = anchor(null, {
      plannedBoardMs: new Date(NEXT_BUS).toISOString()
    })
    expect(d.anchorMs).toBe(THIS_BUS)
  })
})
