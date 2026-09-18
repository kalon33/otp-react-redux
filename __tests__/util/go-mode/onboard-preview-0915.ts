import {
  closeOnboardAlightPreview,
  confirmOnboardAlightStop,
  openOnboardAlightPreview,
  stopVehicleTracking
} from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  // beginGoMode pre-fetches stop times and starts vehicle tracking for a
  // transit first leg; no-op thunks keep the commit test off the network.
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

const T = 1789505000000
const MIN = 60000
const TRIP_ID = '1:1346665'

const stopTime = (id: string, name: string, dep: number) => ({
  scheduledArrival: dep,
  scheduledDeparture: dep,
  serviceDay: 0,
  stop: { code: id, id, lat: 44.9, lon: -93.28, name }
})

const trip = {
  id: TRIP_ID,
  route: {
    id: '1:904',
    longName: 'METRO Orange Line',
    mode: 'BUS',
    shortName: 'Orange'
  },
  stopTimes: [
    stopTime('1:s1', 'I-35W & 46th St Station', 100),
    stopTime('1:s2', '2nd Ave S & Washington Ave S', 700)
  ],
  tripHeadsign: 'Minneapolis'
}

const option = (stopId: string, stopName: string, endTime: number) => ({
  busArrivalEpoch: T + 10 * MIN,
  displayItinerary: {
    endTime,
    legs: [
      {
        endTime: T + 10 * MIN,
        mode: 'BUS',
        startTime: T,
        to: { name: stopName },
        transitLeg: true
      }
    ],
    startTime: T
  },
  itinerary: {
    endTime,
    legs: [
      {
        endTime,
        from: { lat: 44.9, lon: -93.28, name: stopName, stopId },
        mode: 'BICYCLE',
        startTime: T + 10 * MIN,
        to: { lat: 44.97, lon: -93.21, name: 'Safelite AutoGlass' },
        transitLeg: false
      }
    ],
    startTime: T + 10 * MIN
  },
  realtime: true,
  stopId,
  stopName
})

const OPTIONS = [
  option('1:s1', 'I-35W & 46th St Station', T + 30 * MIN),
  option('1:s2', '2nd Ave S & Washington Ave S', T + 52 * MIN)
]

/** A store whose dispatch runs the real goMode reducer, as onboard-flow does. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeStore = (onboardOverrides: any = {}) => {
  const initial = goMode(undefined, { type: '@@INIT' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any = {
    ...initial,
    isActive: true,
    onboard: {
      ...initial.onboard,
      alightOptions: OPTIONS,
      answeredCandidates: 2,
      bestAlightStop: OPTIONS[0],
      pendingCandidates: 0,
      status: 'ready',
      trip,
      vehicle: { routeId: '1:904', tripId: TRIP_ID, vehicleId: '1:8141' },
      ...onboardOverrides
    },
    tracking: {
      ...initial.tracking,
      lastPosition: { coords: { latitude: 44.9, longitude: -93.28 } }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: { to: { lat: 44.97, lon: -93.21, name: 'Safelite' } },
      goMode: state,
      transitIndex: { routes: {}, trips: { [TRIP_ID]: trip } }
    }
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    state = goMode(state, action)
    return action
  }
  return { actions, dispatch, getGoMode: () => state }
}

afterEach(() => {
  // beginGoMode starts the 15 s vehicle-position poll — clear it so jest exits.
  stopVehicleTracking()(() => undefined)
})

/**
 * Backlog 17.1, the rider's second ask (2026-09-15 15:57:02): *"Again: I just
 * want to view alternatives for searches on 'already on bus'. But just viewing
 * switched and then other options are gone"*.
 *
 * `confirmOnboardAlightStop` opens with `clearOnboard()`, which drops
 * `onboard.alightOptions` — the ONLY copy of the list. Wiring it to a row tap
 * therefore made looking at an option both start the trip and destroy the way
 * back. These tests fix the two halves separately: opening/closing a preview
 * touches nothing else, and the commit is reachable only on purpose.
 */
