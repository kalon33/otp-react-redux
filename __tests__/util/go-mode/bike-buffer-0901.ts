import {
  evaluatePacingCard,
  PacingCardState
} from '../../../lib/util/go-mode/pacing-card'

/**
 * 2026-09-01, the rider's own ask (backlog 6.10a):
 *
 *   "Biking notifications about how much flex or buffer we have after movement
 *    is detected on bike legs. Only notify if bus time is live."
 *
 * It was blocked on 6.4, which is why it is worth being precise about what
 * changed. Before that fix the closing bike leg's countdown was clamped to 0
 * for 487 consecutive ticks from 1068 m out, so "how much flex do I have" had
 * no honest travel time to be measured against; the plan's own
 * `duration × (1 − progress)` was the only figure available, and on that ride
 * it described a 3.3 m/s cyclist while the rider was doing 7.5.
 *
 * So the buffer here is built out of two facts and nothing else: the feed's
 * predicted departure (the caller only hands one over when `boardRealtime` is
 * set — a non-realtime board epoch has been clamped forward to `now` and would
 * read as a bus perpetually about to leave), and the ground still ahead
 * divided by the pace the rider is actually keeping. The rolling estimate in
 * rider-speed.ts answers null until eight moving fixes span a minute, which IS
 * "after movement is detected" — no separate latch.
 *
 * The numbers below are the shape of that leg: 2000 m planned at 600 s
 * (3.33 m/s), the rider a quarter of the way along it at 7.5 m/s, and a bus
 * fifteen minutes out.
 */

const bikeLeg = {
  distance: 2000,
  duration: 600,
  mode: 'BICYCLE',
  startTime: 1000
} as any
const busLeg = { mode: 'BUS', routeShortName: '535', transitLeg: true } as any

const T0 = 1_788_270_000_000

const prog = (
  dueSecs: number,
  waitSecs: number,
  legPct = 25,
  overridden = false
): any => ({
  currentLegProgress: legPct,
  departureIsOverridden: overridden,
  timeUntilNextDeparture: dueSecs,
  waitTimeAtStop: waitSecs
})

const tick = (
  prev: PacingCardState | null,
  opts: {
    dueSecs?: number
    legPct?: number
    liveBoardEpochMs?: number | null
    nowMs?: number
    observedSpeedMps?: number | null
    overridden?: boolean
    waitSecs?: number
  } = {}
) =>
  evaluatePacingCard(prev, {
    currentLeg: bikeLeg,
    enabled: true,
    liveBoardEpochMs:
      opts.liveBoardEpochMs === undefined
        ? (opts.nowMs ?? T0) + 900_000
        : opts.liveBoardEpochMs,
    nextLeg: busLeg,
    nowMs: opts.nowMs ?? T0,
    observedSpeedMps:
      opts.observedSpeedMps === undefined ? 7.5 : opts.observedSpeedMps,
    progress: prog(
      opts.dueSecs ?? 900,
      opts.waitSecs ?? 450,
      opts.legPct ?? 25,
      opts.overridden ?? false
    )
  })

describe('the live bike buffer (rider ask, 2026-09-01)', () => {
  it('measures flex against the feed and the rider’s own pace', () => {
    // 1500 m still ahead at 7.5 m/s = 200 s of riding; the bus is 900 s out,
    // so the flex at the stop is 700 s. The PLAN says 450 s of riding and
    // 450 s of wait — which is the pair the card used to show.
    const { next, post } = tick(null)
    expect(post?.title).toBe('🚲 3 min ride · 12 min wait')
    expect(next?.live).toBe(true)
    expect(next?.bufferMin).toBe(12)
  })

  it('scales the ground ahead by how far along the leg the rider is', () => {
    // Three quarters done: 500 m at 7.5 m/s = 67 s, so the flex is 833 s.
    const { post } = tick(null, { legPct: 75 })
    expect(post?.title).toBe('🚲 1 min ride · 14 min wait')
  })

  it('stays on the plan wait until movement has been detected', () => {
    // No rolling estimate yet = the rider has not been measurably moving on
    // this leg, so there is no observed pace to divide by and nothing that
    // deserves to be called flex.
    const { next, post } = tick(null, { observedSpeedMps: null })
    expect(post?.title).toBe('🚲 8 min ride · 8 min wait')
    expect(next?.live).toBe(false)
  })

  it('stays on the plan wait when the bus time is not live', () => {
    const { next, post } = tick(null, { liveBoardEpochMs: null })
    expect(post?.title).toBe('🚲 8 min ride · 8 min wait')
    expect(next?.live).toBe(false)
  })

  it('leaves a departure the rider picked themselves alone', () => {
    // liveLegTimes tracks the PLANNED leg's trip, so once the rider has chosen
    // a different bus the feed's epoch is a vehicle they are not taking.
    const { next, post } = tick(null, { overridden: true })
    expect(post?.title).toBe('🚲 8 min ride · 8 min wait')
    expect(next?.live).toBe(false)
  })

  it('buzzes when the live flex loses two minutes inside one pacing band', () => {
    const first = tick(null).next
    expect(first?.bufferMin).toBe(12)
    // 100 s later the rider is grinding at 3 m/s: 500 s of riding against a
    // bus 800 s out leaves 300 s of flex. Still "comfortable" — the old
    // band-crossing rule would say nothing — but seven minutes of flex are
    // gone, which is precisely what the rider asked to be told.
    const second = tick(first, {
      dueSecs: 800,
      liveBoardEpochMs: T0 + 900_000,
      nowMs: T0 + 100_000,
      observedSpeedMps: 3
    })
    expect(second.post).not.toBeNull()
    expect(second.post?.passive).toBe(false)
    expect(second.post?.title).toBe('🚲 8 min ride · 5 min wait')
  })

  it('says nothing about a minute of drift', () => {
    const first = tick(null).next
    // 100 s on, at the same pace, with the feed having slipped the bus a
    // minute: 12 min of flex reads as 11. Under the step, so the wrist is
    // left alone.
    const second = tick(first, {
      dueSecs: 800,
      liveBoardEpochMs: T0 + 960_000,
      nowMs: T0 + 100_000
    })
    expect(second.post).toBeNull()
    expect(second.next).toBe(first)
  })

  it('updates silently when the flex improves', () => {
    // Established tight, then the rider picks up speed and gains flex. More
    // room than expected is a glance, never a buzz.
    const first = tick(null, { observedSpeedMps: 2.1 }).next
    expect(first?.bufferMin).toBe(3)
    const second = tick(first, {
      dueSecs: 800,
      liveBoardEpochMs: T0 + 900_000,
      nowMs: T0 + 100_000,
      observedSpeedMps: 7.5
    })
    expect(second.post).not.toBeNull()
    expect(second.post?.passive).toBe(true)
    expect(second.next?.bufferMin).toBe(10)
  })

  it('does not compare a live buffer with a plan-derived one', () => {
    // The feed dropping out mid-leg changes the EVIDENCE, not the trip. A
    // 12 min live buffer becoming an 8 min planned one is not four minutes of
    // lost flex and must not buzz like it.
    const first = tick(null).next
    const second = tick(first, {
      liveBoardEpochMs: null,
      nowMs: T0 + 100_000
    })
    expect(second.post?.passive).toBe(true)
    expect(second.next?.live).toBe(false)
  })
})
