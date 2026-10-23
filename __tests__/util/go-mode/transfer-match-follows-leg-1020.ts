/* globals afterEach, describe, expect, it, jest */
import '../../test-utils/mock-window-url'

import fs from 'fs'
import path from 'path'

import { applyMiddleware, combineReducers, createStore } from 'redux'
import FakeTimers from '@sinonjs/fake-timers'
import thunk from 'redux-thunk'

import * as transitTrust from '../../../lib/util/go-mode/transit-trust'
import {
  CONFIRM_VEHICLE,
  performVehicleMatching,
  replayTrip,
  setRiding,
  startGoMode,
  stopReplay,
  updatePosition
} from '../../../lib/actions/go-mode'
import { matchFollowsRoute } from '../../../lib/util/go-mode/transit-trust'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'

/** Same stub as detour-riding-hold-1012.ts: this replay runs the real tick. */
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
 * BACKLOG 67.2 — after a same-stop change from one transit leg to another, the
 * new leg's vehicle was never matched and the rider was never marked aboard.
 *
 * 2026-10-20, session `mvgr2jqp-b81j4g` (dev), the 94 → Gold Line change at
 * 5th St & Cedar Station. From ~/otp-debug-logs/debug-2026-10-20.jsonl:
 *
 *   09:25:16.507 CONFIRM_VEHICLE 1:2015 (route 1:94), refreshed every tick
 *   09:35:55.112 UPDATE_VEHICLE_MATCH confirmed 1:2015 — the last of the ride
 *   09:35:56.088 TRANSITION_LEG 1 (the Gold Line, trip 1:1262609)
 *   09:35:56.115 UPDATE_VEHICLE_MATCH {emptyPolls: 1}
 *   09:35:57-09:57:12 no UPDATE_VEHICLE_MATCH, no UPDATE_NEARBY_VEHICLES,
 *                no SET_RIDING — while every 1:905 poll carried train 8181
 *                on trip 1:1262609, 6 m from the rider at 09:35:56.
 *
 * Mechanism: advanceToLeg started 1:905 tracking without clearing the 94's
 * confirmed match (TRANSITION_LEG clears only `riding`), so every
 * performVehicleMatching('1:905') took the confirmed branch, could not find
 * 1:2015 in the 905 feed, and returned before the matcher, the nearby list,
 * the boarding prompt or the riding decision ever ran. A walk between buses
 * goes through stopVehicleTracking, which is why only a same-stop
 * transit → transit change was hit.
 *
 * The replay below is cut from the untracked 62 MB recording
 * (ride-1020-0907.json) into transfer-match-1020.json: the 09:34:30-09:50:00
 * gpsTrack, the 1:94 and 1:905 vehicle snapshots, and the itinerary of the
 * 09:25:16 START_GO_MODE (94 → Gold Line → bike).
 */

const FIXTURE = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/transfer-match-1020.json'
)
const fixture: any = fs.existsSync(FIXTURE)
  ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  : null

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

/** 2026-10-20 HH:MM:SS CDT as epoch ms. */
const at = (hms: string) => Date.parse(`2026-10-20T${hms}-05:00`)

const GOLD_TRIP = '1:1262609'
const GOLD_TRAIN = '1:8181'

/** The 94 riding fact carried into the 09:25:16 START_GO_MODE. */
const RIDING_94 = {
  boardedAt: 1792505978046,
  headsign: 'Express / I-94 / Downtown St Paul',
  legIndex: 0,
  offRouteSince: null,
  routeId: '1:94',
  routeShortName: '94',
  tripId: '1:1186422',
  vehicleId: '1:2015'
}
/** CONFIRM_VEHICLE 09:25:16.507. */
const CONFIRMED_94 = {
  confidence: 'confirmed',
  distanceMeters: null,
  label: '94',
  lastSeen: at('09:25:16'),
  routeId: '1:94',
  tripId: '1:1186422',
  vehicleId: '1:2015'
}

interface Recorded {
  p: any
  t: number
  type: string
}

