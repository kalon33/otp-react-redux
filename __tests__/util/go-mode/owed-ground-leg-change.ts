import '../../test-utils/mock-window-url'
import {
  calculateDistance,
  matchPositionToRoute
} from '../../../lib/util/go-mode/position-matching'
import { transitionLeg, updateRouteMatch } from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'
import slice from '../../mocks/owed-ground-1015-2130.json'
import slice0917 from '../../mocks/owed-ground-0917-2053.json'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'

/**
 * OWED GROUND IS OWED ALONG ONE LEG — backlog 12.17, the 2026-10-29 replay
 * sighting (stress-test replay agent R11, fixture `ride-1015-2130`, session
 * `mva4fpf5-hhg1cf`).
 *
 * The replay ran the ride's original plan (tram -> 1,000 m bike leg to MOA
 * Gate H -> 539). `unaccountedFromFix [44.88170, -93.20831]` was set at
 * 21:30:57 on the TRAM leg and never changed again: the matcher carried it
 * (with 2,302 m still owed) onto the bike leg when it accepted the leg-1
 * winner, and TRANSITION_LEG built its re-anchored match with
 * `...state.routeMatch`, so it survived that too. The off-corridor check then
 * measured the rider's displacement from a fix eight minutes and one leg old
 * (3,186 m south of it by 21:39:56), and the scalar budget had 2 x 2,724 m.
 *
 * The slice is the fixture's own fixes (their own clock: the replay ran it
 * 26.485 s later, so sim 21:38:57.484 = fixture 21:38:30.999 and sim
 * 21:39:56.534 = fixture 21:39:29.999), the plan's four legs, and the matches
 * the replay recorded on either side of the change. Threaded the way
 * `handlePositionUpdate` threads them: the stored match is the previous one,
 * the rider's own step is the gate's `movedSinceFixM`, a nomination of a leg
 * the trip has not reached is put to the transition gate — which admitted the
 * bike leg at 21:38:57 and refuses the 539 (boarding 21:53:00, 13 min out), so
 * the match is re-taken over the legs reached — and an admitted later leg is
 * followed by TRANSITION_LEG through the real reducer. This reproduces the
 * replay's matches tick for tick (0.0307 -> 0.0261 at sim 21:39:51, 0.7107 at
 * 21:39:56, 400.0 m held, 0.9992 at 21:40:12).
 */

type Fix = { accuracy: number; lat: number; lon: number; tMs: number }
const fixes = slice.fixes as Fix[]
const legs = slice.legs as any[]
const held = slice.heldLeg0Match as unknown as RouteMatchResult
const crossed = slice.crossedMatch as unknown as RouteMatchResult
const TRAM_FIX: [number, number] = [44.88170391746987, -93.20831076330735]

const hms = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/Chicago' })

const initial = goMode(undefined as any, { type: '@@INIT' } as any)

/** What the transition gate did on the replay: the bike leg yes, the 539 no. */
const GATE_ADMITS_THROUGH_LEG = 1

/** The bike leg, from the leg-0 match the replay held at 21:38:29.999. */
const run = () => {
  let state: any = { ...initial, routeMatch: held }
  let transitioned = 0
  const ticks: Array<{ fix: Fix; match: RouteMatchResult }> = []
  for (let i = 1; i < fixes.length; i++) {
    const fix = fixes[i]
    const prev = fixes[i - 1]
    const gate = {
      accuracyM: fix.accuracy,
      movedSinceFixM: calculateDistance(prev.lat, prev.lon, fix.lat, fix.lon),
      nowMs: fix.tMs
    }
    let match = matchPositionToRoute(
      [fix.lat, fix.lon],
      legs,
      state.routeMatch.legIndex,
      state.routeMatch,
      gate
    ) as RouteMatchResult
    if (
      match.legIndex > transitioned &&
      match.legIndex > GATE_ADMITS_THROUGH_LEG
    ) {
      // Refused nomination: re-taken over the legs the trip has reached.
      match = matchPositionToRoute(
        [fix.lat, fix.lon],
        legs.slice(0, transitioned + 1),
        Math.min(state.routeMatch.legIndex, transitioned),
        state.routeMatch,
        gate
      ) as RouteMatchResult
    }
    state = goMode(state, updateRouteMatch(match))
    if (match.legIndex > transitioned) {
      transitioned = match.legIndex
      state = goMode(state, transitionLeg({ legIndex: match.legIndex }))
    }
    ticks.push({ fix, match: state.routeMatch })
  }
  return ticks
}

const at = (ticks: ReturnType<typeof run>, clock: string) => {
  const tick = ticks.find((t) => hms(t.fix.tMs) === clock)
  if (!tick) throw new Error(`no fix at ${clock}`)
  return tick.match
}

