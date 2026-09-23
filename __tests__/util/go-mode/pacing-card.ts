import {
  classifyBuffer,
  evaluatePacingCard,
  PacingCardState
} from '../../../lib/util/go-mode/pacing-card'

const bikeLeg = { mode: 'BICYCLE', startTime: 1000 } as any
const busLeg = {
  mode: 'BUS',
  routeShortName: '535',
  transitLeg: true
} as any

const T0 = 1_700_000_000_000

// progress carrying the two fields the card reads: seconds until the bus
// departs, and seconds of wait at the stop (buffer). Ride time = due - wait.
const prog = (dueSecs: number, waitSecs: number): any => ({
  timeUntilNextDeparture: dueSecs,
  waitTimeAtStop: waitSecs
})

const tick = (
  prev: PacingCardState | null,
  nowMs: number,
  dueSecs: number,
  waitSecs: number,
  legs: { currentLeg?: any; nextLeg?: any } = {}
) =>
  evaluatePacingCard(prev, {
    currentLeg: legs.currentLeg ?? bikeLeg,
    enabled: true,
    nextLeg: legs.nextLeg ?? busLeg,
    nowMs,
    progress: prog(dueSecs, waitSecs)
  })

describe('util > go-mode > pacing-card', () => {
  describe('classifyBuffer', () => {
    it('maps buffers to pacing states', () => {
      expect(classifyBuffer(-30)).toBe('atRisk')
      expect(classifyBuffer(60)).toBe('tight')
      expect(classifyBuffer(600)).toBe('comfortable')
    })
  })

  it('posts once (alerting) when the bike leg becomes current', () => {
    // 15 min to the bus, 2 min of wait → 13 min ride, tight buffer.
    const { next, post } = tick(null, T0, 900, 120)
    expect(post).not.toBeNull()
    expect(post?.passive).toBe(false)
    // Rider-confirmed copy: the two numbers and nothing else.
    expect(post?.title).toBe('🚲 13 min ride · 2 min wait')
    expect(post?.message).toBe('')
    expect(next?.state).toBe('tight')
  })

  it('shows no card off an access leg or without a transit leg ahead', () => {
    // Aboard the bus: the pacing question is already answered.
    expect(tick(null, T0, 900, 120, { currentLeg: busLeg }).post).toBeNull()
    expect(
      tick(null, T0, 900, 120, { nextLeg: { mode: 'BICYCLE' } }).post
    ).toBeNull()
  })

  it('covers WALK legs too, with the verb and icon swapped', () => {
    const walkLeg = { mode: 'WALK', startTime: 1000 } as any
    const { next, post } = tick(null, T0, 900, 120, { currentLeg: walkLeg })
    expect(post).not.toBeNull()
    expect(post?.title).toBe('🚶 13 min walk · 2 min wait')
    expect(post?.passive).toBe(false)
    expect(next?.state).toBe('tight')
  })

  it('paces a walk leg on the same cadence as a bike leg', () => {
    const walkLeg = { mode: 'WALK', startTime: 1000 } as any
    const opts = { currentLeg: walkLeg }
    const first = tick(null, T0, 900, 300, opts).next
    // Under the 2-min move / 90 s floor: silent, exactly as on a bike.
    expect(tick(first, T0 + 30_000, 900, 480, opts).post).toBeNull()
    // A worsening edge still jumps the floor and alerts.
    const worse = tick(first, T0 + 20_000, 900, -30, opts)
    expect(worse.post?.passive).toBe(false)
    expect(worse.post?.title).toBe('🚶 16 min walk · 1 min short')
  })

  it('clears the card once the data goes away (boarded)', () => {
    const first = tick(null, T0, 900, 300).next
    const gone = evaluatePacingCard(first, {
      currentLeg: busLeg,
      enabled: true,
      nextLeg: undefined,
      nowMs: T0 + 60_000,
      progress: {} as any
    })
    expect(gone.next).toBeNull()
    expect(gone.post).toBeNull()
    // The wrist is still showing the ride advice until someone cancels it.
    expect(gone.clear).toBe(true)
  })

  it('has nothing to clear when no card was showing', () => {
    const gone = evaluatePacingCard(null, {
      currentLeg: busLeg,
      enabled: true,
      nextLeg: undefined,
      nowMs: T0,
      progress: {} as any
    })
    expect(gone.clear).toBe(false)
  })

  it('leaves the wrist untouched when disabled, rather than clearing it', () => {
    // Replay, or config.goMode.pacingCard off. A replay must not cancel a card
    // the live trip put there.
    const showing = tick(null, T0, 900, 300).next
    const d = evaluatePacingCard(showing, {
      currentLeg: busLeg,
      enabled: false,
      nextLeg: undefined,
      nowMs: T0 + 60_000,
      progress: {} as any
    })
    expect(d).toEqual({ clear: false, next: showing, post: null })
  })

  it('stays quiet while the buffer holds steady', () => {
    let state = tick(null, T0, 900, 300).next
    let posts = 0
    // 10 minutes of ticks, buffer drifting well under the 2-min threshold.
    for (let s = 5; s <= 600; s += 5) {
      const r = tick(state, T0 + s * 1000, 900 - s, 300 + (s % 30 ? 10 : -10))
      if (r.post) posts += 1
      state = r.next
    }
    expect(posts).toBe(0)
  })

  it('re-posts passively when the buffer moves ≥2 min, but not before 90s', () => {
    const first = tick(null, T0, 900, 300).next
    // Buffer improved by 3 min only 30s in: too soon.
    expect(tick(first, T0 + 30_000, 900, 480).post).toBeNull()
    // Same change after the 90s floor: passive update.
    const later = tick(first, T0 + 120_000, 900, 480)
    expect(later.post).not.toBeNull()
    expect(later.post?.passive).toBe(true)
  })

  it('a worsening pacing edge alerts immediately, ignoring the 90s floor', () => {
    const first = tick(null, T0, 900, 300).next // comfortable
    const r = tick(first, T0 + 20_000, 900, -30) // now atRisk, 20s later
    expect(r.post).not.toBeNull()
    expect(r.post?.passive).toBe(false)
    expect(r.post?.priority).toBe(1)
    // A shortfall keeps the same two-number shape, without a minus sign (12.16).
    expect(r.post?.title).toContain('1 min short')
    expect(r.next?.state).toBe('atRisk')
  })

  // 12.16, the rider on 2026-09-21 17:06:53: "I'm sick of the negative minute
  // wait notifications." This card was the surface — a native push, which is
  // why no ADD_NOTIFICATION in any day file ever carried the minus sign.
  describe('never shows a negative wait (12.16)', () => {
    it('says "N min short" while the bus is still ahead of the rider', () => {
      // 5 min to the bus, but the rider is 90 s further away than that.
      const { post } = tick(null, T0, 300, -90)
      expect(post?.title).toBe('🚲 7 min ride · 2 min short')
      expect(post?.title).not.toMatch(/[-−]\s?\d/u)
    })

    it('says "due" once the departure itself is in the past', () => {
      // The 17:06:53 tick, to the second: waitTimeAtStop -237 s against a board
      // epoch already 237 s gone, on a BICYCLE access leg. Was
      // "🚲 0 min ride · −4 min wait"; the bus actually arrived at 17:08:18.
      const { post } = tick(null, T0, -237, -237)
      expect(post?.title).toBe('🚲 0 min ride · due')
      expect(post?.title).not.toMatch(/[-−]\s?\d/u)
    })

    it('never says the bus has departed — the card cannot know that', () => {
      expect(tick(null, T0, -237, -237).post?.title).not.toMatch(
        /departed|gone|missed/i
      )
    })

    it('stays clean for every tick of the 17:06:06–17:08:17 window', () => {
      // 132 consecutive negative-wait ticks on mubq7tfx-8dz3ar ride 2, walked
      // here at the measured rate (-187 s to -317 s): none may print a sign.
      let state: PacingCardState | null = null
      const titles: string[] = []
      for (let s = -187; s >= -317; s -= 1) {
        const r = tick(state, T0 + (s + 187) * -1000, s, s)
        if (r.post) titles.push(r.post.title)
        state = r.next ?? state
      }
      expect(titles.length).toBeGreaterThan(0)
      expect(titles.filter((t) => /[-−]\s?\d/u.test(t))).toEqual([])
      expect(titles.filter((t) => !t.endsWith('· due'))).toEqual([])
    })
  })

  it('an improving edge waits for the floor and updates passively', () => {
    const first = tick(null, T0, 900, -30).next // atRisk
    expect(tick(first, T0 + 30_000, 900, 400).post).toBeNull()
    const later = tick(first, T0 + 100_000, 900, 400)
    expect(later.post).not.toBeNull()
    expect(later.post?.passive).toBe(true)
    expect(later.next?.state).toBe('comfortable')
  })

  it('a new bike leg is a fresh card', () => {
    const first = tick(null, T0, 900, 300).next
    const nextBike = { mode: 'BICYCLE', startTime: 2000 } as any
    const r = tick(first, T0 + 10_000, 900, 300, { currentLeg: nextBike })
    expect(r.post).not.toBeNull()
    expect(r.post?.passive).toBe(false)
  })
})
