import {
  ACT_LEAD_MAX_M,
  checkUpcomingTurn
} from '../../../lib/util/go-mode/notification-service'
import { buildStepIndex } from '../../../lib/util/go-mode/turn-by-turn'
import {
  calculateCumulativeDistances,
  decodeLegGeometry,
  matchPositionToRoute
} from '../../../lib/util/go-mode/position-matching'
import { calculateTripProgress } from '../../../lib/util/go-mode/progress-calculator'
import fixture from '../../../lib/util/go-mode/replay/fixtures/orange-line-0729.json'

/**
 * Turn-announcement honesty over the real 7/29 ride.
 *
 * The rider's note: "The bike turn notification announces turns after you take
 * them :)". Measured from this fixture: minutes 20.2–22.2 the rider rode a
 * street parallel to bike leg 0 (perpendicular distance flapping around the
 * 100 m on-route threshold) while the nearest-point projection slid
 * 537 m → 1509 m — sweeping past the cues at 822/1003 m. Ticks that dipped
 * back under the threshold announced those swept-past turns as if they were
 * still ahead.
 *
 * (A third swept cue used to sit at 992 m: `LEFT bike path`, a 10.5 m connector
 * onto the Grand Rounds a dozen metres later. It is folded away now — see
 * MICRO_STEP_METERS — so the sweep is two cues wide here rather than three.)
 *
 * This test replays leg 0's window through the same pure pipeline the app
 * runs per GPS tick — matchPositionToRoute → calculateTripProgress →
 * checkUpcomingTurn — and pins what an honest navigator must do with this
 * exact data. Against the pre-fix logic these assertions fail; that is the
 * point of the test.
 *
 * Off-corridor ticks are no longer silent (2026-09-01 ride 1 lost a 300 m turn
 * to that silence — turn-off-corridor-0901), so the guard that matters here is
 * the convergence one: the rider on the parallel street is riding AWAY from
 * 822/1003 m, never towards them, so those turns still earn no announcement.
 * "Announces nothing at all on deviated ticks" holds on this data for that
 * reason, not because the code has nothing to say.
 */

// Leg 0's window: departure through the ride to the boarding stop. 28 minutes
// covers the stationary start, the min 9–12 backtrack, the deviated stretch
// and several minutes of settled riding after the rejoin.
const WINDOW_MS = 28 * 60 * 1000

interface EmittedTurn {
  cueIndex: number
  cueOffsetMeters: number
  /** Highest on-route projection offset seen up to (and incl.) emit time. */
  highWaterOnRouteMeters: number
  isOnRoute: boolean
  projectionOffsetMeters: number
  stage: string
  tMs: number
}

