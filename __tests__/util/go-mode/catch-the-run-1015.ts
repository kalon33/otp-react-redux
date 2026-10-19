/* globals afterEach, beforeEach, describe, expect, it, jest */
import fs from 'fs'
import path from 'path'

import FakeTimers from '@sinonjs/fake-timers'

import {
  AUTO_REPLAN,
  endGoMode,
  handlePositionUpdate,
  PLAN_RETARGET,
  quietReplanAccessLeg,
  retargetPlanToDeparture
} from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import { reanchorAccessChain } from '../../../lib/util/go-mode/leg-merge'
import { riderMakesRun } from '../../../lib/util/go-mode/replan-acceptance'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 40
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * 2026-10-15 17:47 ride, session `mva4fpf5-hhg1cf`, backlog 23.3 + 53.2.
 *
 * The rider biked for the 539 `1:897704` at 98th St W & Penn Ave / Newton Ave
 * S (`1:1737`). The feed's prediction for it there said 17:52:30 from 17:50:16
 * to 17:53:02 and never moved; the bus was on a detour south of 98th St and
 * stopped at Penn at about 17:54:35 (vehicle SL-60152, STOPPED_AT 1:1737,
 * record time 17:54:35). The rider rode on east along 98th St, waited at
 * 98th St W & Fremont Ave / Dupont Ave S from 17:54:00 to 17:57:01 (GPS
 * stationary within 12 m of the stop), and boarded the same bus there: from
 * 17:57:15 their fixes run at 12-14 m/s and stop at I-35W & 98th St Gate C
 * (3 m from the stop) 17:58:15-17:58:31, behind SL-60152.
 *
 * On the day:
 *  - 17:51:02 the scoped access re-plan to Penn arrived 17:55:22 and was
 *    refused `access-misses-board` against the frozen 17:52:30; 17:51:04 the
 *    full fallback was accepted with `heldBoardMissed: true` and the plan
 *    moved to the 18:18:24 `1:877022` from Penn.
 *  - 17:52:42 the card anchored back on `1:897704` and PLAN_RETARGET refused
 *    it `refused-overrun`, overrunMs 1554000: the 18:18 plan's access leg was
 *    OTP's time-shifted 18:14:14 -> 18:18:24, kept by reference.
 *  - 17:57:03, standing at Fremont/Dupont, the scoped re-plan rebuilt a
 *    1162 m bike leg back west to Penn for the 18:18.
 *
 * Fixture: `catch-the-run-1015.json`, a slice of `ride-1015-1747.json`
 * (17:46:40-18:02:00, route 1:539) plus the ride's SET_LIVE_LEG_TIMES
 * payloads from the debug day file.
 */
const FIXTURE = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/catch-the-run-1015.json'
)
const fixture: any = fs.existsSync(FIXTURE)
  ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  : null
const withFixture = fixture ? describe : describe.skip

const ROUTE = '1:539'
const HELD_TRIP = '1:897704'
const NEXT_TRIP = '1:877022'
const PENN = '1:1737'

/** CDT wall clock on 2026-10-15 to epoch ms. */
const at = (hhmmss: string): number =>
  Date.parse(`2026-10-15T${hhmmss}Z`) + 5 * 3600000
const clock = (ms: number) =>
  new Date(Number(ms) - 5 * 3600000).toISOString().slice(11, 19)

const SCOPED_1 = 1792104662155 // 17:51:02.155, AUTO_REPLAN scoped
const RETARGET = 1792104762086 // 17:52:42.086, PLAN_RETARGET
const SCOPED_3 = 1792105023179 // 17:57:03.179, the third scoped re-plan
/** SET_LIVE_LEG_TIMES 17:50:58.388, the last made for the 1:897704 plan. */
const LAST_HELD_LIVE = 1792104658388
/** The departure the card anchored to: 17:52:30. */
const HELD_BOARD_MS = 1792104750000

