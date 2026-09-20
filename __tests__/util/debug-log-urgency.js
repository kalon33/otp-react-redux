/**
 * Which records must not wait in the buffer (backlog 20.2).
 *
 * On 2026-09-20 the rider hit "Could Not Plan Trip" at 09:23 on a trip the
 * server planned in 0.76 s, retried, and it worked — and the sink holds not one
 * `ROUTING_*` record for any of it. Two holes put it there: the 3 s buffer (an
 * iOS force-quit fires no `pagehide`, so the buffer dies with the WebView) and
 * a rejected flush that says nothing, leaving a blocked stream and an unopened
 * app looking identical. These cases pin both decisions.
 */

import {
  createFlushFailureTracker,
  isUrgentEntry,
  shouldUrgentFlush,
  URGENT_FLUSH_MIN_GAP_MS
} from '../../lib/util/debug-log-urgency'

describe('isUrgentEntry', () => {
  it('is urgent for the action that 20.2 lost — ROUTING_ERROR', () => {
    expect(isUrgentEntry({ kind: 'action', type: 'ROUTING_ERROR' })).toBe(true)
  })

  it('matches on the _ERROR suffix, so a failure action written tomorrow is urgent tomorrow', () => {
    // A list is what went stale and left 20.2 with nothing to read.
    expect(
      isUrgentEntry({ kind: 'action', type: 'SOME_FUTURE_THING_ERROR' })
    ).toBe(true)
    expect(isUrgentEntry({ kind: 'action', type: 'FIND_TRIP_ERROR' })).toBe(
      true
    )
  })

  it('is urgent for thrown errors and unhandled rejections', () => {
    expect(isUrgentEntry({ kind: 'error', message: 'boom' })).toBe(true)
    expect(isUrgentEntry({ kind: 'rejection', message: 'nope' })).toBe(true)
  })

  it('is NOT urgent for ordinary actions', () => {
    expect(isUrgentEntry({ kind: 'action', type: 'SET_MOBILE_SCREEN' })).toBe(
      false
    )
    expect(isUrgentEntry({ kind: 'action', type: 'ROUTING_RESPONSE' })).toBe(
      false
    )
  })

  it('is NOT urgent for console or session entries, which are steady noise', () => {
    // Beaconing these would spend the ~64KB quota on warnings.
    expect(isUrgentEntry({ kind: 'console', level: 'warn' })).toBe(false)
    expect(isUrgentEntry({ event: 'start', kind: 'session' })).toBe(false)
  })

  it('does not mistake a type that merely contains ERROR', () => {
    expect(isUrgentEntry({ kind: 'action', type: 'CLEAR_ERROR_BANNER' })).toBe(
      false
    )
  })

  it('survives rubbish rather than throwing into dispatch', () => {
    expect(isUrgentEntry(null)).toBe(false)
    expect(isUrgentEntry(undefined)).toBe(false)
    expect(isUrgentEntry('ROUTING_ERROR')).toBe(false)
    expect(isUrgentEntry({ kind: 'action' })).toBe(false)
  })
})

describe('shouldUrgentFlush', () => {
  it('always sends the first one', () => {
    expect(shouldUrgentFlush(1000, 0)).toBe(true)
  })

  it('holds a burst inside the gap', () => {
    expect(shouldUrgentFlush(1000 + URGENT_FLUSH_MIN_GAP_MS - 1, 1000)).toBe(
      false
    )
  })

  it('sends again once the gap has passed', () => {
    expect(shouldUrgentFlush(1000 + URGENT_FLUSH_MIN_GAP_MS, 1000)).toBe(true)
  })
})

describe('createFlushFailureTracker', () => {
  it('reports the first failure of a run and then stays quiet', () => {
    const t = createFlushFailureTracker()
    const first = t.fail(5000)
    expect(first).toEqual({
      event: 'sink-flush-failing',
      kind: 'session',
      sinceMs: 5000
    })
    // A phone in a tunnel fails every 3 s; one breadcrumb is the report.
    expect(t.fail(8000)).toBeNull()
    expect(t.fail(11000)).toBeNull()
  })

  it('says how long the stream was out when the link returns', () => {
    const t = createFlushFailureTracker()
    t.fail(5000)
    t.fail(8000)
    expect(t.recover(65000)).toEqual({
      event: 'sink-flush-recovered',
      failures: 2,
      kind: 'session',
      outForMs: 60000
    })
  })

  it('says nothing on a flush that was never failing', () => {
    const t = createFlushFailureTracker()
    expect(t.recover(5000)).toBeNull()
  })

  it('reports each run separately, so a flapping link is legible', () => {
    const t = createFlushFailureTracker()
    expect(t.fail(1000)).not.toBeNull()
    expect(t.recover(2000).outForMs).toBe(1000)
    // Second run: it must report again rather than staying latched.
    expect(t.fail(9000)).toEqual({
      event: 'sink-flush-failing',
      kind: 'session',
      sinceMs: 9000
    })
    expect(t.recover(12000).outForMs).toBe(3000)
  })
})
