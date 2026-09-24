import { accessSecondsToBoardStop } from '../../../lib/util/go-mode/progress-calculator'
import {
  CARD_HOLD_RELEASE_GRACE_MS,
  getRouteDepartures,
  getSoonestCatchableMs,
  HeldDeparture,
  resolveCardDeparture,
  RouteDeparture
} from '../../../lib/util/go-mode/departure-anchor'

/**
 * Backlog 16.3 — the ride of 2026-09-15.
 *
 * The rider was biking to Marquette Ave & 11th St for the Orange Line. The
 * card headlined 10:09 AM ("arrives in 25 min") while UPDATE_PROGRESS was
 * carrying effectiveDepartureMs 09:54:02 and timeUntilNextDeparture 534.9 s.
 * No MISSED_BUS fired all ride — nothing had happened to the bus. Realtime for
 * the leg simply dropped 09:43:29–09:50:19 and the board fell back to the
 * scheduled 09:53:00. The rider boarded the 09:54 and wrote "wtf".
 *
 * Mechanism: `rideSecondsRemaining` was `leg.duration x (1 - progress/100)` on
 * an 847 s leg whose progress was frozen at 0 %, so getSoonestCatchableMs
 * demanded `depMs - now >= 847 - 180` (the optimism cap) and skipped the
 * 09:54. At ~09:43:00 that threshold landed on 09:54:07 — five seconds past
 * the departure — and the anchor slid to the next trip; by the 09:44:45
 * screenshot the same projection was 110 s short of it. Same mechanism, and
 * 09:44:45 is the state the rider photographed, so it is the one asserted on.
 */

/** Local-time epochs, so the component test's clock strings match too. */
const at = (h: number, m: number, s = 0) =>
  new Date(2026, 8, 15, h, m, s).getTime()

const NOW = at(9, 44, 45) // the screenshot
const DEP_LIVE = at(9, 54, 2) // the bus the rider caught
const DEP_SCHED = at(9, 53, 0) // ...its scheduled time, when realtime dropped
const DEP_NEXT = at(10, 9, 0) // the one the card jumped to
const TRIP = 'Trip:1:1346023'

const departures = (
  overrides: Partial<RouteDeparture> = {}
): RouteDeparture[] => [
  {
    depMs: DEP_LIVE,
    realtime: true,
    routeId: 'MET:903',
    tripId: TRIP,
    ...overrides
  },
  { depMs: DEP_NEXT, realtime: true, routeId: 'MET:903', tripId: 'Trip:next' }
]

const held: HeldDeparture = { departureMs: DEP_LIVE, tripId: TRIP }

const resolve = (input: Partial<Parameters<typeof resolveCardDeparture>[0]>) =>
  resolveCardDeparture({
    candidateMs: DEP_NEXT,
    departures: departures(),
    held,
    nowMs: NOW,
    plannedDepartureMs: DEP_SCHED,
    ...input
  })

