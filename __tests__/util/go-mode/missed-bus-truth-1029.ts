/* globals describe, expect, it, jest */
import '../../test-utils/mock-window-url'

import fs from 'fs'
import path from 'path'

import { applyMiddleware, combineReducers, createStore } from 'redux'
import FakeTimers from '@sinonjs/fake-timers'
import thunk from 'redux-thunk'

import {
  checkMissedBus,
  classifyMissedBus
} from '../../../lib/util/go-mode/notification-service'
import { replayTrip, stopReplay } from '../../../lib/actions/go-mode'
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
      generateOtp2Query: (params: unknown) =>
        core.queryGen.generateOtp2Query(params, stub)
    }
  }
  return { ...actual, __esModule: true, default: patched }
})

/**
 * Three ways "Missed bus" told the rider something untrue, all found by the
 * 2026-10-28/29 isolated stress-test session (backlog Tier 75) and all in the
 * missed-bus classifier or its call in handlePositionUpdate.
 *
 * 75.3 — "Missed bus · next departure" plus an auto-applied re-plan for the bus
 * the rider had just ridden to the end of its leg. Once the off-route clock
 * dropped the riding fact, nothing the classifier was given said the leg had
 * been ridden, and the matcher was still on it.
 *
 * 75.5 — on the tick the planned trip's bus is first matched, the classifier
 * read the PREVIOUS tick's vehicle match off the tick's opening snapshot.
 *
 * 25.1 (chaos C3) — the same bus announced missed twice, 60 s apart, because
 * the push's dedupe key carried its board epoch, and a realtime epoch moves.
 *
 * The replays run the recorded fixtures through the real store, the real tick
 * and replayTrip, with no riding fact carried in: the sweep that found these
 * started every fixture that way.
 */

const FIXTURES = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)
const load = (name: string): any => {
  const file = path.join(FIXTURES, `${name}.json`)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
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

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

interface Recorded {
  p: any
  /** goMode.progress as the action found it. */
  progress: any
  /** The GPS fix being processed when the action was dispatched. */
  t: number
  type: string
}

/** Replay a fixture (optionally cut at `untilMs`); every action recorded. */
async function replay(fx: any, untilMs?: number) {
  const cut = { ...fx }
  if (untilMs != null) {
    cut.gpsTrack = fx.gpsTrack.filter((g: any) => g.tMs <= untilMs)
  }
  const globalScope: any = global
  globalScope.fetch = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({}), ok: true, status: 200 })
  )
  const clock = FakeTimers.install({ now: fx.meta.startMs })
  const events: Recorded[] = []
  let fixT = 0
  const recorder = (api: any) => (next: any) => (action: any) => {
    if (action && typeof action === 'object') {
      if (action.type === 'UPDATE_POSITION') fixT = action.payload?.timestamp
      events.push({
        p: action.payload,
        progress: api.getState().otp.goMode?.progress ?? null,
        t: fixT,
        type: action.type
      })
    }
    return next(action)
  }
  const store = createStore(
    combineReducers({ otp: createOtpReducer(CONFIG as any) }),
    applyMiddleware(thunk, recorder)
  )
  await store.dispatch(replayTrip(cut, { speedMultiplier: 4 }) as any)
  for (let i = 0; i < 10000; i++) {
    await clock.tickAsync(1000)
    if (store.getState().otp.goMode.simulation.status !== 'running') break
  }
  store.dispatch(stopReplay() as any)
  clock.uninstall()

  const of = (type: string) => events.filter((e) => e.type === type)
  return {
    clears: of('CLEAR_RIDING'),
    events,
    missed: of('ADD_NOTIFICATION').filter((e) => e.p?.type === 'MISSED_BUS'),
    missedReplans: of('START_REROUTE').filter(
      (e) => e.p?.reason === 'missed-bus'
    ),
    sets: of('SET_RIDING'),
    transitions: of('TRANSITION_LEG')
  }
}

jest.setTimeout(600000)

/* ─── 75.3: the classifier, on the 2026-10-19 Gold Line ride's numbers ──── */

