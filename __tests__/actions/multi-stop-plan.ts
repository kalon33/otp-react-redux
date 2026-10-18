/* globals afterEach, beforeEach, describe, expect, it, jest */
import '../test-utils/mock-window-url'
import { resetPlanQueryGate } from '../../lib/util/plan-concurrency'
import { routingQuery } from '../../lib/actions/apiV2'
import { RoutingQueryCallResult } from '../../lib/actions/api-constants'
import { viaVisitLocations } from '../../lib/util/multi-stop'
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
 * Backlog 43.1 — what goes over the wire when the rider plans a trip with a
 * stop in it, and what comes back on the results list.
 *
 * Measured against production OTP 2026-10-08 (home → Perennial Cycle → Micro
 * Center, 2026-10-09 10:00): WALK+TRANSIT with `via [{visit}]` returned three
 * itineraries through the stop; BICYCLE+TRANSIT with the same via returned
 * three (9.7 s); BICYCLE alone and WALK alone with the via returned NOTHING,
 * `routingErrors []`. So: transit combinations carry the via, the street-only
 * one is a chain of direct plans.
 */
describe('actions > apiV2 > routingQuery with the rider’s stops (43.1)', () => {
  const config = {
    api: { host: 'http://mock-host.com', path: '/api', port: 80 },
    homeTimezone: 'America/Chicago',
    itinerary: {},
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

  const HOME = { lat: 44.8168, lon: -93.3101, name: 'Home' }
  const PERENNIAL = { lat: 44.941584, lon: -93.298483, name: 'Perennial Cycle' }
  const MICRO_CENTER = { lat: 44.9396, lon: -93.3466, name: 'Micro Center' }

  const currentQuery = {
    date: '2026-10-09',
    departArrive: 'DEPART',
    from: HOME,
    intermediatePlaces: [PERENNIAL],
    mode: 'WALK,TRANSIT',
    numItineraries: 3,
    routingType: 'ITINERARY',
    time: '10:00',
    to: MICRO_CENTER
  }

  const T = (hhmm: string) => new Date(`2026-10-09T${hhmm}:00-05:00`).getTime()
  const place = (s: string) => {
    const [name, coords] = s.split('::')
    const [lat, lon] = coords.split(',').map(Number)
    return { lat, lon, name }
  }

  let sent: Array<Record<string, any>>
  let actions: any[]
  let otpState: any
  let reducer: any
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

  /**
   * A server shaped like the probe: a transit plan with a via walks through
   * the stop; a bike-only plan with a via is empty; a bike-only plan without
   * one rides straight there, 20 minutes, starting when it was asked to.
   */
  const probeServer = () =>
    jest.fn((_url: string, options: { body?: string }) => {
      const { variables } = JSON.parse(options?.body || '{}')
      sent.push(variables)
      const streetOnly = !variables.modes.some((m: any) => m.mode === 'TRANSIT')
      const from = place(variables.fromPlace)
      const to = place(variables.toPlace)
      let itineraries: any[] = []
      if (streetOnly && !variables.via) {
        // Arrive-by: the ride ends at the time asked (58.3's backward chain).
        const start = variables.arriveBy
          ? T(variables.time) - 1200000
          : T(variables.time)
        itineraries = [
          {
            duration: 1200,
            endTime: start + 1200000,
            legs: [
              {
                distance: 5000,
                duration: 1200,
                endTime: start + 1200000,
                from,
                mode: 'BICYCLE',
                startTime: start,
                to
              }
            ],
            startTime: start
          }
        ]
      } else if (!streetOnly && variables.via) {
        const stop = {
          lat: 44.941584,
          lon: -93.298483,
          name: 'Perennial Cycle (44.94158, -93.29848)'
        }
        itineraries = [
          {
            duration: 6104,
            endTime: T('11:44'),
            legs: [
              {
                distance: 4284,
                duration: 3480,
                endTime: T('10:58'),
                from,
                mode: 'BUS',
                route: { id: '1:904' },
                startTime: T('10:00'),
                to: {
                  lat: 44.942607,
                  lon: -93.298437,
                  name: 'Hennepin & 33rd'
                },
                transitLeg: true
              },
              {
                distance: 114,
                duration: 86,
                endTime: T('10:59'),
                from: { lat: 44.942607, lon: -93.298437, name: 'Hennepin' },
                mode: 'WALK',
                startTime: T('10:58'),
                to: stop
              },
              {
                distance: 5263,
                duration: 2700,
                endTime: T('11:44'),
                from: stop,
                mode: 'BUS',
                route: { id: '1:38' },
                startTime: T('10:59'),
                to,
                transitLeg: true
              }
            ],
            startTime: T('10:00')
          }
        ]
      }
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            data: { plan: { itineraries, routingErrors: [] } }
          }),
        status: 200
      })
    })

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const settle = async () => {
    for (let i = 0; i < 12; i++) await flush()
  }

  beforeEach(() => {
    resetPlanQueryGate()
    sent = []
    actions = []
    realFetch = anyGlobal.fetch
    reducer = createOtpReducer(config)
    otpState = reducer(undefined, { type: '@@INIT' })
    otpState = {
      ...otpState,
      config,
      currentQuery,
      modeSettingDefinitions: []
    }
    anyGlobal.fetch = probeServer()
  })
  afterEach(() => {
    anyGlobal.fetch = realFetch
  })

  it('sends the stop as a via visit on every transit plan', async () => {
    dispatch(routingQuery())
    await settle()
    const transit = sent.filter((v) =>
      v.modes.some((m: any) => m.mode === 'TRANSIT')
    )
    expect(transit.length).toBeGreaterThanOrEqual(2)
    transit.forEach((v) => {
      expect(v.via).toEqual(viaVisitLocations([PERENNIAL]))
      // The raw otp-ui array is bookkeeping, never a plan() argument.
      expect(v.intermediatePlaces).toBeUndefined()
    })
  })

  it('plans the bike-only option as a chain through the stop, not a via', async () => {
    dispatch(routingQuery())
    await settle()
    const street = sent.filter(
      (v) => !v.modes.some((m: any) => m.mode === 'TRANSIT')
    )
    // Never the via OTP answers with nothing.
    expect(street.every((v) => v.via === undefined)).toBe(true)
    expect(street.map((v) => [v.fromPlace, v.toPlace])).toEqual([
      ['Home::44.8168,-93.3101', 'Perennial Cycle::44.941584,-93.298483'],
      [
        'Perennial Cycle::44.941584,-93.298483',
        'Micro Center::44.9396,-93.3466'
      ]
    ])
    // The second segment leaves when the first arrives.
    expect(street.map((v) => v.time)).toEqual(['10:00', '10:20'])
  })

  it('puts one itinerary per option on the list, each through the stop', async () => {
    dispatch(routingQuery())
    await settle()
    const search = otpState.searches[otpState.activeSearchId]
    expect(search.pending).toBe(0)
    const itineraries = search.response.flatMap(
      (r: any) => r?.plan?.itineraries || []
    )
    const bike = itineraries.find((it: any) =>
      it.legs.every((l: any) => l.mode === 'BICYCLE')
    )
    expect(bike.stopLegIndexes).toEqual([0])
    expect(bike.legs[0].to.name).toBe('Perennial Cycle')
    expect(bike.duration).toBe(40 * 60)
    const transit = itineraries.filter((it: any) =>
      it.legs.some((l: any) => l.transitLeg)
    )
    expect(transit.length).toBeGreaterThan(0)
    transit.forEach((it: any) => {
      expect(it.stopLegIndexes).toEqual([1])
      // OTP's "(lat, lon)" label becomes the rider's own name for the place.
      expect(it.legs[1].to.name).toBe('Perennial Cycle')
    })
  })

  it('leaves an ordinary search exactly as it was', async () => {
    otpState = {
      ...otpState,
      currentQuery: { ...currentQuery, intermediatePlaces: [] }
    }
    dispatch(routingQuery())
    await settle()
    expect(sent.every((v) => v.via === undefined)).toBe(true)
    // One plan per combination: no chain.
    expect(
      sent.filter((v) => !v.modes.some((m: any) => m.mode === 'TRANSIT'))
    ).toHaveLength(1)
  })

  /**
   * Backlog 52.1 — the rider's first multi-stop search on the phone,
   * 2026-10-15 15:53 (stop ALDI Richfield): production OTP refused every
   * transit plan with that via, `{errors:[{message:'… All connection need to
   * be pareto-optimal …'}], data:{plan:null}}`, and the app crashed on the
   * missing list. This server answers the same way: any plan with a via and
   * transit is refused; a transit plan WITHOUT one is a walk then a bus whose
   * departure is set by its schedule (the next :x3 after the walk), not by
   * when the request asked to leave.
   */
  const PARETO =
    'Exception while fetching data (/plan) : All connection need to be pareto-optimal: ((stop 3336 ~ 1901, 25m7s)) <-> ((stop 3336 ~ 1901, 25m9s))'
  const refused = () => ({
    data: { plan: null },
    errors: [{ message: PARETO }]
  })
  const kindOf = (v: Record<string, any>) => {
    const modes = (v.modes || []).map((m: any) => m.mode)
    if (!modes.includes('TRANSIT')) return 'bike'
    return modes.includes('BICYCLE') ? 'bikeTransit' : 'walkTransit'
  }
  /** Next minute ending in 3, at or after `ms`. */
  const nextBus = (ms: number) => {
    const min = 60000
    let t = Math.ceil(ms / min) * min
    while (new Date(t).getMinutes() % 10 !== 3) t += min
    return t
  }
  const refusingServer = ({
    segmentsToo = false
  }: { segmentsToo?: boolean } = {}) =>
    jest.fn((_url: string, options: { body?: string }) => {
      const { variables } = JSON.parse(options?.body || '{}')
      sent.push(variables)
      const kind = kindOf(variables)
      const from = place(variables.fromPlace)
      const to = place(variables.toPlace)
      const start = T(variables.time)
      let body: any
      if (kind !== 'bike' && (variables.via || segmentsToo)) {
        body = refused()
      } else if (kind === 'bike') {
        body = {
          data: {
            plan: {
              itineraries: variables.via
                ? []
                : [
                    {
                      duration: 1200,
                      endTime: start + 1200000,
                      legs: [
                        {
                          distance: 5000,
                          duration: 1200,
                          endTime: start + 1200000,
                          from,
                          mode: 'BICYCLE',
                          startTime: start,
                          to
                        }
                      ],
                      startTime: start
                    }
                  ],
              routingErrors: []
            }
          }
        }
      } else {
        const board = nextBus(start + 300000)
        const alight = board + 20 * 60000
        const stopA = { lat: from.lat + 0.001, lon: from.lon, name: 'Stop A' }
        body = {
          data: {
            plan: {
              itineraries: [
                {
                  duration: (alight - start) / 1000,
                  endTime: alight,
                  legs: [
                    {
                      distance: 300,
                      duration: 300,
                      endTime: start + 300000,
                      from,
                      mode: kind === 'bikeTransit' ? 'BICYCLE' : 'WALK',
                      startTime: start,
                      to: stopA
                    },
                    {
                      distance: 6000,
                      duration: 1200,
                      endTime: alight,
                      from: stopA,
                      mode: 'BUS',
                      route: { id: '1:46' },
                      startTime: board,
                      to,
                      transitLeg: true
                    }
                  ],
                  startTime: start,
                  waitingTime: (board - start - 300000) / 1000
                }
              ],
              routingErrors: []
            }
          }
        }
      }
      return Promise.resolve({ json: () => Promise.resolve(body), status: 200 })
    })

  describe('when OTP refuses the plan through the stop (52.1)', () => {
    let warn: jest.SpyInstance
    let error: jest.SpyInstance
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    })
    afterEach(() => {
      warn.mockRestore()
      error.mockRestore()
    })

    const types = () => actions.map((a) => a.type)
    const walkTransitSent = () =>
      sent.filter((v) => kindOf(v) === 'walkTransit')

    it('plans walk + transit as two segments without the via', async () => {
      anyGlobal.fetch = refusingServer()
      dispatch(routingQuery())
      await settle()
      const wt = walkTransitSent()
      // The refused via plan, then one plan per segment.
      expect(wt).toHaveLength(3)
      expect(wt[0].via).toEqual(viaVisitLocations([PERENNIAL]))
      expect(wt.slice(1).every((v) => v.via === undefined)).toBe(true)
      expect(wt.slice(1).every((v) => v.numItineraries === 1)).toBe(true)
      expect(wt.slice(1).map((v) => [v.fromPlace, v.toPlace])).toEqual([
        ['Home::44.8168,-93.3101', 'Perennial Cycle::44.941584,-93.298483'],
        [
          'Perennial Cycle::44.941584,-93.298483',
          'Micro Center::44.9396,-93.3466'
        ]
      ])
      // Segment 1: walk 10:00-10:05, bus 10:13-10:33. Segment 2 asked from
      // its arrival.
      expect(wt.slice(1).map((v) => v.time)).toEqual(['10:00', '10:33'])
    })

    it('settles that slot with one stitched itinerary through the stop, and no error', async () => {
      anyGlobal.fetch = refusingServer()
      dispatch(routingQuery())
      await settle()
      expect(types()).not.toContain('ROUTING_ERROR')
      const search = otpState.searches[otpState.activeSearchId]
      expect(search.pending).toBe(0)
      expect(search.response.some((r: any) => r?.error)).toBe(false)
      const itineraries = search.response.flatMap(
        (r: any) => r?.plan?.itineraries || []
      )
      const walkTransit = itineraries.filter(
        (it: any) =>
          it.legs.some((l: any) => l.transitLeg) &&
          !it.legs.some((l: any) => l.mode === 'BICYCLE')
      )
      expect(walkTransit).toHaveLength(1)
      const [it0] = walkTransit
      expect(it0.stopLegIndexes).toEqual([1])
      expect(it0.legs[1].to.name).toBe('Perennial Cycle')
      expect(it0.legs[2].from.name).toBe('Perennial Cycle')
      // Scheduled times kept: segment 2's walk 10:33-10:38, its bus at 10:43.
      expect(it0.legs[3].startTime).toBe(T('10:43'))
      expect(it0.endTime).toBe(T('11:03'))
      // The slot still says it asked for transit (22.2's copy reads it).
      const slot = search.response.find((r: any) =>
        r?.plan?.itineraries?.includes(it0)
      )
      expect(slot.transitRequested).toBe(true)
    })

    it('does not run the full bike + transit pass when the quick pass fell back', async () => {
      anyGlobal.fetch = refusingServer()
      dispatch(routingQuery())
      await settle()
      const bt = sent.filter((v) => kindOf(v) === 'bikeTransit')
      // The refused quick pass at 2000, then two segments — no 10000 pass.
      expect(bt).toHaveLength(3)
      expect(bt[0].maxStopCount).toBe(2000)
      expect(bt.some((v) => v.maxStopCount === 10000)).toBe(false)
      expect(bt.slice(1).every((v) => v.via === undefined)).toBe(true)
      expect(types()).not.toContain('ROUTING_SILENT_ERROR')
      expect(types()).not.toContain('ROUTING_EXTRA_REQUEST')
      const itineraries = otpState.searches[
        otpState.activeSearchId
      ].response.flatMap((r: any) => r?.plan?.itineraries || [])
      const bikeTransit = itineraries.find(
        (it: any) =>
          it.legs.some((l: any) => l.transitLeg) &&
          it.legs.some((l: any) => l.mode === 'BICYCLE')
      )
      expect(bikeTransit.stopLegIndexes).toEqual([1])
    })

    it('shows OTP’s own refusal when the segments cannot be planned either', async () => {
      anyGlobal.fetch = refusingServer({ segmentsToo: true })
      dispatch(routingQuery())
      await settle()
      const errors = actions.filter((a) => a.type === 'ROUTING_ERROR')
      expect(errors.length).toBeGreaterThan(0)
      errors.forEach((a) => {
        expect(a.payload.error).not.toBeInstanceOf(TypeError)
        expect(a.payload.error.message).toBe(PARETO)
      })
      // The bike chain still answers — after both refusals, so its slot index
      // already holds one of them — and the search settles.
      const search = otpState.searches[otpState.activeSearchId]
      expect(search.pending).toBe(0)
      const bike = search.response
        .flatMap((r: any) => r?.plan?.itineraries || [])
        .find((it: any) => it.legs.every((l: any) => l.mode === 'BICYCLE'))
      expect(bike.stopLegIndexes).toEqual([0])
      expect(search.response.filter((r: any) => r?.error)).toHaveLength(2)
    })

    it('a search with no stops and no plan gets OTP’s message, not a TypeError', async () => {
      otpState = {
        ...otpState,
        currentQuery: { ...currentQuery, intermediatePlaces: [] }
      }
      // Refuse every transit plan, via or not.
      anyGlobal.fetch = refusingServer({ segmentsToo: true })
      dispatch(routingQuery())
      await settle()
      // No chain: one plan per combination, plus nothing per segment.
      expect(walkTransitSent()).toHaveLength(1)
      const errors = actions.filter((a) => a.type === 'ROUTING_ERROR')
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0].payload.error).not.toBeInstanceOf(TypeError)
      expect(errors[0].payload.error.message).toBe(PARETO)
    })

    it('leaves a via plan OTP answers alone: no per-segment plans', async () => {
      // The original probe server: transit with the via plans fine.
      dispatch(routingQuery())
      await settle()
      expect(types()).not.toContain('ROUTING_ERROR')
      expect(
        walkTransitSent().every(
          (v) =>
            JSON.stringify(v.via) ===
            JSON.stringify(viaVisitLocations([PERENNIAL]))
        )
      ).toBe(true)
      expect(walkTransitSent()).toHaveLength(1)
    })
  })

  /**
   * Backlog 58.3 — a stay at each of the rider's stops. A transit plan asks
   * OTP for it (`minimumWaitTime`); the street-only chain asks each segment
   * from the end of the stay, forward and arrive-by.
   */
  describe('with a stay at the stop (58.3)', () => {
    const withStay = (extra: Record<string, unknown> = {}) => {
      otpState = {
        ...otpState,
        currentQuery: { ...currentQuery, stopStays: [20], ...extra }
      }
    }
    const street = () =>
      sent.filter((v) => !v.modes.some((m: any) => m.mode === 'TRANSIT'))
    const bikeItinerary = () =>
      otpState.searches[otpState.activeSearchId].response
        .flatMap((r: any) => r?.plan?.itineraries || [])
        .find((it: any) => it.legs.every((l: any) => l.mode === 'BICYCLE'))

    it('asks OTP for the stay on every transit plan', async () => {
      withStay()
      dispatch(routingQuery())
      await settle()
      const transit = sent.filter((v) =>
        v.modes.some((m: any) => m.mode === 'TRANSIT')
      )
      expect(transit.length).toBeGreaterThanOrEqual(2)
      transit.forEach((v) => {
        expect(v.via[0].visit.minimumWaitTime).toBe('PT20M')
        expect(v.stopStays).toBeUndefined()
      })
    })

    it('forward chain: the second segment leaves after the stay', async () => {
      withStay()
      dispatch(routingQuery())
      await settle()
      // 10:00-10:20 to the stop, 20 min there, then from 10:40.
      expect(street().map((v) => v.time)).toEqual(['10:00', '10:40'])
      const bike = bikeItinerary()
      expect(bike.stopLegIndexes).toEqual([0])
      expect(bike.stopStayMinutes).toEqual([20])
      expect(bike.legs[0].endTime).toBe(T('10:20'))
      expect(bike.legs[1].startTime).toBe(T('10:40'))
      expect(bike.endTime).toBe(T('11:00'))
      expect(bike.legs[1].from.riderStop).toEqual({
        arrivalTime: T('10:20'),
        stayMinutes: 20
      })
    })

    it('arrive-by chain: the first segment arrives a stay before the second leaves', async () => {
      withStay({ departArrive: 'ARRIVE', time: '11:00' })
      dispatch(routingQuery())
      await settle()
      // Planned backwards: Perennial -> Micro Center to arrive by 11:00
      // (leaves 10:40), then home -> Perennial to arrive by 10:20.
      expect(street().map((v) => [v.toPlace.split('::')[0], v.time])).toEqual([
        ['Micro Center', '11:00'],
        ['Perennial Cycle', '10:20']
      ])
      expect(street().every((v) => v.arriveBy === true)).toBe(true)
      const bike = bikeItinerary()
      expect(bike.startTime).toBe(T('10:00'))
      expect(bike.legs[0].endTime).toBe(T('10:20'))
      expect(bike.legs[1].startTime).toBe(T('10:40'))
      expect(bike.endTime).toBe(T('11:00'))
    })

    it('without a stay the chain is exactly as before', async () => {
      withStay({ stopStays: [] })
      dispatch(routingQuery())
      await settle()
      expect(street().map((v) => v.time)).toEqual(['10:00', '10:20'])
    })

    it('carries the stay in the URL beside the stop', async () => {
      withStay()
      dispatch(routingQuery())
      await settle()
      const pushed = actions
        .filter((a) => a.type === '@@router/CALL_HISTORY_METHOD')
        .map((a) => String(a.payload?.args?.[0]))
      expect(pushed.some((url) => /[?&]stopStays=20(&|$)/.test(url))).toBe(true)
    })

    it('a changed stay is a new question, not a duplicate of the one in flight', () => {
      withStay()
      expect(dispatch(routingQuery())).toBe(RoutingQueryCallResult.SUCCESS)
      // The same question again while the first is out is refused …
      expect(dispatch(routingQuery())).toBe(
        RoutingQueryCallResult.DUPLICATE_SEARCH_IN_FLIGHT
      )
      // … but with a different stay it goes.
      withStay({ stopStays: [30] })
      expect(dispatch(routingQuery())).toBe(RoutingQueryCallResult.SUCCESS)
    })
  })
})