describe('util > go-mode > turn honesty on the 7/29 ride', () => {
  const itinerary = (fixture as any).itinerary
  const leg0 = itinerary.legs[0]
  const cues = buildStepIndex(leg0)
  const polyline = decodeLegGeometry(leg0)
  const cumulative = calculateCumulativeDistances(polyline)
  const legLength = cumulative[cumulative.length - 1]

  const startMs = (fixture as any).meta.startMs
  const fixes = (fixture as any).gpsTrack.filter(
    (f: any) => f.tMs - startMs <= WINDOW_MS
  )

  const emitted: EmittedTurn[] = []
  let deviatedTickCount = 0
  let nowMs = startMs
  let dateNowSpy: jest.SpyInstance

  beforeAll(() => {
    // The notification ids embed Date.now() and the dedup window compares
    // against it, so the clock must follow the fixture's own timeline.
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs)

    const sentNotifications: string[] = []
    // The rider's settled on-route projection: rises with any on-route tick,
    // but only comes back DOWN after a sustained run of on-route ticks below
    // it — the min 9–12 backtrack (rode 500 m out, returned home) genuinely
    // recedes, while the deviated stretch's threshold flap (single on-route
    // ticks amid off-route ones) must not launder a swept projection.
    let highWater = 0
    let ticksBelowHighWater = 0
    const BACKTRACK_RESET_TICKS = 5

    fixes.forEach((fix: any) => {
      nowMs = fix.tMs
      const match = matchPositionToRoute([fix.lat, fix.lon], [leg0], 0)
      if (!match) return
      if (!match.isOnRoute) deviatedTickCount += 1

      const projectionOffsetMeters = match.progressAlongLeg * legLength
      if (match.isOnRoute) {
        if (projectionOffsetMeters > highWater) {
          highWater = projectionOffsetMeters
          ticksBelowHighWater = 0
        } else if (projectionOffsetMeters < highWater - ACT_LEAD_MAX_M) {
          // Dips accumulate until a new high: stationary GPS noise oscillates
          // through the middle band, and requiring CONSECUTIVE dips would let
          // one spike pin the reference forever.
          ticksBelowHighWater += 1
          if (ticksBelowHighWater >= BACKTRACK_RESET_TICKS) {
            highWater = projectionOffsetMeters
            ticksBelowHighWater = 0
          }
        }
      }

      const progress = calculateTripProgress(
        new Date(fix.tMs),
        itinerary,
        match,
        undefined,
        undefined,
        fix.speed,
        null,
        null,
        // The raw fix, as the live tick supplies it. Off the corridor this is
        // now the only thing turn guidance has to measure with (a held turn,
        // straight-line to the corner — see selectOffRouteCue), so leaving it
        // out would exempt this ride from exactly the path it exists to guard.
        [fix.lat, fix.lon]
      )
      const event = checkUpcomingTurn(progress, leg0, sentNotifications)
      if (!event) return
      sentNotifications.push(event.id)

      // Id shape: UPCOMING_TURN_${leg.startTime}_${cueIndex}_${stage}_${now}.
      const parts = event.id.split('_')
      const cueIndex = Number(parts[3])
      emitted.push({
        cueIndex,
        cueOffsetMeters: cues[cueIndex].offsetMeters,
        highWaterOnRouteMeters: highWater,
        isOnRoute: match.isOnRoute,
        projectionOffsetMeters,
        stage: parts[4],
        tMs: fix.tMs
      })
    })
  })

  afterAll(() => {
    dateNowSpy.mockRestore()
  })

  it('exercises the data it claims to: real cues, real deviated stretch', () => {
    // The turns the rider bypassed on the parallel street.
    expect(cues.map((c) => Math.round(c.offsetMeters))).toEqual(
      expect.arrayContaining([822, 1003])
    )
    // …and the 10.5 m connector between them is no longer a cue at all.
    expect(cues.map((c) => Math.round(c.offsetMeters))).not.toContain(992)
    // The min 20.2–22.2 deviated stretch is in the window.
    expect(deviatedTickCount).toBeGreaterThan(30)
    // And honest guidance still announces the turns the rider does ride.
    expect(emitted.length).toBeGreaterThan(0)
  })

  it('never announces a turn behind the rider on-route projection', () => {
    emitted.forEach((e) => {
      expect(e.cueOffsetMeters).toBeGreaterThanOrEqual(
        e.highWaterOnRouteMeters - ACT_LEAD_MAX_M
      )
    })
  })

  it('announces nothing at all on deviated ticks', () => {
    expect(emitted.filter((e) => !e.isOnRoute)).toEqual([])
  })

  it('never bursts on rejoin: no sweep of several turns in quick succession', () => {
    // Each (cue, stage) at most once across the whole run …
    const keys = emitted.map((e) => `${e.cueIndex}_${e.stage}`)
    expect(new Set(keys).size).toBe(keys.length)
    // … and never three DIFFERENT turns inside 30 s of sim time — the wrist
    // signature of the 822/992/1003 sweep. (Two adjacent real turns produce
    // two cues in a window; only a projection sweep produces three.)
    emitted.forEach((e) => {
      const inWindow = emitted.filter(
        (other) => other.tMs >= e.tMs && other.tMs < e.tMs + 30000
      )
      const distinctCues = new Set(inWindow.map((w) => w.cueIndex))
      expect(distinctCues.size).toBeLessThan(3)
    })
  })

  it('stays silent about the swept-past turns at 822/1003 m', () => {
    // The rider effectively took these on the parallel street; announcing them
    // afterwards is the complaint, verbatim. The rider's on-route travel never
    // brings them inside an announcement lead, so the honest count is zero.
    const sweptIndexes = cues
      .filter((c) => [822, 1003].includes(Math.round(c.offsetMeters)))
      .map((c) => c.index)
    expect(emitted.filter((e) => sweptIndexes.includes(e.cueIndex))).toEqual([])
  })
})
