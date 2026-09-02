import { buildStepIndex } from '../../../lib/util/go-mode/turn-by-turn'
import {
  calculateCumulativeDistances,
  decodeLegGeometry,
  matchPositionToRoute
} from '../../../lib/util/go-mode/position-matching'
import { calculateTripProgress } from '../../../lib/util/go-mode/progress-calculator'
import {
  checkUpcomingTurn,
  resetTurnAnnouncements
} from '../../../lib/util/go-mode/notification-service'
import fixture from '../../../lib/util/go-mode/replay/fixtures/orange-bike-0823.json'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'

/**
 * Guidance through an off-corridor excursion — the 2026-09-01 ride 1 bike leg.
 *
 * The rider left the I-35W & Lake St station on a 1,478 m bike leg whose turns
 * are, in order: service road, 3rd Ave S, E 31st St, Clinton Ave (459 m),
 * **E 32nd St (648 m)**, Portland Ave, E 33rd St, an alley. At the corner of
 * E 31st & 3rd Ave — 358 m along — they simply carried on south down 3rd
 * instead of jogging a block east to Clinton, and rode down to E 32nd Street
 * one block west of the planned corner.
 *
 * What the app did, measured from this fixture:
 *   13:56:53–13:57:07  projection pinned at 358 m, `Turn right on Clinton
 *                      Avenue` frozen at 101 m, while the perpendicular offset
 *                      climbed 5 m → 99 m
 *   13:57:08–13:57:23  off the corridor (offset 103–107 m): NO turn at all
 *   13:57:21           the rider reaches East 32nd Street and turns onto it
 *   13:57:26           `Turn left on East 32nd Street` is finally announced —
 *                      five seconds after the turn was taken
 *
 * A 300 m step, the single biggest turn on the leg, went by in silence. The
 * rider was converging on that exact corner for the whole 16 s of silence.
 *
 * So this pins two things at once, and they pull against each other:
 *  1. the turn the rider is riding towards is announced while it is still
 *     ahead of them, off the corridor or not; and
 *  2. nothing behind the rejoin point is ever announced — the 7/29 complaint
 *     ("announces turns after you take them") must not come back as the price.
 */

// The turn that was lost, from the leg's own steps.
const E32ND_LAT = 44.9449723
const E32ND_LON = -93.2715353

interface EmittedTurn {
  cueIndex: number
  cueOffsetMeters: number
  isOnRoute: boolean
  stage: string
  tMs: number
}

