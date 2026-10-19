/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The leg-frequency fetch as a thunk (backlog 58.1): one stop-times request
 * per leg question, cached app-wide, never asked twice while in flight or
 * answered, retried no sooner than two minutes after a failure, one request
 * at a time, nothing during a replay. The network answers with production's
 * 2026-10-18 Government Plaza answer.
 */
import '../test-utils/mock-window-url'

const g = global as any

jest.mock('../../lib/actions/apiV2', () => ({
  createGraphQLQueryAction:
    (query: string, variables: any, responseAction: any, errorAction: any) =>
    (dispatch: any) => {
      const mocked = global as any
      mocked.__queries.push({ query, variables })
      const answer = () => {
        if (mocked.__fail) return dispatch(errorAction(new Error('timeout')))
        const data = require('../test-utils/mock-data/leg-frequency-1018-gov-plaza.json')
        return dispatch(responseAction({ data: data.answer }))
      }
      if (mocked.__defer) {
        return new Promise((resolve) => {
          mocked.__release.push(() => resolve(answer()))
        })
      }
      return answer()
    }
}))
jest.mock('../../lib/util/go-mode/replay/replay-engine', () => ({
  isReplayActive: () => !!(global as any).__replay
}))

/* eslint-disable import/first */
import { fetchLegFrequency } from '../../lib/actions/leg-frequency'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'
/* eslint-enable import/first */

const leg = (boardSec: number, stop = '1:51409'): any => ({
  from: { stop: { gtfsId: stop } },
  mode: 'TRAM',
  route: { id: '1:901' },
  startTime: boardSec * 1000,
  to: { stop: { gtfsId: '1:51405' } },
  transitLeg: true,
  trip: { gtfsId: '1:887868' }
})

function makeStore() {
  const reducer = createOtpReducer({ homeTimezone: 'America/Chicago' } as any)
  const store: any = {
    actions: [] as any[],
    state: { otp: reducer(undefined, { type: '@@INIT' }) }
  }
  store.getState = () => store.state
  store.dispatch = (action: any): any => {
    if (typeof action === 'function') {
      return action(store.dispatch, store.getState)
    }
    store.actions.push(action)
    store.state = { ...store.state, otp: reducer(store.state.otp, action) }
    return action
  }
  return store
}

beforeEach(() => {
  g.__queries = []
  g.__fail = false
  g.__defer = false
  g.__release = []
  g.__replay = false
})

describe('fetchLegFrequency', () => {
  it('asks the board stop once and stores the route’s runs', async () => {
    const store = makeStore()
    await store.dispatch(fetchLegFrequency(leg(1792347360)))
    expect(g.__queries).toHaveLength(1)
    const { variables } = g.__queries[0]
    expect(variables.stopId).toBe('1:51409')
    expect(variables.timeRange).toBe(10800)
    const entries = Object.values(store.state.otp.legFrequency) as any[]
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('done')
    expect(entries[0].runs).toHaveLength(15)
    // Answered: a second render asks nothing.
    await store.dispatch(fetchLegFrequency(leg(1792347360)))
    expect(g.__queries).toHaveLength(1)
  })

  it('never asks twice while the first request is out', async () => {
    const store = makeStore()
    g.__defer = true
    const first = store.dispatch(fetchLegFrequency(leg(1792347360)))
    const second = store.dispatch(fetchLegFrequency(leg(1792347360)))
    await Promise.resolve()
    await Promise.resolve()
    g.__release.forEach((release: any) => release())
    await Promise.all([first, second])
    expect(g.__queries).toHaveLength(1)
  })

  it('sends two different legs one at a time', async () => {
    const store = makeStore()
    g.__defer = true
    const a = store.dispatch(fetchLegFrequency(leg(1792347360)))
    const b = store.dispatch(fetchLegFrequency(leg(1792347360, '1:51408')))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(g.__queries).toHaveLength(1)
    g.__release.shift()()
    await a
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(g.__queries).toHaveLength(2)
    g.__release.shift()()
    await b
  })

  it('a failure stores no runs and is not retried inside two minutes', async () => {
    const store = makeStore()
    g.__fail = true
    await store.dispatch(fetchLegFrequency(leg(1792347360)))
    const entries = Object.values(store.state.otp.legFrequency) as any[]
    expect(entries[0]).toMatchObject({ status: 'failed' })
    expect(entries[0].runs).toBeUndefined()
    await store.dispatch(fetchLegFrequency(leg(1792347360)))
    expect(g.__queries).toHaveLength(1)
  })

  it('asks nothing during a trip replay or for a leg with no question', async () => {
    const store = makeStore()
    g.__replay = true
    await store.dispatch(fetchLegFrequency(leg(1792347360)))
    g.__replay = false
    await store.dispatch(fetchLegFrequency({ mode: 'WALK' } as any))
    expect(g.__queries).toHaveLength(0)
    expect(store.state.otp.legFrequency).toEqual({})
  })

  it('keeps at most 40 legs, dropping the oldest', async () => {
    const store = makeStore()
    for (let i = 0; i < 45; i++) {
      await store.dispatch(fetchLegFrequency(leg(1792347360, `1:9${i}`)))
    }
    const keys = Object.keys(store.state.otp.legFrequency)
    expect(keys).toHaveLength(40)
    expect(keys.some((k) => k.startsWith('1:944|'))).toBe(true)
  })
})
