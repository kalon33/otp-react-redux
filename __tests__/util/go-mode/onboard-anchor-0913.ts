/* globals describe, expect, it, jest */
import {
  ANCHOR_UNKNOWN,
  getDownstreamStops,
  selectCandidateStops
} from '../../../lib/util/go-mode/alight-optimizer'
import { loadOnboardScheduleAndOptimize } from '../../../lib/actions/go-mode'
import fixture from '../../../lib/util/go-mode/replay/fixtures/green-line-onboard-1137-flows.json'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(
    () => () => Promise.resolve({ error: true, itineraries: [] })
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
 * 2026-09-13 11:38:38 — the onboard candidate list built from the FIRST stop of
 * the line (backlog 15.5). Telemetry only; the rider never saw it long enough
 * to write it down.
 *
 * The sequence: `STOP_GO_MODE` 11:38:36.664 resets Go Mode to defaultState,
 * keeping the physical facts (riding, the confirmed match, the alight) and not
 * a GPS sample, so `tracking.lastPosition` is gone. `BEGIN_ONBOARD_FLOW`
 * 11:38:38.013 re-adopts the remembered vehicle with `nextStopId: null` — on
 * purpose, because a stale next stop is how 8/9 built a bus leg to a stop
 * behind the rider. `START_ONBOARD_OPTIMIZE` 11:38:38.346 therefore had
 * neither input, `findAnchorIndex` fell to index 0, and a rider at Lexington
 * Pkwy was offered Union Depot — 4.7 km east, the other end of the Green Line
 * — with `busArrivalEpoch` = now. The first `UPDATE_POSITION` landed at
 * 11:38:39.035, 689 ms too late. Flow #2, 47 s earlier, had a fix 228 ms
 * before its build and anchored correctly; that flow is what this fixture
 * recorded, and its stops are the control.
 *
 * Two halves, matching the two ways this can go wrong: the optimizer must not
 * invent an anchor it does not have, and the flow must give the fix the moment
 * it needs to arrive.
 */

const trip = (fixture as any).onboard.trip.payload
const TRIP_READ_MS = (fixture as any).onboard.trip.tMs // 11:37:41
/** The fix the optimize actually ran on: 136 m short of Lexington Pkwy. */
const RIDER_POS = { lat: 44.9558030230917, lon: -93.1457763245545 }
const DEST = { lat: 44.92718, lon: -93.213779 }
const LEXINGTON = '1:56034'
const UNION_DEPOT = '1:56026'

describe('util > go-mode > onboard anchor with no evidence (9/13)', () => {
  it('the fixture really is the Green Line run, Union Depot first', () => {
    expect(trip.id).toBe('1:879781')
    expect(trip.stopTimes[0].stop.id).toBe(UNION_DEPOT)
    expect(trip.stopTimes[0].stop.name).toBe('Union Depot Station')
    expect(trip.stopTimes[8].stop.id).toBe(LEXINGTON)
    // 4.7 km east of where the rider actually was.
    expect(ANCHOR_UNKNOWN).toBe(-1)
  })

  it('is what index 0 would have offered — the recorded wrong list', () => {
    // Anchoring at stop 0 is what the old fallback did; asking for it
    // explicitly reproduces the six stops the 11:38:38 optimize dispatched.
    const fromStopZero = getDownstreamStops(
      trip,
      { nextStopId: UNION_DEPOT },
      null,
      DEST,
      TRIP_READ_MS
    )
    expect(
      selectCandidateStops(fromStopZero, 5).map((c) => c.stop.name)
    ).toEqual([
      'Union Depot Station',
      'Capitol / Rice St Station',
      'Victoria St Station',
      'Fairview Ave Station',
      'Raymond Ave Station',
      'Prospect Park Station'
    ])
  })

  it('returns nothing rather than the start of the line', () => {
    expect(getDownstreamStops(trip, null, null, DEST, TRIP_READ_MS)).toEqual([])
    expect(
      getDownstreamStops(trip, { nextStopId: null }, null, DEST, TRIP_READ_MS)
    ).toEqual([])
    // A nextStopId this trip does not serve is no evidence either.
    expect(
      getDownstreamStops(
        trip,
        { nextStopId: '1:not-on-this-run' },
        null,
        DEST,
        TRIP_READ_MS
      )
    ).toEqual([])
  })

  it('still anchors on either piece of evidence on its own', () => {
    const byPos = getDownstreamStops(trip, null, RIDER_POS, DEST, TRIP_READ_MS)
    expect(byPos[0].stop.id).toBe(LEXINGTON)
    const byNextStop = getDownstreamStops(
      trip,
      { nextStopId: LEXINGTON },
      null,
      DEST,
      TRIP_READ_MS
    )
    expect(byNextStop[0].stop.id).toBe(LEXINGTON)
  })
})

describe('actions > go-mode > waiting for the first fix after a Stop (9/13)', () => {
  const initial = goMode(undefined, { type: '@@INIT' })
  const TRIP_ID = '1:879781'

  const makeStore = () => {
    let state: any = {
      ...initial,
      onboard: {
        ...initial.onboard,
        status: 'fetching-schedule',
        // What beginOnboardFlow dispatches for a REMEMBERED vehicle: no
        // nextStopId, deliberately.
        vehicle: {
          label: 'Mpls-Target Field',
          nextStopId: null,
          routeId: '1:902',
          tripId: TRIP_ID,
          vehicleId: '32141'
        }
      },
      // Wiped by STOP_GO_MODE 1.3 s earlier.
      tracking: { ...initial.tracking, lastPosition: null }
    }
    const actions: any[] = []
    const getState = () => ({
      otp: {
        config: {
          homeTimezone: 'America/Chicago',
          itinerary: { onboardAnchorWaitMs: 400, onboardSettleMs: 60 }
        },
        currentQuery: { to: { ...DEST, name: 'Hiawatha Church' } },
        goMode: state,
        transitIndex: { routes: {}, trips: { [TRIP_ID]: trip } }
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      actions.push(action)
      state = goMode(state, action)
      return action
    }
    const arrive = () => {
      state = {
        ...state,
        tracking: {
          ...state.tracking,
          lastPosition: {
            coords: { latitude: RIDER_POS.lat, longitude: RIDER_POS.lon }
          }
        }
      }
    }
    return {
      actions,
      arrive,
      candidates: () =>
        actions.find((a) => a.type === 'START_ONBOARD_OPTIMIZE')?.payload
          ?.candidates ?? null,
      dispatch,
      getOnboard: () => state.onboard
    }
  }

  it('holds the optimize until the fix lands, then anchors on it', async () => {
    const store = makeStore()
    // The real gap was 689 ms; 150 ms here against a 400 ms budget is the
    // same shape at test speed.
    setTimeout(store.arrive, 150)
    await store.dispatch(loadOnboardScheduleAndOptimize(TRIP_ID))
    const candidates = store.candidates()
    expect(candidates).not.toBeNull()
    expect(candidates[0].stopName).toBe('Lexington Pkwy Station')
    expect(candidates.map((c: any) => c.stopId)).not.toContain(UNION_DEPOT)
  })

  it('gives up honestly when no fix ever arrives', async () => {
    const store = makeStore()
    await store.dispatch(loadOnboardScheduleAndOptimize(TRIP_ID))
    // No candidates at all beats six from the wrong end of the line: the
    // rider can tap again, and the flow says nothing it cannot support.
    expect(store.candidates()).toBeNull()
    expect(store.getOnboard().status).toBe('error')
  })

  it('does not wait at all when the vehicle already reports its next stop', async () => {
    const store = makeStore()
    store.dispatch({
      payload: {
        label: 'Mpls-Target Field',
        nextStopId: LEXINGTON,
        routeId: '1:902',
        tripId: TRIP_ID,
        vehicleId: '32141'
      },
      type: 'SET_ONBOARD_VEHICLE'
    })
    const startedAt = Date.now()
    await store.dispatch(loadOnboardScheduleAndOptimize(TRIP_ID))
    expect(Date.now() - startedAt).toBeLessThan(400)
    expect(store.candidates()[0].stopName).toBe('Lexington Pkwy Station')
  })
})
