import coreUtils from '@opentripplanner/core-utils'

import {
  clearReturnPlan,
  planReturnTrip,
  ROUND_TRIP_STORAGE_KEY,
  setRoundTripOptions
} from '../../lib/actions/round-trip'
import { DEFAULT_STAY_MINUTES } from '../../lib/util/go-mode/round-trip'

// The return plan must be an ISOLATED fetch — never routingQuery — so the
// planner the rider is reading is not disturbed. Mocking the two apiV2 helpers
// is also what keeps this test off the network.
jest.mock('../../lib/actions/apiV2', () => ({
  fetchOnboardCandidatePlan: jest.fn(),
  getBasePlanParts: jest.fn()
}))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const apiV2 = require('../../lib/actions/apiV2')

const { getItem } = coreUtils.storage

const OUTBOUND_START = 1_788_537_600_000 // 2026-09-04 16:00 UTC
const OUTBOUND_END = OUTBOUND_START + 30 * 60000

/** Origin → destination, arriving at OUTBOUND_END. */
const outbound: any = {
  endTime: OUTBOUND_END,
  legs: [
    {
      from: { lat: 44.94, lon: -93.28, name: 'Home' },
      mode: 'WALK',
      startTime: OUTBOUND_START,
      to: { lat: 44.95, lon: -93.27, name: 'Lake St & Hennepin Ave' }
    },
    {
      from: { lat: 44.95, lon: -93.27, name: 'Lake St & Hennepin Ave' },
      mode: 'BUS',
      route: { id: '1:21' },
      startTime: OUTBOUND_START + 6 * 60000,
      to: { lat: 44.98, lon: -93.26, name: 'Nicollet Mall' },
      transitLeg: true,
      trip: { gtfsId: '1:trip-out' }
    }
  ],
  startTime: OUTBOUND_START
}

const returnItinerary = (startOffsetMin: number, tripId: string): any => ({
  duration: 1800,
  endTime: OUTBOUND_END + (startOffsetMin + 30) * 60000,
  legs: [
    {
      from: { lat: 44.98, lon: -93.26, name: 'Nicollet Mall' },
      mode: 'BUS',
      route: { id: '1:21' },
      startTime: OUTBOUND_END + startOffsetMin * 60000,
      to: { lat: 44.94, lon: -93.28, name: 'Home' },
      transitLeg: true,
      trip: { gtfsId: tripId }
    }
  ],
  startTime: OUTBOUND_END + startOffsetMin * 60000
})

function makeState(overrides: any = {}) {
  return {
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: { roundTrip: true, stayMinutes: 60, ...overrides.query },
      roundTrip: { returnPlan: null, ...overrides.roundTrip }
    }
  }
}

/** A dispatch that runs thunks, records plain actions, and applies SET_RETURN_PLAN. */
function makeHarness(state: any) {
  const actions: any[] = []
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    if (action.type === 'SET_RETURN_PLAN') {
      state.otp.roundTrip = { returnPlan: action.payload }
    }
    if (action.type === 'CLEAR_RETURN_PLAN') {
      state.otp.roundTrip = { returnPlan: null }
    }
    if (action.type === 'SET_QUERY_PARAM') {
      Object.assign(state.otp.currentQuery, action.payload)
    }
    return action
  }
  const getState = () => state
  return { actions, dispatch, getState, state }
}

beforeEach(() => {
  window.localStorage.clear()
  apiV2.getBasePlanParts.mockReturnValue({
    modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
    modeSettings: [],
    numItineraries: 3,
    planQuery: null
  })
  apiV2.fetchOnboardCandidatePlan.mockReset()
})

describe('actions > round-trip > setRoundTripOptions', () => {
  it('persists both options and clears the stale return plan', () => {
    const harness = makeHarness(
      makeState({
        query: { roundTrip: false, stayMinutes: 60 },
        roundTrip: { returnPlan: { outboundKey: 'x', status: 'ready' } }
      })
    )
    setRoundTripOptions({ roundTrip: true })(harness.dispatch, harness.getState)

    expect(getItem(ROUND_TRIP_STORAGE_KEY)).toEqual({
      roundTrip: true,
      stayMinutes: 60
    })
    expect(harness.actions.map((a) => a.type)).toContain('CLEAR_RETURN_PLAN')
    // No searchId ⇒ no re-search: turning the toggle on asks a second question
    // about the results already on screen.
    expect(harness.actions.map((a) => a.type)).not.toContain('ROUTING_REQUEST')
  })

  it('clamps the stay to the offered range and rejects nonsense', () => {
    const cases: [unknown, number][] = [
      [1, 5],
      [4.6, 5],
      [900, 720],
      [90, 90],
      [0, DEFAULT_STAY_MINUTES],
      [-30, DEFAULT_STAY_MINUTES],
      ['', DEFAULT_STAY_MINUTES],
      ['abc', DEFAULT_STAY_MINUTES]
    ]
    cases.forEach(([input, expected]) => {
      const harness = makeHarness(makeState())
      setRoundTripOptions({ stayMinutes: input as number })(
        harness.dispatch,
        harness.getState
      )
      expect(getItem(ROUND_TRIP_STORAGE_KEY).stayMinutes).toBe(expected)
    })
  })

  it('leaves an up-to-date plan alone when nothing actually changed', () => {
    const harness = makeHarness(
      makeState({ query: { roundTrip: true, stayMinutes: 60 } })
    )
    setRoundTripOptions({ stayMinutes: 60 })(harness.dispatch, harness.getState)
    expect(harness.actions.map((a) => a.type)).not.toContain(
      'CLEAR_RETURN_PLAN'
    )
  })
})

