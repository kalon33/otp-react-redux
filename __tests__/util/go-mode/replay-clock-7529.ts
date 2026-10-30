/* globals afterEach, describe, expect, it, jest */
import '../../test-utils/mock-window-url'

import fs from 'fs'
import path from 'path'

import { applyMiddleware, combineReducers, createStore } from 'redux'
import FakeTimers from '@sinonjs/fake-timers'
import thunk from 'redux-thunk'

import * as debugLog from '../../../lib/util/debug-log'
import {
  goModeNowMs,
  replayTrip,
  stopReplay
} from '../../../lib/actions/go-mode'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'

/** Same stub as detour-riding-hold-1012.ts: these replays run the real tick. */
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
 * BACKLOG 75.29 — a replay runs on ONE clock: the recording's.
 *
 * Every other replay suite pins the wall clock at the fixture's own moment
 * (`FakeTimers.install({ now: fx.meta.startMs })`), which is exactly what
 * hides a wall-clock read. A browser replay runs days or weeks after its ride,
 * so these run with the wall clock at WALL, nine days after the newest of
 * them, and every wall read shows up as a 2026-10-29 stamp.
 *
 * - transfer-match-1020 / ride-1020-0819: `replayTrip` ran startGoMode and
 *   startGoModeTracking BEFORE startTrackReplay set the sim clock, so
 *   SET_TRANSIT_LEG_ENTERED and the deviation settle window's
 *   geometryChangedAtMs were wall time; 0819 pushed "1939m from the route"
 *   one second in (the ride, `mvgplnrw-yvtqga`, pushed nothing).
 * - ride-1019-0902 / ride-1020-0819: the track of a trip entered through the
 *   onboard flow begins at the flow, 20-44 s before START_GO_MODE
 *   (`meta.startMs`). Each fix was played at `meta.startMs` plus the track's
 *   elapsed time — 0902's rider met their own bus 1:3408 at 847 m — and, on
 *   the fixture's own clock, the trip would start before it began: 0819's
 *   settle window then ran out at 08:19:37, 5 s into the real trip.
 * - 1026-1214: the 12:29:10 quiet re-plan re-entered startGoModeTracking with
 *   no replay flag and armed the 90 s wall-clock background interval, so the
 *   REROUTE_SNAPSHOT count was 3 at speed 12 and 5 at speed 4 in the sweep.
 */
const FIXTURES = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)
const load = (name: string): any => {
  const file = path.join(FIXTURES, `${name}.json`)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

/** 2026-10-29 08:00 CDT: the day the sweep ran, long after every ride here. */
const WALL = Date.parse('2026-10-29T08:00:00-05:00')
const DAY_MS = 24 * 60 * 60 * 1000

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

interface Recorded {
  p: any
  /** Go Mode's clock when the action was dispatched. */
  t: number
  type: string
}

async function replay(
  fixture: any,
  { speed, untilSimMs }: { speed: number; untilSimMs?: number }
): Promise<Recorded[]> {
  // A fresh copy per replay: the connection and turn latches are keyed on the
  // leg OBJECTS, so a second replay of the same object would start with the
  // first one's warnings already said.
  const fx = JSON.parse(JSON.stringify(fixture))
  const globalScope: any = global
  globalScope.fetch = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({}), ok: true, status: 200 })
  )
  const clock = FakeTimers.install({ now: WALL })
  const events: Recorded[] = []
  const recorder = () => (next: any) => (action: any) => {
    if (action && typeof action === 'object' && action.type) {
      events.push({ p: action.payload, t: goModeNowMs(), type: action.type })
    }
    return next(action)
  }
  const store = createStore(
    combineReducers({ otp: createOtpReducer(CONFIG as any) }),
    applyMiddleware(thunk, recorder)
  )
  try {
    await store.dispatch(replayTrip(fx, { speedMultiplier: speed }) as any)
    for (let i = 0; i < 20000; i++) {
      await clock.tickAsync(1000)
      if (store.getState().otp.goMode.simulation.status !== 'running') break
      if (untilSimMs != null && goModeNowMs() >= untilSimMs) break
    }
  } finally {
    store.dispatch(stopReplay() as any)
    clock.uninstall()
  }
  return events
}

