/* eslint-disable @typescript-eslint/no-explicit-any */
import { parseUrlQueryString, switchLocations } from '../../lib/actions/form'

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
 * Backlog 58.3 — the stay at each of the rider's stops rides beside the stops
 * in the URL (`stopStays=20`, since `intermediatePlaces=name::lat,lon` has no
 * room for it), so a reload plans the same stays, a URL with stops and no
 * stays never inherits the last search's, and returning to a search already
 * on screen (23.4) does not re-plan it.
 */
const URL_PARAMS = {
  arriveBy: 'false',
  date: '2026-10-20',
  fromPlace: 'Home::44.8168,-93.3101',
  intermediatePlaces: 'Perennial Cycle::44.941584,-93.298483',
  mode: 'WALK,TRANSIT',
  time: '10:00',
  toPlace: 'Micro Center::44.9396,-93.3466',
  ui_activeSearch: 'abc'
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function run(otp: any, params: any = URL_PARAMS) {
  const dispatched: any[] = []
  const getState = () => ({ otp })
  const dispatch = (action: any): any => {
    if (typeof action === 'function') return action(dispatch, getState)
    dispatched.push(action)
    return action
  }
  dispatch(parseUrlQueryString(params))
  await flush()
  return dispatched
}

const state = (searches: any = {}, activeSearchId: string | null = null) => ({
  activeSearchId,
  config: {},
  currentQuery: { stopStays: [45] },
  searches,
  ui: { mainPanelContent: null }
})

const setParam = (dispatched: any[]) =>
  dispatched.find((a) => a.type === 'SET_QUERY_PARAM')?.payload

describe('58.3 > the stays in the URL', () => {
  let spy: jest.SpyInstance
  beforeEach(() => {
    spy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-10-20T15:01:00Z'))
  })
  afterEach(() => spy.mockRestore())

  it('reads a single stay back off a reload', async () => {
    const out = await run(state(), { ...URL_PARAMS, stopStays: '20' })
    expect(setParam(out).stopStays).toEqual([20])
    expect(setParam(out).intermediatePlaces).toHaveLength(1)
  })

  it('stops with no stays in the URL mean no stays, not the last ones', async () => {
    const out = await run(state())
    expect(setParam(out).stopStays).toEqual([])
  })

  it('leaves the stays alone when the URL carries no stops at all', async () => {
    const { intermediatePlaces, ...noStops } = URL_PARAMS
    const out = await run(state(), noStops)
    expect('stopStays' in setParam(out)).toBe(false)
  })

  const settled = (query: any) => ({
    abc: {
      pending: 0,
      query,
      response: [{ plan: { itineraries: [{ startTime: 1 }] } }]
    }
  })
  const plannedQuery = (stopStays?: number[]) => ({
    date: '2026-10-20',
    departArrive: 'DEPART',
    from: { lat: 44.8168, lon: -93.3101, name: 'Home' },
    intermediatePlaces: [
      { lat: 44.941584, lon: -93.298483, name: 'Perennial Cycle' }
    ],
    mode: 'WALK,TRANSIT',
    time: '10:00',
    to: { lat: 44.9396, lon: -93.3466, name: 'Micro Center' },
    ...(stopStays ? { stopStays } : null)
  })
  const replanned = (out: any[]) =>
    out.some((a) => a.type === 'MOCK_ROUTING_QUERY')

  it('does not re-plan the search on screen when its stays match (23.4)', async () => {
    const out = await run(state(settled(plannedQuery([20])), 'abc'), {
      ...URL_PARAMS,
      stopStays: '20'
    })
    expect(replanned(out)).toBe(false)
  })

  it('a search planned with no stays still matches a URL with none', async () => {
    const out = await run(state(settled(plannedQuery()), 'abc'))
    expect(replanned(out)).toBe(false)
  })

  it('re-plans when the URL asks for a different stay', async () => {
    const out = await run(state(settled(plannedQuery([20])), 'abc'), {
      ...URL_PARAMS,
      stopStays: '30'
    })
    expect(replanned(out)).toBe(true)
  })
})

describe('58.3 > swapping origin and destination', () => {
  it('reverses the stays with the stops', async () => {
    const dispatched: any[] = []
    const otp = {
      config: {},
      currentQuery: {
        from: { lat: 1, lon: 1, name: 'A' },
        intermediatePlaces: [
          { lat: 2, lon: 2, name: 'S1' },
          { lat: 3, lon: 3, name: 'S2' }
        ],
        stopStays: [20],
        to: { lat: 4, lon: 4, name: 'B' }
      }
    }
    const getState = () => ({ otp })
    const dispatch = (action: any): any => {
      if (typeof action === 'function') return action(dispatch, getState)
      dispatched.push(action)
      return action
    }
    await dispatch(switchLocations())
    const payload = dispatched.find(
      (a) => a.type === 'SET_QUERY_PARAM' && a.payload.intermediatePlaces
    ).payload
    expect(payload.intermediatePlaces.map((p: any) => p.name)).toEqual([
      'S2',
      'S1'
    ])
    expect(payload.stopStays).toEqual([0, 20])
  })
})
