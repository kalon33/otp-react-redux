/* globals afterEach, beforeEach, describe, expect, it, jest */
/* eslint-disable @typescript-eslint/no-explicit-any */
import '../test-utils/mock-window-url'
import { clearActiveSearch } from '../../lib/actions/form'
import { MobileScreens } from '../../lib/actions/ui-constants'
import { resetPlanQueryGate } from '../../lib/util/plan-concurrency'
import { routingQuery } from '../../lib/actions/apiV2'
import { showMobileSearchScreen } from '../../lib/actions/ui'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'

// Same stub as plan-fan-out.ts / progressive-bike-transit.ts: jest maps
// *.graphql to '', so core-utils' default plan document cannot be printed.
jest.mock('@opentripplanner/core-utils', () => {
  const actual = jest.requireActual('@opentripplanner/core-utils')
  const { parse } = jest.requireActual('graphql')
  const stub = parse('query Plan { plan { itineraries { duration } } }')
  const core = actual.default || actual
  const patched = {
    ...core,
    queryGen: {
      ...core.queryGen,
      generateOtp2Query: (params: unknown, homeTimezone?: string) =>
        core.queryGen.generateOtp2Query(params, homeTimezone, stub)
    }
  }
  return { ...actual, __esModule: true, default: patched }
})

/**
 * Backlog 70.1 — 2026-10-20, session mvh5pg8t-ypn5ph. The rider tapped the
 * results screen's Edit to look at what they had asked for:
 *
 *   16:02:24.842 ROUTING_REQUEST 7wq1iy8ce (3 combos)
 *   16:02:26.192 CLEAR_ACTIVE_SEARCH + SET_MOBILE_SCREEN 3   <- Edit, 1.4 s in
 *   16:02:35.814 ROUTING_REQUEST adlkaogwr                   <- planned again
 *   16:02:38.859 ROUTING_EXTRA_REQUEST BICYCLE_TRANSIT_FULL
 *   16:02:40.009 CLEAR_ACTIVE_SEARCH + SET_MOBILE_SCREEN 3   <- Edit, 4.2 s in
 *
 * Edit (showMobileSearchScreen) cleared the active search, and the follow-up
 * passes skip a search that is not the active one (api-utils.ts
 * shouldRunFullBikeTransitPass / shouldRunLowBikePass), so the search was
 * left half done. Edit now keeps it.
 */
