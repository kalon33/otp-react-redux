import { endGoMode } from '../../../lib/actions/go-mode'
import { stopOriginAboard } from '../../../lib/util/go-mode/stop-origin'
import { syncCurrentLocationOrigin } from '../../../lib/actions/form'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * Backlog 51.2, cycle 24 Q1 = C — "GPS, but the next stop if I'm clearly
 * riding."
 *
 * 2026-10-17, ride mvcx52b7-anqred (DEV 2026.1016.2), day file
 * debug-2026-10-17.jsonl: the trip started at 17:25 from "(Current Location)"
 * 44.94110,-93.21532. At STOP_GO_MODE 17:50:57.040 endGoMode restored exactly
 * that point (SET_QUERY_PARAM from, same millisecond) while the rider was on
 * Orange Line vehicle 1:8217, trip 1:1368267, leg 0: last fix 17:50:55
 * 44.899208,-93.275110, 26.47 m/s, accuracy 3.1 m; route match on-route,
 * leg 0, progress 0.633. Stop should have left the search at the bus's next
 * stop, I-35W & 66th St Station 44.883158,-93.296483 — as a plain place, so
 * the Plan tap's Current Location sync does not drag it back to raw GPS.
 */

// Leg 0 of the 17:28 START_GO_MODE itinerary (trimmed to what the code reads).
const LEG0 = {
  distance: 8595.554996643192,
  duration: 413.805,
  endTime: 1792277621000,
  from: {
    lat: 44.948118,
    lon: -93.274824,
    name: 'I-35W & Lake St Station',
    stop: {
      code: '17781',
      gtfsId: '1:17781',
      id: '1:17781'
    },
    stopCode: '17781',
    stopId: '1:17781'
  },
  headsign: 'ORANGE Burnsville',
  intermediatePlaces: [
    {
      arrivalTime: 1792277321000,
      departureTime: 1792277321000,
      lat: 44.919417,
      lon: -93.274754,
      name: 'I-35W & 46th St Station',
      stop: {
        code: '53543',
        gtfsId: '1:53543',
        id: '1:53543'
      }
    }
  ],
  legGeometry: {
    length: 154,
    points:
      'u|iqGnvhxPH?XP~FAvIAjEAvB?lICbLAfJAvAAxRCrL@lH@pC?`D?zE@tD?vCD`EFr@@bDC~CBxAO|AAlCCdCFpBA`@IRIJCrABj@@D?h@@LBHD^JrCDtC@bCAzBH~ETfOElHCJ?|KDr@?jD@hCBvC@~D@pI?dE?vA@z@?rDIpK?nB?vABd@?hCFvBBrBBbFDzA@l@@pA@v@@d@@Z@^D\\DZFVH\\Jf@Tj@Zd@^XVVV^b@^h@Xh@Xj@Xt@Nb@@BJ`@Jb@Lj@H`@Db@Ht@Fz@Bz@@l@ArA?zDAjGA`FAbDCdL?vE?rC?jAB`DBlE?h@BzC@xA@nA@v@Bf@Bj@Dh@LdALr@Nt@Rt@LZFPRj@Xh@Zl@\\d@f@l@XXf@`@ZRJFRN^NFBb@Nn@Nh@H^@l@Bx@Ar@?xAXj@@rA@nABhA@pCBj@@h@@TA^CTCD?@?'
  },
  mode: 'BUS',
  realTime: false,
  route: {
    color: 'F68B1F',
    gtfsId: '1:904',
    id: '1:904',
    longName: 'METRO Orange Line',
    shortName: null,
    textColor: '000000',
    type: 3
  },
  routeId: '1:904',
  startTime: 1792277207195,
  to: {
    lat: 44.883158,
    lon: -93.296483,
    name: 'I-35W & 66th St Station',
    stop: {
      code: '52719',
      gtfsId: '1:52719',
      id: '1:52719'
    },
    stopCode: '52719',
    stopId: '1:52719'
  },
  transitLeg: true,
  trip: {
    gtfsId: '1:1368267',
    tripHeadsign: 'ORANGE Burnsville'
  },
  tripHeadsign: 'ORANGE Burnsville',
  tripId: '1:1368267'
}

const LEG1 = {
  from: { lat: 44.883158, lon: -93.296483, name: 'I-35W & 66th St Station' },
  mode: 'BICYCLE',
  to: {
    lat: 44.8704,
    lon: -93.3032,
    name: 'Jefferson Park, Thomas Avenue South, Richfield, MN'
  },
  transitLeg: false
}

const STOP_MS = 1792277457040 // 17:50:57.040
const FIX_MS = 1792277454999 // 17:50:55
const START_FROM = {
  category: 'CURRENT_LOCATION',
  lat: 44.94109906726045,
  lon: -93.21532487877944,
  name: '(Current Location)'
}
const STOP_66TH = {
  lat: 44.883158,
  lon: -93.296483,
  name: 'I-35W & 66th St Station'
}

