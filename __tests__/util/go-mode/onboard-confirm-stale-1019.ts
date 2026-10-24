/* globals afterEach, beforeEach, describe, expect, it, jest */
import '../../test-utils/mock-window-url'

import polyline from '@mapbox/polyline'

import {
  closeOnboardAlightPreview,
  confirmOnboardAlightStop,
  openOnboardAlightPreview,
  stopVehicleTracking
} from '../../../lib/actions/go-mode'
import {
  confirmAndReplay,
  hhmmss,
  loadFixture
} from '../../test-utils/onboard-confirm-replay'
import {
  convertPlanResponseItineraries,
  fetchOnboardCandidatePlan
} from '../../../lib/actions/apiV2'
import {
  firstStopAheadOnShape,
  metersPastOnShape,
  projectForwardOnShape
} from '../../../lib/util/go-mode/geometry'
import {
  ONBOARD_CONFIRM_LIST_MAX_AGE_MS,
  ONBOARD_CONFIRM_PASSED_M,
  onboardConfirmRecheck,
  pickRecheckedAlight,
  recheckChangedTrip
} from '../../../lib/util/go-mode/onboard-confirm'
import { sendPush } from '../../../lib/util/go-mode/native-notify'
import goMode from '../../../lib/reducers/go-mode'

/** Same stub as detour-riding-hold-1012.ts: these replays run the real tick. */
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
 * The candidate plans are served from the fixture's own recorded answers
 * (`onboardCandidatePlans`, by the stop the plan departs from, latest at or
 * before the clock): the replay engine has no lane for them — it would answer
 * every plan() with the nearest reroute snapshot.
 */
jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn()
}))
jest.mock('../../../lib/util/go-mode/native-notify', () => ({
  ...jest.requireActual('../../../lib/util/go-mode/native-notify'),
  cancelPush: jest.fn(() => Promise.resolve()),
  sendPush: jest.fn(() => Promise.resolve())
}))

const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
const pushed = sendPush as jest.Mock

/** Raw recorded plans → what fetchOnboardCandidatePlan resolves to. */
function servePlansFrom(records: any[]) {
  mockedFetch.mockImplementation((combo: any) => () => {
    const now = Date.now()
    const near = (r: any) =>
      Math.abs((r.request?.from?.lat ?? 0) - combo.from.lat) < 1e-5 &&
      Math.abs((r.request?.from?.lon ?? 0) - combo.from.lon) < 1e-5
    const mine = records.filter(near).sort((a, b) => a.tMs - b.tMs)
    const rec =
      [...mine].reverse().find((r: any) => r.tMs <= now) || mine[0] || null
    if (!rec) return Promise.resolve({ error: true, itineraries: [] })
    const itineraries = convertPlanResponseItineraries(
      JSON.parse(JSON.stringify(rec.response)),
      {
        combo,
        config: { transitOperators: [] },
        query: {},
        strictModes: false,
        validModeCombinations: undefined
      } as any
    )
    return Promise.resolve({
      error: false,
      itineraries,
      response: rec.response
    })
  })
}

/** Already-converted onward itineraries, by stop id. */
function serveItineraries(byStop: Record<string, any[]>, stops: any[]) {
  mockedFetch.mockImplementation((combo: any) => () => {
    const stop = stops.find(
      (s: any) =>
        Math.abs(s.lat - combo.from.lat) < 1e-6 &&
        Math.abs(s.lon - combo.from.lon) < 1e-6
    )
    const its = (stop && byStop[stop.id]) || []
    return Promise.resolve({
      error: its.length === 0,
      itineraries: JSON.parse(JSON.stringify(its))
    })
  })
}

beforeEach(() => {
  mockedFetch.mockReset()
  pushed.mockClear()
})

jest.setTimeout(300000)

/* ─── 2026-10-19 16:35:17, the Gold Line Confirm (64.1) ─────────────────── */

const gold = loadFixture('gold-1631-1019.json')

