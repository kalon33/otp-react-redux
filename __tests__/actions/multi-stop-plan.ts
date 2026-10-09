/* globals afterEach, beforeEach, describe, expect, it, jest */
import '../test-utils/mock-window-url'
import { resetPlanQueryGate } from '../../lib/util/plan-concurrency'
import { routingQuery } from '../../lib/actions/apiV2'
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
  let otpState: any
  let reducer: any
  const anyGlobal = global as unknown as Record<string, unknown>
  let realFetch: unknown

  const getState = () => ({ otp: otpState, user: {} })
  const dispatch = (action: unknown): any => {
    if (typeof action === 'function') {
      return (action as (d: unknown, g: unknown) => unknown)(dispatch, getState)
    }
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
        const start = T(variables.time)
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
})
