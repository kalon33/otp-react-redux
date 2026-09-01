import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import {
  calculateCumulativeDistances,
  calculateDistance,
  decodeLegGeometry,
  matchPositionToRoute
} from '../../../lib/util/go-mode/position-matching'
import {
  endGoMode,
  handlePositionUpdate,
  transitionLeg
} from '../../../lib/actions/go-mode'
import { getNextStopOnRide } from '../../../lib/util/go-mode/next-stop'
import fixture from '../../../lib/util/go-mode/replay/fixtures/orange-early-board-0828.json'
import goMode from '../../../lib/reducers/go-mode'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'

/**
 * The 2026-08-28 ride (session mtdh67f3-0z5p24), driven from its own recorded
 * GPS track — the same recording Session 1.4 measured.
 *
 * 1.4 fitted a speed ceiling to the projection and concluded that "every large
 * mid-ride jump happens while isOnRoute is already false". Re-measured against
 * this fixture, that is not what the ride says. Attributing every tick's
 * unexplained along-leg motion (projection movement in excess of the rider's
 * own fix-to-fix displacement) by corridor state gives, ungated:
 *
 *     isOnRoute true  : 3,177 ticks, 5,523 m
 *     isOnRoute false :   657 ticks, 4,600 m
 *
 * More than half the invented metres are logged with the rider ON the line,
 * 0–6 m from it — the 215 m access leg that folds back on itself, where two
 * candidate segments sit sub-metre apart and the strict global minimum picks
 * between them on GPS noise. BACKWARD_JUMP_HYSTERESIS_M was built for exactly
 * that shape but only ever looked backward, so every forward flip went
 * through: 165 m of "progress" in one second, nine times over.
 *
 * So the band is now applied in both directions, as a preference among
 * candidates that are equally good: within MATCH_NEAR_TIE_M of the best
 * perpendicular distance, take the one nearest to the projection already held.
 * It cannot pin a rider — a candidate better by more than the band still wins
 * outright — and it needs no clock, no accuracy and no rate limit.
 */

const initial = goMode(undefined, { type: '@@INIT' } as any)

const legs: any[] = (fixture as any).itinerary.legs

const legDistances = legs.map((leg) => {
  const polyline = decodeLegGeometry(leg)
  if (polyline.length < 2) return 0
  const cumulative = calculateCumulativeDistances(polyline)
  return cumulative[cumulative.length - 1]
})

const track = [...(fixture as any).gpsTrack].sort(
  (a: any, b: any) => a.tMs - b.tMs
)

const between = (fromIso: string, toIso: string) =>
  track.filter(
    (fix: any) => fix.tMs >= Date.parse(fromIso) && fix.tMs <= Date.parse(toIso)
  )

/**
 * Replay a stretch of the recorded track through the matcher exactly as
 * handlePositionUpdate now calls it — previous match threaded, gate armed off
 * the fix's own accuracy and clock — and total the along-leg movement that the
 * rider's own displacement does NOT account for.
 *
 * Deliberately no imported constants in the arithmetic: a build that exports
 * none computes NaN, every comparison against NaN is false, and the case would
 * pass on exactly the source it exists to fail against.
 */
const unexplained = (fixes: any[], startLegIndex: number) => {
  let currentLegIndex = startLegIndex
  let previous: RouteMatchResult | null = null
  let previousFix: any = null
  let ticksOver50 = 0
  let totalM = 0
  let worstM = 0

  for (const fix of fixes) {
    const match = matchPositionToRoute(
      [fix.lat, fix.lon],
      legs,
      currentLegIndex,
      previous,
      { accuracyM: fix.accuracy, nowMs: fix.tMs }
    )
    if (!match) continue

    if (previous && previousFix && match.legIndex === previous.legIndex) {
      const movedM =
        Math.abs(match.progressAlongLeg - previous.progressAlongLeg) *
        legDistances[match.legIndex]
      const riderM = calculateDistance(
        previousFix.lat,
        previousFix.lon,
        fix.lat,
        fix.lon
      )
      const excess = Math.max(0, movedM - riderM)
      if (excess > 50) ticksOver50++
      totalM += excess
      if (movedM > worstM) worstM = movedM
    }

    if (match.legIndex > currentLegIndex) currentLegIndex = match.legIndex
    previous = match
    previousFix = fix
  }

  return { ticksOver50, totalM, worstM }
}

