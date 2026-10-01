/* globals afterEach, beforeEach, describe, expect, it, jest */
import FakeTimers from '@sinonjs/fake-timers'

import {
  endGoMode,
  retargetPlanToDeparture,
  selectDeparture
} from '../../../lib/actions/go-mode'
import {
  evaluateDepartureAnchor,
  getRouteDepartures,
  getSoonestCatchableMs,
  HeldDeparture,
  legBoardingDirection,
  resolveCardDeparture
} from '../../../lib/util/go-mode/departure-anchor'
import { getUpcomingTransitTiming } from '../../../lib/util/go-mode/progress-calculator'
import { retargetTransitLegToRun } from '../../../lib/util/go-mode/leg-merge'
import { tripGtfsId } from '../../../lib/util/go-mode/trip-id'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(
    () => () => Promise.resolve({ error: false, itineraries: [] })
  ),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * Backlog 23.3 — "the plan follows the card". Session `mubbbiy9-6zjoq9`,
 * 2026-09-21 09:02 ride, fixture `0921-0902-orange-lake-st.json`.
 *
 * The rider set off to cycle to I-35W & Lake St for an itinerary whose bus leg
 * was the 10:12 Orange Line (`1:1348464`). The auto-anchor was right about the
 * bus almost immediately — `SET_DEPARTURE_OVERRIDE {source: 'anchor'}` at
 * 09:02:05 (ms 09:15:27), again 09:02:59 (09:15:22) and 09:03:20 (09:14:54) —
 * and the 09:15 is the one that came. Nothing else moved: `departureOverride`
 * is a display value, so `trip.gtfsId`, `liveLegTimes`, the sheet's wait and
 * the vehicle matcher's gate all stayed on the 10:12.
 *
 * At 09:12:57 the rider wrote that the sheet showed a **61 min wait** to a
 * 10:13 board. At 09:23:01, three surfaces named three buses: *"The list does
 * not agree with the top banner. The states are majorly screwed up"*. And
 * `CARD_DEPARTURE_MISMATCH` ran 26 records from the 09:05:51 Reset to 09:20:17
 * with `heldTripId VHJpcDoxOjEyNjg5NTI` (= `Trip:1:1268952`, the 09:15)
 * against a tick departure of 10:13:05 — 19.1's second sighting, whose cause
 * this row is.
 *
 * Asked plainly on the pipeline board (Q7) whether the WHOLE plan should
 * switch when the card adopts an earlier real run of the same route from the
 * same stop, the rider answered: **"YES duh!!"**.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fx: any = require('../../../lib/util/go-mode/replay/fixtures/0921-0902-orange-lake-st.json')

const ROUTE_ID = '1:904'
const BOARD_STOP = '1:17781'
/** The plan's bus: the 10:12 Orange Line. */
const PLANNED_TRIP = '1:1348464'
/** The one that came, and the one the anchor moved the card to. */
const ADOPTED_TRIP = '1:1268952'
/**
 * `SET_DEPARTURE_OVERRIDE {ms: 1790000094000, source: 'anchor'}`, 09:03:20.073
 * — the third of the ride's three anchor overrides (09:02:05 -> 09:15:27,
 * 09:02:59 -> 09:15:22, 09:03:20 -> 09:14:54), all of them the same run, the
 * live prediction walking. It is the one the FIXTURE can evidence: recording
 * began 09:02:58 and its first Lake St poll is the one this epoch came out of.
 */
const ANCHORED_MS = 1790000094000
/** The rider's Reset, `{ms: null, source: 'rider'}`. */
const RESET_AT = 1789999551791

/** The sheet the rider was looking at: the 09:03:00 quiet access re-plan. */
const ITINERARY = fx.itinerarySwaps[0].itinerary

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

const stopSnapshots = () =>
  fx.stopTimeSnapshots
    .filter((s: any) => s.stopId === BOARD_STOP)
    .sort((a: any, b: any) => a.tMs - b.tMs)

/** The first recorded Lake St poll, 09:02:59 — the one the anchor read. */
const ANCHOR_AT: number = fx.stopTimeSnapshots
  .filter((s: any) => s.stopId === BOARD_STOP)
  .reduce((min: number, s: any) => Math.min(min, s.tMs), Infinity)

