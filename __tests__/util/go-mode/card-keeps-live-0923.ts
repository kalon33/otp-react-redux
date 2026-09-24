import { readFileSync } from 'fs'
import path from 'path'

import {
  getLegRouteId,
  getRouteDepartures,
  HeldDeparture,
  legBoardingDirection,
  overrideDepartureForTick,
  resolveCardDeparture,
  RouteDeparture
} from '../../../lib/util/go-mode/departure-anchor'
import { getUpcomingTransitTiming } from '../../../lib/util/go-mode/progress-calculator'
import { mergeLiveTimePoint } from '../../../lib/util/go-mode/alight-optimizer'
import { stopLevelBoardDeparture } from '../../../lib/util/go-mode/board-departure'
import { tripIdsMatch } from '../../../lib/util/go-mode/trip-id'
import goMode from '../../../lib/reducers/go-mode'
import type { LiveTimePoint } from '../../../lib/util/go-mode/alight-optimizer'

/**
 * Backlog 29.3 — ride 1 of session `muek9u3n-n8e67r`, 2026-09-23, replayed
 * from `ride-0923-1542.json` (46 stop polls of I-35W & 98th St, 15:42:03 to
 * 15:57:07).
 *
 * Rider, 16:09:26: *"It's not using live time when it slides. If the bus is
 * slipping don't just switch to scheduled times!"*
 *
 * (1) At 15:42:16 the rider tapped their own bus, trip `1:1346795`, at its
 *     live 15:53:49. The card froze on that minute while every stop poll for
 *     the same trip slid it later, and "Later departures" offered the same bus
 *     again as "Next: 3:55".
 * (2) At 15:55:23 the stop poll flipped the same trip to SCHEDULED, whose
 *     time is the timetable 15:45:00, and the card jumped ten minutes into the
 *     past. The last live time, from the 15:55:02 poll, was 15:54:12.
 *
 * Every number below is read out of the fixture, not typed in: the `at()`
 * epochs only name the moments.
 */

const fixture = JSON.parse(
  readFileSync(
    path.join(
      __dirname,
      '../../../lib/util/go-mode/replay/fixtures/ride-0923-1542.json'
    ),
    'utf8'
  )
)

/** 2026-09-23 local (CDT, UTC-5) wall clock as an epoch. */
const at = (h: number, m: number, s = 0) => Date.UTC(2026, 8, 23, h + 5, m, s)

const bikeLeg = fixture.itinerary.legs[0]
const busLeg = fixture.itinerary.legs[1]
const TRIP = '1:1346795' // the rider's bus, the plan's own run
const RIDER_TAP_MS = 1790196829000 // SET_DEPARTURE_OVERRIDE 15:42:16, = 15:53:49

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Snapshot = { payload: any; tMs: number }
const polls: Snapshot[] = fixture.stopTimeSnapshots

/** The poll the store holds at `nowMs` — the replay engine's at-or-before. */
const pollAt = (nowMs: number): Snapshot =>
  polls.filter((s) => s.tMs <= nowMs).slice(-1)[0]

const departuresAt = (nowMs: number): RouteDeparture[] =>
  getRouteDepartures(
    pollAt(nowMs).payload,
    getLegRouteId(busLeg),
    legBoardingDirection(busLeg)
  )

/** The trip id exactly as the departure row spells it (what a tap stores). */
const rowTripId = (departures: RouteDeparture[]) =>
  departures.find((d) => tripIdsMatch(d.tripId, TRIP))?.tripId as string

/** The tick's liveLegTimes board point, rebuilt poll by poll up to `nowMs`. */
function liveBoardAt(nowMs: number) {
  let point: LiveTimePoint | null = null
  polls
    .filter((s) => s.tMs <= nowMs)
    .forEach((s) => {
      point = mergeLiveTimePoint(
        point,
        stopLevelBoardDeparture(s.payload, TRIP),
        s.tMs
      )
    })
  const p = point as LiveTimePoint | null
  return p
    ? {
        boardEpoch: p.epoch,
        boardIsFloor: !!p.isFloor,
        boardRealtime: !!p.realtime
      }
    : null
}