describe('backlog 70.1 > Edit mid-load keeps the search', () => {
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

  const currentQuery = {
    date: '2026-10-20',
    departArrive: 'NOW',
    from: { lat: 44.95316, lon: -92.957, name: '(Current Location)' },
    intermediatePlaces: [],
    mode: 'WALK,TRANSIT',
    numItineraries: 40,
    routingType: 'ITINERARY',
    time: '16:02',
    to: { lat: 44.9358, lon: -93.2259, name: '3322 Columbus' }
  }

  const T = (hhmm: string) => new Date(`2026-10-20T${hhmm}:00-05:00`).getTime()
  const bikeBus = (route: string, hhmm: string) => {
    const start = T(hhmm)
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
          duration: 1500,
          endTime: start + 1800000,
          from: { name: 'Board', stop: { gtfsId: `MN:${route}-a` } },
          mode: 'BUS',
          route: { id: `1:${route}`, shortName: route },
          routeShortName: route,
          startTime: start + 300000,
          to: { name: '3322 Columbus', stop: { gtfsId: `MN:${route}-b` } },
          transitLeg: true,
          trip: { gtfsId: `t-${route}` }
        }
      ],
      startTime: start
    }
  }
  const plan = (itineraries: any[]) => ({
    data: { plan: { itineraries, routingErrors: [] } }
  })
  // The variables go out in the planConnection PlanModesInput shape (see
  // util/plan-combinations): a direct-mode list carries the street-only
  // combinations, and a transit block names its access modes.
  const kindOf = (v: Record<string, any>) => {
    const modes: string[] = v.modes || {}
    const direct = (modes.direct || []).map((m: any) => (typeof m === 'string' ? m : m.mode))
    if (direct.length > 0 && !modes.transit) {
      return direct.includes('BICYCLE') || direct.includes('BICYCLE_RENT') ? 'bike' : 'walk'
    }
    const access: string[] = (modes.transit?.access || []).map((m: any) => (typeof m === 'string' ? m : m.mode))
    return access.includes('BICYCLE') || access.includes('BICYCLE_RENT') ? 'bikeTransit' : 'walkTransit'
  }
  const answer = (v: Record<string, any>) => {
    const kind = kindOf(v)
    if (kind === 'bike') return plan([])
    if (kind === 'walkTransit') {
      return plan(
        [1, 2, 3, 4, 5].map((n) => ({
          ...bikeBus(`${n}`, `16:1${n}`),
          legs: bikeBus(`${n}`, `16:1${n}`).legs.map((leg) =>
            leg.mode === 'BICYCLE' ? { ...leg, mode: 'WALK' } : leg
          )
        }))
      )
    }
    return plan([bikeBus('21', '16:10'), bikeBus('67', '16:20')])
  }

  let sent: Array<Record<string, any>>
  let actions: any[]
  let otpState: any
  let reducer: any
  let releaseQuick: (() => void) | null
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
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const settleAll = async () => {
    for (let round = 0; round < 20; round++) await flush()
  }
  const types = () => actions.map((a) => a.type)
  const fullPassesSent = () =>
    sent.filter((v) => kindOf(v) === 'bikeTransit' && v.maxStopCount === 10000)

  beforeEach(() => {
    resetPlanQueryGate()
    sent = []
    actions = []
    releaseQuick = null
    realFetch = anyGlobal.fetch
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    reducer = createOtpReducer(config as any)
    otpState = reducer(undefined, { type: '@@INIT' })
    otpState = {
      ...otpState,
      config,
      currentQuery,
      modeSettingDefinitions: [],
      ui: { ...otpState.ui, mobileScreen: MobileScreens.RESULTS_SUMMARY }
    }
    // The quick bike + transit pass is held until the test releases it, so
    // Edit is tapped while the search is still loading (16:02:26, 1.4 s in).
    anyGlobal.fetch = jest.fn((_url: string, options: { body?: string }) => {
      const { variables } = JSON.parse(options?.body || '{}')
      sent.push(variables)
      const respond = () =>
        Promise.resolve({
          json: () => Promise.resolve(answer(variables)),
          status: 200
        })
      if (kindOf(variables) === 'bikeTransit' && !releaseQuick) {
        return new Promise((resolve) => {
          releaseQuick = () => resolve(respond())
        })
      }
      return respond()
    })
  })
  afterEach(() => {
    anyGlobal.fetch = realFetch
    warn.mockRestore()
    error.mockRestore()
  })

  it('Edit while loading: the search stays active, its extra pass still runs, the form is shown', async () => {
    dispatch(routingQuery())
    await settleAll()
    const searchId = otpState.activeSearchId
    expect(searchId).toBeTruthy()
    expect(otpState.searches[searchId].pending).toBeGreaterThan(0)

    dispatch(showMobileSearchScreen())
    expect(types()).not.toContain('CLEAR_ACTIVE_SEARCH')
    expect(otpState.activeSearchId).toBe(searchId)
    expect(otpState.ui.mobileScreen).toBe(MobileScreens.SEARCH_FORM)
    ;(releaseQuick as unknown as () => void)()
    await settleAll()
    // The full bike + transit pass (BICYCLE_TRANSIT_FULL) went out for it.
    expect(fullPassesSent()).toHaveLength(1)
    expect(types()).toContain('ROUTING_EXTRA_REQUEST')
    expect(otpState.activeSearchId).toBe(searchId)
    expect(otpState.searches[searchId].pending).toBe(0)
    // Nothing was asked of OTP twice: one search, no re-plan.
    expect(types().filter((t) => t === 'ROUTING_REQUEST')).toHaveLength(1)
    expect(otpState.ui.mobileScreen).toBe(MobileScreens.SEARCH_FORM)
  })

  it('control: clearing the search mid-load (the old Edit) loses the extra pass', async () => {
    dispatch(routingQuery())
    await settleAll()
    dispatch(clearActiveSearch())
    ;(releaseQuick as unknown as () => void)()
    await settleAll()
    expect(fullPassesSent()).toHaveLength(0)
  })
})
