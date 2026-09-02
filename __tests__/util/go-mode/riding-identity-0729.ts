import {
  BOARD_STOP_DWELL_MIN_MS,
  BOARD_STOP_DWELL_RADIUS_M,
  decideRiding,
  matchServesLegStops,
  RIDING_MIN_PROGRESS,
  trackBoardStopDwell,
  vehicleReachedBoardStop
} from '../../../lib/util/go-mode/riding'
import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import fixture from '../../../lib/util/go-mode/replay/fixtures/orange-line-0729.json'

/**
 * Which bus the rider is on — the 2026-07-29 Orange Line replay (backlog 6.28).
 *
 * `scripts/verify-transit-trust.js` assertion c has never been green. Before
 * the board gate (`99001e54`) it reported `boarded 1:1173133/null`: the right
 * trip, named by the itinerary, with no bus behind it. After the board gate it
 * reported `boarded 1:1082792/1:8141` — a real bus, and the WRONG one, the
 * opposite-direction Orange Line across I-35W that caused the whole 7/29
 * incident in the first place.
 *
 * Both readings are the same defect seen from two sides, and it is not the
 * board gate's tests being wrong — it is two things the gate did not separate:
 *
 *   1. The board-stop dwell was a live condition rather than a completed fact,
 *      so it was erased the instant the bus pulled away — 550 m before GPS
 *      establishment could use it. On any leg longer than ~2.4 km that makes
 *      GPS establishment impossible, and leaves the riding fact to whatever
 *      the vehicle feed happens to say.
 *   2. "May this match assert the rider is aboard" and "which bus is it" were
 *      answered by the same predicate, so a match that could not establish
 *      could not identify either — and the fact went in unevidenced.
 *
 * Every number below is read from the committed recording
 * (`orange-line-0729.json`, session `ms6m3bgy-0j7v94`), not hand-built.
 */

const f: any = fixture

/**
 * The bus leg: I-35W & 46th St Station -> I-35W & 98th St Station, 13,279 m.
 *
 * The recording's static itinerary names the 17:11 departure (trip
 * 1:1171228); by the time the rider boarded, three missed-bus auto-updates had
 * moved them to the 17:20 run, which arrived 7 min late as vehicle 1:8140 on
 * trip 1:1173133 — the identity `verify-transit-trust.js` asserts. Only the
 * trip id differs between the two, so the recorded geometry and stop calls are
 * used as they stand.
 */
const BUS_LEG: any = {
  ...f.itinerary.legs[1],
  trip: { gtfsId: '1:1173133' },
  tripId: '1:1173133'
}

const BOARD_STOP = BUS_LEG.from

/** The bus the rider actually caught, 17:28:48 (feed record, verbatim). */
const RIDDEN_BUS = {
  confidence: 'high' as const,
  directionId: null,
  distanceMeters: 125,
  label: '8140',
  lastSeen: 1785364128326,
  nextStopId: '1:53543',
  routeId: '1:904',
  tripHeadsign: 'Orange Burnsville',
  tripId: '1:1173133',
  vehicleId: '1:8140'
}

/**
 * The opposing bus, same snapshot (feed record, verbatim). Northbound: its
 * next stop is 1:53542, the other platform at 46th St. `heading: null` and no
 * `directionId`, which is why both of the matcher's direction gates were inert
 * and it won the match at 559 m over a 44-second-stale record of 8140.
 */
const OPPOSING_BUS = {
  confidence: 'high' as const,
  directionId: null,
  distanceMeters: 559,
  label: '8141',
  lastSeen: 1785364128326,
  nextStopId: '1:53542',
  routeId: '1:904',
  tripHeadsign: 'Orange Downtown Minneapolis',
  tripId: '1:1082792',
  vehicleId: '1:8141'
}

/** 17:28:34, the first fix past RIDING_MIN_PROGRESS along the leg. */
const ABOARD_FIX = {
  accuracy: 3.4712940596251824,
  lat: 44.91346751158671,
  lon: -93.27492423133016,
  speed: 20.606561034276524,
  tMs: 1785364114000
}

const onLeg = (over: any = {}) => ({
  distanceFromRoute: 8,
  isOnRoute: true,
  legIndex: 1,
  nearestPoint: [ABOARD_FIX.lat, ABOARD_FIX.lon] as [number, number],
  progressAlongLeg: 0.0671,
  progressAlongSegment: 0.5,
  segmentIndex: 20,
  ...over
})

/** The real dwell, folded from the real track exactly as the action does. */
function dwellAt(untilMs: number) {
  let dwell = null
  for (const p of f.gpsTrack) {
    if (p.tMs > untilMs) break
    dwell = trackBoardStopDwell(dwell, {
      distanceToBoardStopM: calculateDistance(
        p.lat,
        p.lon,
        BOARD_STOP.lat,
        BOARD_STOP.lon
      ),
      legIndex: 1,
      nowMs: p.tMs
    })
  }
  return dwell
}

const decide = (over: any = {}) =>
  decideRiding({
    boardStopDwellMs: dwellAt(ABOARD_FIX.tMs)?.dwellMs ?? null,
    fixAccuracyM: ABOARD_FIX.accuracy,
    matchedLeg: BUS_LEG,
    nowMs: ABOARD_FIX.tMs,
    offRouteClearMs: 90000,
    prevRiding: null,
    riderSpeedMps: ABOARD_FIX.speed,
    routeMatch: onLeg(),
    vehicleMatch: { consecutiveMatches: 4, match: RIDDEN_BUS },
    ...over
  })