describe('actions > go-mode > onboard alight preview (17.1)', () => {
  it('opening a preview keeps the list, the trip and the vehicle', () => {
    const store = makeStore()
    store.dispatch(openOnboardAlightPreview(OPTIONS[1], 'row'))

    const onboard = store.getGoMode().onboard
    expect(onboard.preview?.option.stopId).toBe('1:s2')
    expect(onboard.preview?.control).toBe('row')
    // Nothing else moved: same list, same ranking, same trip, same status.
    expect(onboard.alightOptions).toBe(OPTIONS)
    expect(onboard.status).toBe('ready')
    expect(onboard.trip).toBe(trip)
    expect(onboard.bestAlightStop).toBe(OPTIONS[0])
    expect(store.actions.map((a) => a.type)).not.toContain('CLEAR_ONBOARD')
    expect(store.actions.map((a) => a.type)).not.toContain('START_GO_MODE')
  })

  it('Back returns to the SAME options — no re-plan, no refetch', () => {
    const store = makeStore()
    store.dispatch(openOnboardAlightPreview(OPTIONS[1], 'row'))
    store.dispatch(closeOnboardAlightPreview())

    const onboard = store.getGoMode().onboard
    expect(onboard.preview).toBeNull()
    // Reference equality is the assertion that matters: this is the same list
    // object the optimizer produced, not a recomputed one. Recovering it on
    // 09-15 cost five OTP plan requests over 12 s.
    expect(onboard.alightOptions).toBe(OPTIONS)
    expect(onboard.answeredCandidates).toBe(2)
    expect(onboard.pendingCandidates).toBe(0)
    expect(onboard.status).toBe('ready')
    const types = store.actions.map((a) => a.type)
    expect(types).toEqual([
      'GO_MODE_CONTROL_TAP',
      'OPEN_ONBOARD_PREVIEW',
      'GO_MODE_CONTROL_TAP',
      'CLOSE_ONBOARD_PREVIEW'
    ])
  })

  it('a stale tap on an option no longer in the list previews nothing', () => {
    const store = makeStore()
    store.dispatch(
      openOnboardAlightPreview(option('1:gone', 'Gateway Ramp', T), 'row')
    )
    expect(store.getGoMode().onboard.preview).toBeNull()
  })

  it('Confirm commits once, for the previewed stop', () => {
    const store = makeStore()
    store.dispatch(openOnboardAlightPreview(OPTIONS[1], 'row'))
    store.dispatch(confirmOnboardAlightStop(OPTIONS[1]))

    const types = store.actions.map((a) => a.type)
    expect(types.filter((t) => t === 'CLEAR_ONBOARD')).toHaveLength(1)
    expect(types.filter((t) => t === 'START_GO_MODE')).toHaveLength(1)
    // And in that order: CLEAR_ONBOARD is the act that drops the list, so it
    // must never run before the rider has confirmed.
    expect(types.indexOf('OPEN_ONBOARD_PREVIEW')).toBeLessThan(
      types.indexOf('CLEAR_ONBOARD')
    )
    const legs = store.getGoMode().activeItinerary?.legs || []
    expect(legs[0].to?.name).toBe('2nd Ave S & Washington Ave S')
  })

  it('Confirm with no argument takes the PREVIEWED stop, not the ranked best', () => {
    const store = makeStore()
    store.dispatch(openOnboardAlightPreview(OPTIONS[1], 'row'))
    store.dispatch(confirmOnboardAlightStop())

    const legs = store.getGoMode().activeItinerary?.legs || []
    expect(legs[0].to?.name).toBe('2nd Ave S & Washington Ave S')
  })

  /** 17.11 — the record that says which control the rider touched. */
  it('records a control tap for open, back and confirm', () => {
    const store = makeStore()
    store.dispatch(openOnboardAlightPreview(OPTIONS[1], 'variant'))
    store.dispatch(closeOnboardAlightPreview())
    store.dispatch(openOnboardAlightPreview(OPTIONS[0], 'row'))
    store.dispatch(confirmOnboardAlightStop(OPTIONS[0]))

    const taps = store.actions
      .filter((a) => a.type === 'GO_MODE_CONTROL_TAP')
      .map((a) => a.payload.control)
    expect(taps).toEqual([
      'onboard-variant-open',
      'onboard-preview-back',
      'onboard-option-row',
      'onboard-preview-confirm'
    ])
    const confirm = store.actions.find(
      (a) =>
        a.type === 'GO_MODE_CONTROL_TAP' &&
        a.payload.control === 'onboard-preview-confirm'
    )
    // `fromPreview: false` on a commit is the signal that 17.1 has regressed.
    expect(confirm.payload.fromPreview).toBe(true)
    expect(confirm.payload.stopId).toBe('1:s1')
  })

  it('a new optimize run drops a preview of the old list', () => {
    const store = makeStore()
    store.dispatch(openOnboardAlightPreview(OPTIONS[1], 'row'))
    store.dispatch({
      payload: { candidates: [] },
      type: 'START_ONBOARD_OPTIMIZE'
    })
    expect(store.getGoMode().onboard.preview).toBeNull()
  })
})
