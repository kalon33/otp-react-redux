import {
  BOARD_STOP_DWELL_MIN_MS,
  decideRiding,
  matchDescribesLeg
} from '../../../lib/util/go-mode/riding'
import { fetchOnboardCandidatePlan, findTrip } from '../../../lib/actions/apiV2'
import {
  itinerarySignature,
  onwardTransitRouteId
} from '../../../lib/util/go-mode/reroute-candidates'
import { replanFromAboard } from '../../../lib/actions/go-mode'
import { shouldReplanBoardedEarlier } from '../../../lib/util/go-mode/transit-trust'
import fixture from '../../../lib/util/go-mode/replay/fixtures/ride-0831-transfer-loop.json'
import goMode from '../../../lib/reducers/go-mode'
import type { RidingState } from '../../../lib/util/go-mode/types'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * The 2026-08-31 evening ride (session mthnk1al-x7m0iv), driven from its own
 * recording.
 *
 * Downtown -> home, via the METRO Orange Line and a 602 m hop on the 539. The
 * rider alights at I-35W & 98th St at 17:35:45. Twelve seconds later Go Mode
 * transitions to the 539's leg — and writes the ORANGE LINE's trip and vehicle
 * into the riding fact for it:
 *
 *   SET_RIDING legIndex 2 routeId 1:539 tripId 1:1268645 vehicleId route:1:904
 *
 * The trip belongs to leg 0, the ride that had just finished. It got there
 * because the Orange Line's confirmed match — a SYNTHETIC vehicle, route:1:904,
 * in no feed and so never refreshable, demotable or ageable — was still held,
 * and decideRiding ranked it above the leg's own trip id.
 *
 * shouldReplanBoardedEarlier then compared that against the 539 leg's planned
 * trip. Neither identity matched, so its planned-trip short-circuit missed and
 * the clock test fired on a board time three minutes out. Each auto-applied
 * splice put the same Orange trip back at leg 0 and moved the onward bus 44
 * minutes away, so the trigger grew STRONGER every cycle. Three cycles in
 * 2m14s, six high-priority pushes, stopped only by the caller's three-attempt
 * cap — and the replan swapped the rider's 539 (home 17:53) for the 546 (home
 * 18:28). Thirty-five minutes.
 *
 * The cases below drive the real functions with the ride's own recorded
 * itineraries and trip schedules, not hand-built approximations.
 */

const PLAN: any = (fixture as any).itinerary
const SWAPS: any[] = (fixture as any).itinerarySwaps

/** Leg 0: the METRO Orange Line the rider really rode and finished. */
const ORANGE_LEG: any = PLAN.legs[0]
/** Leg 2: the 539 the rider chose, and lost. */
const BUS_539_LEG: any = PLAN.legs[2]

const ORANGE_TRIP_ID: string = ORANGE_LEG.trip.gtfsId
const PLANNED_539_TRIP_ID: string = BUS_539_LEG.trip.gtfsId
const SYNTHETIC_VEHICLE_ID = 'route:1:904'

/** 17:35:57 — the SET_RIDING that armed the loop. */
const TRANSFER_MS = 1788215757053

const legTripIds = (itin: any): (string | null)[] =>
  (itin.legs || []).map((l: any) => l?.trip?.gtfsId ?? l?.tripId ?? null)

/**
 * The Orange Line match as it stood at the transfer: confirmed at 17:15:01 and
 * frozen ever since (refreshConfirmedMatch cannot touch a vehicle no feed
 * publishes), so it still names route 1:904 and trip 1:1268645.
 */
const survivingOrangeMatch = {
  confidence: 'confirmed' as const,
  distanceMeters: null,
  label: 'Orange Burnsville',
  lastSeen: 1788214501385,
  routeId: '1:904',
  tripId: ORANGE_TRIP_ID,
  vehicleId: SYNTHETIC_VEHICLE_ID
}

