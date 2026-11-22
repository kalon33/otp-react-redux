/* globals describe, expect, it */
import {
  exploreBoardEpochMs,
  exploreReplanAccess,
  exploreReplanRecord,
  exploreReplanRequest,
  exploreShortOnTime,
  goModeExploreMode,
  isExploreAccessLeg,
  legExploreShortfall,
  tripStartExploreMode,
  withExploreShortfall
} from '../../../lib/util/go-mode/explore-replan'
import goMode from '../../../lib/reducers/go-mode'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fx = require('../../test-utils/mock-data/bike-explore-gomode-46th.json')

/** BACKLOG 76.3 — the pure half of Go Mode's engine-first access re-plan. */
const NOW = 1_795_000_000_000
const STATION = {
  lat: 44.919409,
  lon: -93.274746,
  name: 'I-35W & 46th St Station',
  stopId: '1:56041'
}
const bike = (extra: any = {}) => ({
  mode: 'BICYCLE',
  transitLeg: false,
  ...extra
})
const bus = (extra: any = {}) => ({
  from: STATION,
  mode: 'BUS',
  startTime: NOW + 1_500_000,
  transitLeg: true,
  ...extra
})

describe('76.3 explore-replan', () => {
  describe('the trip’s mode', () => {
    it('is the mode of the ride the trip starts with, else Direct', () => {
      expect(
        tripStartExploreMode({
          legs: [bike({ exploreRide: { mode: 'wander' } }), bus()]
        } as any)
      ).toBe('wander')
      expect(tripStartExploreMode({ legs: [bike(), bus()] } as any)).toBe(
        'direct'
      )
      expect(tripStartExploreMode(null)).toBe('direct')
      expect(goModeExploreMode({ exploreMode: 'calm' })).toBe('calm')
      expect(goModeExploreMode({})).toBe('direct')
      expect(goModeExploreMode({ exploreMode: 'sideways' })).toBe('direct')
    })

    it('is set when a trip starts, kept across a swap, reset by a new trip', () => {
      const calmTrip = {
        legs: [bike({ exploreRide: { mode: 'calm' } }), bus()]
      }
      const otpTrip = { legs: [bike(), bus()] }
      const start = (state: any, itinerary: any, newTrip?: boolean) =>
        goMode(state, {
          payload: { itinerary, newTrip, nowMs: NOW },
          type: 'START_GO_MODE'
        })
      let state = goMode(undefined, { type: '@@INIT' })
      expect(state.exploreMode).toBe('direct')
      state = start(state, calmTrip)
      expect(state.exploreMode).toBe('calm')
      // OTP had to answer one re-plan: the trip stays Calm.
      state = start(state, otpTrip)
      expect(state.exploreMode).toBe('calm')
      // The rider's switch.
      state = goMode(state, {
        payload: 'wander',
        type: 'SET_GO_MODE_EXPLORE_MODE'
      })
      expect(state.exploreMode).toBe('wander')
      // Start Trip on another route: that trip's own mode.
      state = start(state, otpTrip, true)
      expect(state.exploreMode).toBe('direct')
    })
  })

  describe('isExploreAccessLeg', () => {
    it('is the rider’s own bike straight into a bus', () => {
      expect(isExploreAccessLeg([bike(), bus()] as any, 0, 1)).toBe(true)
      // bus → bike → bus: a transfer ride is one too.
      expect(isExploreAccessLeg([bus(), bike(), bus()] as any, 1, 2)).toBe(true)
    })

    it('is not a rented bike, a walk, a bike parked before a walk, or no bus', () => {
      expect(
        isExploreAccessLeg([bike({ rentedBike: true }), bus()] as any, 0, 1)
      ).toBe(false)
      expect(isExploreAccessLeg([{ mode: 'WALK' }, bus()] as any, 0, 1)).toBe(
        false
      )
      expect(
        isExploreAccessLeg([bike(), { mode: 'WALK' }, bus()] as any, 0, 2)
      ).toBe(false)
      expect(isExploreAccessLeg([bike()] as any, 0, -1)).toBe(false)
    })
  })

  describe('exploreBoardEpochMs', () => {
    it('trusts a live, non-floor prediction, else the plan', () => {
      const leg = bus() as any
      expect(
        exploreBoardEpochMs(leg, {
          boardEpoch: NOW + 1_560_000,
          boardRealtime: true
        })
      ).toBe(NOW + 1_560_000)
      expect(
        exploreBoardEpochMs(leg, {
          boardEpoch: NOW - 60_000,
          boardIsFloor: true,
          boardRealtime: true
        })
      ).toBe(NOW + 1_500_000)
      expect(
        exploreBoardEpochMs(leg, {
          boardEpoch: NOW + 1_560_000,
          boardRealtime: false
        })
      ).toBe(NOW + 1_500_000)
      expect(exploreBoardEpochMs(leg, null)).toBe(NOW + 1_500_000)
    })
  })

  describe('exploreReplanRequest', () => {
    const ask = {
      boardEpochMs: NOW + 1_500_000,
      boardPlace: STATION,
      mode: 'calm' as const,
      nowMs: NOW,
      origin: { lat: 44.9145, lon: -93.299 },
      speed: 5
    }

    it('asks one candidate: the stop, seconds to the bus, the speed', () => {
      expect(exploreReplanRequest(ask)).toEqual({
        candidates: [
          {
            depart_s: 1500,
            id: '1:56041',
            lat: 44.919409,
            lon: -93.274746,
            name: 'I-35W & 46th St Station'
          }
        ],
        lat: 44.9145,
        lon: -93.299,
        mode: 'calm',
        speed: 5
      })
    })

    it('leaves the speed to the engine when nothing names one', () => {
      expect(exploreReplanRequest({ ...ask, speed: null })).not.toHaveProperty(
        'speed'
      )
    })

    it('asks nothing in Direct, with no board time, or for a bus already gone', () => {
      expect(exploreReplanRequest({ ...ask, mode: 'direct' })).toBeNull()
      expect(exploreReplanRequest({ ...ask, boardEpochMs: null })).toBeNull()
      expect(exploreReplanRequest({ ...ask, boardEpochMs: NOW })).toBeNull()
    })
  })

  describe('exploreReplanAccess', () => {
    const base = {
      boardPlace: STATION,
      from: { lat: 44.9145, lon: -93.299, name: 'Current location' },
      mode: 'calm' as const,
      startMs: NOW,
      stopId: '1:56041'
    }

    it('turns the real Calm answer into one BICYCLE leg starting now', () => {
      const answer = exploreReplanAccess({ ...base, response: fx.calm })
      expect(answer.miss).toBeNull()
      const leg: any = answer.itinerary?.legs[0]
      expect(leg.mode).toBe('BICYCLE')
      expect(leg.startTime).toBe(NOW)
      expect(leg.endTime).toBe(NOW + 549_000)
      expect(leg.to).toBe(STATION)
      expect(leg.exploreRide).toMatchObject({
        marginS: 235,
        mode: 'calm',
        preference: 1,
        stopId: '1:56041'
      })
    })

    it('names why there is nothing for the gate', () => {
      expect(exploreReplanAccess({ ...base, response: null }).miss).toBe(
        'no-answer'
      )
      expect(
        exploreReplanAccess({
          ...base,
          response: { candidates: [], mode: 'calm', status: 'ok' }
        }).miss
      ).toBe('no-candidate')
      const infeasible = {
        ...fx.calm,
        candidates: [
          {
            ...fx.calm.candidates[0],
            feasible: false,
            reason: 'cannot reach the stop in time with the margin'
          }
        ]
      }
      expect(exploreReplanAccess({ ...base, response: infeasible }).miss).toBe(
        'infeasible'
      )
      // "already at the stop": feasible, no leg.
      const atStop = {
        ...fx.calm,
        candidates: [
          {
            distance_m: 0,
            duration_s: 0,
            feasible: true,
            id: '1:56041',
            reason: 'already at the stop'
          }
        ]
      }
      expect(exploreReplanAccess({ ...base, response: atStop }).miss).toBe(
        'no-leg'
      )
    })
  })

  describe('exploreShortOnTime', () => {
    it('takes the engine at its word when it says which limit bit', () => {
      const asked = {
        departS: 900,
        directDurationS: 543,
        mode: 'calm' as const,
        preference: 0.6
      }
      expect(exploreShortOnTime({ ...asked, timeLimited: false })).toBe(false)
      expect(
        exploreShortOnTime({ ...asked, departS: 5000, timeLimited: true })
      ).toBe(true)
      expect(
        exploreShortOnTime({ ...asked, preference: 1, timeLimited: true })
      ).toBe(false)
    })

    // Calm, a 543 s fastest ride: the mode allows up to 543 + 168.6 s.
    const calm = { directDurationS: 543, mode: 'calm' as const }

    it('is the bus cutting the ride short, not the mode’s own cap', () => {
      // 1500 s to the bus: the limit is 1200 s, past the mode's cap.
      expect(
        exploreShortOnTime({ ...calm, departS: 1500, preference: 0.6 })
      ).toBe(false)
      // 900 s: the limit is 654.5 s, inside the mode's 711.6 s.
      expect(
        exploreShortOnTime({ ...calm, departS: 900, preference: 0.6 })
      ).toBe(true)
      expect(exploreShortOnTime({ ...calm, departS: 900, preference: 1 })).toBe(
        false
      )
      expect(
        exploreShortOnTime({
          departS: 900,
          directDurationS: 543,
          mode: 'direct',
          preference: 0
        })
      ).toBe(false)
    })

    it('Wander’s wider cap makes the bus bind sooner', () => {
      // 543 s fastest: Wander allows up to 1108.8 s, Calm 711.6 s. With
      // 1300 s to the bus the limit is 1018 s: Calm's ride fits, Wander's
      // does not.
      expect(
        exploreShortOnTime({
          departS: 1300,
          directDurationS: 543,
          mode: 'calm',
          preference: 0.3
        })
      ).toBe(false)
      expect(
        exploreShortOnTime({
          departS: 1300,
          directDurationS: 543,
          mode: 'wander',
          preference: 0.3
        })
      ).toBe(true)
    })
  })

  describe('the shortfall on the leg', () => {
    const access: any = { legs: [{ mode: 'BICYCLE' }] }

    it('is marked only when time cut the ride, partial or all the way', () => {
      expect(withExploreShortfall(access, false, 0.3)).toBe(access)
      expect(
        legExploreShortfall(withExploreShortfall(access, true, 0.3).legs[0])
      ).toBe('partial')
      expect(
        legExploreShortfall(withExploreShortfall(access, true, 0).legs[0])
      ).toBe('fastest')
      expect(access.legs[0]).toEqual({ mode: 'BICYCLE' })
      expect(legExploreShortfall({ mode: 'BICYCLE' } as any)).toBeNull()
    })
  })

  describe('exploreReplanRecord', () => {
    it('is scalars only: no coordinates, no place names', () => {
      const answer = exploreReplanAccess({
        boardPlace: STATION,
        from: { lat: 44.9145, lon: -93.299 },
        mode: 'wander',
        response: fx.wander,
        startMs: NOW,
        stopId: '1:56041'
      })
      const record = exploreReplanRecord({
        answer,
        departS: 1500,
        elapsedMs: 129,
        mode: 'wander',
        outcome: 'applied',
        riderAsked: false,
        speed: 5,
        tMs: NOW
      })
      expect(record).toMatchObject({
        durationS: 1080,
        feasible: true,
        marginS: 288,
        mode: 'wander',
        outcome: 'applied',
        preference: 1
      })
      const json = JSON.stringify(record)
      expect(json).not.toMatch(/44\.9|93\.2|Minnehaha|Station/)
      Object.values(record).forEach((v) =>
        expect(['number', 'string', 'boolean']).toContain(
          v === null ? 'number' : typeof v
        )
      )
    })
  })
})