/**
 * The decision timeline the replay sweep compared across speeds
 * ($S/diff-speeds.py): what the rider would be told or have done to their
 * trip, keyed as the sweep keyed it, from START_GPS_SIMULATION to the track's
 * end, with the sim time of each.
 */
const DECISIONS = new Set([
  'ABOARD_CHECK_VERDICT',
  'ADD_NOTIFICATION',
  'AUTO_REPLAN',
  'AUTO_SWITCH',
  'BEGIN_ONBOARD_FLOW',
  'CLEAR_RIDING',
  'CONFIRM_VEHICLE',
  'FASTER_ROUTE_OFFER',
  'HELD_RUN_VERDICT',
  'PLAN_RETARGET',
  'REROUTE_SNAPSHOT',
  'SET_ARRIVED',
  'SET_EARLY_ALIGHT',
  'SET_FASTER_ROUTE_OFFER',
  'SET_RIDING',
  'START_GO_MODE',
  'START_REROUTE',
  'TRANSITION_LEG'
])

function decisionKey(e: Recorded): string {
  const p = e.p || {}
  switch (e.type) {
    case 'ADD_NOTIFICATION':
      return `NOTIFY ${p.type}: ${p.title} | ${p.message}`
    case 'START_REROUTE':
      return `START_REROUTE ${p.reason} auto=${p.autoApply}`
    case 'SET_RIDING':
      return e.p
        ? `SET_RIDING ${p.tripId}/${p.vehicleId} leg ${p.legIndex}`
        : 'SET_RIDING null'
    case 'START_GO_MODE':
      return `START_GO_MODE ${(p.itinerary?.legs || [])
        .map(
          (l: any) =>
            `${l.mode}:${l.route?.gtfsId ?? l.routeId ?? ''}:${
              l.trip?.gtfsId ?? l.tripId ?? ''
            }`
        )
        .join(' ')}`
    case 'AUTO_REPLAN':
      return `AUTO_REPLAN ${p.reason} accepted=${p.accepted} refused=${p.refusedBecause}`
    case 'TRANSITION_LEG':
      return `TRANSITION_LEG ${typeof e.p === 'object' ? p.legIndex : e.p}`
    case 'HELD_RUN_VERDICT':
      return `HELD_RUN_VERDICT ${p.at} makes=${p.makes} why=${p.why}`
    default:
      return e.type
  }
}

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/Chicago' })

function decisions(events: Recorded[]): string[] {
  const start = events.findIndex((e) => e.type === 'START_GPS_SIMULATION')
  const end = events.findIndex(
    (e, i) => i > start && e.type === 'STOP_GPS_SIMULATION'
  )
  return events
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((e) => DECISIONS.has(e.type))
    .map((e) => `${hhmmss(e.t)} ${decisionKey(e)}`)
}

afterEach(() => {
  jest.restoreAllMocks()
})

jest.setTimeout(900000)

const transferMatch = load('transfer-match-1020')
;(transferMatch ? describe : describe.skip)(
  '75.29 R3 — transfer-match-1020: the clock exists before the trip',
  () => {
    it('enters the first transit leg as the trip starts, not at the wall clock', async () => {
      const startMs = transferMatch.meta.startMs
      const events = await replay(transferMatch, {
        speed: 4,
        untilSimMs: startMs + 20000
      })
      const entered = events.filter((e) => e.type === 'SET_TRANSIT_LEG_ENTERED')
      // The 94 is leg 0: entered as the trip starts — 2026-10-20 09:34:30.
      expect(entered.length).toBeGreaterThan(0)
      expect(entered[0].p).toBe(startMs)
      expect(hhmmss(entered[0].p)).toBe('09:34:30')
      // Nothing in the replay's own start was stamped on the wall clock.
      const start = events.find((e) => e.type === 'START_GO_MODE') as Recorded
      expect(start.t).toBe(startMs)
      for (const e of entered) expect(WALL - e.p).toBeGreaterThan(DAY_MS)
    })
  }
)

