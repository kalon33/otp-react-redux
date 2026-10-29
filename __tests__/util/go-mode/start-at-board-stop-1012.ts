import fs from 'fs'
import path from 'path'

import FakeTimers from '@sinonjs/fake-timers'

import { beginGoMode, endGoMode } from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import {
  firstBoardStopMeasure,
  originGapMeters,
  riderAtFirstBoardStop,
  START_AT_BOARD_STOP_PAST_MS,
  startOriginIsStale
} from '../../../lib/util/go-mode/replan-acceptance'
import { shouldReplanBoardedEarlier } from '../../../lib/util/go-mode/transit-trust'
import goMode from '../../../lib/reducers/go-mode'

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
 * 2026-10-12 16:17:15, session `mv5q7id5-who0wz` — backlog 47.2.
 *
 * The rider started Go Mode on the I-35W & 98th St Station platform with the
 * Orange Line bus 8143 at the door. The installed plan still began with the
 * 15:50 search's 2,141 m bike leg, so the stale-start check (12.13) re-planned:
 * the replacement dropped the plan's own trip 1:1364433 (the bus at the
 * platform) for 1:1366748 fourteen minutes later and pushed "Trip updated · in
 * 14 min". Boarding 8143 then fired boarded-earlier and pushed a second,
 * contradicting "Trip updated". A rider at the plan's first board stop in time
 * for its bus is not on a stale plan.
 *
 * Replayed from lib/util/go-mode/replay/fixtures/who0wz-1617-detour.json: its
 * `itinerary` is the START_GO_MODE plan, `gpsTrack[0]` the fix at the tap, and
 * `itinerarySwaps[0]` the replacement OTP actually answered at 16:17:16.
 */
const FIXTURE = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/who0wz-1617-detour.json'
)
const fixture: any = fs.existsSync(FIXTURE)
  ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  : null
const withFixture = fixture ? describe : describe.skip

const initial = goMode(undefined, { type: '@@INIT' })
const mockedFetch = fetchOnboardCandidatePlan as jest.Mock

/** 16:17:27.281, the boarded-earlier TRIP_UPDATED's own timestamp. */
const CONFIRM_AT = 1_791_839_847_281

const clone = (x: any) => JSON.parse(JSON.stringify(x))

