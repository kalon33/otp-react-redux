import {
  currentServiceDate,
  getLegRouteId,
  getRouteDepartures,
  getSoonestCatchableMs,
  RouteDeparture,
  shouldAdoptAnchor
} from '../../../lib/util/go-mode/departure-anchor'

// serviceDay chosen so epochs are easy to eyeball: depMs = (DAY + secs) * 1000
const DAY = 1_700_000_000

const stopTime = (
  secs: number,
  routeId: string,
  opts: { realtime?: number; state?: string } = {}
) => ({
  headsign: 'Downtown',
  realtimeDeparture: opts.realtime ?? null,
  realtimeState: opts.state ?? 'SCHEDULED',
  route: { gtfsId: routeId },
  scheduledDeparture: secs,
  serviceDay: DAY,
  trip: { gtfsId: `trip:${secs}`, route: { gtfsId: routeId } }
})

const stopData = (stoptimes: any[]) => ({
  routes: [],
  stoptimesForPatterns: [{ pattern: { id: 'p1' }, stoptimes }]
})

describe('departure-anchor', () => {
  describe('getLegRouteId', () => {
    it('reads OTP2 route objects (id or gtfsId)', () => {
      expect(getLegRouteId({ route: { id: 'MET:903' } } as any)).toBe('MET:903')
      expect(getLegRouteId({ route: { gtfsId: 'MET:903' } } as any)).toBe(
        'MET:903'
      )
    })
    it('falls back to legacy routeId and null when absent', () => {
      expect(getLegRouteId({ routeId: 'MET:46' } as any)).toBe('MET:46')
      expect(getLegRouteId({} as any)).toBeNull()
      expect(getLegRouteId(undefined)).toBeNull()
    })
  })

  describe('getRouteDepartures', () => {
    it('filters to the boarding route and sorts ascending', () => {
      const data = stopData([
        stopTime(2000, 'MET:903'),
        stopTime(1000, 'MET:903'),
        stopTime(1500, 'MET:46')
      ])
      const deps = getRouteDepartures(data, 'MET:903')
      expect(deps.map((d: RouteDeparture) => d.depMs)).toEqual([
        (DAY + 1000) * 1000,
        (DAY + 2000) * 1000
      ])
    })

    it('prefers the realtime departure when the feed reports one', () => {
      const data = stopData([
        stopTime(1000, 'MET:903', { realtime: 940, state: 'UPDATED' }),
        stopTime(2000, 'MET:903', { realtime: 2100, state: 'SCHEDULED' })
      ])
      const deps = getRouteDepartures(data, 'MET:903')
      // UPDATED -> live 940 wins over scheduled 1000
      expect(deps[0]).toMatchObject({
        depMs: (DAY + 940) * 1000,
        realtime: true
      })
      // SCHEDULED realtimeState -> the realtime value is ignored
      expect(deps[1]).toMatchObject({
        depMs: (DAY + 2000) * 1000,
        realtime: false
      })
    })

    it('is empty on missing data or route', () => {
      expect(getRouteDepartures(null, 'MET:903')).toEqual([])
      expect(getRouteDepartures(stopData([]), null)).toEqual([])
    })
  })

  describe('shouldAdoptAnchor', () => {
    const planned = 1_000_000_000
    const anchored = planned - 45 * 60000 // an earlier bus already anchored

    it('adopts a meaningfully earlier departure', () => {
      expect(shouldAdoptAnchor(anchored, planned)).toBe(true)
    })

    it('ignores a difference too small to be a different bus', () => {
      expect(shouldAdoptAnchor(planned - 60000, planned)).toBe(false)
    })

    // The 7/22 skip: measured against the PLANNED board, the next trip after a
    // late anchored bus still looked like a 43-minute gain and the display
    // jumped to it while the rider's bus had not left.
    it('never moves later than the departure already in force', () => {
      const nextTrip = anchored + 25 * 60000
      expect(shouldAdoptAnchor(nextTrip, planned)).toBe(true)
      expect(shouldAdoptAnchor(nextTrip, anchored)).toBe(false)
    })

    it('handles no candidate and a missing departure', () => {
      expect(shouldAdoptAnchor(null, planned)).toBe(false)
      expect(shouldAdoptAnchor(anchored, NaN)).toBe(false)
    })
  })

  describe('getSoonestCatchableMs', () => {
    const dep = (depMs: number): RouteDeparture => ({ depMs, realtime: false })

    it('skips departures the rider cannot reach', () => {
      const now = 0
      // 10 min of riding left; bus in 2 min is gone, bus in 11 min is fine.
      const deps = [dep(120_000), dep(660_000)]
      expect(getSoonestCatchableMs(deps, now, 600)).toBe(660_000)
    })

    it('allows up to 25% optimism, capped at 3 minutes', () => {
      const now = 0
      // 10 min remaining, optimism = min(180s, 150s) = 150s -> a bus in 8.5
      // min is catchable, one in 7 min is not.
      expect(getSoonestCatchableMs([dep(510_000)], now, 600)).toBe(510_000)
      expect(getSoonestCatchableMs([dep(420_000)], now, 600)).toBeNull()
      // 20 min remaining, optimism capped at 180s -> 17 min bus catchable.
      expect(getSoonestCatchableMs([dep(1_020_000)], now, 1200)).toBe(1_020_000)
      expect(getSoonestCatchableMs([dep(900_000)], now, 1200)).toBeNull()
    })

    it('returns null when nothing is reachable', () => {
      expect(getSoonestCatchableMs([], 0, 600)).toBeNull()
    })

    // 7/22 ride: standing at the stop (no ride time left), the rider's bus ran
    // late with no realtime update. The instant its scheduled time passed it
    // dropped out of the list and the anchor slid onto the next trip — "showed
    // 465 at 0135 before mine even left". A slightly overdue bus stays in play.
    it('keeps a slightly overdue departure catchable when given grace', () => {
      const now = 1_000_000
      const overdue = dep(now - 40_000)
      const nextTrip = dep(now + 1_500_000)
      expect(getSoonestCatchableMs([overdue, nextTrip], now, 0)).toBe(
        nextTrip.depMs
      )
      expect(getSoonestCatchableMs([overdue, nextTrip], now, 0, 60_000)).toBe(
        overdue.depMs
      )
    })

    it('still gives up once the departure is past the grace', () => {
      const now = 1_000_000
      const longGone = dep(now - 200_000)
      const nextTrip = dep(now + 1_500_000)
      expect(getSoonestCatchableMs([longGone, nextTrip], now, 0, 60_000)).toBe(
        nextTrip.depMs
      )
    })
  })
})

