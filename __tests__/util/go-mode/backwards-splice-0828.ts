import FakeTimers from '@sinonjs/fake-timers'

import {
  endGoMode,
  handlePositionUpdate,
  quietReplanAccessLeg
} from '../../../lib/actions/go-mode'
import {
  estimateBikeSpeedMps,
  recordRiderSpeedSample,
  withObservedBikeSpeed
} from '../../../lib/util/go-mode/rider-speed'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import { haversineDistance } from '../../../lib/util/go-mode/geometry'
import { spliceAccessOntoItinerary } from '../../../lib/util/go-mode/access-splice'
import fixture from '../../../lib/util/go-mode/replay/fixtures/orange-backwards-splice-0828.json'
import goMode from '../../../lib/reducers/go-mode'
import type { RiderSpeedSample } from '../../../lib/util/go-mode/rider-speed'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  }))
}))

/**
 * The 2026-08-28 EVENING ride (session mtdh67f3-0z5p24, 20:56–21:36 local),
 * driven from its own recorded feed.
 *
 * Downtown Minneapolis -> Bloomington. Bike to Marquette Ave & 5th St, Orange
 * Line 1:904 departing 02:35:58Z, bike home from I-35W & 98th St. The rider
 * drifted off the planned bike route, so Go Mode quietly re-planned the access
 * leg three times — and each replacement sheet said the bike leg finishes AFTER
 * the bus it feeds has already departed: by 618 s, then 257 s, then 185 s.
 *
 * The sheet was not merely pessimistic, it was wrong. Every re-plan re-derived
 * the bike leg at the engine default while `riderSpeedMps` — read off every fix
 * and spent only on local heuristics — showed this rider doing 6.9–7.2 m/s in
 * the same tick. The fixture's own GPS settles it: the third sheet, issued at
 * 02:31:58 with 760 m to go, promised arrival at 02:39:03; the rider was at the
 * stop by 02:34:43, 75 s before the bus left. They caught it.
 *
 * `spliceAccessOntoItinerary` is NOT the defect and is pinned here as correct:
 * the access end time is deliberately left un-clamped, so a rider who really
 * will arrive after departure is told the truth. The three sheets below are
 * exactly what that splicer produces from the access plans it was handed. The
 * lie came in with the plan.
 *
 * Fixed by 047ee0af / 94a69bba (Session 1.1), which shipped without a
 * fixture-driven gate because the recording had not been scoped to one ride yet
 * — the fixture was 61 MB of two rides and a car park. This is that gate.
 */

const BUS_LEG: any = (fixture as any).itinerary.legs[1]
const BOARD_STOP: [number, number] = [BUS_LEG.from.lat, BUS_LEG.from.lon]
/** When the Orange Line actually left Marquette & 5th. Frozen at plan time. */
const BUS_DEPARTS_MS = Number(BUS_LEG.startTime)

const SWAPS: any[] = (fixture as any).itinerarySwaps
/** The last of the three, and the one the rider disproved with their legs. */
const THIRD = SWAPS[2]

/** The access chain of a sheet: every leg before the boarding. */
const accessLegs = (itin: any) =>
  itin.legs.slice(
    0,
    itin.legs.findIndex((l: any) => l.transitLeg)
  )

/** How late the access chain lands relative to the bus it feeds, in seconds. */
const slackSeconds = (itin: any) => {
  const access = accessLegs(itin)
  const bus = itin.legs[access.length]
  return (
    (Number(bus.startTime) - Number(access[access.length - 1].endTime)) / 1000
  )
}

/**
 * The rolling buffer the re-plan builders query, rebuilt from the ride's own
 * fixes exactly as handlePositionUpdate builds it live — trimmed against each
 * fix's own timestamp, so this reproduces the live estimate rather than
 * approximating it.
 */
const bufferAt = (nowMs: number): RiderSpeedSample[] => {
  let samples: RiderSpeedSample[] = []
  for (const g of (fixture as any).gpsTrack) {
    if (g.tMs > nowMs) break
    samples = recordRiderSpeedSample(samples, {
      speedMps: g.speed,
      tMs: g.tMs
    })
  }
  return samples
}

