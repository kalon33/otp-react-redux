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

    // SET_MAP_FOLLOW round-trip: a map drag auto-disengages follow (false)
    // and the follow button re-engages it (true). Follow defaults on, so the
    // disengage is the leg that proves delegation.
    expect(initial.goMode.ui.mapFollowUser).toBe(true)
    const disengaged = reducer(initial, {
      payload: false,
      type: 'SET_MAP_FOLLOW'
    })
    expect(disengaged.goMode.ui.mapFollowUser).toBe(false)
    expect(
      reducer(disengaged, { payload: true, type: 'SET_MAP_FOLLOW' }).goMode.ui
        .mapFollowUser
    ).toBe(true)

    // A quiet background replan re-fires START_GO_MODE mid-trip; it must not
    // re-engage follow over the rider's explicit disengage.
    const replanned = reducer(disengaged, {
      payload: { itinerary: { legs: [] }, originalFrom: null },
      type: 'START_GO_MODE'
    })
    expect(replanned.goMode.ui.mapFollowUser).toBe(false)
  })

  // Rider ask, backlog 3.9: "Choose on map" puts the map into pick mode, and
  // the mode has to outlive the full-screen mobile picker that started it —
  // hence redux state rather than component state.
  it('tracks which end of the trip is being picked off the map', () => {
    setDefaultTestTime()
    const reducer = createOtpReducer({})
    const initial = reducer(undefined, { type: '@@INIT' })
    expect(initial.ui.mapPickLocationType).toBeNull()

    const picking = reducer(initial, {
      payload: { locationType: 'from' },
      type: 'SET_MAP_PICK_MODE'
    })
    expect(picking.ui.mapPickLocationType).toBe('from')

    // Entering pick mode closes the map popup: both set the same thing, and
    // two ways to set it fighting over one tap is what the rider hit.
    const withPopup = reducer(initial, {
      payload: { location: { lat: 44.98, lon: -93.27, name: 'Somewhere' } },
      type: 'SET_MAP_POPUP_LOCATION'
    })
    expect(withPopup.ui.mapPopupLocation).not.toBeNull()
    const popupClosed = reducer(withPopup, {
      payload: { locationType: 'to' },
      type: 'SET_MAP_PICK_MODE'
    })
    expect(popupClosed.ui.mapPopupLocation).toBeNull()

    expect(
      reducer(picking, {
        payload: { locationType: null },
        type: 'SET_MAP_PICK_MODE'
      }).ui.mapPickLocationType
    ).toBeNull()
  })
})