/** onboard-preview-confirm, 6th St & Minnesota (row index 1). */
const CONFIRM_GOLD = 1792445717023
/** SET_ONBOARD_RESULT 16:34:16.010 — the list the rider confirmed from. */
const RESULT_GOLD = 1792445656010
const GOLD_TRIP = '1:1343603'
const GOLD_VEHICLE = '1:8173'

const goldSetup = (fx: any) => {
  const result = fx.onboard.result.payload
  return {
    confirmAtMs: CONFIRM_GOLD,
    // SET_RIDING 16:31:40.041, standing at the Confirm.
    kept: {
      boardedAt: 1792443942678,
      headsign: 'GOLD Downtown St Paul',
      legIndex: 0,
      offRouteSince: null,
      routeId: '1:905',
      routeShortName: null,
      tripId: GOLD_TRIP,
      vehicleId: GOLD_VEHICLE
    },
    option: result.options[1],
    options: result.options,
    resultAtMs: RESULT_GOLD,
    trip: fx.onboard.trip.payload,
    // SET_ONBOARD_VEHICLE 16:34:08.652: next stop Minnesota, and it stayed
    // Minnesota on every match to the Confirm (a frame frozen at 16:34:19).
    vehicle: {
      label: 'GOLD Downtown St Paul',
      nextStopId: '1:57417',
      routeId: '1:905',
      tripId: GOLD_TRIP,
      vehicleId: GOLD_VEHICLE
    }
  }
}

