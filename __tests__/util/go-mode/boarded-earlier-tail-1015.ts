/* globals afterEach, beforeEach, describe, expect, it, jest */
import FakeTimers from '@sinonjs/fake-timers'

import {
  convertPlanResponseItineraries,
  fetchOnboardCandidatePlan,
  findTrip
} from '../../../lib/actions/apiV2'
import { replanFromAboard } from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * BACKLOG 53.1 — the boarded-earlier re-plan kept the train chosen for the
 * LATER bus.
 *
 * 2026-10-15, session `mva4fpf5-hhg1cf`, DEV `2026.1015.1`. The plan in hand
 * (the 17:57:03 quiet re-plan) was bike → 539 `1:877022` at 18:18 → bike →
 * Blue Line `1:897976` at 18:43, arriving 19:01:01. The rider caught the
 * EARLIER 539, `1:897704`, and confirmed it at 18:01:21. At 18:01:22 the
 * boarded-earlier re-plan swapped that bus in but grafted the held plan's
 * tail: off at 82nd St E & Winstead Way 18:11, then the 18:43 train — a
 * 32-minute layover, pushed as "arriving in 60 min". No candidate plan was
 * asked for (79 ms end to end). The 18:13 train `1:892049` was makeable from
 * Old Shakopee Rd & 86th St E (the rider's own onboard pick at 18:05:33 made
 * it), two stops BEFORE the planned alight stop.
 *
 * Replayed through the real `replanFromAboard` from
 * lib/util/go-mode/replay/fixtures/ride-1015-1747-boarded-earlier.json, a slice
 * of the ride's fixture: the held plan (its `itinerary`), the fixes up to the
 * re-plan, the riding fact, the 18:01:22 trip read, and the onward plan from
 * every stop this re-plan asks — the phone's own recordings where it asked the
 * same stop, production OTP probed with the phone's own request where it never
 * did (see the slice's meta).
 *
 * Measured on main (`ec4ee3bcb`) before the fix, by this harness: zero
 * candidate plans asked, START_GO_MODE = BUS → 82nd St 18:11:37 | BICYCLE →
 * 30th Ave 18:13:41 | TRAM `1:897976` 18:43 | arrival 19:01:01 — the ride.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fx: any = require('../../../lib/util/go-mode/replay/fixtures/ride-1015-1747-boarded-earlier.json')

const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
const mockedFindTrip = findTrip as jest.Mock

/** START_REROUTE {reason:'boarded-earlier'} 18:01:22.113. */
const REPLAN_MS = 1792105282113
const RIDDEN_TRIP = '1:897704'
const PLANNED_STOP = '1:52007' // 82nd St E & Winstead Way
const MADE_IT_STOP = '1:685' // Old Shakopee Rd & 86th St E
const TRAIN_1813 = '1:892049'
const TRAIN_1843 = '1:897976'

const hhmmss = (ms: number | null | undefined) =>
  ms == null
    ? 'n/a'
    : new Date(ms).toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: 'America/Chicago'
      })

const clone = (x: any) => JSON.parse(JSON.stringify(x))

const planFor = (stopId: string) =>
  (fx.candidatePlans as any[]).find((p) => p.stopId === stopId)

const stopIdOf = (place: any) => place?.stop?.gtfsId ?? place?.stopId

const tripIdOf = (leg: any) => leg?.trip?.gtfsId ?? leg?.tripId

const transitLegs = (it: any) =>
  (it?.legs || []).filter((l: any) => l.transitLeg)

/** The re-plan's position: the last fix at or before 18:01:22.113. */
const lastFix = fx.gpsTrack[fx.gpsTrack.length - 1]

function makeStore(overrides: { riding?: any } = {}) {
  const initial = goMode(undefined, { type: '@@INIT' })
  let goModeState: any = {
    ...initial,
    activeItinerary: clone(fx.itinerary),
    isActive: true,
    riding: overrides.riding ?? clone(fx.riding),
    tracking: {
      ...initial.tracking,
      lastPosition: {
        coords: {
          accuracy: lastFix.accuracy,
          heading: lastFix.heading,
          latitude: lastFix.lat,
          longitude: lastFix.lon,
          speed: lastFix.speed
        },
        timestamp: lastFix.tMs
      }
    }
  }
  const trips: Record<string, any> = {}
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago', itinerary: {} },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {}, trips }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    goModeState = goMode(goModeState, action)
    return action
  }
  return { actions, dispatch, trips }
}

/** The stop ids the candidate plans were asked from, in order. */
let asked: string[] = []

async function runReplan(store: ReturnType<typeof makeStore>) {
  mockedFindTrip.mockImplementation(({ tripId }: any) => () => {
    // The ridden run's 18:01:22 read; any other run is given the same stop
    // times under its own id (only the shortcut-vs-optimizer branch is asked).
    store.trips[tripId] = { ...clone(fx.trip), id: tripId }
    return Promise.resolve(store.trips[tripId])
  })
  await store.dispatch(
    replanFromAboard({ autoApply: true, reason: 'boarded-earlier' })
  )
  const start = store.actions.find((a) => a.type === 'START_GO_MODE')
  return start?.payload?.itinerary ?? start?.payload ?? null
}

