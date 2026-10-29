/* globals afterEach, describe, expect, it, jest */
import '../../test-utils/mock-window-url'

import { applyMiddleware, combineReducers, createStore } from 'redux'
import thunk from 'redux-thunk'

import {
  beginReplay,
  endReplay,
  PLAN_TWIN_MAX_ORIGIN_M,
  resolveReplayQuery,
  setReplayClock
} from '../../../lib/util/go-mode/replay/replay-engine'
import {
  createGraphQLQueryAction,
  findFeeds,
  findRoute
} from '../../../lib/actions/apiV2'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'

/**
 * BACKLOG 75.31 / 75.33 — what the replay engine answers each read with.
 *
 * 75.31: every re-plan in a replay was answered with the nearest periodic
 * REROUTE_SNAPSHOT, although fixtures record the quiet re-plans' own answers
 * (`quietReplanPlans`) and the onboard optimizer's (`onboardCandidatePlans`).
 * On ride-1020-0907 (session `mvgr2jqp-b81j4g`) the ride's 09:08:14 scoped
 * re-plan was accepted (originGapM 2.2); the replay asked the same question
 * from the same fix at sim 09:08:36 (its clock runs 23 s ahead of its fixes,
 * 75.29), was served the 09:08:36.269 reroute snapshot, and refused it:
 * origin-behind-rider, 84.9 m — the snapshot's origin.
 *
 * 75.33: anything that was not a vehicle / stop-time / trip read fell
 * through to that snapshot too — `findRoute` (the ridden-route overlay) got a
 * plan and failed "Cannot read properties of undefined (reading 'id')", the
 * feed list was overwritten with `{}`.
 *
 * The requests below are the ride's own (`quietReplanPlans[].request`,
 * copied from lib/util/go-mode/replay/fixtures/ride-1020-0907.json, which is
 * not committed: 62 MB); responses are markers.
 */

/** 2026-10-20 HH:MM:SS(.mmm) CDT as epoch ms. */
const at = (hms: string) => Date.parse(`2026-10-20T${hms}-05:00`)

const STOP = '6th St S & Park Ave / Chicago Ave S::44.973427,-93.261214'
const scoped = (tMs: number, lat: number, lon: number) => ({
  reason: 'quiet-replan-scoped',
  request: {
    from: { lat, lon, name: 'Current location' },
    reason: 'quiet-replan-scoped',
    to: { lat: 44.973427, lon: -93.261214, name: STOP.split('::')[0] },
    variables: {
      fromPlace: `Current location::${lat},${lon}`,
      toPlace: STOP
    }
  },
  response: { data: { plan: { itineraries: [] } }, recordedAt: tMs },
  tMs
})

const ORIGIN_0814 = [44.97353626480288, -93.26428538791443]
const ORIGIN_0848 = [44.974603607694235, -93.26689525497882]

function fixture(extra: any = {}): any {
  return {
    gpsTrack: [{ lat: 44.97, lon: -93.26, tMs: at('09:06:41') }],
    itinerary: { legs: [] },
    meta: { endMs: at('10:11:00'), startMs: at('09:07:04') },
    onboardCandidatePlans: [
      {
        request: {
          from: {
            lat: 44.94865,
            lon: -93.086474,
            name: 'Union Depot & Wacouta Station'
          },
          stopId: '1:57420',
          variables: {
            fromPlace: 'Union Depot & Wacouta Station::44.94865,-93.086474',
            toPlace: '3510 Hopkins Place, Oakdale, MN::45.00028,-92.949399'
          }
        },
        response: { data: { plan: {} }, recordedAt: 1792506126117 },
        stopId: '1:57420',
        tMs: 1792506126117
      }
    ],
    quietReplanPlans: [
      scoped(1792505294177, ORIGIN_0814[0], ORIGIN_0814[1]),
      scoped(1792505328235, ORIGIN_0848[0], ORIGIN_0848[1]),
      scoped(1792505449223, 44.97730667592526, -93.27322543705291)
    ],
    rerouteSnapshots: [
      {
        response: { data: { plan: {} }, snapshotAt: 1792505316269 },
        tMs: 1792505316269
      }
    ],
    routingResponses: [],
    schemaVersion: 1,
    stopTimeSnapshots: [],
    tripSnapshots: [
      {
        payload: { id: '1:1186422', v: 'a' },
        tMs: at('09:07:04'),
        tripId: '1:1186422'
      },
      {
        payload: { id: '1:1186422', v: 'b' },
        tMs: at('09:15:19'),
        tripId: '1:1186422'
      },
      {
        payload: { id: '1:1276072', v: 'c' },
        tMs: at('09:06:44'),
        tripId: '1:1276072'
      }
    ],
    vehicleSnapshots: [
      {
        payload: { routeId: '1:94', vehicles: [{ id: 'v' }] },
        routeId: '1:94',
        tMs: at('09:08:00')
      }
    ],
    ...extra
  }
}

