import type { Itinerary } from '@opentripplanner/types'

import { buildLiveItinerary } from '../../../lib/util/go-mode/live-itinerary'
import {
  clampNonLiveLegTimes,
  getDownstreamStops,
  mergeLiveTimePoint,
  rankAlightOptions,
  scoreAlightOption
} from '../../../lib/util/go-mode/alight-optimizer'

/**
 * 2026-09-15, session mu346i5y-ng2uqc, METRO Orange Line northbound — backlog
 * 15.9 (the ranker scores every waiting option as if the wait were free) and
 * 17.6 (board and bus-arrival epochs clamped into the past, then published as
 * if they were real).
 *
 * Provenance, and a correction to backlog 17.10: this ride IS replayable. Its
 * fixture `lib/util/go-mode/replay/fixtures/orange-alight-rank-0915-1534.json`
 * (10.0 MB) carries `onboard.result.payload.options` in full — five options,
 * each with its own `busArrivalEpoch`, `duration` AND `endTime` — plus the
 * twenty `onboardCandidatePlans` they were ranked from, five of those
 * (`answeredCandidates: 4`, one errored) stamped 15:47:38–15:47:42. No size
 * cap was involved: `MAX_FULL_PAYLOAD_CHARS` (lib/util/debug-log.js) is
 * 1,000,000, the transitnav line cap is 1,179,648, and the 2026-09-15 day file
 * carries no `__truncated_chars` rows at all.
 *
 * Every figure in the 15:47:42 block below is copied from that payload, and
 * the ranking was replayed against the fixture's own candidate plans while
 * this test was written. The figures are inlined rather than imported because
 * the fixture is untracked in the shared checkout, as all of them are, so
 * importing it would mean committing a 10 MB blob.
 *
 * All clock strings are local (America/Chicago, CDT = UTC−5 on this date), the
 * same basis the ride report and the backlog row quote. Cross-checked against
 * the row's own raw epochs: boardEpoch 1789503960000 is 15:26:00 local.
 */

/** A local wall-clock time on 2026-09-15 as an epoch (ms). */
const at = (hms: string): number => {
  const [h, m, s] = hms.split(':').map(Number)
  return Date.UTC(2026, 8, 15, h + 5, m, s || 0)
}

/** The arithmetic that shipped, so a revert fails these tests rather than them. */
const legacyScore = (busArrivalEpoch: number, itin: Itinerary): number =>
  busArrivalEpoch + (itin.duration || 0) * 1000

const bikeLeg = (startTime: number, endTime: number, name: string) => ({
  distance: 4200,
  endTime,
  from: { name: 'from ' + name },
  mode: 'BICYCLE',
  startTime,
  to: { name }
})

const transitLeg = (
  startTime: number,
  endTime: number,
  mode: string,
  routeId: string,
  to: string
) => ({
  distance: 9000,
  endTime,
  from: { name: 'board ' + to },
  mode,
  routeId,
  startTime,
  to: { name: to },
  transitLeg: true
})

/**
 * One row of what the picker showed, built from the four figures the ride
 * report records for it: the stop's bus arrival, the plan's duration, and the
 * arrival the list DISPLAYED against the one the journey really reaches.
 *
 * `startTime` is derived (`endTime − duration`) rather than asserted, because
 * that is the identity the bug turns on: OTP returns just-in-time itineraries,
 * so `duration` spans startTime→endTime and the gap between the bus arrival
 * and that startTime is dead time nobody counted.
 */
const plan = (
  busArrivalEpoch: number,
  durationSec: number,
  reallyArrives: number,
  legs: (start: number, end: number) => any[]
) => {
  const startTime = reallyArrives - durationSec * 1000
  return {
    busArrivalEpoch,
    deadGapSec: (startTime - busArrivalEpoch) / 1000,
    itinerary: {
      duration: durationSec,
      endTime: reallyArrives,
      legs: legs(startTime, reallyArrives),
      startTime,
      transfers: 0,
      walkDistance: 0
    } as unknown as Itinerary
  }
}

