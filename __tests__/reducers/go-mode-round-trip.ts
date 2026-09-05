import {
  SET_RETURN_COUNTDOWN,
  SET_ROUND_TRIP,
  START_GO_MODE,
  STOP_GO_MODE
} from '../../lib/actions/go-mode'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'
import goMode from '../../lib/reducers/go-mode'
import type { RoundTripPlan } from '../../lib/util/go-mode/round-trip'

/**
 * The round-trip half of the goMode slice, and — the part the existing reducer
 * tests do not cover for ANY action — that create-otp-reducer actually
 * delegates the two new types to it.
 *
 * That delegation list is an explicit `case` list with a `default: return
 * state`, so a new goMode action type is silently DROPPED unless it is named
 * there. A slice test cannot see it: `goMode(state, action)` works perfectly
 * while the action never reaches `goMode` in the running app. It has broken the
 * re-route, vehicle-match, boarding-prompt and departure-override flows before.
 */

const MIN = 60000
const NOW = 1_788_537_600_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const itinerary: any = {
  endTime: NOW + 30 * MIN,
  legs: [
    {
      endTime: NOW + 30 * MIN,
      from: { lat: 44.9, lon: -93.3, name: 'A' },
      mode: 'WALK',
      startTime: NOW,
      to: { lat: 44.86, lon: -93.29, name: 'B' },
      transitLeg: false
    }
  ],
  startTime: NOW
}

const plan: RoundTripPlan = {
  destination: { lat: 44.86, lon: -93.29, name: 'B' },
  leaveByMs: NOW + 150 * MIN,
  origin: { lat: 44.9, lon: -93.3, name: 'A' },
  plannedDepartMs: NOW + 150 * MIN,
  refreshedAtMs: null,
  returnItinerary: itinerary,
  stayMinutes: 120
}

const initial = goMode(undefined, { type: '@@INIT' })

describe('reducers > go-mode > round trip', () => {
  describe('the goMode slice', () => {
    it('defaults both fields to null — a one-way trip is the normal case', () => {
      expect(initial.roundTrip).toBeNull()
      expect(initial.returnCountdown).toBeNull()
    })

    it('carries the plan in on START_GO_MODE, with no countdown yet', () => {
      const state = goMode(initial, {
        payload: { itinerary, roundTrip: plan },
        type: START_GO_MODE
      })
      expect(state.roundTrip).toBe(plan)
      expect(state.returnCountdown).toBeNull()
      expect(state.arrivedAt).toBeNull()
    })

    it('clears the plan when START_GO_MODE brings none', () => {
      // An auto-update that re-enters beginGoMode with one argument must not
      // leave a round trip attached to an itinerary nobody tied a return to.
      const withPlan = goMode(initial, {
        payload: { itinerary, roundTrip: plan },
        type: START_GO_MODE
      })
      const swapped = goMode(withPlan, {
        payload: { itinerary },
        type: START_GO_MODE
      })
      expect(swapped.roundTrip).toBeNull()
    })

    it('replaces the plan on SET_ROUND_TRIP and keeps the countdown stage', () => {
      const armed = goMode(
        goMode(initial, {
          payload: { itinerary, roundTrip: plan },
          type: START_GO_MODE
        }),
        {
          payload: { leaveByMs: plan.leaveByMs, stage: 'soon' },
          type: SET_RETURN_COUNTDOWN
        }
      )
      const refreshed = { ...plan, leaveByMs: plan.leaveByMs + 8 * MIN }
      const state = goMode(armed, {
        payload: refreshed,
        type: SET_ROUND_TRIP
      })
      expect(state.roundTrip).toBe(refreshed)
      // Not cleared here: evaluateReturnCountdown re-arms itself off the
      // leaveByMs mismatch, and clearing would re-fire "leave in 10 min" for a
      // refresh that did not move the departure at all.
      expect(state.returnCountdown).toEqual({
        leaveByMs: plan.leaveByMs,
        stage: 'soon'
      })
    })

    it('stores and clears the countdown on SET_RETURN_COUNTDOWN', () => {
      const set = goMode(initial, {
        payload: { leaveByMs: plan.leaveByMs, stage: 'now' },
        type: SET_RETURN_COUNTDOWN
      })
      expect(set.returnCountdown).toEqual({
        leaveByMs: plan.leaveByMs,
        stage: 'now'
      })
      expect(
        goMode(set, { payload: null, type: SET_RETURN_COUNTDOWN })
          .returnCountdown
      ).toBeNull()
    })

    it('clears both on STOP_GO_MODE', () => {
      const running = goMode(
        goMode(initial, {
          payload: { itinerary, roundTrip: plan },
          type: START_GO_MODE
        }),
        {
          payload: { leaveByMs: plan.leaveByMs, stage: 'soon' },
          type: SET_RETURN_COUNTDOWN
        }
      )
      const stopped = goMode(running, { type: STOP_GO_MODE })
      expect(stopped.roundTrip).toBeNull()
      expect(stopped.returnCountdown).toBeNull()
    })
  })

  describe('create-otp-reducer delegation', () => {
    // Dispatch through the ROOT reducer, which is the only thing that proves
    // the case list names them.
    const root = createOtpReducer({ dateTime: {}, initialQuery: {} })
    const base = root(undefined, { type: '@@INIT' })

    it('delegates SET_ROUND_TRIP', () => {
      const next = root(base, { payload: plan, type: SET_ROUND_TRIP })
      expect(next.goMode.roundTrip).toBe(plan)
    })

    it('delegates SET_RETURN_COUNTDOWN', () => {
      const next = root(base, {
        payload: { leaveByMs: plan.leaveByMs, stage: 'soon' },
        type: SET_RETURN_COUNTDOWN
      })
      expect(next.goMode.returnCountdown).toEqual({
        leaveByMs: plan.leaveByMs,
        stage: 'soon'
      })
    })
  })
})
