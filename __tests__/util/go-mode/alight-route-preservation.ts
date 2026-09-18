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
 * gone, and three options remain reachable. keepRouteId is what stops the cap
 * cutting the rider's own route out of the list they tap.
 *
 * RE-MEASURED 2026-09-17, and the original reading of this fixture was wrong —
 * it was reading backlog 15.9 (the ranker scored every waiting option as if
 * the wait were free) and calling it a comparator that had never heard of
 * keepRouteId. All times here are local (CDT), the basis the ride notes
 * use. The three options are route 5 (22 min of RIDING, ending
 * 20:04:01), route 5 (23 min, ending 20:04:01) and the D Line (26 min, ending
 * **20:02:01**). The D Line is the longest ride and the EARLIEST arrival: it
 * starts at 19:35:38, five to six minutes before either route 5, because the route 5
 * plans wait 21-22 minutes at the stop and OTP's just-in-time itineraries put
 * that wait outside `duration`. Scored honestly the rider's own route wins on
 * its own merits and no slot needs holding at all.
 *
 * So the "ranked third" framing is retired, and what is still worth testing —
 * that keepRouteId holds a slot and never promotes a genuinely faster option
 * down — is tested below against a list whose order is now correct.
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

  it('ranks the chosen route FIRST once the wait is not free (8/9, 15.9)', () => {
    // The measurement that retires this row's "ranked third" framing. The
    // three plans all leave from the same poisoned anchor (19:20:00) and the
    // D Line's is the only one that does not sit at the stop for twenty
    // minutes first.
    expect(routesOf(reachable())).toEqual([D_LINE, '1:5', '1:5'])
    const ends = reachable().map((o: any) => Number(o.itinerary.endTime))
    expect(ends).toEqual([1786323721000, 1786323841000, 1786323841000])
    // What the shipped score said instead, off the same three plans:
    // 19:42:09, 19:43:05 and 19:46:23 — the D Line last, 4m14s behind, on a
    // journey that actually lands two minutes ahead.
    const legacy = [...reachable()]
      .map((o: any) => ({
        route: onwardRouteOfItinerary(o.itinerary),
        score: POISONED_EPOCH + (o.itinerary.duration || 0) * 1000
      }))
      .sort((a, b) => a.score - b.score)
    expect(legacy.map((l) => l.route)).toEqual(['1:5', '1:5', D_LINE])
    expect(legacy[2].score - legacy[0].score).toBe(254000)
  })

  it('holds a slot for the chosen route when the cap would cut it (8/9)', () => {
    // The mechanism, on the case that still needs it: ask for one slot and the
    // chosen route is the only thing in it, even though something else could
    // have taken it.
    const oneUnguarded = reachable({ limit: 1 })
    expect(oneUnguarded).toHaveLength(1)
    const kept = reachable({ keepRouteId: '1:5', limit: 1 })
    expect(kept).toHaveLength(1)
    expect(routesOf(kept)).toEqual(['1:5'])
    // ...and the route the rider did NOT choose is what got displaced.
    expect(routesOf(oneUnguarded)).toEqual([D_LINE])
  })

  it('does not promote the chosen route past a genuinely faster one (8/9)', () => {
    // 20:02:01 vs 20:04:01 is 120 s, inside TIE_MS, so on THIS fixture the tie
    // clause would promote either. The guard that matters is the one against a
    // real difference, which the fixture no longer contains — so it is checked
    // where it can be: the chosen route never displaces an option that arrives
    // more than the tie window earlier.
    const ranked = reachable({ keepRouteId: '1:5' })
    const arrivals = ranked.map((o: any) => Number(o.itinerary.endTime))
    expect(arrivals[0]).toBeLessThanOrEqual(arrivals[1] + 180000)
    expect(routesOf(ranked)).toHaveLength(3)
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