/** Bike → train → bike, the shape the report records for ranks 1 and 2. */
const bikeTramBike = (label: string) => (start: number, end: number) =>
  [
    bikeLeg(start, start + 360000, 'platform ' + label),
    transitLeg(
      start + 360000,
      end - 420000,
      'TRAM',
      '1:902',
      'station ' + label
    ),
    bikeLeg(end - 420000, end, 'door ' + label)
  ]

/** Bike → bus → bike, the shape the report records for ranks 3 and 4. */
const bikeBusBike = (label: string) => (start: number, end: number) =>
  [
    bikeLeg(start, start + 300000, 'stop ' + label),
    transitLeg(start + 300000, end - 480000, 'BUS', '1:904', 'corner ' + label),
    bikeLeg(end - 480000, end, 'door ' + label)
  ]

/** Bike the whole rest of the way, the shape of the option the rider took. */
const bikeOnly = (label: string) => (start: number, end: number) =>
  [bikeLeg(start, end, 'door ' + label)]

describe('15.9 — the alight ranker scored the wait as free', () => {
  /**
   * The 15:43:06 list, exactly as the ride report tabulates it: five options,
   * every one of them scored early, dead gaps of 932 s to 1957 s.
   */
  const set1543 = [
    plan(at('16:03:11'), 1030, 1789508979000, bikeTramBike('a')),
    plan(at('16:00:17'), 1310, at('16:37:39'), bikeTramBike('b')),
    plan(at('16:03:11'), 1243, 1789509276000, bikeBusBike('c')),
    plan(at('16:03:11'), 1304, at('16:57:25'), bikeBusBike('d')),
    plan(at('16:07:20'), 1302, at('17:01:39'), bikeBusBike('e'))
  ]

  it('reproduces the recorded "score says" column with the old expression', () => {
    const saidByTheApp = [
      at('16:20:21'),
      at('16:22:07'),
      at('16:23:54'),
      at('16:24:55'),
      at('16:29:02')
    ]
    expect(
      set1543.map((p) => legacyScore(p.busArrivalEpoch, p.itinerary))
    ).toEqual(saidByTheApp)
  })

  it('records the dead gaps the old expression threw away', () => {
    expect(set1543.map((p) => p.deadGapSec)).toEqual([
      1758, 932, 1842, 1950, 1957
    ])
  })

  it('scores each option at the arrival the journey really reaches', () => {
    expect(
      set1543.map((p) => scoreAlightOption(p.busArrivalEpoch, p.itinerary))
    ).toEqual(set1543.map((p) => p.itinerary.endTime))
  })

  it('is between 15m32s and 32m37s later than the old score, per option', () => {
    const optimismSec = set1543.map(
      (p) =>
        (scoreAlightOption(p.busArrivalEpoch, p.itinerary) -
          legacyScore(p.busArrivalEpoch, p.itinerary)) /
        1000
    )
    // Exactly the dead gaps: the whole error was the wait.
    expect(optimismSec).toEqual(set1543.map((p) => p.deadGapSec))
  })

  /**
   * The 15:47:42 list — the clean proof, because the option that really
   * arrives first is NOT the one the app ranked first. Displayed order was
   * 16:49:39 / 16:25:39 / 16:54:36 / 16:57:26 / 16:28:33; the rider picked
   * rank 5 at 15:47:53.
   *
   * Straight off `onboard.result.payload.options` in the fixture, epochs and
   * all. `SIXTY_SIXTH`'s bus arrival is the one 17.6 is about: 1789505250813 =
   * 15:47:30, `realtime: false`, twelve seconds before the list was built, for
   * a stop the bus did not reach until ~15:49:45.
   */
  const SIXTY_SIXTH = {
    arrival: 1789505250813, // 15:47:30 — the floored one
    id: '1:48084',
    name: 'I-35W & 66th St Station'
  }
  const SEVENTH = {
    arrival: 1789506121000, // 16:02:01
    id: '1:53313',
    name: '2nd Ave S & 7th St - Stop Group F'
  }
  const FIFTH = {
    arrival: 1789506181000, // 16:03:01
    id: '1:53314',
    name: '2nd Ave S & 5th St - Stop Group F'
  }

  const rows = [
    {
      plan: plan(FIFTH.arrival, 1030, 1789508979000, bikeTramBike('a')),
      stop: FIFTH
    }, // displayed 1st — really 5th
    {
      plan: plan(SEVENTH.arrival, 1129, 1789507539000, bikeTramBike('b')),
      stop: SEVENTH
    }, // displayed 2nd — really 1st
    {
      plan: plan(FIFTH.arrival, 1243, 1789509276000, bikeBusBike('c')),
      stop: FIFTH
    }, // displayed 3rd
    {
      plan: plan(FIFTH.arrival, 1305, 1789509446000, bikeBusBike('d')),
      stop: FIFTH
    }, // displayed 4th
    {
      plan: plan(SIXTY_SIXTH.arrival, 2377, 1789507713000, bikeOnly('e')),
      stop: SIXTY_SIXTH
    } // displayed 5th — the one the rider took
  ]

  const results = [SIXTY_SIXTH, SEVENTH, FIFTH].map((stop) => ({
    busArrivalEpoch: stop.arrival,
    itineraries: rows
      .filter((r) => r.stop.id === stop.id)
      .map((r) => r.plan.itinerary),
    realtime: true,
    stopId: stop.id,
    stopName: stop.name
  }))

  const NOW = at('15:47:42')

  it('reproduces the recorded displayed order with the old expression', () => {
    const byLegacy = [...rows].sort(
      (a, b) =>
        legacyScore(a.stop.arrival, a.plan.itinerary) -
        legacyScore(b.stop.arrival, b.plan.itinerary)
    )
    expect(byLegacy.map((r) => r.plan.itinerary.endTime)).toEqual([
      1789508979000, 1789507539000, 1789509276000, 1789509446000, 1789507713000
    ])
    // And the recorded scores themselves, to the second.
    expect(
      byLegacy.map((r) => legacyScore(r.stop.arrival, r.plan.itinerary))
    ).toEqual([
      at('16:20:11'),
      at('16:20:50'),
      at('16:23:44'),
      at('16:24:46'),
      // 16:27:07.813 — the .813 is the floored bus arrival's own millisecond,
      // which is `nowMs` and not a published time at all (17.6).
      SIXTY_SIXTH.arrival + 2377000
    ])
  })

  it('records the dead gaps in the 15:47:42 set too', () => {
    // 85 s on the option the rider took and 289 s on the one that was really
    // best, against 1768-1960 s on the three the list preferred. 85.187 s
    // rather than a round number because that candidate's bus arrival is
    // 17.6's floor: `nowMs` to the millisecond.
    expect(rows.map((r) => r.plan.deadGapSec)).toEqual([
      1768, 289, 1852, 1960, 85.187
    ])
  })

  it('ranks the list by true arrival, undoing the 24-minute inversion', () => {
    const ranked = rankAlightOptions(results, { limit: 5, nowMs: NOW })
    expect(ranked.map((o) => o.itinerary.endTime)).toEqual([
      1789507539000, 1789507713000, 1789508979000, 1789509276000, 1789509446000
    ])
  })

  it('no longer puts the 16:49:39 option first, or the rider’s pick last', () => {
    const ranked = rankAlightOptions(results, { limit: 5, nowMs: NOW })
    const arrivals = ranked.map((o) => Number(o.itinerary.endTime))
    // The measured failure: 16:49 above 16:25, and the 16:28:33 the rider
    // actually chose sitting in the last slot.
    expect(arrivals.indexOf(1789508979000)).toBeGreaterThan(1)
    expect(arrivals.indexOf(1789507713000)).toBe(1)
    expect(arrivals[0]).toBeLessThanOrEqual(1789507713000)
  })

  it('keeps the 6-hour onward horizon and the reachability bounds', () => {
    // A plan that departs before the bus gets to the stop is still nobody's
    // plan, and one that ends more than MAX_ONWARD_HORIZON_MS out is still
    // tomorrow's trip. Neither bound reads the score.
    const tooEarly = plan(
      FIFTH.arrival,
      600,
      FIFTH.arrival - 120000,
      bikeOnly('early')
    )
    const tooLate = plan(
      FIFTH.arrival,
      600,
      FIFTH.arrival + 7 * 60 * 60 * 1000,
      bikeOnly('late')
    )
    const ranked = rankAlightOptions(
      [
        {
          busArrivalEpoch: FIFTH.arrival,
          itineraries: [
            tooEarly.itinerary,
            tooLate.itinerary,
            rows[0].plan.itinerary
          ],
          realtime: true,
          stopId: FIFTH.id,
          stopName: FIFTH.name
        }
      ],
      { limit: 5, nowMs: NOW }
    )
    expect(ranked.map((o) => o.itinerary.endTime)).toEqual([1789508979000])
  })

  it('still ranks a genuine 32-minute wait — last, not first', () => {
    // The row's own requirement: "let a long wait rank where it belongs."
    // Dropping the option would be a different bug.
    const ranked = rankAlightOptions(results, { limit: 5, nowMs: NOW })
    expect(ranked).toHaveLength(5)
    expect(ranked[4].itinerary.endTime).toBe(1789509446000)
  })
})