describe('12.17: owed ground does not survive a leg change (ride-1015-2130)', () => {
  it('TRANSITION_LEG drops the old leg’s owed ground from the match it re-anchors', () => {
    // The match the replay stored at sim 21:38:57.484, the tick the trip moved
    // onto the bike leg: still carrying the tram leg's start and 2,302 m.
    expect(crossed.legIndex).toBe(1)
    expect(crossed.unaccountedFromFix).toEqual(TRAM_FIX)
    expect(crossed.unaccountedPathM).toBeCloseTo(2302.1, 1)

    const state = goMode(
      { ...initial, routeMatch: crossed } as any,
      transitionLeg({ legIndex: 1 })
    )
    expect(state.routeMatch.unaccountedFromFix).toBeUndefined()
    expect(state.routeMatch.unaccountedPathM).toBeUndefined()
    // ...and the re-anchor it was already making is unchanged.
    expect(state.routeMatch).toMatchObject({
      legIndex: 1,
      matchedAtMs: undefined,
      progressAlongLeg: 0,
      progressAlongSegment: 0,
      segmentIndex: 0
    })
  })

  it('the matcher starts the owed ground afresh when its winner is on another leg', () => {
    // The tram leg's last match (21:38:29.999: 2,308.8 m owed since 21:30:57)
    // and the next fix, which projects onto the bike leg 3.8 m off it.
    expect(held.legIndex).toBe(0)
    expect(held.unaccountedFromFix).toEqual(TRAM_FIX)
    const fix = fixes[1]
    const match = matchPositionToRoute([fix.lat, fix.lon], legs, 0, held, {
      accuracyM: fix.accuracy,
      movedSinceFixM: calculateDistance(
        fixes[0].lat,
        fixes[0].lon,
        fix.lat,
        fix.lon
      ),
      nowMs: fix.tMs
    }) as RouteMatchResult
    expect(match.legIndex).toBe(1)
    expect(match.progressAlongLeg).toBeCloseTo(crossed.progressAlongLeg, 6)
    expect(match.distanceFromRoute).toBeCloseTo(3.82, 2)
    expect(match.unaccountedFromFix).toEqual([fix.lat, fix.lon])
    expect(match.unaccountedPathM).toBe(0)
  })

  it('on the bike leg, the owed ground never starts before the bike leg did', () => {
    const ticks = run()
    const legStartMs = fixes[1].tMs
    for (const { match } of ticks) {
      expect(match.legIndex).toBe(1)
      const from = match.unaccountedFromFix
      if (from == null) continue
      // A fix the rider passed on THIS leg, never the tram leg's.
      expect(from).not.toEqual(TRAM_FIX)
      const owner = fixes.find((f) => f.lat === from[0] && f.lon === from[1])
      expect(owner).toBeDefined()
      expect((owner as Fix).tMs).toBeGreaterThanOrEqual(legStartMs)
    }
    // The scalar the budget doubles is the bike leg's own ground: 437.7 m by
    // fixture 21:39:28.999 (sim 21:39:55.534), where the replay had 2,723.7 m.
    expect(at(ticks, '21:39:28').unaccountedPathM).toBeCloseTo(437.7, 0)
  })

  it('an off-corridor advance is licensed by this leg’s ground, not the tram’s', () => {
    // Sim 21:40:02.534 (fixture 21:39:35.999): 0.7107 -> 0.9992, 288.5 m along
    // a leg the rider was 400 m off. On the tram leg's start the replay took it
    // (displacement 3,251 m south of the 21:30:57 fix); on the bike leg's own
    // ground the rider has moved ~65 m since the 21:39:56 re-start, so it is
    // held until their own ride pays for it (fixture 21:39:45.999).
    const ticks = run()
    expect(at(ticks, '21:39:35').progressAlongLeg).toBeCloseTo(0.7107, 4)
    expect(at(ticks, '21:39:35').isOnRoute).toBe(false)
    expect(at(ticks, '21:39:35').distanceFromRoute).toBeCloseTo(400.0, 0)
    expect(at(ticks, '21:39:44').progressAlongLeg).toBeCloseTo(0.7107, 4)
    expect(at(ticks, '21:39:45').progressAlongLeg).toBeCloseTo(0.9992, 4)
  })

  it('does not by itself stop the 21:39:56 jump: the bike leg’s own ground licenses it too (open)', () => {
    // Measured, not wanted. Fixture 21:39:29.999 = sim 21:39:56.534: 0.0261 ->
    // 0.7107 (684.6 m) 400 m off the line. From the bike leg's own start the
    // rider has moved 411 m — 394 m of it due south, parallel to segment 45,
    // which runs due south — and the off-corridor check's along-segment credit
    // gives 25 + 2 x 394 = 813 m >= 684.6 m. The rider got 60 m closer to Gate
    // H doing it (484 -> 424 m straight-line). Whether that credit should hold
    // 400 m from a looping leg is a question for the guard, not for the
    // carried-over start this row named; see the build report.
    const ticks = run()
    expect(at(ticks, '21:39:28').progressAlongLeg).toBeCloseTo(0.0261, 4)
    expect(at(ticks, '21:39:29').progressAlongLeg).toBeCloseTo(0.7107, 4)
    expect(at(ticks, '21:39:29').distanceFromRoute).toBeCloseTo(400.0, 0)
  })
})

