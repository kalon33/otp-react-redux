/* eslint-disable @typescript-eslint/no-explicit-any */
import isEqual from 'lodash.isequal'

import { formChanged, parseUrlQueryString } from '../../lib/actions/form'

jest.mock('../../lib/actions/api', () => ({
  routingQuery: (searchId: string) => ({
    payload: { searchId },
    type: 'MOCK_ROUTING_QUERY'
  }),
  setUrlSearch: (params: any) => ({
    payload: params,
    type: 'MOCK_SET_URL_SEARCH'
  })
}))

/**
 * Backlog 23.4 — 2026-09-21, session mubbbiy9-6zjoq9. Every return from the
 * feedback screen re-ran the whole plan:
 *
 *   09:12:07.071 @@router/LOCATION_CHANGE /feedback -> /
 *   09:12:07.084 SET_QUERY_PARAM {from, to, date, time, departArrive, mode}
 *   09:12:07.088 ROUTING_REQUEST  searchId mmzc6wkfw
 *   09:12:07.690 / 09:12:12.113 / 09:12:20.105  three ROUTING_RESPONSEs
 *
 * and again at 09:21:54.939 and 09:23:10.380 — nine OTP plan calls for three
 * notes, with no gesture between the route change and the request.
 *
 * Mechanism: /feedback is its own <Route> in the Switch
 * (webapp-routes.js:101-107), and only routes with `shouldRenderWebApp`
 * render <WebappWithRouter> (responsive-webapp.js:425-440). So the whole
 * ResponsiveWebapp unmounts while the feedback screen is up and MOUNTS AGAIN
 * on the way back; componentDidMount calls parseUrlQueryString whenever
 * location.search is non-empty (responsive-webapp.js:219-223). That action
 * passes the URL's ui_activeSearch to setQueryParam, which dispatches
 * routingQuery for any truthy searchId (form.js:80-82) — with
 * updateSearchInReducer falsy, so the reducer $sets the search fresh
 * (create-otp-reducer.js:469-480) and the settled result is thrown away.
 */

const URL_PARAMS = {
  arriveBy: 'false',
  date: '2026-09-21',
  fromPlace: '(Current Location)::44.942580484827246,-93.2639665716265',
  mode: 'WALK,TRANSIT',
  time: '09:00',
  toPlace: '2345 Old Shakopee Road West, Bloomington, MN::44.816546,-93.30986',
  ui_activeSearch: 'mmzc6wkfw'
}

const SETTLED_RESULT = [
  { plan: { itineraries: [{ startTime: 1789999200000 }] } },
  { plan: { itineraries: [{ startTime: 1789999200000 }] } },
  { plan: { itineraries: [{ startTime: 1789999200000 }] } }
]

