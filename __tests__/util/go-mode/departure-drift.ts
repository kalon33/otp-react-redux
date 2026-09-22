import {
  DepartureBaselineState,
  evaluateDepartureDrift
} from '../../../lib/util/go-mode/departure-drift'

const T0 = 1_700_000_000_000
const MIN = 60_000
// The boarding as first predicted: 20 minutes out.
const BASE_DEPARTURE = T0 + 20 * MIN
const KEY = '1:1:1085482:plan'

// The rider's cadence (24.4) is 5 min between departure-change pushes, so a
// tick that means to test the ±2 min STEP has to stand outside that window.
// QUIET is the default nowMs offset for exactly that reason; a test about the
// cadence itself passes its own nowMs.
const QUIET = 6 * MIN

const tick = (
  prev: DepartureBaselineState | null,
  liveDepartureMs: number | null,
  opts: {
    boardingKey?: string | null
    lastBoardMinutesPushAtMs?: number | null
    nowMs?: number
    toldDepartureMs?: number | null
    waitSeconds?: number
  } = {}
) =>
  evaluateDepartureDrift(prev, {
    boardingKey: opts.boardingKey === undefined ? KEY : opts.boardingKey,
    lastBoardMinutesPushAtMs: opts.lastBoardMinutesPushAtMs ?? null,
    liveDepartureMs,
    nowMs: opts.nowMs ?? T0,
    routeName: '22',
    toldDepartureMs: opts.toldDepartureMs ?? null,
    waitSeconds: opts.waitSeconds ?? 600
  })

/** The state after the boarding has been seen once at its original time. */
const baselined = (): DepartureBaselineState =>
  tick(null, BASE_DEPARTURE).next as DepartureBaselineState