describe('util > go-mode > off-corridor turn guidance (2026-09-01 ride 1)', () => {
  const itinerary = (fixture as any).itinerary
  const bikeLeg = itinerary.legs[1]
  const cues = buildStepIndex(bikeLeg)
  const cumulative = calculateCumulativeDistances(decodeLegGeometry(bikeLeg))
  const legLength = cumulative[cumulative.length - 1]

  const emitted: EmittedTurn[] = []
  /** tMs of the first fix at or south of East 32nd Street. */
  let reachedE32ndMs = Infinity
  /** The first on-route tick that ends the excursion, and where it landed. */
  let rejoinMs = Infinity
  let rejoinOffsetMeters = 0
  let offRouteTicks = 0
  let offRouteTicksWithACue = 0
  let offRouteTicksMeasuredDirect = 0
  let nowMs = 0
  let dateNowSpy: jest.SpyInstance

  beforeAll(() => {
    resetTurnAnnouncements()
    // Notification ids embed Date.now() and the dedup window compares against
    // it, so the clock has to follow the fixture's own timeline.
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs)

    const sentNotifications: string[] = []
    const track = [...(fixture as any).gpsTrack].sort(
      (a: any, b: any) => a.tMs - b.tMs
    )
    let currentLegIndex = 0
    let prevMatch: RouteMatchResult | null = null
    let wasOffRoute = false
    // The ride itself. This fixture keeps recording for 50 minutes after the
    // rider gets home — parked 2.9 km from the leg's polyline, so every one of
    // those stationary ticks is "off route" and none of them says anything
    // about turn guidance. (That the trip never ends is a separate defect.)
    let arrived = false

    track.forEach((fix: any) => {
      if (arrived) return
      nowMs = fix.tMs
      const match = matchPositionToRoute(
        [fix.lat, fix.lon],
        itinerary.legs,
        currentLegIndex,
        prevMatch
      )
      if (!match) return
      currentLegIndex = match.legIndex
      prevMatch = match
      if (match.legIndex !== 1) return

      if (fix.lat <= E32ND_LAT)
        reachedE32ndMs = Math.min(reachedE32ndMs, fix.tMs)

      const progress = calculateTripProgress(
        new Date(fix.tMs),
        itinerary,
        match,
        null,
        undefined,
        fix.speed,
        null,
        null,
        [fix.lat, fix.lon]
      )
      if (
        progress.distanceToDestination != null &&
        progress.distanceToDestination < 50
      ) {
        arrived = true
        return
      }

      if (!match.isOnRoute) {
        offRouteTicks += 1
        wasOffRoute = true
        if (progress.nextTurnCue) {
          offRouteTicksWithACue += 1
          // Off the corridor the quoted distance must be the honest straight
          // line, never a slice of a projection the rider isn't on.
          if (progress.turnDistanceIsDirect) offRouteTicksMeasuredDirect += 1
        }
      } else if (wasOffRoute) {
        wasOffRoute = false
        if (fix.tMs < rejoinMs) {
          rejoinMs = fix.tMs
          rejoinOffsetMeters = match.progressAlongLeg * legLength
        }
      }

      const event = checkUpcomingTurn(progress, bikeLeg, sentNotifications)
      if (!event) return
      sentNotifications.push(event.id)
      // Id shape: UPCOMING_TURN_${leg.startTime}_${cueIndex}_${stage}_${now}.
      const parts = event.id.split('_')
      const cueIndex = Number(parts[3])
      emitted.push({
        cueIndex,
        cueOffsetMeters: cues[cueIndex].offsetMeters,
        isOnRoute: match.isOnRoute,
        stage: parts[4],
        tMs: fix.tMs
      })
    })
  })

  afterAll(() => {
    dateNowSpy.mockRestore()
    resetTurnAnnouncements()
  })

  it('exercises the data it claims to: the real turn, the real excursion', () => {
    const e32nd = cues.find((c) => c.streetName === 'East 32nd Street')
    expect(e32nd).toBeDefined()
    expect(Math.round(e32nd!.offsetMeters)).toBe(648)
    // A 300 m step — ten times MICRO_STEP_METERS, nobody's kerb cut.
    expect(Math.round(e32nd!.distanceMeters)).toBe(300)
    // The corner the cue points at is where the fixture says it is.
    expect(e32nd!.lat).toBeCloseTo(E32ND_LAT, 6)
    expect(e32nd!.lon).toBeCloseTo(E32ND_LON, 6)
    // Sixteen seconds of genuine off-corridor riding, then a rejoin PAST the
    // turn: the projection lands at 641 m, seven metres short of the cue.
    expect(offRouteTicks).toBeGreaterThanOrEqual(15)
    expect(Number.isFinite(rejoinMs)).toBe(true)
    expect(Math.round(rejoinOffsetMeters)).toBe(641)
    expect(Number.isFinite(reachedE32ndMs)).toBe(true)
  })

  it('keeps a turn on the card through the whole excursion', () => {
    // Blank guidance for 16 s is what lost the cue. Every off-corridor tick
    // that has a turn left to give, gives one.
    expect(offRouteTicksWithACue).toBeGreaterThanOrEqual(offRouteTicks - 1)
    // …and every one of those metres is a straight line to the corner, never
    // a slice of the projection the rider has left.
    expect(offRouteTicksMeasuredDirect).toBe(offRouteTicksWithACue)
  })

  it('announces East 32nd Street before the rider gets to East 32nd Street', () => {
    const e32nd = cues.find((c) => c.streetName === 'East 32nd Street')!
    const announcements = emitted.filter((e) => e.cueIndex === e32nd.index)
    expect(announcements.length).toBeGreaterThan(0)
    // The rider crosses the street at 13:57:21; the pre-fix build announced at
    // 13:57:26, five seconds the wrong side of it.
    expect(announcements[0].tMs).toBeLessThan(reachedE32ndMs)
    // …and with enough road left to act on it, not a metre before the corner.
    expect(reachedE32ndMs - announcements[0].tMs).toBeGreaterThanOrEqual(5000)
    // It has to come from the excursion itself: the rejoin is three seconds
    // AFTER the rider is already on East 32nd Street, so waiting for the
    // projection to become trustworthy again is waiting too long by
    // construction, not by a tick or two.
    expect(announcements[0].isOnRoute).toBe(false)
    expect(announcements[0].tMs).toBeLessThan(rejoinMs)
    // And once is enough — no second card at the corner it was already given.
    expect(announcements).toHaveLength(1)
  })

  it('never announces a turn behind the rejoin point', () => {
    // `Turn right on Clinton Avenue` (459 m) is the turn the rider skipped: it
    // sits behind the 641 m rejoin, so after the rejoin it is a turn already
    // taken and must never be spoken again.
    const afterRejoin = emitted.filter((e) => e.tMs >= rejoinMs)
    afterRejoin.forEach((e) => {
      expect(e.cueOffsetMeters).toBeGreaterThan(rejoinOffsetMeters)
    })
    const clinton = cues.find((c) => c.streetName === 'Clinton Avenue')!
    expect(
      emitted.filter((e) => e.cueIndex === clinton.index && e.tMs >= rejoinMs)
    ).toEqual([])
  })

  it('still says each turn once, and never bursts at the rejoin', () => {
    // Every (turn, stage) at most once for the whole leg …
    const keys = emitted.map((e) => `${e.cueIndex}_${e.stage}`)
    expect(new Set(keys).size).toBe(keys.length)
    // … and two DIFFERENT turns never land on top of each other. This leg is
    // genuinely dense — E 31st, Clinton and E 32nd are 100 m and 189 m apart,
    // which at 7 m/s is three cards inside half a minute honestly earned — so
    // the burst signature to guard is same-second stacking, not density. The
    // tightest real pair here is 6 s (E 31st act → Clinton prepare).
    for (let i = 1; i < emitted.length; i++) {
      if (emitted[i].cueIndex === emitted[i - 1].cueIndex) continue
      expect(emitted[i].tMs - emitted[i - 1].tMs).toBeGreaterThan(5000)
    }
  })
})
