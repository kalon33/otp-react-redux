/* globals afterEach, beforeEach, describe, expect, it, jest */
/* eslint-disable @typescript-eslint/no-explicit-any */
import '../test-utils/mock-window-url'
import {
  dropRidesAlreadyListed,
  everySubQueryFailed,
  isProgressiveBikeTransitSearch,
  rideSignature,
  shouldRunFullBikeTransitPass
} from '../../lib/actions/api-utils'
import { FULL_PASS_TIMEOUT_MS, routingQuery } from '../../lib/actions/apiV2'
import {
  getActiveError,
  getActiveItineraries,
  getActiveSearchErrors
} from '../../lib/util/state'
import { getSearchPendingKind } from '../../lib/components/narrative/search-pending-line'
import { resetPlanQueryGate } from '../../lib/util/plan-concurrency'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'

// Same stub as plan-fan-out.ts: jest maps *.graphql to '', so core-utils'
// default plan document cannot be printed.
jest.mock('@opentripplanner/core-utils', () => {
  const actual = jest.requireActual('@opentripplanner/core-utils')
  const { parse } = jest.requireActual('graphql')
  const stub = parse('query Plan { plan { itineraries { duration } } }')
  const core = actual.default || actual
  const patched = {
    ...core,
    queryGen: {
      ...core.queryGen,
      generateOtp2Query: (params: unknown) =>
        core.queryGen.generateOtp2Query(params, stub)
    }
  }
  return { ...actual, __esModule: true, default: patched }
})

/**
 * Backlog 38.3 — the rider's progressive search (2026-09-30, re-raised
 * 2026-10-12: "lower limit, show results and continue looking with a higher
 * limit"). Bike + transit goes out first at 2000 stops (~2 s on the Linode),
 * then once more at the rider's own cap (10000, 7-11 s) with the new trips
 * merged in. Silent when that second pass fails; the rider's answers (rev 2):
 * new trips slot in with no marker (Q1 A), the full pass always runs (Q2 A).
 */