describe('go-mode > near-tie continuity (2026-08-28)', () => {
  // Provenance: the recording still has to carry the defect's own input.
  it('the recording still carries the folded access leg', () => {
    expect((fixture as any).meta.session).toBe('mtdh67f3-0z5p24')
    expect(legs[0].mode).toBe('BICYCLE')
    // 215 m of leg, and the rider's fixes 0–6 m from it while the projection
    // was crossing 165 m of it per second.
    expect(legDistances[0]).toBeGreaterThan(200)
    expect(legDistances[0]).toBeLessThan(230)
  })

  // 16:41:00–16:41:10 local, on the folded access leg. The unfixed matcher
  // reports 164.6 m covered between the 21:41:03Z and 21:41:04Z fixes while
  // the rider's own fix moved 1 m and sat 1 m from the line — on-route by any
  // reading, so no corridor test and no speed ceiling reaches it.
  it('does not flip across the fold at 16:41 with the rider on the line', () => {
    const { totalM, worstM } = unexplained(
      between('2026-08-28T21:41:00Z', '2026-08-28T21:41:10Z'),
      0
    )
    expect(worstM).toBeLessThan(60)
    expect(totalM).toBeLessThan(20)
  })

  // The whole four minutes on that leg, both passes over the fold. Unfixed
  // (gate armed, as it now ships): three flips, 458 invented metres.
  //
  // Honestly: the WORST single step here does NOT improve — 166 m unfixed
  // against 163 m fixed. At 21:43:15–23 the rider stands where the shape
  // passes twice and both candidates sit 7–12 m away, a genuine tie, so the
  // projection holds the pass it was already on until the evidence separates
  // them at :24 and then moves 165 m at once. That step is the ambiguity
  // resolving, not motion being invented; what the rule removes is the two
  // flips that happened while the evidence never separated at all.
  it('cuts the flips on the folded access leg from three to one', () => {
    const { ticksOver50, totalM } = unexplained(
      between('2026-08-28T21:40:30Z', '2026-08-28T21:44:30Z'),
      0
    )
    expect(ticksOver50).toBeLessThanOrEqual(1)
    expect(totalM).toBeLessThan(250)
  })

  // The whole ride, both bike legs and the Orange Line, 3,842 fixes, one pass.
  // Unfixed (gate armed, as it now ships): 30 ticks and 8,015 m.
  it('cuts the ride-long invented motion by half again', () => {
    const { ticksOver50, totalM } = unexplained(track, 0)
    expect(ticksOver50).toBeLessThanOrEqual(10)
    expect(totalM).toBeLessThan(5000)
  })

  // The rule may only ever slow the projection down, never lose the trip.
  it('still finishes the ride on the leg the ungated matcher does', () => {
    let currentLegIndex = 0
    let previous: RouteMatchResult | null = null
    for (const fix of track) {
      const match = matchPositionToRoute(
        [fix.lat, fix.lon],
        legs,
        currentLegIndex,
        previous,
        { accuracyM: fix.accuracy, nowMs: fix.tMs }
      )
      if (!match) continue
      if (match.legIndex > currentLegIndex) currentLegIndex = match.legIndex
      previous = match
    }
    expect(previous!.legIndex).toBe(2)
    // Within a few metres of the ungated 0.9509 on a ~2 km leg: the near-tie
    // preference can lag by at most the width of the band at each vertex.
    expect(previous!.progressAlongLeg).toBeGreaterThan(0.94)
  })
})