/**
 * The same carry-over where it DID license the jump: replay
 * `orange-0917-2053` (bike -> 16.5 km bus -> 3,970 m bike), on the plan the
 * 21:05:56 re-plan installed. The owed ground the bus leg handed to the
 * closing bike leg at TRANSITION_LEG 2 (21:33:32, replay clock) had started at
 * 21:07:12 on LEG 0. At 21:39:19 the rider was 888 m off the bike leg with its
 * projection on segment 1 (6 %), and the leg's far end became the nearer
 * point: 0.06 -> 0.985, 527.8 m off the line, licensed by the rider's
 * 14,455 m displacement from that leg-0 fix. Measured from the bike leg's own
 * opening fix the displacement is 1,251 m and the advance is refused; it is
 * taken at 21:41:22, the first tick the rider is back inside the corridor
 * (87.3 m), by the ordinary budget.
 *
 * The slice is the replay's own fixes (lat/lon/accuracy and the replay clock
 * they were stamped with), the three legs, and the bus-leg match the replay
 * stored at 21:33:31.087. Leg 2 is the last leg, so there is no nomination
 * for the transition gate to refuse after it.
 */
describe('12.17: owed ground does not survive a leg change (orange-0917-2053)', () => {
  const fixes0917 = slice0917.fixes as Fix[]
  const legs0917 = slice0917.legs as any[]
  const heldBus = slice0917.heldLeg1Match as unknown as RouteMatchResult

  const run0917 = () => {
    let state: any = { ...initial, routeMatch: heldBus }
    let transitioned = 1
    const ticks: Array<{ fix: Fix; match: RouteMatchResult }> = []
    for (let i = 1; i < fixes0917.length; i++) {
      const fix = fixes0917[i]
      const prev = fixes0917[i - 1]
      const match = matchPositionToRoute(
        [fix.lat, fix.lon],
        legs0917,
        state.routeMatch.legIndex,
        state.routeMatch,
        {
          accuracyM: fix.accuracy,
          movedSinceFixM: calculateDistance(
            prev.lat,
            prev.lon,
            fix.lat,
            fix.lon
          ),
          nowMs: fix.tMs
        }
      ) as RouteMatchResult
      state = goMode(state, updateRouteMatch(match))
      if (match.legIndex > transitioned) {
        transitioned = match.legIndex
        state = goMode(state, transitionLeg({ legIndex: match.legIndex }))
      }
      ticks.push({ fix, match: state.routeMatch })
    }
    return ticks
  }

  it('starts on the bus leg with ground owed since 21:07:12 on leg 0', () => {
    expect(heldBus.legIndex).toBe(1)
    expect(hms(slice0917.owedSinceMs)).toBe('21:07:12')
    expect(heldBus.unaccountedPathM).toBeCloseTo(326.7, 1)
  })

  it('holds the bike leg’s far end until the rider is back on the line', () => {
    const ticks = run0917()
    // The change itself, on the replay's tick.
    expect(hms(ticks[0].fix.tMs)).toBe('21:33:32')
    expect(ticks[0].match.legIndex).toBe(2)
    // Every owed-ground start from here on is a bike-leg fix.
    for (const { match } of ticks) {
      const from = match.unaccountedFromFix
      if (from == null) continue
      const owner = fixes0917.find(
        (f) => f.lat === from[0] && f.lon === from[1]
      )
      expect(owner).toBeDefined()
      expect((owner as Fix).tMs).toBeGreaterThanOrEqual(ticks[0].fix.tMs)
    }
    // 21:39:19: the far end is the nearer point, 527.8 m away — held at 6 %.
    expect(at(ticks, '21:39:19').progressAlongLeg).toBeCloseTo(0.06, 2)
    expect(at(ticks, '21:39:19').isOnRoute).toBe(false)
    // ...through 21:41:21 (102 m off, still outside the corridor)...
    expect(at(ticks, '21:41:21').progressAlongLeg).toBeCloseTo(0.06, 2)
    // ...and released on the first tick back inside it.
    expect(at(ticks, '21:41:22').progressAlongLeg).toBeCloseTo(0.985, 3)
    expect(at(ticks, '21:41:22').isOnRoute).toBe(true)
    expect(at(ticks, '21:41:22').distanceFromRoute).toBeCloseTo(87.3, 1)
    // No off-corridor tick ever reads more than the 6 % it opened on.
    const offCorridor = ticks.filter(({ match }) => !match.isOnRoute)
    expect(offCorridor.length).toBeGreaterThan(400)
    expect(
      Math.max(...offCorridor.map(({ match }) => match.progressAlongLeg))
    ).toBeLessThan(0.07)
  })
})
