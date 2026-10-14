/**
 * The "Other stops" lookup as a thunk (backlog 21.5, third sighting): one tap
 * costs one trip fetch and at most eleven street plans (5 get-off + 3 earlier
 * + 3 later get-on, backlog 49.1), runs once per row per
 * search, and appends nothing to a search the rider has left. The network is
 * mocked with what the live API answered for the rider's 2026-09-23 15:37
 * search (__tests__/test-utils/mock-data/other-stops-0923-1537.json).
 */
import '../test-utils/mock-window-url'

import { zonedTimeToUtc } from 'date-fns-tz'

import {
  bikeLeg,
  OLD_SHAKOPEE,
  POWDERHORN,
  southboundRepresentative,
  southboundTrip
} from '../test-utils/orange-southbound'
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
    if ((global as any).__synthPlans) {
      return Promise.resolve((global as any).__synthPlans(combo))
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
      dispatch({
        payload: (global as any).__trip || data.trip,
        type: 'FIND_TRIP_RESPONSE'
      })
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
    g.__synthPlans = null
    g.__trip = null
  })

  it('one tap: one trip fetch, nine street plans, the found runs appended at the end', async () => {
    const store = makeStore()
    const before = collectItinerariesWithoutDuplicates(
      store.state.otp.searches.s1.response
    )
    await store.dispatch(lookupOtherStops(row()))

    expect(g.__tripCalls).toEqual(['1:1346795'])
    // Five get-off stops, and since 49.1 four get-on stops: the two Burnsville
    // stops before 98th St (farther from the rider, asked about anyway) and
    // the two between 98th St and the 66th St alight.
    expect(g.__planCalls).toHaveLength(9)
    // Street plans only, in the row's own mode, from each stop at the bus's
    // arrival there, to the search's destination ...
    const offCalls = g.__planCalls.filter((c: any) => !c.arriveBy)
    const onCalls = g.__planCalls.filter((c: any) => c.arriveBy)
    expect(offCalls).toHaveLength(5)
    expect(onCalls).toHaveLength(4)
    g.__planCalls.forEach((combo: any) => {
      expect(combo.modes).toEqual([{ mode: 'BICYCLE' }])
      expect(combo.numItineraries).toBe(1)
    })
    offCalls.forEach((combo: any) => expect(combo.to.lat).toBe(rec.to.lat))
    // ... and from the origin, arriving by the bus's departure, for get-on.
    onCalls.forEach((combo: any) => expect(combo.from.lat).toBe(rec.from.lat))
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
    // The recorded answers hold no access plan, so only the get-off stops
    // come back; the counts say what was asked on each side.
    expect(search.otherStopsLookup[0]).toEqual({
      candidates: 9,
      found: 5,
      offCandidates: 5,
      onCandidates: 4,
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
    expect(g.__planCalls).toHaveLength(9)
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
      candidates: 9,
      found: 0,
      offCandidates: 5,
      onCandidates: 4,
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

/**
 * Backlog 49.1: on 2026-10-13 every lookup from Powderhorn recorded
 * `candidates: 5` — five get-off stops, no get-on stop. The same search on a
 * synthetic southbound Orange Line run (test-utils/orange-southbound.ts).
 */
describe('49.1 > lookupOtherStops from Powderhorn', () => {
  const sbRep = southboundRepresentative()

  function makeSouthboundStore() {
    const store = makeStore()
    const s1 = store.state.otp.searches.s1
    store.state.otp.searches.s1 = {
      ...s1,
      query: { from: POWDERHORN, to: OLD_SHAKOPEE },
      response: [{ plan: { itineraries: [sbRep] } }]
    }
    return store
  }

  beforeEach(() => {
    g.__planCalls = []
    g.__tripCalls = []
    g.__plansFail = false
    g.__beforePlanAnswer = null
    g.__trip = southboundTrip
    // A bike plan for every question: from the origin arriving a minute
    // before the asked time (get on), or from the stop at the asked time
    // (get off).
    g.__synthPlans = (combo: any) => {
      const at = zonedTimeToUtc(
        `${combo.date} ${combo.time}`,
        'America/Chicago'
      ).getTime()
      const template = bikeLeg(combo.from, combo.to, 0)
      const start = combo.arriveBy ? at - 60000 - template.duration * 1000 : at
      const leg = bikeLeg(combo.from, combo.to, start)
      return {
        error: false,
        itineraries: [
          {
            duration: leg.duration,
            endTime: leg.endTime,
            legs: [leg],
            startTime: leg.startTime
          }
        ]
      }
    }
  })

  it('asks about 46th St, at most eleven plans, and records each side', async () => {
    const store = makeSouthboundStore()
    const row = { ...sbRep, index: 0 }
    await store.dispatch(lookupOtherStops({ ...row, sameShapeVariants: [row] }))

    expect(g.__tripCalls).toEqual([southboundTrip.id])
    expect(g.__planCalls.length).toBeLessThanOrEqual(11)
    expect(g.__planCalls).toHaveLength(11)
    const onCalls = g.__planCalls.filter((c: any) => c.arriveBy)
    expect(onCalls.map((c: any) => c.to.name)).toContain(
      'I-35W & 46th St Station'
    )
    const entry = store.state.otp.searches.s1.otherStopsLookup[0]
    expect(entry).toMatchObject({
      candidates: 11,
      offCandidates: 5,
      onCandidates: 6,
      status: 'done'
    })

    // What came back is appended as runs of the same row: six that get on
    // elsewhere and keep the 98th St get-off, five that get off elsewhere.
    const appended = collectItinerariesWithoutDuplicates(
      store.state.otp.searches.s1.response
    ).slice(1) as any[]
    expect(entry.found).toBe(appended.length)
    const onRuns = appended.filter((i) => i.otherStopsLookup.side === 'on')
    const offRuns = appended.filter((i) => i.otherStopsLookup.side === 'off')
    expect(onRuns).toHaveLength(6)
    expect(offRuns).toHaveLength(5)
    onRuns.forEach((itin) =>
      expect(itin.legs[1].to.name).toBe('I-35W & 98th St Station')
    )
    expect(onRuns.map((itin) => itin.legs[1].from.name)).toContain(
      'I-35W & 46th St Station'
    )
    offRuns.forEach((itin) =>
      expect(itin.legs[1].from.name).toBe('I-35W & Lake St Station')
    )
  })
})
