import type { Itinerary } from '@opentripplanner/types'

import {
  journeySignature,
  rankAlightOptions
} from '../../../lib/util/go-mode/alight-optimizer'

/**
 * Backlog 17.20 — "the honest best option was ranked into the five and then
 * lost on the way to the screen."
 *
 * Ride B, 2026-09-15, session `mu35fwv5-8lyyq1`, METRO Orange Line northbound
 * into downtown Minneapolis. Replayed from
 * `lib/util/go-mode/replay/fixtures/orange-onboard-1556.json` (1.2 MB, 10
 * candidate plans over two runs, the onboard flow captured); the fixture is
 * untracked in the shared checkout, as all of them are, so every figure below
 * is copied from the replay rather than imported.
 *
 * WHAT THE REPLAY SHOWS (run 2, candidate fetches 15:57:15–15:57:19, four of
 * five stops answered with 20 usable itineraries between them):
 *
 * Three of the plans out of `1:53314` (2nd Ave S & 5th St) ride the identical
 * chain — bike to Nicollet Mall, METRO Green Line `1:902` to Stadium Village,
 * bike to the door — and reach it at **16:25:39, 16:49:39 and 17:01:39**. They
 * are three different trains: `1:890194`, `1:900502`, `1:891229`. The earliest
 * of them is the earliest real arrival in the whole result set, and it came in
 * from the I-35W & Lake St candidate, re-anchored onto 5th St by
 * `foldSameRouteRelay` (15.4) because its first leg was a LATER Orange Line
 * trip the rider is already aboard for.
 *
 * `journeySignature` was `${stopId}#` + `mode:route:from>to` per leg and
 * **carried no time and no vehicle**, so all three produced the same string
 * and `rankAlightOptions`' dedupe kept exactly one — whichever the score had
 * ranked first. Under the score that shipped that day (15.9's
 * `busArrivalEpoch + duration`) that was the 16:49:39, so the 16:25:39 was
 * deleted 24 minutes before the rider ever saw a list. The recorded
 * `SET_ONBOARD_RESULT` at 15:57:19 confirms it: five options, none of them the
 * 16:25:39, and the replay reproduces those five exactly.
 *
 * WHAT WAS RULED OUT, and this is most of the row's value:
 * - NOT the ranker. `rankAlightOptions` scores and sorts the option correctly
 *   at every limit; the row's own probe found it returning it.
 * - NOT the five-option cap. It was inside the five under both scores.
 * - NOT a candidate failure. I-35W & Lake St answered with five itineraries.
 * - NOT `decorateAlightOptions`' collapse and NOT the splice, which is where
 *   the row pointed. Replayed on main `76f2599c7`, decoration is handed 14
 *   options and returns 13, and the one it drops is a genuine 6.44 duplicate
 *   (two anchors whose built journeys are one ride). It never touched this
 *   option.
 * - NOT 15.9, although 15.9 hides it. `540b5373b` reverses which of the three
 *   survives — the 16:25:39 now wins the dedupe and the 16:37:39 / 16:49:39 /
 *   17:01:39 are the ones deleted. Something is still deleted, the drill-down
 *   17.2 shipped a 20-option pool to fill still has nothing to show, and any
 *   future scoring nuance can put the wrong member back in the slot.
 *
 * THE FIX: the signature says which VEHICLE, not just which route. A genuine
 * duplicate — the same journey surfaced from two anchor stops — rides the same
 * trip ids and still collapses; the relay fold shifts only street legs, so it
 * cannot perturb the transit half. With neither a trip id nor a finite
 * `startTime` the signature is byte-for-byte what it was, so the change can
 * only ever separate options, never merge two that were distinct.
 */

/** A local wall-clock time on 2026-09-15 as an epoch (ms). CDT = UTC−5. */
const at = (hms: string): number => {
  const [h, m, s] = hms.split(':').map(Number)
  return Date.UTC(2026, 8, 15, h + 5, m, s || 0)
}

/** The signature that shipped, so a revert fails these tests rather than them. */
const legacySignature = (stopId: string, itinerary: Itinerary): string =>
  `${stopId}#${(itinerary.legs || [])
    .map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (l: any) =>
        `${l.mode}:${l.routeId || l.route?.id || ''}:${l.from?.name || ''}>${
          l.to?.name || ''
        }`
    )
    .join('|')}`

