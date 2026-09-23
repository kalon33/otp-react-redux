import fs from 'fs'
import path from 'path'

import {
  CardDepartureReason,
  departuresInBoardingDirection,
  getRouteDepartures,
  getSoonestCatchableMs,
  HeldDeparture,
  legBoardingDirection,
  resolveCardDeparture,
  RouteDeparture
} from '../../../lib/util/go-mode/departure-anchor'
import {
  patternDirectionId,
  tripGtfsId
} from '../../../lib/util/go-mode/trip-id'

/**
 * Backlog 19.1, third sighting and the mechanism. Session `mubq7tfx-8dz3ar`,
 * 2026-09-21 16:05 ride, dev bundle `2026.0920.1`. Rider note 16:17:55 — *"It
 * did not in fact depart"* — over a screenshot of the card reading
 * "465 · 4:16 PM · departed / Next: 4:22 PM".
 *
 * I-35W & 98th Street Station Gate E (`2:51825`) serves BOTH 465 patterns.
 * `getRouteDepartures` filtered the stop's departures on `routeId` alone, so
 * at 16:15:31 its candidate list was exactly:
 *
 *   16:18:20 LIVE  South to Burnsville TS  2:465:1:01  2:t609-b15C-sl1C-v64
 *   16:21:02 LIVE  North to UMN            2:465:0:01  2:t64A-b156-sl1C-v64
 *
 * — the rider's own leg being the second. The southbound was 162 s earlier
 * than the northbound the card was holding, which clears
 * AUTO_ANCHOR_MIN_GAIN_MS, so `resolveCardDeparture` adopted it:
 * `CARD_DEPARTURE_MISMATCH` 16:15:31 `reason: 'adopted-earlier'`,
 * `heldTripId: VHJpcDoyOnQ2MDktYjE1Qy1zbDFDLXY2NA` (= `Trip:2:t609-b15C-sl1C
 * -v64`), `cardDepartureMs` 16:18:20 against a tick on 16:19:52. Five further
 * `held` records carried it to 16:17:34. Vehicle 4834 (directionId 1) passed
 * the gate at 16:17:18 and the card said "departed", while the rider's
 * northbound 4051 was five kilometres south and boarded at ~16:23:30.
 *
 * The recorded records, straight out of `~/otp-debug-logs/debug-2026-09-21
 * .jsonl` for that session, reasons in order from 16:12:05 to 16:23:01:
 *
 *   held held held | adopted-earlier held held held held held | held x6
 *          t64A                 t609 (six records, 2m03s)        t64A
 *
 * The fixture is 13.7 MB and untracked, so everything here skips when it is
 * absent.
 */

const FIXTURE_PATH = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/0921-1605-465-wrongdir.json'
)

const fixture: any = fs.existsSync(FIXTURE_PATH)
  ? JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))
  : null

const withFixture = fixture ? describe : describe.skip

const ROUTE_ID = '2:465'
const GATE_E = '2:51825'
/** The rider's run: 465 North to UMN, the itinerary's own transit leg. */
const NORTHBOUND = '2:t64A-b156-sl1C-v64'
/** The other one at the same gate: 465 South to Burnsville TS. */
const SOUTHBOUND = '2:t609-b15C-sl1C-v64'
/** The CARD_DEPARTURE_MISMATCH that named the southbound. */
const ADOPTED_AT = 1790025331216

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

const boardingLeg = () =>
  (fixture?.itinerary?.legs || []).find((l: any) => l.transitLeg)

/** Every Gate E stop-times snapshot the ride recorded, in order. */
const gateSnapshots = () =>
  (fixture?.stopTimeSnapshots || [])
    .filter((s: any) => s.stopId === GATE_E)
    .sort((a: any, b: any) => a.tMs - b.tMs)

/** The snapshot in force at `atMs` — what the store held that second. */
const snapshotAt = (atMs: number) => {
  let best: any = null
  for (const s of gateSnapshots()) {
    if (s.tMs <= atMs && (!best || s.tMs > best.tMs)) best = s
  }
  return best ?? gateSnapshots()[0]
}