/** The first recorded fix within `m` metres of the boarding stop. */
const reachedStopAtMs = (m: number): number | undefined =>
  (fixture as any).gpsTrack.find(
    (g: any) => haversineDistance([g.lat, g.lon], BOARD_STOP) < m
  )?.tMs

describe('util > go-mode > the 8/28 backwards trip sheets', () => {
  // Provenance. Everything below is meaningless if the fixture stops carrying
  // the defect's own input, so the recording is pinned by name and by number.
  it('the recording still carries three backwards sheets on one ride', () => {
    expect((fixture as any).meta.session).toBe('mtdh67f3-0z5p24')
    // One ride, not the seven-hour session it was recorded inside.
    const durationMin =
      ((fixture as any).meta.endMs - (fixture as any).meta.startMs) / 60000
    expect(durationMin).toBeLessThan(45)

    expect(SWAPS).toHaveLength(3)
    expect(SWAPS.map((s) => Math.round(slackSeconds(s.itinerary)))).toEqual([
      -618, -257, -185
    ])
    // ...and every one of them keeps the SAME bus. The re-plan was scoped to
    // the access chain, which is why the sheet reads as backwards rather than
    // as a later departure.
    for (const swap of SWAPS) {
      const bus = swap.itinerary.legs[accessLegs(swap.itinerary).length]
      expect(Number(bus.startTime)).toBe(BUS_DEPARTS_MS)
      expect(bus.trip.gtfsId).toBe(BUS_LEG.trip.gtfsId)
    }
  })

  it('and carries the rider beating every one of them', () => {
    // 760 m still to ride, and the sheet gave it 483 s — 2.3 m/s for a rider
    // whose own fixes in the same minute read three times that.
    const remaining = haversineDistance(
      [
        (fixture as any).gpsTrack.filter((g: any) => g.tMs <= THIRD.tMs).pop()
          .lat,
        (fixture as any).gpsTrack.filter((g: any) => g.tMs <= THIRD.tMs).pop()
          .lon
      ],
      BOARD_STOP
    )
    expect(remaining).toBeGreaterThan(700)
    expect(remaining).toBeLessThan(820)

    const arrived = reachedStopAtMs(80) as number
    expect(arrived).toBeLessThan(BUS_DEPARTS_MS)
    // Promised 02:39:03, at the stop by 02:34:43.
    const promisedMs = Number(accessLegs(THIRD.itinerary).slice(-1)[0].endTime)
    expect((promisedMs - arrived) / 1000).toBeGreaterThan(240)
  })

  it('reads the rider’s real pace off the ride’s own fixes', () => {
    // What every re-plan of that evening had in hand and never asked.
    expect(
      estimateBikeSpeedMps(bufferAt(SWAPS[1].tMs), SWAPS[1].tMs)
    ).toBeCloseTo(7.16, 2)
    expect(estimateBikeSpeedMps(bufferAt(THIRD.tMs), THIRD.tMs)).toBeCloseTo(
      6.87,
      2
    )
  })

  it('would have finished the third sheet’s bike leg before the bus left', () => {
    const observed = estimateBikeSpeedMps(
      bufferAt(THIRD.tMs),
      THIRD.tMs
    ) as number
    const access = accessLegs(THIRD.itinerary)
    const metres = access.reduce(
      (sum: number, l: any) => sum + (l.distance || 0),
      0
    )
    // The sheet's own figure, and the rider's.
    expect(metres / access[access.length - 1].duration).toBeCloseTo(2.26, 2)
    expect(THIRD.tMs + (metres / observed) * 1000).toBeLessThan(BUS_DEPARTS_MS)
  })

  it('puts that pace on the channel a re-plan query actually carries', () => {
    const observed = estimateBikeSpeedMps(
      bufferAt(THIRD.tMs),
      THIRD.tMs
    ) as number
    expect(withObservedBikeSpeed(undefined, observed)?.bikeSpeed).toBeCloseTo(
      6.87,
      2
    )
    // ...unless the rider named one themselves. bike-forward's 5.5 stands.
    expect(withObservedBikeSpeed({ bikeSpeed: 5.5 }, observed)).toEqual({
      bikeSpeed: 5.5
    })
  })

  it('splices the recorded access plan back into the recorded sheet, exactly', () => {
    // The splicer is correct and stays un-clamped: given an access plan that
    // lands after the bus, the honest sheet IS backwards. Reproducing all three
    // byte-for-byte is what proves the defect was upstream of it.
    for (const swap of SWAPS) {
      const access = accessLegs(swap.itinerary)
      const rebuilt = spliceAccessOntoItinerary(
        (fixture as any).itinerary,
        {
          legs: access,
          startTime: swap.itinerary.startTime
        } as any,
        1
      )
      expect(rebuilt.legs).toEqual(swap.itinerary.legs)
      expect(rebuilt.startTime).toBe(swap.itinerary.startTime)
      expect(rebuilt.endTime).toBe(swap.itinerary.endTime)
      expect(rebuilt.duration).toBe(swap.itinerary.duration)
      expect(rebuilt.walkDistance).toBeCloseTo(swap.itinerary.walkDistance, 5)
      expect(slackSeconds(rebuilt)).toBe(slackSeconds(swap.itinerary))
    }
  })
})

