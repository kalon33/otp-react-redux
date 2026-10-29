/* globals afterEach, beforeEach, describe, expect, it, jest */
import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import {
  endGoMode,
  quietReplanAccessLeg,
  replanFromAboard,
  reRouteFromCurrentPosition
} from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan, findTrip } from '../../../lib/actions/apiV2'
import { inheritItineraryModes } from '../../../lib/util/go-mode/replan-modes'
import goMode from '../../../lib/reducers/go-mode'

// The search's modes on the day: the config default "Transit, Bike" buttons
// (the C4 reroute request carried `modes [TRANSIT, BICYCLE]`).
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

const initial = goMode(undefined, { type: '@@INIT' })
const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
const mockedFindTrip = findTrip as jest.Mock

const modeNames = (modes: any[] | undefined) =>
  (modes || []).map((m: any) => m.mode)
const asksForBike = (combo: any) => modeNames(combo?.modes).includes('BICYCLE')

/**
 * BACKLOG 75.15 — chaos agent C4, `$S/chaos/s1-otp-unreachable/mid-trip-geo2/`
 * (2026-10-28 23:45 CDT, otprr main `3a7050816`, isolated sim stack).
 *
 * The rider was WALKING 243.51 m to the 18 at Nicollet Ave S & 46th St E.
 * The 23:52 run was missed; `START_REROUTE {autoApply: true, keepRouteId:
 * "1:18", reason: "missed-bus"}`; `AUTO_REPLAN accepted reason missed-bus`
 * (tMs 1793249925334) installed BICYCLE 5306.58 m → 18 at Nicollet Ave S &
 * Franklin Ave W → BICYCLE, pushed "18 · in 22 min · Nicollet Ave S & Franklin
 * Ave W", then "Leave in 1 min". While offline the card had shown the walk
 * answer: "Next: 12:07 AM … 9 min away" at 46th St. The route was kept; the
 * mode and the boarding stop were not, because the re-plan asked with the
 * search's modes, and the search allowed bike.
 */
const NOW = 1793249925334 // AUTO_REPLAN tMs, 23:58:45 CDT
const RIDER: [number, number] = [44.91958, -93.27679] // the walker's fix
const STOP_46TH: [number, number] = [44.91962, -93.27772]
const STOP_FRANKLIN: [number, number] = [44.96263, -93.27848]
const ALIGHT: [number, number] = [44.97412, -93.27396]
const DEST: [number, number] = [44.97521, -93.27011]

const RUN_1207 = Date.parse('2026-10-29T05:07:00Z') // 12:07 AM at 46th St
const RUN_1221 = Date.parse('2026-10-29T05:21:00Z') // 12:21 AM at Franklin
const ARRIVE = Date.parse('2026-10-29T05:33:25Z') // the C4 replacement's end

const place = ([lat, lon]: [number, number], name: string) => ({
  lat,
  lon,
  name
})

const street = (
  mode: 'BICYCLE' | 'WALK',
  from: [number, number],
  fromName: string,
  to: [number, number],
  toName: string,
  startTime: number,
  endTime: number,
  distance: number
) => ({
  distance,
  duration: (endTime - startTime) / 1000,
  endTime,
  from: place(from, fromName),
  legGeometry: { points: encode([from, to]) },
  mode,
  startTime,
  to: place(to, toName),
  transitLeg: false
})

const bus18 = (
  from: [number, number],
  fromName: string,
  startTime: number,
  endTime: number
) => ({
  distance: 6000,
  duration: (endTime - startTime) / 1000,
  endTime,
  from: { ...place(from, fromName), stopId: `1:${fromName}` },
  legGeometry: { points: encode([from, ALIGHT]) },
  mode: 'BUS',
  route: { gtfsId: '1:18', id: '1:18' },
  routeId: '1:18',
  routeShortName: '18',
  startTime,
  to: { ...place(ALIGHT, 'Nicollet Mall & 8th St'), stopId: '1:alight' },
  transitLeg: true,
  tripId: `1:18-${startTime}`
})