async function replay(fx: any) {
  const globalScope: any = global
  globalScope.fetch = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({}), ok: true, status: 200 })
  )
  const clock = FakeTimers.install({ now: fx.meta.startMs })
  const events: Recorded[] = []
  let lastSim = fx.meta.startMs
  const keep = new Set([
    'CLEAR_RIDING',
    'CLEAR_VEHICLE_MATCH',
    'CONFIRM_VEHICLE',
    'REALTIME_VEHICLE_POSITIONS_RESPONSE',
    'SET_RIDING',
    'TRANSITION_LEG',
    'UPDATE_NEARBY_VEHICLES',
    'UPDATE_VEHICLE_MATCH'
  ])
  const recorder = () => (next: any) => (action: any) => {
    if (action && typeof action === 'object' && keep.has(action.type)) {
      events.push({ p: action.payload, t: lastSim, type: action.type })
    }
    return next(action)
  }
  const store = createStore(
    combineReducers({ otp: createOtpReducer(CONFIG as any) }),
    applyMiddleware(thunk, recorder)
  )
  store.subscribe(() => {
    const g = store.getState().otp.goMode
    if (g?.progress?.currentTime) {
      const t = new Date(g.progress.currentTime).getTime()
      if (t > lastSim) lastSim = t
    }
  })
  const dispatch: any = store.dispatch
  // Where the phone stood at 09:34:30: aboard the 94 on leg 0, holding the
  // confirmed match for 1:2015 that every tick since 09:25:16 refreshed.
  dispatch(setRiding(RIDING_94 as any))
  dispatch({ payload: CONFIRMED_94, type: CONFIRM_VEHICLE })
  await dispatch(replayTrip(fx, { speedMultiplier: 4 }))
  for (let i = 0; i < 10000; i++) {
    await clock.tickAsync(1000)
    if (store.getState().otp.goMode.simulation.status !== 'running') break
  }
  const riding = store.getState().otp.goMode.riding
  dispatch(stopReplay())
  clock.uninstall()

  const transition = events.find(
    (e) => e.type === 'TRANSITION_LEG' && e.p?.legIndex === 1
  )
  const afterIdx = transition ? events.indexOf(transition) : events.length
  const after = events.slice(afterIdx + 1)
  const of = (type: string) => after.filter((e) => e.type === type)
  return {
    after,
    clears: of('CLEAR_RIDING'),
    goldPolls: of('REALTIME_VEHICLE_POSITIONS_RESPONSE').filter(
      (e) => e.p?.routeId === '1:905'
    ),
    matches: of('UPDATE_VEHICLE_MATCH'),
    nearby: of('UPDATE_NEARBY_VEHICLES'),
    riding,
    sets: of('SET_RIDING'),
    transition,
    vehicleClears: of('CLEAR_VEHICLE_MATCH')
  }
}

afterEach(() => {
  jest.restoreAllMocks()
})

jest.setTimeout(600000)
;(fixture ? describe : describe.skip)(
  '67.2 — the 2026-10-20 94 → Gold Line change, replayed',
  () => {
    it('as shipped (the old match stands for every route): nothing after the change', async () => {
      // The pre-fix decision exactly: a match never stops speaking for the
      // route being polled.
      jest.spyOn(transitTrust, 'matchFollowsRoute').mockReturnValue(true)
      const r = await replay(fixture)
      // The change lands within a second of the phone's 09:35:56.088.
      expect(r.transition).toBeDefined()
      expect(
        Math.abs((r.transition as Recorded).t - at('09:35:56'))
      ).toBeLessThanOrEqual(1000)
      // The Gold Line feed was polled the whole way...
      expect(r.goldPolls.length).toBeGreaterThan(500)
      // ...and nothing ever looked at it: the ride's own 09:35:57-09:57:12.
      expect(r.matches).toEqual([])
      expect(r.nearby).toEqual([])
      expect(r.sets).toEqual([])
      expect(r.vehicleClears).toEqual([])
      expect(r.riding).toBeNull()
    })

    it('after: the change drops the 94 match, 8181 is matched and the rider is aboard', async () => {
      const r = await replay(fixture)
      expect(r.transition).toBeDefined()
      const tr = r.transition as Recorded
      // The 94's match is dropped at the change itself.
      expect(r.vehicleClears).toHaveLength(1)
      expect(r.vehicleClears[0].t).toBe(tr.t)
      // 8181 is the first thing matched, inside two Gold Line polls.
      const first8181 = r.matches.findIndex(
        (e) => e.p?.match?.vehicleId === GOLD_TRAIN
      )
      expect(first8181).toBe(0)
      const pollsBefore = r.goldPolls.filter(
        (e) => r.after.indexOf(e) <= r.after.indexOf(r.matches[first8181])
      )
      expect(pollsBefore.length).toBeLessThanOrEqual(2)
      expect(r.matches[first8181].p.match).toMatchObject({
        routeId: '1:905',
        tripId: GOLD_TRIP
      })
      // No other vehicle is ever named on this leg.
      expect(
        r.matches.filter(
          (e) => e.p?.match?.vehicleId && e.p.match.vehicleId !== GOLD_TRAIN
        )
      ).toEqual([])
      // Aboard 8181 on the Gold Line leg — well before 09:46:17, where the
      // phone's digest still read "Riding: not aboard".
      expect(r.sets).toHaveLength(1)
      expect(r.sets[0].p).toMatchObject({
        legIndex: 1,
        routeId: '1:905',
        tripId: GOLD_TRIP,
        vehicleId: GOLD_TRAIN
      })
      expect(r.sets[0].t).toBeLessThan(at('09:46:17'))
      expect(r.sets[0].t - tr.t).toBeLessThanOrEqual(2000)
      // ...and still aboard at 09:50, never cleared on the way.
      expect(r.clears).toEqual([])
      expect(r.riding).toMatchObject({
        legIndex: 1,
        tripId: GOLD_TRIP,
        vehicleId: GOLD_TRAIN
      })
      // The nearby list and matcher run on every tick of the leg again.
      expect(r.nearby.length).toBe(r.matches.length)
    })

    it('an interlined Gold Line leg keeps the 94 match (same bus, new number)', async () => {
      const fx = JSON.parse(JSON.stringify(fixture))
      fx.itinerary.legs[1].interlineWithPreviousLeg = true
      fx.gpsTrack = fx.gpsTrack.filter((g: any) => g.tMs <= at('09:37:00'))
      const r = await replay(fx)
      expect(r.transition).toBeDefined()
      expect(r.vehicleClears).toEqual([])
      // 1:2015 is not in the 905 feed, so the kept match ages honestly
      // instead of being replaced by a different vehicle.
      expect(
        r.matches.filter((e) => e.p?.match?.vehicleId === GOLD_TRAIN)
      ).toEqual([])
    })
  }
)