const bike = (
  startTime: number,
  endTime: number,
  from: string,
  to: string
) => ({
  distance: 1500,
  endTime,
  from: { name: from },
  mode: 'BICYCLE',
  startTime,
  to: { name: to }
})

/**
 * The Green Line leg, identified by its trip. Route `1:902` and the stop names
 * are the same on every train of the day; `1:890194` vs `1:900502` is the only
 * thing that distinguishes the 16:20 arrival at Stadium Village from the 16:44.
 */
const greenLine = (startTime: number, endTime: number, tripId: string) => ({
  distance: 6800,
  endTime,
  from: { name: 'Nicollet Mall Station' },
  mode: 'TRAM',
  route: { gtfsId: '1:902', id: '1:902' },
  routeId: '1:902',
  startTime,
  to: { name: 'Stadium Village Station' },
  transitLeg: true,
  trip: { gtfsId: tripId }
})

/**
 * One of the three plans out of 2nd Ave S & 5th St, with the times the replay
 * records. `duration` spans startTime → endTime, as OTP's do.
 */
const greenLinePlan = (
  bikeStart: string,
  trainStart: string,
  trainEnd: string,
  arrive: string,
  tripId: string
): Itinerary => {
  const legs = [
    bike(
      at(bikeStart),
      at(trainStart),
      '2nd Ave S & 5th St',
      'Nicollet Mall Station'
    ),
    greenLine(at(trainStart), at(trainEnd), tripId),
    bike(
      at(trainEnd),
      at(arrive),
      'Stadium Village Station',
      'Safelite AutoGlass'
    )
  ]
  return {
    duration: (at(arrive) - at(bikeStart)) / 1000,
    endTime: at(arrive),
    legs,
    startTime: at(bikeStart),
    transfers: 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Itinerary
}

/**
 * The three departures, exactly as the fixture's run-2 candidate plans carry
 * them. The 16:25:39 is the one that was deleted.
 */
const ARRIVE_1625 = greenLinePlan(
  '16:03:29',
  '16:10:00',
  '16:20:00',
  '16:25:39',
  '1:890194'
)
const ARRIVE_1649 = greenLinePlan(
  '16:32:29',
  '16:34:00',
  '16:44:00',
  '16:49:39',
  '1:900502'
)
const ARRIVE_1701 = greenLinePlan(
  '16:44:29',
  '16:46:00',
  '16:56:00',
  '17:01:39',
  '1:891229'
)

/** 2nd Ave S & 5th St, where the bus gets there at 16:03:01. */
const FIFTH_ST = {
  busArrivalEpoch: at('16:03:01'),
  realtime: true,
  stopId: '1:53314',
  stopName: '2nd Ave S & 5th St - Stop Group F'
}

describe('util > go-mode > journeySignature carries the vehicle (17.20)', () => {
  describe('the three Green Line departures the replay records', () => {
    it('collapsed to ONE signature before the fix', () => {
      // The bug, stated as the equality it rests on: 36 minutes of difference
      // and not a byte of it in the key.
      expect(legacySignature('1:53314', ARRIVE_1649)).toEqual(
        legacySignature('1:53314', ARRIVE_1625)
      )
      expect(legacySignature('1:53314', ARRIVE_1701)).toEqual(
        legacySignature('1:53314', ARRIVE_1625)
      )
    })

    it('are three signatures now', () => {
      const sigs = [ARRIVE_1625, ARRIVE_1649, ARRIVE_1701].map((i) =>
        journeySignature('1:53314', i)
      )
      expect(new Set(sigs).size).toBe(3)
    })

    it('names the trip, not the departure clock', () => {
      // Trip id over time on purpose: a realtime update moves a train's times
      // without making it a different train, and re-deduping it as one would
      // put the same ride on the list twice.
      expect(journeySignature('1:53314', ARRIVE_1625)).toContain('1:890194')
      expect(journeySignature('1:53314', ARRIVE_1625)).not.toContain('16:10')
    })
  })

  describe('a genuine duplicate still collapses', () => {
    it('the same journey from the same anchor is one signature', () => {
      const twin = greenLinePlan(
        '16:03:29',
        '16:10:00',
        '16:20:00',
        '16:25:39',
        '1:890194'
      )
      expect(journeySignature('1:53314', twin)).toEqual(
        journeySignature('1:53314', ARRIVE_1625)
      )
    })

    it('street legs contribute no vehicle and no time', () => {
      const bikeOnly = {
        duration: 1200,
        endTime: at('16:29:07'),
        legs: [
          bike(at('16:09:07'), at('16:29:07'), '2nd Ave S & 5th St', 'Safelite')
        ],
        startTime: at('16:09:07')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as Itinerary
      const later = {
        ...bikeOnly,
        endTime: at('16:39:07'),
        legs: [
          bike(at('16:19:07'), at('16:39:07'), '2nd Ave S & 5th St', 'Safelite')
        ],
        startTime: at('16:19:07')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as Itinerary
      // Two bike-only plans between the same two places ARE the same journey,
      // ridden at whatever moment the rider gets off the bus. Unchanged.
      expect(journeySignature('1:53314', later)).toEqual(
        journeySignature('1:53314', bikeOnly)
      )
      expect(journeySignature('1:53314', bikeOnly)).not.toContain('@')
    })

    it('a transit leg with no trip id at all keeps the old signature', () => {
      const noTrip = {
        duration: 600,
        endTime: at('16:20:00'),
        legs: [
          {
            endTime: at('16:20:00'),
            from: { name: 'Nicollet Mall Station' },
            mode: 'TRAM',
            routeId: '1:902',
            startTime: at('16:10:00'),
            to: { name: 'Stadium Village Station' },
            transitLeg: true
          }
        ],
        startTime: at('16:10:00')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as Itinerary
      // Falls back to the leg's own start, so two departures are still two
      // options; with neither trip nor a finite startTime it degrades to the
      // shipped string exactly.
      expect(journeySignature('1:53314', noTrip)).toContain(
        `@t${at('16:10:00')}`
      )
      const timeless = {
        ...noTrip,
        legs: [{ ...noTrip.legs[0], endTime: undefined, startTime: undefined }]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as Itinerary
      expect(journeySignature('1:53314', timeless)).toEqual(
        legacySignature('1:53314', timeless)
      )
    })
  })

  /**
   * End to end through the ranker, which is where the option was actually
   * deleted (`alight-optimizer.ts`'s dedupe loop, on the signature). The
   * ranking itself is 15.9's and is not under test here — only how many of the
   * three survive to be ranked.
   */
  describe('rankAlightOptions no longer deletes two of the three', () => {
    const results = [
      { ...FIFTH_ST, itineraries: [ARRIVE_1649, ARRIVE_1625, ARRIVE_1701] }
    ]

    it('keeps all three, earliest arrival first', () => {
      const ranked = rankAlightOptions(results, {
        limit: 20,
        nowMs: at('15:57:15')
      })
      expect(ranked.map((o) => o.itinerary.endTime)).toEqual([
        at('16:25:39'),
        at('16:49:39'),
        at('17:01:39')
      ])
    })

    it('still keeps the honest option when the cap is five', () => {
      const ranked = rankAlightOptions(results, {
        limit: 5,
        nowMs: at('15:57:15')
      })
      // The measured failure was at limit 5, so the cap is pinned too.
      expect(ranked.map((o) => o.itinerary.endTime)).toContain(at('16:25:39'))
      expect(ranked).toHaveLength(3)
    })

    it('collapses a plan surfaced twice from two anchors', () => {
      // 1:19260 (Washington Ave, bus there 16:05:14) returns the SAME train
      // and the same walk, which is one journey however many stops found it.
      const twoAnchors = [
        { ...FIFTH_ST, itineraries: [ARRIVE_1649] },
        {
          busArrivalEpoch: at('16:05:14'),
          itineraries: [ARRIVE_1649],
          realtime: true,
          stopId: '1:53314',
          stopName: '2nd Ave S & 5th St - Stop Group F'
        }
      ]
      const ranked = rankAlightOptions(twoAnchors, {
        limit: 20,
        nowMs: at('15:57:15')
      })
      expect(ranked).toHaveLength(1)
    })
  })
})