const itinerary = (legs: any[]) => ({
  duration: (legs[legs.length - 1].endTime - legs[0].startTime) / 1000,
  endTime: legs[legs.length - 1].endTime,
  legs,
  startTime: legs[0].startTime
})

/** The trip the rider chose: walk → the missed 23:52 18 at 46th → walk. */
const heldWalkTrip = () => {
  const board = Date.parse('2026-10-29T04:52:43Z')
  return itinerary([
    street(
      'WALK',
      [44.9205, -93.27603],
      'Test origin',
      STOP_46TH,
      'Nicollet Ave S & 46th St E',
      board - 187_000,
      board,
      243.51
    ),
    bus18(STOP_46TH, 'Nicollet Ave S & 46th St E', board, board + 1_200_000),
    street(
      'WALK',
      ALIGHT,
      'Nicollet Mall & 8th St',
      DEST,
      'Destination',
      board + 1_200_000,
      board + 1_429_000,
      320
    )
  ])
}

/** What the fix should install: on foot to 46th St for the 12:07 18. */
const walkAnswer = () =>
  itinerary([
    street(
      'WALK',
      RIDER,
      'Current location',
      STOP_46TH,
      'Nicollet Ave S & 46th St E',
      NOW,
      NOW + 75_000,
      75
    ),
    bus18(STOP_46TH, 'Nicollet Ave S & 46th St E', RUN_1207, ARRIVE - 229_000),
    street(
      'WALK',
      ALIGHT,
      'Nicollet Mall & 8th St',
      DEST,
      'Destination',
      ARRIVE - 229_000,
      ARRIVE,
      320
    )
  ])

/** What C4 installed: bike 21 min (5.3 km) to Franklin for the 12:21 18. */
const bikeAnswer = () =>
  itinerary([
    street(
      'BICYCLE',
      RIDER,
      'Current location',
      STOP_FRANKLIN,
      'Nicollet Ave S & Franklin Ave W',
      RUN_1221 - 1_299_000,
      RUN_1221,
      5306.58
    ),
    bus18(
      STOP_FRANKLIN,
      'Nicollet Ave S & Franklin Ave W',
      RUN_1221,
      ARRIVE - 60_000
    ),
    street(
      'BICYCLE',
      ALIGHT,
      'Nicollet Mall & 8th St',
      DEST,
      'Destination',
      ARRIVE - 60_000,
      ARRIVE,
      320
    )
  ])

/** OTP as it answered: a search that allows bike comes back with the bike
 * variant of the 18 (the C4 answer); one that does not, with the walk one. */
const otp = (combo: any) => () =>
  Promise.resolve({
    error: false,
    itineraries: [asksForBike(combo) ? bikeAnswer() : walkAnswer()]
  })

const fixAt = ([lat, lon]: [number, number]) => ({
  coords: {
    accuracy: 8,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    latitude: lat,
    longitude: lon,
    speed: null
  },
  timestamp: NOW
})

const makeStore = (activeItinerary: any, overrides: any = {}) => {
  let goModeState: any = {
    ...initial,
    activeItinerary,
    isActive: true,
    tracking: { ...initial.tracking, lastPosition: fixAt(RIDER) },
    ...overrides
  }
  const actions: any[] = []
  const trips: Record<string, any> = {}
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
  return {
    actions,
    activeItinerary: () => goModeState.activeItinerary,
    dispatch,
    trips
  }
}

