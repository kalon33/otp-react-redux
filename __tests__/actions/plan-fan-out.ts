/* globals afterEach, beforeEach, describe, expect, it, jest */
import '../test-utils/mock-window-url'
import { resetPlanQueryGate } from '../../lib/util/plan-concurrency'
import { routingQuery } from '../../lib/actions/apiV2'
import { RoutingQueryCallResult } from '../../lib/actions/api-constants'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'

/**
 * jest maps `*.graphql` to an empty string (package.json moduleNameMapper), so
 * core-utils' `generateOtp2Query` cannot `print()` its default document. Swap
 * in a valid stub document and keep every other thing core-utils does,
 * including the real variable assembly this test asserts on.
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
 * The wiring, not the helpers: what actually goes over the wire when the rider
 * taps Plan.
 *
 * Backlog 17.8 — production OTP threw `OutOfMemoryError: Java heap space`
 * twice during the 2026-09-15 15:46 ride. `combinations.forEach` had no await
 * and the rider's stop cap rode on every combination, so one search was three
 * concurrent cap-10000 plans (`ROUTING_REQUEST pending: 3` in the ride's own
 * telemetry), and the app fires two searches 0.4-0.9 s apart: six at once on a
 * 4-thread pool. Measured on the Linode on ride A's own O/D: x5 concurrent at
 * cap 10000 = 120.11 s wall, 4 of 5 `OutOfMemoryError`; the same five serial
 * at the server's cap, 2 s each.
 *
 * Backlog 14.2 — rider, 2026-09-12: "Why am I only getting one route here. I'd
 * prefer to get 5+ routes always."
 *
 * These cases exist because a unit test of the helpers cannot see a wiring
 * mistake: a cap attached to the wrong combination, a bound that is never
 * consulted, a re-query that fans out again.
 */
