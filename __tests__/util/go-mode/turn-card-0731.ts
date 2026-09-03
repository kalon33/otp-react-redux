import { calculateTripProgress } from '../../../lib/util/go-mode/progress-calculator'
import { evaluateTurnCard } from '../../../lib/util/go-mode/turn-card'
import { matchPositionToRoute } from '../../../lib/util/go-mode/position-matching'
import fixture from '../../../lib/util/go-mode/replay/fixtures/ride-2026-07-31.json'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'
import type { TurnCardPost } from '../../../lib/util/go-mode/turn-card'

/**
 * The sticky turn card, driven by a real recorded ride.
 *
 * Until the decision came out of handlePositionUpdate this could not be
 * written: the card logic sat inline in a 750-line thunk, reachable only by
 * running the app against a live OTP backend and the dev server. It is the
 * first slice of that extraction, and this is what the slice buys — the same
 * 7/31 track the turn-storm test replays, now driving the card the rider
 * actually sees on their wrist.
 *
 * The ride: the rider opened Go Mode 21 minutes early and stood at the origin
 * for 7 minutes — 335 fixes inside a 7 m circle, one turn cue 53 m ahead that
 * never changed. The card must be written ONCE and then left alone; a card
 * rewritten per tick is a wrist buzzing every 1.3 seconds.
 */
describe('util > go-mode > the turn card over the 7/31 ride', () => {
  const itinerary = (fixture as any).itinerary
  const fixes = (fixture as any).gpsTrack

  const posts: Array<{ post: TurnCardPost; tMs: number }> = []
  const clears: number[] = []
  let cardKey: string | null = null
  let ticksWithACue = 0

  beforeAll(() => {
    fixes.forEach((fix: any) => {
      // Read the leg the way the tick does — out of the itinerary every time.
      const currentLeg = itinerary.legs[0]
      const match: RouteMatchResult | null = matchPositionToRoute(
        [fix.lat, fix.lon],
        [currentLeg],
        0
      )
      if (!match) return

      const progress = calculateTripProgress(
        new Date(fix.tMs),
        itinerary,
        match,
        undefined,
        undefined,
        fix.speed
      )
      if (progress.nextTurnCue) ticksWithACue += 1

      const decision = evaluateTurnCard(cardKey, {
        currentLeg,
        enabled: true,
        progress
      })
      cardKey = decision.next
      if (decision.post) posts.push({ post: decision.post, tMs: fix.tMs })
      if (decision.clear) clears.push(fix.tMs)
    })
  })

  it('replays the ride it claims to: 335 fixes, one turn ahead throughout', () => {
    expect(fixes.length).toBe(335)
    expect(ticksWithACue).toBeGreaterThan(300)
  })

  it('writes the card once, not once per fix', () => {
    // The whole point of keying on the cue's identity. Per-tick posting would
    // be 300+.
    expect(posts.length).toBe(1)
    // The first cue of this leg is the bear-right onto Village Terrace. The
    // 11.2 m `RIGHT Village Lane` that used to precede it is a connector, not a
    // decision, and is folded away (MICRO_STEP_METERS).
    expect(posts[0].post.title).toBe('Bear right on Village Terrace')
    // Passive: the buzz for this turn already went out as a TURN_ALERT.
    expect(posts[0].post.passive).toBe(true)
  })

  it('never cancels a card that is still the rider’s next move', () => {
    expect(clears).toHaveLength(0)
    expect(cardKey).not.toBeNull()
  })
})

describe('util > go-mode > turn card decisions', () => {
  const walkLeg = { mode: 'WALK', startTime: 1_769_616_000_000 } as any
  const progressWith = (over: any = {}) =>
    ({
      nextTurnCue: { index: 0, instruction: 'Turn right on Village Lane' },
      status: 'onTrack',
      ...over
    } as any)

  it('posts when the turn changes and holds while it does not', () => {
    const first = evaluateTurnCard(null, {
      currentLeg: walkLeg,
      enabled: true,
      progress: progressWith()
    })
    expect(first.post?.title).toBe('Turn right on Village Lane')

    const held = evaluateTurnCard(first.next, {
      currentLeg: walkLeg,
      enabled: true,
      progress: progressWith()
    })
    expect(held.post).toBeNull()
    expect(held.next).toBe(first.next)

    const swapped = evaluateTurnCard(first.next, {
      currentLeg: walkLeg,
      enabled: true,
      progress: progressWith({
        nextTurnCue: { index: 1, instruction: 'Turn left on Bryant Ave S' }
      })
    })
    expect(swapped.post?.title).toBe('Turn left on Bryant Ave S')
    expect(swapped.next).not.toBe(first.next)
  })

  it('carries the following turn as the card’s second line', () => {
    const d = evaluateTurnCard(null, {
      currentLeg: walkLeg,
      enabled: true,
      progress: progressWith({
        followingTurnCue: { index: 1, instruction: 'Turn left on Bryant Ave S' }
      })
    })
    expect(d.post?.message).toMatch(/^then /)
  })

  it('clears the card once there is no turn left to make', () => {
    const d = evaluateTurnCard('someLeg_0', {
      currentLeg: walkLeg,
      enabled: true,
      progress: progressWith({ nextTurnCue: undefined })
    })
    expect(d.clear).toBe(true)
    expect(d.next).toBeNull()
  })

  it('freezes rather than churns while deviated on an access leg', () => {
    // 7/29: perpendicular distance flapped across the on-route threshold for
    // two minutes. Clearing on each off-route tick churns cancel→repost.
    const d = evaluateTurnCard('someLeg_0', {
      currentLeg: walkLeg,
      enabled: true,
      progress: progressWith({ nextTurnCue: undefined, status: 'deviated' })
    })
    expect(d.clear).toBe(false)
    expect(d.next).toBe('someLeg_0')
  })

  it('still clears a deviated TRANSIT leg — that means boarded', () => {
    const d = evaluateTurnCard('someLeg_0', {
      currentLeg: { mode: 'BUS', startTime: 1 } as any,
      enabled: true,
      progress: progressWith({ nextTurnCue: undefined, status: 'deviated' })
    })
    expect(d.clear).toBe(true)
  })

  it('leaves the wrist untouched when disabled, rather than clearing it', () => {
    // A replay must not cancel a card the live trip put there.
    const d = evaluateTurnCard('someLeg_0', {
      currentLeg: walkLeg,
      enabled: false,
      progress: progressWith({ nextTurnCue: undefined })
    })
    expect(d).toEqual({ clear: false, next: 'someLeg_0', post: null })
  })
})