const PLAN_QUERY =
  'query Plan($fromPlace: String!) { plan(fromPlace: $fromPlace) { itineraries { duration } } }'
const ROUTE_QUERY = '{ route(id: "1:94") { id: gtfsId patterns { id } } }'
const VEHICLE_QUERY =
  '{ route(id: "1:94") { patterns { vehiclePositions { vehicleId } } } }'
const FEEDS_QUERY = 'query FeedsQuery { feeds { feedId publisher { name } } }'
const tripQuery = (id: string) => `{ trip(id: "${id}") { id: gtfsId } }`

const scopedVars = (lat: number, lon: number) => ({
  fromPlace: `Current location::${lat},${lon}`,
  toPlace: STOP
})

const quiet = (clock: number, vars: any, reason = 'quiet-replan-scoped') => {
  setReplayClock(clock)
  return resolveReplayQuery({
    planKey: { reason },
    query: PLAN_QUERY,
    variables: vars
  })
}

afterEach(() => {
  endReplay()
  jest.restoreAllMocks()
})

describe('replay engine: a quiet re-plan gets its recorded twin (75.31)', () => {
  it('a scoped re-plan at 09:08:14 gets the plan recorded at 09:08:14', () => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined)
    beginReplay(fixture())
    const r: any = quiet(
      1792505294177,
      scopedVars(ORIGIN_0814[0], ORIGIN_0814[1])
    )
    expect(r.mode).toBe('raw')
    expect(r.payload.recordedAt).toBe(1792505294177)
  })

  it('the replay asking at 09:08:36 from the 09:08:14 fix gets the 09:08:14 twin, not the reroute snapshot or the nearer-in-time 09:08:48 one', () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    beginReplay(fixture())
    const r: any = quiet(
      1792505316269,
      scopedVars(ORIGIN_0814[0], ORIGIN_0814[1])
    )
    expect(r.mode).toBe('raw')
    // Main served `snapshotAt` 09:08:36.269 here — the GPS → destination plan
    // the ride's acceptance gate never saw.
    expect(r.payload.snapshotAt).toBeUndefined()
    expect(r.payload.recordedAt).toBe(1792505294177)
    // The match is logged with its numbers.
    expect(info.mock.calls.map((c) => c[0]).join('\n')).toMatch(
      /plan twin: quiet-replan-scoped .* <- recorded 14:08:14Z \(origin 0 m, -22 s\)/
    )
  })

  it('between two origins of a moving rider, the nearer place wins', () => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined)
    beginReplay(fixture())
    const r: any = quiet(
      at('09:08:30'),
      scopedVars(ORIGIN_0848[0] + 0.0001, ORIGIN_0848[1])
    )
    expect(r.payload.recordedAt).toBe(1792505328235)
  })

  it('falls back to the reroute snapshot when no twin was asked near the rider', () => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined)
    beginReplay(fixture())
    // ~330 m north of the 09:08:14 origin, at 09:08:20.
    const r: any = quiet(
      at('09:08:20'),
      scopedVars(ORIGIN_0814[0] + 0.003, ORIGIN_0814[1])
    )
    expect(r.payload.snapshotAt).toBe(1792505316269)
    expect(PLAN_TWIN_MAX_ORIGIN_M).toBeLessThan(330)
  })

  it('a re-plan to another stop is not the same question (1026-1214, 12:27:09)', () => {
    // The ride's twin went to I-35W & 46th St after a planner swap the replay
    // does not make (75.30); the replay's asks for the D Line's stop.
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    beginReplay(fixture())
    const r: any = quiet(1792505294177, {
      fromPlace: `Current location::${ORIGIN_0814[0]},${ORIGIN_0814[1]}`,
      toPlace: 'Portland Ave & 52nd St E::44.9087,-93.2675'
    })
    expect(r.payload.snapshotAt).toBe(1792505316269)
    expect(info.mock.calls[0][0]).toMatch(
      /none to this destination; serving the reroute snapshot/
    )
  })

  it('falls back to the reroute snapshot outside the time window, for another reason, and for an untagged plan', () => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined)
    beginReplay(fixture())
    const here = scopedVars(ORIGIN_0814[0], ORIGIN_0814[1])
    expect((quiet(at('09:20:00'), here) as any).payload.snapshotAt).toBe(
      1792505316269
    )
    expect(
      (quiet(1792505294177, here, 'quiet-replan-full') as any).payload
        .snapshotAt
    ).toBe(1792505316269)
    setReplayClock(1792505294177)
    const untagged: any = resolveReplayQuery({
      query: PLAN_QUERY,
      variables: here
    })
    expect(untagged.payload.snapshotAt).toBe(1792505316269)
  })

  it('an onboard alight candidate gets the plan recorded for that stop', () => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined)
    beginReplay(fixture())
    setReplayClock(at('09:22:05'))
    const r: any = resolveReplayQuery({
      planKey: { candidateStopId: '1:57420' },
      query: PLAN_QUERY,
      variables: {
        fromPlace: 'Union Depot & Wacouta Station::44.94865,-93.086474',
        toPlace: '3510 Hopkins Place, Oakdale, MN::45.00028,-92.949399'
      }
    })
    expect(r.payload.recordedAt).toBe(1792506126117)
  })
})