describe('currentServiceDate', () => {
  const TZ = 'America/Chicago'
  const utc = (y: number, mo: number, d: number, h: number, mi = 0) =>
    Date.UTC(y, mo - 1, d, h, mi)

  it('uses the local calendar date during the day', () => {
    // 2026-07-21 14:00 CDT = 19:00 UTC
    expect(currentServiceDate(utc(2026, 7, 21, 19), TZ)).toBe('2026-07-21')
  })

  it('stays on the local date in the evening when UTC has rolled over (the dead-anchor bug)', () => {
    // 2026-07-21 20:00 CDT = 2026-07-22 01:00 UTC — toISOString said 07-22
    expect(currentServiceDate(utc(2026, 7, 22, 1), TZ)).toBe('2026-07-21')
  })

  it('rolls back to yesterday after midnight, before the 03:30 service break', () => {
    // 2026-07-22 00:30 CDT = 05:30 UTC
    expect(currentServiceDate(utc(2026, 7, 22, 5, 30), TZ)).toBe('2026-07-21')
  })

  it('flips to the new service day at exactly 03:30 local', () => {
    // 03:29 CDT -> yesterday; 03:30 CDT -> today
    expect(currentServiceDate(utc(2026, 7, 22, 8, 29), TZ)).toBe('2026-07-21')
    expect(currentServiceDate(utc(2026, 7, 22, 8, 30), TZ)).toBe('2026-07-22')
  })
})