const snapshotAt = (atMs: number) => {
  let best: any = null
  for (const s of stopSnapshots()) {
    if (s.tMs <= atMs && (!best || s.tMs > best.tMs)) best = s
  }
  return best ?? stopSnapshots()[0]
}

const departuresAt = (atMs: number, itinerary: any = ITINERARY) =>
  getRouteDepartures(
    snapshotAt(atMs).payload,
    ROUTE_ID,
    legBoardingDirection(itinerary.legs[1])
  )

/** The run the anchor picked, in the shape retargetTransitLegToRun wants. */
const anchoredRun = (itinerary: any = ITINERARY) => {
  const d = departuresAt(ANCHOR_AT, itinerary).find(
    (x) => x.depMs === ANCHORED_MS
  )!
  return {
    departureMs: d.depMs,
    headsign: d.headsign ?? null,
    realtime: d.realtime,
    tripId: tripGtfsId(d.tripId) as string
  }
}

/**
 * The gap the trip sheet prints above a transit leg — `waitSecondsBeforeLeg`
 * in TripSheet.tsx, for a boarding that is not the one `progress.waitTimeAtStop`
 * covers: the bus's departure less the arrival of the leg before it.
 */
const sheetWaitSeconds = (itinerary: any, i: number) =>
  (Number(itinerary.legs[i].startTime) -
    Number(itinerary.legs[i - 1].endTime)) /
  1000

describe('go-mode > the fixture is the ride the row describes', () => {
  it('has the rider cycling to Lake St for a bus an hour out', () => {
    expect(fx.meta.session).toBe('mubbbiy9-6zjoq9')
    expect(ITINERARY.legs[0].mode).toBe('BICYCLE')
    expect(hhmmss(ITINERARY.legs[0].endTime)).toBe('09:09:36')
    expect(ITINERARY.legs[1].transitLeg).toBe(true)
    expect(ITINERARY.legs[1].trip.gtfsId).toBe(PLANNED_TRIP)
    expect(ITINERARY.legs[1].from.stop.gtfsId).toBe(BOARD_STOP)
    expect(hhmmss(ITINERARY.legs[1].startTime)).toBe('10:12:00')
  })

  it('and the 09:15 in the stop feed, on the pattern the plan is on', () => {
    const run = anchoredRun()
    expect(run.tripId).toBe(ADOPTED_TRIP)
    expect(hhmmss(run.departureMs)).toBe('09:14:54')
    expect(run.realtime).toBe(true)
    expect(run.headsign).toBe('ORANGE Burnsville')
  })

  it('the anchor picks it out of the feed unprompted, as it did', () => {
    const decision = evaluateDepartureAnchor(null, {
      departureOverride: null,
      departures: departuresAt(ANCHOR_AT),
      manualLock: false,
      nowMs: ANCHOR_AT,
      plannedBoardMs: ITINERARY.legs[1].startTime,
      rideSecondsRemaining: ITINERARY.legs[0].duration
    })
    // The recorded SET_DEPARTURE_OVERRIDE of 09:03:20.073, to the millisecond.
    expect(hhmmss(ANCHOR_AT)).toBe('09:02:59')
    expect(decision.anchorMs).toBe(ANCHORED_MS)
  })

  it('this stop serves ONE direction of the route, so 19.1 changes nothing', () => {
    // Lake St publishes only `1:904:1:01` (ORANGE Burnsville). The direction
    // filter must be inert here — it is the wrong-direction case's fix, not a
    // general narrowing that could cost this ride its bus.
    const all = getRouteDepartures(snapshotAt(ANCHOR_AT).payload, ROUTE_ID)
    expect(departuresAt(ANCHOR_AT)).toEqual(all)
  })
})

