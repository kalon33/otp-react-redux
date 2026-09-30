/**
 * The route-row timetable fill as a thunk (backlog 36.1): once a search has
 * settled, each qualifying row costs ONE stop-times request, never asked twice
 * on the same search, and what it finds is appended at the end of the
 * search's responses. The network answers with what production answered for
 * the 2026-09-30 15:43 search
 * (__tests__/test-utils/mock-data/route-row-timetable-0930-1543.json).
 */
import '../test-utils/mock-window-url'

import recorded from '../test-utils/mock-data/route-row-timetable-0930-1543.json'

const rec = recorded as any
const g = global as any

jest.mock('../../lib/actions/apiV2', () => ({
  createGraphQLQueryAction:
    (query: string, variables: any, responseAction: any, errorAction: any) =>
    (dispatch: any) => {
      const mocked = global as any
      mocked.__queries.push({ query, variables })
      if (mocked.__fail) {
        return dispatch(errorAction(new Error('timeout')))
      }
      const data = require('../test-utils/mock-data/route-row-timetable-0930-1543.json')
      return dispatch(responseAction({ data: data.stopTimes }))
    }
}))
jest.mock('../../lib/actions/other-stops-lookup', () => ({
  routingResponseExtra: (payload: any) => ({
    payload,
    type: 'ROUTING_RESPONSE_EXTRA'
  })
}))

/* eslint-disable import/first */
import { countTransitItineraries } from '../../lib/actions/api-utils'
import { doMergeItineraries } from '../../lib/components/narrative/narrative-itineraries'
import { fillRouteRowTimetables } from '../../lib/actions/route-row-timetable'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'
/* eslint-enable import/first */

const itineraries = () =>
  rec.itineraries.map((itin: any, index: number) => ({
    ...itin,
    index,
    otp2QueryParams: { arriveBy: false, date: rec.date, time: rec.time }
  }))

function makeStore({ goMode = false, pending = 0 } = {}) {
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
          itinerary: { searchWindowSeconds: 7200 }
        },
        goMode: { ...initial.goMode, isActive: goMode },
        searches: {
          s1: {
            pending,
            query: { from: rec.from, to: rec.to },
            response: [{ plan: { itineraries: itineraries() } }]
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

const rows = () =>
  doMergeItineraries(itineraries(), undefined, true).mergedItineraries

describe('36.1 > fillRouteRowTimetables', () => {
  const realNow = Date.now
  beforeEach(() => {
    g.__queries = []
    g.__fail = false
    // 2026-09-30 15:40 CDT: planning for 15:43.
    Date.now = () => Date.UTC(2026, 8, 30, 20, 40)
  })
  afterEach(() => {
    Date.now = realNow
  })

  it('asks each qualifying stop once and appends the 16:15 Orange run', async () => {
    const store = makeStore()
    await store.dispatch(fillRouteRowTimetables(rows()))
    // Two rows qualify: bike > Orange at 98th St, bike > 465 at 98th St Gate
    // E. The bike-only row asks nothing.
    expect(g.__queries).toHaveLength(2)
    expect(g.__queries.map((q: any) => q.variables.stopId).sort()).toEqual([
      '1:56831',
      '2:51825'
    ])
    const orange = g.__queries.find(
      (q: any) => q.variables.stopId === '1:56831'
    ).variables
    // The window, shifted by the row's 529 s of bike.
    expect(orange.startTime).toBe(
      Math.floor(Date.UTC(2026, 8, 30, 20, 43) / 1000) + 529
    )
    expect(orange.timeRange).toBe(7260)
    expect(orange.serviceDate).toBe('20260930')

    const response = store.state.otp.searches.s1.response
    expect(response).toHaveLength(2)
    expect(response[1].routeRowTimetable).toBe(true)
    const added = response[1].plan.itineraries
    expect(added.map((i: any) => i.timetableFill.tripId)).toEqual(['1:1361025'])
    // The stop answered for the 465's stop too, but only with Orange
    // departures (the recording is 98th St's), so nothing folds into 465.
    expect(store.state.otp.searches.s1.routeRowTimetable).toEqual({
      '1:56831|1:904|1:17780|BICYCLE': { found: 1, status: 'done' },
      '2:51825|2:465|2:17780|BICYCLE': { found: 0, status: 'done' }
    })
  })

  it('never asks twice on the same search', async () => {
    const store = makeStore()
    const first = store.dispatch(fillRouteRowTimetables(rows()))
    // The next render calls again while the first request is out.
    await store.dispatch(fillRouteRowTimetables(rows()))
    await first
    await store.dispatch(fillRouteRowTimetables(rows()))
    expect(g.__queries).toHaveLength(2)
  })

  it('asks nothing while the search is still answering, or on a Go Mode trip', async () => {
    await makeStore({ pending: 1 }).dispatch(fillRouteRowTimetables(rows()))
    await makeStore({ goMode: true }).dispatch(fillRouteRowTimetables(rows()))
    expect(g.__queries).toHaveLength(0)
  })

  it('a failed request leaves the row as OTP returned it', async () => {
    g.__fail = true
    const store = makeStore()
    await store.dispatch(fillRouteRowTimetables(rows()))
    expect(store.state.otp.searches.s1.response).toHaveLength(1)
    expect(
      store.state.otp.searches.s1.routeRowTimetable[
        '1:56831|1:904|1:17780|BICYCLE'
      ]
    ).toEqual({ status: 'failed' })
  })

  it('the thin-search count ignores what the timetable added', async () => {
    const store = makeStore()
    const before = countTransitItineraries(store.state.otp.searches.s1.response)
    await store.dispatch(fillRouteRowTimetables(rows()))
    expect(countTransitItineraries(store.state.otp.searches.s1.response)).toBe(
      before
    )
  })
})