/** gold-1631-1019 leg 0 (METRO Gold Line, trip 1:1343603) and leg 1 (94). */
const GOLD_BOARD_MS = 1792445497270 // 16:31:37.270
const JACKSON = {
  lat: 44.948784,
  lon: -93.090581,
  name: '6th St & Jackson Station',
  stop: { gtfsId: '1:57456' }
}
const MINNESOTA = {
  lat: 44.947532,
  lon: -93.093165,
  name: '6th St & Minnesota Station',
  stop: { gtfsId: '1:57417' }
}
const GOLD_LEGS: any[] = [
  {
    endTime: 1792445669000,
    from: JACKSON,
    mode: 'BUS',
    routeLongName: 'METRO Gold Line',
    startTime: GOLD_BOARD_MS,
    to: MINNESOTA,
    transitLeg: true,
    trip: { gtfsId: '1:1343603' }
  },
  {
    endTime: 1792447830000,
    from: MINNESOTA,
    mode: 'BUS',
    routeShortName: '94',
    startTime: 1792446351000,
    to: { lat: 44.974976, lon: -93.2675, name: '7th St & 3rd/4th Ave Station' },
    transitLeg: true,
    trip: { gtfsId: '1:1186627' }
  }
]
/** The replay's 16:37:53 tick: the fix, ~530 m west of 6th St & Jackson. */
const AT_163753 = 1792445873999
const RIDER_163753: [number, number] = [44.94804480662564, -93.09720205053199]
/** SET_RIDING 16:33:09, dropped by CLEAR_RIDING 16:37:45. */
const RIDDEN_GOLD = { legIndex: 0, tripId: '1:1343603', vehicleId: '1:8173' }

const goldInput = (over: Record<string, any> = {}): any => ({
  clearedRiding: null,
  currentLegIndex: 0,
  departureOverrideMs: null,
  legs: GOLD_LEGS,
  liveLegTimes: {},
  nowMs: AT_163753,
  progressOnCurrentLeg: null,
  riderPosition: RIDER_163753,
  riderSpeedMps: 0,
  riding: null,
  vehicleConfidence: undefined,
  ...over
})

describe('75.3 — a boarding already made is not one to miss (classifier)', () => {
  it('without the ridden facts, 16:37:53 reads as a definitive miss of the 16:31:37 boarding', () => {
    // What the tick handed the classifier on main: riding cleared, no match,
    // leg 0 still the matcher's leg. Everything else in the classifier agrees
    // it is a miss, so the ridden facts are what has to decide it.
    expect(classifyMissedBus(goldInput())).toEqual({
      boardLegIndex: 0,
      definitive: true,
      effectiveBoardMs: GOLD_BOARD_MS,
      realtime: false
    })
  })

  it('leg 0 finished behind the rider (100 %, 0 stops to go): no miss', () => {
    expect(
      classifyMissedBus(
        goldInput({
          progressOnCurrentLeg: { currentLegProgress: 100, stopsRemaining: 0 }
        })
      )
    ).toBeNull()
  })

  it('the 16:42:53 slide to 87.99 % cannot un-finish it: the latched count still reads 0', () => {
    expect(
      classifyMissedBus(
        goldInput({
          nowMs: 1792446173000,
          progressOnCurrentLeg: { currentLegProgress: 87.99, stopsRemaining: 0 }
        })
      )
    ).toBeNull()
  })

  it('the dropped riding fact named this run: no miss, wherever progress reads', () => {
    expect(
      classifyMissedBus(
        goldInput({
          clearedRiding: RIDDEN_GOLD,
          progressOnCurrentLeg: { currentLegProgress: 50, stopsRemaining: 1 }
        })
      )
    ).toBeNull()
  })

  describe('a real miss is still a miss', () => {
    const MISS = { boardLegIndex: 0, definitive: true }

    it('the leg not finished and no riding fact (93.7 %, 1 stop — the 75.5 tick)', () => {
      expect(
        classifyMissedBus(
          goldInput({
            progressOnCurrentLeg: {
              currentLegProgress: 93.73,
              stopsRemaining: 1
            }
          })
        )
      ).toMatchObject(MISS)
    })

    it('a riding fact dropped on a DIFFERENT run (an earlier bus) says nothing about this one', () => {
      expect(
        classifyMissedBus(
          goldInput({
            clearedRiding: { ...RIDDEN_GOLD, tripId: '1:1343237' }
          })
        )
      ).toMatchObject(MISS)
    })

    it('a dropped fact with no real vehicle behind it is no evidence', () => {
      for (const vehicleId of [null, 'route:1:905']) {
        expect(
          classifyMissedBus(
            goldInput({ clearedRiding: { ...RIDDEN_GOLD, vehicleId } })
          )
        ).toMatchObject(MISS)
      }
    })

    it('a dropped fact about another leg is no evidence', () => {
      expect(
        classifyMissedBus(
          goldInput({ clearedRiding: { ...RIDDEN_GOLD, legIndex: 2 } })
        )
      ).toMatchObject(MISS)
    })

    it('a FINISHED ACCESS leg is the rider at the stop, not the bus ridden', () => {
      // Walked all the way to 6th St & Jackson and the bus has gone: the walk
      // leg is at 100 %, but it is not the boarding, so it decides nothing.
      const walk = {
        endTime: GOLD_BOARD_MS - 60000,
        from: { lat: 44.9466, lon: -93.0866, name: 'Origin' },
        mode: 'WALK',
        startTime: GOLD_BOARD_MS - 600000,
        to: JACKSON
      }
      expect(
        classifyMissedBus(
          goldInput({
            legs: [walk, ...GOLD_LEGS],
            progressOnCurrentLeg: { currentLegProgress: 100 },
            riderPosition: [JACKSON.lat, JACKSON.lon]
          })
        )
      ).toMatchObject({ boardLegIndex: 1 })
    })
  })
})