/* ─── performVehicleMatching, synthetic ────────────────────────────────── */

const NOW = 1_800_000_000_000
const RIDER = { lat: 44.9466, lon: -93.0866 }
const leg = (routeId: string, tripId: string, over: any = {}) => ({
  distance: 1000,
  duration: 600,
  endTime: NOW + 600000,
  from: { lat: RIDER.lat, lon: RIDER.lon, name: 'From' },
  interlineWithPreviousLeg: false,
  legGeometry: { length: 0, points: '' },
  mode: 'BUS',
  route: { gtfsId: routeId, id: routeId },
  startTime: NOW,
  to: { lat: RIDER.lat + 0.01, lon: RIDER.lon, name: 'To' },
  transitLeg: true,
  trip: { gtfsId: tripId },
  ...over
})
const bus = (vehicleId: string, routeId: string, over: any = {}) => ({
  directionId: '0',
  heading: null,
  label: vehicleId.slice(2),
  lat: RIDER.lat,
  lon: RIDER.lon,
  nextStopId: '1:next',
  nextStopName: 'Next',
  patternId: `${routeId}:0:01`,
  routeId,
  seconds: NOW / 1000,
  speed: 0,
  stopStatus: 'IN_TRANSIT_TO',
  tripHeadsign: 'Somewhere',
  tripId: `${routeId}-trip`,
  vehicleId,
  ...over
})
const CONFIRMED_A = {
  confidence: 'confirmed' as const,
  distanceMeters: null,
  label: '94',
  lastSeen: NOW - 30000,
  routeId: '1:94',
  tripId: '1:94-trip',
  vehicleId: '1:2015'
}

function storeWith(legs: any[], vehiclesByRoute: Record<string, any[]>) {
  const matches: any[] = []
  const recorder = () => (next: any) => (action: any) => {
    if (action?.type === 'UPDATE_VEHICLE_MATCH') matches.push(action.payload)
    return next(action)
  }
  const store = createStore(
    combineReducers({ otp: createOtpReducer(CONFIG as any) }),
    applyMiddleware(thunk, recorder)
  )
  const dispatch: any = store.dispatch
  dispatch(
    startGoMode({ itinerary: { legs } as any, nowMs: NOW, originalFrom: null })
  )
  dispatch(
    updatePosition({
      coords: {
        accuracy: 5,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        latitude: RIDER.lat,
        longitude: RIDER.lon,
        speed: 0
      },
      timestamp: NOW
    } as any)
  )
  for (const [routeId, vehicles] of Object.entries(vehiclesByRoute)) {
    dispatch({
      payload: { routeId, vehicles },
      type: 'REALTIME_VEHICLE_POSITIONS_RESPONSE'
    })
  }
  dispatch({ payload: CONFIRMED_A, type: CONFIRM_VEHICLE })
  matches.length = 0
  return { dispatch, matches, store }
}