const copy = (x: any) => JSON.parse(JSON.stringify(x))
const latestAtOrBefore = (list: any[], tMs: number) =>
  list.reduce(
    (best: any, x: any) =>
      x.tMs <= tMs && (!best || x.tMs > best.tMs) ? x : best,
    null
  )

const toPosition = (p: any): GeolocationPosition =>
  ({
    coords: {
      accuracy: p.accuracy ?? 10,
      altitude: null,
      altitudeAccuracy: null,
      heading: p.heading ?? null,
      latitude: p.lat,
      longitude: p.lon,
      speed: p.speed ?? null
    },
    timestamp: p.tMs
  } as GeolocationPosition)

const transitSummary = (it: any) =>
  (it?.legs || [])
    .filter((l: any) => l.transitLeg)
    .map((l: any) => ({
      from: l.from?.stop?.gtfsId || l.from?.stopId || null,
      fromName: l.from?.name,
      start: clock(l.startTime),
      trip: l.trip?.gtfsId || l.tripId
    }))

withFixture('catch the run (23.3 + 53.2, 2026-10-15 17:47)', () => {
  const initial = goMode(undefined, { type: '@@INIT' })
  const mockedFetch = fetchOnboardCandidatePlan as jest.Mock

  /** Served answers, by kind. `laterStop` answers are synthesized per test. */
  let serveLaterStop: ((combo: any) => any[] | null) | null = null
  const served: Array<{ kind: string; t: string; to: string }> = []
  const serve = (combo: any, heldDestName: string) => {
    const now = Date.now()
    const toName = combo.to?.name
    const fullTrip = toName === heldDestName
    const toPenn = toName === '98th St W & Penn Ave / Newton Ave S'
    let itineraries: any[] = []
    let kind = 'other'
    if (fullTrip) {
      kind = 'full'
      // The day's own full answer at 17:51:04; at other instants the ride's
      // REROUTE_SNAPSHOT nearest in time, cut to the 539 itineraries (a stated
      // proxy: the day sent no full fetch then).
      const recorded = fixture.quietReplanPlans.find(
        (q: any) => q.reason === 'quiet-replan-full'
      )
      const source =
        Math.abs(recorded.tMs - now) < 30000
          ? recorded
          : fixture.rerouteSnapshots[0]
      itineraries = copy(source.response.data.plan.itineraries)
    } else if (toPenn) {
      kind = 'scoped'
      const scoped = fixture.quietReplanPlans.filter(
        (q: any) => q.reason === 'quiet-replan-scoped'
      )
      const source = scoped.reduce((best: any, q: any) =>
        Math.abs(q.tMs - now) < Math.abs(best.tMs - now) ? q : best
      )
      itineraries = copy(source.response.data.plan.itineraries)
    } else if (serveLaterStop) {
      kind = 'later-stop'
      itineraries = serveLaterStop(combo) || []
    }
    served.push({ kind, t: clock(now), to: toName })
    return {
      error: false,
      itineraries,
      query: null,
      response: null,
      variables: null
    }
  }

  const makeStore = (held: any, nowMs: number, liveAtMs?: number) => {
    let runThunks = false
    let goModeState: any = {
      ...initial,
      activeItinerary: copy(held),
      isActive: true,
      liveLegTimes: copy(
        latestAtOrBefore(fixture.liveLegTimesRecords, liveAtMs ?? nowMs)
          ?.payload ?? {}
      ),
      routeMatch: null,
      tracking: {
        ...initial.tracking,
        lastPosition: toPosition(
          latestAtOrBefore(fixture.gpsTrack, nowMs) || fixture.gpsTrack[0]
        )
      }
    }
    let atMs = nowMs
    const vehiclesAt = (t: number) =>
      latestAtOrBefore(fixture.vehicleSnapshots, t)?.payload?.vehicles ?? []
    const trips: Record<string, any> = {}
    fixture.tripSnapshots.forEach((s: any) => {
      trips[s.tripId] = s.payload
    })
    const actions: any[] = []
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: {},
        goMode: goModeState,
        location: { currentPosition: { coords: null } },
        transitIndex: {
          routes: { [ROUTE]: { vehicles: vehiclesAt(atMs) } },
          stops: {
            [PENN]: latestAtOrBefore(fixture.stopTimeSnapshots, atMs)?.payload
          },
          trips
        }
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') {
        return runThunks ? action(dispatch, getState) : undefined
      }
      actions.push({ ...action, atMs: Date.now() })
      goModeState = goMode(goModeState, action)
      return action
    }
    return {
      actions,
      goMode: () => goModeState,
      run: (thunk: any) => thunk(dispatch, getState),
      setNow: (t: number) => {
        atMs = t
      },
      setRunThunks: (on: boolean) => {
        runThunks = on
      },
      /** Lay the recorded live times as of `t` over whatever the plan has. */
      syncLive: (t: number) => {
        goModeState = {
          ...goModeState,
          liveLegTimes: copy(
            latestAtOrBefore(fixture.liveLegTimesRecords, liveAtMs ?? t)
              ?.payload ?? {}
          )
        }
      }
    }
  }

  let dateFaker: FakeTimers.InstalledClock | undefined
  let store: ReturnType<typeof makeStore> | undefined

  /** Every recorded fix in (fromMs, toMs], ticked through the app. */
  const replayFixes = (fromMs: number, toMs: number) => {
    for (const p of fixture.gpsTrack) {
      if (p.tMs <= fromMs || p.tMs > toMs) continue
      dateFaker?.setSystemTime(p.tMs)
      store?.setNow(p.tMs)
      store?.setRunThunks(false)
      store?.run(handlePositionUpdate(toPosition(p)))
    }
  }

  const autoReplans = () =>
    (store?.actions || [])
      .filter((a: any) => a.type === AUTO_REPLAN)
      .map((a: any) => ({
        heldBoardMissed: a.payload.heldBoardMissed,
        reason: a.payload.reason,
        refusedBecause: a.payload.refusedBecause,
        t: clock(a.atMs)
      }))
  const retargets = (): any[] =>
    (store?.actions || [])
      .filter((a: any) => a.type === PLAN_RETARGET)
      .map((a: any) => a.payload)

  beforeEach(() => {
    served.length = 0
    serveLaterStop = null
    mockedFetch.mockReset()
  })
  afterEach(() => {
    store?.setRunThunks(false)
    store?.run(endGoMode())
    store = undefined
    dateFaker?.uninstall()
    dateFaker = undefined
  })

  /**
   * `liveAtMs`: whose SET_LIVE_LEG_TIMES to hold. The recorded ones belong to
   * whichever plan the app held then; a case that holds another plan names
   * the last record made for it.
   */
  const start = (held: any, fromMs: number, liveAtMs?: number) => {
    dateFaker = FakeTimers.install({ now: fromMs, toFake: ['Date'] })
    store = makeStore(held, fromMs, liveAtMs)
    const heldDest = held.legs[held.legs.length - 1].to.name
    mockedFetch.mockImplementation(
      (combo: any) => () => Promise.resolve(serve(combo, heldDest))
    )
  }

  const runAt = async (tMs: number, thunk: any) => {
    dateFaker?.setSystemTime(tMs)
    store?.setNow(tMs)
    store?.syncLive(tMs)
    store?.setRunThunks(true)
    await store?.run(thunk)
    store?.setRunThunks(false)
  }

  const verdicts = (type = 'HELD_RUN_VERDICT') =>
    (store?.actions || [])
      .filter((a: any) => a.type === type)
      .map((a: any) => a.payload)
  const types = () => (store?.actions || []).map((a: any) => a.type)
  const firstTransit = () => transitSummary(store?.goMode().activeItinerary)[0]

  /**
   * A street plan for a stop the day never asked about: one bike leg, the
   * straight line x 1.3, at the pace OTP gave this rider at 17:57:03
   * (1162.29 m in 308 s = 3.77 m/s). A stated proxy, not a recording.
   */
  const OTP_PACE_1757 = 1162.29 / 308
  const synthesizeStreetPlan = (combo: any) => {
    const now = Date.now()
    const from = combo.from
    const to = combo.to
    const dLat = (to.lat - from.lat) * 111000
    const dLon =
      (to.lon - from.lon) * 111000 * Math.cos((from.lat * Math.PI) / 180)
    const distance = Math.hypot(dLat, dLon) * 1.3
    const duration = Math.round(distance / OTP_PACE_1757)
    const leg = {
      distance,
      duration,
      endTime: now + duration * 1000,
      from: { lat: from.lat, lon: from.lon, name: 'Current location' },
      legGeometry: { length: 2, points: '' },
      mode: 'BICYCLE',
      startTime: now,
      to: { lat: to.lat, lon: to.lon, name: to.name },
      transitLeg: false
    }
    return [
      {
        duration,
        endTime: leg.endTime,
        legs: [leg],
        startTime: now,
        walkDistance: 0
      }
    ]
  }

  it('17:51:02: the bus is 1.7 km short of Penn, so the held run is not called missed (53.2a)', async () => {
    start(fixture.itinerary, at('17:47:10'))
    replayFixes(at('17:47:10'), SCOPED_1 - 1)
    await runAt(SCOPED_1, quietReplanAccessLeg())
    // BEFORE (otprr main ec4ee3bcb, this replay = the day to the second): the
    // scoped answer was refused `access-misses-board`, the full fallback ran
    // with heldBoardMissed: true and moved the plan to the 18:18:24 1:877022.
    expect(autoReplans()).toEqual([
      {
        heldBoardMissed: false,
        reason: 'quiet-replan-scoped',
        refusedBecause: 'access-misses-board',
        t: '17:51:02'
      }
    ])
    const [v] = verdicts()
    expect(v).toMatchObject({
      makes: true,
      tripId: HELD_TRIP,
      vehiclePassed: false,
      why: 'bus-upstream'
    })
    // The feed's frozen 17:52:30 is the bus time (the record's floor is
    // 17:52:15); the rider at their own pace is about two minutes behind it.
    expect(clock(v.busMs)).toBe('17:52:30')
    expect(v.vehicleDistanceM).toBeGreaterThan(1700)
    expect(v.overrunMs).toBeGreaterThan(60000)
    expect(v.overrunMs).toBeLessThan(180000)
    // No full-trip fetch, no swap: the rider keeps racing for 1:897704.
    expect(served.map((x) => x.kind)).toEqual(['scoped'])
    expect(types()).not.toContain('START_GO_MODE')
    expect(firstTransit()).toMatchObject({ from: PENN, trip: HELD_TRIP })
  })

  it('17:51:02 with no vehicle record: still the next run from Penn, as before', async () => {
    start(fixture.itinerary, at('17:47:10'))
    replayFixes(at('17:47:10'), SCOPED_1 - 1)
    // A feed with nothing on the trip: the verdict has only the prediction,
    // and nothing says the bus is short of the stop.
    fixture.vehicleSnapshots.forEach((x: any) => {
      x.__vehicles = x.__vehicles ?? x.payload.vehicles
      x.payload.vehicles = []
    })
    try {
      await runAt(SCOPED_1, quietReplanAccessLeg())
    } finally {
      fixture.vehicleSnapshots.forEach((x: any) => {
        x.payload.vehicles = x.__vehicles
        delete x.__vehicles
      })
    }
    expect(verdicts()[0]).toMatchObject({ makes: false, why: 'late' })
    expect(autoReplans().map((a) => a.heldBoardMissed)).toContain(true)
    expect(firstTransit()).toMatchObject({ from: PENN, trip: NEXT_TRIP })
  })

  it('17:52:42: the re-target onto 1:897704 is measured from the rider and applied (23.3)', async () => {
    const swap = fixture.itinerarySwaps[0]
    start(swap.itinerary, swap.tMs)
    replayFixes(swap.tMs, RETARGET - 1)
    await runAt(RETARGET, retargetPlanToDeparture(HELD_BOARD_MS, 'anchor'))
    // BEFORE: verdict 'refused-overrun', overrunMs 1554000 — the kept access
    // leg 18:14:14 -> 18:18:24 against the 17:52:30 run.
    const [r] = retargets()
    expect(r).toMatchObject({
      tripId: HELD_TRIP,
      verdict: 'applied',
      why: 'bus-upstream'
    })
    // Rider: 550 m from Penn at their own pace (the matcher said 99.55 %,
    // floored by the straight line). Bus: the 17:51:00 record 1.67 km out,
    // floored at 17:53:08. Over by under a minute, bus upstream.
    expect(r.overrunMs).toBeGreaterThan(0)
    expect(r.overrunMs).toBeLessThan(60000)
    expect(clock(r.busMs)).toBe('17:53:08')
    const legs = store?.goMode().activeItinerary.legs
    expect(legs[1].trip.gtfsId).toBe(HELD_TRIP)
    expect(clock(legs[1].startTime)).toBe('17:53:08')
    // The access leg is the rider's from now, and ends by the bus: no
    // inversion (it was 18:14:14 -> 18:18:24).
    expect(clock(legs[0].startTime)).toBe('17:52:42')
    expect(Number(legs[0].endTime)).toBeLessThanOrEqual(
      Number(legs[1].startTime)
    )
    expect(legs[0].distance).toBe(swap.itinerary.legs[0].distance)
  })

  it('17:57:03: the bus is past Penn, so the same run is offered further along (53.2b)', async () => {
    serveLaterStop = synthesizeStreetPlan
    // From the start of the ride, so the app has the rider's own pace (the
    // day asked OTP for bikeSpeed 8 at 17:57:03).
    start(fixture.itinerary, at('17:47:10'), LAST_HELD_LIVE)
    replayFixes(at('17:47:10'), SCOPED_3 - 1)
    await runAt(SCOPED_3, quietReplanAccessLeg())
    // BEFORE: the scoped answer (1162 m back west to Penn, 18:02:11) was
    // refused and the full fallback found nothing to keep the 539 on, so the
    // plan stayed on a bus already gone; on the day, holding the 18:18 plan,
    // the same answer sent the rider back to Penn for the 18:18.
    expect(verdicts()[0]).toMatchObject({
      makes: false,
      vehiclePassed: true,
      why: 'bus-passed'
    })
    // SL-60152 STOPPED_AT Humboldt at 17:55:36 (87 s old): Fremont's bus time
    // is 17:56:36, gone; the three nearest stops still ahead of it were asked.
    expect(
      served.filter((x) => x.kind === 'later-stop').map((x) => x.to)
    ).toEqual([
      'I-35W & 98th Street Station Gate C',
      'Lyndale Ave S & 99th St / 98th St W',
      '98th St W & Garfield Ave / Grand Ave'
    ])
    expect(served.map((x) => x.kind)).not.toContain('full')
    // Gate C: the rider 17:57:57 at their own pace, the bus 17:58:36 by the
    // timetable from Humboldt — under the minute's margin, and SL-60152 was
    // in fact there at ~17:57:58. Lyndale & 99th: the rider 17:58:25, the
    // bus 17:59:36 — offered. (The plan named Garfield; the rider boarded at
    // Fremont/Dupont at ~17:57, whose bus time had already gone.)
    const tried = verdicts('HELD_RUN_LATER_STOP').map((t: any) => ({
      accepted: t.accepted,
      bus: clock(t.busMs),
      rider: clock(t.riderEtaMs),
      stopId: t.stopId
    }))
    expect(tried).toEqual([
      {
        accepted: false,
        bus: '17:58:36',
        rider: '17:57:57',
        stopId: '1:51823'
      },
      { accepted: true, bus: '17:59:36', rider: '17:58:25', stopId: '1:51858' }
    ])
    expect(types()).toContain('START_GO_MODE')
    expect(firstTransit()).toEqual({
      from: '1:51858',
      fromName: 'Lyndale Ave S & 99th St / 98th St W',
      start: '17:59:36',
      trip: HELD_TRIP
    })
    // The rest of the trip is the held plan's: same get-off stop, same tram.
    const legs = store?.goMode().activeItinerary.legs
    const held = fixture.itinerary.legs
    expect(legs[1].to.name).toBe(held[1].to.name)
    expect(legs.slice(2).map((l: any) => l.trip?.gtfsId ?? l.mode)).toEqual(
      held.slice(2).map((l: any) => l.trip?.gtfsId ?? l.mode)
    )
    expect(Number(legs[0].endTime)).toBeLessThanOrEqual(
      Number(legs[1].startTime)
    )
  })
})