describe('go-mode > re-targeting the plan onto the adopted run (23.3)', () => {
  it('puts the bus leg on the run the card moved to', () => {
    const next = retargetTransitLegToRun(ITINERARY, 1, anchoredRun())!
    expect(next).not.toBeNull()
    expect(next.legs[1].transitLeg).toBe(true)
    expect((next.legs[1] as any).trip.gtfsId).toBe(ADOPTED_TRIP)
    expect((next.legs[1] as any).tripId).toBe(ADOPTED_TRIP)
    expect(hhmmss(Number(next.legs[1].startTime))).toBe('09:14:54')
    // Same route, same boarding stop, same alight stop, same geometry.
    expect((next.legs[1] as any).route).toBe((ITINERARY.legs[1] as any).route)
    expect(next.legs[1].from.stop.gtfsId).toBe(BOARD_STOP)
    expect(next.legs[1].to.stop.gtfsId).toBe('1:56833')
    expect(next.legs[1].legGeometry).toBe(ITINERARY.legs[1].legGeometry)
    expect(next.legs[1].duration).toBe(ITINERARY.legs[1].duration)
  })

  it('collapses the 61-minute wait the rider was shown', () => {
    const before = sheetWaitSeconds(ITINERARY, 1)
    const after = sheetWaitSeconds(
      retargetTransitLegToRun(ITINERARY, 1, anchoredRun())!,
      1
    )
    // 10:12:00 less a bike leg ending 09:09:36.
    expect(Math.round(before / 60)).toBe(62)
    // 09:14:54 less the same bike leg. The rider's note said "61 min wait".
    expect(Math.round(after / 60)).toBe(5)
  })

  it('and the wait the tick itself computes, with no override in force', () => {
    const wait = (itinerary: any) =>
      getUpcomingTransitTiming(
        new Date(ANCHOR_AT),
        itinerary.legs[0],
        itinerary.legs[1],
        0,
        null,
        null,
        null
      )
    const before = wait(ITINERARY)
    const after = wait(retargetTransitLegToRun(ITINERARY, 1, anchoredRun())!)
    expect(Math.round((before.waitTimeAtStop as number) / 60)).toBe(62)
    expect(Math.round((after.waitTimeAtStop as number) / 60)).toBe(5)
    // The plan's own board time is the adopted one now — nothing downstream
    // has to know about an override to agree with the card.
    expect(hhmmss(after.plannedDepartureTime as number)).toBe('09:14:54')
    expect(after.departureIsOverridden).toBe(false)
  })

  it('carries the rest of the trip with it and leaves the access leg alone', () => {
    const next = retargetTransitLegToRun(ITINERARY, 1, anchoredRun())!
    // The 7/29 promise the other splicers keep: legs before the change are the
    // SAME objects.
    expect(next.legs[0]).toBe(ITINERARY.legs[0])
    expect(hhmmss(Number(next.legs[2].startTime))).toBe('09:33:54')
    expect(hhmmss(Number(next.legs[2].endTime))).toBe('09:47:44')
    expect(next.legs[2].duration).toBe(ITINERARY.legs[2].duration)
    expect(hhmmss(Number(next.endTime))).toBe('09:47:44')
    expect(next.startTime).toBe(ITINERARY.startTime)
    expect(next.duration).toBe(2684)
  })

  it('refuses when there is nothing to do or nothing to do it with', () => {
    expect(retargetTransitLegToRun(ITINERARY, 0, anchoredRun())).toBeNull()
    expect(retargetTransitLegToRun(ITINERARY, 1, null)).toBeNull()
    expect(
      retargetTransitLegToRun(ITINERARY, 1, {
        ...anchoredRun(),
        tripId: PLANNED_TRIP
      })
    ).toBeNull()
    expect(
      retargetTransitLegToRun(ITINERARY, 1, {
        ...anchoredRun(),
        departureMs: NaN
      })
    ).toBeNull()
  })
})

