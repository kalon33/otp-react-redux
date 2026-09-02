/* globals afterEach, beforeEach, describe, expect, it, jest */
import '../test-utils/mock-window-url'
import {
  createQueryAction,
  DEFAULT_FETCH_TIMEOUT_MS,
  GO_MODE_FETCH_TIMEOUT_MS,
  isTimeoutError
} from '../../lib/actions/api'
import { resetReachability } from '../../lib/util/server-reachable'

/**
 * 2026-08-31, session mthnk1al-x7m0iv: the rider tapped "Search from here" at
 * 17:22:25 and got an empty panel until they cleared it 9m11s later. Three of
 * the five candidate plans never came back — not an error, not a 500, no
 * answer at all — and `fetch` has no deadline of its own, so the promises the
 * app was waiting on simply never settled.
 *
 * These cases are about the request layer alone: a request that hangs must
 * end, and it must end as the caller's error action.
 */
describe('actions > createQueryAction request deadline', () => {
  const state = {
    otp: {
      config: {
        api: { host: 'http://mock-host.com', path: '/api', port: 80 }
      }
    },
    user: {}
  }
  const getState = () => state
  let realFetch: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyGlobal = global as any
  const setFetch = (fn: unknown) => {
    anyGlobal.fetch = fn
  }

  beforeEach(() => {
    realFetch = anyGlobal.fetch
    resetReachability()
  })
  afterEach(() => setFetch(realFetch))

  /** A server that accepted the connection and then said nothing, ever. */
  const silentServer = jest.fn(
    (_url: string, options: any) =>
      new Promise((resolve, reject) => {
        const signal = options?.signal
        if (!signal) return
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.')
          err.name = 'AbortError'
          reject(err)
        })
      })
  )

  it('gives up on a request that never answers, and says so', async () => {
    // FAILS BEFORE: with no AbortController the fetch promise never settles,
    // so this await never returns and the case times out — which is precisely
    // what the rider experienced, in test form.
    setFetch(silentServer)
    const dispatched: any[] = []
    const dispatch = (action: any) => {
      dispatched.push(action)
      return action
    }
    await createQueryAction(
      'plan',
      (payload: unknown) => ({ payload, type: 'RESPONSE' }),
      (err: unknown) => ({ payload: err, type: 'ERROR' }),
      { noThrottle: true, timeoutMs: 40 }
    )(dispatch, getState)

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].type).toBe('ERROR')
    expect(isTimeoutError(dispatched[0].payload)).toBe(true)
    expect(dispatched[0].payload.timeoutMs).toBe(40)
  })

  it('leaves the server-reachable banner out of it', async () => {
    // A timeout cannot tell a dead server from a slow one, and the onboard
    // optimizer fires five at once: three timing out while two answer would
    // otherwise drive the strike count straight past the banner threshold with
    // the server plainly working.
    setFetch(silentServer)
    const dispatch = (action: any) => action
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const reachable = require('../../lib/util/server-reachable')
    for (let i = 0; i < 4; i++) {
      await createQueryAction(
        'plan',
        (payload: unknown) => ({ payload, type: 'RESPONSE' }),
        (err: unknown) => ({ payload: err, type: 'ERROR' }),
        { noThrottle: true, timeoutMs: 20 }
      )(dispatch, getState)
    }
    expect(reachable.isServerReachable()).toBe(true)
  })

  it('still reports a real transport failure as unreachable', async () => {
    setFetch(jest.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
    const dispatch = (action: any) => action
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const reachable = require('../../lib/util/server-reachable')
    for (let i = 0; i < 2; i++) {
      await createQueryAction(
        'plan',
        (payload: unknown) => ({ payload, type: 'RESPONSE' }),
        (err: unknown) => ({ payload: err, type: 'ERROR' }),
        { noThrottle: true }
      )(dispatch, getState)
    }
    expect(reachable.isServerReachable()).toBe(false)
  })

  it('takes the deadline from config when the caller names none', async () => {
    let seen: any = null
    setFetch(
      jest.fn((_url: string, options: any) => {
        seen = options
        return Promise.resolve({
          json: () => Promise.resolve({ data: {} }),
          status: 200
        })
      })
    )
    const dispatch = (action: any) => action
    await createQueryAction(
      'plan',
      (payload: unknown) => ({ payload, type: 'RESPONSE' }),
      (err: unknown) => ({ payload: err, type: 'ERROR' }),
      { noThrottle: true }
    )(dispatch, getState)
    // Every request now carries an abort signal, whoever asked for it.
    expect(seen.signal).toBeDefined()
  })

  it('bounds a Go Mode background plan harder than a rider-initiated one', () => {
    // Nobody is watching a reroute snapshot, and five onboard candidates go out
    // at once on a moving bus: an answer after 12 s describes a position the
    // rider has already left.
    expect(GO_MODE_FETCH_TIMEOUT_MS).toBeLessThan(DEFAULT_FETCH_TIMEOUT_MS)
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(20000)
    expect(GO_MODE_FETCH_TIMEOUT_MS).toBe(12000)
  })
})