/* ─── 75.3: replayed ───────────────────────────────────────────────────── */

const gold = load('gold-1631-1019')
const transitPace = load('h5he2i-0952-transit-pace')
const detour = load('who0wz-1617-detour')
const transferMatch = load('transfer-match-1020')

;(gold ? describe : describe.skip)(
  '75.3 — the 2026-10-19 Gold Line ride, replayed (gold-1631-1019)',
  () => {
    let r: Awaited<ReturnType<typeof replay>>
    beforeAll(async () => {
      r = await replay(gold, Date.parse('2026-10-19T16:45:00-05:00'))
    })

    it('rides leg 0, and the riding fact is still dropped at 16:37:45', () => {
      expect(r.sets[0].p).toMatchObject({
        legIndex: 0,
        tripId: '1:1343603',
        vehicleId: '1:8173'
      })
      expect(r.clears.map((e) => hhmmss(e.t))).toEqual(['16:37:45'])
      // Leg 0 is behind the rider when it goes: 100 %, nothing left to pass.
      expect(r.clears[0].progress).toMatchObject({
        currentLegIndex: 0,
        currentLegProgress: 100,
        stopsRemaining: 0
      })
    })

    it('no "METRO Gold Line missed" at 16:37:53, and no missed-bus re-plan at all', () => {
      expect(r.missed.map((e) => [hhmmss(e.t), e.p.message])).toEqual([])
      expect(r.missedReplans).toEqual([])
    })
  }
)
;(transitPace ? describe : describe.skip)(
  '75.3 — h5he2i-0952-transit-pace, replayed: its first tick is at 100 %',
  () => {
    it('no "METRO Orange Line missed" at 09:51:00; the bike leg still follows', async () => {
      const r = await replay(
        transitPace,
        Date.parse('2026-10-13T09:53:00-05:00')
      )
      expect(r.missed).toEqual([])
      expect(r.missedReplans).toEqual([])
      expect(
        r.transitions.map((e) => [hhmmss(e.t), e.p?.legIndex])
      ).toContainEqual(['09:51:01', 1])
    })
  }
)
;(detour ? describe : describe.skip)(
  '75.3 — the 2026-10-12 detour, replayed with no rider tap (who0wz-1617-detour)',
  () => {
    it('the riding fact still drops at 16:24:32, and no "missed" follows it', async () => {
      // The 47.1 bus is off its shape with the rider aboard; without the
      // rider's confirm the hold never engages and the clock drops the fact.
      // On main the next 17 s produced "METRO Orange Line missed · next
      // departure" and an auto-applied re-plan for the bus the rider was on.
      const r = await replay(detour, Date.parse('2026-10-12T16:30:00-05:00'))
      expect(r.clears.map((e) => hhmmss(e.t))).toEqual(['16:24:32'])
      expect(r.missed).toEqual([])
      expect(r.missedReplans).toEqual([])
    })
  }
)