;(gold ? describe : describe.skip)(
  '64.1 — the 2026-10-19 16:35:17 Gold Line Confirm, replayed',
  () => {
    it('as shipped: Minnesota, behind the rider, and "Off route" follows', async () => {
      const setup = goldSetup(gold)
      // The recorded START_GO_MODE 16:35:17.027 is the shipped answer.
      const shipped = gold.itinerarySwaps.find(
        (s: any) => Math.abs(s.tMs - 1792445717027) < 5
      ).itinerary
      const r = await confirmAndReplay(
        gold,
        { ...setup, option: { ...setup.option, __itinerary: shipped } },
        { commit: 'as-shipped', windowMs: 34000 }
      )
      expect(r.itinerary.legs[0].to.name).toBe('6th St & Minnesota Station')
      const offRoute = r.events.filter(
        (e) => e.type === 'ADD_NOTIFICATION' && e.p?.type === 'ROUTE_DEVIATION'
      )
      expect(offRoute.length).toBeGreaterThan(0)
      // The phone pushed it at 16:35:50.108; the replay's tick lands within
      // a second of that.
      expect(Math.abs(offRoute[0].t - 1792445750108)).toBeLessThan(1500)
    })

    it('measures the Confirm: ~131 m past Minnesota on a 61 s-old list', () => {
      const setup = goldSetup(gold)
      const fix = [...gold.gpsTrack]
        .filter((g: any) => g.tMs <= CONFIRM_GOLD)
        .pop()
      const check = onboardConfirmRecheck({
        itinerary: setup.option.displayItinerary,
        lastPosition: {
          coords: {
            accuracy: fix.accuracy,
            latitude: fix.lat,
            longitude: fix.lon
          },
          timestamp: fix.tMs
        },
        nowMs: CONFIRM_GOLD,
        resultAtMs: RESULT_GOLD,
        trip: setup.trip
      })
      expect(check.reason).toBe('passed')
      expect(check.pastM).toBeGreaterThan(110)
      expect(check.pastM).toBeLessThan(150)
      // The list alone would not have tripped it: 61 s < 2 min.
      expect(check.listAgeMs).toBe(61013)
      expect(check.listAgeMs!).toBeLessThan(ONBOARD_CONFIRM_LIST_MAX_AGE_MS)
      // 6th St & Washington is the first stop still ahead.
      expect(check.aheadStopId).toBe('1:11863')
    })

    it('after: starts at Washington, says "Trip updated" once, no push', async () => {
      servePlansFrom(gold.onboardCandidatePlans)
      const r = await confirmAndReplay(gold, goldSetup(gold), {
        commit: 'confirm',
        windowMs: 34000
      })
      const legs: any[] = r.itinerary.legs
      expect(legs[0].trip.gtfsId).toBe(GOLD_TRIP)
      expect(legs[0].to.name).toBe('6th St & Washington Station')
      // The rider is on the bus leg, not past it: it starts at Minnesota
      // (the stop just behind them) and runs to Washington.
      expect(legs[0].from.name).toBe('6th St & Minnesota Station')
      // Same onward route the rider chose: the 54.
      const onward = legs.find((l, i) => i > 0 && l.transitLeg)
      expect(onward?.routeShortName ?? onward?.route?.shortName).toBe('54')
      const types = r.events.map((e) => e.type)
      // No list flash: the re-ask wrote no optimize bookkeeping.
      expect(types).not.toContain('START_ONBOARD_OPTIMIZE')
      expect(types).not.toContain('SET_ONBOARD_RESULT')
      // Confirm disabled while it asked, then released.
      expect(
        r.events
          .filter((e) => e.type === 'SET_ONBOARD_CONFIRMING')
          .map((e) => e.p != null)
      ).toEqual([true, false])
      expect(r.starts).toHaveLength(1)
      const notes = r.events.filter((e) => e.type === 'ADD_NOTIFICATION')
      const updated = notes.filter((e) => e.p?.type === 'TRIP_UPDATED')
      expect(updated).toHaveLength(1)
      expect(updated[0].p.message).toContain(
        'off at 6th St & Washington Station'
      )
      expect(pushed).not.toHaveBeenCalled()
      // …and in the 33 s the shipped trip took to cry "Off route": nothing.
      expect(notes.filter((e) => e.p?.type === 'ROUTE_DEVIATION')).toEqual([])
      // The fact is the Gold Line bus, on leg 0, clean (64.3's tail).
      expect(r.riding0).toMatchObject({
        legIndex: 0,
        tripId: GOLD_TRIP,
        vehicleId: GOLD_VEHICLE
      })
      expect(r.clears).toEqual([])
    })

    it('a passed stop with nothing ahead answering: the list comes back', async () => {
      mockedFetch.mockImplementation(
        () => () => Promise.resolve({ error: true, itineraries: [] })
      )
      const r = await confirmAndReplay(gold, goldSetup(gold), {
        commit: 'confirm',
        windowMs: 0
      })
      const types = r.events.map((e) => e.type)
      // No trip started on a stop behind the rider…
      expect(r.starts).toEqual([])
      // …the preview closed and the list re-ran, visibly, from Washington.
      expect(types).toContain('CLOSE_ONBOARD_PREVIEW')
      expect(types).toContain('START_ONBOARD_OPTIMIZE')
      expect(r.onboardAtEnd.preview).toBeNull()
      expect(r.onboardAtEnd.vehicle?.nextStopId).toBe('1:11863')
      expect(r.onboardAtEnd.confirmingAtMs).toBeNull()
    })
  }
)

/* ─── 2026-10-20 08:32:53, the 12.8-minute-old list (stale only) ───────── */

const orange = loadFixture('ride-1020-0832.json')
const CONFIRM_0832 = 1792503173360
/** SET_ONBOARD_RESULT 08:20:02.647 — the list confirmed at 08:32:53. */
const RESULT_0832 = 1792502402647

