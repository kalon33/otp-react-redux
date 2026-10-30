import { doMergeItineraries } from '../../../lib/components/narrative/narrative-itineraries'

/**
 * Backlog 75.6. A search more than 24 hours ahead lost all but one departure
 * per row: the merge folded a same-shape duplicate in only when it left less
 * than a day after NOW, and otherwise dropped it — neither a row nor a time.
 * The fuzz session's Saturday search (case 14, downtown -> Union Depot,
 * 2026-10-31 10:00, searched 2026-10-29 00:27) showed "Leaves 10:11 AM" on
 * the 94 row and nothing else, though OTP returned the 94 at 10:17 / 10:47 /
 * 11:17 / 11:47 and the Green Line at 10:23 / 10:47 / 11:23 / 11:47.
 *
 * Departures fold together when they leave on the same day as the row, and
 * a departure a day or more away from the row is its own row — never dropped.
 */

const MIN = 60000
const DAY = 24 * 60 * MIN
// America/Chicago is CDT (UTC-5) through 2026-11-01 02:00, CST (UTC-6) after.
const cdt = (y: number, mo: number, d: number, h: number, m: number) =>
  Date.UTC(y, mo - 1, d, h + 5, m)
const cst = (y: number, mo: number, d: number, h: number, m: number) =>
  Date.UTC(y, mo - 1, d, h + 6, m)
// When the fuzz session made the search: Thursday 2026-10-29 00:27 CDT.
const SEARCHED_AT = cdt(2026, 10, 29, 0, 27)

const DOWNTOWN = { lat: 44.9778, lon: -93.265, name: 'Downtown Mpls' }
const UNION_DEPOT = { lat: 44.948, lon: -93.0866, name: 'Union Depot St Paul' }
// The stops case 14's rows rode (fuzz/rows-sat.json).
const BUS_94_FROM = {
  lat: 44.9772,
  lon: -93.2669,
  name: '1:17884',
  stopId: '1:17884'
}
const BUS_94_TO = {
  lat: 44.9465,
  lon: -93.0897,
  name: '1:57420',
  stopId: '1:57420'
}
const GREEN_FROM = {
  lat: 44.9775,
  lon: -93.2635,
  name: '1:51409',
  stopId: '1:51409'
}
const GREEN_TO = {
  lat: 44.9478,
  lon: -93.0864,
  name: '1:56018',
  stopId: '1:56018'
}

