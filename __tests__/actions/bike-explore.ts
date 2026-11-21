/**
 * Direct / Calm / Wander as a thunk and a store (backlog 76.2): the mode is
 * stored on the device and restored at boot; Calm or Wander asks the engine
 * ONE request per lookup (every explore-shaped itinerary of the search at
 * once), once per (search, mode); the
 * results list reads the variants through getActiveItineraries at the same
 * positions; Direct asks nothing and shows OTP's answer, the same array.
 *
 * Real shapes: the 2026-09-23 15:37 search's Orange Line representative and
 * its run (other-stops-0923-1537.json); the engine's real answers for that
 * origin and those stops (bike-explore-0923-1537.json).
 */
import '../test-utils/mock-window-url'

import engine from '../test-utils/mock-data/bike-explore-0923-1537.json'
import recorded from '../test-utils/mock-data/other-stops-0923-1537.json'

const rec = recorded as any
const eng = engine as any

jest.mock('../../lib/actions/apiV2', () => ({
  fetchOnboardCandidatePlan: () => () => Promise.resolve({ itineraries: [] }),
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
import {
  ensureBikeExploreVariants,
  setBikeExploreMode
} from '../../lib/actions/bike-explore'
import {
  EXPLORE_MODE_STORAGE_KEY,
  exploreItineraryKey,
  exploreRideOf
} from '../../lib/util/bike-explore'
import { exploreNowMs } from '../../lib/util/bike-explore-variants'
import {
  getActiveItineraries,
  getActiveItinerary,
  getActiveOtpItineraries,
  getBikeExploreMode,
  getNicestExploreIndex
} from '../../lib/util/state'
import { PAYLOAD_SUMMARISERS } from '../../lib/util/debug-log-summarisers'
import { resetSafeStorageForTests } from '../../lib/util/safe-storage'
import bikeExploreReducer, {
  BIKE_EXPLORE_MAX_SEARCHES,
  initialBikeExploreState
} from '../../lib/reducers/bike-explore'
import createOtpReducer, {
  getInitialState
} from '../../lib/reducers/create-otp-reducer'
/* eslint-enable import/first */

const g = global as any
const NOW = eng.access.nowMs as number
const TZ = 'America/Chicago'

/** The representative and the same run fifteen minutes later. */
const later = (shift = 900000) => {
  const itin = JSON.parse(JSON.stringify(rec.representative))
  itin.startTime += shift
  itin.endTime += shift
  itin.legs.forEach((leg: any) => {
    leg.startTime += shift
    leg.endTime += shift
  })
  return itin
}

function makeStore({
  cachedTrip = true,
  extraConfig = {},
  itineraries
}: { cachedTrip?: boolean; extraConfig?: any; itineraries?: any[] } = {}) {
  const reducer = createOtpReducer({ homeTimezone: TZ } as any)
  const initial = reducer(undefined, { type: '@@INIT' })
  const store: any = {
    actions: [] as any[],
    state: {
      otp: {
        ...initial,
        activeSearchId: 's1',
        config: { ...initial.config, homeTimezone: TZ, ...extraConfig },
        searches: {
          s1: {
            activeItinerary: 0,
            pending: 0,
            query: {
              date: '2026-09-23',
              departArrive: 'DEPART',
              from: rec.from,
              time: '15:37',
              to: rec.to
            },
            response: [
              {
                plan: {
                  itineraries: itineraries || [
                    JSON.parse(JSON.stringify(rec.representative)),
                    later()
                  ]
                }
              }
            ]
          }
        },
        transitIndex: {
          ...initial.transitIndex,
          trips: cachedTrip ? { [rec.trip.id]: rec.trip } : {}
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

/**
 * The engine, as the live one answers a batch: the recorded flat answer for a
 * stop is turned into the compact shape (rides once, candidates pointing at
 * them) for whatever candidates the request names, `n|id` and all. A stop the
 * recording has no answer for could not be routed.
 */
function compactFrom(flat: any, body: any) {
  const rides: any[] = []
  const candidates = body.candidates.map((c: any) => {
    const original = c.id.slice(c.id.indexOf('|') + 1)
    const r = flat.candidates.find((x: any) => x.id === original)
    if (!r) {
      return { feasible: false, id: c.id, name: c.name, reason: 'unroutable' }
    }
    const { direct, feasible, id, leave_in_s: leave, name, ...ride } = r
    const { leave_in_s: directLeave, ...directRest } = direct
    rides.push({ ...ride, direct: directRest })
    return {
      direct_leave_in_s: directLeave,
      feasible,
      id: c.id,
      leave_in_s: leave,
      name,
      ride: rides.length - 1
    }
  })
  return { candidates, mode: flat.mode, rides, status: 'ok' }
}

function answerWith(flat: any) {
  return jest.fn(async (_url: string, init: any) => ({
    json: async () => compactFrom(flat, JSON.parse(init.body)),
    ok: true
  }))
}

beforeEach(() => {
  g.__tripCalls = []
  window.localStorage.clear()
  resetSafeStorageForTests()
  jest.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  jest.restoreAllMocks()
  delete g.fetch
})

describe('76.2 > the stored mode', () => {
  it('defaults to Direct and survives a reload', () => {
    expect(getInitialState({ homeTimezone: TZ } as any).bikeExplore.mode).toBe(
      'direct'
    )
    const store = makeStore()
    store.dispatch(setBikeExploreMode('wander'))
    expect(getBikeExploreMode(store.getState())).toBe('wander')
    expect(window.localStorage.getItem(`otp.${EXPLORE_MODE_STORAGE_KEY}`)).toBe(
      '"wander"'
    )
    resetSafeStorageForTests()
    expect(getInitialState({ homeTimezone: TZ } as any).bikeExplore.mode).toBe(
      'wander'
    )
  })

  it('reads anything else stored as Direct', () => {
    window.localStorage.setItem(`otp.${EXPLORE_MODE_STORAGE_KEY}`, '"scenic"')
    resetSafeStorageForTests()
    expect(getInitialState({ homeTimezone: TZ } as any).bikeExplore.mode).toBe(
      'direct'
    )
  })
})

describe('76.2 > Direct is the old version', () => {
  it('asks nothing and shows the very array OTP answered', async () => {
    g.fetch = answerWith(eng.access.calm)
    const store = makeStore()
    const before = store.getState().otp.bikeExplore
    await store.dispatch(ensureBikeExploreVariants())
    expect(g.fetch).not.toHaveBeenCalled()
    expect(g.__tripCalls).toEqual([])
    expect(store.actions).toEqual([])
    expect(store.getState().otp.bikeExplore).toBe(before)
    const state = store.getState()
    expect(getActiveItineraries(state)).toBe(getActiveOtpItineraries(state))
    expect(getNicestExploreIndex(state)).toBeNull()
  })
})

describe('76.2 > Calm and Wander', () => {
  it('one engine request for the whole search, the variants shown at the same positions', async () => {
    g.fetch = answerWith(eng.access.calm)
    const store = makeStore()
    const direct = JSON.stringify(getActiveItineraries(store.getState()))
    store.dispatch(setBikeExploreMode('calm'))
    await store.dispatch(ensureBikeExploreVariants())

    // Two itineraries, one request, to the app's own path.
    expect(g.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = g.fetch.mock.calls[0]
    expect(url).toBe('/api/bike/access')
    const body = JSON.parse(init.body)
    expect(body.mode).toBe('calm')
    expect(body.compact).toBe(true)
    const ids = ['1:56831', '1:56830', '1:56829', '1:51110', '1:56828']
    expect(body.candidates.map((c: any) => c.id)).toEqual([
      ...ids.map((id) => `0|${id}`),
      ...ids.map((id) => `1|${id}`)
    ])
    // The search's own 15:37 departure, 98th St at 15:58:58; the second
    // itinerary is the same run fifteen minutes later.
    expect(body.candidates[0].depart_s).toBe(1318)
    expect(body.candidates[5].depart_s).toBe(1318 + 900)
    // The run was in the transit index already: no trip fetch.
    expect(g.__tripCalls).toEqual([])

    const state = store.getState()
    const shown = getActiveItineraries(state)
    expect(shown).toHaveLength(2)
    expect(shown.map((i: any) => i.index)).toEqual([0, 1])
    expect(exploreRideOf(shown[0])?.stopId).toBe('1:51110')
    expect(shown[0].legs[1].from.stopId).toBe('1:51110')
    expect(shown[0].endTime).toBe(rec.representative.endTime)
    // Sorting costs re-derived for the variant, as for any listed itinerary.
    expect(typeof (shown[0] as any).rank).toBe('number')
    // The selected card, the map preview and Start Trip read the same.
    expect(getActiveItinerary(state)).toBe(shown[0])

    // Back to Direct: no request, and OTP's answer exactly as before.
    store.dispatch(setBikeExploreMode('direct'))
    const back = store.getState()
    expect(getActiveItineraries(back)).toBe(getActiveOtpItineraries(back))
    expect(JSON.stringify(getActiveItineraries(back))).toBe(direct)
    expect(g.fetch).toHaveBeenCalledTimes(1)

    // ...and Calm again is a view over what is stored.
    store.dispatch(setBikeExploreMode('calm'))
    await store.dispatch(ensureBikeExploreVariants())
    expect(g.fetch).toHaveBeenCalledTimes(1)
    expect(exploreRideOf(getActiveItineraries(store.getState())[0])).not.toBe(
      null
    )
  })

  it('asks each itinerary once, even while the first answers are out', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    g.fetch = jest.fn(async (_url: string, init: any) => {
      await gate
      return {
        json: async () => compactFrom(eng.access.wander, JSON.parse(init.body)),
        ok: true
      }
    })
    const store = makeStore()
    store.dispatch(setBikeExploreMode('wander'))
    const first = store.dispatch(ensureBikeExploreVariants())
    await Promise.resolve()
    const entries = store.getState().otp.bikeExplore.searches.s1.wander
    expect(Object.values(entries).map((e: any) => e.status)).toEqual([
      'pending',
      'pending'
    ])
    await store.dispatch(ensureBikeExploreVariants())
    release()
    await first
    expect(g.fetch).toHaveBeenCalledTimes(1)
    const done = store.getState().otp.bikeExplore.searches.s1.wander
    expect(Object.values(done).map((e: any) => e.status)).toEqual([
      'done',
      'done'
    ])
  })

  it("an engine that fails leaves every itinerary on OTP's leg", async () => {
    g.fetch = jest.fn(async () => {
      throw new TypeError('Load failed')
    })
    const store = makeStore()
    store.dispatch(setBikeExploreMode('calm'))
    await store.dispatch(ensureBikeExploreVariants())
    const state = store.getState()
    const key = exploreItineraryKey(getActiveOtpItineraries(state)[0])
    expect(state.otp.bikeExplore.searches.s1.calm[key]).toEqual({
      status: 'none'
    })
    expect(
      Object.values(state.otp.bikeExplore.searches.s1.calm).map(
        (e: any) => e.status
      )
    ).toEqual(['none', 'none'])
    expect(getActiveItineraries(state)).toBe(getActiveOtpItineraries(state))
  })

  it('fetches the run when the transit index does not have it', async () => {
    g.fetch = answerWith(eng.access.calm)
    const store = makeStore({ cachedTrip: false })
    store.dispatch(setBikeExploreMode('calm'))
    await store.dispatch(ensureBikeExploreVariants())
    // Both itineraries ride the same run: one fetch.
    expect(g.__tripCalls).toEqual([rec.trip.id])
  })

  it('uses config.bikeExploreApiUrl when the deployment sets one', async () => {
    g.fetch = answerWith(eng.access.calm)
    const store = makeStore({
      extraConfig: {
        bikeExploreApiUrl: 'http://127.0.0.1:8787/api/bike/access'
      }
    })
    store.dispatch(setBikeExploreMode('calm'))
    await store.dispatch(ensureBikeExploreVariants())
    expect(g.fetch.mock.calls[0][0]).toBe(
      'http://127.0.0.1:8787/api/bike/access'
    )
  })

  it("leaves a running Go Mode trip's plans alone (76.3's)", async () => {
    g.fetch = answerWith(eng.access.calm)
    const store = makeStore()
    store.state.otp.goMode = { ...store.state.otp.goMode, isActive: true }
    store.dispatch(setBikeExploreMode('calm'))
    await store.dispatch(ensureBikeExploreVariants())
    expect(g.fetch).not.toHaveBeenCalled()
  })

  it('itineraries that differ only after the bus share the stops they were asked', async () => {
    g.fetch = answerWith(eng.access.calm)
    // The same ride and bus, another ride home (a stop's worth longer).
    const otherEgress = JSON.parse(JSON.stringify(rec.representative))
    const last = otherEgress.legs[2]
    last.distance += 300
    last.endTime += 60000
    otherEgress.endTime += 60000
    const store = makeStore({
      itineraries: [JSON.parse(JSON.stringify(rec.representative)), otherEgress]
    })
    store.dispatch(setBikeExploreMode('calm'))
    await store.dispatch(ensureBikeExploreVariants())
    expect(g.fetch).toHaveBeenCalledTimes(1)
    const shown = getActiveItineraries(store.getState())
    expect(shown.map((i: any) => exploreRideOf(i)?.stopId)).toEqual([
      '1:51110',
      '1:51110'
    ])
    // Each keeps its own ride home.
    expect(shown[1].endTime).toBe(otherEgress.endTime)
  })

  it('seven itineraries, one request, pending then the answers with the counts', async () => {
    g.fetch = answerWith(eng.access.wander)
    const runs = [6, 5, 4, 3, 2, 1, 0].map((k) => later(k * 900000))
    const store = makeStore({ itineraries: runs })
    store.dispatch(setBikeExploreMode('wander'))
    await store.dispatch(ensureBikeExploreVariants())
    expect(g.fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(g.fetch.mock.calls[0][1].body)
    // Soonest departures first; ids unique within the request.
    const sent = body.candidates
      .filter((c: any) => c.id.endsWith('|1:56831'))
      .map((c: any) => c.depart_s)
    expect([...sent].sort((a, b) => a - b)).toEqual(sent)
    expect(new Set(body.candidates.map((c: any) => c.id)).size).toBe(35)
    expect(g.fetch.mock.calls[0][1].signal).toBeDefined()
    const stored = store.actions.filter(
      (a: any) => a.type === 'BIKE_EXPLORE_VARIANTS'
    )
    expect(
      stored.map((a: any) => Object.keys(a.payload.entries).length)
    ).toEqual([7, 7])
    expect(stored[1].payload.counts).toEqual({
      asked: 7,
      found: 7,
      requests: 1
    })
  })

  it("shifts a differently-timed itinerary onto the request's one now", async () => {
    g.fetch = answerWith(eng.access.calm)
    const second = later()
    // A planned search set for 16:37: its own now is later than the lookup's.
    second.otp2QueryParams = {
      arriveBy: false,
      date: '2026-09-23',
      time: '16:37'
    }
    const store = makeStore({
      itineraries: [JSON.parse(JSON.stringify(rec.representative)), second]
    })
    store.dispatch(setBikeExploreMode('calm'))
    await store.dispatch(ensureBikeExploreVariants())
    expect(g.fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(g.fetch.mock.calls[0][1].body)
    const own = exploreNowMs(second, NOW, TZ, undefined)
    expect(own).toBeGreaterThan(NOW)
    const busEpoch = second.legs[1].startTime
    // depart_s is relative to the request's now (the lookup's), yet equals
    // bus time minus the itinerary's own now.
    const mine = body.candidates.find((c: any) => c.id === '1|1:56831')
    expect(mine.depart_s).toBe(Math.round((busEpoch - own) / 1000))
    expect(
      body.candidates.find((c: any) => c.id === '0|1:56831').depart_s
    ).toBe(1318)
  })

  it('splits more than 2000 candidates between whole itineraries', async () => {
    g.fetch = answerWith(eng.access.calm)
    const base = JSON.parse(JSON.stringify(rec.representative))
    // 5 candidates each; 401 itineraries is 2005 candidates.
    const runs = Array.from({ length: 401 }, (_, k) => {
      const itin = JSON.parse(JSON.stringify(base))
      const shift = k * 60000
      itin.startTime += shift
      itin.endTime += shift
      itin.legs.forEach((leg: any) => {
        leg.startTime += shift
        leg.endTime += shift
      })
      return itin
    })
    const store = makeStore({ itineraries: runs })
    store.dispatch(setBikeExploreMode('calm'))
    await store.dispatch(ensureBikeExploreVariants())
    expect(g.fetch).toHaveBeenCalledTimes(2)
    const sizes = g.fetch.mock.calls.map(
      (c: any) => JSON.parse(c[1].body).candidates.length
    )
    expect(sizes).toEqual([2000, 5])
    const last = store.actions[store.actions.length - 1]
    expect(last.payload.counts.requests).toBe(2)
    expect(last.payload.counts.asked).toBe(401)
  })

  it('records counts, not routes, on the debug stream', async () => {
    g.fetch = answerWith(eng.access.calm)
    const store = makeStore()
    store.dispatch(setBikeExploreMode('calm'))
    await store.dispatch(ensureBikeExploreVariants())
    const last = store.actions[store.actions.length - 1]
    expect(last.type).toBe('BIKE_EXPLORE_VARIANTS')
    const summary = PAYLOAD_SUMMARISERS.BIKE_EXPLORE_VARIANTS(last.payload)
    expect(summary).toEqual({
      __summary: true,
      asked: 2,
      done: 2,
      elapsedMs: 0,
      mode: 'calm',
      none: 0,
      pending: 0,
      requests: 1
    })
    expect(JSON.stringify(summary).length).toBeLessThan(200)
  })
})

describe('76.2 > the stored variants', () => {
  it('keeps the most recent searches only', () => {
    let state = initialBikeExploreState('calm')
    for (let i = 0; i <= BIKE_EXPLORE_MAX_SEARCHES; i++) {
      state = bikeExploreReducer(state, {
        payload: {
          entries: { k: { status: 'none' } },
          mode: 'calm',
          searchId: `s${i}`
        },
        type: 'BIKE_EXPLORE_VARIANTS'
      })
    }
    expect(Object.keys(state.searches)).toHaveLength(BIKE_EXPLORE_MAX_SEARCHES)
    expect(state.searches.s0).toBeUndefined()
    expect(state.mode).toBe('calm')
  })

  it('ignores Direct and malformed payloads', () => {
    const state = initialBikeExploreState(null)
    expect(
      bikeExploreReducer(state, {
        payload: { entries: {}, mode: 'direct', searchId: 's1' },
        type: 'BIKE_EXPLORE_VARIANTS'
      })
    ).toBe(state)
    expect(
      bikeExploreReducer(state, {
        payload: 'direct',
        type: 'SET_BIKE_EXPLORE_MODE'
      })
    ).toBe(state)
  })
})