const orangeSetup = (fx: any) => {
  const legs = fx.itinerary.legs
  // The fixture opens at START_GO_MODE, outside the list's window; the
  // confirmed option is the started plan's stop and onward legs.
  const option = {
    busArrivalEpoch: legs[0].endTime,
    itinerary: { ...fx.itinerary, legs: legs.slice(1) },
    stopId: '1:53314',
    stopName: '2nd Ave S & 5th St - Stop Group F'
  }
  return {
    confirmAtMs: CONFIRM_0832,
    kept: {
      boardedAt: 1792502355479,
      headsign: 'ORANGE Downtown Minneapolis',
      keptAtMs: 1792502389796,
      legIndex: 0,
      offRouteSince: 1792502372418,
      routeId: '1:904',
      routeShortName: null,
      tripId: '1:1366791',
      vehicleId: '1:8222'
    },
    option,
    resultAtMs: RESULT_0832,
    vehicle: {
      label: 'METRO Orange Line',
      nextStopId: null,
      routeId: '1:904',
      tripId: '1:1366791',
      vehicleId: '1:8222'
    }
  }
}

;(orange ? describe : describe.skip)(
  '64.1 — the 2026-10-20 08:32:53 Confirm on a 12.8 min-old list',
  () => {
    it('re-asks, gets the same stop and route back, starts it with no note', async () => {
      const setup = orangeSetup(orange)
      // The 10-20 fixture recorded no candidate plans: the re-ask is answered
      // with the started plan's own onward legs from 2nd Ave S & 5th St, and
      // nothing from anywhere else.
      const tripRec = orange.tripSnapshots.find(
        (s: any) => s.tripId === '1:1366791'
      ).payload
      serveItineraries(
        { '1:53314': [setup.option.itinerary] },
        tripRec.stopTimes.map((st: any) => st.stop)
      )
      const r = await confirmAndReplay(orange, setup, {
        commit: 'confirm',
        windowMs: 14000
      })
      expect(mockedFetch).toHaveBeenCalled()
      expect(r.starts).toHaveLength(1)
      expect(r.itinerary.legs[0].to.name).toBe(
        '2nd Ave S & 5th St - Stop Group F'
      )
      const types = r.events.map((e) => e.type)
      expect(types).not.toContain('START_ONBOARD_OPTIMIZE')
      expect(
        r.events.filter(
          (e) => e.type === 'ADD_NOTIFICATION' && e.p?.type === 'TRIP_UPDATED'
        )
      ).toEqual([])
      expect(r.clears).toEqual([])
    })

    it('stale with nothing answering: the rider’s own choice starts', async () => {
      mockedFetch.mockImplementation(
        () => () => Promise.resolve({ error: true, itineraries: [] })
      )
      const r = await confirmAndReplay(orange, orangeSetup(orange), {
        commit: 'confirm',
        windowMs: 0
      })
      expect(mockedFetch).toHaveBeenCalled()
      expect(r.starts).toHaveLength(1)
      expect(r.itinerary.legs[0].to.name).toBe(
        '2nd Ave S & 5th St - Stop Group F'
      )
      expect(r.events.map((e) => e.type)).not.toContain(
        'START_ONBOARD_OPTIMIZE'
      )
      expect(
        r.events.filter(
          (e) => e.type === 'ADD_NOTIFICATION' && e.p?.type === 'TRIP_UPDATED'
        )
      ).toEqual([])
    })
  }
)

/* ─── The shape helpers ───────────────────────────────────────────────── */