/**
 * The route match for the moment the rider stepped onto the 539's leg. The
 * recorded fix at 17:35:57 was 16 m accurate at 7.54 m/s — the rider was
 * genuinely moving, which is what carried firstEstablishmentIsCorroborated.
 */
const onThe539Leg = {
  distanceFromRoute: 12,
  isOnRoute: true,
  legIndex: 2,
  nearestPoint: [44.82635, -93.29375] as [number, number],
  progressAlongLeg: 0.08,
  progressAlongSegment: 0,
  segmentIndex: 0
}

const decideAtTheTransfer = (over: any = {}) =>
  decideRiding({
    // A transfer IS a wait at the next leg's boarding stop, so the
    // 2026-09-01 board gate (BOARD_STOP_DWELL_MIN_MS, false-board-0901.ts) is
    // satisfied here. Supplied explicitly so these cases keep testing what
    // they were written for: WHICH trip the fact names, not whether one is
    // established. The recorded 17:35:57 tick — 7.54 m/s, no dwell — would
    // now be refused outright, which is a strictly better outcome for this
    // ride too and is why that gate has its own coverage.
    boardStopDwellMs: BOARD_STOP_DWELL_MIN_MS,
    matchedLeg: BUS_539_LEG,
    nowMs: TRANSFER_MS,
    offRouteClearMs: 90000,
    // TRANSITION_LEG cleared the fact on the alight — the recorded boardedAt of
    // 1788215757053 is TRANSFER_MS itself, which is only reachable from a null
    // prevRiding. The stale identity did NOT come from the previous riding
    // state; it came from the surviving match.
    prevRiding: null,
    riderSpeedMps: 7.54,
    routeMatch: onThe539Leg,
    vehicleMatch: { consecutiveMatches: 0, match: survivingOrangeMatch },
    ...over
  })