describe('util > go-mode > departure-drift', () => {
  it('never alerts on first sight — it records the baseline', () => {
    const { alert, next } = tick(null, BASE_DEPARTURE)
    expect(alert).toBeNull()
    expect(next).toEqual({
      baselineMs: BASE_DEPARTURE,
      boardingKey: KEY,
      lastAlertAtMs: null,
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
    expect(slipped.alert?.message).toBe('2 min later · 15 min slack')
    // The rider's standing rule: no pacing words ("take your time"), and the
    // title carries minutes-away, never a clock time.
    expect(slipped.alert?.title).toBe('22 · 22 min')
    expect(slipped.alert?.message).not.toMatch(/[ap]m/i)
    // A bus handing the rider MORE slack is news, not an emergency: no buzz.
    expect(slipped.alert?.priority).toBe('medium')

    // 30 s further is still the same story — the rider was already told.
    expect(
      tick(slipped.next, BASE_DEPARTURE + 2.5 * MIN, { waitSeconds: 900 }).alert
    ).toBeNull()
  })

  it('re-alerts on each further 2 min once the 5-min window has passed', () => {
    const first = tick(baselined(), BASE_DEPARTURE + 2 * MIN)
    const second = tick(first.next, BASE_DEPARTURE + 4 * MIN, {
      nowMs: T0 + QUIET
    })
    expect(second.alert?.message).toContain('4 min later')
    const third = tick(second.next, BASE_DEPARTURE + 6 * MIN, {
      nowMs: T0 + 2 * QUIET
    })
    expect(third.alert?.message).toContain('6 min later')
    // Total drift, never a per-alert increment.
    expect(third.next?.lastAlertedDriftMs).toBe(6 * MIN)
  })

  it('a bus moving EARLIER buzzes, and says so without coaching', () => {
    // Departure pulled 3 min earlier, leaving 40 s of slack at the stop.
    const r = tick(baselined(), BASE_DEPARTURE - 3 * MIN, { waitSeconds: 40 })
    // Minutes away, not a clock time: the rider's rule, and what a rider on
    // the pavement actually uses.
    expect(r.alert?.title).toBe('22 · 17 min')
    expect(r.alert?.message).toBe('3 min earlier · 1 min slack')
    // The haptic carries the urgency; the words must not.
    expect(r.alert?.message).not.toMatch(/hurry|pace|take your time/i)
    expect(r.alert?.priority).toBe('high')
  })

  it('reports a negative buffer as short, not as slack', () => {
    const r = tick(baselined(), BASE_DEPARTURE - 4 * MIN, { waitSeconds: -90 })
    expect(r.alert?.message).toBe('4 min earlier · 2 min short')
  })

  it('never rounds a shortfall down to a reassuring zero', () => {
    // 30 s short: Math.round would render "0 min slack", the one thing this
    // sentence must not say. Same rule as the pacing card's copy.
    const r = tick(baselined(), BASE_DEPARTURE - 3 * MIN, { waitSeconds: -30 })
    expect(r.alert?.message).toContain('1 min short')
  })

  it('reports a bus that gives the time back', () => {
    const late = tick(baselined(), BASE_DEPARTURE + 6 * MIN)
    expect(late.alert).not.toBeNull()
    const recovered = tick(late.next, BASE_DEPARTURE)
    expect(recovered.alert?.message).toContain('back on time')
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
      lastAlertAtMs: null,
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

  // Backlog 24.4. The rider on the board, 2026-09-21 22:42: "at most one
  // departure-change push per bus every 5 minutes unless the change is 5+
  // minutes or risks a miss, and the 'Bus coming' push must agree with it."
  describe("the rider's push cadence (24.4)", () => {
    it('holds a second alert inside 5 min even though the bus moved 2 min', () => {
      const first = tick(baselined(), BASE_DEPARTURE + 2 * MIN)
      expect(first.alert).not.toBeNull()
      // 100 s later, another 2 min of slip — the ±2 min step is met and the
      // cadence still says no.
      const held = tick(first.next, BASE_DEPARTURE + 4 * MIN, {
        nowMs: T0 + 100_000
      })
      expect(held.alert).toBeNull()
      // Held, not discarded: the figure the rider was last given is untouched.
      expect(held.next?.lastAlertedDriftMs).toBe(2 * MIN)
    })

    it('quotes TOTAL movement when the window finally opens, not the last step', () => {
      let s = baselined()
      s = tick(s, BASE_DEPARTURE + 2 * MIN).next as DepartureBaselineState
      // Two more minutes of slip, re-read across the window: all silent.
      for (let i = 1; i <= 3; i++) {
        const r = tick(s, BASE_DEPARTURE + 4 * MIN, { nowMs: T0 + i * 60_000 })
        expect(r.alert).toBeNull()
        s = r.next as DepartureBaselineState
      }
      // The window opens. One push, and it names the whole four minutes the
      // bus has moved, not the two it moved since the rider was last told.
      const out = tick(s, BASE_DEPARTURE + 4 * MIN, { nowMs: T0 + QUIET })
      expect(out.alert?.message).toContain('4 min later')
      expect(out.alert?.message).not.toContain('2 min later')
    })

    it('breaks the window for a change of 5 min or more', () => {
      const first = tick(baselined(), BASE_DEPARTURE + 2 * MIN)
      const jumped = tick(first.next, BASE_DEPARTURE + 7 * MIN, {
        nowMs: T0 + 30_000
      })
      expect(jumped.alert?.message).toContain('7 min later')
    })

    it('breaks the window when an EARLIER bus drops slack to the leave-now line', () => {
      const first = tick(baselined(), BASE_DEPARTURE + 4 * MIN, {
        waitSeconds: 600
      })
      expect(first.alert).not.toBeNull()
      // The bus hands 2 min back, and the rider now has 90 s — under
      // LEAVE_SOON's own threshold. Small change, shut window, still spoken.
      const risky = tick(first.next, BASE_DEPARTURE + 2 * MIN, {
        nowMs: T0 + 30_000,
        waitSeconds: 90
      })
      expect(risky.alert).not.toBeNull()
      expect(risky.alert?.priority).toBe('high')
    })

    it('does NOT break the window for a LATER bus, however little slack is left', () => {
      // A later departure hands slack over; it cannot be the thing that
      // creates the miss, so low slack alone must not reopen the window.
      const first = tick(baselined(), BASE_DEPARTURE + 2 * MIN)
      const later = tick(first.next, BASE_DEPARTURE + 4 * MIN, {
        nowMs: T0 + 30_000,
        waitSeconds: 30
      })
      expect(later.alert).toBeNull()
    })

    it("shares the window with 'Bus coming' / 'Leave in N min'", () => {
      // No drift alert yet, but the rider read a boarding push 60 s ago.
      const held = tick(baselined(), BASE_DEPARTURE + 3 * MIN, {
        lastBoardMinutesPushAtMs: T0 - 60_000
      })
      expect(held.alert).toBeNull()
      // Six minutes after that push, the same movement is news again.
      expect(
        tick(baselined(), BASE_DEPARTURE + 3 * MIN, {
          lastBoardMinutesPushAtMs: T0 - QUIET,
          nowMs: T0
        }).alert
      ).not.toBeNull()
    })

    it('folds in the figure "Bus coming" showed, and says nothing that tick', () => {
      const state = baselined()
      const folded = tick(state, BASE_DEPARTURE + 5 * MIN, {
        toldDepartureMs: BASE_DEPARTURE + 5 * MIN
      })
      expect(folded.alert).toBeNull()
      // The rider now holds "+5 min", so the next step is measured from there.
      expect(folded.next?.lastAlertedDriftMs).toBe(5 * MIN)
      expect(folded.next?.lastAlertAtMs).toBe(T0)
    })
  })

  // The ride that opened 24.4: `0921-1605-465-wrongdir.json`, session
  // mubq7tfx-8dz3ar. The 465's live board epoch as the feed actually published
  // it, and the pushes it actually produced.
  describe('replay: the 465 on 2026-09-21', () => {
    // [tick ms, boardEpoch] — every change in SET_LIVE_LEG_TIMES leg 1.
    const FEED: Array<[number, number]> = [
      [1790024859307, 1790025420000], // 16:07:39 -> board 16:17:00 (baseline)
      [1790025125182, 1790025462000], // 16:12:05 -> 16:17:42
      [1790025208138, 1790025522000], // 16:13:28 -> 16:18:42
      [1790025270195, 1790025592000], // 16:14:30 -> 16:19:52
      [1790025331221, 1790025662000], // 16:15:31 -> 16:21:02
      [1790025373174, 1790025725000], // 16:16:13 -> 16:22:05
      [1790025495259, 1790025804000], // 16:18:15 -> 16:23:24
      [1790025557185, 1790025865000], // 16:19:17 -> 16:24:25
      [1790025618280, 1790025935000], // 16:20:18 -> 16:25:35
      [1790025679186, 1790026005000] // 16:21:19 -> 16:26:45
    ]
    const LEAVE_SOON_AT = 1790024757055 // 16:05:57 "465 · 11 min"
    const APPROACH_AT = 1790025485094 // 16:18:05 "Bus coming · 465 · 4 min"
    const RIDE_KEY = '1:2:t64A-b156-sl1C-v64:plan'

    /** Every 1 s progress tick of the access leg, as the app runs them. */
    const replay = () => {
      let state: DepartureBaselineState | null = null
      const alerts: Array<{ atMs: number; body: string; title: string }> = []
      for (let now = FEED[0][0]; now < 1790025740000; now += 1000) {
        let live: number | null = null
        for (const [t, epoch] of FEED) if (t <= now) live = epoch
        if (live == null) continue
        const r = evaluateDepartureDrift(state, {
          boardingKey: RIDE_KEY,
          lastBoardMinutesPushAtMs:
            APPROACH_AT <= now ? APPROACH_AT : LEAVE_SOON_AT,
          liveDepartureMs: live,
          nowMs: now,
          routeName: '465',
          // "4 min slack" / "5 min slack" on the day's own pushes.
          toldDepartureMs:
            now >= APPROACH_AT && now < APPROACH_AT + 1000 ? live : null,
          waitSeconds: 300
        })
        state = r.next
        if (r.alert) {
          alerts.push({
            atMs: now,
            body: r.alert.message,
            title: r.alert.title
          })
        }
      }
      return alerts
    }

    it('turns four pushes in five minutes into one', () => {
      // Shipped: DEPARTURE_CHANGED 16:14:31 "3 min later", 16:16:14 "5 min
      // later", 16:19:18 "7 min later", 16:21:20 "10 min later" (that last in
      // the same second as "Bus here"), around BOARD_BUS_APPROACHING 16:18:05.
      const alerts = replay()
      expect(alerts).toHaveLength(1)
      expect(alerts[0].body).toBe('3 min later · 5 min slack')
      expect(alerts[0].title).toBe('465 · 5 min')
      // 16:14:30, the first tick that saw 16:19:52.
      expect(alerts[0].atMs).toBe(1790025270307)
    })

    it('leaves no push to contradict "Bus coming · 465 · 4 min"', () => {
      // The 73-second contradiction was 16:18:05 "4 min" then 16:19:18
      // "5 min". Nothing of this module's now speaks after the approach push.
      expect(replay().filter((a) => a.atMs > APPROACH_AT)).toHaveLength(0)
    })
  })
})
