/* globals afterEach, beforeEach, describe, expect, it, jest */
import '../test-utils/mock-window-url'
import { resetPlanQueryGate } from '../../lib/util/plan-concurrency'
import { resetRoutingDiagnosticGate } from '../../lib/util/plan-diagnostic'
import { routingQuery } from '../../lib/actions/apiV2'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'

/**
 * jest maps `*.graphql` to an empty string (package.json moduleNameMapper), so
 * core-utils' `generateOtp2Query` cannot `print()` its default document. Swap
 * in a valid stub document and keep every other thing core-utils does,
 * including the real variable assembly.
 */
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
 * Backlog 22.2, the wiring.
 *
 * The rider's 2026-09-21 09:25:58 Bloomington -> Lakeville search fanned out
 * into three plans and came back with one card, a 25 283 m / 94 min direct
 * bike. The day file (`~/otp-debug-logs/debug-2026-09-21.jsonl`, lines
 * 13657-13672) has the three answers:
 *
 *   index 1  [BICYCLE]           1 itinerary, the bike        routingErrors []
 *   index 0  [TRANSIT]           0 itineraries                NO_STOPS_IN_RANGE/TO
 *   index 2  [TRANSIT, BICYCLE]  the SAME bike                routingErrors []
 *
 * Index 2 is the failure and it recorded nothing that could name itself. Nine
 * serial probes against production 10:42-10:55 the same morning, with the
 * rider's exact variables, returned 13 itineraries and 12 transit every time.
 *
 * So: one more plan with `debugItineraryFilter: true`, once, after everything
 * else, and a ROUTING_DIAGNOSTIC record of the filter chain's tags.
 */