/* ─── 75.5: replayed ───────────────────────────────────────────────────── */
;(transferMatch ? describe : describe.skip)(
  '75.5 — the 2026-10-20 94, first matched at 09:34:30 (transfer-match-1020)',
  () => {
    let r: Awaited<ReturnType<typeof replay>>
    beforeAll(async () => {
      r = await replay(transferMatch, Date.parse('2026-10-20T09:36:30-05:00'))
    })

    it('the first tick matches the planned 94 trip high, 17 m away', () => {
      const first = r.events.find(
        (e) => e.type === 'UPDATE_VEHICLE_MATCH' && e.p?.match
      )
      expect(hhmmss(first!.t)).toBe('09:34:30')
      expect(first!.p.match).toMatchObject({
        confidence: 'high',
        distanceMeters: 17,
        tripId: '1:1186422',
        vehicleId: '1:2015'
      })
    })

    it('the 75.3 guard is not what holds it: the leg is not finished on that tick', () => {
      const tick = r.events.find(
        (e) => e.type === 'UPDATE_VEHICLE_MATCH' && e.p?.match
      )
      expect(tick!.progress.currentLegIndex).toBe(0)
      expect(tick!.progress.currentLegProgress).toBeLessThan(99.5)
      expect(tick!.progress.stopsRemaining).toBe(1)
    })

    it('no "94 missed" and no missed-bus re-plan; aboard on the next tick', () => {
      expect(r.missed).toEqual([])
      expect(r.missedReplans).toEqual([])
      expect(hhmmss(r.sets[0].t)).toBe('09:34:31')
      expect(r.sets[0].p).toMatchObject({
        tripId: '1:1186422',
        vehicleId: '1:2015'
      })
    })
  }
)

/* ─── 25.1 (C3): one push per run ──────────────────────────────────────── */

describe('25.1 (C3) — "Missed bus" once per RUN, whatever its epoch reads', () => {
  // Sim session mid-trip-geo2 (2026-10-28): the 18 from Nicollet Ave S & 46th
  // St E, trip 1:1361969. Pushed at 23:46:30.835 on board epoch 23:52:23, and
  // again at 23:47:30.116 on 23:51:59 after the live-times poll moved it.
  const NICOLLET = {
    lat: 44.9198,
    lon: -93.2776,
    name: 'Nicollet Ave S & 46th St E',
    stop: { gtfsId: '1:46th-nicollet' }
  }
  const legs18 = (tripId: string | null): any[] => [
    {
      endTime: 1793249400000,
      from: { lat: 44.918, lon: -93.276, name: 'Origin' },
      mode: 'WALK',
      startTime: 1793249200000,
      to: NICOLLET
    },
    {
      endTime: 1793250778000,
      from: NICOLLET,
      mode: 'BUS',
      routeShortName: '18',
      startTime: 1793249550000,
      to: {
        lat: 44.9626,
        lon: -93.2782,
        name: 'Nicollet Ave S & Franklin Ave W'
      },
      transitLeg: true,
      ...(tripId ? { trip: { gtfsId: tripId } } : {})
    }
  ]
  const ctx = (effectiveBoardMs: number) => ({
    boardLegIndex: 1,
    definitive: true,
    effectiveBoardMs,
    realtime: true
  })

  it('the second reading of the same trip does not push again', () => {
    const legs = legs18('1:1361969')
    const first = checkMissedBus(ctx(1793249543000), legs, [])
    expect(first?.message).toBe('18 missed · next departure')
    expect(checkMissedBus(ctx(1793249519000), legs, [first!.id])).toBeNull()
  })

  it('the next run (a different trip) still re-arms', () => {
    const first = checkMissedBus(ctx(1793249543000), legs18('1:1361969'), [])
    expect(
      checkMissedBus(ctx(1793250420000), legs18('1:1361046'), [first!.id])
    ).not.toBeNull()
  })

  it('keeps the board epoch second from the right, where ride-watch reads it (26.7)', () => {
    const first = checkMissedBus(ctx(1793249543000), legs18('1:1361969'), [])
    expect(first!.id).toMatch(
      /^MISSED_BUS_18_Nicollet Ave S & 46th St E_1:1361969_1793249543000_\d+$/
    )
    // ride_watch.py `_notification_epoch`: int(id.split('_')[-2]).
    expect(Number(first!.id.split('_').slice(-2)[0])).toBe(1793249543000)
  })

  it('a leg with no trip id keeps the epoch key it always had', () => {
    const legs = legs18(null)
    const first = checkMissedBus(ctx(1793249543000), legs, [])
    expect(first!.id).toMatch(
      /^MISSED_BUS_18_Nicollet Ave S & 46th St E_1793249543000_\d+$/
    )
    expect(checkMissedBus(ctx(1793249543000), legs, [first!.id])).toBeNull()
    expect(checkMissedBus(ctx(1793249519000), legs, [first!.id])).not.toBeNull()
  })
})
