import {
  onwardRouteOfItinerary,
  pickSameRouteAlight,
  rankAlightOptions
} from '../../../lib/util/go-mode/alight-optimizer'
import { onwardTransitRouteId } from '../../../lib/util/go-mode/reroute-candidates'
import fixture from '../../../lib/util/go-mode/replay/fixtures/orange-alight-backwards.json'

/**
 * Backlog item 4 from the 2026-08-09 ride: the rider's METRO D Line came back
 * replaced. Driven from the ride's own recorded plans (session
 * msmhi3j5-lnt6uw), because the item's original diagnosis was wrong and only
 * the recording settles what is left of it.
 *
 * What the recording says after the 8/10 fixes: the two departed route 22s are
 * gone, and the three reachable options are route 5 (22 min), route 5 (23 min)
 * and the rider's own D Line (26 min). So the D Line is no longer DROPPED — it
 * is ranked third by a comparator that has never heard of it, and with a
 * five-slot cap and a wider candidate spread it is one crowded list away from
 * disappearing again. keepRouteId is what makes that impossible.
 */

const recordedOptions = (fixture as any).onboard.result.payload
/** When the ranked options were produced. */
const RESULT_MS = (fixture as any).onboard.result.tMs // 1786321761182
/** The poisoned anchor every recorded option was planned from. */
const POISONED_EPOCH = 1786321200000
/** The rider's own onward route: METRO D Line. */
const D_LINE = '1:924'
/** The Orange Line they were aboard. */
const ORANGE = '1:904'

const recordedResults = [
  {
    busArrivalEpoch: POISONED_EPOCH,
    error: false,
    itineraries: recordedOptions.map((o: any) => o.itinerary),
    realtime: true,
    stopId: '1:53313',
    stopName: '2nd Ave S & 7th St - Stop Group F'
  }
]

const reachable = (opts: { keepRouteId?: string; limit?: number } = {}) =>
  rankAlightOptions(recordedResults as any, { nowMs: RESULT_MS, ...opts })

const routesOf = (options: any[]) =>
  options.map((o) => onwardRouteOfItinerary(o.itinerary))

describe('util > go-mode > the rider keeps the route they chose (8/9)', () => {
  // Provenance. If the fixture stops carrying the D Line these tests pass
  // vacuously, which is worse than not having them — the same guard
  // alight-backwards-0809.ts opens with.
  it('the ride really did plan a D Line leg the optimizer could replace (8/9)', () => {
    const legs = (fixture as any).itinerary.legs
    expect(legs.map((l: any) => l.routeId ?? null)).toEqual([
      ORANGE,
      null,
      D_LINE,
      null
    ])
    // Five recorded options, all from the same stop; the D Line is one of
    // them and the two route 22s are the ones the reachability fix removes.
    expect(routesOf(recordedOptions)).toEqual([
      '1:5',
      '1:5',
      D_LINE,
      '1:22',
      '1:22'
    ])
  })

  it('reads the chosen onward route past the bus the rider is on (8/9)', () => {
    const itinerary = (fixture as any).itinerary
    // Pre-trip: no leg index yet, so the boarded route identifies the leg to
    // skip. Mid-ride: the leg index does it directly.
    expect(onwardTransitRouteId(itinerary, { boardedRouteId: ORANGE })).toBe(
      D_LINE
    )
    expect(onwardTransitRouteId(itinerary, { afterLegIndex: 0 })).toBe(D_LINE)
    // Nothing to preserve once the D Line is behind them.
    expect(onwardTransitRouteId(itinerary, { afterLegIndex: 2 })).toBeNull()
    expect(onwardTransitRouteId(null)).toBeNull()
  })

  it('ranks the chosen route third without keepRouteId — the state that fix 4 is for (8/9)', () => {
    expect(routesOf(reachable())).toEqual(['1:5', '1:5', D_LINE])
  })

  it('holds a slot for the chosen route when the cap would cut it (8/9)', () => {
    // Two slots, and the two route 5s are both faster: unguarded, the D Line
    // is off the list the rider taps.
    expect(routesOf(reachable({ limit: 2 }))).toEqual(['1:5', '1:5'])
    const kept = reachable({ keepRouteId: D_LINE, limit: 2 })
    expect(kept).toHaveLength(2)
    expect(routesOf(kept)).toEqual(['1:5', D_LINE])
  })

  it('does not promote the chosen route past a genuinely faster one (8/9)', () => {
    // 22 min vs 26 min is a real difference, not noise — the rider still sees
    // the fast option first and can take it. Only ties go the other way.
    expect(routesOf(reachable({ keepRouteId: D_LINE }))).toEqual([
      '1:5',
      '1:5',
      D_LINE
    ])
  })

  it('finds the chosen route for the automatic path, or nothing at all (8/9)', () => {
    const ranked = reachable({ keepRouteId: D_LINE })
    expect(
      onwardRouteOfItinerary(pickSameRouteAlight(ranked, D_LINE)!.itinerary)
    ).toBe(D_LINE)
    // Nothing onward on their route means the automatic path must not apply.
    expect(pickSameRouteAlight(ranked, '1:18')).toBeNull()
    expect(pickSameRouteAlight(ranked, null)).toBeNull()
    expect(pickSameRouteAlight(null, D_LINE)).toBeNull()
  })
})

/**
 * The tie-break, on built inputs: the 8/9 options are 4 minutes apart, outside
 * the tie window by design, so the recording cannot exercise this clause.
 */
describe('util > go-mode > keepRouteId wins ties', () => {
  const leg = (routeId: string | null) => ({
    mode: routeId ? 'BUS' : 'BICYCLE',
    routeId,
    transitLeg: !!routeId
  })
  const itin = (routeId: string, duration: number, name: string) => ({
    duration,
    endTime: 2000000 + duration * 1000,
    legs: [leg(null), leg(routeId), leg(null)],
    startTime: 2000000,
    transfers: 0,
    walkDistance: 100,
    // Distinguishes the journey signatures so neither is deduped away.
    walkTime: name.length
  })
  const results = (a: any, b: any) => [
    {
      busArrivalEpoch: 1000000,
      error: false,
      itineraries: [a, b],
      realtime: true,
      stopId: '1:1',
      stopName: 'A'
    }
  ]

  it('prefers the rider’s route when the difference is noise', () => {
    // 60 s apart: inside TIE_MS (180 s).
    const mine = itin('1:924', 1000, 'mine')
    const other = itin('1:5', 940, 'other')
    expect(
      rankAlightOptions(results(other, mine) as any, {
        keepRouteId: '1:924'
      }).map((o) => onwardRouteOfItinerary(o.itinerary))
    ).toEqual(['1:924', '1:5'])
    // Without it, the faster one leads.
    expect(
      rankAlightOptions(results(other, mine) as any, {}).map((o) =>
        onwardRouteOfItinerary(o.itinerary)
      )
    ).toEqual(['1:5', '1:924'])
  })

  it('leaves a real difference alone', () => {
    // 300 s apart: outside the tie window, so speed wins and the rider still
    // sees it first.
    const mine = itin('1:924', 1240, 'mine')
    const other = itin('1:5', 940, 'other')
    expect(
      rankAlightOptions(results(other, mine) as any, {
        keepRouteId: '1:924'
      }).map((o) => onwardRouteOfItinerary(o.itinerary))
    ).toEqual(['1:5', '1:924'])
  })
})
