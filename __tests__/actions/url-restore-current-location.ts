/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  parseUrlQueryString,
  syncCurrentLocationOrigin
} from '../../lib/actions/form'

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
 * Backlog 51.2 — 2026-10-13. After a reload a popstate landed on an old
 * #/feedback?ui_activeSearch=c5nby1lyz entry; handleBackButtonPress logged
 * "No search found in state history ... Replanning" at 09:11:42.502 and
 * dispatched parseUrlQueryString, whose setQueryParam overwrote the fresh
 * CURRENT_LOCATION query with the URL's `name::lat,lon` + arriveBy=false.
 * So `from` lost its category (syncCurrentLocationOrigin never re-synced) and
 * the 09:06 DEPART was never moved to now (updateQueryTimeIfLeavingNow is
 * NOW-only).
 */

const TZ = 'America/Chicago'
// 2026-10-13 09:11:42 CDT
const NOW_MS = Date.parse('2026-10-13T14:11:42Z')

const URL_PARAMS = {
  arriveBy: 'false',
  date: '2026-10-13',
  fromPlace: '(Current Location)::44.94,-93.26',
  mode: 'WALK,TRANSIT',
  time: '09:06',
  toPlace: 'Mall of America::44.8549,-93.2422',
  ui_activeSearch: 'c5nby1lyz'
}

const FIX = { coords: { latitude: 44.9511, longitude: -93.2877 } }

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const makeOtp = (over: any = {}): any => ({
  activeSearchId: null,
  config: { homeTimezone: TZ },
  currentQuery: {},
  location: { currentPosition: FIX },
  searches: {},
  ui: { mainPanelContent: null },
  ...over
})

function makeStore(otp: any) {
  const state: any = { otp }
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
    if (action.type === 'SET_LOCATION') {
      state.otp = {
        ...state.otp,
        currentQuery: {
          ...state.otp.currentQuery,
          [action.payload.locationType]: action.payload.location
        }
      }
    }
    return action
  }
  return { dispatch, dispatched, state }
}

async function restore(params: any, otp: any = makeOtp()) {
  const store = makeStore(otp)
  store.dispatch(parseUrlQueryString(params))
  await flush()
  const set = store.dispatched.find((a) => a.type === 'SET_QUERY_PARAM')
  return { ...store, set, types: store.dispatched.map((a) => a.type) }
}

describe('backlog 51.2 > URL restore on the re-plan path', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS)
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('popstate replan: origin is CURRENT_LOCATION at the fresh fix, time is NOW', async () => {
    const out = await restore(URL_PARAMS)
    expect(out.types).toContain('MOCK_ROUTING_QUERY')
    expect(out.set.payload.from).toEqual({
      category: 'CURRENT_LOCATION',
      lat: FIX.coords.latitude,
      lon: FIX.coords.longitude,
      name: '(Current Location)'
    })
    expect(out.set.payload.departArrive).toBe('NOW')
    expect(out.set.payload.date).toBe('2026-10-13')
    expect(out.set.payload.time).toBe('09:11')
    // the destination is a named place and stays one
    expect(out.set.payload.to.category).toBeUndefined()
    expect(out.set.payload.to.name).toBe('Mall of America')
  })

  it('keeps the URL point when no fix exists, but still tags the category', async () => {
    const out = await restore(
      URL_PARAMS,
      makeOtp({ location: { currentPosition: {} } })
    )
    expect(out.set.payload.from.category).toBe('CURRENT_LOCATION')
    expect(out.set.payload.from.lat).toBe(44.94)
    expect(out.set.payload.from.lon).toBe(-93.26)
  })

  it('also recognises a translated label', async () => {
    const out = await restore({
      ...URL_PARAMS,
      fromPlace: '(Emplacement actuel)::44.94,-93.26'
    })
    expect(out.set.payload.from.category).toBe('CURRENT_LOCATION')
  })

  it('a later syncCurrentLocationOrigin follows a new fix', async () => {
    const out = await restore(URL_PARAMS)
    const next = { coords: { latitude: 44.97, longitude: -93.3 } }
    out.state.otp = { ...out.state.otp, location: { currentPosition: next } }
    out.dispatch(syncCurrentLocationOrigin())
    expect(out.state.otp.currentQuery.from.lat).toBe(44.97)
    expect(out.state.otp.currentQuery.from.lon).toBe(-93.3)
    expect(out.state.otp.currentQuery.from.category).toBe('CURRENT_LOCATION')
  })

  it('a DEPART within ~2 minutes is kept', async () => {
    const out = await restore({ ...URL_PARAMS, time: '09:10' })
    expect(out.set.payload.departArrive).toBe('DEPART')
    expect(out.set.payload.time).toBe('09:10')
  })

  it('a future DEPART is kept', async () => {
    const out = await restore({ ...URL_PARAMS, time: '17:30' })
    expect(out.set.payload.departArrive).toBe('DEPART')
    expect(out.set.payload.time).toBe('17:30')
  })

  it('a past ARRIVE is untouched', async () => {
    const out = await restore({ ...URL_PARAMS, arriveBy: 'true' })
    expect(out.set.payload.departArrive).toBe('ARRIVE')
    expect(out.set.payload.time).toBe('09:06')
  })

  it('a named place stays named (no category, URL coords)', async () => {
    const out = await restore({
      ...URL_PARAMS,
      fromPlace: 'Uptown Transit Station::44.9487,-93.2985'
    })
    expect(out.set.payload.from).toEqual({
      lat: 44.9487,
      lon: -93.2985,
      name: 'Uptown Transit Station'
    })
  })

  it('a fresh reload (empty store) never takes the keep path', async () => {
    const out = await restore(URL_PARAMS, makeOtp({ searches: {} }))
    expect(out.types).toEqual(['SET_QUERY_PARAM', 'MOCK_ROUTING_QUERY'])
  })

  it('the keep path (23.4) is unchanged: stored query wins, time not bumped', async () => {
    const stored = {
      date: '2026-10-13',
      departArrive: 'DEPART',
      from: { lat: 44.94, lon: -93.26, name: '(Current Location)' },
      mode: 'WALK,TRANSIT',
      time: '09:06',
      to: { lat: 44.8549, lon: -93.2422, name: 'Mall of America' }
    }
    const out = await restore(
      URL_PARAMS,
      makeOtp({
        activeSearchId: 'c5nby1lyz',
        searches: {
          c5nby1lyz: {
            pending: 0,
            query: stored,
            response: [{ plan: { itineraries: [{ startTime: NOW_MS }] } }]
          }
        }
      })
    )
    expect(out.types).toEqual(['SET_QUERY_PARAM'])
    expect(out.set.payload.departArrive).toBe('DEPART')
    expect(out.set.payload.time).toBe('09:06')
    expect(out.set.payload.from).toEqual(stored.from)
  })
})
