import {
  evaluateMissedBusRecovery,
  MISSED_BUS_REROUTE_MAX_ATTEMPTS,
  MISSED_BUS_REROUTE_RETRY_MS
} from '../../../lib/util/go-mode/missed-bus-recovery'
import type { MissedBusAttempt } from '../../../lib/util/go-mode/missed-bus-recovery'
import type { MissedBusContext } from '../../../lib/util/go-mode/notification-service'

const T0 = 1_785_516_757_402
const DEPARTURE = T0 + 300_000

const missed = (over: Partial<MissedBusContext> = {}): MissedBusContext => ({
  boardLegIndex: 1,
  definitive: true,
  effectiveBoardMs: DEPARTURE,
  realtime: true,
  ...over
})

const tick = (
  prev: MissedBusAttempt | null,
  over: {
    justRaised?: boolean
    missed?: MissedBusContext | null
    nowMs?: number
    reRouteStatus?: string
  } = {}
) =>
  evaluateMissedBusRecovery(prev, {
    justRaised: over.justRaised ?? false,
    missed: over.missed === undefined ? missed() : over.missed,
    nowMs: over.nowMs ?? T0,
    reRouteStatus: over.reRouteStatus ?? 'idle'
  })

describe('util > go-mode > missed-bus recovery', () => {
  it('does nothing, and forgets nothing, when no bus was missed', () => {
    const carried: MissedBusAttempt = {
      attempts: 2,
      departureMs: DEPARTURE,
      lastAtMs: T0
    }
    expect(tick(carried, { missed: null })).toEqual({
      autoApply: false,
      next: carried,
      replan: false
    })
  })

  it('re-plans the moment a definitive miss is raised, and auto-applies', () => {
    const d = tick(null, { justRaised: true })
    expect(d.replan).toBe(true)
    // No prompt: the rider watching their bus pull away does not want a question.
    expect(d.autoApply).toBe(true)
    expect(d.next).toEqual({
      attempts: 1,
      departureMs: DEPARTURE,
      lastAtMs: T0
    })
  })

  it('plans but never applies when the miss is ambiguous', () => {
    const d = tick(null, {
      justRaised: true,
      missed: missed({ definitive: false })
    })
    expect(d.replan).toBe(true)
    // The whole point of `definitive`: an ambiguous miss must not swap the
    // rider's route on a guess. It shows what it found instead.
    expect(d.autoApply).toBe(false)
  })

  it('an ambiguous miss searches without waiting to be told it was raised', () => {
    // It cannot lean on justRaised the way a definitive miss does: nothing
    // pushes a notification for an ambiguous miss any more (checkMissedBus
    // returns null for one and waits for the outcome), so justRaised is false
    // on every tick of it. A fresh record with lastAtMs 0 is what makes the
    // first search due immediately.
    const d = tick(null, { missed: missed({ definitive: false }) })
    expect(d.replan).toBe(true)
    expect(d.next).toEqual({
      attempts: 1,
      departureMs: DEPARTURE,
      lastAtMs: T0
    })
  })

  it('gives an ambiguous miss that found nothing the same second look', () => {
    // Before 2026-09-03 retryDue was definitive-only, so an ambiguous miss got
    // exactly one attempt and, if it came back empty, the rider standing at the
    // stop was never looked at again.
    const spent: MissedBusAttempt = {
      attempts: 1,
      departureMs: DEPARTURE,
      lastAtMs: T0
    }
    const d = tick(spent, {
      missed: missed({ definitive: false }),
      nowMs: T0 + MISSED_BUS_REROUTE_RETRY_MS,
      reRouteStatus: 'none'
    })
    expect(d.replan).toBe(true)
    expect(d.autoApply).toBe(false)
  })

  it('does not re-search over alternatives the rider is being shown', () => {
    // 'found' means the candidates are in the planner under them.
    const spent: MissedBusAttempt = {
      attempts: 1,
      departureMs: DEPARTURE,
      lastAtMs: T0
    }
    expect(
      tick(spent, {
        missed: missed({ definitive: false }),
        nowMs: T0 + MISSED_BUS_REROUTE_RETRY_MS * 5,
        reRouteStatus: 'found'
      }).replan
    ).toBe(false)
  })

  it('supersedes results already on screen, but never an in-flight search', () => {
    expect(
      tick(null, { justRaised: true, reRouteStatus: 'found' }).replan
    ).toBe(true)
    expect(
      tick(null, { justRaised: true, reRouteStatus: 'searching' }).replan
    ).toBe(false)
  })

  it('leaves an ambiguous miss alone once results are showing', () => {
    // Only 'idle' lets an ambiguous miss through; it has no claim to replace
    // alternatives the rider is already reading.
    const d = tick(null, {
      justRaised: true,
      missed: missed({ definitive: false }),
      reRouteStatus: 'found'
    })
    expect(d.replan).toBe(false)
  })

  it('retries a failed auto-update on its own schedule, not the alert dedup', () => {
    // The MISSED_BUS notification dedups for 30 minutes. Recovery must not.
    let state = tick(null, { justRaised: true }).next
    expect(state?.attempts).toBe(1)

    // Too soon.
    const early = tick(state, {
      nowMs: T0 + MISSED_BUS_REROUTE_RETRY_MS - 1,
      reRouteStatus: 'none'
    })
    expect(early.replan).toBe(false)
    expect(early.next?.attempts).toBe(1)

    // A minute later, with the last attempt settled as failed.
    const due = tick(state, {
      nowMs: T0 + MISSED_BUS_REROUTE_RETRY_MS,
      reRouteStatus: 'none'
    })
    expect(due.replan).toBe(true)
    expect(due.next?.attempts).toBe(2)
    state = due.next
  })

  it('never retries over a search in flight or a card being read', () => {
    const state: MissedBusAttempt = {
      attempts: 1,
      departureMs: DEPARTURE,
      lastAtMs: T0
    }
    const later = T0 + MISSED_BUS_REROUTE_RETRY_MS * 5
    expect(
      tick(state, { nowMs: later, reRouteStatus: 'searching' }).replan
    ).toBe(false)
    expect(tick(state, { nowMs: later, reRouteStatus: 'found' }).replan).toBe(
      false
    )
    expect(tick(state, { nowMs: later, reRouteStatus: 'error' }).replan).toBe(
      false
    )
    expect(tick(state, { nowMs: later, reRouteStatus: 'none' }).replan).toBe(
      true
    )
  })

  it('gives up after the cap so a dead network cannot retry forever', () => {
    let state: MissedBusAttempt | null = null
    let now = T0
    let replans = 0
    for (let i = 0; i < 20; i++) {
      const d = evaluateMissedBusRecovery(state, {
        justRaised: i === 0,
        missed: missed(),
        nowMs: now,
        reRouteStatus: 'none'
      })
      if (d.replan) replans += 1
      state = d.next
      now += MISSED_BUS_REROUTE_RETRY_MS
    }
    expect(replans).toBe(MISSED_BUS_REROUTE_MAX_ATTEMPTS)
    expect(state?.attempts).toBe(MISSED_BUS_REROUTE_MAX_ATTEMPTS)
  })

  it('starts a fresh count for the next departure missed', () => {
    // The rider missed the 09:05, recovery moved them to the 09:20, and they
    // missed that too. The second miss gets its own five attempts.
    const spent: MissedBusAttempt = {
      attempts: MISSED_BUS_REROUTE_MAX_ATTEMPTS,
      departureMs: DEPARTURE,
      lastAtMs: T0
    }
    const nextBus = missed({ effectiveBoardMs: DEPARTURE + 900_000 })
    const d = tick(spent, {
      missed: nextBus,
      nowMs: T0 + 60_000,
      reRouteStatus: 'none'
    })
    expect(d.replan).toBe(true)
    expect(d.next).toEqual({
      attempts: 1,
      departureMs: nextBus.effectiveBoardMs,
      lastAtMs: T0 + 60_000
    })
  })

  it('does not mutate the record it was handed', () => {
    const prev: MissedBusAttempt = {
      attempts: 1,
      departureMs: DEPARTURE,
      lastAtMs: T0
    }
    const frozen = { ...prev }
    tick(prev, {
      nowMs: T0 + MISSED_BUS_REROUTE_RETRY_MS,
      reRouteStatus: 'none'
    })
    expect(prev).toEqual(frozen)
  })
})