describe('64.1 — shape helpers', () => {
  // A run east along 44.95 N, ~78.7 m per 0.001° of longitude, that loops:
  // out to the east end, up 0.002° N, back west, then down past the start's
  // longitude again on a parallel street ~22 m north of the outbound one.
  const S = (lonOff: number, latOff = 0): [number, number] => [
    44.95 + latOff,
    -93.1 + lonOff
  ]
  const loop: Array<[number, number]> = [
    S(0),
    S(0.01),
    S(0.02),
    S(0.02, 0.0002),
    S(0.01, 0.0002),
    S(0, 0.0002)
  ]
  const stops = [
    { id: 'a', lat: S(0)[0], lon: S(0)[1] },
    { id: 'b', lat: S(0.01)[0], lon: S(0.01)[1] },
    { id: 'c', lat: S(0.02)[0], lon: S(0.02)[1] },
    { id: 'd', lat: S(0.01, 0.0002)[0], lon: S(0.01, 0.0002)[1] }
  ]

  it('projects forward from the anchor, first pass first', () => {
    // A point on the OUTBOUND street near b, 2 m north of it: the return
    // street is 20 m away — nearer than nothing, but the second pass.
    const p: [number, number] = [44.95 + 0.00002, -93.1 + 0.011]
    const first = projectForwardOnShape(loop, p, 0)
    expect(first?.segmentIndex).toBe(1)
    // From the far end on, the only pass left is the return one.
    const later = projectForwardOnShape(loop, p, 3)
    expect(later?.segmentIndex).toBe(3)
    expect(later!.alongM).toBeGreaterThan(first!.alongM)
  })

  it('metersPastOnShape: past b by ~79 m on the outbound pass, never the return', () => {
    const p: [number, number] = [44.95 + 0.00005, -93.1 + 0.011]
    const at = (point: [number, number] | null, stopIndex: number) =>
      metersPastOnShape(loop, { anchorIndex: 0, point, stopIndex, stops })
    const past = at(p, 1)
    expect(past).toBeGreaterThan(70)
    expect(past).toBeLessThan(90)
    // Still ahead of b: negative.
    expect(at([44.95, -93.1 + 0.009], 1)).toBeLessThan(-70)
    // d is the return-pass stop 22 m north of b. A global nearest point would
    // put it on the outbound street beside b — and the rider ~79 m PAST it.
    // Placed in run order it is ~1.5 km further on, still well ahead.
    expect(at(p, 3)).toBeLessThan(-1400)
  })

  it('firstStopAheadOnShape: the next stop along, a stop underfoot counts', () => {
    const p: [number, number] = [44.95, -93.1 + 0.011]
    expect(firstStopAheadOnShape(loop, stops, p)).toBe(2)
    // Standing 10 m past b (within atStopM): b is still "ahead".
    const atB: [number, number] = [44.95, -93.1 + 0.01 + 0.00013]
    expect(firstStopAheadOnShape(loop, stops, atB)).toBe(1)
    // Past the last stop: nothing ahead.
    const pastEnd: [number, number] = [44.95 + 0.0002, -93.1 + 0.005]
    expect(
      firstStopAheadOnShape(loop, stops, pastEnd, { fromStopIndex: 3 })
    ).toBeNull()
  })

  it('no fix, no shape, no stop: no answer rather than a guess', () => {
    const q = { anchorIndex: 0, stopIndex: 1, stops }
    expect(metersPastOnShape(loop, { ...q, point: null })).toBeNull()
    expect(metersPastOnShape(null, { ...q, point: [44.95, -93.1] })).toBeNull()
    expect(
      metersPastOnShape(loop, {
        ...q,
        point: [44.95, -93.1],
        stops: [stops[0], { id: 'x' }]
      })
    ).toBeNull()
    expect(firstStopAheadOnShape(loop, stops, null)).toBeNull()
    expect(firstStopAheadOnShape([], stops, [44.95, -93.1])).toBeNull()
    expect(projectForwardOnShape(loop, null)).toBeNull()
  })
})

/* ─── The decision and the pick, without a fixture ────────────────────── */

