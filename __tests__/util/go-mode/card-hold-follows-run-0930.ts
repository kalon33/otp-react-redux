import { readFileSync } from 'fs'
import path from 'path'

import {
  getLegRouteId,
  getRouteDepartures,
  HeldDeparture,
  legBoardingDirection,
  resolveCardDeparture,
  RouteDeparture
} from '../../../lib/util/go-mode/departure-anchor'
import { tripIdsMatch } from '../../../lib/util/go-mode/trip-id'

/**
 * Backlog 38.1 — session `muomy26h-g1zujp`, 2026-09-30, dev `2026.0930.1`,
 * replayed from `ride-0930-1648-card.json` — `ride-0930-1648.json` without its
 * reroute/routing payloads; the 58 stop polls of I-35W & 46th St Station are
 * whole.
 *
 * Rider, 17:08:00: *"Seems like live bus times lag a bit. And they don't show
 * as live which is always concerning? Why does the live symbol go away so
 * often?"*
 *
 * The plan boarded trip `1:1273254` at 17:06:44. START_GO_MODE landed at
 * 16:48:08.716 and the first stop poll at 16:48:08.857, so the first render
 * had no departures at all and seeded on the plan's 17:06:44 with no trip id.
 * The hold then matched rows by exact epoch only — the poll said 17:06:43 —
 * and the card sat on 17:06:44 through 14 CARD_DEPARTURE_MISMATCH records
 * (16:48:09 - 16:57:05, every one `held`, `heldTripId null`) while the same
 * bus moved as late as 17:08:55, with no live mark. Only the 16:57:48 quiet
 * re-plan re-seeded it on the run.
 */

const fixture = JSON.parse(
  readFileSync(
    path.join(
      __dirname,
      '../../../lib/util/go-mode/replay/fixtures/ride-0930-1648-card.json'
    ),
    'utf8'
  )
)

/** 2026-09-30 local (CDT, UTC-5) wall clock as an epoch. */
const at = (h: number, m: number, s = 0) => Date.UTC(2026, 8, 30, h + 5, m, s)

const busLeg = fixture.itinerary.legs[1]
const TRIP = '1:1273254'
const PLAN_MS = busLeg.startTime as number // 17:06:44
const START_MS = fixture.meta.startMs as number // 16:48:08.716
const REPLAN_MS = at(16, 57, 48)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Snapshot = { payload: any; tMs: number }
const polls: Snapshot[] = fixture.stopTimeSnapshots

const departuresOf = (poll: Snapshot | undefined): RouteDeparture[] =>
  poll
    ? getRouteDepartures(
        poll.payload,
        getLegRouteId(busLeg),
        legBoardingDirection(busLeg)
      )
    : []

const tripRow = (departures: RouteDeparture[]) =>
  departures.find((d) => tripIdsMatch(d.tripId, TRIP))

/** WalkingNavigation's `departureIsLive`: an exact match on a realtime row. */
const isLive = (ms: number | null, departures: RouteDeparture[]) =>
  ms != null && departures.some((d) => d.depMs === ms && d.realtime)

type Render = {
  departureMs: number | null
  heldTripId: string | null
  live: boolean
  reason: string
  rowMs: number | null
  tMs: number
}

/**
 * The card from START_GO_MODE to the quiet re-plan: one render with no poll
 * yet, then one per stop poll, carrying the hold the way holdRef does.
 */
function replay(tickTripId: string | null): Render[] {
  const moments: Array<{ poll?: Snapshot; tMs: number }> = [
    { tMs: START_MS },
    ...polls
      .filter((p) => p.tMs < REPLAN_MS)
      .map((p) => ({ poll: p, tMs: p.tMs }))
  ]
  let held: HeldDeparture | null = null
  return moments.map(({ poll, tMs }) => {
    const departures = departuresOf(poll)
    const decision = resolveCardDeparture({
      candidateMs: null,
      departures,
      held,
      nowMs: tMs,
      plannedDepartureMs: PLAN_MS,
      tickTripId
    })
    held = decision.held
    return {
      departureMs: decision.departureMs,
      heldTripId: decision.held?.tripId ?? null,
      live: isLive(decision.departureMs, departures),
      reason: decision.reason,
      rowMs: tripRow(departures)?.depMs ?? null,
      tMs
    }
  })
}

