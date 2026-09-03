import {
  BOARD_AUTO_CONFIRM_MIN_CONSECUTIVE,
  BOARD_STOP_DWELL_MIN_MS,
  decideRiding,
  ridingFactIsEvidenced,
  trackBoardStopDwell,
  vehicleReachedBoardStop
} from '../../../lib/util/go-mode/riding'
import {
  calculateDistance,
  shouldTransitionToNextLeg,
  TRANSIT_BOARD_EARLY_MS
} from '../../../lib/util/go-mode/position-matching'
import goMode from '../../../lib/reducers/go-mode'
import ride12 from '../../../lib/util/go-mode/replay/fixtures/bike-false-board-1029.json'
import ride3 from '../../../lib/util/go-mode/replay/fixtures/ride-1048-orange-bike.json'

/**
 * The 2026-09-01 board gate — three rides, one defect, three different doors
 * (backlog 6.1, fourth observation counting 4.4).
 *
 * Go Mode declared the rider aboard a bus on evidence that was not there.
 * Everything downstream — progress, deviation, the arrival latch, the
 * auto-applied replans — was then computed against a bus polyline for someone
 * on a bicycle. The four recorded false boards did NOT share a code path, and
 * each is gated here separately:
 *
 *   4.4  2026-08-31 17:15:01  decideRiding, GPS alone, on a fix reporting
 *                             1254.7 m of accuracy.
 *   6.1a 2026-09-01 08:26:26  performVehicleMatching's boarding-prompt
 *                             auto-confirm, on ONE poll of a bus that had not
 *                             reached the stop, bypassing decideRiding
 *                             entirely.
 *   6.1b 2026-09-01 10:47:15  decideRiding, GPS alone, 4.3 km from the
 *                             boarding stop at 8.0 m/s on a bicycle.
 *   6.1c 2026-09-01 10:48:50  the 10:47:15 fact resumed across a Go Mode
 *                             restart, so the next trip began already aboard,
 *                             and survived its own confirmation with the
 *                             fabricated board time intact.
 *
 * All numbers below are read from the committed recordings or quoted from the
 * debug log (`~/otp-debug-logs/debug-2026-09-01.jsonl`,
 * `debug-2026-08-31.jsonl`); nothing here is a hand-built approximation.
 */

/** Ride 1's bus leg: the Orange Line from I-35W & 98th St Station. */
const RIDE1_BUS_LEG: any = (ride12 as any).itinerary.legs[0]
/** Ride 2 and 3's bus leg: the Orange Line from I-35W & 46th St Station. */
const RIDE3_BUS_LEG: any = (ride3 as any).itinerary.legs[1]

const OFF_ROUTE_CLEAR_MS = 90000

// ---------------------------------------------------------------------------
// 6.1b — ride 2, 10:47:15. The cleanest recording of the defect.
// ---------------------------------------------------------------------------

/** `SET_RIDING` fired on this fix. speed 8.01 m/s = 28.8 km/h — a bicycle. */
const FALSE_BOARD_MS = 1788277635063
const FALSE_BOARD_FIX = {
  accuracy: 18.5,
  lat: 44.88357,
  lon: -93.2952,
  speed: 8.01
}

/**
 * The route match the app actually held on that tick. distanceFromRoute had
 * fallen 108.1 -> 100.0 m in one second as the bike path converged on the
 * Orange Line's geometry; progressAlongLeg had been frozen at 0.4043 since
 * 10:46:56. Nothing else changed.
 */
const falseBoardMatch = (over: any = {}) => ({
  distanceFromRoute: 100.0,
  isOnRoute: true,
  legIndex: 1,
  nearestPoint: [44.88357, -93.29642] as [number, number],
  progressAlongLeg: 0.4043,
  progressAlongSegment: 1,
  segmentIndex: 118,
  ...over
})

/** What the matcher reported on every poll of the ride: nothing. */
const noVehicle = {
  consecutiveMatches: 0,
  match: {
    confidence: 'none' as const,
    distanceMeters: null,
    label: null,
    lastSeen: FALSE_BOARD_MS,
    vehicleId: null
  }
}