describe('64.1 — onboardConfirmRecheck and pickRecheckedAlight', () => {
  const NOW = 1_800_000_000_000
  const lonAt = (m: number) => -93.1 + m / 78_700
  const st = (id: string, m: number, dep: number) => ({
    scheduledArrival: dep,
    scheduledDeparture: dep,
    serviceDay: 0,
    stop: { code: id, id, lat: 44.95, lon: lonAt(m), name: id }
  })
  const trip = {
    geometry: {
      points: polyline.encode([
        [44.95, lonAt(0)],
        [44.95, lonAt(3000)]
      ])
    },
    id: '1:T',
    stopTimes: [st('1:a', 0, 0), st('1:b', 1000, 120), st('1:c', 2000, 240)]
  }
  const built = (fromId: string, toId: string): any => ({
    legs: [
      {
        from: { name: fromId, stopId: fromId },
        to: { name: toId, stop: { gtfsId: toId } },
        transitLeg: true,
        trip: { gtfsId: '1:T' }
      }
    ]
  })
  const fixAt = (m: number, extra: any = {}) => ({
    coords: { accuracy: 10, latitude: 44.95, longitude: lonAt(m), ...extra },
    timestamp: NOW - 1000
  })

  it('commits as chosen when the stop is ahead and the list is fresh', () => {
    const c = onboardConfirmRecheck({
      itinerary: built('1:a', '1:b'),
      lastPosition: fixAt(800),
      nowMs: NOW,
      resultAtMs: NOW - 30_000,
      trip
    })
    expect(c.reason).toBeNull()
    expect(c.pastM).toBeLessThan(-150)
  })

  it('"passed" past the 50 m line, "stale" past two minutes', () => {
    const passed = onboardConfirmRecheck({
      itinerary: built('1:a', '1:b'),
      lastPosition: fixAt(1000 + ONBOARD_CONFIRM_PASSED_M + 20),
      nowMs: NOW,
      resultAtMs: NOW - 30_000,
      trip
    })
    expect(passed.reason).toBe('passed')
    expect(passed.aheadStopId).toBe('1:c')
    const within = onboardConfirmRecheck({
      itinerary: built('1:a', '1:b'),
      lastPosition: fixAt(1000 + 30),
      nowMs: NOW,
      resultAtMs: NOW - 30_000,
      trip
    })
    expect(within.reason).toBeNull()
    const stale = onboardConfirmRecheck({
      itinerary: built('1:a', '1:b'),
      lastPosition: fixAt(500),
      nowMs: NOW,
      resultAtMs: NOW - ONBOARD_CONFIRM_LIST_MAX_AGE_MS - 1,
      trip
    })
    expect(stale.reason).toBe('stale')
    expect(stale.aheadStopId).toBe('1:b')
  })

  it('a coarse or old fix never moves the stop; an unknown age is not stale', () => {
    const coarse = onboardConfirmRecheck({
      itinerary: built('1:a', '1:b'),
      lastPosition: fixAt(1500, { accuracy: 1414 }),
      nowMs: NOW,
      resultAtMs: null,
      trip
    })
    expect(coarse.pastM).toBeNull()
    expect(coarse.reason).toBeNull()
    const old = onboardConfirmRecheck({
      itinerary: built('1:a', '1:b'),
      lastPosition: { ...fixAt(1500), timestamp: NOW - 10 * 60_000 },
      nowMs: NOW,
      resultAtMs: undefined,
      trip
    })
    expect(old.reason).toBeNull()
    // No shape at all: the age test still runs.
    const noShape = onboardConfirmRecheck({
      itinerary: built('1:a', '1:b'),
      lastPosition: fixAt(1500),
      nowMs: NOW,
      resultAtMs: NOW - 5 * 60_000,
      trip: { ...trip, geometry: null }
    })
    expect(noShape.pastM).toBeNull()
    expect(noShape.reason).toBe('stale')
  })

  const opt = (stopId: string, route: string | null, extra: any = {}) => ({
    itinerary: {
      legs: route
        ? [{ route: { id: route }, transitLeg: true }]
        : [{ mode: 'BICYCLE', transitLeg: false }]
    } as any,
    stopId,
    ...extra
  })

  it('pick: the chosen stop, then the same onward route, then the top', () => {
    const chosen = opt('1:b', '1:54')
    expect(
      pickRecheckedAlight(
        [opt('1:c', '1:54'), opt('1:b', '1:480'), opt('1:b', '1:54')],
        chosen
      )
    ).toEqual(opt('1:b', '1:54'))
    expect(
      pickRecheckedAlight([opt('1:c', '1:480'), opt('1:b', '1:480')], chosen)
    ).toEqual(opt('1:b', '1:480'))
    expect(
      pickRecheckedAlight([opt('1:c', '1:480'), opt('1:d', '1:54')], chosen)
    ).toEqual(opt('1:d', '1:54'))
    expect(
      pickRecheckedAlight([opt('1:c', '1:480'), opt('1:d', null)], chosen)
    ).toEqual(opt('1:c', '1:480'))
    expect(pickRecheckedAlight([], chosen)).toBeNull()
    expect(pickRecheckedAlight(null, chosen)).toBeNull()
  })

  it('a note only when the stop or the onward route changed', () => {
    const chosen = opt('1:b', '1:54')
    expect(recheckChangedTrip(opt('1:b', '1:54'), chosen)).toBe(false)
    expect(recheckChangedTrip(opt('1:c', '1:54'), chosen)).toBe(true)
    expect(recheckChangedTrip(opt('1:b', '1:480'), chosen)).toBe(true)
    // Same anchor, but it now rides on to a different stop: changed.
    expect(
      recheckChangedTrip(opt('1:b', '1:54', { alightStopId: '1:c' }), chosen)
    ).toBe(true)
  })
})

