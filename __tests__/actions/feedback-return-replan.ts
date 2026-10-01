/* eslint-disable @typescript-eslint/no-explicit-any */
import { parseUrlQueryString } from '../../lib/actions/form'

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

  it('still plans when the stored query differs from the URL', async () => {
    // The 09:12:07 return: the search on screen was planned from the form, and
    // its `from` still carries the category setLocationToCurrent puts on it
    // (map.js:94-103), which the URL round-trip drops.
    const dispatched = await run(
      baseState(
        {
          mmzc6wkfw: {
            pending: 0,
            query: {
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
                lat: 44.816546,
                lon: -93.30986,
                name: '2345 Old Shakopee Road West, Bloomington, MN'
              }
            },
            response: SETTLED_RESULT
          }
        },
        'mmzc6wkfw'
      )
    )
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