const decideAtFalseBoard = (over: any = {}) =>
  decideRiding({
    boardStopDwellMs: null,
    fixAccuracyM: FALSE_BOARD_FIX.accuracy,
    matchedLeg: RIDE3_BUS_LEG,
    nowMs: FALSE_BOARD_MS,
    offRouteClearMs: OFF_ROUTE_CLEAR_MS,
    prevRiding: null,
    riderSpeedMps: FALSE_BOARD_FIX.speed,
    routeMatch: falseBoardMatch(),
    vehicleMatch: noVehicle,
    ...over
  })

describe('util > go-mode > the 2026-09-01 false boards', () => {
  describe('the recording still carries the defect', () => {
    it('ride 2/3 boarded a bus whose stop was 4.3 km away', () => {
      const km =
        calculateDistance(
          FALSE_BOARD_FIX.lat,
          FALSE_BOARD_FIX.lon,
          RIDE3_BUS_LEG.from.lat,
          RIDE3_BUS_LEG.from.lon
        ) / 1000
      expect(RIDE3_BUS_LEG.from.stopId).toBe('1:53543')
      expect(RIDE3_BUS_LEG.transitLeg).toBe(true)
      expect(Math.round(km * 10) / 10).toBe(4.3)
    })

    it('and the rider was moving at bicycle speed, not bus speed', () => {
      expect(FALSE_BOARD_FIX.speed).toBeGreaterThan(7)
      expect(FALSE_BOARD_FIX.speed).toBeLessThan(9)
    })
  })

  // FAILS AGAINST UNFIXED SOURCE: returns { kind: 'set' } with vehicleId null
  // and boardedAt 1788277635049 — the recorded SET_RIDING of 10:47:15.
  describe('6.1b — route proximity plus motion is not boarding', () => {
    it('refuses the 10:47:15 board', () => {
      expect(decideAtFalseBoard().kind).toBe('none')
    })

    it('refuses it one metre-count earlier too (10:47:14, 108.1 m)', () => {
      // The old gate was exactly this wide: the ONLY quantity that crossed a
      // threshold between these two ticks was distanceFromRoute vs
      // RIDING_ESTABLISH_MAX_DISTANCE_M.
      expect(
        decideAtFalseBoard({
          nowMs: FALSE_BOARD_MS - 1000,
          routeMatch: falseBoardMatch({ distanceFromRoute: 108.1 })
        }).kind
      ).toBe('none')
    })

    it('the rider never waited at that stop — the real track says so', () => {
      // Every recorded fix from the leg transition (10:42:09) to the false
      // board, folded through the real dwell tracker against the real stop.
      const track = (ride12 as any).gpsTrack.filter(
        (p: any) => p.tMs >= 1788277330000 && p.tMs <= FALSE_BOARD_MS
      )
      expect(track.length).toBeGreaterThan(300)
      let dwell = null
      let closestM = Infinity
      for (const p of track) {
        const d = calculateDistance(
          p.lat,
          p.lon,
          RIDE3_BUS_LEG.from.lat,
          RIDE3_BUS_LEG.from.lon
        )
        closestM = Math.min(closestM, d)
        dwell = trackBoardStopDwell(dwell, {
          distanceToBoardStopM: d,
          legIndex: 1,
          nowMs: p.tMs
        })
      }
      expect(dwell).toBeNull()
      // Not marginal: the nearest the rider came to the boarding stop in the
      // five minutes before being declared aboard it was 3.9 km — thirty-two
      // times the radius that counts as waiting there.
      expect(Math.round(closestM)).toBe(3933)
    })
  })

  describe('a rider who actually catches the bus still boards', () => {
    // The gate must not be so tight that the ordinary case stops working —
    // this is the case that has to keep passing.
    it('waits at the stop, then moves along the shape', () => {
      const d = decideAtFalseBoard({
        boardStopDwellMs: BOARD_STOP_DWELL_MIN_MS,
        riderSpeedMps: 12,
        routeMatch: falseBoardMatch({
          distanceFromRoute: 18,
          progressAlongLeg: 0.06
        })
      })
      expect(d.kind).toBe('set')
      expect(d.kind === 'set' && d.riding.tripId).toBe('1:1272543')
      expect(d.kind === 'set' && d.riding.boardedAt).toBe(FALSE_BOARD_MS)
    })

    it('but a wait that has not yet run its course is not enough', () => {
      expect(
        decideAtFalseBoard({
          boardStopDwellMs: BOARD_STOP_DWELL_MIN_MS - 1000,
          routeMatch: falseBoardMatch({
            distanceFromRoute: 18,
            progressAlongLeg: 0.06
          })
        }).kind
      ).toBe('none')
    })

    it('the dwell accumulates while the rider stands there, and only then', () => {
      const stop = { lat: RIDE3_BUS_LEG.from.lat, lon: RIDE3_BUS_LEG.from.lon }
      let dwell = null
      for (let i = 0; i <= 90; i++) {
        dwell = trackBoardStopDwell(dwell, {
          distanceToBoardStopM: 15,
          legIndex: 1,
          nowMs: FALSE_BOARD_MS + i * 1000
        })
      }
      expect(dwell?.dwellMs).toBe(90000)
      expect(stop.lat).toBeGreaterThan(44)
      // Once the wait has run its course, leaving the radius is BOARDING, so
      // the fact is kept (see the 2026-07-29 leg in riding-identity-0729).
      dwell = trackBoardStopDwell(dwell, {
        distanceToBoardStopM: 400,
        legIndex: 1,
        nowMs: FALSE_BOARD_MS + 91000
      })
      expect(dwell?.dwellMs).toBe(90000)
      // But moving on to a DIFFERENT leg's boarding stop starts again.
      expect(
        trackBoardStopDwell(dwell, {
          distanceToBoardStopM: 400,
          legIndex: 3,
          nowMs: FALSE_BOARD_MS + 92000
        })
      ).toBeNull()
    })

    it('a wait that has not run its course still restarts on leaving', () => {
      // A rider who cycled past a stop has not waited at it.
      let dwell = null
      for (let i = 0; i <= 30; i++) {
        dwell = trackBoardStopDwell(dwell, {
          distanceToBoardStopM: 15,
          legIndex: 1,
          nowMs: FALSE_BOARD_MS + i * 1000
        })
      }
      expect(dwell?.dwellMs).toBe(30000)
      expect(dwell!.dwellMs).toBeLessThan(BOARD_STOP_DWELL_MIN_MS)
      expect(
        trackBoardStopDwell(dwell, {
          distanceToBoardStopM: 400,
          legIndex: 1,
          nowMs: FALSE_BOARD_MS + 31000
        })
      ).toBeNull()
    })

    it('a backgrounded app cannot bank a wait it did not observe', () => {
      // Two fixes ten minutes apart are not ten minutes at the kerb.
      let dwell = trackBoardStopDwell(null, {
        distanceToBoardStopM: 20,
        legIndex: 1,
        nowMs: FALSE_BOARD_MS
      })
      dwell = trackBoardStopDwell(dwell, {
        distanceToBoardStopM: 20,
        legIndex: 1,
        nowMs: FALSE_BOARD_MS + 600000
      })
      expect(dwell?.dwellMs).toBeLessThan(BOARD_STOP_DWELL_MIN_MS)
    })
  })

  // -------------------------------------------------------------------------
  // 6.1a — ride 1, 08:26:26. A different door entirely.
  // -------------------------------------------------------------------------
  describe('6.1a — the auto-confirm that boarded a bus still on its way', () => {
    /**
     * `UPDATE_VEHICLE_MATCH` at 08:26:26.113, quoted from the debug log. The
     * rider was standing on the platform at 0.0-0.9 m/s; 8139 was 135 m out
     * and its next stop was still the rider's own. `CONFIRM_VEHICLE` and
     * `SET_RIDING` followed within 3 ms.
     */
    const ride1Match = {
      confidence: 'medium' as const,
      directionId: '0',
      distanceMeters: 135,
      label: '8139',
      lastSeen: 1788269186100,
      nextStopId: '1:56831',
      routeId: '1:904',
      tripHeadsign: 'ORANGE Downtown Minneapolis',
      tripId: '1:1265802',
      vehicleId: '1:8139'
    }
    const RIDE1_CONSECUTIVE_MATCHES = 1

    it('the bus had not reached the boarding stop', () => {
      expect(RIDE1_BUS_LEG.from.stopId).toBe('1:56831')
      expect(ride1Match.nextStopId).toBe(RIDE1_BUS_LEG.from.stopId)
      expect(vehicleReachedBoardStop(ride1Match, RIDE1_BUS_LEG)).toBe(false)
    })

    it('and one poll is not agreement', () => {
      expect(RIDE1_CONSECUTIVE_MATCHES).toBeLessThan(
        BOARD_AUTO_CONFIRM_MIN_CONSECUTIVE
      )
    })

    it('once it is at or past the stop, boarding is possible again', () => {
      expect(
        vehicleReachedBoardStop({ nextStopId: '1:17780' }, RIDE1_BUS_LEG)
      ).toBe(true)
    })

    it('never blocks on a next stop the feed does not publish', () => {
      expect(vehicleReachedBoardStop({ nextStopId: null }, RIDE1_BUS_LEG)).toBe(
        true
      )
      expect(vehicleReachedBoardStop(ride1Match, null)).toBe(true)
    })

    // FAILS AGAINST UNFIXED SOURCE: 'set'. decideRiding trusted a confirmed
    // match without asking whether boarding it was physically possible.
    it('decideRiding refuses the same evidence for the same reason', () => {
      expect(
        decideRiding({
          boardStopDwellMs: null,
          fixAccuracyM: 8,
          matchedLeg: RIDE1_BUS_LEG,
          nowMs: 1788269186116,
          offRouteClearMs: OFF_ROUTE_CLEAR_MS,
          prevRiding: null,
          riderSpeedMps: 1.92,
          routeMatch: {
            distanceFromRoute: 19.7,
            isOnRoute: true,
            legIndex: 0,
            nearestPoint: [44.82548, -93.29092] as [number, number],
            progressAlongLeg: 0.06,
            progressAlongSegment: 0,
            segmentIndex: 0
          },
          vehicleMatch: {
            consecutiveMatches: 1,
            match: { ...ride1Match, confidence: 'confirmed' as const }
          }
        }).kind
      ).toBe('none')
    })
  })

  // -------------------------------------------------------------------------
  // 6.1c — the board time that survived its own confirmation.
  // -------------------------------------------------------------------------
  describe('6.1c — a confirmation is the boarding, when nothing else was', () => {
    /** `CONFIRM_VEHICLE` 10:50:55: vehicle 1:8216 at 127.9 m — real evidence. */
    const CONFIRM_MS = 1788277855088
    const confirmed = {
      confidence: 'confirmed' as const,
      distanceMeters: 127.9,
      label: '8216',
      lastSeen: CONFIRM_MS,
      nextStopId: '1:56833',
      routeId: '1:904',
      tripId: '1:1272543',
      vehicleId: '1:8216'
    }
    /** The fabricated fact the app was holding when it arrived. */
    const fabricated = {
      boardedAt: 1788277635049,
      headsign: 'ORANGE Burnsville',
      legIndex: 1,
      offRouteSince: null,
      routeId: '1:904',
      routeShortName: null,
      tripId: '1:1272543',
      vehicleId: null
    }

    it('a fact naming no bus is not evidence', () => {
      expect(ridingFactIsEvidenced(fabricated)).toBe(false)
      // Nor is a synthetic id, which is in no feed and refreshable by nothing.
      expect(ridingFactIsEvidenced({ vehicleId: 'route:1:904' })).toBe(false)
      expect(ridingFactIsEvidenced({ vehicleId: '1:8216' })).toBe(true)
    })

    // FAILS AGAINST UNFIXED SOURCE: boardedAt stays 1788277635049, which is
    // 3m40s before any bus was identified — the recorded SET_RIDING of
    // 10:50:55, byte for byte.
    it('re-stamps a board time that had no bus behind it', () => {
      const d = decideRiding({
        boardStopDwellMs: null,
        fixAccuracyM: 12,
        matchedLeg: RIDE3_BUS_LEG,
        nowMs: CONFIRM_MS,
        offRouteClearMs: OFF_ROUTE_CLEAR_MS,
        prevRiding: fabricated,
        riderSpeedMps: 15,
        routeMatch: falseBoardMatch({ distanceFromRoute: 20 }),
        vehicleMatch: { consecutiveMatches: 4, match: confirmed }
      })
      expect(d.kind).toBe('set')
      expect(d.kind === 'set' && d.riding.vehicleId).toBe('1:8216')
      expect(d.kind === 'set' && d.riding.boardedAt).toBe(CONFIRM_MS)
      expect(d.kind === 'set' && d.riding.boardedAt).not.toBe(
        fabricated.boardedAt
      )
    })

    it('but keeps a board time that already had one', () => {
      const d = decideRiding({
        boardStopDwellMs: null,
        fixAccuracyM: 12,
        matchedLeg: RIDE3_BUS_LEG,
        nowMs: CONFIRM_MS,
        offRouteClearMs: OFF_ROUTE_CLEAR_MS,
        prevRiding: {
          ...fabricated,
          legIndex: 0,
          offRouteSince: 1,
          vehicleId: '1:8216'
        },
        riderSpeedMps: 15,
        routeMatch: falseBoardMatch({ distanceFromRoute: 20 }),
        vehicleMatch: { consecutiveMatches: 4, match: confirmed }
      })
      expect(d.kind).toBe('set')
      expect(d.kind === 'set' && d.riding.boardedAt).toBe(1788277635049)
    })
  })

  describe('6.1c — a restart does not resume a guess', () => {
    /**
     * 10:48:47 `STOP_GO_MODE` -> 10:48:50 `START_GO_MODE` -> 10:48:51
     * `TRANSITION_LEG {legIndex: 1}`. The trip that began at 10:48:50 began
     * already aboard, and stepped onto the bus leg one second later, because
     * the fabricated fact of 10:47:15 rode across the restart.
     *
     * STOP_GO_MODE keeps `riding` on purpose (7/12: backing out of Go Mode and
     * reopening "I'm on the bus" must not re-ask which bus). That is only
     * sound for a fact that names a bus.
     */
    const unevidenced = {
      boardedAt: 1788277635049,
      headsign: 'ORANGE Burnsville',
      legIndex: 1,
      offRouteSince: null,
      routeId: '1:904',
      routeShortName: null,
      tripId: '1:1272543',
      vehicleId: null
    }
    const restartWith = (riding: any) => {
      const stopped = goMode(
        { ...goMode(undefined, { type: '@@INIT' }), isActive: true, riding },
        { type: 'STOP_GO_MODE' }
      )
      expect(stopped.isActive).toBe(false)
      expect(stopped.riding).toEqual(riding)
      return goMode(stopped, {
        payload: { itinerary: (ride3 as any).itinerary, originalFrom: null },
        type: 'START_GO_MODE'
      })
    }

    // FAILS AGAINST UNFIXED SOURCE: the fact is carried, re-anchored onto the
    // new itinerary's leg 1 — exactly the state the 10:48:50 trip started in.
    it('drops a riding fact that never named a bus', () => {
      expect(restartWith(unevidenced).riding).toBeNull()
    })

    it('keeps one that did — getting on a bus is a physical fact', () => {
      const r = restartWith({ ...unevidenced, vehicleId: '1:8216' })
      expect(r.riding?.vehicleId).toBe('1:8216')
      expect(r.riding?.legIndex).toBe(1)
    })

    it('and a mid-ride itinerary swap keeps it either way', () => {
      // A swap re-enters START_GO_MODE while still active: the plan around the
      // rider changed, the bus under them did not.
      const swapped = goMode(
        {
          ...goMode(undefined, { type: '@@INIT' }),
          isActive: true,
          riding: unevidenced
        },
        {
          payload: {
            itinerary: (ride3 as any).itinerary,
            originalFrom: null
          },
          type: 'START_GO_MODE'
        }
      )
      expect(swapped.riding?.tripId).toBe('1:1272543')
    })
  })

  // -------------------------------------------------------------------------
  // 4.4 — 2026-08-31 17:15:01, a fix that could not place the rider at all.
  // -------------------------------------------------------------------------
  describe('4.4 — a 1254 m fix is not evidence of anything', () => {
    const ELEVEN_FIFTEEN = 1788214501364
    const at1715 = (over: any = {}) =>
      decideRiding({
        boardStopDwellMs: BOARD_STOP_DWELL_MIN_MS,
        fixAccuracyM: 1254.7415098701167,
        matchedLeg: RIDE3_BUS_LEG,
        nowMs: ELEVEN_FIFTEEN,
        offRouteClearMs: OFF_ROUTE_CLEAR_MS,
        prevRiding: null,
        riderSpeedMps: null,
        routeMatch: falseBoardMatch({
          distanceFromRoute: 20.328158675694763,
          progressAlongLeg: 0.051423727389171586
        }),
        vehicleMatch: null,
        ...over
      })

    // FAILS AGAINST UNFIXED SOURCE: 'set' — the recorded SET_RIDING that
    // boarded the rider 6m22s early.
    it('refuses even though the projection lands 20 m from the shape', () => {
      expect(at1715().kind).toBe('none')
    })

    it('accepts the same geometry on a fix that means something', () => {
      expect(at1715({ fixAccuracyM: 16.2 }).kind).toBe('set')
    })

    it('never blocks on an accuracy the platform did not report', () => {
      expect(at1715({ fixAccuracyM: null }).kind).toBe('set')
    })
  })

  // -------------------------------------------------------------------------
  // 6.3 — the leg advance that ran four and a half minutes ahead of the rider.
  // -------------------------------------------------------------------------
  describe('6.3 — the clock is not a statement about position', () => {
    const BOARD_MS = RIDE3_BUS_LEG.startTime
    const gate = (match: any, over: any = {}) =>
      shouldTransitionToNextLeg(match, 0, {
        boardEpoch: BOARD_MS,
        isRiding: false,
        nowMs: BOARD_MS - 60_000,
        targetLeg: RIDE3_BUS_LEG,
        ...over
      })

    // FAILS AGAINST UNFIXED SOURCE: true — the recorded TRANSITION_LEG of
    // 10:42:09, with the rider 1003.7 m from the leg it stepped onto.
    it('refuses to step onto a bus leg the rider is 1 km away from', () => {
      expect(
        gate(falseBoardMatch({ distanceFromRoute: 1003.7, isOnRoute: false }))
      ).toBe(false)
    })

    it('and refuses at 810 m, where the matcher first nominated it', () => {
      expect(
        gate(falseBoardMatch({ distanceFromRoute: 810.5, isOnRoute: false }))
      ).toBe(false)
    })

    it('still boards a rider standing on the platform, same tick as before', () => {
      // Ride 1, 08:25:30-08:26:26: distanceFromRoute 19.7-31.6 m, isOnRoute
      // true, for the whole minute before boarding.
      expect(gate(falseBoardMatch({ distanceFromRoute: 30.0 }))).toBe(true)
    })

    it('and a rider already aboard still outranks all of it', () => {
      expect(
        gate(falseBoardMatch({ distanceFromRoute: 1003.7, isOnRoute: false }), {
          isRiding: true
        })
      ).toBe(true)
    })

    it('the board window itself is unchanged', () => {
      expect(
        gate(falseBoardMatch({ distanceFromRoute: 30.0 }), {
          nowMs: BOARD_MS - TRANSIT_BOARD_EARLY_MS - 1000
        })
      ).toBe(false)
    })
  })
})