describe('go-mode > the near-tie band works in both directions', () => {
  // The same out-and-back the 8/27 backward case uses: one polyline unit
  // (~0.8 m at this latitude) between the outbound and return passes, which is
  // the least precision-5 encoding can express and about what the real flip
  // was worth.
  const outAndBack = encode([
    [44.97, -93.27],
    [44.975, -93.27],
    [44.98, -93.27],
    [44.975, -93.27001],
    [44.97, -93.27001]
  ])
  const legs1 = [{ legGeometry: { points: outAndBack }, mode: 'BUS' }] as any[]

  /** Marginally closer to the OUTBOUND pass (~25% along). */
  const leaningOutbound: [number, number] = [44.97501, -93.269998]
  /** Marginally closer to the RETURN pass (~75% along). */
  const leaningReturn: [number, number] = [44.97501, -93.270012]

  it('the geometry really is a sub-metre tie', () => {
    const out = matchPositionToRoute(leaningOutbound, legs1)!
    const ret = matchPositionToRoute(leaningReturn, legs1)!
    expect(out.progressAlongLeg).toBeLessThan(0.5)
    expect(ret.progressAlongLeg).toBeGreaterThan(0.5)
    // Both projections are within a metre of the rider, so neither is a better
    // measurement than the other.
    expect(out.distanceFromRoute).toBeLessThan(1)
    expect(ret.distanceFromRoute).toBeLessThan(1)
  })

  it('holds position when a near-tie would drag progress FORWARD', () => {
    // Established on the outbound pass...
    const held = matchPositionToRoute(leaningOutbound, legs1)!
    expect(held.progressAlongLeg).toBeLessThan(0.5)
    // ...and one tick later the noise leans the other way. The unfixed matcher
    // takes it and reports half the leg covered in a second.
    const next = matchPositionToRoute(leaningReturn, legs1, 0, held)!
    expect(next.progressAlongLeg).toBeLessThan(0.5)
  })

  it('still holds position when a near-tie would drag progress BACKWARD', () => {
    const held = matchPositionToRoute(leaningReturn, legs1)!
    expect(held.progressAlongLeg).toBeGreaterThan(0.5)
    const next = matchPositionToRoute(leaningOutbound, legs1, 0, held)!
    expect(next.progressAlongLeg).toBeGreaterThan(0.5)
  })

  // A fold whose two passes are ~78 m apart: no longer a tie, so the rule must
  // get out of the way entirely. A preference that could outvote a real
  // measurement would pin the rider to a stale point forever.
  const wideFold = encode([
    [44.97, -93.27],
    [44.975, -93.27],
    [44.98, -93.27],
    [44.975, -93.271],
    [44.97, -93.271]
  ])
  const legs2 = [{ legGeometry: { points: wideFold }, mode: 'BUS' }] as any[]

  it('lets a candidate that is genuinely closer win outright', () => {
    const onOutbound = matchPositionToRoute([44.975, -93.27], legs2)!
    expect(onOutbound.progressAlongLeg).toBeLessThan(0.5)
    const onReturn = matchPositionToRoute(
      [44.975, -93.271],
      legs2,
      0,
      onOutbound
    )!
    expect(onReturn.progressAlongLeg).toBeGreaterThan(0.5)
  })

  it('is unchanged when the caller passes no previous match', () => {
    expect(matchPositionToRoute(leaningReturn, legs1, 0, null)).toEqual(
      matchPositionToRoute(leaningReturn, legs1)
    )
  })
})

describe('go-mode > the re-anchored match carries no stamp', () => {
  // TRANSITION_LEG synthesizes a routeMatch for the manual "I got off
  // here"/onboard paths: it spreads the old match, moves legIndex and zeroes
  // progress. The nearestPoint it keeps still belongs to the OLD leg, and the
  // continuity gate measures a cross-leg move as ground distance from exactly
  // that point — so a stamp left on this match makes the next honest
  // projection look like a several-hundred-metre teleport and holds it.
  const withMatch = () => ({
    ...initial,
    routeMatch: {
      distanceFromRoute: 12,
      isOnRoute: true,
      legIndex: 1,
      matchedAtMs: 1787868000000,
      nearestPoint: [44.9, -93.2] as [number, number],
      progressAlongLeg: 0.98,
      progressAlongSegment: 0.6,
      segmentIndex: 7
    }
  })

  it('TRANSITION_LEG drops matchedAtMs', () => {
    const next = goMode(withMatch() as any, transitionLeg({ legIndex: 2 }))
    expect(next.routeMatch!.legIndex).toBe(2)
    expect(next.routeMatch!.matchedAtMs).toBeUndefined()
  })

  it('so the next tick is not gated against the old leg', () => {
    const next = goMode(withMatch() as any, transitionLeg({ legIndex: 2 }))
    const straight = encode([
      [44.92, -93.27],
      [44.94, -93.27]
    ])
    const twoLegs = [
      { legGeometry: { points: straight }, mode: 'WALK' },
      { legGeometry: { points: straight }, mode: 'WALK' },
      { legGeometry: { points: straight }, mode: 'BICYCLE' }
    ] as any[]
    // A first honest fix on the new leg, one second later. It is ~2 km from
    // the stale nearestPoint the re-anchor kept, which no budget would allow.
    const match = matchPositionToRoute(
      [44.93, -93.27],
      twoLegs,
      2,
      next.routeMatch,
      { accuracyM: 8, nowMs: 1787868001000 }
    )
    expect(match).not.toBe(next.routeMatch)
    expect(match!.legIndex).toBe(2)
  })
})