/**
 * The card's own loop over the ride, one pass per recorded poll — the same
 * three calls WalkingNavigation makes every render, with the hold carried
 * between them exactly as `holdRef` carries it.
 *
 * `rideSecondsRemaining: 0` is the rider standing at the gate, which is where
 * they were: it reproduces the recording's own numbers (the 16:15:31 pass
 * picks 16:18:20 and adopts, as the debug stream says it did).
 *
 * `directionAware` / `tickTripId` are the two arguments this branch adds. With
 * both off, every call below is byte-for-byte the pre-fix behaviour.
 */
function runCard(opts: { directionAware: boolean; tickAware: boolean }) {
  const leg = boardingLeg()
  const boarding = opts.directionAware ? legBoardingDirection(leg) : undefined
  const tickTripId = opts.tickAware ? legBoardingDirection(leg).tripId : null
  let held: HeldDeparture | null = null
  const log: Array<{
    heldTripId: string | null
    reason: CardDepartureReason
    tMs: number
  }> = []
  for (const snap of gateSnapshots()) {
    const departures = getRouteDepartures(snap.payload, ROUTE_ID, boarding)
    const decision = resolveCardDeparture({
      candidateMs: getSoonestCatchableMs(departures, snap.tMs, 0),
      departures,
      held,
      nowMs: snap.tMs,
      plannedDepartureMs: Number(leg.startTime),
      tickTripId
    })
    held = decision.held
    log.push({
      heldTripId: tripGtfsId(decision.held?.tripId),
      reason: decision.reason,
      tMs: snap.tMs
    })
  }
  return log
}

const countReason = (log: any[], reason: string) =>
  log.filter((r) => r.reason === reason).length
const countHeld = (log: any[], tripId: string) =>
  log.filter((r) => r.heldTripId === tripId).length