describe('riderMakesRun', () => {
  const nowMs = 1000000
  it('a bus past the stop is a miss whatever the times say', () => {
    expect(
      riderMakesRun({
        boardMs: nowMs + 600000,
        nowMs,
        riderSecondsToStop: 10,
        vehicle: {
          ageSec: 30,
          distanceToBoardStopM: 400,
          passedBoardStop: true
        }
      })
    ).toMatchObject({ makes: false, why: 'bus-passed' })
  })
  it('in time against the later of the feed and the record floor', () => {
    const v = riderMakesRun({
      boardMs: nowMs + 60000,
      nowMs,
      riderSecondsToStop: 120,
      vehicle: {
        ageSec: 10,
        distanceToBoardStopM: 1300 * 1.2,
        passedBoardStop: false,
        recordMs: nowMs
      }
    })
    expect(v.busMs).toBe(nowMs + 120000)
    expect(v).toMatchObject({ makes: true, why: 'in-time' })
  })
  it('the upstream allowance needs a fresh record short of the stop', () => {
    const base = {
      boardMs: nowMs,
      nowMs,
      riderSecondsToStop: 150
    }
    const upstream = {
      ageSec: 60,
      distanceToBoardStopM: 1000,
      passedBoardStop: false,
      recordMs: nowMs
    }
    expect(riderMakesRun({ ...base, vehicle: upstream })).toMatchObject({
      makes: true,
      why: 'bus-upstream'
    })
    expect(
      riderMakesRun({ ...base, vehicle: { ...upstream, ageSec: 200 } })
    ).toMatchObject({ makes: false, why: 'late' })
    expect(
      riderMakesRun({
        ...base,
        vehicle: { ...upstream, passedBoardStop: null }
      })
    ).toMatchObject({ makes: false, why: 'late' })
    expect(
      riderMakesRun({ ...base, riderSecondsToStop: 400, vehicle: upstream })
    ).toMatchObject({ makes: false, why: 'late' })
  })
  it('unmeasured without a rider figure', () => {
    expect(
      riderMakesRun({ boardMs: nowMs, nowMs, riderSecondsToStop: null })
    ).toMatchObject({ makes: null, why: 'unmeasured' })
  })
})

describe('reanchorAccessChain', () => {
  it('re-times the street legs into the span, keeping their shares', () => {
    const it0: any = {
      endTime: 5000,
      legs: [
        { distance: 100, endTime: 3000, mode: 'WALK', startTime: 2000 },
        { distance: 900, endTime: 5000, mode: 'BICYCLE', startTime: 3000 },
        { endTime: 9000, mode: 'BUS', startTime: 6000, transitLeg: true }
      ],
      startTime: 2000
    }
    const next: any = reanchorAccessChain(it0, 0, 2, 100, 400)
    expect(next.legs.map((l: any) => [l.startTime, l.endTime])).toEqual([
      [100, 200],
      [200, 400],
      [6000, 9000]
    ])
    expect(next.startTime).toBe(100)
    expect(next.legs[1].distance).toBe(900)
    expect(reanchorAccessChain(it0, 1, 3, 0, 10)).toBe(it0)
  })
})