describe('actions > apiV2 > routingQuery progressive bike + transit (38.3)', () => {
  const baseConfig = {
    api: { host: 'http://mock-host.com', path: '/api', port: 80 },
    homeTimezone: 'America/Chicago',
    itinerary: { enableMaxStopCount: true },
    modes: {
      initialState: { enabledModeButtons: ['transit', 'bicycle'] },
      modeButtons: [
        { key: 'transit', modes: [{ mode: 'TRANSIT' }] },
        { key: 'bicycle', modes: [{ mode: 'BICYCLE' }] }
      ],
      transitModes: []
    },
    persistence: { enabled: false }
  }

  const currentQuery = {
    date: '2026-10-12',
    departArrive: 'DEPART',
    from: { lat: 44.9483, lon: -93.2905, name: 'Home' },
    intermediatePlaces: [],
    mode: 'WALK,TRANSIT',
    numItineraries: 40,
    routingType: 'ITINERARY',
    time: '17:30',
    to: { lat: 44.9358, lon: -93.2259, name: '3322 Columbus' }
  }

  const T = (hhmm: string) => new Date(`2026-10-12T${hhmm}:00-05:00`).getTime()

  /** A bike -> bus -> bike itinerary on one vehicle trip. */
  const bikeBus = (route: string, trip: string, hhmm: string, delayS = 0) => {
    const start = T(hhmm) + delayS * 1000
    return {
      duration: 1800,
      endTime: start + 1800000,
      legs: [
        {
          duration: 300,
          endTime: start + 300000,
          from: { name: 'Home' },
          mode: 'BICYCLE',
          startTime: start,
          to: { name: 'Board' }
        },
        {
          duration: 1200,
          endTime: start + 1500000,
          from: { name: 'Board', stop: { gtfsId: `MN:${route}-a` } },
          mode: 'BUS',
          route: { id: `1:${route}`, shortName: route },
          routeShortName: route,
          startTime: start + 300000,
          to: { name: 'Alight', stop: { gtfsId: `MN:${route}-b` } },
          transitLeg: true,
          trip: { gtfsId: trip }
        },
        {
          duration: 300,
          endTime: start + 1800000,
          from: { name: 'Alight' },
          mode: 'BICYCLE',
          startTime: start + 1500000,
          to: { name: '3322 Columbus' }
        }
      ],
      startTime: start
    }
  }
  const walkBus = (route: string, trip: string, hhmm: string) => ({
    ...bikeBus(route, trip, hhmm),
    legs: bikeBus(route, trip, hhmm).legs.map((leg) =>
      leg.mode === 'BICYCLE' ? { ...leg, mode: 'WALK' } : leg
    )
  })
  const directBike = {
    duration: 2400,
    endTime: T('18:10'),
    legs: [
      {
        duration: 2400,
        endTime: T('18:10'),
        from: { name: 'Home' },
        mode: 'BICYCLE',
        startTime: T('17:30'),
        to: { name: '3322 Columbus' }
      }
    ],
    startTime: T('17:30')
  }

  type Answer = { data?: any; fail?: boolean | 'pending' }
  type Handler = (v: Record<string, any>) => Answer

  let sent: Array<Record<string, any>>
  let actions: any[]
  let otpState: any
  let reducer: any
  let warn: jest.SpyInstance
  let error: jest.SpyInstance
  const anyGlobal = global as unknown as Record<string, unknown>
  let realFetch: unknown

  const getState = () => ({ otp: otpState, user: {} })
  const dispatch = (action: unknown): any => {
    if (typeof action === 'function') {
      return (action as (d: unknown, g: unknown) => unknown)(dispatch, getState)
    }
    actions.push(action)
    otpState = reducer(otpState, action)
    return action
  }

  const kindOf = (v: Record<string, any>) => {
    const modes = (v.modes || []).map((m: any) => m.mode)
    if (!modes.includes('TRANSIT')) return 'bike'
    return modes.includes('BICYCLE') ? 'bikeTransit' : 'walkTransit'
  }

  /** Answers per request; `fail: 'pending'` never answers. */
  const server = (handler: Handler) =>
    jest.fn((_url: string, options: { body?: string }) => {
      const { variables } = JSON.parse(options?.body || '{}')
      sent.push(variables)
      const answer = handler(variables)
      if (answer.fail === 'pending') return new Promise(() => undefined)
      if (answer.fail) {
        return Promise.resolve({
          status: 500,
          text: () => Promise.resolve('boom')
        })
      }
      return Promise.resolve({
        json: () => Promise.resolve({ data: answer.data }),
        status: 200
      })
    })

  const plan = (itineraries: any[]) => ({
    data: { plan: { itineraries, routingErrors: [] } }
  })
  /** Five transit trips on walk + transit, so 14.2's widen stays home. */
  const plenty = [1, 2, 3, 4, 5].map((n) =>
    walkBus('5', `t-5-${n}`, `17:${30 + n}`)
  )
  const quickTrips = [
    bikeBus('21', 't-21-a', '17:35'),
    bikeBus('2', 't-2-a', '17:40')
  ]
  const happy: Handler = (v) => {
    const kind = kindOf(v)
    if (kind === 'bike') return plan([directBike])
    if (kind === 'walkTransit') return plan(plenty)
    if (v.maxStopCount === 2000) return plan(quickTrips)
    // The full pass: the same two trips (realtime moved one by 60 s), and one
    // the 2000-stop search could not reach.
    return plan([
      bikeBus('21', 't-21-a', '17:35', 60),
      bikeBus('2', 't-2-a', '17:40'),
      bikeBus('67', 't-67-a', '17:45'),
      directBike
    ])
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const settleAll = async () => {
    for (let round = 0; round < 20; round++) await flush()
  }
  const search = () => otpState.searches[otpState.activeSearchId]
  const bikeTransitSent = () => sent.filter((v) => kindOf(v) === 'bikeTransit')
  const types = () => actions.map((a) => a.type)

  const init = (config: any = baseConfig) => {
    reducer = createOtpReducer(config)
    otpState = reducer(undefined, { type: '@@INIT' })
    otpState = { ...otpState, config, currentQuery, modeSettingDefinitions: [] }
  }

  beforeEach(() => {
    resetPlanQueryGate()
    sent = []
    actions = []
    realFetch = anyGlobal.fetch
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    init()
  })
  afterEach(() => {
    anyGlobal.fetch = realFetch
    warn.mockRestore()
    error.mockRestore()
  })

  it('asks bike + transit at 2000 first, everything else at the rider’s cap', async () => {
    anyGlobal.fetch = server(happy)
    dispatch(routingQuery())
    await flush()
    const caps = Object.fromEntries(
      sent.slice(0, 3).map((v) => [kindOf(v), v.maxStopCount])
    )
    expect(caps).toEqual({
      bike: undefined,
      bikeTransit: 2000,
      walkTransit: 10000
    })
    await settleAll()
  })

  it('then asks bike + transit once more, at 10000, and merges the new trip without duplicates', async () => {
    anyGlobal.fetch = server(happy)
    dispatch(routingQuery())
    await settleAll()

    // Quick + full, nothing else: plenty of transit, so no widen either.
    expect(sent).toHaveLength(4)
    expect(bikeTransitSent().map((v) => v.maxStopCount)).toEqual([2000, 10000])
    const full = sent[3]
    expect(full.modes).toEqual([{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }])
    expect(full.searchWindow).toBe(7200)
    expect(types().filter((t) => t === 'ROUTING_EXTRA_REQUEST')).toHaveLength(1)

    expect(search().pending).toBe(0)
    const listed = getActiveItineraries(getState())
    const routes = listed.map(
      (itin: any) =>
        itin.legs
          .filter((l: any) => l.transitLeg)
          .map((l: any) => l.routeShortName)
          .join('>') || 'bike'
    )
    // 21 and 2 once each (21 came back 60 s later on the full pass), the
    // direct bike once, and 67 — the trip only the full limit reached.
    expect(routes.filter((r: string) => r === '21')).toHaveLength(1)
    expect(routes.filter((r: string) => r === '2')).toHaveLength(1)
    expect(routes.filter((r: string) => r === 'bike')).toHaveLength(1)
    expect(routes).toContain('67')
    // The one already on screen is the one kept.
    const r21 = listed.find(
      (itin: any) => itin.legs[1]?.routeShortName === '21'
    )
    expect(r21.startTime).toBe(T('17:35'))
    expect(getActiveError(getState())).toBeUndefined()
  })

  it('says "more bike + transit trips" while the full pass is out, and nothing after', async () => {
    let releaseFull: (() => void) | null = null
    anyGlobal.fetch = jest.fn((_url: string, options: { body?: string }) => {
      const { variables } = JSON.parse(options?.body || '{}')
      sent.push(variables)
      const respond = () =>
        Promise.resolve({
          json: () => Promise.resolve(happy(variables)),
          status: 200
        })
      if (
        kindOf(variables) === 'bikeTransit' &&
        variables.maxStopCount === 10000
      ) {
        return new Promise((resolve) => {
          releaseFull = () => resolve(respond())
        })
      }
      return respond()
    })
    dispatch(routingQuery())
    await settleAll()
    expect(releaseFull).not.toBeNull()
    expect(search().pending).toBe(1)
    expect(getSearchPendingKind(search())).toBe('BICYCLE_TRANSIT_MORE')
    // The quick answer is already on the list.
    expect(getActiveItineraries(getState()).length).toBeGreaterThan(0)
    ;(releaseFull as unknown as () => void)()
    await settleAll()
    expect(search().pending).toBe(0)
    expect(getSearchPendingKind(search())).toBeNull()
  })

  it('a failed full pass is silent: no ROUTING_ERROR, no error stored, no card, pending 0', async () => {
    anyGlobal.fetch = server((v) =>
      kindOf(v) === 'bikeTransit' && v.maxStopCount === 10000
        ? { fail: true }
        : happy(v)
    )
    dispatch(routingQuery())
    await settleAll()
    expect(bikeTransitSent().map((v) => v.maxStopCount)).toEqual([2000, 10000])
    expect(types()).not.toContain('ROUTING_ERROR')
    const silent = actions.filter((a) => a.type === 'ROUTING_SILENT_ERROR')
    expect(silent).toHaveLength(1)
    expect(silent[0].payload.pass).toBe('full')
    expect(silent[0].payload.failure.status).toBe(500)
    expect(search().pending).toBe(0)
    expect(search().response.some((r: any) => r?.error)).toBe(false)
    expect(getActiveError(getState())).toBeUndefined()
    expect(getActiveSearchErrors(getState()).SYSTEM_ERROR).toBeUndefined()
    // The quick pass's trips stay.
    expect(getActiveItineraries(getState()).length).toBe(plenty.length + 3)
  })

  it('a failed full pass does not stop 14.2’s widen (hadError stays false)', async () => {
    // Thin: walk + transit finds nothing, quick bike + transit finds two.
    anyGlobal.fetch = server((v) => {
      if (kindOf(v) === 'walkTransit') return plan([])
      if (kindOf(v) === 'bikeTransit' && v.maxStopCount === 10000)
        return { fail: true }
      return happy(v)
    })
    dispatch(routingQuery())
    await settleAll()
    // quick fan-out (3) + full pass + widen.
    expect(sent).toHaveLength(5)
    expect(sent[4].searchWindow).toBe(14400)
    expect(types()).not.toContain('ROUTING_ERROR')
    expect(search().pending).toBe(0)
  })

  it('a timed-out full pass is silent too, and is given 45 s', async () => {
    expect(FULL_PASS_TIMEOUT_MS).toBe(45000)
    jest.useFakeTimers()
    try {
      anyGlobal.fetch = jest.fn((_url: string, options: any) => {
        const { variables } = JSON.parse(options?.body || '{}')
        sent.push(variables)
        if (
          kindOf(variables) === 'bikeTransit' &&
          variables.maxStopCount === 10000
        ) {
          return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => {
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            })
          })
        }
        return Promise.resolve({
          json: () => Promise.resolve(happy(variables)),
          status: 200
        })
      })
      dispatch(routingQuery())
      for (let i = 0; i < 20; i++) {
        jest.advanceTimersByTime(0)
        await Promise.resolve()
        await Promise.resolve()
      }
      expect(bikeTransitSent().map((v) => v.maxStopCount)).toEqual([
        2000, 10000
      ])
      expect(search().pending).toBe(1)
      // Not at the 20 s a watched plan gets.
      jest.advanceTimersByTime(20000)
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(search().pending).toBe(1)
      jest.advanceTimersByTime(25000)
      for (let i = 0; i < 20; i++) {
        jest.advanceTimersByTime(0)
        await Promise.resolve()
        await Promise.resolve()
      }
      expect(search().pending).toBe(0)
      const silent = actions.filter((a) => a.type === 'ROUTING_SILENT_ERROR')
      expect(silent).toHaveLength(1)
      expect(silent[0].payload.failure.timedOut).toBe(true)
      expect(types()).not.toContain('ROUTING_ERROR')
      expect(search().response.some((r: any) => r?.error)).toBe(false)
      expect(getActiveError(getState())).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  it('a failed quick pass is not shown while the full pass is out, and the full answer stands', async () => {
    anyGlobal.fetch = server((v) =>
      kindOf(v) === 'bikeTransit' && v.maxStopCount === 2000
        ? { fail: true }
        : happy(v)
    )
    dispatch(routingQuery())
    await settleAll()
    expect(bikeTransitSent().map((v) => v.maxStopCount)).toEqual([2000, 10000])
    expect(types()).not.toContain('ROUTING_ERROR')
    expect(search().pending).toBe(0)
    expect(getActiveError(getState())).toBeUndefined()
    const routes = getActiveItineraries(getState()).map(
      (itin: any) => itin.legs[1]?.routeShortName
    )
    expect(routes).toEqual(expect.arrayContaining(['21', '2', '67']))
  })

  it('both bike + transit passes failing gives exactly today’s card', async () => {
    anyGlobal.fetch = server((v) =>
      kindOf(v) === 'bikeTransit' ? { fail: true } : happy(v)
    )
    dispatch(routingQuery())
    await settleAll()
    expect(types().filter((t) => t === 'ROUTING_ERROR')).toHaveLength(1)
    expect(search().response.filter((r: any) => r?.error)).toHaveLength(1)
    expect(search().pending).toBe(0)
    expect(getActiveError(getState())).toBeDefined()
  })

  it('no full pass after a quick pass where every sub-query failed (offline)', async () => {
    anyGlobal.fetch = server(() => ({ fail: true }))
    dispatch(routingQuery())
    await settleAll()
    expect(sent).toHaveLength(3)
    // Every failure is stored as it always was, the held one included.
    expect(types().filter((t) => t === 'ROUTING_ERROR')).toHaveLength(3)
    expect(search().response.filter((r: any) => r?.error)).toHaveLength(3)
    expect(search().pending).toBe(0)
    expect(getActiveError(getState())).toBeDefined()
  })

  it('no second pass when the rider’s cap is already 2000', async () => {
    init({
      ...baseConfig,
      itinerary: { maxStopCount: 2000, enableMaxStopCount: true }
    })
    anyGlobal.fetch = server(happy)
    dispatch(routingQuery())
    await settleAll()
    expect(sent).toHaveLength(3)
    expect(bikeTransitSent().map((v) => v.maxStopCount)).toEqual([2000])
  })

  it('no staging in Go Mode: bike + transit goes once, at the rider’s cap', async () => {
    otpState = { ...otpState, goMode: { ...otpState.goMode, isActive: true } }
    anyGlobal.fetch = server(happy)
    dispatch(routingQuery())
    await settleAll()
    expect(sent).toHaveLength(3)
    expect(bikeTransitSent().map((v) => v.maxStopCount)).toEqual([10000])
  })

  it('no full pass for a search the rider has already left', async () => {
    let releaseQuick: (() => void) | null = null
    anyGlobal.fetch = jest.fn((_url: string, options: { body?: string }) => {
      const { variables } = JSON.parse(options?.body || '{}')
      sent.push(variables)
      const respond = () =>
        Promise.resolve({
          json: () => Promise.resolve(happy(variables)),
          status: 200
        })
      if (kindOf(variables) === 'bikeTransit') {
        return new Promise((resolve) => {
          releaseQuick = () => resolve(respond())
        })
      }
      return respond()
    })
    dispatch(routingQuery())
    await settleAll()
    otpState = { ...otpState, activeSearchId: 'a-newer-search' }
    ;(releaseQuick as unknown as () => void)()
    await settleAll()
    expect(bikeTransitSent().map((v) => v.maxStopCount)).toEqual([2000])
    // It was the rider leaving that stopped it, not a failure.
    expect(types()).not.toContain('ROUTING_ERROR')
  })
})

describe('actions > api-utils > progressive bike + transit helpers (38.3)', () => {
  it('stages only a rider’s own itinerary search above the quick cap', () => {
    const base = {
      effectiveCap: 10000,
      firstPassCap: 2000,
      routingType: 'ITINERARY'
    }
    expect(isProgressiveBikeTransitSearch(base)).toBe(true)
    expect(
      isProgressiveBikeTransitSearch({ ...base, effectiveCap: 2000 })
    ).toBe(false)
    expect(
      isProgressiveBikeTransitSearch({ ...base, goModeActive: true })
    ).toBe(false)
    expect(
      isProgressiveBikeTransitSearch({ ...base, updateSearchInReducer: true })
    ).toBe(false)
    expect(
      isProgressiveBikeTransitSearch({ ...base, routingType: 'PROFILE' })
    ).toBe(false)
  })

  it('runs the full pass only for the live, not-all-failed search', () => {
    expect(shouldRunFullBikeTransitPass({ isActiveSearch: true })).toBe(true)
    expect(
      shouldRunFullBikeTransitPass({ allFailed: true, isActiveSearch: true })
    ).toBe(false)
    expect(
      shouldRunFullBikeTransitPass({ goModeActive: true, isActiveSearch: true })
    ).toBe(false)
    expect(shouldRunFullBikeTransitPass({ isActiveSearch: false })).toBe(false)
  })

  it('every sub-query failed = errors only, at least one', () => {
    expect(everySubQueryFailed([])).toBe(false)
    expect(everySubQueryFailed([{ error: {} }, { error: {} }])).toBe(true)
    expect(
      everySubQueryFailed([{ error: {} }, { plan: { itineraries: [] } }])
    ).toBe(false)
  })

  it('a ride is its vehicle trips and stops, not its clock', () => {
    const leg = (start: number) => ({
      from: { stop: { gtfsId: 'MN:a' } },
      startTime: start,
      to: { stop: { gtfsId: 'MN:b' } },
      transitLeg: true,
      trip: { gtfsId: 'trip-1' }
    })
    expect(rideSignature({ legs: [leg(1)] })).toBe(
      rideSignature({ legs: [leg(61)] })
    )
    const listed = [{ plan: { itineraries: [{ legs: [leg(1)] }] } }]
    expect(dropRidesAlreadyListed([{ legs: [leg(61)] }], listed)).toHaveLength(
      0
    )
    expect(
      dropRidesAlreadyListed(
        [{ legs: [{ ...leg(1), trip: { gtfsId: 'trip-2' } }] }],
        listed
      )
    ).toHaveLength(1)
  })
})