describe('go-mode > the card and the plan name one bus (19.1 + 23.3)', () => {
  /** The card's loop over every recorded Lake St poll, as WalkingNavigation
   *  runs it: getRouteDepartures -> getSoonestCatchableMs -> the hold. */
  const runCard = (itinerary: any, tickAware: boolean) => {
    const leg = itinerary.legs[1]
    const tickTripId = tickAware ? legBoardingDirection(leg).tripId : null
    let held: HeldDeparture | null = null
    const log: Array<{ heldTripId: string | null; reason: string }> = []
    for (const snap of stopSnapshots()) {
      if (snap.tMs < RESET_AT) continue
      const departures = getRouteDepartures(
        snap.payload,
        ROUTE_ID,
        legBoardingDirection(leg)
      )
      const decision = resolveCardDeparture({
        candidateMs: getSoonestCatchableMs(departures, snap.tMs, 0),
        departures,
        held,
        nowMs: snap.tMs,
        plannedDepartureMs: Number(leg.startTime),
        tickTripId
      })
      held = decision.held
      log.push({
        heldTripId: tripGtfsId(decision.held?.tripId),
        reason: decision.reason
      })
    }
    return log
  }

  const disagreements = (log: any[], planTrip: string) =>
    log.filter((r) => r.heldTripId && r.heldTripId !== planTrip).length

  it('BEFORE: the card holds the 09:15 while the plan holds the 10:12', () => {
    const log = runCard(ITINERARY, false)
    // Every pass from the Reset onward, exactly the recorded symptom: 26
    // CARD_DEPARTURE_MISMATCH records 09:05:51 -> 09:20:17, heldTripId
    // Trip:1:1268952, tickDepartureMs 10:13:05.
    expect(log.length).toBe(45)
    expect(disagreements(log, PLANNED_TRIP)).toBe(45)
    expect(new Set(log.map((r) => r.heldTripId))).toEqual(
      new Set([ADOPTED_TRIP])
    )
  })

  it('AFTER, plan re-targeted: the card is on the plan and stays there', () => {
    const next = retargetTransitLegToRun(ITINERARY, 1, anchoredRun())!
    const log = runCard(next, true)
    expect(disagreements(log, ADOPTED_TRIP)).toBe(0)
    expect(log.every((r) => r.heldTripId === ADOPTED_TRIP)).toBe(true)
  })

  it('AFTER, plan NOT re-targeted: the card comes back in one pass', () => {
    // The re-target can be refused (the rider is aboard, the access leg would
    // not make it, the rider has locked their own pick). The card must not be
    // left showing a bus the trip is not on: it re-seeds once and is then on
    // the plan's run for the rest of the window.
    const log = runCard(ITINERARY, true)
    expect(log[0].reason).toBe('seeded')
    expect(log[1].reason).toBe('released-split')
    expect(log[1].heldTripId).toBe(PLANNED_TRIP)
    expect(disagreements(log, PLANNED_TRIP)).toBe(1)
  })
})

