import {
  getUnreachableSince,
  isConnectionFailure,
  isServerReachable,
  noteServerAnswered,
  noteServerUnreachable,
  onReachabilityChange,
  resetReachability,
  UNREACHABLE_STRIKES
} from '../../lib/util/server-reachable'

/**
 * The 2026-08-14 outage: the router stopped passing traffic, every request hung,
 * and for four days the app was indistinguishable from a slow one. What this
 * module exists to do is tell those two apart, so the rider gets a sentence
 * instead of an animation.
 */
describe('util > server-reachable', () => {
  beforeEach(() => resetReachability())

  it('starts out believing the server is there', () => {
    expect(isServerReachable()).toBe(true)
    expect(getUnreachableSince()).toBeNull()
  })

  it('does not cry outage over a single failure', () => {
    // A tunnel, a lift, a wifi-to-cell handover. All fix themselves.
    noteServerUnreachable()
    expect(isServerReachable()).toBe(true)
  })

  it('says so once failures are consecutive', () => {
    for (let i = 0; i < UNREACHABLE_STRIKES; i++) noteServerUnreachable()
    expect(isServerReachable()).toBe(false)
    expect(getUnreachableSince()).not.toBeNull()
  })

  it('forgets the streak as soon as anything answers', () => {
    noteServerUnreachable()
    noteServerAnswered()
    noteServerUnreachable()
    expect(isServerReachable()).toBe(true)
  })

  it('recovers, and stops claiming a duration', () => {
    for (let i = 0; i < UNREACHABLE_STRIKES; i++) noteServerUnreachable()
    expect(isServerReachable()).toBe(false)
    noteServerAnswered()
    expect(isServerReachable()).toBe(true)
    expect(getUnreachableSince()).toBeNull()
  })

  it('tells subscribers only when the answer changes', () => {
    const seen: boolean[] = []
    const stop = onReachabilityChange((r) => seen.push(r))
    for (let i = 0; i < UNREACHABLE_STRIKES; i++) noteServerUnreachable()
    noteServerUnreachable() // still down; not a change
    noteServerAnswered()
    noteServerAnswered() // still up; not a change
    stop()
    expect(seen).toEqual([false, true])
  })

  it('does not let a broken subscriber take the fetch layer down', () => {
    const stop = onReachabilityChange(() => {
      throw new Error('bad listener')
    })
    expect(() => {
      for (let i = 0; i < UNREACHABLE_STRIKES; i++) noteServerUnreachable()
    }).not.toThrow()
    stop()
  })

  describe('what counts as unreachable', () => {
    it('a 500 is the server being present and unhappy', () => {
      // createQueryAction attaches the Response to errors it raises for 4xx/5xx.
      const err = new Error('Received error from server') as Error & {
        response?: unknown
      }
      err.response = { status: 500 }
      expect(isConnectionFailure(err)).toBe(false)
    })

    it('a failed connection is not', () => {
      // What fetch throws when it cannot connect at all.
      expect(isConnectionFailure(new TypeError('Failed to fetch'))).toBe(true)
    })

    it('an aborted request is the app changing its mind, not an outage', () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      expect(isConnectionFailure(err)).toBe(false)
    })

    it('shrugs at things that are not errors', () => {
      expect(isConnectionFailure(null)).toBe(false)
      expect(isConnectionFailure('nope')).toBe(false)
    })
  })
})
