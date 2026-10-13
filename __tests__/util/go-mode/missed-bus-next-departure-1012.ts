import fs from 'fs'
import path from 'path'

import FakeTimers from '@sinonjs/fake-timers'

import {
  AUTO_REPLAN,
  endGoMode,
  handlePositionUpdate,
  quietReplanAccessLeg
} from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import { noteReplanAttempt } from '../../../lib/util/go-mode/destination-progress'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 40
  }))
}))

// Spy on the stall count without changing it: every strike the trip records
// goes through noteReplanAttempt, and its return value IS the count.
jest.mock('../../../lib/util/go-mode/destination-progress', () => {
  const actual = jest.requireActual(
    '../../../lib/util/go-mode/destination-progress'
  )
  return { ...actual, noteReplanAttempt: jest.fn(actual.noteReplanAttempt) }
})

/**
 * 2026-10-12, ride `mv5buy9q-g8hr46`, backlog 46.1 — "Routing stops here" at
 * 09:18:20.088 for a rider who had ridden off the access leg to I-35W & Lake
 * St, while the next Orange Line (09:43:32) still reached the door at ~10:18.
 *
 * On the day: three quiet re-plans, 09:14:18 (accepted), 09:16:18 and
 * 09:18:19 (both refused `access-misses-board` — the scoped answers put the
 * rider at the stop 09:33:51 / 09:33:41, eight minutes after the held
 * 09:25:53 departure). All three counted as strikes against the destination,
 * so the next tick retired BICYCLE re-planning and posted the alert. A
 * refused scoped answer never fell through to the full-trip search, so the
 * same route's next departure was never asked for.
 *
 * Replayed from lib/util/go-mode/replay/fixtures/ride-1012-0908.json: every
 * GPS fix from the 09:14:18 swap to STOP_GO_MODE at 09:22:55, the three
 * recorded scoped answers at the times the app asked, and — because a refused
 * attempt never issued a full fetch on the day — the ride's own full-trip
 * REROUTE_SNAPSHOT nearest in time as the full fallback's answer (a stated
 * proxy: same origin within 21 s, same destination, same modes).
 */
const FIXTURE = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/ride-1012-0908.json'
)
const fixture: any = fs.existsSync(FIXTURE)
  ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  : null
const withFixture = fixture ? describe : describe.skip

/** CDT wall clock on 2026-10-12 to epoch ms. */
const at = (hhmmss: string): number =>
  Date.parse(`2026-10-12T${hhmmss}Z`) + 5 * 3600000

const clock = (ms: number) =>
  new Date(ms - 5 * 3600000).toISOString().slice(11, 19)

const SWAP_MS = 1791814458185 // 09:14:18.185, the accepted scoped re-plan
const STOP_MS = 1791814975804 // 09:22:55.804, STOP_GO_MODE
const ALERT_MS = 1791814700087 // 09:18:20.087, the tick that posted it
/** The three quiet re-plans the app issued, from AUTO_REPLAN tMs. */
const REPLAN_MS = [1791814458182, 1791814578191, 1791814699170]

