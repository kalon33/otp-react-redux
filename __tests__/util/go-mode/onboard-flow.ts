import {
  beginOnboardFlowAction,
  stopGoMode
} from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'

const initial = goMode(undefined, { type: '@@INIT' })

const confirmedMatch = {
  confidence: 'confirmed' as const,
  distanceMeters: 120,
  label: 'Orange Burnsville',
  lastSeen: 1783882345000,
  routeId: '1:904',
  tripId: '1:1172697',
  vehicleId: '1:8141'
}

const withConfirmed = goMode(initial, {
  payload: confirmedMatch,
  type: 'CONFIRM_VEHICLE'
})

describe('onboard flow keeps what the app already knows', () => {
  it('BEGIN_ONBOARD_FLOW preserves a confirmed vehicle match', () => {
    const state = goMode(withConfirmed, beginOnboardFlowAction({}))
    expect(state.vehicleMatch.match).toEqual(
      expect.objectContaining({ confidence: 'confirmed', vehicleId: '1:8141' })
    )
    expect(state.onboard.status).toBe('discovering')
  })

  it('BEGIN_ONBOARD_FLOW still resets an unconfirmed match', () => {
    const low = goMode(initial, {
      payload: { ...confirmedMatch, confidence: 'low' },
      type: 'UPDATE_VEHICLE_MATCH'
    })
    const state = goMode(low, beginOnboardFlowAction({}))
    expect(state.vehicleMatch.match).toBeNull()
  })

  it('STOP_GO_MODE preserves a confirmed vehicle match', () => {
    // 7/12: exit at 13:56:08, re-enter at 13:56:12 — the app must not forget
    // the bus it verified four seconds earlier.
    const state = goMode(withConfirmed, stopGoMode())
    expect(state.vehicleMatch.match).toEqual(
      expect.objectContaining({ confidence: 'confirmed', vehicleId: '1:8141' })
    )
    expect(state.isActive).toBe(false)
  })

  it('STOP_GO_MODE drops an unconfirmed match with the rest of the state', () => {
    const low = goMode(initial, {
      payload: { ...confirmedMatch, confidence: 'low' },
      type: 'UPDATE_VEHICLE_MATCH'
    })
    expect(goMode(low, stopGoMode()).vehicleMatch.match).toBeNull()
  })
})
