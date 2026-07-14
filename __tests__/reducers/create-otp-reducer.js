import '../test-utils/mock-window-url'
import { restoreDateNowBehavior, setDefaultTestTime } from '../test-utils'
import createOtpReducer, {
  getInitialState
} from '../../lib/reducers/create-otp-reducer'

describe('lib > reducers > create-otp-reducer', () => {
  afterEach(restoreDateNowBehavior)

  it('should be able to create the initial state', () => {
    setDefaultTestTime()
    expect(getInitialState({})).toMatchSnapshot()
  })

  // The otp reducer delegates Go Mode actions to goModeReducer through an
  // explicit case list; an action type missing from that list is silently
  // dropped in the app even though the goMode reducer unit tests pass.
  // Exercise the delegation end-to-end for the newest action types.
  it('delegates Go Mode actions through to the goMode slice', () => {
    setDefaultTestTime()
    const reducer = createOtpReducer({})
    const initial = reducer(undefined, { type: '@@INIT' })

    const riding = {
      boardedAt: 1,
      headsign: null,
      legIndex: 1,
      offRouteSince: null,
      routeId: '1:904',
      routeShortName: 'Orange',
      tripId: '1:trip-1',
      vehicleId: null
    }
    const withRiding = reducer(initial, {
      payload: riding,
      type: 'SET_RIDING'
    })
    expect(withRiding.goMode.riding).toEqual(riding)
    expect(
      reducer(withRiding, { type: 'CLEAR_RIDING' }).goMode.riding
    ).toBeNull()

    const liveTimes = { 1: { alightEpoch: 5, boardEpoch: 3, realtime: true } }
    const withTimes = reducer(initial, {
      payload: liveTimes,
      type: 'SET_LIVE_LEG_TIMES'
    })
    expect(withTimes.goMode.liveLegTimes).toEqual(liveTimes)

    const withArrival = reducer(initial, {
      payload: 1783884008121,
      type: 'SET_ARRIVED'
    })
    expect(withArrival.goMode.arrivedAt).toBe(1783884008121)
    // A new trip clears the arrival fact.
    const restarted = reducer(withArrival, {
      payload: { itinerary: { legs: [] }, originalFrom: null },
      type: 'START_GO_MODE'
    })
    expect(restarted.goMode.arrivedAt).toBeNull()
  })
})