describe('17.6 — a clamped epoch is a floor, not a time', () => {
  /**
   * 15:46:02: a candidate carried busArrivalEpoch = "now" for I-35W & 66th St,
   * which the bus did not reach until ~15:49:45 (the rider's own fix at
   * 15:49:45 is at 66th St). The mechanism is getDownstreamStops' schedule
   * chain: it is seeded at nowMs and the ANCHOR stop's offset from itself is
   * zero, so the bus's next stop is always projected as "arriving now".
   */
  const NOW = at('15:46:02')
  const SERVICE_DAY = Date.UTC(2026, 8, 15, 5, 0, 0) / 1000 // 00:00 local
  const secs = (hms: string): number => {
    const [h, m, s] = hms.split(':').map(Number)
    return h * 3600 + m * 60 + (s || 0)
  }
  const st = (
    name: string,
    id: string,
    departure: string,
    live?: string
  ): any => ({
    scheduledArrival: secs(departure),
    scheduledDeparture: secs(departure),
    serviceDay: SERVICE_DAY,
    stop: { id, lat: 44.9 + secs(departure) / 1e7, lon: -93.3, name },
    ...(live ? { realtimeArrival: secs(live), realtimeState: 'UPDATED' } : {})
  })

  const trip = {
    id: '1:1346665',
    stopTimes: [
      st('Knox Ave & 76th St', '1:76th', '15:44:00'),
      st('I-35W & 66th St', '1:66th', '15:47:00'),
      st('I-35W & Lake St', '1:lake', '15:56:00'),
      st('I-35W & Franklin Ave', '1:franklin', '16:00:00')
    ]
  }
  const DEST = { lat: 44.95, lon: -93.24 }

  it('still clamps the anchor stop to now — but says that it did', () => {
    const downstream = getDownstreamStops(
      trip,
      { nextStopId: '1:66th' },
      { lat: 44.86543, lon: -93.30193 },
      DEST,
      NOW
    )
    expect(downstream[0].stop.id).toBe('1:66th')
    // The 3m43s error itself is unchanged: this row does not claim to know
    // when the bus reaches its next stop, only that "now" is a floor.
    expect(downstream[0].busArrivalEpoch).toBe(NOW)
    expect(downstream[0].arrivalIsFloor).toBe(true)
    // The stops after it are honest projections off that anchor, not floors.
    expect(downstream[1].arrivalIsFloor).toBe(false)
    expect(downstream[2].arrivalIsFloor).toBe(false)
  })

  it('does not flag a floor when a live neighbour set the bound', () => {
    const live = {
      ...trip,
      stopTimes: [
        trip.stopTimes[0],
        st('I-35W & 66th St', '1:66th', '15:47:00', '15:49:45'),
        st('I-35W & Lake St', '1:lake', '15:56:00', '15:58:30'),
        trip.stopTimes[3]
      ]
    }
    const downstream = getDownstreamStops(
      live,
      { nextStopId: '1:66th' },
      null,
      DEST,
      NOW
    )
    expect(downstream[0].busArrivalEpoch).toBe(at('15:49:45'))
    expect(downstream[0].arrivalIsFloor).toBe(false)
  })

  it('does not build the score on a bound of a bound', () => {
    // The floored arrival is 3m43s early. busArrivalEpoch + duration inherits
    // every second of that, so with a floor the sum is dropped and the plan's
    // own endTime stands alone.
    const itin = {
      duration: 1800,
      endTime: 1789507539000,
      legs: [bikeLeg(at('15:55:39'), 1789507539000, 'door')],
      startTime: at('15:55:39')
    } as unknown as Itinerary
    expect(scoreAlightOption(NOW, itin, { arrivalIsFloor: true })).toBe(
      1789507539000
    )
    // Without the flag the sum is still the lower bound for a LATE bus, which
    // is the failure in the other direction.
    const lateBus = at('16:10:00')
    expect(scoreAlightOption(lateBus, itin)).toBe(lateBus + 1800000)
  })

  it('carries the floor from the candidate stop into the ranked option', () => {
    const downstream = getDownstreamStops(
      trip,
      { nextStopId: '1:66th' },
      null,
      DEST,
      NOW
    )
    const itin = {
      duration: 1800,
      endTime: 1789507539000,
      legs: [bikeLeg(at('15:55:39'), 1789507539000, 'door')],
      startTime: at('15:55:39')
    } as unknown as Itinerary
    const ranked = rankAlightOptions(
      [
        {
          busArrivalEpoch: downstream[0].busArrivalEpoch,
          itineraries: [itin],
          realtime: false,
          stopId: '1:66th',
          stopName: 'I-35W & 66th St'
        }
      ],
      { downstream, limit: 5, nowMs: NOW }
    )
    expect(ranked[0].arrivalIsFloor).toBe(true)
  })

  it('marks a board time raised to now, and to the displayed minute', () => {
    // mergeLiveTimePoint's clamp.
    const merged = mergeLiveTimePoint(
      { epoch: at('15:26:00'), realtime: false },
      null,
      at('15:36:33')
    )
    expect(merged).toEqual({
      epoch: at('15:36:33'),
      isFloor: true,
      projected: undefined,
      realtime: false
    })
    // clampNonLiveLegTimes' minute-floor bridge, the `boardClamped: true`
    // record seen at 15:43:00.
    const clamped = clampNonLiveLegTimes(
      {
        0: {
          alightEpoch: at('15:56:00'),
          boardEpoch: at('15:31:00'),
          realtime: false
        }
      },
      at('15:43:28')
    )
    expect(clamped?.[0].boardEpoch).toBe(at('15:43:00'))
    expect(clamped?.[0].boardClamped).toBe(true)
    expect(clamped?.[0].boardIsFloor).toBe(true)
  })

  it('never publishes a floored board time onto the leg', () => {
    // "- minute waits make no sense": the trip sheet measures the wait before
    // a later bus as leg.startTime - legs[i-1].endTime off the LIVE itinerary,
    // so a board time clamped to `now` renders a wait about nothing.
    const itinerary = {
      legs: [
        bikeLeg(at('15:30:00'), at('15:38:00'), 'stop'),
        transitLeg(at('15:50:00'), at('16:05:00'), 'BUS', '1:904', 'Lake St')
      ]
    } as unknown as Itinerary
    const floored = buildLiveItinerary(itinerary, {
      1: {
        alightEpoch: null,
        boardEpoch: at('15:37:00'),
        boardIsFloor: true,
        boardProjected: true,
        realtime: false
      }
    })
    expect(Number(floored.legs[1].startTime)).toBe(at('15:50:00'))
    const waitSec =
      (Number(floored.legs[1].startTime) - Number(floored.legs[0].endTime)) /
      1000
    expect(waitSec).toBeGreaterThan(0)

    // An honest projection still publishes, which is what it is for.
    const projected = buildLiveItinerary(itinerary, {
      1: {
        alightEpoch: null,
        boardEpoch: at('15:53:00'),
        boardProjected: true,
        realtime: false
      }
    })
    expect(Number(projected.legs[1].startTime)).toBe(at('15:53:00'))
  })
})
