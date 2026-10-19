import type { Itinerary } from '@opentripplanner/types'

import {
  accessStreetMeters,
  rankAlightOptions
} from '../../../lib/util/go-mode/alight-optimizer'

/**
 * Backlog 54.2, ride mva4fpf5-hhg1cf, SET_ONBOARD_RESULT 21:30:41 (2026-10-15,
 * CDT). The list put 'off at American Blvd, bike 6,190 m to the 534' (arrive
 * 22:13:52) at the top and 'off at 30th Ave, bike 999 m to the 539 from MOA
 * Gate H' (22:14:44, 52 s later) at row 11; the MOA Station +130 m option
 * (22:15:24, 92 s later) fell outside the 20-option pool. The tie-break read
 * the never-selected `walkDistance`, so ties fell through to raw arrival.
 * Figures below are the row's own; the rest of the 20 are filler.
 */
const at = (hms: string): number => {
  const [h, m, s] = hms.split(':').map(Number)
  return Date.UTC(2026, 9, 15, h + 5, m, s || 0)
}
const NOW = at('21:30:41')

const bike = (meters: number, start: number, end: number) => ({
  distance: meters,
  endTime: end,
  mode: 'BICYCLE',
  startTime: start
})
const bus = (routeId: string, start: number, end: number) => ({
  distance: 9000,
  endTime: end,
  mode: 'BUS',
  routeId,
  startTime: start,
  transitLeg: true
})

const option = (
  stopId: string,
  stopName: string,
  busArrival: string,
  arrives: string,
  routeId: string,
  accessMeters: number,
  egressMeters = 1500
) => {
  const busArrivalEpoch = at(busArrival)
  const end = at(arrives)
  const start = busArrivalEpoch
  const access = Math.round(accessMeters * 0.2) * 1000
  const itinerary = {
    duration: (end - start) / 1000,
    endTime: end,
    legs: [
      bike(accessMeters, start, start + access),
      bus(routeId, start + access, end - 300000),
      bike(egressMeters, end - 300000, end)
    ],
    startTime: start,
    transfers: 0
  } as unknown as Itinerary
  return {
    busArrivalEpoch,
    itineraries: [itinerary],
    realtime: true,
    stopId,
    stopName
  }
}

const results = [
  option('1:american', 'American Blvd', '21:40:00', '22:13:52', '1:534', 6190),
  option('1:30th-b', '30th Ave (far)', '21:42:00', '22:13:52', '1:534', 5593),
  option('1:30th', '30th Ave', '21:44:00', '22:14:44', '1:539', 999, 1743),
  option('1:moa', 'MOA Station', '21:47:00', '22:15:24', '1:539', 130, 1700),
  // later than the 3-minute bucket
  option('1:late', 'Late stop', '21:50:00', '22:19:30', '1:539', 50)
]

describe('54.2 — stay aboard when the arrival is a wash', () => {
  it('measures street metres from non-transit legs only', () => {
    const itin = results[2].itineraries[0]
    expect(accessStreetMeters(itin)).toBe(999 + 1743)
  })

  it('ranks the stay-on options above American Blvd inside 3 minutes', () => {
    const names = rankAlightOptions(results, { limit: 20, nowMs: NOW }).map(
      (o) => o.stopName
    )
    expect(names.indexOf('MOA Station')).toBeLessThan(
      names.indexOf('American Blvd')
    )
    expect(names.indexOf('30th Ave')).toBeLessThan(
      names.indexOf('American Blvd')
    )
    expect(names[0]).toBe('MOA Station')
    // outside the bucket, arrival alone: the late option stays last
    expect(names[names.length - 1]).toBe('Late stop')
  })

  it('is transitive over a chain of options two minutes apart', () => {
    const chain = [0, 1, 2, 3, 4].map((i) =>
      option(
        '1:c' + i,
        'chain ' + i,
        '21:40:00',
        i === 0 ? '22:00:00' : '22:0' + 2 * i + ':00',
        '1:539',
        1000 - i * 100
      )
    )
    const names = rankAlightOptions(chain, { limit: 20, nowMs: NOW }).map(
      (o) => o.stopName
    )
    // 22:00 anchors the bucket (<=22:03): chain 0 and 1 in, sorted by metres
    expect(names.slice(0, 2)).toEqual(['chain 1', 'chain 0'])
    expect(names.slice(2)).toEqual(['chain 2', 'chain 3', 'chain 4'])
  })

  it('keeps the least-street bucket option when the pool is cut', () => {
    const ranked = rankAlightOptions(results, { limit: 2, nowMs: NOW })
    expect(ranked.map((o) => o.stopName)).toContain('MOA Station')
  })
})