withFixture('util > go-mode > starting at the board stop (47.2)', () => {
  const plan = () => clone(fixture.itinerary)
  const replacement = () => clone(fixture.itinerarySwaps[0].itinerary)
  const g0 = () => fixture.gpsTrack[0]
  const position = (): [number, number] => [g0().lat, g0().lon]
  const NOW = (): number => g0().tMs

  /** The fixture plan with its bus leg moved to `boardMs`. */
  const planBoardingAt = (boardMs: number) => {
    const it = plan()
    const bus = it.legs[1]
    const shift = boardMs - bus.startTime
    bus.startTime += shift
    bus.endTime += shift
    it.legs[0].endTime = bus.startTime
    return it
  }

  describe('the measurement at gpsTrack[0] (16:17:15.260)', () => {
    it('is the fixture this row was written from', () => {
      expect(g0().tMs).toBe(1_791_839_835_260)
      expect(plan().legs[1].trip.gtfsId).toBe('1:1364433')
      expect(replacement().legs[1].trip.gtfsId).toBe('1:1366748')
    })

    it("today's check calls the plan stale — it would re-plan", () => {
      const gap = originGapMeters(plan(), position()) as number
      // The 15:50 search's origin: 1,831 m behind the platform as the crow
      // flies (the bike leg itself is 2,141 m).
      expect(gap).toBeGreaterThan(1800)
      expect(gap).toBeLessThan(1860)
      expect(
        startOriginIsStale({
          accuracyM: g0().accuracy,
          itinerary: plan(),
          position: position(),
          riding: false
        })
      ).toBe(true)
    })

    it('puts the rider 63 m from the board stop, its bus 274 s out', () => {
      const m = firstBoardStopMeasure({
        itinerary: plan(),
        position: position()
      }) as any
      expect(m.legIndex).toBe(1)
      expect(m.distanceM).toBeGreaterThan(60)
      expect(m.distanceM).toBeLessThan(66)
      // leg.startTime 16:21:49 (departureDelay 409 s on the 16:15:00 run).
      expect(Math.round((m.boardMs - NOW()) / 1000)).toBe(274)
      expect(
        riderAtFirstBoardStop({
          accuracyM: g0().accuracy,
          itinerary: plan(),
          nowMs: NOW(),
          position: position()
        })
      ).toBe(true)
    })

    it('takes the later of the leg and a live board time', () => {
      // A live epoch later than the leg keeps the rider in time.
      const it = planBoardingAt(NOW() - 300_000)
      expect(
        riderAtFirstBoardStop({
          itinerary: it,
          liveLegTimes: {
            1: { alightEpoch: null, boardEpoch: NOW() + 30_000 } as any
          },
          nowMs: NOW(),
          position: position()
        })
      ).toBe(true)
      expect(
        riderAtFirstBoardStop({
          itinerary: it,
          nowMs: NOW(),
          position: position()
        })
      ).toBe(false)
    })

    it('holds up to two minutes past the board time, not beyond', () => {
      const at = (boardMs: number) =>
        riderAtFirstBoardStop({
          itinerary: planBoardingAt(boardMs),
          nowMs: NOW(),
          position: position()
        })
      expect(at(NOW() - START_AT_BOARD_STOP_PAST_MS)).toBe(true)
      expect(at(NOW() - START_AT_BOARD_STOP_PAST_MS - 1000)).toBe(false)
    })

    it('needs the rider at the stop: 200 m off is not, unless the fix is that poor', () => {
      const away: [number, number] = [44.825493 + 200 / 111_320, position()[1]]
      const args = { itinerary: plan(), nowMs: NOW(), position: away }
      expect(riderAtFirstBoardStop({ ...args, accuracyM: 14 })).toBe(false)
      expect(riderAtFirstBoardStop({ ...args, accuracyM: 120 })).toBe(true)
    })

    it('has nothing to say about a plan with no access leg before transit', () => {
      const aboard = clone(fixture.itinerarySwaps[1].itinerary)
      expect(aboard.legs[0].transitLeg).toBe(true)
      expect(
        riderAtFirstBoardStop({
          itinerary: aboard,
          nowMs: NOW(),
          position: position()
        })
      ).toBe(false)
      // ...nor about a bike-only plan (12.13's shape).
      const bikeOnly = { ...plan(), legs: [plan().legs[0]] }
      expect(
        riderAtFirstBoardStop({
          itinerary: bikeOnly,
          nowMs: NOW(),
          position: position()
        })
      ).toBe(false)
    })
  })

  describe('the start path, through beginGoMode', () => {
    let clock: FakeTimers.InstalledClock | undefined
    let store: ReturnType<typeof makeStore> | undefined

    const makeStore = () => {
      let goModeState: any = {
        ...initial,
        tracking: {
          ...initial.tracking,
          lastPosition: {
            coords: {
              accuracy: g0().accuracy,
              altitude: null,
              altitudeAccuracy: null,
              heading: g0().heading,
              latitude: g0().lat,
              longitude: g0().lon,
              speed: g0().speed
            },
            timestamp: g0().tMs
          }
        }
      }
      const actions: any[] = []
      const getState = () => ({
        otp: {
          config: {
            // 75.37 (J5): getOtpFetchOptions needs config.api (see test-utils/mock-data/store.js).
            api: { host: 'http://mock-otp.invalid', path: '/otp', port: 80 },
            homeTimezone: 'America/Chicago'
          },
          currentQuery: {},
          goMode: goModeState,
          location: { currentPosition: { coords: null } },
          transitIndex: { routes: {}, stops: {} }
        }
      })
      const dispatch: any = (action: any) => {
        if (typeof action === 'function') return action(dispatch, getState)
        actions.push(action)
        goModeState = goMode(goModeState, action)
        return action
      }
      return {
        activeItinerary: () => goModeState.activeItinerary,
        recoveries: () =>
          actions.filter(
            (a) =>
              a.type === 'START_REROUTE' &&
              a.payload?.reason === 'stale-plan-origin'
          ),
        run: (thunk: any) => thunk(dispatch, getState),
        tripUpdated: () =>
          actions.filter((a) =>
            JSON.stringify(a.payload ?? '').includes('TRIP_UPDATED')
          ),
        types: () => actions.map((a) => a.type)
      }
    }

    beforeEach(() => {
      mockedFetch.mockReset()
      // Serve what OTP actually answered at 16:17:16: trip 1:1366748, 14 min
      // out. Only today's path ever asks for it.
      mockedFetch.mockReturnValue(() =>
        Promise.resolve({ error: false, itineraries: [replacement()] })
      )
      clock = FakeTimers.install({ now: NOW(), toFake: ['Date'] })
    })
    afterEach(() => {
      store?.run(endGoMode())
      store = undefined
      clock?.uninstall()
      clock = undefined
    })

    it('keeps the plan and its bus: no re-plan, no fetch, no Trip updated', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
      store = makeStore()
      await store.run(beginGoMode(plan()))
      const lines = log.mock.calls.map((c) => String(c[0]))
      log.mockRestore()
      expect(store.types()).toContain('START_GO_MODE')
      expect(store.recoveries()).toHaveLength(0)
      expect(store.types()).not.toContain('START_REROUTE')
      expect(mockedFetch).not.toHaveBeenCalled()
      expect(store.tripUpdated()).toHaveLength(0)
      expect(store.activeItinerary().legs[1].trip.gtfsId).toBe('1:1364433')
      expect(
        lines.filter((l) => l.includes('keeping the plan (47.2)'))
      ).toEqual([
        '[go-mode] plan origin stale but rider 63m from the first board stop, board in 274s — keeping the plan (47.2)'
      ])
    })

    it('negative control: its bus left over two minutes ago → today’s recovery', async () => {
      // 12.13 unchanged: a board time well past means the run is gone.
      store = makeStore()
      await store.run(
        beginGoMode(
          planBoardingAt(NOW() - START_AT_BOARD_STOP_PAST_MS - 60_000)
        )
      )
      expect(store.recoveries()).toHaveLength(1)
      expect(mockedFetch).toHaveBeenCalled()
      expect(mockedFetch.mock.calls[0][0].from.lat).toBeCloseTo(g0().lat, 5)
      expect(store.activeItinerary().legs[1].trip.gtfsId).toBe('1:1366748')
      expect(store.tripUpdated().length).toBeGreaterThan(0)
    })
  })

  describe('boarding the bus at the platform (CONFIRM_VEHICLE 16:17:27)', () => {
    const confirmed = (tripId: string) => ({
      match: {
        confidence: 'confirmed',
        distanceMeters: 62,
        label: '8143',
        lastSeen: CONFIRM_AT,
        tripHeadsign: 'ORANGE Downtown Minneapolis',
        tripId,
        vehicleId: '1:8143'
      }
    })

    it('on the kept plan, 8143 is the planned trip — no boarded-earlier', () => {
      const it = plan()
      expect(
        shouldReplanBoardedEarlier({
          nowMs: CONFIRM_AT,
          plannedTripIds: it.legs.map((l: any) => l.trip?.gtfsId),
          ridingLeg: it.legs[1],
          ridingTripId: '1:1364433',
          vehicleMatchState: confirmed('1:1364433') as any,
          vehicleRecord: null
        })
      ).toBe(false)
    })

    it('on the 16:17:16 replacement it fired — the second push', () => {
      const it = replacement()
      expect(
        shouldReplanBoardedEarlier({
          nowMs: CONFIRM_AT,
          plannedTripIds: it.legs.map((l: any) => l.trip?.gtfsId),
          ridingLeg: it.legs[1],
          ridingTripId: '1:1364433',
          vehicleMatchState: confirmed('1:1364433') as any,
          vehicleRecord: null
        })
      ).toBe(true)
    })
  })
})