describe('replay engine: reads that are not plans (75.33, 75.32)', () => {
  it('a route look-up is passed through, never answered with a plan', () => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined)
    beginReplay(fixture())
    setReplayClock(at('09:10:00'))
    expect(resolveReplayQuery({ query: ROUTE_QUERY, variables: {} })).toEqual({
      mode: 'live'
    })
    // The vehicle query also opens with route( — it stays on the recording.
    const v: any = resolveReplayQuery({ query: VEHICLE_QUERY, variables: {} })
    expect(v.mode).toBe('direct')
    expect(v.payload.routeId).toBe('1:94')
  })

  it('the feeds query is passed through', () => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined)
    beginReplay(fixture())
    expect(resolveReplayQuery({ query: FEEDS_QUERY, variables: {} })).toEqual({
      mode: 'live'
    })
  })

  it('an unrecorded query is an error that names it, not a plan', () => {
    beginReplay(fixture())
    const r: any = resolveReplayQuery({
      query: 'query Nearby($lat: Float!) { nearest(lat: $lat) { edges } }',
      variables: {}
    })
    expect(r).toEqual({
      message: 'replay: no recording for Nearby',
      mode: 'error'
    })
  })

  it('a planner plan still gets the reroute snapshot', () => {
    beginReplay(fixture())
    setReplayClock(at('09:30:00'))
    const r: any = resolveReplayQuery({ query: PLAN_QUERY, variables: {} })
    expect(r.mode).toBe('raw')
    expect(r.payload.snapshotAt).toBe(1792505316269)
  })

  it('a trip is answered at the sim clock, and an unrecorded trip is not answered with another', () => {
    beginReplay(fixture())
    setReplayClock(at('09:10:00'))
    expect(
      (
        resolveReplayQuery({
          query: tripQuery('1:1186422'),
          variables: {}
        }) as any
      ).payload.v
    ).toBe('a')
    setReplayClock(at('09:16:00'))
    expect(
      (
        resolveReplayQuery({
          query: tripQuery('1:1186422'),
          variables: {}
        }) as any
      ).payload.v
    ).toBe('b')
    expect(
      resolveReplayQuery({ query: tripQuery('1:9999999'), variables: {} })
    ).toEqual({
      message: 'replay: no trip snapshot for 1:9999999',
      mode: 'error'
    })
  })
})