/* ─── Through the reducer: single-flight, Back, the note's channel ────── */

describe('64.1 — the Confirm re-check through the real reducer', () => {
  // The optimizer reads the wall clock; the trip is planned around it.
  const NOW = Date.now()
  const lonAt = (m: number) => -93.1 + m / 78_700
  const st = (id: string, m: number, dep: number) => ({
    scheduledArrival: dep,
    scheduledDeparture: dep,
    serviceDay: 0,
    stop: { code: id, id, lat: 44.95, lon: lonAt(m), name: `Stop ${id}` }
  })
  const TRIP = {
    geometry: {
      points: polyline.encode([
        [44.95, lonAt(0)],
        [44.95, lonAt(3000)]
      ])
    },
    id: '1:T',
    route: { id: '1:904', mode: 'BUS', shortName: 'Orange' },
    stopTimes: [st('1:a', 0, 0), st('1:b', 1000, 120), st('1:c', 2000, 240)],
    tripHeadsign: 'East'
  }
  const onward = (fromId: string, m: number) => ({
    endTime: NOW + 30 * 60_000,
    legs: [
      {
        distance: 500,
        endTime: NOW + 30 * 60_000,
        from: {
          lat: 44.95,
          lon: lonAt(m),
          name: `Stop ${fromId}`,
          stopId: fromId
        },
        mode: 'BICYCLE',
        startTime: NOW + 5 * 60_000,
        to: { lat: 44.96, lon: lonAt(m), name: 'Home' },
        transitLeg: false
      }
    ],
    startTime: NOW + 5 * 60_000
  })
  const OPTION_B = {
    busArrivalEpoch: NOW + 2 * 60_000,
    itinerary: onward('1:b', 1000),
    stopId: '1:b',
    stopName: 'Stop 1:b'
  }

  const makeStore = (fixM: number, resultAtMs: number | null) => {
    const initial = goMode(undefined, { type: '@@INIT' })
    let state: any = {
      ...initial,
      isActive: true,
      onboard: {
        ...initial.onboard,
        alightOptions: [OPTION_B],
        answeredCandidates: 1,
        bestAlightStop: OPTION_B,
        pendingCandidates: 0,
        resultAtMs,
        status: 'ready',
        trip: TRIP,
        vehicle: { routeId: '1:904', tripId: '1:T', vehicleId: '1:8222' }
      },
      tracking: {
        ...initial.tracking,
        lastPosition: {
          coords: { accuracy: 8, latitude: 44.95, longitude: lonAt(fixM) },
          timestamp: Date.now()
        }
      }
    }
    const actions: any[] = []
    const getState = () => ({
      otp: {
        config: {
          api: { host: 'http://mock-host.com', path: '/api', port: 80 },
          homeTimezone: 'America/Chicago',
          modes: {}
        },
        currentQuery: { to: { lat: 44.96, lon: lonAt(2000), name: 'Home' } },
        goMode: state,
        transitIndex: { routes: {}, trips: { '1:T': TRIP } }
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      actions.push(action)
      state = goMode(state, action)
      return action
    }
    return { actions, dispatch, getGoMode: () => state }
  }

  afterEach(() => {
    stopVehicleTracking()(() => undefined)
  })

  it('a fresh list with the stop ahead commits at once — no re-ask', () => {
    const store = makeStore(500, Date.now() - 10_000)
    store.dispatch(openOnboardAlightPreview(OPTION_B, 'row'))
    store.dispatch(confirmOnboardAlightStop())
    expect(mockedFetch).not.toHaveBeenCalled()
    const types = store.actions.map((a) => a.type)
    expect(types).not.toContain('SET_ONBOARD_CONFIRMING')
    expect(types.filter((t) => t === 'START_GO_MODE')).toHaveLength(1)
  })

  it('a second tap while re-checking does nothing; Back drops the answer', async () => {
    let release: (v: any) => void = () => undefined
    mockedFetch.mockImplementation(
      () => () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const store = makeStore(1200, Date.now() - 10_000) // 200 m past b
    store.dispatch(openOnboardAlightPreview(OPTION_B, 'row'))
    const first = store.dispatch(confirmOnboardAlightStop())
    expect(store.getGoMode().onboard.confirmingAtMs).not.toBeNull()
    const callsAfterFirst = mockedFetch.mock.calls.length
    store.dispatch(confirmOnboardAlightStop())
    expect(mockedFetch.mock.calls.length).toBe(callsAfterFirst)
    // The rider backs out of the preview while the re-ask is out.
    store.dispatch(closeOnboardAlightPreview())
    expect(store.getGoMode().onboard.confirmingAtMs).toBeNull()
    release({ error: false, itineraries: [onward('1:c', 2000)] })
    await first
    const types = store.actions.map((a) => a.type)
    expect(types).not.toContain('START_GO_MODE')
    expect(store.getGoMode().onboard.alightOptions).toEqual([OPTION_B])
  })

  it('a changed stop gets the in-app "Trip updated" card and never a push', async () => {
    mockedFetch.mockImplementation(
      (combo: any) => () =>
        Promise.resolve(
          Math.abs(combo.from.lon - lonAt(2000)) < 1e-6
            ? { error: false, itineraries: [onward('1:c', 2000)] }
            : { error: true, itineraries: [] }
        )
    )
    const seen: any[] = []
    const listener = (e: any) => seen.push(e.detail)
    window.addEventListener('go-mode-notification', listener)
    try {
      const store = makeStore(1200, Date.now() - 10_000)
      store.dispatch(openOnboardAlightPreview(OPTION_B, 'row'))
      await store.dispatch(confirmOnboardAlightStop())
      const legs: any[] = store.getGoMode().activeItinerary?.legs || []
      expect(legs[0].to.name).toBe('Stop 1:c')
      // (The seed tick may add its own approach card; only the note counts.)
      const notes = store.actions
        .filter(
          (a) =>
            a.type === 'ADD_NOTIFICATION' && a.payload?.type === 'TRIP_UPDATED'
        )
        .map((a) => a.payload)
      expect(notes).toHaveLength(1)
      expect(notes[0].title).toBe('Trip updated')
      expect(notes[0].message).toContain('off at Stop 1:c')
      // In-app: the toast event fired; no push was sent.
      expect(
        seen.filter((n) => n.type === 'TRIP_UPDATED').map((n) => n.id)
      ).toEqual([notes[0].id])
      expect(pushed).not.toHaveBeenCalled()
      // …and the fact is the confirmed bus on the bus leg.
      expect(store.getGoMode().riding).toMatchObject({
        legIndex: 0,
        offRouteSince: null,
        tripId: '1:T'
      })
    } finally {
      window.removeEventListener('go-mode-notification', listener)
    }
  })
})