describe('go-mode > 16.3 the card holds the departure it showed', () => {
  describe('the 2026-09-15 numbers', () => {
    it('reproduces the slide: a frozen 847 s projection skips the 09:54', () => {
      // 847 - min(180, 847*0.25) = 667 s of required margin; the 09:54 is
      // only 557 s away, so the projection alone answers with the 10:09.
      expect((DEP_LIVE - NOW) / 1000).toBeCloseTo(557, 0)
      expect(getSoonestCatchableMs(departures(), NOW, 847)).toBe(DEP_NEXT)
    })

    it('keeps the 09:54 once it has been shown, projection or no', () => {
      const decision = resolve({ candidateMs: DEP_NEXT })
      expect(decision.departureMs).toBe(DEP_LIVE)
      expect(decision.reason).toBe('held')
      expect(decision.held).toEqual(held)
    })

    it('measured pace, not the plan, would not have slid in the first place', () => {
      // The bike leg OTP timed at 847 s: 3,500 m at its own 4.13 m/s.
      const leg: any = { distance: 3500, duration: 847, mode: 'BICYCLE' }
      // No measured pace: the plan's own figure, and the 09:54 is skipped.
      expect(accessSecondsToBoardStop([leg], 0, 0, null)).toBeCloseTo(847, 0)
      expect(
        getSoonestCatchableMs(
          departures(),
          NOW,
          accessSecondsToBoardStop([leg], 0, 0, null) as number
        )
      ).toBe(DEP_NEXT)

      // The rider's measured 6 m/s: 583 s, and the 09:54 is catchable.
      const measured = accessSecondsToBoardStop([leg], 0, 0, 6) as number
      expect(measured).toBeCloseTo(583.3, 1)
      expect(getSoonestCatchableMs(departures(), NOW, measured)).toBe(DEP_LIVE)
    })

    it('seeds from the projection when nothing is held yet', () => {
      const decision = resolve({ candidateMs: DEP_LIVE, held: null })
      expect(decision.departureMs).toBe(DEP_LIVE)
      expect(decision.reason).toBe('seeded')
      expect(decision.held).toEqual(held)
    })
  })

  describe('a realtime -> schedule flip is not a different bus', () => {
    it('stays on the held TRIP, floored at its last live time (29.3)', () => {
      // Until 29.3 this followed the trip back to its 09:53 timetable. A
      // schedule row EARLIER than the last live time now keeps that time: the
      // 2026-09-23 flip put the card ten minutes into the past this way.
      const flipped = departures({ depMs: DEP_SCHED, realtime: false })
      const decision = resolve({ departures: flipped })
      expect(decision.departureMs).toBe(DEP_LIVE)
      expect(decision.departureMs).not.toBe(DEP_NEXT)
      expect(decision.reason).toBe('held')
    })

    it('still follows the held TRIP to a LATER scheduled time', () => {
      const later = DEP_LIVE + 120000
      const flipped = departures({ depMs: later, realtime: false })
      const decision = resolve({ departures: flipped })
      expect(decision.departureMs).toBe(later)
      expect(decision.reason).toBe('held')
    })

    it('holds by epoch when the feed names no trip', () => {
      const anonymous: RouteDeparture[] = [
        { depMs: DEP_LIVE, realtime: false, routeId: 'MET:903', tripId: null },
        { depMs: DEP_NEXT, realtime: true, routeId: 'MET:903', tripId: null }
      ]
      const decision = resolve({
        departures: anonymous,
        held: { departureMs: DEP_LIVE, tripId: null }
      })
      expect(decision.departureMs).toBe(DEP_LIVE)
      expect(decision.reason).toBe('held')
    })
  })

  describe('a bus that is genuinely gone does move it', () => {
    it('releases on the missed-bus classifier’s definitive verdict', () => {
      const decision = resolve({
        boardingMiss: { definitive: true },
        nowMs: DEP_LIVE + 200000
      })
      expect(decision.departureMs).toBe(DEP_NEXT)
      expect(decision.reason).toBe('released-missed')
      expect(decision.held).toEqual({
        departureMs: DEP_NEXT,
        tripId: 'Trip:next'
      })
    })

    it('releases when the run leaves the feed, after the grace', () => {
      const withoutIt = [departures()[1]]
      const gone = resolve({
        departures: withoutIt,
        nowMs: DEP_LIVE + CARD_HOLD_RELEASE_GRACE_MS + 1000
      })
      expect(gone.departureMs).toBe(DEP_NEXT)
      expect(gone.reason).toBe('released-gone')
    })

    it('does NOT release on an ambiguous miss — that is a late bus', () => {
      const decision = resolve({
        boardingMiss: { definitive: false },
        nowMs: DEP_LIVE + 200000
      })
      expect(decision.departureMs).toBe(DEP_LIVE)
      expect(decision.reason).toBe('held')
    })

    it('does NOT release inside the grace on a poll that rolled forward', () => {
      const decision = resolve({
        departures: [departures()[1]],
        nowMs: DEP_LIVE + CARD_HOLD_RELEASE_GRACE_MS - 1000
      })
      expect(decision.departureMs).toBe(DEP_LIVE)
      expect(decision.reason).toBe('held')
    })
  })

  describe('what the hold does not block', () => {
    it('the rider’s own pick', () => {
      const decision = resolve({ departureOverride: DEP_NEXT })
      expect(decision.departureMs).toBe(DEP_NEXT)
      expect(decision.reason).toBe('override')
    })

    it('a meaningfully EARLIER run of the same route', () => {
      const earlier = DEP_LIVE - 5 * 60000
      const decision = resolve({
        candidateMs: earlier,
        departures: [
          {
            depMs: earlier,
            realtime: true,
            routeId: 'MET:903',
            tripId: 'Trip:earlier'
          },
          ...departures()
        ]
      })
      expect(decision.departureMs).toBe(earlier)
      expect(decision.reason).toBe('adopted-earlier')
    })

    it('...but not jitter: a run 30 s earlier is not a different bus', () => {
      const decision = resolve({ candidateMs: DEP_LIVE - 30000 })
      expect(decision.departureMs).toBe(DEP_LIVE)
      expect(decision.reason).toBe('held')
    })
  })

  describe('degenerate inputs', () => {
    it('falls back to the plan when there are no departures at all', () => {
      const decision = resolve({
        candidateMs: null,
        departures: [],
        held: null
      })
      expect(decision.departureMs).toBe(DEP_SCHED)
      expect(decision.held).toEqual({ departureMs: DEP_SCHED, tripId: null })
    })

    it('answers null when there is nothing to show', () => {
      const decision = resolve({
        candidateMs: null,
        departures: [],
        held: null,
        plannedDepartureMs: null
      })
      expect(decision).toEqual({
        departureMs: null,
        held: null,
        reason: 'none'
      })
    })
  })

  it('getRouteDepartures carries the trip id the hold matches on', () => {
    const DAY = 1_700_000_000
    const stopData = {
      routes: [],
      stoptimesForPatterns: [
        {
          pattern: { id: 'p1' },
          stoptimes: [
            {
              realtimeDeparture: 940,
              realtimeState: 'UPDATED',
              route: { gtfsId: 'MET:903' },
              scheduledDeparture: 1000,
              serviceDay: DAY,
              trip: { gtfsId: TRIP, route: { gtfsId: 'MET:903' } }
            }
          ]
        }
      ]
    }
    expect(getRouteDepartures(stopData, 'MET:903')[0]).toMatchObject({
      depMs: (DAY + 940) * 1000,
      realtime: true,
      tripId: TRIP
    })
  })
})
