import { doMergeItineraries } from '../../../lib/components/narrative/narrative-itineraries'

/**
 * Backlog 28.4. On the production app (2026-09-23 08:10, session
 * mue4dnyd-ek7bzu) the rider tapped the "You leave 8:32 AM, 9:18 AM, ... or
 * 10:03 AM" links on a trip and the STOP changed along with the time: "Do not
 * change the stop when I change times!" The route-signature merge folds runs
 * of the same routes together whatever stops they use, and every folded
 * departure became a time link. A time link must change the time only; a run
 * that alights elsewhere stays under the "N options" toggle, which names it.
 */

// 2026-09-23T13:00:00Z = 8:00 AM CDT; only relative minutes matter here.
const BASE = Date.UTC(2026, 8, 23, 13, 0, 0)
const MIN = 60000

const HOME = { lat: 44.9311, lon: -93.2801, name: 'Home' }
const LAKE = { lat: 44.9483, lon: -93.2728, name: 'Lake St/Midtown Station' }
const I35W_98 = { lat: 44.8266, lon: -93.2893, name: 'I-35W & 98th St Station' }
const I35W_66 = { lat: 44.8833, lon: -93.2877, name: 'I-35W & 66th St Station' }
const WORK = { lat: 44.8201, lon: -93.2951, name: 'Work' }

type Spec = { alight: typeof I35W_98; departMin: number; index: number }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function orangeLine({ alight, departMin, index }: Spec): any {
  const start = BASE + departMin * MIN
  return {
    duration: 3000,
    endTime: start + 50 * MIN,
    index,
    legs: [
      {
        distance: 1900,
        endTime: start + 8 * MIN,
        from: HOME,
        mode: 'BICYCLE',
        startTime: start,
        to: LAKE
      },
      {
        distance: 15000,
        endTime: start + 35 * MIN,
        from: LAKE,
        mode: 'BUS',
        routeId: 'METROTRANSIT:903',
        routeShortName: 'Orange',
        startTime: start + 10 * MIN,
        to: alight,
        transitLeg: true
      },
      {
        distance: 2500,
        endTime: start + 50 * MIN,
        from: alight,
        mode: 'BICYCLE',
        startTime: start + 36 * MIN,
        to: WORK
      }
    ],
    startTime: start
  }
}

const at832 = { alight: I35W_98, departMin: 32, index: 0 }
const at918 = { alight: I35W_66, departMin: 78, index: 1 }
const at1003 = { alight: I35W_98, departMin: 123, index: 2 }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function merge(specs: Spec[]): any[] {
  // A fresh array each call: doMergeItineraries is memoized on its argument.
  return doMergeItineraries(specs.map(orangeLine), undefined, true)
    .mergedItineraries
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const linkMinutes = (row: any) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row.allStartTimes.map((t: any) => (t.itinerary.startTime - BASE) / MIN)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const variantIndexes = (row: any) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row.sameShapeVariants.map((v: any) => v.index).sort()

describe('components > narrative > "You leave" time links keep the stop (28.4)', () => {
  it('still folds all three runs into one row', () => {
    expect(merge([at832, at918, at1003])).toHaveLength(1)
  })

  it('lists only the runs that alight at the same stop as the time links', () => {
    const [row] = merge([at832, at918, at1003])
    expect(row.index).toBe(0)
    // 8:32 and 10:03 alight at 98th St; 9:18 alights at 66th St.
    expect(linkMinutes(row)).toEqual([32, 123])
    // ...and the 66th St run is still reachable, under the toggle.
    expect(variantIndexes(row)).toEqual([0, 1, 2])
  })

  it('filters against the new representative when the row changes hands', () => {
    // The 9:18 (66th St) run is found first and holds the row until the
    // earlier 8:32 (98th St) run arrives and takes it over.
    const [row] = merge([at918, at832, at1003])
    expect(row.startTime).toBe(BASE + 32 * MIN)
    expect(linkMinutes(row)).toEqual([32, 123])
    expect(variantIndexes(row)).toEqual([0, 1, 2])
  })

  it('keeps a same-stop run the old representative had turned away', () => {
    // 9:18 (66th St) holds the row and turns away 10:03 (98th St); when 8:32
    // (98th St) takes over, 10:03 is one of ITS times and must be on the links.
    const [row] = merge([at918, at1003, at832])
    expect(row.startTime).toBe(BASE + 32 * MIN)
    expect(linkMinutes(row)).toEqual([32, 123])
    expect(variantIndexes(row)).toEqual([0, 1, 2])
  })

  it('keeps every same-stop run on the links', () => {
    const [row] = merge([at832, { ...at918, alight: I35W_98 }, at1003])
    expect(linkMinutes(row)).toEqual([32, 78, 123])
  })
})
