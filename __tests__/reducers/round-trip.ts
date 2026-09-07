import {
  clearReturnPlan,
  selectReturnItinerary,
  setReturnPlan
} from '../../lib/actions/round-trip'
import roundTripReducer from '../../lib/reducers/round-trip'
import type { ReturnPlanState } from '../../lib/actions/round-trip'

const plan = (overrides: Partial<ReturnPlanState> = {}): ReturnPlanState => ({
  departMs: 1_788_541_200_000,
  itineraries: [
    { startTime: 1 } as any,
    { startTime: 2 } as any,
    { startTime: 3 } as any
  ],
  outboundKey: 'WALK:::a>b@1|BUS:1:21:1:trip-out:b>c@2:1788539400000',
  selectedIndex: 0,
  status: 'ready',
  stayMinutes: 60,
  ...overrides
})

describe('lib > reducers > round-trip', () => {
  const initial = roundTripReducer(undefined, { type: '@@INIT' } as any)

  it('starts with no return plan', () => {
    expect(initial).toEqual({ returnPlan: null })
  })

  it('replaces the plan on SET_RETURN_PLAN', () => {
    const pending = plan({ itineraries: [], status: 'pending' })
    const afterPending = roundTripReducer(initial, setReturnPlan(pending))
    expect(afterPending.returnPlan).toEqual(pending)

    const ready = plan()
    expect(
      roundTripReducer(afterPending, setReturnPlan(ready)).returnPlan
    ).toEqual(ready)
  })

  it('selects a return itinerary by index, ignoring out-of-range picks', () => {
    const ready = roundTripReducer(initial, setReturnPlan(plan()))
    expect(
      roundTripReducer(ready, selectReturnItinerary(2)).returnPlan
        ?.selectedIndex
    ).toBe(2)
    // Out of range / not an index: the rider's current pick stands rather than
    // the panel rendering a row that isn't there.
    expect(
      roundTripReducer(ready, selectReturnItinerary(3)).returnPlan
        ?.selectedIndex
    ).toBe(0)
    expect(
      roundTripReducer(ready, selectReturnItinerary(-1)).returnPlan
        ?.selectedIndex
    ).toBe(0)
    // Nothing to select against.
    expect(
      roundTripReducer(initial, selectReturnItinerary(0)).returnPlan
    ).toBeNull()
  })

  it('clears the plan on CLEAR_RETURN_PLAN', () => {
    const ready = roundTripReducer(initial, setReturnPlan(plan()))
    expect(roundTripReducer(ready, clearReturnPlan()).returnPlan).toBeNull()
  })

  it('clears the plan when a new outbound search runs', () => {
    const ready = roundTripReducer(initial, setReturnPlan(plan()))
    expect(
      roundTripReducer(ready, {
        payload: { searchId: 'abc' },
        type: 'ROUTING_REQUEST'
      } as any).returnPlan
    ).toBeNull()
  })
})