type Ride = {
  board: number
  index: number
  route: '1:94' | '1:902'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function trip({ board, index, route }: Ride): any {
  const bus = route === '1:94'
  const from = bus ? BUS_94_FROM : GREEN_FROM
  const to = bus ? BUS_94_TO : GREEN_TO
  const ride = (bus ? 22 : 38) * MIN
  const start = board - 6 * MIN
  const end = board + ride + 6 * MIN
  return {
    duration: (end - start) / 1000,
    endTime: end,
    index,
    legs: [
      {
        distance: 300,
        endTime: board,
        from: DOWNTOWN,
        mode: 'WALK',
        startTime: start,
        to: from
      },
      {
        distance: bus ? 15800 : 17400,
        endTime: board + ride,
        from,
        mode: bus ? 'BUS' : 'TRAM',
        routeId: route,
        routeShortName: bus ? '94' : 'Green',
        startTime: board,
        to,
        transitLeg: true
      },
      {
        distance: 250,
        endTime: end,
        from: to,
        mode: 'WALK',
        startTime: board + ride,
        to: UNION_DEPOT
      }
    ],
    startTime: start
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function merge(rides: Ride[]): any {
  // A fresh array each call: doMergeItineraries is memoized on its argument.
  return doMergeItineraries(rides.map(trip), undefined, true)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const departures = (row: any) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (row.allStartTimes || []).map((t: any) => t.itinerary.index).sort()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inSomeRow = (result: any) =>
  result.allItineraries.every(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (itin: any, i: number) =>
      result.mergedItineraries.some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (row: any) =>
          row.index === i ||
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (row.allStartTimes || []).some((t: any) => t.itinerary.index === i)
      )
  )

describe('backlog 75.6 > the row merge keys on the searched day, not on now', () => {
  let realNow: () => number
  beforeEach(() => {
    realNow = Date.now
    Date.now = () => SEARCHED_AT
  })
  afterEach(() => {
    Date.now = realNow
  })

  const sat = (h: number, m: number) => cdt(2026, 10, 31, h, m)

  it('folds two departures on the same day, three days ahead, into one row', () => {
    // Searched Thursday 00:27, both buses Saturday morning: ~58 h ahead.
    const result = merge([
      { board: sat(10, 17), index: 0, route: '1:94' },
      { board: sat(10, 47), index: 1, route: '1:94' }
    ])
    expect(result.mergedItineraries).toHaveLength(1)
    expect(departures(result.mergedItineraries[0])).toEqual([0, 1])
    expect(inSomeRow(result)).toBe(true)
  })

  it('keeps all eight of case 14 departures, four per route row', () => {
    const result = merge([
      { board: sat(10, 17), index: 0, route: '1:94' },
      { board: sat(10, 23), index: 1, route: '1:902' },
      { board: sat(10, 47), index: 2, route: '1:94' },
      { board: sat(10, 47), index: 3, route: '1:902' },
      { board: sat(11, 17), index: 4, route: '1:94' },
      { board: sat(11, 23), index: 5, route: '1:902' },
      { board: sat(11, 47), index: 6, route: '1:94' },
      { board: sat(11, 47), index: 7, route: '1:902' }
    ])
    expect(result.mergedItineraries).toHaveLength(2)
    const [bus94, green] = result.mergedItineraries
    expect(departures(bus94)).toEqual([0, 2, 4, 6])
    expect(departures(green)).toEqual([1, 3, 5, 7])
    expect(inSomeRow(result)).toBe(true)
    // Every itinerary the card can switch to carries its row's times too.
    result.allItineraries.forEach((itin: { allStartTimes?: unknown[] }) =>
      expect(itin.allStartTimes).toHaveLength(4)
    )
  })

  it('does not fold departures on different days, and drops neither', () => {
    // Sunday 2026-11-01 is the day the clocks go back: the same bus at the
    // same wall-clock time is 25 h after Saturday's.
    const sun = (h: number, m: number) => cst(2026, 11, 1, h, m)
    const result = merge([
      { board: sat(10, 17), index: 0, route: '1:94' },
      // Sunday, same bus, same stops: not another time for Saturday's row.
      { board: sun(10, 17), index: 1, route: '1:94' },
      { board: sun(10, 47), index: 2, route: '1:94' }
    ])
    expect(result.mergedItineraries).toHaveLength(2)
    const [saturday, sunday] = result.mergedItineraries
    expect(saturday.index).toBe(0)
    expect(departures(saturday)).toEqual([])
    expect(sunday.index).toBe(1)
    // Sunday's departures still fold into Sunday's row.
    expect(departures(sunday)).toEqual([1, 2])
    expect(inSomeRow(result)).toBe(true)
  })

  it('still folds a late-night search across midnight into one row', () => {
    // Same-day behaviour unchanged: 11:47 PM and 12:17 AM answer one search
    // made at 11:40 PM (this passed before 75.6 too; a calendar-date key
    // would have split it into two rows of the same route).
    Date.now = () => cdt(2026, 10, 30, 23, 40)
    const result = merge([
      { board: cdt(2026, 10, 30, 23, 47), index: 0, route: '1:94' },
      { board: cdt(2026, 10, 31, 0, 17), index: 1, route: '1:94' }
    ])
    expect(result.mergedItineraries).toHaveLength(1)
    expect(departures(result.mergedItineraries[0])).toEqual([0, 1])
  })

  it('gives the same rows whatever the clock says', () => {
    const rides: Ride[] = [
      { board: sat(10, 17), index: 0, route: '1:94' },
      { board: sat(10, 47), index: 1, route: '1:94' },
      { board: sat(11, 17), index: 2, route: '1:94' }
    ]
    const asSearched = merge(rides).mergedItineraries.map(departures)
    Date.now = () => sat(9, 0)
    expect(merge(rides).mergedItineraries.map(departures)).toEqual(asSearched)
    Date.now = () => sat(9, 0) + 9 * DAY
    expect(merge(rides).mergedItineraries.map(departures)).toEqual(asSearched)
  })
})