describe('67.2 — performVehicleMatching follows the route it is asked about', () => {
  it('a confirmed match on route A, asked about route B, runs the matcher', () => {
    const { dispatch, matches, store } = storeWith(
      [leg('1:94', '1:94-trip'), leg('1:905', '1:905-trip')],
      { '1:905': [bus('1:8181', '1:905')] }
    )
    dispatch(performVehicleMatching('1:905'))
    expect(matches).toHaveLength(1)
    expect(matches[0].match.vehicleId).toBe('1:8181')
    expect(matches[0].match.confidence).not.toBe('confirmed')
    // A fresh run: no continuity borrowed from the 94.
    expect(matches[0].consecutiveMatches).toBe(1)
    expect(store.getState().otp.goMode.vehicleMatch.match.vehicleId).toBe(
      '1:8181'
    )
  })

  it('control: as shipped the same call dispatched nothing', () => {
    jest.spyOn(transitTrust, 'matchFollowsRoute').mockReturnValue(true)
    const { dispatch, matches, store } = storeWith(
      [leg('1:94', '1:94-trip'), leg('1:905', '1:905-trip')],
      { '1:905': [bus('1:8181', '1:905')] }
    )
    dispatch(performVehicleMatching('1:905'))
    expect(matches).toEqual([])
    expect(store.getState().otp.goMode.vehicleMatch.match.vehicleId).toBe(
      '1:2015'
    )
  })

  it('the same route keeps the confirmed refresh path', () => {
    const { dispatch, matches } = storeWith([leg('1:94', '1:94-trip')], {
      // The confirmed bus 300 m on, and another 94 right at the rider.
      '1:94': [
        bus('1:2099', '1:94'),
        bus('1:2015', '1:94', {
          lat: RIDER.lat + 0.0027,
          tripId: '1:94-trip'
        })
      ]
    })
    dispatch(performVehicleMatching('1:94'))
    expect(matches).toHaveLength(1)
    expect(matches[0].match).toMatchObject({
      confidence: 'confirmed',
      vehicleId: '1:2015'
    })
    expect(matches[0].match.distanceMeters).toBeGreaterThan(250)
    expect(matches[0].match.distanceMeters).toBeLessThan(350)
  })

  it('an interlined leg keeps its confirmed bus under the new route number', () => {
    const legs = [
      leg('1:94', '1:94-trip'),
      leg('1:4', '1:4-trip', { interlineWithPreviousLeg: true })
    ]
    // The same bus now listed under route 4, with another 4 at the rider.
    const { dispatch, matches } = storeWith(legs, {
      '1:4': [
        bus('1:7777', '1:4'),
        bus('1:2015', '1:4', { lat: RIDER.lat + 0.0027 })
      ]
    })
    dispatch(performVehicleMatching('1:4'))
    expect(matches).toHaveLength(1)
    expect(matches[0].match).toMatchObject({
      confidence: 'confirmed',
      vehicleId: '1:2015'
    })
  })

  it('an interlined leg whose bus is not in the feed yet ages honestly', () => {
    const legs = [
      leg('1:94', '1:94-trip'),
      leg('1:4', '1:4-trip', { interlineWithPreviousLeg: true })
    ]
    const { dispatch, matches, store } = storeWith(legs, {
      '1:4': [bus('1:7777', '1:4')]
    })
    dispatch(performVehicleMatching('1:4'))
    expect(matches).toEqual([])
    expect(store.getState().otp.goMode.vehicleMatch.match.vehicleId).toBe(
      '1:2015'
    )
  })
})

describe('matchFollowsRoute', () => {
  const legs: any[] = [
    leg('1:94', 't94'),
    leg('1:905', 't905'),
    leg('1:4', 't4', { interlineWithPreviousLeg: true }),
    leg('1:5', 't5', { interlineWithPreviousLeg: true })
  ]
  it('no route on either side → follows (nothing to compare)', () => {
    expect(matchFollowsRoute(null, '1:94', legs)).toBe(true)
    expect(matchFollowsRoute({ routeId: null }, '1:94', legs)).toBe(true)
    expect(matchFollowsRoute({ routeId: '1:94' }, null, legs)).toBe(true)
  })
  it('same route → follows', () => {
    expect(matchFollowsRoute({ routeId: '1:94' }, '1:94', legs)).toBe(true)
  })
  it('a different, non-interlined route → does not', () => {
    expect(matchFollowsRoute({ routeId: '1:94' }, '1:905', legs)).toBe(false)
    expect(matchFollowsRoute({ routeId: '1:94' }, '1:905')).toBe(false)
  })
  it('reached through an interline chain → follows', () => {
    expect(matchFollowsRoute({ routeId: '1:905' }, '1:4', legs)).toBe(true)
    expect(matchFollowsRoute({ routeId: '1:905' }, '1:5', legs)).toBe(true)
    expect(matchFollowsRoute({ routeId: '1:4' }, '1:5', legs)).toBe(true)
  })
  it('an interline chain does not reach back past a real change', () => {
    expect(matchFollowsRoute({ routeId: '1:94' }, '1:4', legs)).toBe(false)
    expect(matchFollowsRoute({ routeId: '1:5' }, '1:4', legs)).toBe(false)
  })
})
