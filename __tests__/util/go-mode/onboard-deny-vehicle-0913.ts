import { denyOnboardVehicle } from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'

const initial = goMode(undefined, { type: '@@INIT' })

const ridingGreenLine = {
  boardedAt: 1789000000000,
  headsign: 'Mpls-Target Field',
  legIndex: 0,
  offRouteSince: null,
  routeId: '1:902',
  routeShortName: null,
  tripId: '1:879781',
  vehicleId: '1:32141'
}

const confirmedMatch = {
  confidence: 'confirmed' as const,
  distanceMeters: null,
  label: 'METRO Green Line',
  lastSeen: 1789000000000,
  routeId: '1:902',
  tripId: '1:879781',
  vehicleId: '1:32141'
}

const makeStore = () => {
  let goModeState: any = {
    ...initial,
    isActive: true,
    onboard: {
      ...initial.onboard,
      status: 'optimizing',
      vehicle: {
        label: 'METRO Green Line',
        nextStopId: null,
        routeId: '1:902',
        tripId: '1:879781',
        vehicleId: '1:32141'
      }
    },
    riding: ridingGreenLine,
    vehicleMatch: { ...initial.vehicleMatch, match: confirmedMatch }
  }
  const actions: any[] = []
  const getState = () => ({
    otp: { config: {}, goMode: goModeState, transitIndex: { routes: {} } }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    goModeState = goMode(goModeState, action)
    return action
  }
  return { actions, dispatch, getGoMode: () => goModeState }
}

/**
 * 15.3. The onboard flow adopts a remembered vehicle without asking (correct —
 * never re-ask what the app knows), so "Not this one" is the rider's only way
 * to contradict it. rediscoverOnboardVehicles alone clears the match but NOT
 * the riding fact, which is what beginOnboardFlow reads: the rejected vehicle
 * would come straight back on the next pass.
 */
describe('denying the assumed onboard vehicle', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('drops the riding fact AND the match, then reopens discovery', () => {
    const store = makeStore()
    store.dispatch(denyOnboardVehicle())
    const state = store.getGoMode()
    // FAILS BEFORE: the button dispatched rediscoverOnboardVehicles, which
    // leaves riding standing.
    expect(state.riding).toBeNull()
    expect(state.vehicleMatch.match).toBeNull()
    expect(state.onboard.status).toBe('discovering')
    expect(store.actions.map((a) => a.type)).toEqual(
      expect.arrayContaining(['CLEAR_RIDING', 'SET_ONBOARD_STATUS'])
    )
  })
})
