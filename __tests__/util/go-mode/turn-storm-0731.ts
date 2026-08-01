import { calculateTripProgress } from '../../../lib/util/go-mode/progress-calculator'
import { checkUpcomingTurn } from '../../../lib/util/go-mode/notification-service'
import { matchPositionToRoute } from '../../../lib/util/go-mode/position-matching'
import fixture from '../../../lib/util/go-mode/replay/fixtures/ride-2026-07-31.json'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'

/**
 * The 7/31 notification storm, replayed (session ms96ka9s-wc8j1u).
 *
 * The rider opened Go Mode 21 minutes before their planned departure, stood at
 * the origin the whole time — 335 GPS fixes inside a 7 m circle, speed ≤2.89 m/s
 * with 18 of 314 samples above 0.5 m/s — and the app pushed the identical
 * "Turn right on Village Lane" TURN_ALERT to their phone and watch **14 times in
 * 7 minutes**, one every 30.5 s. `distanceToNextTurn` never left the 52.7–53.9 m
 * band; nothing about the rider's situation changed between the first push and
 * the fourteenth. Their note, mid-ride: "I'm getting so many notifications even
 * though I have[n't] moved. I specifically asked for notifications to be once".
 *
 * This drives the same pure per-tick pipeline the app runs —
 * matchPositionToRoute → calculateTripProgress → checkUpcomingTurn — over the
 * recorded track. Against the pre-fix logic it emits 14 TURN_ALERTs for cue 0;
 * that is the number this test exists to pin at one.
 */

interface EmittedTurn {
  cueIndex: number
  stage: string
  tMs: number
  type: string
}

describe('util > go-mode > the 7/31 turn-alert storm', () => {
  const itinerary = (fixture as any).itinerary
  // Leg 0: the bike leg to the boarding stop, whose first turn the rider was
  // 53 m from and never rode.
  const leg0 = itinerary.legs[0]
  const fixes = (fixture as any).gpsTrack

  const emitted: EmittedTurn[] = []
  /** Leg-object identity across ticks, the latch's whole lifetime assumption. */
  let legAlwaysSameObject = true
  let onRouteTicks = 0
  let nowMs = (fixture as any).meta.startMs
  let dateNowSpy: jest.SpyInstance

  beforeAll(() => {
    // Notification ids embed Date.now() and the dedup window compares against
    // it, so the clock has to follow the fixture's own timeline.
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs)

    const sentNotifications: string[] = []
    fixes.forEach((fix: any) => {
      nowMs = fix.tMs
      // handlePositionUpdate reads its leg out of goMode.activeItinerary every
      // tick; re-reading it here keeps that indirection honest rather than
      // closing over one hoisted reference.
      const currentLeg = itinerary.legs[0]
      if (currentLeg !== leg0) legAlwaysSameObject = false

      const match: RouteMatchResult | null = matchPositionToRoute(
        [fix.lat, fix.lon],
        [currentLeg],
        0
      )
      if (!match) return
      if (match.isOnRoute) onRouteTicks += 1

      const progress = calculateTripProgress(
        new Date(fix.tMs),
        itinerary,
        match,
        undefined,
        undefined,
        fix.speed
      )
      const event = checkUpcomingTurn(progress, currentLeg, sentNotifications)
      if (!event) return
      sentNotifications.push(event.id)

      // Id shape: UPCOMING_TURN_${leg.startTime}_${cueIndex}_${stage}_${now}.
      const parts = event.id.split('_')
      emitted.push({
        cueIndex: Number(parts[3]),
        stage: parts[4],
        tMs: fix.tMs,
        type: event.type
      })
    })
  })

  afterAll(() => {
    dateNowSpy.mockRestore()
  })

  it('replays the ride it claims to: 7 minutes parked on leg 0', () => {
    expect(fixes.length).toBe(335)
    expect(onRouteTicks).toBeGreaterThan(300)
    // 421 s of standing still.
    const spanMs = (fixture as any).meta.endMs - (fixture as any).meta.startMs
    expect(spanMs).toBeGreaterThan(400000)
    // And the leg object the app hands to checkUpcomingTurn never changes
    // identity across those ticks — what the per-leg latch is keyed on.
    expect(legAlwaysSameObject).toBe(true)
  })

  it('pushes the first turn at most once across the whole session', () => {
    // Pre-fix this is 14. Every one of them reached the phone and the watch.
    const alerts = emitted.filter(
      (e) => e.cueIndex === 0 && e.type === 'TURN_ALERT'
    )
    expect(alerts.length).toBeLessThanOrEqual(1)
  })

  it('never repeats any (turn, stage) on the leg', () => {
    const keys = emitted.map((e) => `${e.cueIndex}_${e.stage}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