describe('util > go-mode > riding identity on the 2026-07-29 ride', () => {
  describe('the wait is a fact about the leg, not a live condition', () => {
    it('the rider really did wait at the boarding stop — 332 s of it', () => {
      // 17:20:39 -> 17:28:03 within BOARD_STOP_DWELL_RADIUS_M of 1:53543.
      expect(BOARD_STOP.stopId).toBe('1:53543')
      const atDeparture = dwellAt(1785364083000) // 17:28:03
      expect(atDeparture?.dwellMs).toBeGreaterThanOrEqual(
        BOARD_STOP_DWELL_MIN_MS
      )
      expect(Math.round((atDeparture?.dwellMs ?? 0) / 1000)).toBe(332)
    })

    // FAILS AGAINST UNFIXED SOURCE: null. The dwell was discarded the moment
    // the bus pulled away from the kerb.
    it('and the wait survives the bus pulling away', () => {
      expect(dwellAt(ABOARD_FIX.tMs)?.dwellMs).toBeGreaterThanOrEqual(
        BOARD_STOP_DWELL_MIN_MS
      )
    })

    it('because otherwise the two GPS conditions cannot both hold', () => {
      // RIDING_MIN_PROGRESS of this leg is 664 m down the freeway; the dwell
      // radius is 120 m. Without the latch, every transit leg longer than
      // BOARD_STOP_DWELL_RADIUS_M / RIDING_MIN_PROGRESS can never be boarded
      // from GPS at all.
      expect(Math.round(BUS_LEG.distance)).toBe(13279)
      expect(BUS_LEG.distance * RIDING_MIN_PROGRESS).toBeGreaterThan(
        BOARD_STOP_DWELL_RADIUS_M
      )
    })
  })

  describe('a vehicle going somewhere else is not this bus', () => {
    it('the opposing run never names a stop on the leg', () => {
      expect(matchServesLegStops(OPPOSING_BUS, BUS_LEG)).toBe(false)
      // Its next four, in order, through the rest of the recording.
      for (const nextStopId of ['1:17780', '1:53311', '1:53313', '1:53314']) {
        expect(matchServesLegStops({ nextStopId }, BUS_LEG)).toBe(false)
      }
    })

    it('the ridden run names nothing else — the leg’s five calls in order', () => {
      for (const nextStopId of [
        '1:53543',
        '1:52719',
        '1:56832',
        '1:56884',
        '1:56833'
      ]) {
        expect(matchServesLegStops({ nextStopId }, BUS_LEG)).toBe(true)
      }
    })

    it('and says nothing when the data is not there', () => {
      expect(matchServesLegStops({ nextStopId: null }, BUS_LEG)).toBe(true)
      expect(matchServesLegStops(OPPOSING_BUS, null)).toBe(true)
      // A leg that does not enumerate its calls cannot rule a stop out: "not
      // in the list" would be a statement about the recording, not the bus.
      expect(
        matchServesLegStops(OPPOSING_BUS, {
          ...BUS_LEG,
          intermediateStops: []
        } as any)
      ).toBe(true)
    })
  })

  describe('establishing the ride names the bus the rider is on', () => {
    // FAILS AGAINST UNFIXED SOURCE: { kind: 'none' } — the dwell had been
    // erased 31 s earlier, and the board-stop gate refused 8140 because its
    // 44-second-stale feed record still named the rider's own stop.
    it('boards 1:1173133/1:8140 at 17:28:34', () => {
      const d = decide()
      expect(d.kind).toBe('set')
      expect(d.kind === 'set' && d.riding.tripId).toBe('1:1173133')
      expect(d.kind === 'set' && d.riding.vehicleId).toBe('1:8140')
      expect(d.kind === 'set' && d.riding.boardedAt).toBe(ABOARD_FIX.tMs)
    })

    it('even though that match may not establish the ride by itself', () => {
      // The distinction the fix rests on: 8140's record still named 1:53543,
      // so it could not assert aboard-ness — but it is still the answer to
      // "which bus". Naming a bus is not asserting a boarding.
      expect(vehicleReachedBoardStop(RIDDEN_BUS, BUS_LEG)).toBe(false)
      const gpsOnly = decide({ vehicleMatch: null })
      expect(gpsOnly.kind).toBe('set')
      expect(gpsOnly.kind === 'set' && gpsOnly.riding.vehicleId).toBeNull()
    })

    // FAILS AGAINST UNFIXED SOURCE: { kind: 'set' } naming 1:1082792/1:8141 —
    // `FAIL c. riding stays 1:1173133/1:8140 while aboard — boarded
    // 1:1082792/1:8141`, reproduced byte-identically across two full replays.
    it('refuses to be established by the opposing run at 17:28:50', () => {
      const d = decide({
        nowMs: 1785364130000,
        vehicleMatch: { consecutiveMatches: 2, match: OPPOSING_BUS }
      })
      expect(d.kind).toBe('set')
      expect(d.kind === 'set' && d.riding.tripId).toBe('1:1173133')
      expect(d.kind === 'set' && d.riding.vehicleId).toBeNull()
    })

    it('and does not rename a ride already established on the right bus', () => {
      const established = {
        boardedAt: ABOARD_FIX.tMs,
        headsign: BUS_LEG.headsign,
        legIndex: 1,
        offRouteSince: null,
        routeId: '1:904',
        routeShortName: BUS_LEG.routeShortName ?? null,
        tripId: '1:1173133',
        vehicleId: '1:8140'
      }
      const d = decide({
        nowMs: 1785364130000,
        prevRiding: established,
        vehicleMatch: { consecutiveMatches: 2, match: OPPOSING_BUS }
      })
      // Nothing to record: the flap changes neither trip nor vehicle.
      expect(d.kind).toBe('none')
    })
  })
})
