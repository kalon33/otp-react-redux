import '../../test-utils/mock-window-url'

import {
  BOARD_STOP_DWELL_MIN_MS,
  decideRiding,
  EARLY_ALIGHT_MIN_MS,
  EARLY_ALIGHT_MIN_TICKS,
  EARLY_ALIGHT_RIDER_MAX_SPEED_MPS,
  EARLY_ALIGHT_VEHICLE_GAIN_M,
  legStopsInOrder,
  riderStopOnLeg,
  trackEarlyAlight,
  vehiclePassedRiderStop
} from '../../../lib/util/go-mode/riding'
import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'
import goMode from '../../../lib/reducers/go-mode'

/**
 * Backlog 8.11 — getting off the bus early, at a stop that is still on the
 * route.
 *
 * The rider, 2026-08-27: *"Ok so I got off early for a transfer. It did not
 * detect that I had gotten off the bus. This is likely ok since I was on the
 * route. Only problem is I was not receiving notifications then to board the
 * next bus."*
 *
 * Before this file, the ONLY exit from `riding` was `offRouteSince` running
 * past 90 s — and a rider standing on the platform they alighted at never goes
 * off route, so the fact was held for the rest of the leg. A held fact silences
 * `checkBoardVehicleApproach` (skipped while `goMode.riding` is set) and
 * `classifyMissedBus` (`if (riding) return null`), which is exactly the silence
 * the rider described.
 *
 * NOTE ON EVIDENCE: no recorded fixture contains an early alight. Every tick
 * sequence below is SYNTHETIC — built to the geometry of a Metro Transit local
 * with stops ~400 m apart — so these cases pin the RULE, not a replayed ride.
 * The first real early alight to be recorded should be turned into a fixture
 * and this file re-checked against it.
 */

const NOW = 1788000000000

// A five-stop local: board, three intermediates, alight. Stop spacing ~400 m
// along a straight westward run, which is a normal Minneapolis local.
const stopAt = (i: number, over: any = {}) => ({
  lat: 44.95,
  lon: -93.25 - i * 0.005,
  name: `Stop ${i}`,
  stop: { gtfsId: `1:100${i}` },
  ...over
})

const ridingLeg = (over: any = {}) => ({
  from: stopAt(0),
  headsign: 'Downtown',
  intermediatePlaces: [stopAt(1), stopAt(2), stopAt(3)],
  mode: 'BUS',
  routeId: '1:18',
  routeShortName: '18',
  to: stopAt(4),
  transitLeg: true,
  trip: { gtfsId: '1:trip-a' },
  ...over
})

// The rider stepped off at stop 2 — an on-route intermediate, two stops short
// of the alight stop they planned.
const RIDER = [stopAt(2).lat, stopAt(2).lon] as [number, number]

const ridingFact = (over: any = {}) => ({
  boardedAt: NOW - 600000,
  headsign: 'Downtown',
  legIndex: 1,
  offRouteSince: null,
  routeId: '1:18',
  routeShortName: '18',
  tripId: '1:trip-a',
  vehicleId: '1:8140',
  ...over
})

const onLeg = (over: any = {}) => ({
  distanceFromRoute: 8,
  isOnRoute: true,
  legIndex: 1,
  nearestPoint: RIDER,
  progressAlongLeg: 0.5,
  progressAlongSegment: 0,
  segmentIndex: 3,
  ...over
})

const atStop2 = () =>
  riderStopOnLeg(ridingLeg(), RIDER[0], RIDER[1], calculateDistance)

/**
 * Run a tick sequence through the watch and hand back the final watch plus the
 * decision the last tick would produce. `ticks` are (dtSeconds, sample-overs).
 */