describe('actions > apiV2 > missing-transit diagnostic', () => {
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

  // The rider's own pair: 2345 Old Shakopee Rd W -> 19925 Idealic Ave, Lakeville.
  const currentQuery = {
    date: '2026-09-21',
    departArrive: 'NOW',
    from: { lat: 44.816546, lon: -93.30986, name: '2345 Old Shakopee Rd W' },
    intermediatePlaces: [],
    mode: 'WALK,TRANSIT',
    numItineraries: 40,
    routingType: 'ITINERARY',
    time: '09:00',
    to: { lat: 44.660949, lon: -93.25211, name: '19925 Idealic Ave' }
  }

  // `from`/`to` are not decoration: core-utils'
  // convertGraphQLResponseToLegacy reads `leg.from.stop` unguarded, and a leg
  // without them throws inside routingQuery's rewritePayload — which is caught
  // and turned into a ROUTING_ERROR, i.e. a plan that looks like it failed.
  const place = { lat: 44.8, lon: -93.3, name: 'x' }
  const bikeLeg = {
    distance: 25283,
    from: place,
    mode: 'BICYCLE',
    to: place,
    transitLeg: false
  }
  const busLeg = {
    from: place,
    mode: 'BUS',
    route: { gtfsId: '1:904', shortName: 'Orange' },
    to: place,
    transitLeg: true
  }
  const directBike = { duration: 5625, legs: [bikeLeg] }
  const bikeBusBike = { duration: 4440, legs: [bikeLeg, busLeg, bikeLeg] }

  interface Sent {
    query: string
    variables: Record<string, any>
  }

  let sent: Sent[]
  let actions: Array<{ payload?: any; type: string }>
  let otpState: any
  let reducer: any
  const anyGlobal = global as unknown as Record<string, unknown>
  let realFetch: unknown
  let warn: jest.SpyInstance

  const getState = () => ({ otp: otpState, user: {} })
  const dispatch = (action: any): any => {
    if (typeof action === 'function') return action(dispatch, getState)
    if (action && typeof action.type === 'string') actions.push(action)
    otpState = reducer(otpState, action)
    return action
  }

  /**
   * A server that answers each mode combination the way production answered the
   * rider, and answers the diagnostic re-plan (the one carrying
   * `debugItineraryFilter`) with `answerDiagnostic`.
   */
  const server = ({
    answerDiagnostic,
    transitCombo
  }: {
    answerDiagnostic?: unknown
    transitCombo: unknown
  }) =>
    jest.fn((_url: string, options: { body?: string }) => {
      const body = JSON.parse(options?.body || '{}')
      const v = body.variables || {}
      sent.push({ query: body.query, variables: v })
      const modes = (v.modes || []).map((m: { mode: string }) => m.mode)
      let data
      if (v.debugItineraryFilter) {
        data = answerDiagnostic
      } else if (!modes.includes('TRANSIT')) {
        data = { plan: { itineraries: [directBike], routingErrors: [] } }
      } else if (modes.includes('BICYCLE')) {
        data = transitCombo
      } else {
        // The walk-access transit call: honest about walking, and only walking.
        data = {
          plan: {
            itineraries: [],
            routingErrors: [
              {
                code: 'NO_STOPS_IN_RANGE',
                description: 'no stops within the search radius',
                inputField: 'TO'
              }
            ]
          }
        }
      }
      return Promise.resolve({
        json: () => Promise.resolve({ data }),
        status: 200
      })
    })

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  /** Everything answers immediately; just let the chained thens run out. */
  const settleAll = async () => {
    for (let round = 0; round < 12; round++) await flush()
  }

  const diagnostics = () =>
    sent.filter((req) => req.variables.debugItineraryFilter === true)
  const record = () => actions.find((a) => a.type === 'ROUTING_DIAGNOSTIC')

  beforeEach(() => {
    resetPlanQueryGate()
    resetRoutingDiagnosticGate()
    sent = []
    actions = []
    realFetch = anyGlobal.fetch
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    reducer = createOtpReducer(config)
    otpState = reducer(undefined, { type: '@@INIT' })
    otpState = { ...otpState, config, currentQuery, modeSettingDefinitions: [] }
  })
  afterEach(() => {
    anyGlobal.fetch = realFetch
    warn.mockRestore()
  })

  it('asks once, with the debug flag, when a transit request answers with only a bike', async () => {
    anyGlobal.fetch = server({
      answerDiagnostic: {
        plan: {
          itineraries: [
            { ...directBike, generalizedCost: 4455, systemNotices: [] },
            {
              ...bikeBusBike,
              generalizedCost: 4067,
              systemNotices: [{ tag: 'transit-vs-street-filter' }]
            }
          ],
          routingErrors: []
        }
      },
      // Exactly what index 2 answered on the ride: the same direct bike, and
      // not a word about why.
      transitCombo: { plan: { itineraries: [directBike], routingErrors: [] } }
    })
    dispatch(routingQuery())
    await settleAll()

    // Exactly one, and it is the transit+bicycle combination's own question.
    expect(diagnostics()).toHaveLength(1)
    const probe = diagnostics()[0]
    expect(probe.variables.modes).toEqual([
      { mode: 'TRANSIT' },
      { mode: 'BICYCLE' }
    ])
    // The rider's own levers, re-sent unchanged — a cheaper question would not
    // diagnose the expensive one's answer.
    expect(probe.variables.maxStopCount).toBe(10000)
    expect(probe.variables.searchWindow).toBe(7200)
    expect(probe.query).toContain('$debugItineraryFilter: Boolean')
    expect(probe.query).toContain('systemNotices')

    const rec = record()
    expect(rec).toBeDefined()
    expect(rec?.payload.reason).toBe('zero-transit-no-routing-error')
    expect(rec?.payload.request.index).toBe(2)
    expect(rec?.payload.original).toEqual({
      itineraries: 1,
      routingErrors: [],
      transitItineraries: 0
    })
    expect(rec?.payload.diagnostic.ok).toBe(true)
    expect(rec?.payload.diagnostic.transitItineraries).toBe(1)
    expect(rec?.payload.diagnostic.noticeCounts).toEqual({
      'transit-vs-street-filter': 1
    })
    // Nothing it learned reached the rider's list.
    expect(
      otpState.searches[otpState.activeSearchId].response.length
    ).toBeLessThanOrEqual(4)
  })

  it('asks nothing when the search did find transit', async () => {
    anyGlobal.fetch = server({
      transitCombo: {
        plan: {
          itineraries: [bikeBusBike, directBike],
          routingErrors: []
        }
      }
    })
    dispatch(routingQuery())
    await settleAll()
    expect(diagnostics()).toHaveLength(0)
    expect(record()).toBeUndefined()
  })

  it('asks nothing when the transit call errored', async () => {
    anyGlobal.fetch = jest.fn((_url: string, options: { body?: string }) => {
      const body = JSON.parse(options?.body || '{}')
      const v = body.variables || {}
      sent.push({ query: body.query, variables: v })
      const modes = (v.modes || []).map((m: { mode: string }) => m.mode)
      if (modes.includes('TRANSIT')) {
        return Promise.resolve({
          json: () => Promise.resolve({ errors: [{ message: 'boom' }] }),
          status: 500,
          statusText: 'Internal Server Error'
        })
      }
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            data: { plan: { itineraries: [directBike], routingErrors: [] } }
          }),
        status: 200
      })
    })
    dispatch(routingQuery())
    await settleAll()
    expect(diagnostics()).toHaveLength(0)
    expect(record()).toBeUndefined()
  })

  it('asks nothing when OTP already said why', async () => {
    // NO_TRANSIT_CONNECTION is stripped out of the stored response before the
    // reducer sees it, so the trigger reads OTP's RAW codes. Without that, this
    // case is indistinguishable from the silent one and would be re-asked.
    anyGlobal.fetch = server({
      transitCombo: {
        plan: {
          itineraries: [directBike],
          routingErrors: [{ code: 'NO_TRANSIT_CONNECTION', inputField: null }]
        }
      }
    })
    dispatch(routingQuery())
    await settleAll()
    expect(diagnostics()).toHaveLength(0)
    expect(record()).toBeUndefined()
  })

  it('asks nothing during a live trip', async () => {
    anyGlobal.fetch = server({
      transitCombo: { plan: { itineraries: [directBike], routingErrors: [] } }
    })
    otpState = { ...otpState, goMode: { ...otpState.goMode, isActive: true } }
    dispatch(routingQuery())
    await settleAll()
    expect(diagnostics()).toHaveLength(0)
  })

  it('records the failure rather than nothing when the diagnostic itself fails', async () => {
    anyGlobal.fetch = jest.fn((_url: string, options: { body?: string }) => {
      const body = JSON.parse(options?.body || '{}')
      const v = body.variables || {}
      sent.push({ query: body.query, variables: v })
      if (v.debugItineraryFilter) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              errors: [{ message: 'Unknown argument debugItineraryFilter' }]
            }),
          status: 200
        })
      }
      const modes = (v.modes || []).map((m: { mode: string }) => m.mode)
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            data: {
              plan: {
                itineraries: modes.includes('TRANSIT')
                  ? [directBike]
                  : [directBike],
                routingErrors: []
              }
            }
          }),
        status: 200
      })
    })
    dispatch(routingQuery())
    await settleAll()
    expect(diagnostics()).toHaveLength(1)
    expect(record()?.payload.diagnostic.ok).toBe(false)
    expect(record()?.payload.diagnostic.error).toContain('debugItineraryFilter')
  })

  it('marks which stored responses ran OTP’s transit search', async () => {
    anyGlobal.fetch = server({
      answerDiagnostic: { plan: { itineraries: [], routingErrors: [] } },
      transitCombo: { plan: { itineraries: [directBike], routingErrors: [] } }
    })
    dispatch(routingQuery())
    await settleAll()
    const responses = otpState.searches[otpState.activeSearchId].response
    // Indexes 0 and 2 are the transit-bearing combinations; index 1 is the
    // bike-only one. util/state reads this to decide whether "no transit
    // option was found" is a thing the search is entitled to say.
    expect(responses[0].transitRequested).toBe(true)
    expect(responses[1].transitRequested).toBe(false)
    expect(responses[2].transitRequested).toBe(true)
  })
})
