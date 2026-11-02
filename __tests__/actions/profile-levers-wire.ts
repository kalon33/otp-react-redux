/* globals afterEach, beforeEach, describe, expect, it, jest */
import '../test-utils/mock-window-url'
import { resetPlanQueryGate } from '../../lib/util/plan-concurrency'
import { routingQuery } from '../../lib/actions/apiV2'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'

// Same stub as plan-fan-out.ts: jest maps *.graphql to '', so core-utils'
// default plan document cannot be printed.
jest.mock('@opentripplanner/core-utils', () => {
  const actual = jest.requireActual('@opentripplanner/core-utils')
  const { parse } = jest.requireActual('graphql')
  const stub = parse(
    'query Plan { planConnection { edges { node { duration } } } }'
  )
  const core = actual.default || actual
  const patched = {
    ...core,
    queryGen: {
      ...core.queryGen,
      generateOtp2Query: (params: unknown, homeTimezone: string) =>
        core.queryGen.generateOtp2Query(params, homeTimezone, stub)
    }
  }
  return { ...actual, __esModule: true, default: patched }
})

/**
 * Rider report (2026-11-02, Paris): the Bus/Tram/Metro toggles did nothing —
 * a deselected bus still came back in the results — and the routing profiles
 * (Fastest / Fewer Transfers) seemed inert. This pins the wire format:
 * every transit plan the fork dispatches must carry (a) the rider's
 * transit-mode restriction as planConnection's modes.transit.transit
 * preference list, and (b) the profile levers as plan() variables.
 *
 * core-utils' generateCombinations used to inject the enabled transit
 * submodes; the fork's subset fan-out had lost that, so every transit plan
 * went out with no restriction and the server answered with every mode.
 */
describe('actions > apiV2 > routingQuery wire format', () => {
  const config = {
    api: { host: 'http://mock-host.com', path: '/api', port: 80 },
    homeTimezone: 'America/Chicago',
    itinerary: {},
    modes: {
      initialState: { enabledModeButtons: ['transit'] },
      modeButtons: [
        { key: 'transit', modes: [{ mode: 'TRANSIT' }] },
        { key: 'bicycle', modes: [{ mode: 'BICYCLE' }] }
      ],
      transitModes: []
    },
    persistence: { enabled: false }
  }

  // The SUBMODE settings the panel builds from config.modes.transitModes
  // (default: true — every toggle starts on), plus the stay-seated
  // profile's levers on currentQuery.
  const modeSettingDefinitions = [
    {
      addTransportMode: [{ mode: 'TROLLEYBUS' }, { mode: 'BUS' }],
      applicableMode: 'TRANSIT',
      default: true,
      key: 'bus',
      type: 'SUBMODE'
    },
    {
      addTransportMode: { mode: 'TRAM' },
      applicableMode: 'TRANSIT',
      default: true,
      key: 'tram',
      type: 'SUBMODE'
    },
    {
      addTransportMode: { mode: 'SUBWAY' },
      applicableMode: 'TRANSIT',
      default: true,
      key: 'metro',
      type: 'SUBMODE'
    }
  ]

  const currentQuery = {
    date: '2026-10-09',
    departArrive: 'DEPART',
    from: { lat: 44.8168, lon: -93.3101, name: 'Home' },
    mode: 'WALK,TRANSIT',
    numItineraries: 3,
    routingPreferences: { transferPenalty: 600, waitReluctance: 4 },
    routingType: 'ITINERARY',
    time: '10:00',
    to: { lat: 44.9396, lon: -93.3466, name: 'Micro Center' }
  }

  let sent: Array<Record<string, any>>
  let otpState: any
  let reducer: any
  const anyGlobal = global as unknown as Record<string, unknown>
  let realFetch: unknown
  let realHref: unknown

  const getState = () => ({ otp: otpState, user: {} })
  const dispatch = (action: unknown): any => {
    if (typeof action === 'function') {
      return (action as (d: unknown, g: unknown) => unknown)(dispatch, getState)
    }
    otpState = reducer(otpState, action)
    return action
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const settle = async () => {
    for (let i = 0; i < 12; i++) await flush()
  }

  beforeEach(() => {
    resetPlanQueryGate()
    sent = []
    realFetch = anyGlobal.fetch
    realHref = anyGlobal.location.href
    // The URL the settings panel writes: transit on, bus deselected. jsdom
    // refuses direct href assignment, but replaceState does the same job.
    anyGlobal.history.replaceState(
      null,
      '',
      'http://localhost:9966/?modeButtons=transit&bus=false&tram=true&metro=true'
    )
    reducer = createOtpReducer(config)
    otpState = reducer(undefined, { type: '@@INIT' })
    otpState = {
      ...otpState,
      config,
      currentQuery,
      modeSettingDefinitions
    }
    anyGlobal.fetch = jest.fn((_url: string, options: { body?: string }) => {
      const { variables } = JSON.parse(options?.body || '{}')
      sent.push(variables)
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            data: {
              planConnection: { edges: [{ node: { duration: 600 } }] }
            }
          })
      })
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    anyGlobal.fetch = realFetch
    anyGlobal.history.replaceState(null, '', realHref as string)
  })

  it('carries the transit-mode restriction and the profile levers', async () => {
    dispatch(routingQuery())
    await settle()
    expect(sent.length).toBeGreaterThan(0)
    const transit = sent.filter((v) => v.modes?.transitOnly)
    expect(transit.length).toBeGreaterThan(0)
    transit.forEach((v) => {
      const modes = v.modes.transit.transit.map((p: any) => p.mode)
      expect(modes).toContain('TRAM')
      expect(modes).toContain('SUBWAY')
      expect(modes).not.toContain('BUS')
      expect(modes).not.toContain('TROLLEYBUS')
      // The stay-seated profile levers ride as plan() variables.
      expect(v.transferPenalty).toBe(600)
      expect(v.waitReluctance).toBe(4)
    })
  })
})
