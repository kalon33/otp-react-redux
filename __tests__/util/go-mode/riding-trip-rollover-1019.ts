import { existsSync, readFileSync } from 'fs'
import path from 'path'

import {
  decideRiding,
  matchTripIsRollover,
  RIDING_ALONG_LEG_MAX_DEG,
  RIDING_ESTABLISH_MIN_SPEED_MPS
} from '../../../lib/util/go-mode/riding'
import { matchPositionToRoute } from '../../../lib/util/go-mode/position-matching'
import type { RidingState } from '../../../lib/util/go-mode/types'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'

/**
 * Backlog 62.1 — the app followed the bus's PREVIOUS trip.
 *
 * 2026-10-19 (session mvfqu4i0-yd2epd, fixture `green-465-1657.json`): the
 * rider boarded MVTA 465 bus 2:4054 at Oak St SE & Washington Ave SE for the
 * plan's run 2:t6B2-b156-sl1C-v64 "South to Burnsville TS". The feed had not
 * rolled the bus over yet — every 4054 record from 17:09:34 to 17:19:05 still
 * names 2:t64A-b156-sl1C-v64 "North to UMN" (direction 0, no next stop), the
 * run the bus had just finished; the same block (342-v64) runs t6B2 next, and
 * the first t6B2 record is the 17:19:21 snapshot (direction 1, next stop
 * 2:41248, the rider's own stop).
 *
 * `decideRiding` let the match name the trip, so SET_RIDING 17:18:04 carried
 * the feed's t64A with the plan's headsign. The first establishment was
 * corroborated by speed (rider 3.08 m/s > RIDING_ESTABLISH_MIN_SPEED_MPS), not
 * by headsign, which contradicted the leg. For 79 s the leg's live times read
 * `realtime:false` and at 17:19:23 the fact flipped to t6B2 on the same bus
 * and boardedAt — the daemon's riding-flip page.
 *
 * ## The measurement (both fixtures, decideRiding replayed tick by tick)
 *
 * Candidates the plan named, measured at the 17:18:04 decision:
 *
 *  (a) "feed headsign contradicts the leg while the feed's heading/direction
 *      agree with it" — does NOT fire. The feed record behind the decision
 *      (frame 17:17:25) has `directionId "0"` against the plan trip's "1"
 *      (both read from the fixture's trip snapshots) and `heading 184` at
 *      speed 0 against the leg's 90° first segment, 94° apart. The feed's
 *      direction agrees with its own stale headsign, not with the leg.
 *  (b) "the feed trip's last stop is the leg's board stop" — does NOT fire.
 *      t64A's 13 calls end at 2:16154 "4 St SE & Ridder Arena"; the board
 *      stop 2:41248 is not among them. It also needs a trip fetch the
 *      decision does not have (the t64A trip snapshot lands 17:18:09, after
 *      the SET_RIDING it would have to prevent).
 *
 * What does separate them is the RIDER's own motion: at 17:18:04 the rider
 * is carried at 3.08 m/s on heading 275° along a leg segment bearing 277° —
 * 2° apart. A rider truly aboard an opposite-direction bus (the 2026-08-27
 * inbound 94, riding-decision.ts) is carried AGAINST the leg's bearing. So
 * the discriminator is: feed headsign contradicts the leg AND the rider is
 * carried within RIDING_ALONG_LEG_MAX_DEG of the leg's own bearing → the
 * match names its vehicle but not its trip (matchTripIsRollover).
 *
 * The control, `0921-1605-465-wrongdir.json` (2026-09-21, bus 2:4051), plans
 * and boards t64A itself: the feed's trip IS the plan's, headsigns agree, and
 * the feed trip must still be named. It cannot exercise the contradicting
 * case, so the opposite-direction controls are the synthetic cases below.
 *
 * The 09-21 / 10-19 recordings are 13 MB each and deliberately NOT committed;
 * the fixture blocks skip when they are absent.
 */

const FIXTURE_DIR = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)
const ROLLOVER = 'green-465-1657.json'
const CONTROL = '0921-1605-465-wrongdir.json'