/**
 * The gate at the call site: the same recorded fixes, through the real tick, to
 * the real re-plan builder. On the unfixed code the query carries no
 * routingPreferences at all and OTP times the bike leg for somebody else.
 */
describe('util > go-mode > the 8/28 re-plan query, from the ride itself', () => {
  const initial = goMode(undefined, { type: '@@INIT' })
  const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
  /** The five minutes of riding the third sheet was planned from. */
  const RIDDEN = (fixture as any).gpsTrack.filter(
    (g: any) => g.tMs > THIRD.tMs - 300000 && g.tMs <= THIRD.tMs
  )

  let dateFaker: FakeTimers.InstalledClock | undefined
  let store: any

  const makeStore = () => {
    let runThunks = false
    let state: any = {
      ...initial,
      activeItinerary: (fixture as any).itinerary,
      isActive: true,
      routeMatch: { legIndex: 0, progressAlongLeg: 0 },
      tracking: { ...initial.tracking, lastPosition: null }
    }
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: {},
        goMode: state,
        transitIndex: { routes: {}, stops: {} }
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') {
        return runThunks ? action(dispatch, getState) : undefined
      }
      state = goMode(state, action)
      return action
    }
    return {
      getState,
      run: (thunk: any) => thunk(dispatch, getState),
      setRunThunks: (on: boolean) => {
        runThunks = on
      }
    }
  }

  beforeAll(async () => {
    mockedFetch.mockReset()
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({ error: false, itineraries: [] })
    )
    dateFaker = FakeTimers.install({ now: RIDDEN[0].tMs, toFake: ['Date'] })
    store = makeStore()
    for (const g of RIDDEN) {
      dateFaker.setSystemTime(g.tMs)
      store.run(
        handlePositionUpdate({
          coords: {
            accuracy: g.accuracy,
            altitude: null,
            altitudeAccuracy: null,
            heading: g.heading,
            latitude: g.lat,
            longitude: g.lon,
            speed: g.speed
          },
          timestamp: g.tMs
        } as GeolocationPosition)
      )
    }
    dateFaker.setSystemTime(THIRD.tMs)
    store.setRunThunks(true)
    await store.run(quietReplanAccessLeg())
  })

  afterAll(() => {
    store?.setRunThunks(false)
    store?.run(endGoMode())
    dateFaker?.uninstall()
  })

  it('scopes the re-plan to the bike chain, as it already did', () => {
    const scoped = mockedFetch.mock.calls[0]?.[0]
    expect(scoped).toBeDefined()
    expect(scoped.modes).toEqual([{ mode: 'BICYCLE' }])
    expect(scoped.to.name).toBe(BUS_LEG.from.name)
  })

  it('tells OTP the pace this ride was actually being ridden at', () => {
    // The assertion that fails on the unfixed code, where routingPreferences is
    // absent and the bike leg is re-derived at the engine default.
    const scoped = mockedFetch.mock.calls[0]?.[0]
    expect(scoped.routingPreferences?.bikeSpeed).toBeCloseTo(6.87, 2)
  })
})
