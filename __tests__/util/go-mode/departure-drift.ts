import {
  DepartureBaselineState,
  evaluateDepartureDrift,
  paceAdvice
} from '../../../lib/util/go-mode/departure-drift'

const T0 = 1_700_000_000_000
const MIN = 60_000
// The boarding as first predicted: 20 minutes out.
const BASE_DEPARTURE = T0 + 20 * MIN
const KEY = '1:1:1085482:plan'

const tick = (
  prev: DepartureBaselineState | null,
  liveDepartureMs: number | null,
  opts: {
    boardingKey?: string | null
    nowMs?: number
    waitSeconds?: number
  } = {}
) =>
  evaluateDepartureDrift(prev, {
    boardingKey: opts.boardingKey === undefined ? KEY : opts.boardingKey,
    liveDepartureMs,
    nowMs: opts.nowMs ?? T0,
    routeName: '22',
    waitSeconds: opts.waitSeconds ?? 600
  })

/** The state after the boarding has been seen once at its original time. */
const baselined = (): DepartureBaselineState =>
  tick(null, BASE_DEPARTURE).next as DepartureBaselineState

describe('util > go-mode > departure-drift', () => {
  describe('paceAdvice', () => {
    it('speaks the same three states the pacing card buzzes on', () => {
      expect(paceAdvice(-60)).toBe('hurry')
      expect(paceAdvice(60)).toBe('pick up the pace')
      expect(paceAdvice(900)).toBe('take your time')
    })
  })

  it('never alerts on first sight — it records the baseline', () => {
    const { alert, next } = tick(null, BASE_DEPARTURE)
    expect(alert).toBeNull()
    expect(next).toEqual({
      baselineMs: BASE_DEPARTURE,
      boardingKey: KEY,
      lastAlertedDriftMs: 0
    })
  })

  it('stays silent while the prediction wobbles under 2 min', () => {
    let state = baselined()
    let alerts = 0
    // Six minutes of 20 s polls, the prediction jittering ±90 s.
    for (let s = 20; s <= 360; s += 20) {
      const jitter = (s % 40 ? 1 : -1) * 90 * 1000
      const r = tick(state, BASE_DEPARTURE + jitter, { nowMs: T0 + s * 1000 })
      if (r.alert) alerts += 1
      state = r.next as DepartureBaselineState
    }
    expect(alerts).toBe(0)
  })

  it('alerts once when the bus slips 2 min, and not again at 2:30', () => {
    const state = baselined()
    const slipped = tick(state, BASE_DEPARTURE + 2 * MIN, { waitSeconds: 900 })
    expect(slipped.alert).not.toBeNull()
    expect(slipped.alert?.type).toBe('DEPARTURE_CHANGED')
    expect(slipped.alert?.message).toBe(
      '2 min later than first estimated — take your time, 15 min slack at the stop.'
    )
    // A bus handing the rider MORE slack is news, not an emergency: no buzz.
    expect(slipped.alert?.priority).toBe('medium')

    // 30 s further is still the same story — the rider was already told.
    expect(
      tick(slipped.next, BASE_DEPARTURE + 2.5 * MIN, { waitSeconds: 900 }).alert
    ).toBeNull()
  })

  it('re-alerts on each further 2 min, quoting drift from the baseline', () => {
    const first = tick(baselined(), BASE_DEPARTURE + 2 * MIN)
    const second = tick(first.next, BASE_DEPARTURE + 4 * MIN)
    expect(second.alert?.message).toContain('4 min later than first estimated')
    const third = tick(second.next, BASE_DEPARTURE + 6 * MIN)
    expect(third.alert?.message).toContain('6 min later than first estimated')
    // Total drift, never a per-alert increment.
    expect(third.next?.lastAlertedDriftMs).toBe(6 * MIN)
  })

  it('a bus moving EARLIER says hurry, and buzzes', () => {
    // Departure pulled 3 min earlier, leaving 40 s of slack at the stop.
    const r = tick(baselined(), BASE_DEPARTURE - 3 * MIN, { waitSeconds: 40 })
    expect(r.alert?.title).toBe(
      `22 now ${new Date(BASE_DEPARTURE - 3 * MIN).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
      })}`
    )
    expect(r.alert?.message).toBe(
      '3 min earlier than first estimated — pick up the pace, 1 min slack at the stop.'
    )
    expect(r.alert?.priority).toBe('high')
  })

  it('reports a negative buffer as short, not as slack', () => {
    const r = tick(baselined(), BASE_DEPARTURE - 4 * MIN, { waitSeconds: -90 })
    expect(r.alert?.message).toBe(
      '4 min earlier than first estimated — hurry, 2 min short at the stop.'
    )
  })

  it('never rounds a shortfall down to a reassuring zero', () => {
    // 30 s short: Math.round would render "0 min slack", the one thing this
    // sentence must not say. Same rule as the pacing card's copy.
    const r = tick(baselined(), BASE_DEPARTURE - 3 * MIN, { waitSeconds: -30 })
    expect(r.alert?.message).toContain('1 min short at the stop')
  })

  it('reports a bus that gives the time back', () => {
    const late = tick(baselined(), BASE_DEPARTURE + 6 * MIN)
    expect(late.alert).not.toBeNull()
    const recovered = tick(late.next, BASE_DEPARTURE)
    expect(recovered.alert?.message).toContain('Back to the original time')
    expect(recovered.next?.lastAlertedDriftMs).toBe(0)
  })

  it('re-baselines silently when the boarding itself changes', () => {
    const state = baselined()
    // The auto-anchor adopted an earlier run: different trip, different key.
    // That is a different bus, not a jump, so it must not alert.
    const swapped = tick(state, BASE_DEPARTURE - 8 * MIN, {
      boardingKey: '1:1:1085999:plan'
    })
    expect(swapped.alert).toBeNull()
    expect(swapped.next).toEqual({
      baselineMs: BASE_DEPARTURE - 8 * MIN,
      boardingKey: '1:1:1085999:plan',
      lastAlertedDriftMs: 0
    })
  })

  it('ignores a prediction the feed has left behind the clock', () => {
    // The 8/9 failure: an UPDATED stop time reading minutes in the past while
    // the bus is still coming. Whether it has gone is classifyMissedBus's call.
    const state = baselined()
    const poisoned = tick(state, T0 - 5 * MIN)
    expect(poisoned.alert).toBeNull()
    // The baseline survives, so the next honest poll is still measured.
    expect(poisoned.next).toEqual(state)
  })

  it('holds the baseline through a realtime dropout', () => {
    const state = baselined()
    const dropped = tick(state, null)
    expect(dropped.alert).toBeNull()
    expect(dropped.next).toEqual(state)
    // And the drift is still measured from the ORIGINAL estimate afterwards.
    expect(
      tick(dropped.next, BASE_DEPARTURE + 5 * MIN).alert?.message
    ).toContain('5 min later')
  })

  it('watches nothing when there is no boarding ahead', () => {
    const r = tick(baselined(), BASE_DEPARTURE + 9 * MIN, { boardingKey: null })
    expect(r.alert).toBeNull()
    expect(r.next).toBeNull()
  })
})