withFixture(
  'go-mode > the card must not adopt the other direction (19.1)',
  () => {
    it('is the ride the row describes', () => {
      expect(fixture.meta.session).toBe('mubq7tfx-8dz3ar')
      const leg = boardingLeg()
      expect(leg.route.gtfsId).toBe(ROUTE_ID)
      expect(leg.trip.gtfsId).toBe(NORTHBOUND)
      expect(leg.headsign).toBe('North to UMN')
      expect(leg.from.stop.gtfsId).toBe(GATE_E)
      expect(hhmmss(Number(leg.startTime))).toBe('16:17:00')
    })

    it('the leg carries a headsign and a trip — and no directionId at all', () => {
      // The row said the leg carries `directionId`. It does not: `leg.trip` comes
      // back from the plan query with exactly these four fields, and there is no
      // `pattern` on it either. The headsign and the trip id are the whole of
      // what the leg knows about which way its bus goes.
      const leg = boardingLeg()
      expect(Object.keys(leg.trip).sort()).toEqual([
        'arrivalStoptime',
        'departureStoptime',
        'gtfsId',
        'id'
      ])
      expect((leg as any).directionId).toBeUndefined()
      expect(legBoardingDirection(leg)).toEqual({
        headsign: 'North to UMN',
        tripId: NORTHBOUND
      })
    })

    it('the gate really does serve both directions', () => {
      const snap = snapshotAt(ADOPTED_AT)
      const patterns = snap.payload.stoptimesForPatterns.map(
        (p: any) => `${p.pattern.id}|${p.pattern.headsign}`
      )
      expect(patterns.sort()).toEqual([
        '2:465:0:01|North to UMN',
        '2:465:0:02|North to UMN',
        '2:465:1:01|South to Burnsville TS',
        '2:465:1:02|South to Burnsville TS'
      ])
    })

    describe('the candidate list at 16:15:31', () => {
      const at = () => snapshotAt(ADOPTED_AT)

      it('BEFORE: routeId alone puts the southbound in front of the rider', () => {
        const all = getRouteDepartures(at().payload, ROUTE_ID)
        // The next two runs of the route at this gate, in order.
        const soon = all.filter((d) => d.depMs >= ADOPTED_AT).slice(0, 2)
        expect(
          soon.map((d) => [
            hhmmss(d.depMs),
            d.headsign,
            d.directionId,
            tripGtfsId(d.tripId)
          ])
        ).toEqual([
          ['16:18:20', 'South to Burnsville TS', '1', SOUTHBOUND],
          ['16:21:02', 'North to UMN', '0', NORTHBOUND]
        ])
        // 162 s earlier than the rider's own run — over AUTO_ANCHOR_MIN_GAIN_MS,
        // which is the whole of why it was adopted.
        expect(soon[1].depMs - soon[0].depMs).toBe(162000)
      })

      it('AFTER: only the direction the rider is going survives', () => {
        const mine = getRouteDepartures(
          at().payload,
          ROUTE_ID,
          legBoardingDirection(boardingLeg())
        )
        expect(mine.every((d) => d.directionId === '0')).toBe(true)
        expect(mine.every((d) => d.headsign === 'North to UMN')).toBe(true)
        expect(mine.some((d) => tripGtfsId(d.tripId) === SOUTHBOUND)).toBe(
          false
        )
        expect(mine.some((d) => tripGtfsId(d.tripId) === NORTHBOUND)).toBe(true)
        // The soonest thing the projection can now offer IS the rider's bus.
        expect(
          hhmmss(getSoonestCatchableMs(mine, ADOPTED_AT, 0) as number)
        ).toBe('16:21:02')
      })
    })

    describe('the card over the whole 16:07:39 - 16:23:01 window', () => {
      it('BEFORE: adopts the southbound, at the recorded second', () => {
        const log = runCard({ directionAware: false, tickAware: false })
        expect(log.length).toBe(46)
        expect(countReason(log, 'adopted-earlier')).toBe(1)
        const adopted = log.find((r) => r.reason === 'adopted-earlier')!
        expect(hhmmss(adopted.tMs)).toBe('16:15:31')
        expect(adopted.heldTripId).toBe(SOUTHBOUND)
        // ...and keeps it for the rest of the window: 23 of the 46 passes name
        // the wrong bus. The live ride let it go after six records (16:15:31 ->
        // 16:17:34) because the real card also carries the missed-bus verdict
        // and a non-zero ride time, neither of which this pure loop has — the
        // loop is the same decision function on the same feed, and it is
        // stricter about the defect, not looser.
        expect(countHeld(log, SOUTHBOUND)).toBe(23)
        const last = [...log]
          .reverse()
          .find((r) => r.heldTripId === SOUTHBOUND)!
        expect(hhmmss(last.tMs)).toBe('16:23:01')
      })

      it('AFTER: the southbound is never adopted and never held', () => {
        const log = runCard({ directionAware: true, tickAware: true })
        expect(log.length).toBe(46)
        expect(countHeld(log, SOUTHBOUND)).toBe(0)
        expect(countReason(log, 'adopted-earlier')).toBe(0)
        // ...and the card is on the rider's own run wherever it holds one.
        const namedRuns = new Set(
          log.map((r) => r.heldTripId).filter(Boolean) as string[]
        )
        expect([...namedRuns]).toEqual([NORTHBOUND])
      })

      it('AFTER: the direction filter alone is enough for this ride', () => {
        // `tickTripId` is the 23.3 half; it must not be what is carrying 19.1.
        const log = runCard({ directionAware: true, tickAware: false })
        expect(countHeld(log, SOUTHBOUND)).toBe(0)
        expect(countReason(log, 'adopted-earlier')).toBe(0)
      })
    })
  }
)