describe('actions > round-trip > planReturnTrip', () => {
  it('plans destination → origin at arrival + stay, in the home timezone', async () => {
    apiV2.fetchOnboardCandidatePlan.mockReturnValue(async () => ({
      error: false,
      itineraries: [returnItinerary(0, '1:trip-a')]
    }))
    const harness = makeHarness(makeState())
    await planReturnTrip(outbound)(harness.dispatch, harness.getState)

    const combo = apiV2.fetchOnboardCandidatePlan.mock.calls[0][0]
    expect(combo.from).toEqual({
      lat: 44.98,
      lon: -93.26,
      name: 'Nicollet Mall'
    })
    expect(combo.to).toEqual({ lat: 44.94, lon: -93.28, name: 'Home' })
    expect(combo.arriveBy).toBe(false)
    // Outbound arrives 16:30 UTC; +60 min stay = 17:30 UTC = 12:30 in Chicago.
    expect(combo.date).toBe('2026-09-04')
    expect(combo.time).toBe('12:30')
    expect(combo.numItineraries).toBe(3)

    const plan = harness.state.otp.roundTrip.returnPlan
    expect(plan.status).toBe('ready')
    expect(plan.selectedIndex).toBe(0)
    expect(plan.departMs).toBe(OUTBOUND_END + 60 * 60000)
  })

  it('sorts by departure, dedupes, and keeps the slower options', async () => {
    apiV2.fetchOnboardCandidatePlan.mockReturnValue(async () => ({
      error: false,
      itineraries: [
        { ...returnItinerary(40, '1:trip-c'), duration: 600 },
        returnItinerary(10, '1:trip-a'),
        returnItinerary(10, '1:trip-a'), // duplicate
        { ...returnItinerary(25, '1:trip-b'), duration: 5400 } // much slower
      ]
    }))
    const harness = makeHarness(makeState())
    await planReturnTrip(outbound)(harness.dispatch, harness.getState)

    const { itineraries } = harness.state.otp.roundTrip.returnPlan
    expect(
      itineraries.map((i: any) => (i.startTime - OUTBOUND_END) / 60000)
    ).toEqual([10, 25, 40])
  })

  it('reports empty and error separately', async () => {
    apiV2.fetchOnboardCandidatePlan.mockReturnValue(async () => ({
      error: false,
      itineraries: []
    }))
    const empty = makeHarness(makeState())
    await planReturnTrip(outbound)(empty.dispatch, empty.getState)
    expect(empty.state.otp.roundTrip.returnPlan.status).toBe('empty')

    apiV2.fetchOnboardCandidatePlan.mockReturnValue(async () => ({
      error: true,
      itineraries: []
    }))
    const failed = makeHarness(makeState())
    await planReturnTrip(outbound)(failed.dispatch, failed.getState)
    expect(failed.state.otp.roundTrip.returnPlan.status).toBe('error')
  })

  it('no-ops when the rider has not asked for a round trip', async () => {
    const harness = makeHarness(makeState({ query: { roundTrip: false } }))
    await planReturnTrip(outbound)(harness.dispatch, harness.getState)
    expect(apiV2.fetchOnboardCandidatePlan).not.toHaveBeenCalled()
    expect(harness.actions).toHaveLength(0)
  })

  it('no-ops when the same outbound and stay are already pending', async () => {
    apiV2.fetchOnboardCandidatePlan.mockReturnValue(async () => ({
      error: false,
      itineraries: [returnItinerary(0, '1:trip-a')]
    }))
    const harness = makeHarness(makeState())
    await planReturnTrip(outbound)(harness.dispatch, harness.getState)
    expect(apiV2.fetchOnboardCandidatePlan).toHaveBeenCalledTimes(1)
    await planReturnTrip(outbound)(harness.dispatch, harness.getState)
    expect(apiV2.fetchOnboardCandidatePlan).toHaveBeenCalledTimes(1)
  })

  it('discards a result the rider has already moved on from', async () => {
    const harness = makeHarness(makeState())
    // The stay changes while the plan is in flight: CLEAR_RETURN_PLAN has
    // already wiped the pending entry, so this result answers a dead question.
    apiV2.fetchOnboardCandidatePlan.mockReturnValue(async () => {
      harness.dispatch(clearReturnPlan())
      return { error: false, itineraries: [returnItinerary(0, '1:trip-a')] }
    })
    await planReturnTrip(outbound)(harness.dispatch, harness.getState)
    expect(harness.state.otp.roundTrip.returnPlan).toBeNull()
  })

  it('discards a result once the toggle has been turned off', async () => {
    const harness = makeHarness(makeState())
    apiV2.fetchOnboardCandidatePlan.mockReturnValue(async () => {
      harness.state.otp.currentQuery.roundTrip = false
      return { error: false, itineraries: [returnItinerary(0, '1:trip-a')] }
    })
    await planReturnTrip(outbound)(harness.dispatch, harness.getState)
    expect(harness.state.otp.roundTrip.returnPlan.status).toBe('pending')
  })
})