/** The stored query of a search planned from the form, as on 2026-09-30. */
function formBuiltQuery(): any {
  return {
    date: '2026-09-21',
    departArrive: 'DEPART',
    from: {
      category: 'CURRENT_LOCATION',
      lat: 44.942580484827246,
      lon: -93.2639665716265,
      name: '(Current Location)'
    },
    mode: 'WALK,TRANSIT',
    time: '09:00',
    to: {
      address: '2345 Old Shakopee Road West, Bloomington, MN',
      icon: 'clock-o',
      id: 'recent-1789999000000',
      lat: 44.816546,
      lon: -93.30986,
      name: '2345 Old Shakopee Road West, Bloomington, MN',
      timestamp: 1789999000000,
      type: 'recent'
    }
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function run(otp: any) {
  const dispatched: any[] = []
  const getState = () => ({ otp })
  const dispatch = (action: any): any => {
    if (typeof action === 'function') return action(dispatch, getState)
    dispatched.push(action)
    return action
  }
  dispatch(parseUrlQueryString(URL_PARAMS))
  await flush()
  return dispatched
}

const baseState = (searches: any, activeSearchId: string | null) => ({
  activeSearchId,
  config: {},
  currentQuery: {},
  searches,
  ui: { mainPanelContent: null }
})

describe('backlog 23.4 > returning to / with ui_activeSearch in the URL', () => {
  it('reads the same query out of the URL that the ride logged', async () => {
    const dispatched = await run(baseState({}, null))
    const setParam = dispatched.find((a) => a.type === 'SET_QUERY_PARAM')
    expect(setParam.payload).toEqual({
      date: '2026-09-21',
      departArrive: 'DEPART',
      from: {
        lat: 44.942580484827246,
        lon: -93.2639665716265,
        name: '(Current Location)'
      },
      mode: 'WALK,TRANSIT',
      time: '09:00',
      to: {
        lat: 44.816546,
        lon: -93.30986,
        name: '2345 Old Shakopee Road West, Bloomington, MN'
      }
    })
  })

  it('still plans when the store has no result for that search (page load)', async () => {
    const dispatched = await run(baseState({}, null))
    expect(dispatched.map((a) => a.type)).toEqual([
      'SET_QUERY_PARAM',
      'MOCK_ROUTING_QUERY'
    ])
    expect(dispatched[1].payload.searchId).toBe('mmzc6wkfw')
  })

  it('does NOT re-plan when only category / recent-place fields differ (the FIRST return)', async () => {
    // The 09:12:07 return, and 2026-09-30 17:08:33 (muomy26h-g1zujp): the
    // search on screen was planned from the form, so its `from` carries the
    // category setLocationToCurrent puts on it (actions/map.js) and its `to`
    // a recent place's address/icon/id/timestamp/type. The URL round-trip
    // keeps only name::lat,lon. Until cycle 13 this pinned "still plans" —
    // and on 09-30 it re-ran a 1,244,124-char search under a live trip
    // (backlog 23.4 / 37.1).
    const dispatched = await run(
      baseState(
        {
          mmzc6wkfw: {
            pending: 0,
            query: formBuiltQuery(),
            response: SETTLED_RESULT
          }
        },
        'mmzc6wkfw'
      )
    )
    expect(dispatched.map((a) => a.type)).toEqual(['SET_QUERY_PARAM'])
  })

  it('still plans when the stored origin is somewhere else (lat/lon differ)', async () => {
    const query = formBuiltQuery()
    query.from.lat += 0.001 // ~110 m: a different origin, a different plan
    const dispatched = await run(
      baseState(
        { mmzc6wkfw: { pending: 0, query, response: SETTLED_RESULT } },
        'mmzc6wkfw'
      )
    )
    expect(dispatched.map((a) => a.type)).toContain('MOCK_ROUTING_QUERY')
  })

  it('still plans when the stored destination is somewhere else', async () => {
    const query = formBuiltQuery()
    query.to.lon -= 0.0005
    const dispatched = await run(
      baseState(
        { mmzc6wkfw: { pending: 0, query, response: SETTLED_RESULT } },
        'mmzc6wkfw'
      )
    )
    expect(dispatched.map((a) => a.type)).toContain('MOCK_ROUTING_QUERY')
  })

  it('still plans when another key differs (time)', async () => {
    const query: any = formBuiltQuery()
    query.time = '09:15'
    const dispatched = await run(
      baseState(
        { mmzc6wkfw: { pending: 0, query, response: SETTLED_RESULT } },
        'mmzc6wkfw'
      )
    )
    expect(dispatched.map((a) => a.type)).toContain('MOCK_ROUTING_QUERY')
  })

  it('does not re-plan while Go Mode is active and the search is in the store', async () => {
    // Even when the stored query genuinely differs (here: a later time), the
    // trip holds its own itinerary; a re-plan could only renumber the list
    // under it (37.1's loop).
    const query: any = formBuiltQuery()
    query.time = '09:15'
    const otp: any = baseState(
      { mmzc6wkfw: { pending: 0, query, response: SETTLED_RESULT } },
      'mmzc6wkfw'
    )
    otp.goMode = { isActive: true }
    const dispatched = await run(otp)
    expect(dispatched.map((a) => a.type)).toEqual(['SET_QUERY_PARAM'])
  })

  it('still plans in Go Mode when the URL search is not in the store', async () => {
    const otp: any = baseState({}, null)
    otp.goMode = { isActive: true }
    const dispatched = await run(otp)
    expect(dispatched.map((a) => a.type)).toContain('MOCK_ROUTING_QUERY')
  })

  it('does NOT re-plan the search already on screen (the feedback return)', async () => {
    // From the second return onward the stored query IS the URL's: the first
    // return's SET_QUERY_PARAM was $merged into currentQuery
    // (create-otp-reducer.js:761-762) and ROUTING_REQUEST cloned currentQuery
    // into searches[id].query (:464). searches[id].query is therefore a
    // superset of the URL-derived query, key for key.
    const storedQuery = {
      arriveBy: false,
      date: '2026-09-21',
      departArrive: 'DEPART',
      from: {
        lat: 44.942580484827246,
        lon: -93.2639665716265,
        name: '(Current Location)'
      },
      mode: 'WALK,TRANSIT',
      numItineraries: 7,
      routingType: 'ITINERARY',
      time: '09:00',
      to: {
        lat: 44.816546,
        lon: -93.30986,
        name: '2345 Old Shakopee Road West, Bloomington, MN'
      }
    }
    const dispatched = await run(
      baseState(
        {
          mmzc6wkfw: {
            pending: 0,
            query: storedQuery,
            response: SETTLED_RESULT
          }
        },
        'mmzc6wkfw'
      )
    )
    // The form still follows the URL...
    expect(dispatched.map((a) => a.type)).toContain('SET_QUERY_PARAM')
    // ...but nothing is asked of OTP again.
    expect(dispatched.map((a) => a.type)).not.toContain('MOCK_ROUTING_QUERY')
  })

  it('still plans while that search is another one than the app is showing', async () => {
    const dispatched = await run(
      baseState(
        {
          mmzc6wkfw: {
            pending: 0,
            query: {
              date: '2026-09-21',
              departArrive: 'DEPART',
              from: {
                lat: 44.942580484827246,
                lon: -93.2639665716265,
                name: '(Current Location)'
              },
              mode: 'WALK,TRANSIT',
              time: '09:00',
              to: {
                lat: 44.816546,
                lon: -93.30986,
                name: '2345 Old Shakopee Road West, Bloomington, MN'
              }
            },
            response: SETTLED_RESULT
          }
        },
        '6wdj06ddu'
      )
    )
    expect(dispatched.map((a) => a.type)).toContain('MOCK_ROUTING_QUERY')
  })

  it('still plans when the stored search came back empty', async () => {
    const dispatched = await run(
      baseState(
        {
          mmzc6wkfw: {
            pending: 0,
            query: {
              date: '2026-09-21',
              departArrive: 'DEPART',
              from: {
                lat: 44.942580484827246,
                lon: -93.2639665716265,
                name: '(Current Location)'
              },
              mode: 'WALK,TRANSIT',
              time: '09:00',
              to: {
                lat: 44.816546,
                lon: -93.30986,
                name: '2345 Old Shakopee Road West, Bloomington, MN'
              }
            },
            response: [{ plan: { itineraries: [] } }]
          }
        },
        'mmzc6wkfw'
      )
    )
    expect(dispatched.map((a) => a.type)).toContain('MOCK_ROUTING_QUERY')
  })
})

/**
 * Cycle 20 / backlog 23.4 — the componentDidUpdate path. Setting the query
 * from the URL's `name::lat,lon` places rewrote currentQuery.from/to (the
 * Current Location category, a recent place's id/type, and a NOW departArrive
 * are lost), and ResponsiveWebapp.componentDidUpdate
 * (responsive-webapp.js:113-121) hands that change to formChanged, which under
 * BOTH_LOCATIONS_CHANGED (form.js:246-247) planned again under a new id
 * (2026-10-12 17:14:13, Go active) or cleared the search (10-13). The harness
 * applies SET_QUERY_PARAM the way the reducer does ($merge into currentQuery)
 * and then calls formChanged(prev, next) exactly as componentDidUpdate does.
 */
describe('backlog 23.4 > the form change that follows the URL restore', () => {
  const makeStore = (otp: any) => {
    const state: any = { otp, router: { location: { pathname: '/' } } }
    const dispatched: any[] = []
    const getState = () => state
    const dispatch = (action: any): any => {
      if (typeof action === 'function') return action(dispatch, getState)
      dispatched.push(action)
      if (action.type === 'SET_QUERY_PARAM') {
        state.otp = {
          ...state.otp,
          currentQuery: { ...state.otp.currentQuery, ...action.payload }
        }
      }
      return action
    }
    return { dispatch, dispatched, state }
  }

  async function returnFromFeedback(otp: any) {
    const store = makeStore(otp)
    const prev = store.state.otp.currentQuery
    store.dispatch(parseUrlQueryString(URL_PARAMS))
    await flush()
    const next = store.state.otp.currentQuery
    // componentDidUpdate only calls formChanged when the query differs.
    if (!isEqual(prev, next)) store.dispatch(formChanged(prev, next))
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { ...store, next, types: store.dispatched.map((a) => a.type) }
  }

  const goOtp = (stored: any, current: any = stored): any => ({
    activeSearchId: 'mmzc6wkfw',
    config: {
      autoPlan: { default: 'BOTH_LOCATIONS_CHANGED' },
      debouncePlanTimeMs: 0
    },
    currentQuery: current,
    goMode: { isActive: true },
    location: { currentPosition: {} },
    searches: {
      mmzc6wkfw: { pending: 0, query: stored, response: SETTLED_RESULT }
    },
    ui: { mainPanelContent: null }
  })

  it('(a) Go active, stored Current Location origin: no request, no clear, category kept', async () => {
    const out = await returnFromFeedback(goOtp(formBuiltQuery()))
    expect(out.types).not.toContain('MOCK_ROUTING_QUERY')
    expect(out.types).not.toContain('ROUTING_REQUEST')
    expect(out.types).not.toContain('CLEAR_ACTIVE_SEARCH')
    expect(out.state.otp.activeSearchId).toBe('mmzc6wkfw')
    expect(out.next.from.category).toBe('CURRENT_LOCATION')
    expect(out.next.to.type).toBe('recent')
  })

  it('(b) stored NOW vs URL DEPART: no re-plan, still NOW', async () => {
    const stored: any = formBuiltQuery()
    stored.departArrive = 'NOW'
    const out = await returnFromFeedback(goOtp(stored))
    expect(out.types).not.toContain('MOCK_ROUTING_QUERY')
    expect(out.types).not.toContain('CLEAR_ACTIVE_SEARCH')
    expect(out.next.departArrive).toBe('NOW')
  })

  it('(c) form origin moved to a fresh fix: no clear, no re-plan', async () => {
    const stored = formBuiltQuery()
    const current = {
      ...formBuiltQuery(),
      from: { ...stored.from, lat: stored.from.lat + 0.01 }
    }
    const out = await returnFromFeedback(goOtp(stored, current))
    expect(out.types).not.toContain('MOCK_ROUTING_QUERY')
    expect(out.types).not.toContain('CLEAR_ACTIVE_SEARCH')
    expect(out.state.otp.activeSearchId).toBe('mmzc6wkfw')
  })

  it('(d) cold URL with no stored search still plans', async () => {
    const otp = goOtp(formBuiltQuery())
    otp.goMode = { isActive: false }
    otp.activeSearchId = null
    otp.searches = {}
    otp.currentQuery = {}
    const out = await returnFromFeedback(otp)
    expect(out.types).toContain('MOCK_ROUTING_QUERY')
  })
})