const fix = (over: any = {}, at = FIX_MS): any => ({
  coords: {
    accuracy: 3.072890272735073,
    latitude: 44.899207515520466,
    longitude: -93.2751097522235,
    speed: 26.470715240970247,
    ...over
  },
  timestamp: at
})

const RIDING = {
  boardedAt: 1792277206081,
  headsign: 'ORANGE Burnsville',
  legIndex: 0,
  offRouteSince: null,
  routeId: '1:904',
  routeShortName: null,
  tripId: '1:1368267',
  vehicleId: '1:8217'
}

const ROUTE_MATCH = {
  distanceFromRoute: 6,
  isOnRoute: true,
  legIndex: 0,
  matchedAtMs: FIX_MS,
  progressAlongLeg: 0.6332521603249276
}

interface Setup {
  fix?: any
  /** Remount-renamed from, as at 17:49:53.734 on the day. */
  from?: any
  originalFrom?: any
  plannerFix?: any
  riding?: any
  routeMatch?: any
  trips?: any
}

function makeStore(setup: Setup = {}) {
  const lastPosition = 'fix' in setup ? setup.fix : fix()
  let goModeState: any = {
    ...goMode(undefined, { type: '@@INIT' }),
    activeItinerary: { legs: [LEG0, LEG1] },
    isActive: true,
    originalFrom: 'originalFrom' in setup ? setup.originalFrom : START_FROM,
    riding: 'riding' in setup ? setup.riding : RIDING,
    routeMatch: 'routeMatch' in setup ? setup.routeMatch : ROUTE_MATCH
  }
  goModeState = {
    ...goModeState,
    tracking: {
      ...goModeState.tracking,
      lastPosition,
      lastTrustedPosition: lastPosition
    }
  }
  let currentQuery: any = {
    from: 'from' in setup ? setup.from : { ...START_FROM, ...STOP_66TH }
  }
  const location: any = {
    currentPosition: 'plannerFix' in setup ? setup.plannerFix : {}
  }
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery,
      goMode: goModeState,
      location,
      transitIndex: { routes: {}, trips: setup.trips || {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    if (action.type === 'SET_QUERY_PARAM') {
      currentQuery = { ...currentQuery, ...action.payload }
    } else if (action.type === 'SET_LOCATION') {
      const { location: loc, locationType } = action.payload
      currentQuery = { ...currentQuery, [locationType]: loc }
    }
    goModeState = goMode(goModeState, action)
    return action
  }
  return {
    actions,
    dispatch,
    from: () => currentQuery.from,
    getState,
    location
  }
}

describe('util > go-mode > Stop origin (51.2, 2026-10-17)', () => {
  let nowSpy: jest.SpyInstance
  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(STOP_MS)
  })
  afterEach(() => nowSpy.mockRestore())

  it('(a) aboard and moving: Stop leaves the next stop, not the 17:25 start', () => {
    const store = makeStore()
    expect(stopOriginAboard(store.getState(), STOP_MS)).toEqual(STOP_66TH)
    store.dispatch(endGoMode())
    const from = store.from()
    expect(from).toEqual(STOP_66TH)
    expect(from.category).toBeUndefined()
    expect(from.lat).not.toBe(44.94109906726045)
    expect(from.lon).not.toBe(-93.21532487877944)
    expect(store.getState().otp.goMode.isActive).toBe(false)
  })

  const gpsAtFix = (over: any = {}) => ({
    ...START_FROM,
    lat: 44.899207515520466,
    lon: -93.2751097522235,
    ...over
  })

  it('(b) speed 0 (a bus at a stop, or just stepped off): GPS', () => {
    const store = makeStore({ fix: fix({ speed: 0 }) })
    expect(stopOriginAboard(store.getState(), STOP_MS)).toBeNull()
    store.dispatch(endGoMode())
    expect(store.from()).toEqual(gpsAtFix())
  })

  it('(c) no speed on the fix (as the 17:49:53 resume fixes): GPS', () => {
    const store = makeStore({ fix: fix({ speed: null }) })
    expect(stopOriginAboard(store.getState(), STOP_MS)).toBeNull()
    store.dispatch(endGoMode())
    expect(store.from()).toEqual(gpsAtFix())
    expect(store.from().category).toBe('CURRENT_LOCATION')
  })

  it('(d) a synthetic route: vehicle is no evidence of a bus: GPS', () => {
    const store = makeStore({ riding: { ...RIDING, vehicleId: 'route:1:904' } })
    expect(stopOriginAboard(store.getState(), STOP_MS)).toBeNull()
    store.dispatch(endGoMode())
    expect(store.from()).toEqual(gpsAtFix())
  })

  it('(e) off the route, or the fix older than 15 s: GPS', () => {
    const off = makeStore({ routeMatch: { ...ROUTE_MATCH, isOnRoute: false } })
    expect(stopOriginAboard(off.getState(), STOP_MS)).toBeNull()
    off.dispatch(endGoMode())
    expect(off.from()).toEqual(gpsAtFix())

    // 20 s old: not aboard-trusted, but still the freshest fix to plan from.
    const old = makeStore({ fix: fix({}, STOP_MS - 20_000) })
    expect(stopOriginAboard(old.getState(), STOP_MS)).toBeNull()
    old.dispatch(endGoMode())
    expect(old.from()).toEqual(gpsAtFix())

    // A match anchored to a different leg is not "on the ridden leg".
    const otherLeg = makeStore({ routeMatch: { ...ROUTE_MATCH, legIndex: 1 } })
    expect(stopOriginAboard(otherLeg.getState(), STOP_MS)).toBeNull()
  })

  it('(f) no next stop on the ride: GPS', () => {
    // Anchored (fact and match) to leg 1, the bike leg: every other gate
    // holds, but there is no stop list, so no next stop.
    const store = makeStore({
      riding: { ...RIDING, legIndex: 1 },
      routeMatch: { ...ROUTE_MATCH, legIndex: 1 }
    })
    expect(stopOriginAboard(store.getState(), STOP_MS)).toBeNull()
    store.dispatch(endGoMode())
    expect(store.from()).toEqual(gpsAtFix())
  })

  it('(g) no riding fact: GPS', () => {
    const store = makeStore({ riding: null })
    expect(stopOriginAboard(store.getState(), STOP_MS)).toBeNull()
    store.dispatch(endGoMode())
    expect(store.from()).toEqual(gpsAtFix())
  })

  it('(g2) a riding fact for a run that ended: GPS', () => {
    const store = makeStore({
      trips: {
        '1:1368267': {
          stopTimes: [
            // Last stop 30 min before Stop: past the 10-min slack.
            { scheduledArrival: 0, serviceDay: (STOP_MS - 30 * 60_000) / 1000 }
          ]
        }
      }
    })
    expect(stopOriginAboard(store.getState(), STOP_MS)).toBeNull()
  })

  it('(h) a typed origin is restored exactly as before', () => {
    const typed = { lat: 44.9481, lon: -93.2748, name: '3324 40th Ave S' }
    const store = makeStore({ originalFrom: typed })
    store.dispatch(endGoMode())
    expect(store.from()).toEqual(typed)

    // ...and not touched when the form already holds it.
    const same = makeStore({ from: typed, originalFrom: typed })
    same.dispatch(endGoMode())
    expect(
      same.actions.filter((a) => a.type === 'SET_QUERY_PARAM')
    ).toHaveLength(0)
  })

  it('(i) no fix anywhere: the Current Location start keeps its category, no throw', () => {
    const store = makeStore({ fix: null, plannerFix: {} })
    expect(stopOriginAboard(store.getState(), STOP_MS)).toBeNull()
    expect(() => store.dispatch(endGoMode())).not.toThrow()
    expect(store.from()).toEqual(START_FROM)
    expect(store.from().category).toBe('CURRENT_LOCATION')
  })

  it('falls back to the planner fix when Go Mode has none', () => {
    const store = makeStore({
      fix: null,
      plannerFix: {
        coords: { accuracy: 8, latitude: 44.91, longitude: -93.27 },
        timestamp: STOP_MS - 1000
      }
    })
    store.dispatch(endGoMode())
    expect(store.from()).toEqual({ ...START_FROM, lat: 44.91, lon: -93.27 })
  })

  it('(j) the Plan tap sync leaves the next stop alone', () => {
    const store = makeStore()
    store.dispatch(endGoMode())
    // A fresh planner fix lands before the rider taps Plan.
    store.location.currentPosition = {
      coords: { accuracy: 3, latitude: 44.8985, longitude: -93.2751 },
      timestamp: STOP_MS + 2000
    }
    const before = store.actions.length
    store.dispatch(syncCurrentLocationOrigin())
    expect(store.actions.length).toBe(before)
    expect(store.from()).toEqual(STOP_66TH)

    // ...whereas the GPS case IS re-synced to the newer fix, as today.
    const gps = makeStore({ fix: fix({ speed: 0 }) })
    gps.dispatch(endGoMode())
    gps.location.currentPosition = {
      coords: { accuracy: 3, latitude: 44.8985, longitude: -93.2751 },
      timestamp: STOP_MS + 2000
    }
    gps.dispatch(syncCurrentLocationOrigin())
    expect(gps.from()).toEqual(gpsAtFix({ lat: 44.8985, lon: -93.2751 }))
  })
})