describe('apiV2 under replay: route look-ups and feeds reach the server (75.33)', () => {
  const CONFIG = {
    api: { host: 'http://mock-host.com', path: '/api', port: 80 },
    homeTimezone: 'America/Chicago',
    modes: { transitModes: [] },
    persistence: { enabled: false }
  }
  const ROUTE = {
    agency: { id: '1:0', name: 'Metro Transit' },
    color: '0053A0',
    id: '1:94',
    mode: 'BUS',
    patterns: [
      {
        headsign: 'Downtown St Paul',
        id: '1:94:0:01',
        name: '94 to Downtown St Paul',
        patternGeometry: { length: 2, points: '_p~iF~ps|U_ulLnnqC' },
        stops: [
          {
            id: '1:17887',
            lat: 44.973427,
            lon: -93.261214,
            name: '6th St S & Park Ave',
            routes: [{ color: '0053A0' }]
          }
        ]
      }
    ],
    shortName: '94'
  }
  const FEEDS = [
    { feedId: '0', publisher: { name: 'MVTA' } },
    { feedId: '1', publisher: { name: 'Metro Transit' } }
  ]

  function storeUnderReplay() {
    const seen: any[] = []
    const store = createStore(
      combineReducers({ otp: createOtpReducer(CONFIG as any) }),
      applyMiddleware(thunk, () => (next: any) => (action: any) => {
        if (action?.type) seen.push(action)
        return next(action)
      })
    )
    beginReplay(fixture())
    setReplayClock(at('09:30:00'))
    return { seen, store }
  }

  function serve(body: any) {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ json: () => Promise.resolve(body), status: 200 })
    )
    ;(global as any).fetch = fetchMock
    return fetchMock
  }

  it('findRoute stores the route with its patterns instead of failing on a plan', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined)
    const { seen, store } = storeUnderReplay()
    const fetchMock = serve({ data: { route: ROUTE } })
    await store.dispatch(findRoute({ routeId: '1:94' }) as any)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0] as any)[1].body).toContain(
      'route(id: \\"1:94\\")'
    )
    expect(seen.find((a) => a.type === 'FIND_ROUTE_ERROR')).toBeUndefined()
    const stored = store.getState().otp.transitIndex.routes['1:94']
    expect(stored.id).toBe('1:94')
    expect(Object.keys(stored.patterns)).toEqual(['1:94:0:01'])
  })

  it('findFeeds stores the feed list instead of wiping it', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined)
    const { store } = storeUnderReplay()
    serve({ data: { feeds: FEEDS } })
    store.dispatch(findFeeds() as any)
    // findFeeds does not return its request; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getState().otp.transitIndex.feeds).toEqual(FEEDS)
  })

  it('a recorded read never reaches the server', async () => {
    const { seen, store } = storeUnderReplay()
    const fetchMock = serve({})
    await store.dispatch(
      createGraphQLQueryAction(
        VEHICLE_QUERY,
        {},
        (payload: any) => ({ payload, type: 'VEHICLES' }),
        (err: any) => ({ payload: err, type: 'VEHICLES_ERROR' }),
        { noThrottle: true }
      ) as any
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(seen.find((a) => a.type === 'VEHICLES').payload.routeId).toBe('1:94')
  })
})