function run(
  ticks: Array<[number, any]>,
  opts: { leg?: any; prevRiding?: any } = {}
) {
  const leg = opts.leg ?? ridingLeg()
  const prevRiding = opts.prevRiding ?? ridingFact()
  let watch: any = null
  let t = NOW
  let decision: any = { kind: 'none' }
  for (const [dt, over] of ticks) {
    t += dt * 1000
    const rider = over.rider ?? RIDER
    const atStop =
      over.atStop !== undefined
        ? over.atStop
        : riderStopOnLeg(leg, rider[0], rider[1], calculateDistance)
    watch = trackEarlyAlight(watch, {
      atStop,
      legIndex: 1,
      nowMs: t,
      riderSpeedMps: 'riderSpeedMps' in over ? over.riderSpeedMps : 0.2,
      vehicleAgeMs: over.vehicleAgeMs ?? 4000,
      vehicleDistanceM: over.vehicleDistanceM ?? 20,
      vehicleId: over.vehicleId ?? '1:8140',
      vehiclePassedStop:
        over.vehiclePassedStop ??
        vehiclePassedRiderStop(leg, over.nextStopId, atStop?.index ?? null)
    })
    decision = decideRiding({
      boardStopDwellMs: BOARD_STOP_DWELL_MIN_MS,
      earlyAlight: watch,
      fixAccuracyM: 12,
      matchedLeg: leg,
      nowMs: t,
      offRouteClearMs: 90000,
      prevRiding,
      riderSpeedMps: 'riderSpeedMps' in over ? over.riderSpeedMps : 0.2,
      routeMatch: onLeg(over.routeMatch),
      vehicleMatch: {
        consecutiveMatches: 4,
        match: {
          confidence: 'confirmed',
          distanceMeters: over.vehicleDistanceM ?? 20,
          label: '8140',
          lastSeen: t - (over.vehicleAgeMs ?? 4000),
          nextStopId: over.nextStopId ?? null,
          routeId: '1:18',
          tripId: '1:trip-a',
          vehicleId: over.vehicleId ?? '1:8140'
        }
      }
    })
  }
  return { decision, watch }
}

/** Ten seconds apart, the bus pulling away at ~12 m/s from a standing rider. */
const departingTicks = (count: number, from = 20) =>
  Array.from({ length: count }, (_, i) => [
    10,
    { riderSpeedMps: 0.3, vehicleDistanceM: from + i * 120 }
  ]) as Array<[number, any]>