describe('go-mode > the stop counter refuses off-corridor progress', () => {
  // A transit leg's corridor is 250 m. Off it the nearest point on the shape
  // slides freely — 266 m, then 315 m, then 397 m on single one-second fixes
  // on 8/28 — and reading that as a fraction of the leg passes stops the
  // vehicle has not reached. The arrival-time fallback is a real alternative.
  const busLeg = {
    from: { lat: 44.95, lon: -93.27, name: 'Board' },
    intermediatePlaces: [
      { arrivalTime: 2000, lat: 44.96, lon: -93.27, name: 'First' },
      { arrivalTime: 3000, lat: 44.97, lon: -93.27, name: 'Second' }
    ],
    legGeometry: {
      points: encode([
        [44.95, -93.27],
        [44.98, -93.27]
      ])
    },
    mode: 'BUS',
    to: { arrivalTime: 4000, lat: 44.98, lon: -93.27, name: 'Alight' },
    transitLeg: true
  }

  const stateWith = (routeMatch: any) => ({
    otp: {
      goMode: {
        activeItinerary: { legs: [busLeg] },
        isActive: true,
        riding: { legIndex: 0, tripId: null },
        routeMatch
      },
      transitIndex: { trips: {} }
    }
  })

  it('uses the projection while the rider is inside the corridor', () => {
    const next = getNextStopOnRide(
      stateWith({
        distanceFromRoute: 10,
        isOnRoute: true,
        legIndex: 0,
        progressAlongLeg: 0.5
      }),
      1000
    )
    expect(next!.name).toBe('Second')
  })

  it('falls back to arrival times once the projection is a fiction', () => {
    // Same fabricated 0.5 — two thirds of the way down the leg — but the rider
    // is 400 m off the shape, so it is not a measurement. By the clock the bus
    // has not reached the first stop yet.
    const next = getNextStopOnRide(
      stateWith({
        distanceFromRoute: 400,
        isOnRoute: false,
        legIndex: 0,
        progressAlongLeg: 0.5
      }),
      1000
    )
    expect(next!.name).toBe('First')
  })
})

describe('go-mode > the gate is wired to the fix that armed it', () => {
  let dateFaker: FakeTimers.InstalledClock | undefined
  let store: any

  const makeStore = () => {
    let state: any = {
      ...initial,
      activeItinerary: (fixture as any).itinerary,
      isActive: true,
      routeMatch: null,
      tracking: { ...initial.tracking, lastPosition: null }
    }
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: {},
        goMode: state,
        transitIndex: { routes: {}, stops: {} }
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return undefined
      state = goMode(state, action)
      return action
    }
    return { getState, run: (thunk: any) => thunk(dispatch, getState) }
  }

  const opening = track.slice(0, 12)

  beforeAll(() => {
    dateFaker = FakeTimers.install({ now: opening[0].tMs, toFake: ['Date'] })
    store = makeStore()
    for (const fix of opening) {
      dateFaker.setSystemTime(fix.tMs)
      store.run(
        handlePositionUpdate({
          coords: {
            accuracy: fix.accuracy,
            altitude: null,
            altitudeAccuracy: null,
            heading: fix.heading,
            latitude: fix.lat,
            longitude: fix.lon,
            speed: fix.speed
          },
          timestamp: fix.tMs
        } as GeolocationPosition)
      )
    }
  })

  afterAll(() => {
    store?.run(endGoMode())
    dateFaker?.uninstall()
  })

  // The stamp is the whole handoff: without it the gate has no elapsed time,
  // computes no budget, and every tick is ungated no matter what the matcher
  // supports. It has to be the FIX's clock, not the wall clock, or a replayed
  // ride gates somewhere the live one did not.
  it('stamps the stored match with the fix timestamp', () => {
    const stored = store.getState().otp.goMode.routeMatch
    expect(stored).not.toBeNull()
    expect(stored.matchedAtMs).toBe(opening[opening.length - 1].tMs)
  })
})