describe('actions > apiV2 > routingQuery fan-out', () => {
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

  // Ride A's own origin/destination (backlog 17.8's measurements).
  const currentQuery = {
    date: '2026-09-15',
    departArrive: 'NOW',
    from: { lat: 44.88310681395636, lon: -93.29538303290862, name: 'Origin' },
    intermediatePlaces: [],
    // Obsolete OTP1 param, still required by core-utils' getRoutingParams.
    mode: 'WALK,TRANSIT',
    numItineraries: 40,
    routingType: 'ITINERARY',
    time: '15:48',
    to: { lat: 44.97207, lon: -93.208231, name: 'Destination' }
  }

  interface Sent {
    resolve: () => void
    variables: Record<string, unknown>
  }

  let sent: Sent[]
  let otpState
  let reducer
  const anyGlobal = global as unknown as Record<string, unknown>
  let realFetch: unknown

  const getState = () => ({ otp: otpState, user: {} })
  const dispatch = (action: unknown) => {
    if (typeof action === 'function') {
      return (action as (d: unknown, g: unknown) => unknown)(dispatch, getState)
    }
    otpState = reducer(otpState, action)
    return action
  }

  /**
   * A server that records what it was asked and answers only when this test
   * says so — the only way to see how many plans are in flight at once.
   */
  const controllableServer = (itineraries: unknown[] = []) =>
    jest.fn((_url: string, options: { body?: string }) => {
      const body = JSON.parse(options?.body || '{}')
      return new Promise((resolve) => {
        sent.push({
          resolve: () =>
            resolve({
              json: () =>
                Promise.resolve({
                  data: { plan: { itineraries, routingErrors: [] } }
                }),
              status: 200
            }),
          variables: body.variables
        })
      })
    })

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const settleAll = async () => {
    // Answer everything currently in flight, repeatedly, until nothing new is
    // asked (the widening top-up is issued only after the fan-out settles).
    for (let round = 0; round < 6; round++) {
      const pending = [...sent]
      pending.forEach((req) => req.resolve())
      await flush()
      await flush()
      if (sent.length === pending.length) break
    }
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
  })
  afterEach(() => {
    anyGlobal.fetch = realFetch
  })

  it('sends the rider’s stop cap only where there is a stop search to cap', async () => {
    anyGlobal.fetch = controllableServer()
    dispatch(routingQuery())
    await flush()

    // The ride's own fan-out: three combinations, `pending: 3`. Two of them
    // run OTP's transit search and carry the rider's cap; the bike-only one
    // has no access/egress to cap, so it goes out cheap and outside the bound.
    expect(sent).toHaveLength(3)
    const byModes = Object.fromEntries(
      sent.map((req) => [
        JSON.stringify(req.variables.modes),
        req.variables.maxStopCount
      ])
    )
    expect(byModes[JSON.stringify([{ mode: 'TRANSIT' }])]).toBe(10000)
    expect(
      byModes[JSON.stringify([{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }])]
    ).toBe(10000)
    expect(byModes[JSON.stringify([{ mode: 'BICYCLE' }])]).toBeUndefined()
    await settleAll()
  })

  it('never has more than two cap-bearing plans in flight', async () => {
    // Transit + bicycle + car generates four combinations, three of them
    // cap-bearing ([TRANSIT], [TRANSIT, BICYCLE], [TRANSIT, CAR]; car alone is
    // not a valid combination) — enough to see the bound hold something back.
    const carConfig = {
      ...config,
      modes: {
        ...config.modes,
        initialState: { enabledModeButtons: ['transit', 'bicycle', 'car'] },
        modeButtons: [
          ...config.modes.modeButtons,
          { key: 'car', modes: [{ mode: 'CAR' }] }
        ]
      }
    }
    reducer = createOtpReducer(carConfig)
    otpState = reducer(undefined, { type: '@@INIT' })
    otpState = {
      ...otpState,
      config: carConfig,
      currentQuery,
      modeSettingDefinitions: []
    }
    anyGlobal.fetch = controllableServer()
    dispatch(routingQuery())
    await flush()

    const capped = () =>
      sent.filter((req) => req.variables.maxStopCount === 10000)
    const street = () =>
      sent.filter((req) => req.variables.maxStopCount === undefined)
    // Before this fix all four went out at once.
    expect(capped()).toHaveLength(2)
    expect(street()).toHaveLength(1)

    // Releasing a cheap street-only plan frees no slot: it never took one.
    street()[0].resolve()
    await flush()
    expect(capped()).toHaveLength(2)

    // Releasing a cap-bearing one lets the queued combination go out, and only
    // that one.
    capped()[0].resolve()
    await flush()
    expect(capped()).toHaveLength(3)
    await settleAll()
  })

  it('refuses the 0.8 s twin of a search already in flight', async () => {
    anyGlobal.fetch = controllableServer()
    expect(dispatch(routingQuery())).toBe(RoutingQueryCallResult.SUCCESS)
    await flush()
    const duringFirst = sent.length

    // The same tap's location change kicks formChanged's debounced auto-replan.
    expect(dispatch(routingQuery())).toBe(
      RoutingQueryCallResult.DUPLICATE_SEARCH_IN_FLIGHT
    )
    await flush()
    expect(sent).toHaveLength(duringFirst)

    // Once it has settled the rider can ask again.
    await settleAll()
    const afterFirst = sent.length
    expect(dispatch(routingQuery())).toBe(RoutingQueryCallResult.SUCCESS)
    await flush()
    expect(sent.length).toBeGreaterThan(afterFirst)
    await settleAll()
  })

  it('lets through a search the rider actually changed', async () => {
    anyGlobal.fetch = controllableServer()
    expect(dispatch(routingQuery())).toBe(RoutingQueryCallResult.SUCCESS)
    await flush()
    otpState = {
      ...otpState,
      currentQuery: {
        ...currentQuery,
        to: { lat: 44.92718, lon: -93.213779, name: 'Hiawatha Church' }
      }
    }
    expect(dispatch(routingQuery())).toBe(RoutingQueryCallResult.SUCCESS)
    await settleAll()
  })

  /**
   * 14.2's top-up. One query, after everything else has settled, on the
   * combination the rider's modes actually produced results with, at a wider
   * window and the cheap cap.
   */
  it('asks once more, wider, when the list comes back thin', async () => {
    anyGlobal.fetch = controllableServer()
    dispatch(routingQuery())
    await settleAll()

    expect(sent).toHaveLength(4)
    const topUp = sent[3]
    expect(topUp.variables.searchWindow).toBe(14400)
    expect(topUp.variables.maxStopCount).toBe(2000)
    // The rider's own modes, not a wider set: only the window and the cap
    // change (feedback_no_forced_route_changes).
    expect(topUp.variables.modes).toEqual([
      { mode: 'TRANSIT' },
      { mode: 'BICYCLE' }
    ])
    // Not a second fan-out: exactly one extra plan.
    expect(
      sent.filter((req) => req.variables.searchWindow === 14400)
    ).toHaveLength(1)
    // And the first three asked for the default window.
    sent
      .slice(0, 3)
      .forEach((req) => expect(req.variables.searchWindow).toBe(7200))
    // The search is not left looking pending forever.
    expect(otpState.searches[otpState.activeSearchId].pending).toBe(0)
    expect(otpState.searches[otpState.activeSearchId].response).toHaveLength(4)
  })

  it('does not widen a window that is already wider', async () => {
    const wideConfig = {
      ...config,
      itinerary: { searchWindowSeconds: 21600 }
    }
    reducer = createOtpReducer(wideConfig)
    otpState = reducer(undefined, { type: '@@INIT' })
    otpState = {
      ...otpState,
      config: wideConfig,
      currentQuery,
      modeSettingDefinitions: []
    }
    anyGlobal.fetch = controllableServer()
    dispatch(routingQuery())
    await settleAll()
    expect(sent).toHaveLength(3)
    sent.forEach((req) => expect(req.variables.searchWindow).toBe(21600))
  })

  it('does not widen while Go Mode is live', async () => {
    anyGlobal.fetch = controllableServer()
    otpState = { ...otpState, goMode: { ...otpState.goMode, isActive: true } }
    dispatch(routingQuery())
    await settleAll()
    expect(sent).toHaveLength(3)
  })
})