const ride0819 = load('ride-1020-0819')
;(ride0819 ? describe : describe.skip)(
  '75.29 R3 — ride-1020-0819: no off-route push the ride never sent',
  () => {
    it('stays inside the 25 s settle window: no ROUTE_DEVIATION at all', async () => {
      const events = await replay(ride0819, { speed: 4 })
      const pushes = events.filter((e) => e.type === 'ADD_NOTIFICATION')
      expect(
        pushes
          .filter((e) => e.p?.type === 'ROUTE_DEVIATION')
          .map((e) => `${hhmmss(e.t)} ${e.p.message}`)
      ).toEqual([])
      // It ran the trip's own 16 fixes, 08:19:32.999-08:19:47.999 — the 22
      // from 08:19:12, the onboard flow, came before Go Mode existed.
      const played = events.filter((e) => e.type === 'UPDATE_POSITION')
      expect(played.map((e) => e.p.timestamp)).toEqual(
        ride0819.gpsTrack
          .map((f: any) => f.tMs)
          .filter((t: number) => t >= ride0819.meta.startMs)
      )
      expect(played).toHaveLength(16)
    })
  }
)

const ride0902 = load('ride-1019-0902')
;(ride0902 ? describe : describe.skip)(
  '75.29 R12 — ride-1019-0902: every fix at its own recorded time',
  () => {
    it('plays each fix at its own tMs and matches the rider’s bus at that moment', async () => {
      const events = await replay(ride0902, { speed: 4 })
      const played = events
        .filter((e) => e.type === 'UPDATE_POSITION')
        .map((e) => e.p?.timestamp)
      // START_GO_MODE 09:02:30.671; the track's first fix, 09:01:46.997, is
      // the onboard flow's. The trip's first fix is played at its own time,
      // and so is every one after it (164 of 209).
      const track = ride0902.gpsTrack
        .map((f: any) => f.tMs)
        .filter((t: number) => t >= ride0902.meta.startMs)
      expect(track).toHaveLength(164)
      expect(played[0]).toBe(track[0])
      expect(hhmmss(played[0])).toBe('09:02:30')
      expect(played).toEqual(track)
      // The bus the rider tapped on the ride, 1:3408, is first matched on the
      // trip's first tick, against the poll the phone held then (09:02:30.898,
      // a frame stamped 09:01:34): 577 m. Main paired the onboard flow's
      // 09:01:46.997 fix with that poll and read 851 m, then 847 m (the
      // sweep's figure). What remains is the feed's own lag, not the replay:
      // the phone's raw distance to that frame was 1,052 m at 09:02:31.
      const firstMatch = events.find(
        (e) =>
          e.type === 'UPDATE_VEHICLE_MATCH' &&
          e.p?.match?.vehicleId === '1:3408'
      ) as Recorded
      expect(firstMatch).toBeDefined()
      expect(firstMatch.t).toBe(track[0])
      expect(firstMatch.p.match.distanceMeters).toBeLessThan(600)
    })
  }
)

const swap1214 = load('1026-1214')
;(swap1214 ? describe : describe.skip)(
  '75.29 R2 — 1026-1214: a replay with a mid-trip swap is speed-invariant',
  () => {
    it('makes the same decisions at the same sim seconds at 4x and 12x', async () => {
      // Recording on, as the sweep's ?debugLog=1 page had it: the background
      // interval's REROUTE_SNAPSHOT is what showed the 90 s wall cadence.
      jest.spyOn(debugLog, 'isTripRecordingEnabled').mockReturnValue(true)
      const at4 = decisions(await replay(swap1214, { speed: 4 }))
      const at12 = decisions(await replay(swap1214, { speed: 12 }))
      // The swap the sweep saw is in it (the replay's own 12:29:10 re-plan).
      expect(at4.filter((d) => d.includes('START_GO_MODE')).length).toBe(
        at12.filter((d) => d.includes('START_GO_MODE')).length
      )
      expect(at4.some((d) => d.includes('START_GO_MODE'))).toBe(true)
      expect(at12).toEqual(at4)
      // A replay never arms the live 90 s interval, so nothing it records is
      // paced by the harness.
      expect(at4.filter((d) => d.endsWith('REROUTE_SNAPSHOT'))).toEqual([])
    })
  }
)
