/* globals afterEach, beforeEach, describe, expect, it */
import FakeTimers from '@sinonjs/fake-timers'

import {
  ABOARD_CHECK_MAX_CONCURRENT,
  ABOARD_CHECK_SETTLE_MS,
  ONBOARD_CANDIDATE_SETTLE_MS,
  paceCandidatePlans,
  settleCandidatePlans
} from '../../../lib/util/go-mode/alight-optimizer'

/**
 * Backlog 56.1 (2026-10-19, ride mvfqu4i0-yd2epd): the aboard get-off check
 * sent its 7-8 plans at once and 3-7 hit the 12 s deadline every check, the
 * planned stop among them. paceCandidatePlans asks the planned stop alone,
 * then the rest two at a time.
 */

type R = { error: boolean; i: number; skipped?: boolean }

describe('paceCandidatePlans', () => {
  let clock: FakeTimers.InstalledClock
  beforeEach(() => {
    clock = FakeTimers.install({ now: 0, toFake: ['setTimeout', 'Date'] })
  })
  afterEach(() => clock.uninstall())

  /** A server stub: each plan answers after `ms(i)`, logging concurrency. */
  const server = (ms: (i: number) => number, fail: Set<number> = new Set()) => {
    const log: string[] = []
    let inFlight = 0
    let peak = 0
    const start = (i: number) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      log.push(`start ${i}`)
      return new Promise<R>((resolve) =>
        setTimeout(() => {
          inFlight--
          log.push(`end ${i}`)
          resolve({ error: fail.has(i), i })
        }, ms(i))
      )
    }
    return { log, peak: () => peak, start }
  }
  const opts = (firstIndex: number | null) => ({
    firstIndex,
    isFailure: (r: R) => r.error,
    maxConcurrent: ABOARD_CHECK_MAX_CONCURRENT,
    onSkip: (i: number): R => ({ error: true, i, skipped: true })
  })

  it('asks the first alone, then the rest at most two at a time', async () => {
    const s = server(() => 2000)
    const { plans } = paceCandidatePlans(6, s.start, opts(5))
    const all = Promise.all(plans)
    await clock.runAllAsync()
    const out = await all
    expect(s.log.slice(0, 3)).toEqual(['start 5', 'end 5', 'start 0'])
    expect(s.peak()).toBe(2)
    expect(out.map((r) => r.error)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false
    ])
  })

  it('sends nothing else when the first fails', async () => {
    const s = server(() => 2000, new Set([3]))
    const { plans } = paceCandidatePlans(5, s.start, opts(3))
    const all = Promise.all(plans)
    await clock.runAllAsync()
    const out = await all
    expect(s.log).toEqual(['start 3', 'end 3'])
    expect(out.filter((r) => r.skipped).length).toBe(4)
  })

  it('without a first, it is only the width cap', async () => {
    const s = server(() => 1000)
    const { plans } = paceCandidatePlans(5, s.start, opts(null))
    const all = Promise.all(plans)
    await clock.runAllAsync()
    await all
    expect(s.log[0]).toBe('start 0')
    expect(s.peak()).toBe(2)
  })

  it('stop() keeps queued plans from starting', async () => {
    const s = server(() => 5000)
    const paced = paceCandidatePlans(6, s.start, opts(0))
    await clock.tickAsync(6000) // first done, two more in flight
    paced.stop()
    await clock.runAllAsync()
    expect(s.log.filter((l) => l.startsWith('start')).length).toBe(3)
  })

  /**
   * The 2026-10-19 load shape, as a model fitted to what was measured: a plan
   * takes ~2 s per plan in flight when it is sent (alone 1.4-2.0 s; two at
   * once 1.6 / 3.0 s; eight at once 3 of 8 answered in 5.8-9.0 s and the rest
   * passed 12 s), and the fetch layer gives up at 12 s. The planned stop is
   * the last of the eight in the downstream order, as Washington was.
   */
  it('2026-10-19 shape: the burst loses the planned stop, the paced run keeps it', async () => {
    const DEADLINE = 12000
    let inFlight = 0
    const start = (i: number) => {
      inFlight++
      const took = 2000 * inFlight
      return new Promise<R>((resolve) =>
        setTimeout(() => {
          inFlight--
          resolve({ error: took > DEADLINE, i })
        }, Math.min(took, DEADLINE))
      )
    }
    const PLANNED = 7
    const sub = (i: number): R => ({ error: true, i })

    const burst = settleCandidatePlans(
      Array.from({ length: 8 }, (_, i) => start(i)),
      ONBOARD_CANDIDATE_SETTLE_MS,
      sub
    )
    await clock.runAllAsync()
    const before = await burst
    inFlight = 0
    const paced = paceCandidatePlans(8, start, opts(PLANNED))
    const settled = settleCandidatePlans(
      paced.plans,
      ABOARD_CHECK_SETTLE_MS,
      sub
    )
    const t0 = Date.now()
    let doneAt = 0
    settled.then(() => (doneAt = Date.now()))
    await clock.runAllAsync()
    const after = await settled
    const wall = doneAt - t0

    // eslint-disable-next-line no-console
    console.log(
      `burst: ${before.filter((r) => !r.error).length}/8 answered, planned ${
        before[PLANNED].error ? 'TIMED OUT' : 'answered'
      }; paced: ${after.filter((r) => !r.error).length}/8, planned ${
        after[PLANNED].error ? 'TIMED OUT' : 'answered'
      }, ${wall / 1000} s wall`
    )
    expect(before[PLANNED].error).toBe(true)
    expect(after[PLANNED].error).toBe(false)
    expect(after.every((r) => !r.error)).toBe(true)
    expect(wall).toBeLessThan(ABOARD_CHECK_SETTLE_MS)
  })
})