describe('util > go-mode > early alight on an on-route stop (8.11)', () => {
  describe('the leg’s own stops', () => {
    it('orders from, intermediates and to', () => {
      const stops = legStopsInOrder(ridingLeg())
      expect(stops.map((s) => s.stopId)).toEqual([
        '1:1000',
        '1:1001',
        '1:1002',
        '1:1003',
        '1:1004'
      ])
    })

    it('places the rider at the intermediate stop they stepped off at', () => {
      const stop = atStop2()
      expect(stop?.index).toBe(2)
      expect(stop?.stopId).toBe('1:1002')
      expect(stop?.distanceM).toBeLessThan(1)
    })

    it('never places them at the ALIGHT stop — a missed alight is a different story', () => {
      const to = stopAt(4)
      expect(
        riderStopOnLeg(ridingLeg(), to.lat, to.lon, calculateDistance)
      ).toBeNull()
    })

    it('places them nowhere when they are between stops', () => {
      expect(
        riderStopOnLeg(ridingLeg(), 44.95, -93.2625, calculateDistance)
      ).toBeNull()
    })

    it('needs TWO stops of advance before nextStopId alone counts', () => {
      // The bus pulling out of the rider's own stop names the next one. That
      // is what riding a bus looks like, at every stop of every leg.
      expect(vehiclePassedRiderStop(ridingLeg(), '1:1003', 2)).toBe(false)
      expect(vehiclePassedRiderStop(ridingLeg(), '1:1004', 2)).toBe(true)
      // Silent on what a feed may not publish.
      expect(vehiclePassedRiderStop(ridingLeg(), null, 2)).toBe(false)
      expect(vehiclePassedRiderStop(ridingLeg(), '1:9999', 2)).toBe(false)
      expect(vehiclePassedRiderStop(ridingLeg(), '1:1004', null)).toBe(false)
    })
  })

  describe('(a) the rider gets off early at an on-route stop', () => {
    it('clears riding once the divergence has been sustained', () => {
      const { decision } = run(departingTicks(10))
      expect(decision.kind).toBe('alightedEarly')
      expect(decision.record).toMatchObject({
        legIndex: 1,
        stopId: '1:1002',
        stopName: 'Stop 2',
        tripId: '1:trip-a',
        vehicleId: '1:8140'
      })
    })

    it('holds the fact for the whole of EARLY_ALIGHT_MIN_MS first', () => {
      // Four 10 s ticks is 30 s of divergence — real, but not yet sustained.
      const { decision, watch } = run(departingTicks(4))
      expect(watch.divergingMs).toBeLessThan(EARLY_ALIGHT_MIN_MS)
      expect(decision.kind).not.toBe('alightedEarly')
    })

    it('is reached by the nextStopId path too, with the bus two stops on', () => {
      const ticks = Array.from({ length: 6 }, () => [
        10,
        // Distance never grows past the bar; the feed's own next stop does the
        // talking. (Stop 4 is two beyond the rider's stop 2.)
        { nextStopId: '1:1004', riderSpeedMps: 0.1, vehicleDistanceM: 60 }
      ]) as Array<[number, any]>
      expect(run(ticks).decision.kind).toBe('alightedEarly')
    })

    it('will not put the rider back on the bus they just left', () => {
      const earlyAlightedFrom = {
        legIndex: 1,
        tripId: '1:trip-a',
        vehicleId: '1:8140'
      }
      const base = {
        boardStopDwellMs: BOARD_STOP_DWELL_MIN_MS,
        earlyAlightedFrom,
        fixAccuracyM: 12,
        matchedLeg: ridingLeg(),
        nowMs: NOW,
        offRouteClearMs: 90000,
        prevRiding: null,
        riderSpeedMps: 0.2,
        routeMatch: onLeg()
      }
      // The confirmed match is the stickiest fact Go Mode holds — without the
      // refusal the very next tick re-establishes the identical ride.
      expect(
        decideRiding({
          ...base,
          vehicleMatch: {
            consecutiveMatches: 6,
            match: {
              confidence: 'confirmed',
              distanceMeters: 900,
              label: '8140',
              lastSeen: NOW,
              nextStopId: '1:1004',
              routeId: '1:18',
              tripId: '1:trip-a',
              vehicleId: '1:8140'
            }
          }
        }).kind
      ).toBe('none')
      // GPS alone on the same shape is likewise refused.
      expect(
        decideRiding({ ...base, vehicleMatch: { match: null } }).kind
      ).toBe('none')
      // A trusted match on a DIFFERENT bus of the route still lands: the rider
      // really can catch the next run from the same platform.
      expect(
        decideRiding({
          ...base,
          vehicleMatch: {
            consecutiveMatches: 6,
            match: {
              confidence: 'confirmed',
              distanceMeters: 15,
              label: '8155',
              lastSeen: NOW,
              nextStopId: '1:1003',
              routeId: '1:18',
              // A different RUN of the same route: its own trip id, and the
              // same headsign, which is what corroborates a first
              // establishment on a trip the plan does not name.
              tripHeadsign: 'Downtown',
              tripId: '1:trip-b',
              vehicleId: '1:8155'
            }
          }
        }).kind
      ).toBe('set')
    })
  })

  describe('(b) a bus dwelling at a stop with the rider aboard', () => {
    // The case this rule is built around, and the one 6.38 had to rewrite the
    // board gate for: Metro Transit publishes STOPPED_AT with the doors open
    // for a full minute. Rider and bus are both stationary and the gap is ~0.
    it('never clears, however long the doors stay open', () => {
      const ticks = Array.from({ length: 30 }, (_, i) => [
        10,
        { riderSpeedMps: 0, vehicleDistanceM: 12 + (i % 3) * 6 }
      ]) as Array<[number, any]>
      const { decision, watch } = run(ticks)
      expect(decision.kind).not.toBe('alightedEarly')
      expect(watch.divergingTicks).toBe(0)
      // 300 s of dwell — three and a third times the old 90 s off-route timer.
      expect(watch.minDistanceM).toBeLessThanOrEqual(18)
    })

    it('never clears while the bus is merely lagging in the feed', () => {
      // A moving bus's record can sit hundreds of metres behind the rider (on
      // orange-line-0729 bus 8140 was 230 m up the freeway on the first record
      // after departure, rider aboard). What it cannot do is that while the
      // rider is parked at a stop: they are moving with it.
      const ticks = Array.from({ length: 12 }, () => [
        10,
        { riderSpeedMps: 11, vehicleDistanceM: 300 }
      ]) as Array<[number, any]>
      expect(run(ticks).decision.kind).not.toBe('alightedEarly')
    })

    it('never clears on a stale vehicle record', () => {
      const ticks = departingTicks(8).map(
        ([dt, over]) => [dt, { ...over, vehicleAgeMs: 200000 }] as [number, any]
      )
      expect(run(ticks).decision.kind).not.toBe('alightedEarly')
    })

    it('will not act on a synthetic vehicle id', () => {
      // `route:<routeId>` ids are minted by the riding lock, are in no feed and
      // carry no position — exactly as much evidence as a null.
      const ticks = departingTicks(8).map(
        ([dt, over]) =>
          [dt, { ...over, vehicleId: 'route:1:18' }] as [number, any]
      )
      expect(run(ticks).watch).toBeNull()
    })
  })

  describe('(c) one wobbling tick', () => {
    it('is worth nothing on its own', () => {
      const { decision, watch } = run([
        [10, { vehicleDistanceM: 15 }],
        [10, { vehicleDistanceM: 18 }],
        // One bad reading: the record jumps a kilometre and comes straight back.
        [10, { vehicleDistanceM: 1200 }],
        [10, { vehicleDistanceM: 21 }]
      ])
      expect(decision.kind).not.toBe('alightedEarly')
      expect(watch.divergingTicks).toBe(0)
    })

    it('resets the streak, so a real divergence has to start over', () => {
      const ticks: Array<[number, any]> = [
        ...departingTicks(4),
        // …then one tick that says they are back together.
        [10, { riderSpeedMps: 0.3, vehicleDistanceM: 15 }],
        ...departingTicks(3, 500)
      ]
      const { decision, watch } = run(ticks)
      expect(watch.divergingTicks).toBeLessThan(EARLY_ALIGHT_MIN_TICKS)
      expect(decision.kind).not.toBe('alightedEarly')
    })

    it('needs consecutive TICKS as well as elapsed time', () => {
      // Two ticks four minutes apart span plenty of wall clock. Per-tick
      // capping (EARLY_ALIGHT_MAX_STEP_MS) and the tick count both refuse it —
      // a backgrounded app's gap is not evidence of watching a bus leave.
      const { decision, watch } = run([
        [240, { riderSpeedMps: 0.1, vehicleDistanceM: 20 }],
        [240, { riderSpeedMps: 0.1, vehicleDistanceM: 3000 }]
      ])
      expect(watch.divergingTicks).toBe(1)
      expect(watch.divergingMs).toBeLessThanOrEqual(10000)
      expect(decision.kind).not.toBe('alightedEarly')
    })

    it('refuses a fix that carries no speed at all', () => {
      const ticks = departingTicks(8).map(
        ([dt, over]) => [dt, { ...over, riderSpeedMps: null }] as [number, any]
      )
      expect(run(ticks).watch).toBeNull()
    })

    it('refuses a rider moving faster than a walk', () => {
      const ticks = departingTicks(8).map(
        ([dt, over]) =>
          [
            dt,
            { ...over, riderSpeedMps: EARLY_ALIGHT_RIDER_MAX_SPEED_MPS + 0.5 }
          ] as [number, any]
      )
      expect(run(ticks).watch).toBeNull()
    })

    it('needs the gap to be wide in absolute terms, not just grown', () => {
      // A baseline that starts negative-adjacent: growth alone would pass at
      // 0 m -> EARLY_ALIGHT_VEHICLE_GAIN_M, and the absolute floor refuses it.
      const ticks = Array.from({ length: 8 }, () => [
        10,
        {
          riderSpeedMps: 0.1,
          vehicleDistanceM: EARLY_ALIGHT_VEHICLE_GAIN_M - 1
        }
      ]) as Array<[number, any]>
      expect(run(ticks).decision.kind).not.toBe('alightedEarly')
    })
  })

  describe('(d) the rider stays aboard past the stop they planned to leave at', () => {
    it('is untouched — a missed alight never reaches this rule', () => {
      // They are at the ALIGHT stop, which riderStopOnLeg excludes by
      // construction, and they are moving with the bus.
      const to = stopAt(4)
      const ticks = Array.from({ length: 12 }, () => [
        10,
        { rider: [to.lat, to.lon], riderSpeedMps: 10, vehicleDistanceM: 40 }
      ]) as Array<[number, any]>
      const { decision, watch } = run(ticks)
      expect(watch).toBeNull()
      expect(decision.kind).not.toBe('alightedEarly')
    })

    it('and neither does a rider sitting through a long red light', () => {
      // Stationary, at a stop, bus stationary with them — the ordinary shape
      // of a bus stuck in traffic beside a stop.
      const ticks = Array.from({ length: 20 }, () => [
        10,
        { riderSpeedMps: 0, vehicleDistanceM: 25 }
      ]) as Array<[number, any]>
      expect(run(ticks).decision.kind).toBe('none')
    })

    it('leaves the ordinary off-route clear exactly as it was', () => {
      const offRoute = (sinceMs: number, atMs: number) =>
        decideRiding({
          boardStopDwellMs: BOARD_STOP_DWELL_MIN_MS,
          fixAccuracyM: 12,
          matchedLeg: ridingLeg(),
          nowMs: atMs,
          offRouteClearMs: 90000,
          prevRiding: ridingFact({ offRouteSince: sinceMs }),
          riderSpeedMps: 0.1,
          routeMatch: onLeg({ isOnRoute: false }),
          vehicleMatch: null
        })
      expect(offRoute(NOW, NOW + 89000).kind).toBe('none')
      expect(offRoute(NOW, NOW + 91000).kind).toBe('clear')
    })
  })

  describe('the store carries the alight', () => {
    it('SET_EARLY_ALIGHT drops riding and records where they got off', () => {
      let state = goMode(undefined, { type: '@@INIT' })
      expect(state.earlyAlight).toBeNull()
      state = goMode(state, { payload: ridingFact(), type: 'SET_RIDING' })
      state = goMode(state, { payload: 1234, type: 'SET_DEPARTURE_OVERRIDE' })
      const record = {
        atMs: NOW,
        legIndex: 1,
        stopId: '1:1002',
        stopLat: 44.95,
        stopLon: -93.26,
        stopName: 'Stop 2',
        tripId: '1:trip-a',
        vehicleId: '1:8140'
      }
      state = goMode(state, { payload: record, type: 'SET_EARLY_ALIGHT' })
      expect(state.riding).toBeNull()
      expect(state.earlyAlight).toEqual(record)
      // An early alight IS an alight: the onboard flow must not read a
      // surviving confirmed match as proof the rider is still aboard (8/9).
      expect(state.alightedFrom).toEqual({
        tripId: '1:trip-a',
        vehicleId: '1:8140'
      })
      // The departure pick belonged to the bus they left.
      expect(state.departureOverride).toBeNull()
    })

    it('is retired by boarding again, and by moving past the leg', () => {
      const record = {
        atMs: NOW,
        legIndex: 1,
        stopId: '1:1002',
        stopLat: 44.95,
        stopLon: -93.26,
        stopName: 'Stop 2',
        tripId: '1:trip-a',
        vehicleId: '1:8140'
      }
      const alighted = goMode(goMode(undefined, { type: '@@INIT' }), {
        payload: record,
        type: 'SET_EARLY_ALIGHT'
      })
      expect(
        goMode(alighted, { payload: ridingFact(), type: 'SET_RIDING' })
          .earlyAlight
      ).toBeNull()
      expect(
        goMode(alighted, {
          payload: { vehicleId: '1:8155' },
          type: 'CONFIRM_VEHICLE'
        }).earlyAlight
      ).toBeNull()
      // Still on the leg they got off: the re-anchoring is still needed.
      expect(
        goMode(alighted, { payload: { legIndex: 1 }, type: 'TRANSITION_LEG' })
          .earlyAlight
      ).toEqual(record)
      expect(
        goMode(alighted, { payload: { legIndex: 2 }, type: 'TRANSITION_LEG' })
          .earlyAlight
      ).toBeNull()
    })

    // The delegation trap: create-otp-reducer forwards goMode actions through
    // an EXPLICIT case list, and a type missing from it is silently dropped in
    // the app while the slice's own unit tests stay green.
    it('SET_EARLY_ALIGHT is delegated by the root reducer', () => {
      const reducer = createOtpReducer({})
      const initial = reducer(undefined, { type: '@@INIT' })
      expect(initial.goMode.earlyAlight).toBeNull()
      const after = reducer(initial, {
        payload: {
          atMs: NOW,
          legIndex: 1,
          stopId: '1:1002',
          stopLat: 44.95,
          stopLon: -93.26,
          stopName: 'Stop 2',
          tripId: '1:trip-a',
          vehicleId: '1:8140'
        },
        type: 'SET_EARLY_ALIGHT'
      })
      expect(after.goMode.earlyAlight?.stopId).toBe('1:1002')
    })
  })
})