describe('util > go-mode > boarded earlier: the plan tail (53.1)', () => {
  let clock: FakeTimers.InstalledClock | undefined

  beforeEach(() => {
    clock = FakeTimers.install({ now: REPLAN_MS, toFake: ['Date'] })
    asked = []
    mockedFetch.mockReset()
    mockedFetch.mockImplementation((combo: any) => () => {
      const rec = (fx.candidatePlans as any[]).find(
        (p) =>
          p.request.from.lat === combo.from.lat &&
          p.request.from.lon === combo.from.lon
      )
      asked.push(rec?.stopId ?? `unrecorded:${combo.from.name}`)
      if (!rec) return Promise.resolve({ error: true, itineraries: [] })
      return Promise.resolve({
        error: false,
        itineraries: convertPlanResponseItineraries(clone(rec.response), {
          combo,
          config: { transitOperators: [] },
          query: {},
          strictModes: false,
          validModeCombinations: undefined
        })
      })
    })
  })
  afterEach(() => {
    clock?.uninstall()
    clock = undefined
  })

  describe('the slice is the ride the row describes', () => {
    it('held: the 18:18 539 into the 18:43 train, arriving 19:01:01', () => {
      expect(fx.meta.session).toBe('mva4fpf5-hhg1cf')
      const [bus, train] = transitLegs(fx.itinerary)
      expect(tripIdOf(bus)).toBe('1:877022')
      expect(stopIdOf(bus.to)).toBe(PLANNED_STOP)
      expect(tripIdOf(train)).toBe(TRAIN_1843)
      expect(hhmmss(fx.itinerary.endTime)).toBe('19:01:01')
    })

    it('the riding fact names the earlier run, on the access leg', () => {
      expect(fx.riding.tripId).toBe(RIDDEN_TRIP)
      expect(fx.riding.legIndex).toBe(0)
      expect(fx.itinerary.legs[0].mode).toBe('BICYCLE')
      expect(fx.trip.id).toBe(RIDDEN_TRIP)
    })

    it('what the phone installed at 18:01:22, and what the rider picked', () => {
      expect(transitLegs(fx.recordedReplan).map(tripIdOf)).toEqual([
        RIDDEN_TRIP,
        TRAIN_1843
      ])
      const pick = transitLegs(fx.onboardPick)
      expect(pick.map(tripIdOf)).toEqual([RIDDEN_TRIP, TRAIN_1813])
      expect(stopIdOf(pick[0].to)).toBe(MADE_IT_STOP)
    })

    it('OTP makes the 18:13 from Old Shakopee & 86th, not from 82nd St', () => {
      const trains = (stopId: string) =>
        planFor(stopId)
          .response.data.plan.itineraries.flatMap((it: any) => it.legs)
          .filter((l: any) => l.mode === 'TRAM')
          .map((l: any) => l.trip.gtfsId)
      // The phone's own recordings, 18:05:20-18:05:23.
      expect(planFor(MADE_IT_STOP).source).toBe('recorded')
      expect(planFor(PLANNED_STOP).source).toBe('recorded')
      expect(trains(MADE_IT_STOP)).toContain(TRAIN_1813)
      expect(trains(PLANNED_STOP)).not.toContain(TRAIN_1813)
    })
  })

  it('re-plans the tail: off at Old Shakopee & 86th for the 18:13 train', async () => {
    const store = makeStore()
    const installed = await runReplan(store)
    expect(installed).not.toBeNull()

    // The planned stop and the stop that makes the 18:13 are both asked,
    // whatever the five-stop sample picks, and every stop asked has a plan.
    expect(asked).toEqual(expect.arrayContaining([PLANNED_STOP, MADE_IT_STOP]))
    expect(asked.filter((s) => s.startsWith('unrecorded'))).toEqual([])

    const [bus, train] = transitLegs(installed)
    expect(tripIdOf(bus)).toBe(RIDDEN_TRIP)
    expect(stopIdOf(bus.to)).toBe(MADE_IT_STOP)
    expect(tripIdOf(train)).toBe(TRAIN_1813)
    expect(hhmmss(train.startTime)).toBe('18:13:00')
    expect(hhmmss(installed.legs[installed.legs.length - 1].endTime)).toBe(
      '18:30:48'
    )

    const verdict = store.actions.find((a) => a.type === 'AUTO_REPLAN')
    expect(verdict.payload.accepted).toBe(true)
  })

  it('no answers at all (timeouts) still swaps the boarded bus in, as before', async () => {
    mockedFetch.mockImplementation(
      () => () => Promise.resolve({ error: true, itineraries: [] })
    )
    const store = makeStore()
    const installed = await runReplan(store)
    const [bus, train] = transitLegs(installed)
    expect(tripIdOf(bus)).toBe(RIDDEN_TRIP)
    expect(stopIdOf(bus.to)).toBe(PLANNED_STOP)
    expect(tripIdOf(train)).toBe(TRAIN_1843)
  })

  it('the plan’s own run aboard: the same-stop shortcut, no candidate plans', async () => {
    const store = makeStore({
      riding: { ...clone(fx.riding), legIndex: 1, tripId: '1:877022' }
    })
    await runReplan(store)
    expect(mockedFindTrip).toHaveBeenCalled()
    expect(store.actions.some((a) => a.type === 'AUTO_REPLAN')).toBe(true)
    expect(mockedFetch).not.toHaveBeenCalled()
  })
})