describe('go-mode > retargetPlanToDeparture, through the store', () => {
  let clock: FakeTimers.InstalledClock | undefined
  let store: ReturnType<typeof makeStore> | undefined
  const initial = goMode(undefined, { type: '@@INIT' })

  const makeStore = (
    overrides: { itinerary?: any; riding?: any; stopData?: any } = {}
  ) => {
    let goModeState: any = {
      ...initial,
      activeItinerary: overrides.itinerary ?? ITINERARY,
      isActive: true,
      riding: overrides.riding ?? null,
      routeMatch: { legIndex: 0 },
      tracking: {
        ...initial.tracking,
        lastPosition: {
          coords: {
            accuracy: 12,
            heading: null,
            latitude: 44.9482,
            longitude: -93.2748,
            speed: null
          },
          timestamp: ANCHOR_AT
        }
      }
    }
    const actions: any[] = []
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: {},
        goMode: goModeState,
        location: { currentPosition: { coords: null } },
        transitIndex: {
          routes: {},
          stops: {
            [BOARD_STOP]: overrides.stopData ?? snapshotAt(ANCHOR_AT).payload
          },
          trips: {}
        }
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      actions.push(action)
      goModeState = goMode(goModeState, action)
      return action
    }
    return {
      actions,
      itinerary: () => goModeState.activeItinerary,
      run: (thunk: any) => thunk(dispatch, getState),
      types: () => actions.map((a) => a.type)
    }
  }

  beforeEach(() => {
    clock = FakeTimers.install({ now: ANCHOR_AT, toFake: ['Date'] })
  })
  afterEach(() => {
    store?.run(endGoMode())
    store = undefined
    clock?.uninstall()
    clock = undefined
  })

  it('installs the re-targeted plan', async () => {
    store = makeStore()
    await store.run(retargetPlanToDeparture(ANCHORED_MS, 'anchor'))
    expect(store.types()).toContain('START_GO_MODE')
    const legs = store.itinerary().legs
    expect(legs[1].trip.gtfsId).toBe(ADOPTED_TRIP)
    expect(hhmmss(Number(legs[1].startTime))).toBe('09:14:54')
    // The access leg is untouched, so the 12.13 stale-origin recovery must not
    // fire — it would re-plan the whole trip from the rider's position.
    expect(
      store.actions.filter(
        (a) =>
          a.type === 'START_REROUTE' &&
          a.payload?.reason === 'stale-plan-origin'
      )
    ).toHaveLength(0)
  })

  it('leaves a rider who is already aboard alone (23.2 wins)', async () => {
    store = makeStore({
      riding: {
        boardedAt: ANCHOR_AT,
        legIndex: 0,
        offRouteSince: null,
        routeId: ROUTE_ID,
        tripId: ADOPTED_TRIP,
        vehicleId: '1:8228'
      }
    })
    await store.run(retargetPlanToDeparture(ANCHORED_MS, 'anchor'))
    expect(store.types()).not.toContain('START_GO_MODE')
  })

  it('refuses a run the access leg of the rider cannot reach (16.2)', async () => {
    // Same plan, bike leg dragged out to 09:16:00 — 38 s after the 09:15:22 it
    // would be re-planned onto. 2026-09-15's two bad splices overran by 3m05s
    // and 49 s and stood in front of the rider for ten minutes.
    const legs = [...ITINERARY.legs]
    legs[0] = { ...legs[0], endTime: ANCHORED_MS + 38000 }
    store = makeStore({ itinerary: { ...ITINERARY, legs } })
    await store.run(retargetPlanToDeparture(ANCHORED_MS, 'anchor'))
    expect(store.types()).not.toContain('START_GO_MODE')
  })

  it('does nothing for a departure the feed does not name a run for', async () => {
    store = makeStore()
    await store.run(retargetPlanToDeparture(ANCHORED_MS + 1234, 'anchor'))
    expect(store.types()).not.toContain('START_GO_MODE')
  })

  it('does nothing on a reset', async () => {
    store = makeStore()
    await store.run(retargetPlanToDeparture(null, 'rider'))
    expect(store.types()).not.toContain('START_GO_MODE')
  })

  it("the rider's own pick moves the plan too, and keeps their lock", async () => {
    store = makeStore()
    await store.run(selectDeparture(ANCHORED_MS))
    expect(store.types()).toContain('SET_DEPARTURE_OVERRIDE')
    expect(store.types()).toContain('START_GO_MODE')
    expect(store.itinerary().legs[1].trip.gtfsId).toBe(ADOPTED_TRIP)
    // beginGoMode clears manualDepartureLock along with the override it
    // belonged to; the rider's pick outlives both, so the anchor may not move
    // the plan again behind them. Proved by the anchor's own decision.
    const after = evaluateDepartureAnchor(null, {
      departureOverride: null,
      departures: departuresAt(ANCHOR_AT),
      manualLock: true,
      nowMs: ANCHOR_AT,
      plannedBoardMs: store.itinerary().legs[1].startTime,
      rideSecondsRemaining: ITINERARY.legs[0].duration
    })
    expect(after.anchorMs).toBeNull()
  })

  it('a pick names its run, and the run is found even after its time moved (29.3)', async () => {
    // The row the rider tapped was drawn a poll ago; by the time the tap lands
    // the feed may have moved that bus. An epoch match would miss it.
    const row = departuresAt(ANCHOR_AT).find((d) => d.depMs === ANCHORED_MS)
    expect(row?.tripId).toBeTruthy()
    store = makeStore()
    await store.run(selectDeparture(ANCHORED_MS + 1234, row?.tripId ?? null))
    const pick = store.actions.find((a) => a.type === 'SET_DEPARTURE_OVERRIDE')
    expect(pick.payload).toEqual({
      ms: ANCHORED_MS + 1234,
      source: 'rider',
      tripId: row?.tripId
    })
    expect(store.types()).toContain('START_GO_MODE')
    expect(store.itinerary().legs[1].trip.gtfsId).toBe(ADOPTED_TRIP)
  })
})