const load = (name: string): any => {
  const p = path.join(FIXTURE_DIR, name)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

const describeIf = (name: string) =>
  existsSync(path.join(FIXTURE_DIR, name)) ? describe : describe.skip

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

const PLAN_TRIP = '2:t6B2-b156-sl1C-v64'
const FEED_TRIP = '2:t64A-b156-sl1C-v64'

interface SetEvent {
  at: string
  tripId: string | null
  vehicleId: string | null
}

/**
 * Replay decideRiding over a window of the recording: the rider's own fixes
 * (one a second), matchPositionToRoute against the active itinerary, and the
 * named bus's latest feed record at each fix as the matcher's trusted match
 * (the matcher held it at `high` from the second tick on; ticks and distinct
 * frames are counted the way performVehicleMatching counts them).
 */
function replay(
  f: any,
  legs: any[],
  vehicleId: string,
  fromMs: number,
  toMs: number
): SetEvent[] {
  const snaps = f.vehicleSnapshots
    .map((s: any) => ({
      tMs: s.tMs,
      v: (s.payload?.vehicles ?? []).find((v: any) => v.vehicleId === vehicleId)
    }))
    .filter((s: any) => s.v)
  const fixes = f.gpsTrack.filter((g: any) => g.tMs >= fromMs && g.tMs <= toMs)

  let routeMatch: RouteMatchResult | null = null
  let prevRiding: RidingState | null = null
  let ticks = 0
  let frames = 0
  let lastFrame: number | null = null
  const sets: SetEvent[] = []
  for (const fix of fixes) {
    routeMatch = matchPositionToRoute(
      [fix.lat, fix.lon],
      legs,
      routeMatch?.legIndex ?? 1,
      routeMatch,
      { accuracyM: fix.accuracy, nowMs: fix.tMs }
    )
    if (!routeMatch) continue
    const rec = [...snaps].reverse().find((s: any) => s.tMs <= fix.tMs)?.v
    let vehicleMatch = null
    if (rec) {
      ticks++
      if (rec.seconds !== lastFrame) frames++
      lastFrame = rec.seconds
      vehicleMatch = {
        consecutiveFrames: frames,
        consecutiveMatches: ticks,
        match: {
          confidence: ticks > 1 ? ('high' as const) : ('medium' as const),
          directionId: rec.directionId,
          distanceMeters: 25,
          heading: rec.heading,
          label: rec.label,
          lastSeen: fix.tMs,
          nextStopId: rec.nextStopId ?? null,
          routeId: rec.routeId,
          stopStatus: rec.stopStatus ?? null,
          tripHeadsign: rec.tripHeadsign,
          tripId: rec.tripId,
          vehicleId: rec.vehicleId
        }
      }
    }
    const decision = decideRiding({
      boardStopDwellMs: null,
      fixAccuracyM: fix.accuracy,
      matchedLeg: legs[routeMatch.legIndex],
      nowMs: fix.tMs,
      offRouteClearMs: 90000,
      prevRiding,
      riderHeadingDeg: fix.heading ?? null,
      riderSpeedMps: fix.speed ?? null,
      routeMatch,
      vehicleMatch
    } as any)
    if (decision.kind === 'set') {
      if (
        prevRiding?.tripId !== decision.riding.tripId ||
        prevRiding?.vehicleId !== decision.riding.vehicleId
      ) {
        sets.push({
          at: hhmmss(fix.tMs),
          tripId: decision.riding.tripId,
          vehicleId: decision.riding.vehicleId
        })
      }
      prevRiding = decision.riding
    } else if (decision.kind === 'clear') {
      prevRiding = null
    }
  }
  return sets
}

describe('util > go-mode > riding trip rollover (62.1)', () => {
  describeIf(ROLLOVER)(
    '2026-10-19, 465 bus 4054 still labelled North to UMN',
    () => {
      const f = load(ROLLOVER)
      // The itinerary active at 17:18 (swap of 17:13:06): bike, 465, bike.
      const legs = f?.itinerarySwaps?.[1]?.itinerary?.legs ?? []

      it('the recording is the one this row was measured on', () => {
        expect(f.meta.session).toBe('mvfqu4i0-yd2epd')
        expect(legs[1].trip.gtfsId).toBe(PLAN_TRIP)
        expect(legs[1].headsign).toBe('South to Burnsville TS')
        expect(legs[1].from.stopId).toBe('2:41248')
      })

      it('(b) is inert: the feed trip does not end at — or call at — the board stop', () => {
        const t64a = f.tripSnapshots.find(
          (s: any) => s.payload?.id === FEED_TRIP
        ).payload
        const calls = t64a.stopTimes.map((st: any) => st.stop.id)
        expect(calls).toHaveLength(13)
        expect(calls[calls.length - 1]).toBe('2:16154')
        expect(calls).not.toContain('2:41248')
        // The two trips are one bus's consecutive runs — the rollover itself.
        const t6b2 = f.tripSnapshots.find(
          (s: any) => s.payload?.id === PLAN_TRIP
        ).payload
        expect(t64a.blockId).toBe(t6b2.blockId)
        expect([t64a.directionId, t6b2.directionId]).toEqual(['0', '1'])
      })

      it('names the plan trip at establishment and never flips, 17:17:50-17:19:30', () => {
        const sets = replay(f, legs, '2:4054', 1792448270000, 1792448370000)
        // Before 62.1: [{17:18:04, t64A, 4054}, {17:19:2x, t6B2, 4054}].
        expect(sets).toEqual([
          { at: '17:18:04', tripId: PLAN_TRIP, vehicleId: '2:4054' }
        ])
      })
    }
  )

  describeIf(CONTROL)('control: 2026-09-21, the plan IS the feed trip', () => {
    const f = load(CONTROL)
    const legs = f?.itinerarySwaps?.[1]?.itinerary?.legs ?? []

    it('still names the feed trip and bus', () => {
      expect(legs[1].trip.gtfsId).toBe(FEED_TRIP)
      expect(legs[1].headsign).toBe('North to UMN')
      const sets = replay(f, legs, '2:4051', 1790025780000, 1790025830000)
      expect(sets.length).toBeGreaterThanOrEqual(1)
      expect(sets[0]).toMatchObject({ tripId: FEED_TRIP, vehicleId: '2:4051' })
      expect(sets.every((s) => s.tripId === FEED_TRIP)).toBe(true)
    })
  })

  describe('matchTripIsRollover — the discriminator, synthetic', () => {
    // A straight east-west leg: polyline of (44.9737,-93.2271) -> (44.9737,-93.2371),
    // bearing ~270 (westbound), like the 465's Washington Ave start.
    const westLeg: any = {
      headsign: 'South to Burnsville TS',
      legGeometry: { points: 's|nqGjl_xP?n}@' },
      routeId: '2:465',
      transitLeg: true,
      trip: { gtfsId: PLAN_TRIP }
    }
    const rm: any = { segmentIndex: 0 }
    const carried = RIDING_ESTABLISH_MIN_SPEED_MPS + 0.08
    const stale = { tripHeadsign: 'North to UMN', tripId: FEED_TRIP }
    const base = {
      match: stale,
      matchedLeg: westLeg,
      riderHeadingDeg: 275,
      riderSpeedMps: carried,
      routeMatch: rm
    }

    it('fires on the 10-19 signature', () => {
      expect(matchTripIsRollover(base)).toBe(true)
    })

    it('does not fire when the rider is carried AGAINST the leg (a wrong-way bus)', () => {
      expect(matchTripIsRollover({ ...base, riderHeadingDeg: 95 })).toBe(false)
      expect(
        matchTripIsRollover({
          ...base,
          riderHeadingDeg: 270 + RIDING_ALONG_LEG_MAX_DEG + 5
        })
      ).toBe(false)
    })

    it('does not fire when headsigns agree (an earlier run of the same service)', () => {
      expect(
        matchTripIsRollover({
          ...base,
          match: {
            tripHeadsign: 'south to burnsville ts ',
            tripId: '2:earlier'
          }
        })
      ).toBe(false)
    })

    it('does not fire on missing data — heading, speed, headsign or geometry', () => {
      expect(matchTripIsRollover({ ...base, riderHeadingDeg: null })).toBe(
        false
      )
      expect(matchTripIsRollover({ ...base, riderHeadingDeg: -1 })).toBe(false)
      expect(matchTripIsRollover({ ...base, riderSpeedMps: 1.2 })).toBe(false)
      expect(
        matchTripIsRollover({
          ...base,
          match: { tripHeadsign: null, tripId: FEED_TRIP }
        })
      ).toBe(false)
      expect(
        matchTripIsRollover({
          ...base,
          matchedLeg: { ...westLeg, legGeometry: undefined }
        })
      ).toBe(false)
    })

    it('does not fire when the match already names the plan trip', () => {
      expect(
        matchTripIsRollover({
          ...base,
          match: { tripHeadsign: 'North to UMN', tripId: PLAN_TRIP }
        })
      ).toBe(false)
    })
  })

  describe('decideRiding — only the NAME changes', () => {
    const westLeg: any = {
      from: { stopId: '2:41248' },
      headsign: 'South to Burnsville TS',
      legGeometry: { points: 's|nqGjl_xP?n}@' },
      mode: 'BUS',
      routeId: '2:465',
      routeShortName: '465',
      transitLeg: true,
      trip: { gtfsId: PLAN_TRIP }
    }
    const onLeg: any = {
      distanceFromRoute: 4,
      isOnRoute: true,
      legIndex: 1,
      nearestPoint: [44.9737, -93.2275],
      progressAlongLeg: 0.002,
      progressAlongSegment: 0.04,
      segmentIndex: 0
    }
    const feed = (over: any = {}) => ({
      consecutiveFrames: 3,
      consecutiveMatches: 14,
      match: {
        confidence: 'high',
        directionId: '0',
        distanceMeters: 31,
        heading: 184,
        label: '4054',
        lastSeen: 1792448284000,
        nextStopId: null,
        routeId: '2:465',
        tripHeadsign: 'North to UMN',
        tripId: FEED_TRIP,
        vehicleId: '2:4054',
        ...over
      }
    })
    const decide = (over: any = {}) =>
      decideRiding({
        boardStopDwellMs: null,
        matchedLeg: westLeg,
        nowMs: 1792448284095,
        offRouteClearMs: 90000,
        prevRiding: null,
        riderHeadingDeg: 275,
        riderSpeedMps: 3.08,
        routeMatch: onLeg,
        vehicleMatch: feed(),
        ...over
      } as any)

    it('the 17:18:04 tick: establishes on the same bus, names the plan trip', () => {
      const d = decide()
      expect(d.kind).toBe('set')
      expect(d.kind === 'set' && d.riding).toMatchObject({
        headsign: 'South to Burnsville TS',
        tripId: PLAN_TRIP,
        vehicleId: '2:4054'
      })
    })

    it('carried the other way, the feed trip is still named (the wrong-way bus is real)', () => {
      const d = decide({ riderHeadingDeg: 95 })
      expect(d.kind === 'set' && d.riding.tripId).toBe(FEED_TRIP)
    })

    it('with no heading at all, nothing changes from before', () => {
      const d = decide({ riderHeadingDeg: undefined })
      expect(d.kind === 'set' && d.riding.tripId).toBe(FEED_TRIP)
    })

    it('establishment is judged on the feed claim: standing still still refuses', () => {
      // The 2026-08-27 gate must not be bought by renaming: a contradicting
      // headsign at a standstill establishes nothing, rollover or not.
      expect(decide({ riderSpeedMps: 0.2 }).kind).toBe('none')
    })

    it('a held plan-trip fact is not rebound onto the stale label', () => {
      const prevRiding = {
        boardedAt: 1792448284095,
        headsign: 'South to Burnsville TS',
        legIndex: 1,
        offRouteSince: null,
        routeId: '2:465',
        routeShortName: '465',
        tripId: PLAN_TRIP,
        vehicleId: '2:4054'
      }
      expect(decide({ nowMs: 1792448300000, prevRiding }).kind).toBe('none')
    })
  })
})
