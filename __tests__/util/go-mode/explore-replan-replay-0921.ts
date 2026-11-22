/* globals describe, expect, it, jest */
import '../../test-utils/mock-window-url'

import { applyMiddleware, combineReducers, createStore } from 'redux'
import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'
import thunk from 'redux-thunk'

import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import { fetchBikeExplore } from '../../../lib/util/bike-explore'
import { replayTrip, stopReplay } from '../../../lib/actions/go-mode'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'

jest.mock('@opentripplanner/core-utils', () => {
  const actual = jest.requireActual('@opentripplanner/core-utils')
  const { parse } = jest.requireActual('graphql')
  const stub = parse('query Plan { plan { itineraries { duration } } }')
  const core = actual.default || actual
  const patched = {
    ...core,
    queryGen: {
      ...core.queryGen,
      // merge_dev runs core-utils 16.2.0, whose generateOtp2Query signature
      // is (params, homeTimezone, query); this branch's tests were written
      // against 14.2.4's (params, query) and passed the stub where
      // homeTimezone goes — "Invalid time zone specified: [object Object]".
      generateOtp2Query: (params: unknown, homeTimezone: string) =>
        core.queryGen.generateOtp2Query(params, homeTimezone, stub)
    }
  }
  return { ...actual, __esModule: true, default: patched }
})
jest.mock('../../../lib/util/bike-explore', () => ({
  ...jest.requireActual('../../../lib/util/bike-explore'),
  fetchBikeExplore: jest.fn()
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fixture: any = require('../../../lib/util/go-mode/replay/fixtures/0921-0902-orange-lake-st.json')

const mockedEngine = fetchBikeExplore as jest.Mock

/**
 * BACKLOG 76.3, replayed. `0921-0902-orange-lake-st` (2026-09-21, session
 * `mubbbiy9-6zjoq9`): a bike ride to the Orange Line at I-35W & Lake St on
 * which the phone made four quiet access re-plans (`quiet-replan-scoped`,
 * 09:03:00, 09:20:39, 09:21:17, 09:23:42), each served back here from the
 * recording.
 *
 * The same ride as a Calm trip — the fixture's plan with the engine's mark on
 * its bike leg — through the real store, the real tick and the replay
 * engine. The engine is a STUB (no fixture has recorded one): a straight ride
 * from the asked origin to the asked stop at the asked speed, 20 % longer than
 * the crow flies, feasible when it leaves the rider's margin before the bus.
 * What is under test is Go Mode's side: that each re-plan asks the engine
 * first and installs its ride through the gate, keeping the bus. Measured on
 * this branch: three engine re-plans (sim 09:02:59, 09:04:59, 09:06:15 CDT),
 * all accepted, the ride to Lake St shrinking 1,491 → 1,104 → 604 → 216 m.
 */
const stubEngine = (url: string, body: any) => {
  const c = body.candidates[0]
  const metres =
    1.2 * calculateDistance(body.lat, body.lon, Number(c.lat), Number(c.lon))
  const speed = Number(body.speed) || 5
  const duration = Math.round(metres / speed)
  const margin = 180 + 0.1 * duration
  return Promise.resolve({
    candidates: [
      {
        calm: 1,
        direct: { calm: 0.8, distance_m: metres, duration_s: duration },
        distance_m: metres,
        duration_s: duration,
        feasible: c.depart_s == null || duration + margin <= c.depart_s,
        id: c.id,
        leg: {
          distance: metres,
          duration,
          legGeometry: {
            length: 2,
            points: encode([
              [body.lat, body.lon],
              [Number(c.lat), Number(c.lon)]
            ])
          },
          mode: 'BICYCLE',
          steps: []
        },
        margin_s: Math.round(margin),
        preference: 1,
        score: 50
      }
    ],
    mode: body.mode,
    status: 'ok'
  })
}

const CONFIG = {
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

async function replay(fx: any) {
  const globalScope: any = global
  globalScope.fetch = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({}), ok: true, status: 200 })
  )
  const clock = FakeTimers.install({ now: 1790181000000 })
  const verdicts: any[] = []
  const installs: any[] = []
  const recorder = () => (next: any) => (action: any) => {
    if (action?.type === 'AUTO_REPLAN') verdicts.push(action.payload)
    if (action?.type === 'START_GO_MODE')
      installs.push(action.payload.itinerary)
    return next(action)
  }
  const store = createStore(
    combineReducers({ otp: createOtpReducer(CONFIG as any) }),
    applyMiddleware(thunk, recorder)
  )
  await store.dispatch(replayTrip(fx, { speedMultiplier: 1 }) as any)
  for (let i = 0; i < 20000; i++) {
    await clock.tickAsync(1000)
    if (store.getState().otp.goMode.simulation.status !== 'running') break
  }
  store.dispatch(stopReplay() as any)
  clock.uninstall()
  return { installs, verdicts }
}

const asCalm = (fx: any) => {
  const copy = JSON.parse(JSON.stringify(fx))
  copy.itinerary.legs[0].exploreRide = {
    calm: 1,
    marginS: 220,
    mode: 'calm',
    preference: 1,
    stopId: 'replay'
  }
  return copy
}

const transitTrips = (itinerary: any) =>
  (itinerary?.legs || [])
    .filter((l: any) => l.transitLeg)
    .map((l: any) => `${l.route?.gtfsId ?? l.routeId}@${l.from?.name}`)

describe('76.3 replay: a Calm trip re-plans its bike leg with the engine', () => {
  it('Direct (the ride as recorded): the engine is never asked', async () => {
    mockedEngine.mockReset()
    mockedEngine.mockImplementation(stubEngine)
    const r = await replay(fixture)
    expect(mockedEngine).not.toHaveBeenCalled()
    expect(r.verdicts.map((v) => v.reason)).toContain('quiet-replan-scoped')
    expect(r.verdicts.map((v) => v.reason)).not.toContain(
      'quiet-replan-explore'
    )
  }, 600000)

  it('Calm: every re-plan of the ride to the bus asks the engine first and keeps the bus', async () => {
    mockedEngine.mockReset()
    mockedEngine.mockImplementation(stubEngine)
    const fx = asCalm(fixture)
    const r = await replay(fx)
    const explore = r.verdicts.filter(
      (v) => v.reason === 'quiet-replan-explore'
    )
    expect(mockedEngine.mock.calls.length).toBeGreaterThan(0)
    expect(explore.length).toBe(mockedEngine.mock.calls.length)
    expect(explore.every((v) => v.accepted)).toBe(true)
    // Each one installed, so OTP's scoped question was never needed.
    expect(r.verdicts.map((v) => v.reason)).not.toContain('quiet-replan-scoped')
    mockedEngine.mock.calls.forEach(([, body]) => {
      expect(body.mode).toBe('calm')
      expect(body.candidates).toHaveLength(1)
      expect(body.candidates[0].depart_s).toBeGreaterThan(0)
    })
    // The rider's bus is the bus: every installed plan boards the Orange Line
    // where the held plan did.
    const held = transitTrips(fx.itinerary)
    r.installs.slice(1).forEach((itinerary) => {
      expect(transitTrips(itinerary)).toEqual(held)
    })
    const engineInstalls = r.installs.filter(
      (i) => i?.legs?.[0]?.exploreRide?.mode === 'calm' && i.legs[0].steps
    )
    expect(engineInstalls.length).toBeGreaterThan(1)
  }, 600000)
})
