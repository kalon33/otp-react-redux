import {
  getLegRouteId,
  getRouteDepartures,
  getSoonestCatchableMs,
  RouteDeparture
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
  })
})