describe('util > go-mode > the 8/31 transfer reroute loop', () => {
  // Provenance. Every gate below is meaningless if the recording stops
  // carrying the defect's own input.
  describe('the recording still carries the loop', () => {
    it('holds the plan the rider chose: the Orange Line, then the 539', () => {
      expect(ORANGE_TRIP_ID).toBe('1:1268645')
      expect(ORANGE_LEG.routeId).toBe('1:904')
      expect(PLANNED_539_TRIP_ID).toBe('1:896792')
      expect(BUS_539_LEG.routeId).toBe('1:539')
      // The two identities are different objects on different routes: this is
      // exactly what the stale carry-over collapsed.
      expect(ORANGE_TRIP_ID).not.toBe(PLANNED_539_TRIP_ID)
    })

    it('holds three auto-applied swaps that all throw the 539 away', () => {
      expect(SWAPS).toHaveLength(3)
      for (const swap of SWAPS) {
        // Same Orange trip re-spliced as leg 0, starting at a stop the rider
        // had already ridden through — Knox Ave & American Blvd, 4.6 km back.
        expect(swap.itinerary.legs[0].trip.gtfsId).toBe(ORANGE_TRIP_ID)
        expect(swap.itinerary.legs[0].from.name).toBe(
          'Knox Ave & American Blvd Station'
        )
        expect(Math.round(swap.itinerary.legs[0].distance)).toBe(4607)
        // ...and the 539 replaced by the 546.
        expect(swap.itinerary.legs[2].routeShortName).toBe('546')
        expect(legTripIds(swap.itinerary)).not.toContain(PLANNED_539_TRIP_ID)
      }
      // 17:36:00, 17:37:11, 17:38:11 — 2m11s of cycling.
      const gaps = SWAPS.slice(1).map((s, i) => s.tMs - SWAPS[i].tMs)
      expect(gaps.every((g: number) => g < 90000)).toBe(true)
    })

    it('the swaps cost the rider 39 minutes of planned arrival time', () => {
      const lost = (SWAPS[0].itinerary.endTime - PLAN.endTime) / 60000
      expect(Math.round(lost)).toBe(39)
      // Against the 539's own arrival on the plan the rider was standing to
      // catch, the loss the ride note reports.
      expect(
        Math.round((SWAPS[0].itinerary.endTime - PLAN.legs[3].endTime) / 60000)
      ).toBe(39)
    })
  })

  describe('defect 1 — the stale riding identity (riding.ts)', () => {
    it('a confirmed match for another route does not speak for this leg', () => {
      expect(matchDescribesLeg(survivingOrangeMatch, BUS_539_LEG)).toBe(false)
      // ...but it is still the authority on its own leg.
      expect(matchDescribesLeg(survivingOrangeMatch, ORANGE_LEG)).toBe(true)
    })

    it('never blocks on a routeId a matcher simply did not carry', () => {
      expect(matchDescribesLeg({ routeId: null }, BUS_539_LEG)).toBe(true)
      expect(matchDescribesLeg({}, BUS_539_LEG)).toBe(true)
      expect(matchDescribesLeg(survivingOrangeMatch, null)).toBe(true)
    })

    // FAILS AGAINST UNFIXED SOURCE: returns tripId '1:1268645' and vehicleId
    // 'route:1:904' — byte for byte the recorded SET_RIDING of 17:35:57.
    it('establishes the transfer on the 539 own trip, not the Orange Line', () => {
      const d = decideAtTheTransfer()
      expect(d.kind).toBe('set')
      expect(d.kind === 'set' && d.riding.legIndex).toBe(2)
      expect(d.kind === 'set' && d.riding.routeId).toBe('1:539')
      expect(d.kind === 'set' && d.riding.tripId).toBe(PLANNED_539_TRIP_ID)
      expect(d.kind === 'set' && d.riding.tripId).not.toBe(ORANGE_TRIP_ID)
      expect(d.kind === 'set' && d.riding.vehicleId).toBeNull()
    })

    it('and that identity disarms the boarded-earlier detector outright', () => {
      const d = decideAtTheTransfer()
      const ridingTripId = d.kind === 'set' ? d.riding.tripId : null
      expect(
        shouldReplanBoardedEarlier({
          nowMs: TRANSFER_MS,
          plannedTripIds: legTripIds(PLAN),
          ridingLeg: BUS_539_LEG,
          ridingTripId,
          vehicleMatchState: {
            consecutiveMatches: 0,
            match: survivingOrangeMatch
          },
          vehicleRecord: null
        })
      ).toBe(false)
    })

    it('a match that DOES speak for the leg still names the ridden trip', () => {
      // The whole point of trusting a match: the rider caught an earlier run of
      // the route they planned. That must still work.
      const earlierRun = {
        ...survivingOrangeMatch,
        routeId: '1:539',
        tripHeadsign: BUS_539_LEG.headsign,
        tripId: '1:539-earlier-run',
        vehicleId: '1:5501'
      }
      const d = decideAtTheTransfer({
        vehicleMatch: { consecutiveMatches: 8, match: earlierRun }
      })
      expect(d.kind).toBe('set')
      expect(d.kind === 'set' && d.riding.tripId).toBe('1:539-earlier-run')
      expect(d.kind === 'set' && d.riding.vehicleId).toBe('1:5501')
    })
  })

  describe('defect 1b — the loop gate (transit-trust.ts)', () => {
    const fireWith = (over: any = {}) =>
      shouldReplanBoardedEarlier({
        nowMs: TRANSFER_MS,
        ridingLeg: BUS_539_LEG,
        // What the app actually held: leg 0's trip, on leg 2.
        ridingTripId: ORANGE_TRIP_ID,
        vehicleMatchState: {
          consecutiveMatches: 0,
          match: survivingOrangeMatch
        },
        vehicleRecord: null,
        ...over
      })

    it('the recorded moment really is inside the clock window', () => {
      // The 539 boarded at 17:41:01; it is 17:35:57. More than the 120 s that
      // arms the early-board proof, so on the unfixed code the clock fired with
      // no vehicle evidence of any kind.
      expect(Number(BUS_539_LEG.startTime) - TRANSFER_MS).toBeGreaterThan(
        120000
      )
      // And neither identity is the planned trip, so 8/28's short-circuit —
      // the fix that landed the day before this ride — cannot catch it.
      expect(survivingOrangeMatch.tripId).not.toBe(PLANNED_539_TRIP_ID)
      expect(ORANGE_TRIP_ID).not.toBe(PLANNED_539_TRIP_ID)
      // This is the unfixed answer.
      expect(fireWith({ plannedTripIds: null })).toBe(true)
    })

    // FAILS AGAINST UNFIXED SOURCE: returns true — the first reroute of the loop.
    it('does not fire on a riding trip the plan puts on another leg', () => {
      expect(fireWith({ plannedTripIds: legTripIds(PLAN) })).toBe(false)
    })

    // FAILS AGAINST UNFIXED SOURCE: returns true for both — cycles 2 and 3.
    it('stays shut on every itinerary the loop applied to itself', () => {
      for (const swap of SWAPS) {
        const bus546Leg = swap.itinerary.legs[2]
        expect(
          shouldReplanBoardedEarlier({
            nowMs: swap.tMs,
            plannedTripIds: legTripIds(swap.itinerary),
            ridingLeg: bus546Leg,
            ridingTripId: ORANGE_TRIP_ID,
            vehicleMatchState: {
              consecutiveMatches: 0,
              match: survivingOrangeMatch
            },
            vehicleRecord: null
          })
        ).toBe(false)
      }
    })

    it('still fires for a trip that is genuinely not in the plan', () => {
      // An earlier run of the ridden route appears nowhere in the itinerary, so
      // the stale-anchor gate passes and the clock proof is untouched.
      expect(
        fireWith({
          plannedTripIds: legTripIds(PLAN),
          ridingTripId: '1:539-earlier-run'
        })
      ).toBe(true)
    })
  })

  describe('defect 2 — the auto-replan threw away the rider 539', () => {
    it('anchored on the leg the matcher named, there is nothing to keep', () => {
      // riding.legIndex was 2. Everything after leg 2 is a bike leg, so the
      // rule "an auto-update keeps the rider route" had nothing to hold: this
      // is the recorded keepRouteId: null, reproduced from the plan itself.
      expect(
        onwardTransitRouteId(PLAN, {
          afterLegIndex: 2,
          boardedRouteId: '1:539'
        })
      ).toBeNull()
    })

    it('anchored on the leg the boarded TRIP is on, it is the 539', () => {
      expect(
        onwardTransitRouteId(PLAN, { afterLegIndex: 0, boardedRouteId: null })
      ).toBe('1:539')
    })

    // FAILS AGAINST UNFIXED SOURCE: dispatches keepRouteId null.
    it('replanFromAboard keeps the 539 when riding.legIndex has drifted', async () => {
      const orangeTrip = (fixture as any).tripSnapshots
        .filter((s: any) => s.payload.id === ORANGE_TRIP_ID)
        .sort((a: any, b: any) => b.tMs - a.tMs)[0].payload
      ;(findTrip as jest.Mock).mockReturnValue(() => Promise.resolve({}))
      ;(fetchOnboardCandidatePlan as jest.Mock).mockReturnValue(() =>
        Promise.resolve({ error: true, itineraries: [] })
      )

      // The riding fact exactly as recorded at 17:35:57: leg 2, route 1:539,
      // and the Orange Line's trip and synthetic vehicle.
      const riding: RidingState = {
        boardedAt: TRANSFER_MS,
        headsign: BUS_539_LEG.headsign,
        legIndex: 2,
        offRouteSince: null,
        routeId: '1:539',
        routeShortName: '539',
        tripId: ORANGE_TRIP_ID,
        vehicleId: SYNTHETIC_VEHICLE_ID
      }
      let state: any = {
        ...goMode(undefined, { type: '@@INIT' }),
        activeItinerary: PLAN,
        isActive: true,
        riding,
        tracking: {
          ...goMode(undefined, { type: '@@INIT' }).tracking,
          lastPosition: { coords: { latitude: 44.8247, longitude: -93.2909 } }
        }
      }
      const actions: any[] = []
      const getState = () => ({
        otp: {
          config: { homeTimezone: 'America/Chicago' },
          currentQuery: { to: { lat: 1, lon: 2, name: 'elsewhere' } },
          goMode: state,
          transitIndex: { routes: {}, trips: { [ORANGE_TRIP_ID]: orangeTrip } }
        }
      })
      const dispatch: any = (action: any) => {
        if (typeof action === 'function') return action(dispatch, getState)
        actions.push(action)
        state = goMode(state, action)
        return action
      }
      await dispatch(
        replanFromAboard({ autoApply: true, reason: 'boarded-earlier' })
      )

      const started = actions.find((a) => a.type === 'START_REROUTE')
      expect(started).toBeDefined()
      expect(started.payload.reason).toBe('boarded-earlier')
      expect(started.payload.keepRouteId).toBe('1:539')
    })
  })

  describe('defect 3 — the loop outran its own dedupe guard', () => {
    it('the ride even mislabels the spliced Orange leg with the wrong route', () => {
      // buildOnboardItinerary stamps `vehicle.routeId` onto the synthesized bus
      // leg, and that came from the corrupted riding.routeId — so the Orange
      // Line trip 1:1268645 was published as route 1:539 on the first swap and
      // route 1:546 on the next two, chasing whatever leg the matcher had last
      // named. Recorded here as provenance: it is why cycle 1 and cycle 2 can
      // never look alike to ANY signature, and it is a defect of its own.
      expect(SWAPS[0].itinerary.legs[0].trip.gtfsId).toBe(ORANGE_TRIP_ID)
      expect(SWAPS[0].itinerary.legs[0].routeId).toBe('1:539')
      expect(SWAPS[1].itinerary.legs[0].routeId).toBe('1:546')
      expect(SWAPS[2].itinerary.legs[0].routeId).toBe('1:546')
    })

    it('the recorded swaps differ ONLY in the minute their leg 0 starts', () => {
      const legShape = (itin: any) =>
        itin.legs.map(
          (l: any) =>
            `${l.mode}:${l.routeId ?? ''}:${l.trip?.gtfsId ?? ''}:${
              l.from?.name
            }>${l.to?.name}`
        )
      // Cycles 2 and 3, which the mislabel above leaves identical in shape.
      expect(legShape(SWAPS[2].itinerary)).toEqual(legShape(SWAPS[1].itinerary))
      const startMinute = (itin: any) =>
        Math.floor(Number(itin.legs[0].startTime) / 60000)
      expect(startMinute(SWAPS[2].itinerary)).not.toBe(
        startMinute(SWAPS[1].itinerary)
      )
    })

    // FAILS AGAINST UNFIXED SOURCE: the three signatures are all different,
    // which is why replanFromAboard's "materially the same trip" guard — the
    // one meant to make this whole CLASS non-recurring — let cycles 2 and 3
    // swap the itinerary and push again.
    it('reads a re-splice of the same trip as the same trip', () => {
      expect(itinerarySignature(SWAPS[2].itinerary)).toBe(
        itinerarySignature(SWAPS[1].itinerary)
      )
    })

    it('and still tells the 539 plan apart from the 546 one', () => {
      expect(itinerarySignature(PLAN)).not.toBe(
        itinerarySignature(SWAPS[0].itinerary)
      )
      // Two departures of one route always carry different trip ids, so
      // dropping the clock from a leg that names a trip cannot collapse them.
      const laterRun = {
        ...SWAPS[0].itinerary,
        legs: SWAPS[0].itinerary.legs.map((l: any, i: number) =>
          i === 2 ? { ...l, trip: { gtfsId: '1:546-later-run' } } : l
        )
      }
      expect(itinerarySignature(laterRun)).not.toBe(
        itinerarySignature(SWAPS[0].itinerary)
      )
    })
  })
})