/**
 * The card, driven the way WalkingNavigation drives it: one call per poll,
 * each carrying the previous decision's hold forward.
 */
function cardAt(
  nowMs: number,
  opts: {
    fromMs: number
    override?: number | null
    overrideTrip?: string | null
    seed?: HeldDeparture | null
  }
) {
  let held: HeldDeparture | null = opts.seed ?? null
  let decision = null as ReturnType<typeof resolveCardDeparture> | null
  polls
    .filter((s) => s.tMs >= opts.fromMs && s.tMs <= nowMs)
    .concat([{ payload: null, tMs: nowMs }])
    .forEach((s) => {
      const t = s.tMs
      decision = resolveCardDeparture({
        boardingMiss: null,
        candidateMs: null,
        departureOverride: opts.override ?? null,
        departureOverrideTripId: opts.overrideTrip ?? null,
        departures: departuresAt(t),
        held,
        nowMs: t,
        plannedDepartureMs: Number(busLeg.startTime),
        tickTripId: TRIP
      })
      held = decision.held
    })
  return decision as ReturnType<typeof resolveCardDeparture>
}

describe('29.3 — the card keeps the live time of the bus the rider picked', () => {
  it('the fixture says what the row says', () => {
    // The stop poll for the rider's trip slid 15:53:49 -> 15:55:44 across
    // the frozen stretch, then flipped to the timetable.
    const own = (t: number) =>
      departuresAt(t).find((d) => tripIdsMatch(d.tripId, TRIP))
    expect(own(at(15, 42, 16))?.depMs).toBe(RIDER_TAP_MS)
    expect(own(at(15, 46, 0))).toMatchObject({
      depMs: at(15, 55, 32),
      realtime: true
    })
    expect(own(at(15, 46, 15))?.depMs).toBe(at(15, 55, 34))
    expect(own(at(15, 46, 35))?.depMs).toBe(at(15, 55, 44))
    expect(own(at(15, 55, 10))).toMatchObject({
      depMs: at(15, 54, 12),
      realtime: true
    })
    expect(own(at(15, 55, 24))).toMatchObject({
      depMs: at(15, 45, 0),
      realtime: false
    })
  })

  describe('(a) a tap picks a run, and the run is followed', () => {
    const TAP = at(15, 42, 16)
    const tripAsTapped = rowTripId(departuresAt(TAP))

    it.each([
      ['15:46:00', at(15, 46, 0), at(15, 55, 32)],
      ['15:46:15', at(15, 46, 15), at(15, 55, 34)],
      ['15:46:35', at(15, 46, 35), at(15, 55, 44)],
      ['15:47:15', at(15, 47, 15), at(15, 56, 11)]
    ])(
      'at %s the headline is the run’s live time, not 15:53:49',
      (_, now, live) => {
        const card = cardAt(now, {
          fromMs: TAP,
          override: RIDER_TAP_MS,
          overrideTrip: tripAsTapped
        })
        expect(card.departureMs).toBe(live)
        expect(card.departureMs).not.toBe(RIDER_TAP_MS)
        expect(card.reason).toBe('override')
        expect(tripIdsMatch(card.held?.tripId, TRIP)).toBe(true)
      }
    )

    it.each([
      ['15:46:00', at(15, 46, 0), at(15, 55, 32)],
      ['15:46:15', at(15, 46, 15), at(15, 55, 34)]
    ])(
      'at %s the tick counts down to the same time as the card',
      (_, now, live) => {
        const tickOverride = overrideDepartureForTick({
          boardingLegTripId: busLeg.trip.gtfsId,
          departureOverrideMs: RIDER_TAP_MS,
          departureOverrideTripId: tripAsTapped,
          departures: departuresAt(now),
          liveBoard: liveBoardAt(now)
        })
        const liveBoard = liveBoardAt(now)
        const timing = getUpcomingTransitTiming(
          new Date(now),
          bikeLeg,
          busLeg,
          0.5,
          tickOverride,
          liveBoard?.boardRealtime ? liveBoard.boardEpoch : null
        )
        expect(timing.effectiveDepartureMs).toBe(live)
        // Still the rider's own pick: "Back to …" stays on offer.
        expect(timing.departureIsOverridden).toBe(true)
        const card = cardAt(now, {
          fromMs: TAP,
          override: RIDER_TAP_MS,
          overrideTrip: tripAsTapped
        })
        expect(timing.effectiveDepartureMs).toBe(card.departureMs)
      }
    )

    it('a pick of a DIFFERENT run follows that run', () => {
      // Synthetic: the rider taps the 16:02:15 (trip ...3NjA) at 15:47:32 and
      // the plan re-target is refused, so the override outlives the tap. By
      // 15:55:44 that run's live time is 16:04:39.
      const tap = at(15, 47, 32)
      const other = departuresAt(tap).find(
        (d) => !tripIdsMatch(d.tripId, TRIP) && d.depMs > at(16, 0)
      ) as RouteDeparture
      expect(other.depMs).toBe(at(16, 2, 15))
      const card = cardAt(at(15, 55, 45), {
        fromMs: tap,
        override: other.depMs,
        overrideTrip: other.tripId
      })
      expect(card.departureMs).toBe(at(16, 4, 39))
      expect(card.held?.tripId).toBe(other.tripId)
      expect(
        overrideDepartureForTick({
          boardingLegTripId: busLeg.trip.gtfsId,
          departureOverrideMs: other.depMs,
          departureOverrideTripId: other.tripId as string,
          departures: departuresAt(at(15, 55, 45)),
          liveBoard: liveBoardAt(at(15, 55, 45))
        })
      ).toBe(at(16, 4, 39))
    })

    it('a pick with no run id is the bare minute it always was', () => {
      const card = cardAt(at(15, 46, 15), {
        fromMs: TAP,
        override: RIDER_TAP_MS
      })
      expect(card.departureMs).toBe(RIDER_TAP_MS)
      expect(
        overrideDepartureForTick({
          boardingLegTripId: busLeg.trip.gtfsId,
          departureOverrideMs: RIDER_TAP_MS,
          departureOverrideTripId: null,
          departures: departuresAt(at(15, 46, 15)),
          liveBoard: liveBoardAt(at(15, 46, 15))
        })
      ).toBe(RIDER_TAP_MS)
    })
  })

  describe('(b) a flip to the timetable does not pull the time backwards', () => {
    it('15:55:23 (the poll lands at .xxx; asserted at :24): the held run keeps the last live 15:54:12, not 15:45:00', () => {
      // After "Back to planned" at 15:47:22 the card held the trip itself.
      const card = cardAt(at(15, 55, 24), {
        fromMs: at(15, 47, 22),
        seed: {
          departureMs: at(15, 56, 11),
          tripId: rowTripId(departuresAt(at(15, 47, 22)))
        }
      })
      expect(card.departureMs).toBe(at(15, 54, 12))
      expect(card.departureMs).not.toBe(at(15, 45, 0))
      expect(card.reason).toBe('held')
      // ...and it does not match a realtime row, so it is drawn plain (Q1 = B).
      expect(
        departuresAt(at(15, 55, 24)).some(
          (d) => d.depMs === card.departureMs && d.realtime
        )
      ).toBe(false)
    })

    it('stays on the floor through every later schedule-only poll', () => {
      const card = cardAt(at(15, 57, 7), {
        fromMs: at(15, 47, 22),
        seed: {
          departureMs: at(15, 56, 11),
          tripId: rowTripId(departuresAt(at(15, 47, 22)))
        }
      })
      expect(card.departureMs).toBe(at(15, 54, 12))
    })

    it('the rider’s own pick keeps it too, card and tick alike', () => {
      const tap = at(15, 42, 16)
      const now = at(15, 55, 24)
      const card = cardAt(now, {
        fromMs: tap,
        override: RIDER_TAP_MS,
        overrideTrip: rowTripId(departuresAt(tap))
      })
      expect(card.departureMs).toBe(at(15, 54, 12))
      // The tick's own mergeLiveTimePoint already held the same floor.
      expect(liveBoardAt(now)).toEqual({
        boardEpoch: at(15, 54, 12),
        boardIsFloor: true,
        boardRealtime: false
      })
      expect(
        overrideDepartureForTick({
          boardingLegTripId: busLeg.trip.gtfsId,
          departureOverrideMs: RIDER_TAP_MS,
          departureOverrideTripId: rowTripId(departuresAt(tap)),
          departures: departuresAt(now),
          liveBoard: liveBoardAt(now)
        })
      ).toBe(at(15, 54, 12))
    })

    it('a timetable time LATER than the last one still moves it', () => {
      const run: RouteDeparture = {
        depMs: at(15, 58, 0),
        realtime: false,
        routeId: '1:904',
        tripId: TRIP
      }
      const card = resolveCardDeparture({
        candidateMs: null,
        departures: [run],
        held: { departureMs: at(15, 54, 12), tripId: TRIP },
        nowMs: at(15, 55, 24),
        tickTripId: TRIP
      })
      expect(card.departureMs).toBe(at(15, 58, 0))
    })

    it('a realtime row moves it either way', () => {
      const run: RouteDeparture = {
        depMs: at(15, 53, 0),
        realtime: true,
        routeId: '1:904',
        tripId: TRIP
      }
      const card = resolveCardDeparture({
        candidateMs: null,
        departures: [run],
        held: { departureMs: at(15, 54, 12), tripId: TRIP },
        nowMs: at(15, 52, 0),
        tickTripId: TRIP
      })
      expect(card.departureMs).toBe(at(15, 53, 0))
    })

    it('the definitive miss still releases the floor', () => {
      const now = at(15, 57, 7)
      const card = resolveCardDeparture({
        boardingMiss: { definitive: true },
        candidateMs: at(16, 5, 39),
        departures: departuresAt(now),
        held: {
          departureMs: at(15, 54, 12),
          tripId: rowTripId(departuresAt(now))
        },
        nowMs: now,
        tickTripId: TRIP
      })
      expect(card.reason).toBe('released-missed')
      expect(card.departureMs).toBe(at(16, 5, 39))
    })
  })

  describe('the store keeps the run beside the minute', () => {
    const initial = goMode(undefined, { type: '@@INIT' })
    const pick = (payload: unknown) =>
      goMode(initial, { payload, type: 'SET_DEPARTURE_OVERRIDE' })

    it('stores the run a tap names', () => {
      const state = pick({ ms: RIDER_TAP_MS, source: 'rider', tripId: TRIP })
      expect(state.departureOverride).toBe(RIDER_TAP_MS)
      expect(state.departureOverrideTripId).toBe(TRIP)
    })

    it('an anchor epoch names no run', () => {
      expect(pick(RIDER_TAP_MS).departureOverrideTripId).toBeNull()
    })

    it('a reset clears the run with the minute', () => {
      const picked = pick({ ms: RIDER_TAP_MS, source: 'rider', tripId: TRIP })
      const reset = goMode(picked, {
        payload: { ms: null, source: 'rider', tripId: TRIP },
        type: 'SET_DEPARTURE_OVERRIDE'
      })
      expect(reset.departureOverride).toBeNull()
      expect(reset.departureOverrideTripId).toBeNull()
    })

    it('a new plan clears it (12.14)', () => {
      const picked = pick({ ms: RIDER_TAP_MS, source: 'rider', tripId: TRIP })
      const swapped = goMode(picked, {
        payload: fixture.itinerary,
        type: 'START_GO_MODE'
      })
      expect(swapped.departureOverrideTripId).toBeNull()
    })
  })
})
