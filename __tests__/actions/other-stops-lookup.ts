/**
 * The "Other stops" lookup as a thunk (backlog 21.5, third sighting): one tap
 * costs one trip fetch and at most eight street plans, runs once per row per
 * search, and appends nothing to a search the rider has left. The network is
 * mocked with what the live API answered for the rider's 2026-09-23 15:37
 * search (__tests__/test-utils/mock-data/other-stops-0923-1537.json).
 */
import '../test-utils/mock-window-url'

import recorded from '../test-utils/mock-data/other-stops-0923-1537.json'

const rec = recorded as any
const g = global as any

jest.mock('../../lib/actions/apiV2', () => ({
  fetchOnboardCandidatePlan: (combo: any) => () => {
    const calls = (global as any).__planCalls
    calls.push(combo)
    const hook = (global as any).__beforePlanAnswer
    if (hook) hook()
    if ((global as any).__plansFail) {
      return Promise.resolve({ error: true, itineraries: [] })
    }
    const data = require('../test-utils/mock-data/other-stops-0923-1537.json')
    const stopId = Object.keys(data.onward).find(
      (id) => data.onward[id].legs[0].from.name === combo.from.name
    )
    return Promise.resolve({
      error: false,
      itineraries: stopId ? [data.onward[stopId]] : []
    })
  },
  findTrip:
    ({ tripId }: { tripId: string }) =>
    (dispatch: any) => {
      const tripCalls = (global as any).__tripCalls
      tripCalls.push(tripId)
      const data = require('../test-utils/mock-data/other-stops-0923-1537.json')
      dispatch({ payload: data.trip, type: 'FIND_TRIP_RESPONSE' })
      return Promise.resolve()
    },
  getBasePlanParts: () => ({ modeSettings: [] })
}))
jest.mock('../../lib/actions/go-mode', () => ({
  onboardCandidateRoutingPreferences: () => undefined
}))

/* eslint-disable import/first */
import { collectItinerariesWithoutDuplicates } from '../../lib/util/itinerary'
import { lookupOtherStops } from '../../lib/actions/other-stops-lookup'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'
/* eslint-enable import/first */

function makeStore() {
  const reducer = createOtpReducer({ homeTimezone: 'America/Chicago' } as any)
  const initial = reducer(undefined, { type: '@@INIT' })
  const store: any = {
    actions: [] as any[],
    state: {
      otp: {
        ...initial,
        activeSearchId: 's1',
        config: {
          ...initial.config,
          homeTimezone: 'America/Chicago',
          itinerary: { onboardSettleMs: 2000 }
        },
        searches: {
          s1: {
            pending: 0,
            query: { from: rec.from, to: rec.to },
            response: [
              {
                plan: {
                  itineraries: [
                    rec.representative,
                    {
                      ...rec.representative,
                      startTime: rec.representative.startTime + 900000
                    }
                  ]
                }
              }
            ]
          }
        }
      }
    }
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

const row = () => {
  const itin = { ...rec.representative, index: 0 }
  return { ...itin, sameShapeVariants: [itin] }
}
const types = (store: any) => store.actions.map((a: any) => a.type)

describe('21.5 > lookupOtherStops', () => {
  beforeEach(() => {
    g.__planCalls = []
    g.__tripCalls = []
    g.__plansFail = false
    g.__beforePlanAnswer = null
  })

  it('one tap: one trip fetch, five street plans, the found runs appended at the end', async () => {
    const store = makeStore()
    const before = collectItinerariesWithoutDuplicates(
      store.state.otp.searches.s1.response
    )
    await store.dispatch(lookupOtherStops(row()))

    expect(g.__tripCalls).toEqual(['1:1346795'])
    expect(g.__planCalls).toHaveLength(5)
    // Street plans only, in the row's own mode, from each stop at the bus's
    // arrival there, to the search's destination.
    g.__planCalls.forEach((combo: any) => {
      expect(combo.modes).toEqual([{ mode: 'BICYCLE' }])
      expect(combo.numItineraries).toBe(1)
      expect(combo.arriveBy).toBe(false)
      expect(combo.to.lat).toBe(rec.to.lat)
    })
    expect(g.__planCalls.map((c: any) => c.from.name)).toContain(
      'I-35W & 46th St Station'
    )

    expect(types(store)).toEqual([
      'OTHER_STOPS_LOOKUP',
      'FIND_TRIP_RESPONSE',
      'ROUTING_RESPONSE_EXTRA',
      'OTHER_STOPS_LOOKUP'
    ])
    const search = store.state.otp.searches.s1
    expect(search.otherStopsLookup[0]).toEqual({
      candidates: 5,
      found: 5,
      status: 'done'
    })
    const after = collectItinerariesWithoutDuplicates(search.response)
    before.forEach((itin, i) => expect(after[i].startTime).toBe(itin.startTime))
    const appended = after.slice(before.length) as any[]
    expect(appended).toHaveLength(5)
    expect(appended.map((itin) => itin.legs[1].to.name)).toContain(
      'I-35W & 46th St Station'
    )
    appended.forEach((itin) => expect(itin.otherStopsLookup.side).toBe('off'))
  })

  it('never asks twice for the same row on the same search', async () => {
    const store = makeStore()
    await store.dispatch(lookupOtherStops(row()))
    await store.dispatch(lookupOtherStops(row()))
    expect(g.__tripCalls).toHaveLength(1)
    expect(g.__planCalls).toHaveLength(5)
    expect(store.state.otp.searches.s1.response).toHaveLength(2)
  })

  it('appends nothing to a search the rider has left while the plans were out', async () => {
    const store = makeStore()
    g.__beforePlanAnswer = () => {
      store.state = {
        ...store.state,
        otp: { ...store.state.otp, activeSearchId: 's2' }
      }
    }
    await store.dispatch(lookupOtherStops(row()))
    expect(types(store)).not.toContain('ROUTING_RESPONSE_EXTRA')
    expect(store.state.otp.searches.s1.response).toHaveLength(1)
  })

  it('says it failed when no plan came back, and appends nothing', async () => {
    const store = makeStore()
    g.__plansFail = true
    await store.dispatch(lookupOtherStops(row()))
    expect(types(store)).not.toContain('ROUTING_RESPONSE_EXTRA')
    expect(store.state.otp.searches.s1.otherStopsLookup[0]).toEqual({
      candidates: 5,
      found: 0,
      status: 'failed'
    })
  })

  it('does nothing for a row with no transit leg', async () => {
    const store = makeStore()
    await store.dispatch(
      lookupOtherStops({
        ...rec.representative,
        index: 1,
        legs: [rec.representative.legs[0]]
      })
    )
    expect(store.actions).toEqual([])
    expect(g.__planCalls).toHaveLength(0)
  })
})