withFixture('46.1: a missed-bus refusal is not a dead end (2026-10-12)', () => {
  const initial = goMode(undefined, { type: '@@INIT' })
  const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
  const mockedNote = noteReplanAttempt as jest.Mock

  const held = () =>
    JSON.parse(JSON.stringify(fixture.itinerarySwaps[0].itinerary))

  const fixes = () =>
    [...fixture.gpsTrack]
      .sort((a: any, b: any) => a.tMs - b.tMs)
      .filter((p: any) => p.tMs >= SWAP_MS - 5000 && p.tMs <= STOP_MS)

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

  const nearest = (list: any[], tMs: number) =>
    list.reduce((best: any, x: any) =>
      Math.abs(x.tMs - tMs) < Math.abs(best.tMs - tMs) ? x : best
    )

  /**
   * What the recorder kept, served to the request the app makes now. A scoped
   * request (one access mode, to the boarding stop) gets the scoped answer
   * recorded at that instant; a full-trip request gets the ride's full-trip
   * REROUTE_SNAPSHOT nearest in time — the proxy, since the day never sent one.
   * `full` lets a case rewrite the full answer.
   */
  const served: Array<{ answeredFrom: string; kind: string; t: string }> = []
  let full: (itineraries: any[]) => any[] = (its) => its
  const serve = (combo: any) => {
    const now = Date.now()
    const scoped = combo.to?.name !== held().legs[2].to.name
    const source = scoped
      ? nearest(fixture.quietReplanPlans, now)
      : nearest(fixture.rerouteSnapshots, now)
    served.push({
      answeredFrom: clock(source.tMs),
      kind: scoped ? 'scoped' : 'full',
      t: clock(now)
    })
    const itineraries = JSON.parse(
      JSON.stringify(source.response.data.plan.itineraries)
    )
    return {
      error: false,
      itineraries: scoped ? itineraries : full(itineraries),
      query: null,
      response: null,
      variables: null
    }
  }

  const makeStore = () => {
    let runThunks = false
    const first = fixes()[0]
    let goModeState: any = {
      ...initial,
      activeItinerary: held(),
      isActive: true,
      routeMatch: { legIndex: 0, progressAlongLeg: 0 },
      tracking: { ...initial.tracking, lastPosition: toPosition(first) }
    }
    const actions: any[] = []
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: {},
        goMode: goModeState,
        transitIndex: { routes: {}, stops: {} }
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
      setRunThunks: (on: boolean) => {
        runThunks = on
      }
    }
  }

  let dateFaker: FakeTimers.InstalledClock | undefined
  let store: ReturnType<typeof makeStore> | undefined

  /**
   * Every fix from the 09:14:18 swap to STOP_GO_MODE, with the quiet re-plan
   * run at the three instants the app ran it and at 09:18:20.087, the tick
   * that posted the alert (the stall check runs before any admission test).
   * Re-plans are not invented between them: the recorder holds no answer for
   * a question the day never asked.
   */
  const replay = async () => {
    const attempts = [...REPLAN_MS, ALERT_MS]
    let next = 0
    for (const p of fixes()) {
      while (next < attempts.length && attempts[next] <= p.tMs) {
        dateFaker?.setSystemTime(attempts[next])
        store?.setRunThunks(true)
        await store?.run(quietReplanAccessLeg())
        next++
      }
      dateFaker?.setSystemTime(p.tMs)
      store?.setRunThunks(false)
      store?.run(handlePositionUpdate(toPosition(p)))
    }
  }

  /** The stall count as the trip last recorded it. */
  const strikes = () => {
    const results = mockedNote.mock.results
    const last = results[results.length - 1]?.value
    return last?.replansSinceGain ?? 0
  }
  const unreachable = () =>
    (store?.actions || []).filter(
      (a: any) =>
        a.type === 'ADD_NOTIFICATION' &&
        a.payload?.type === 'DESTINATION_UNREACHABLE'
    )
  const verdicts = () =>
    (store?.actions || [])
      .filter((a: any) => a.type === AUTO_REPLAN)
      .map((a: any) => [
        clock(a.atMs),
        a.payload.reason,
        a.payload.refusedBecause
      ])
  const transit = (it: any) =>
    (it?.legs || [])
      .filter((l: any) => l.transitLeg)
      .map((l: any) => [l.route?.gtfsId, clock(l.startTime)])

  beforeEach(() => {
    served.length = 0
    full = (its) => its
    mockedNote.mockClear()
    mockedFetch.mockReset()
    mockedFetch.mockImplementation(
      (combo: any) => () => Promise.resolve(serve(combo))
    )
    dateFaker = FakeTimers.install({ now: SWAP_MS - 5000, toFake: ['Date'] })
    store = makeStore()
  })
  afterEach(() => {
    store?.setRunThunks(false)
    store?.run(endGoMode())
    store = undefined
    dateFaker?.uninstall()
    dateFaker = undefined
  })

  it('holds the 09:14:18 plan: Orange Line 1:1273236 from I-35W & Lake St at 09:25:53', () => {
    expect(fixture.meta.session).toBe('mv5buy9q-g8hr46')
    const plan = held()
    expect(plan.legs.map((l: any) => l.mode)).toEqual([
      'BICYCLE',
      'BUS',
      'BICYCLE'
    ])
    expect(plan.legs[1].trip.gtfsId).toBe('1:1273236')
    expect(clock(plan.legs[1].startTime)).toBe('09:25:53')
    // Each refused scoped answer put the rider at the stop ~8 min too late.
    const ends = fixture.quietReplanPlans.map((q: any) =>
      clock(q.response.data.plan.itineraries[0].endTime)
    )
    expect(ends).toEqual(['09:22:18', '09:33:51', '09:33:41'])
  })

  it('asks for the same route’s next departure instead of counting the miss', async () => {
    await replay()
    expect(verdicts()).toEqual([
      ['09:14:18', 'quiet-replan-scoped', null],
      // The held bus is out of reach: no strike, ask the full-trip question...
      ['09:16:18', 'quiet-replan-scoped', 'access-misses-board'],
      // ...whose answer keeps the Orange Line and is accepted, arrival waived.
      ['09:16:18', 'quiet-replan-full', null],
      // On the new plan the 09:18:19 answer (stop at 09:33:41) makes the
      // 09:43:32 bus, so it is an ordinary accepted re-plan.
      ['09:18:19', 'quiet-replan-scoped', null]
    ])
    const fullVerdict = (store?.actions || []).find(
      (a: any) =>
        a.type === AUTO_REPLAN && a.payload.reason === 'quiet-replan-full'
    )
    expect(fullVerdict.payload.heldBoardMissed).toBe(true)
    // The 09:16:18 full fallback was served the 09:16:39 snapshot (proxy).
    expect(served.map((s) => [s.t, s.kind, s.answeredFrom])).toEqual([
      ['09:14:18', 'scoped', '09:14:18'],
      ['09:16:18', 'scoped', '09:16:18'],
      ['09:16:18', 'full', '09:16:39'],
      ['09:18:19', 'scoped', '09:18:19']
    ])
    // Same route, next departure: the Orange Line at 09:43:32.
    const plan = store?.goMode().activeItinerary
    expect(transit(plan)[0]).toEqual(['1:904', '09:43:32'])
    expect(plan.legs.find((l: any) => l.transitLeg).trip.gtfsId).toBe(
      '1:1367537'
    )
    // No "Routing stops here" through STOP_GO_MODE at 09:22:55.
    expect(unreachable()).toHaveLength(0)
    // Two strikes, not three: 09:14:18 and 09:18:19 (the rider, riding away
    // from Lake St, gained nothing between them). The two missed-bus
    // refusals counted none.
    expect(strikes()).toBe(2)
  })

  it('counts the miss as before when the route has no next departure', async () => {
    // The full answer holds nothing on the Orange Line: nothing to swap to,
    // and the attempt is the strike it always was.
    full = (its) =>
      its.filter(
        (it: any) => !it.legs.some((l: any) => l.route?.gtfsId === '1:904')
      )
    await replay()
    expect(transit(store?.goMode().activeItinerary)[0]).toEqual([
      '1:904',
      '09:25:53'
    ])
    expect(strikes()).toBe(3)
    expect(unreachable().map((a: any) => clock(a.atMs))).toEqual(['09:18:20'])
  })

  it('still never installs a fallback whose own access misses its bus (16.2)', async () => {
    // Make every Orange Line answer's bike leg end 2 min after its bus leaves.
    full = (its) =>
      its.map((it: any) => {
        const board = it.legs.find((l: any) => l.transitLeg)
        if (board?.route?.gtfsId !== '1:904') return it
        const legs = it.legs.map((l: any, i: number) =>
          i === 0 ? { ...l, endTime: board.startTime + 120000 } : l
        )
        return { ...it, legs }
      })
    await replay()
    expect(verdicts()[2]).toEqual([
      '09:16:18',
      'quiet-replan-full',
      'access-misses-board'
    ])
    expect(transit(store?.goMode().activeItinerary)[0]).toEqual([
      '1:904',
      '09:25:53'
    ])
  })
})