describe('go-mode > departuresInBoardingDirection', () => {
  const dep = (
    depMs: number,
    directionId: string | null,
    headsign: string | null,
    tripId: string
  ): RouteDeparture => ({
    depMs,
    directionId,
    headsign,
    realtime: true,
    routeId: '2:465',
    tripId
  })
  const north = dep(2000, '0', 'North to UMN', 'n1')
  const northVariant = dep(4000, '0', 'North to UMN', 'n2')
  const south = dep(1000, '1', 'South to Burnsville TS', 's1')

  it('uses the direction of the pattern the boarding trip is filed under', () => {
    expect(
      departuresInBoardingDirection([south, north, northVariant], {
        headsign: null,
        tripId: 'n1'
      })
    ).toEqual([north, northVariant])
  })

  it('keeps BOTH variants of a direction — an express is the same bus', () => {
    const byHeadsign = departuresInBoardingDirection(
      [south, north, northVariant],
      { headsign: 'North to UMN', tripId: null }
    )
    expect(byHeadsign).toEqual([north, northVariant])
  })

  it('matches a headsign loosely enough for case and padding', () => {
    expect(
      departuresInBoardingDirection([south, north], {
        headsign: '  north to umn ',
        tripId: null
      })
    ).toEqual([north])
  })

  it('leaves a single-direction stop alone whatever the leg says', () => {
    // I-35W & Lake St publishes one 904 headsign, and a leg headsign that does
    // not match it is a spelling difference, not a wrong bus. Filtering there
    // would blind the anchor for nothing.
    const only = [dep(1000, '1', 'ORANGE Burnsville', 't1')]
    expect(
      departuresInBoardingDirection(only, {
        headsign: 'Orange Line to Burnsville',
        tripId: null
      })
    ).toEqual(only)
  })

  it('offers nothing rather than the other way, where directions differ', () => {
    // A stop publishing two directions and a leg headsign matching neither:
    // there is no honest candidate here, and an empty list sends the card back
    // to the planned departure, which is the rider's own bus. The one thing it
    // may never do is hand back the southbound.
    expect(
      departuresInBoardingDirection([south, north], {
        headsign: 'North to Roseville',
        tripId: null
      })
    ).toEqual([])
  })

  it('never reaches across when this direction has run out of buses', () => {
    const laterSouth = dep(9000, '1', 'South to Burnsville TS', 's2')
    expect(
      departuresInBoardingDirection([south, north, laterSouth], {
        headsign: null,
        tripId: 'n1'
      })
    ).toEqual([north])
  })

  it('does nothing at all with nothing to go on', () => {
    const all = [south, north]
    expect(
      departuresInBoardingDirection(all, { headsign: null, tripId: null })
    ).toEqual(all)
    expect(departuresInBoardingDirection(all, null)).toEqual(all)
  })

  it('matches the leg trip across the relay/gtfsId spellings', () => {
    // The stop query names trips `VHJpcDoxOjEyNjg5NTI`; the leg names them
    // `1:1268952` (backlog 21.1's third correction).
    const relay = dep(2000, '0', 'North to UMN', 'VHJpcDoxOjEyNjg5NTI')
    expect(
      departuresInBoardingDirection([south, relay], {
        headsign: null,
        tripId: '1:1268952'
      })
    ).toEqual([relay])
  })
})

describe('go-mode > patternDirectionId', () => {
  it('reads the direction out of both spellings', () => {
    expect(patternDirectionId('2:465:0:01')).toBe('0')
    expect(patternDirectionId('2:465:1:02')).toBe('1')
    expect(patternDirectionId('UGF0dGVybjoyOjQ2NTowOjAx')).toBe('0')
    expect(patternDirectionId('UGF0dGVybjoyOjQ2NToxOjAx')).toBe('1')
  })

  it('says nothing rather than guess', () => {
    expect(patternDirectionId(null)).toBeNull()
    expect(patternDirectionId('')).toBeNull()
    expect(patternDirectionId('2:465')).toBeNull()
    expect(patternDirectionId('VHJpcDoxOjEyNjg5NTI')).toBeNull()
  })
})