describe('38.1 — a card hold with no trip id follows the trip’s run', () => {
  it('the fixture says what the row says', () => {
    expect(PLAN_MS).toBe(at(17, 6, 44))
    expect(busLeg.trip.gtfsId).toBe(TRIP)
    expect(polls[0].tMs).toBeGreaterThan(START_MS) // no poll at the first render
    const first = tripRow(departuresOf(polls[0]))
    expect(first?.depMs).toBe(at(17, 6, 43))
    expect(first?.realtime).toBe(true)
    const window = polls.filter((p) => p.tMs < REPLAN_MS)
    const rows = window.map((p) => tripRow(departuresOf(p)))
    expect(rows.every((r) => r?.realtime)).toBe(true)
    expect(Math.max(...rows.map((r) => r?.depMs ?? 0))).toBe(at(17, 8, 55))
  })

  it('BEFORE (no trip to follow): the card freezes on the plan’s 17:06:44 with no live mark', () => {
    const renders = replay(null).slice(1)
    expect(renders.every((r) => r.departureMs === PLAN_MS)).toBe(true)
    expect(renders.every((r) => r.heldTripId == null)).toBe(true)
    expect(renders.every((r) => !r.live)).toBe(true)
    // The recorded shape: `held`, heldTripId null, card != the run's row.
    const mismatches = renders.filter(
      (r) =>
        r.reason === 'held' && r.heldTripId == null && r.departureMs !== r.rowMs
    )
    expect(mismatches.length).toBe(renders.length)
  })

  it('AFTER: from the first poll the card IS the run’s row, named and live', () => {
    const [seed, ...renders] = replay(TRIP)
    // No poll yet: nothing to follow, so the plan time stands (unchanged).
    expect(seed.reason).toBe('seeded')
    expect(seed.departureMs).toBe(PLAN_MS)
    expect(seed.heldTripId).toBeNull()
    expect(renders.length).toBeGreaterThan(20)
    for (const r of renders) {
      expect(r.departureMs).toBe(r.rowMs)
      expect(tripIdsMatch(r.heldTripId, TRIP)).toBe(true)
      expect(r.live).toBe(true)
      expect(r.reason).toBe('held')
    }
    expect(
      renders.filter((r) => r.heldTripId == null && r.departureMs !== r.rowMs)
        .length
    ).toBe(0)
    // The 16:55:19 poll's 17:08:55 is on the card, not 17:06:44.
    expect(renders.some((r) => r.departureMs === at(17, 8, 55))).toBe(true)
  })

  it('seeds on the trip’s row when the poll is already in and nothing projected', () => {
    const departures = departuresOf(polls[0])
    const d = resolveCardDeparture({
      candidateMs: null,
      departures,
      held: null,
      nowMs: polls[0].tMs,
      plannedDepartureMs: PLAN_MS,
      tickTripId: TRIP
    })
    expect(d.reason).toBe('seeded')
    expect(d.departureMs).toBe(at(17, 6, 43))
    expect(tripIdsMatch(d.held?.tripId, TRIP)).toBe(true)
  })

  it('a seed one second off every row still names the trip’s run', () => {
    const departures = departuresOf(polls[0])
    const d = resolveCardDeparture({
      candidateMs: PLAN_MS, // 17:06:44 — no row at that exact epoch
      departures,
      held: null,
      nowMs: polls[0].tMs,
      plannedDepartureMs: PLAN_MS,
      tickTripId: TRIP
    })
    expect(d.departureMs).toBe(PLAN_MS)
    expect(tripIdsMatch(d.held?.tripId, TRIP)).toBe(true)
  })

  it('once it names the run, 19.1’s split test works: a plan moved to another run takes the card', () => {
    const departures = departuresOf(polls[0])
    const other = departures.find(
      (d) => d.tripId && !tripIdsMatch(d.tripId, TRIP)
    )
    expect(other).toBeDefined()
    const adopted = resolveCardDeparture({
      candidateMs: null,
      departures,
      held: { departureMs: PLAN_MS, tripId: null },
      nowMs: polls[0].tMs,
      plannedDepartureMs: PLAN_MS,
      tickTripId: TRIP
    })
    const moved = resolveCardDeparture({
      candidateMs: null,
      departures,
      held: adopted.held,
      nowMs: polls[0].tMs,
      plannedDepartureMs: other?.depMs,
      tickTripId: other?.tripId
    })
    expect(
      moved.reason === 'released-split' || moved.reason === 'adopted-earlier'
    ).toBe(true)
    expect(moved.departureMs).toBe(other?.depMs)
  })

  it('a trip id the poll does not list leaves the exact-epoch behaviour alone', () => {
    const departures = departuresOf(polls[0])
    const d = resolveCardDeparture({
      candidateMs: null,
      departures,
      held: { departureMs: PLAN_MS, tripId: null },
      nowMs: polls[0].tMs,
      plannedDepartureMs: PLAN_MS,
      tickTripId: '1:does-not-run'
    })
    expect(d).toEqual({
      departureMs: PLAN_MS,
      held: { departureMs: PLAN_MS, tripId: null },
      reason: 'held'
    })
  })

  it('a definitive miss still releases an adopted hold', () => {
    const departures = departuresOf(polls[0])
    const d = resolveCardDeparture({
      boardingMiss: { definitive: true },
      candidateMs: null,
      departures,
      held: { departureMs: PLAN_MS, tripId: null },
      nowMs: polls[0].tMs,
      plannedDepartureMs: PLAN_MS,
      tickTripId: TRIP
    })
    expect(d.reason).toBe('released-missed')
  })
})