describe('75.15: an automatic re-plan keeps the trip’s mode', () => {
  let clock: FakeTimers.InstalledClock | undefined
  let store: ReturnType<typeof makeStore> | undefined

  beforeEach(() => {
    mockedFetch.mockReset()
    mockedFindTrip.mockReset()
    // beginGoMode's live-times refresh reads each transit leg's trip.
    mockedFindTrip.mockImplementation(() => () => Promise.resolve(null))
    clock = FakeTimers.install({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    store?.dispatch(endGoMode())
    store = undefined
    clock?.uninstall()
    clock = undefined
  })

  describe('the missed-bus auto-update (C4)', () => {
    const missedBus = (s: ReturnType<typeof makeStore>, autoApply = true) =>
      s.dispatch(
        reRouteFromCurrentPosition({
          autoApply,
          keepRouteId: '1:18',
          reason: 'missed-bus'
        })
      )

    it('asks for a walk + transit trip without BICYCLE', async () => {
      // FAILS BEFORE: modes [TRANSIT, BICYCLE], the search's set.
      mockedFetch.mockImplementation(otp)
      store = makeStore(heldWalkTrip())
      await missedBus(store)
      const combo = mockedFetch.mock.calls[0][0]
      expect(modeNames(combo.modes)).toEqual(['TRANSIT'])
    })

    it('installs the next 18 from 46th St on foot, not a 5.3 km bike to Franklin', async () => {
      // FAILS BEFORE: BICYCLE 5306.58 m → 18 at Franklin 12:21, the C4 swap.
      mockedFetch.mockImplementation(otp)
      store = makeStore(heldWalkTrip())
      await missedBus(store)
      const installed = store.activeItinerary()
      expect(installed.legs.map((l: any) => l.mode)).toEqual([
        'WALK',
        'BUS',
        'WALK'
      ])
      expect(installed.legs[1].from.name).toBe('Nicollet Ave S & 46th St E')
      expect(installed.legs[1].startTime).toBe(RUN_1207)
      const verdict = store.actions.find((a) => a.type === 'AUTO_REPLAN')
      expect(verdict.payload).toMatchObject({
        accepted: true,
        reason: 'missed-bus'
      })
    })

    it('a trip that already bikes keeps bike in the set', async () => {
      mockedFetch.mockImplementation(otp)
      store = makeStore(bikeAnswer())
      await missedBus(store)
      expect(asksForBike(mockedFetch.mock.calls[0][0])).toBe(true)
    })

    it('an ambiguous miss (listed for the rider, not applied) still asks the full set', async () => {
      mockedFetch.mockImplementation(otp)
      store = makeStore(heldWalkTrip())
      await missedBus(store, false)
      expect(asksForBike(mockedFetch.mock.calls[0][0])).toBe(true)
      // ...and nothing was installed behind the rider's back.
      expect(store.actions.map((a) => a.type)).not.toContain('START_GO_MODE')
    })
  })

  describe('the quiet re-plan’s full-trip fallback', () => {
    // A rider on the closing WALK leg, drifted off it: no boarding ahead, so
    // the full-trip plan is the only question and its picker takes the
    // FASTEST access-only answer — a bike, if the search allows one.
    const walkHome = () =>
      itinerary([
        street(
          'WALK',
          RIDER,
          'Nicollet Mall & 8th St',
          DEST,
          'Destination',
          NOW,
          NOW + 900_000,
          1100
        )
      ])

    it('asks without BICYCLE and keeps the rider on foot', async () => {
      // FAILS BEFORE: asks [TRANSIT, BICYCLE] and installs the 4-min bike.
      mockedFetch.mockImplementation((combo: any) => () => {
        const walk = itinerary([
          street(
            'WALK',
            RIDER,
            'Current location',
            DEST,
            'Destination',
            NOW,
            NOW + 840_000,
            1050
          )
        ])
        const bike = itinerary([
          street(
            'BICYCLE',
            RIDER,
            'Current location',
            DEST,
            'Destination',
            NOW,
            NOW + 240_000,
            1050
          )
        ])
        return Promise.resolve({
          error: false,
          itineraries: asksForBike(combo) ? [bike, walk] : [walk]
        })
      })
      store = makeStore(walkHome(), {
        routeMatch: { legIndex: 0, progressAlongLeg: 0.1 }
      })
      await store.dispatch(quietReplanAccessLeg())
      expect(store.activeItinerary().legs.map((l: any) => l.mode)).toEqual([
        'WALK'
      ])
      expect(asksForBike(mockedFetch.mock.calls[0][0])).toBe(false)
    })
  })
})

/**
 * The boarded-earlier swap (replanFromAboard autoApply) on the 2026-10-15
 * 53.1 slice: its candidate plans from the stops ahead are the same automatic
 * question, so they keep the held plan's modes too.
 */
describe('75.15: the boarded-earlier swap asks with the held plan’s modes', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fx: any = require('../../../lib/util/go-mode/replay/fixtures/ride-1015-1747-boarded-earlier.json')
  const REPLAN_MS = 1792105282113 // START_REROUTE boarded-earlier 18:01:22.113
  const lastFix = fx.gpsTrack[fx.gpsTrack.length - 1]
  const clone = (x: any) => JSON.parse(JSON.stringify(x))
  let clock: FakeTimers.InstalledClock | undefined

  beforeEach(() => {
    mockedFetch.mockReset()
    mockedFindTrip.mockReset()
    mockedFetch.mockImplementation(
      () => () => Promise.resolve({ error: true, itineraries: [] })
    )
    clock = FakeTimers.install({ now: REPLAN_MS, toFake: ['Date'] })
  })
  afterEach(() => {
    clock?.uninstall()
    clock = undefined
  })

  const askedModes = async (held: any) => {
    const s = makeStore(held, {
      riding: clone(fx.riding),
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
    })
    mockedFindTrip.mockImplementation(({ tripId }: any) => () => {
      s.trips[tripId] = { ...clone(fx.trip), id: tripId }
      return Promise.resolve(s.trips[tripId])
    })
    await s.dispatch(
      replanFromAboard({ autoApply: true, reason: 'boarded-earlier' })
    )
    return mockedFetch.mock.calls.map((c) => modeNames(c[0].modes))
  }

  it('a plan that bikes (the ride) still asks with BICYCLE', async () => {
    const asked = await askedModes(clone(fx.itinerary))
    expect(asked.length).toBeGreaterThan(0)
    asked.forEach((modes) => expect(modes).toContain('BICYCLE'))
  })

  it('the same plan on foot asks every stop without BICYCLE', async () => {
    // FAILS BEFORE: every candidate asked [TRANSIT, BICYCLE].
    const onFoot = clone(fx.itinerary)
    onFoot.legs.forEach((l: any) => {
      if (l.mode === 'BICYCLE') l.mode = 'WALK'
    })
    const asked = await askedModes(onFoot)
    expect(asked.length).toBeGreaterThan(0)
    asked.forEach((modes) => expect(modes).toEqual(['TRANSIT']))
  })
})

describe('inheritItineraryModes', () => {
  const search = [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }]
  const legs = (...modes: string[]) => ({
    legs: modes.map((mode) => ({ mode }))
  })

  it('drops a vehicle mode the trip does not use', () => {
    expect(
      inheritItineraryModes(search, legs('WALK', 'BUS', 'WALK') as any)
    ).toEqual([{ mode: 'TRANSIT' }])
  })

  it('keeps it, qualifiers too, when the trip uses it', () => {
    const withRent = [...search, { mode: 'BICYCLE', qualifier: 'RENT' }]
    expect(
      inheritItineraryModes(withRent, legs('BICYCLE', 'BUS', 'WALK') as any)
    ).toBe(withRent)
  })

  it('never widens the search, and never returns nothing', () => {
    expect(
      inheritItineraryModes(
        [{ mode: 'TRANSIT' }],
        legs('BICYCLE', 'BUS') as any
      )
    ).toEqual([{ mode: 'TRANSIT' }])
    expect(
      inheritItineraryModes([{ mode: 'BICYCLE' }], legs('WALK') as any)
    ).toEqual([{ mode: 'WALK' }])
  })

  it('leaves the modes alone with no itinerary to read', () => {
    expect(inheritItineraryModes(search, null)).toBe(search)
    expect(inheritItineraryModes(search, { legs: [] } as any)).toBe(search)
  })
})
