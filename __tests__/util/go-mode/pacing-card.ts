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
    expect(worse.post?.title).toBe('🚶 16 min walk · −1 min wait')
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
    // A negative projected wait keeps the same two-number shape.
    expect(r.post?.title).toContain('−1 min wait')
    expect(r.next?.state).toBe('atRisk')
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
