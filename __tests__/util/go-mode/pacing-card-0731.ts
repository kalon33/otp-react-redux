import { calculateTripProgress } from '../../../lib/util/go-mode/progress-calculator'
import { evaluatePacingCard } from '../../../lib/util/go-mode/pacing-card'
import { matchPositionToRoute } from '../../../lib/util/go-mode/position-matching'
import fixture from '../../../lib/util/go-mode/replay/fixtures/ride-2026-07-31.json'
import type { PacingCardState } from '../../../lib/util/go-mode/pacing-card'

/**
 * The sticky pacing card, driven by a real recorded ride.
 *
 * The 7/31 trip is BICYCLE -> BUS -> BICYCLE, and the rider spent the whole
 * recording standing at the origin: 335 fixes inside a 7 m circle while the
 * bus they were chasing came 21 minutes closer. That is exactly the question
 * the card exists to answer ("should I go fast or slow?"), so it is the right
 * ride to hold the cadence against.
 *
 * The contrast worth keeping in view: over these same seven minutes the turn
 * announcement path pushed the identical alert 14 times, which is what the
 * rider complained about. The pacing card buzzes ONCE and then updates in
 * place — three silent rewrites as the wait counts down.
 *
 * evaluatePacingCard was already pure when it was written; what this test
 * needed was the rest of the tick's decisions (the enable gate, the clear) to
 * come out with it, so a replay can drive the whole thing.
 */
describe('util > go-mode > the pacing card over the 7/31 ride', () => {
  const itinerary = (fixture as any).itinerary
  const fixes = (fixture as any).gpsTrack

  const posts: Array<{ passive: boolean; tMs: number; title: string }> = []
  let clears = 0
  let ticksWithPacingData = 0
  let card: PacingCardState | null = null

  beforeAll(() => {
    fixes.forEach((fix: any) => {
      const currentLeg = itinerary.legs[0]
      const nextLeg = itinerary.legs[1]
      const match = matchPositionToRoute([fix.lat, fix.lon], [currentLeg], 0)
      if (!match) return

      const progress = calculateTripProgress(
        new Date(fix.tMs),
        itinerary,
        match,
        undefined,
        undefined,
        fix.speed
      )
      if (
        progress.waitTimeAtStop != null &&
        progress.timeUntilNextDeparture != null
      ) {
        ticksWithPacingData += 1
      }

      const decision = evaluatePacingCard(card, {
        currentLeg,
        enabled: true,
        nextLeg,
        nowMs: fix.tMs,
        progress
      })
      card = decision.next
      if (decision.post) {
        posts.push({
          passive: decision.post.passive,
          title: decision.post.title,
          tMs: fix.tMs
        })
      }
      if (decision.clear) clears += 1
    })
  })

  const waitMinutes = (title: string): number => {
    const m = title.match(/·\s*(−?-?\d+) min wait/)
    if (!m) throw new Error('unparseable card title: ' + title)
    return Number(m[1].replace('−', '-'))
  }

  it('replays a ride the card actually applies to', () => {
    expect(itinerary.legs.map((l: any) => l.mode).slice(0, 3)).toEqual([
      'BICYCLE',
      'BUS',
      'BICYCLE'
    ])
    expect(fixes.length).toBe(335)
    // Every fix carries both numbers the card is made of.
    expect(ticksWithPacingData).toBe(335)
  })

  it('buzzes once and then updates in place', () => {
    // Per-tick posting would be 335. The cadence rules make it four.
    expect(posts).toHaveLength(4)
    expect(posts.filter((p) => !p.passive)).toHaveLength(1)
    expect(posts[0].passive).toBe(false)
    expect(posts.slice(1).every((p) => p.passive)).toBe(true)
  })

  it('never re-posts inside the 90 s floor', () => {
    const gaps = posts.slice(1).map((p, i) => (p.tMs - posts[i].tMs) / 1000)
    gaps.forEach((g) => expect(g).toBeGreaterThanOrEqual(90))
  })

  it('counts the wait down as the bus closes in', () => {
    const waits = posts.map((p) => waitMinutes(p.title))
    expect(waits).toEqual([...waits].sort((a, b) => b - a))
    expect(new Set(waits).size).toBe(waits.length)
    // The rider never moved, so the ride time cannot have changed.
    const rides = posts.map((p) => p.title.match(/(\d+) min ride/)?.[1])
    expect(new Set(rides).size).toBe(1)
  })

  it('never clears while the rider is still riding to the stop', () => {
    expect(clears).toBe(0)
    expect(card).not.toBeNull()
  })
})
