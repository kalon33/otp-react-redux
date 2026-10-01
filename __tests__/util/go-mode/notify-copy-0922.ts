import fs from 'fs'
import path from 'path'

import { encode } from '@mapbox/polyline'
import flatten from 'flat'
import yaml from 'js-yaml'

import {
  applyAutoReroute,
  handlePositionUpdate
} from '../../../lib/actions/go-mode'
import { cancelPush, sendPush } from '../../../lib/util/go-mode/native-notify'
import {
  resetNotifyLocale,
  setNotifyLocale
} from '../../../lib/util/go-mode/notify-i18n'
import {
  RETURN_LEAVE_NOW_NOTIFICATION_ID,
  RETURN_LEAVE_SOON_MIN,
  RETURN_LEAVE_SOON_NOTIFICATION_ID
} from '../../../lib/util/go-mode/round-trip'
import goModeReducer from '../../../lib/reducers/go-mode'
import type { RoundTripPlan } from '../../../lib/util/go-mode/round-trip'

jest.mock('../../../lib/util/go-mode/native-notify', () => ({
  ...jest.requireActual('../../../lib/util/go-mode/native-notify'),
  cancelPush: jest.fn(() => Promise.resolve()),
  ensureNativeNotifyPermission: jest.fn(() => Promise.resolve(true)),
  hasNativeNotify: jest.fn(() => true),
  sendPush: jest.fn(() => Promise.resolve())
}))

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(() => () => Promise.resolve({})),
  fetchRerouteSnapshotPlan: jest.fn(() => () => Promise.resolve(null)),
  findRoutesNearby: jest.fn(() => () => Promise.resolve({})),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({})),
  onboardGraphQLQuery: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * Backlog 17.25 — the Go Mode alert copy that 12.23 could not reach.
 *
 * `lib/actions/go-mode.ts` was owned by five other agents in 12.23's wave, so
 * the notifications it raises itself stayed English literals with no key in
 * either message file. This is the mechanism test for the two that a rider
 * actually reads: the "Trip updated" confirmation an automatic re-plan pushes,
 * and the two round-trip return pushes handed to the OS at arrival. Each is
 * asserted in en-US AND in fr, so a string that goes back to a literal fails
 * here and not on a French rider's lock screen.
 */
const catalogue = (locale: string): Record<string, string> =>
  flatten(
    yaml.load(
      fs.readFileSync(
        path.join(__dirname, `../../../i18n/${locale}.yml`),
        'utf8'
      )
    ) as Record<string, unknown>
  )

const mockSend = sendPush as jest.Mock
const mockCancel = cancelPush as jest.Mock

const RealDate = Date
let fakeNow = 0

const freezeClock = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = global as any
  g.Date = class extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      super(...((args.length ? args : [fakeNow]) as [any]))
    }

    static now(): number {
      return fakeNow
    }
  }
}

beforeEach(() => {
  mockSend.mockClear()
  mockCancel.mockClear()
  freezeClock()
})

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = global as any
  g.Date = RealDate
  resetNotifyLocale()
})

/* eslint-disable sort-keys */
describe('the automatic re-plan confirmation is localized (17.25)', () => {
  const T0 = Date.UTC(2026, 8, 22, 22, 0, 0)
  const orangeLeg = (startTime: number) => ({
    distance: 13279,
    from: { lat: 44.86, lon: -93.28, name: 'I-35W & 98th St' },
    mode: 'BUS',
    route: { id: '1:904' },
    routeId: '1:904',
    routeShortName: 'Orange',
    startTime,
    to: { lat: 44.94, lon: -93.28, name: 'Lake St Station' },
    transitLeg: true
  })
  const candidate = () => ({
    duration: 900,
    endTime: T0 + 21 * 60000,
    legs: [
      orangeLeg(T0 + 6 * 60000),
      {
        distance: 1743,
        from: { lat: 44.94, lon: -93.28, name: 'Lake St Station' },
        mode: 'BICYCLE',
        to: { lat: 44.95, lon: -93.279, name: 'Home' },
        transitLeg: false
      }
    ],
    startTime: T0 + 6 * 60000
  })

  const runReroute = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let state: any = {
      ...goModeReducer(undefined, { type: '@@INIT' }),
      activeItinerary: {
        duration: 900,
        endTime: T0 + 15 * 60000,
        legs: [orangeLeg(T0)],
        startTime: T0
      },
      isActive: true,
      reRoute: {
        autoApply: true,
        keepRouteId: '1:904',
        reason: 'missed-bus',
        searchId: 's1',
        startedAtMs: T0,
        status: 'searching'
      },
      tracking: {
        lastPosition: { coords: { latitude: 44.86, longitude: -93.28 } }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actions: any[] = []
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: {},
        goMode: state,
        transitIndex: { routes: {}, trips: {} }
      }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      actions.push(action)
      state = goModeReducer(state, action)
      return action
    }
    fakeNow = T0
    await dispatch(applyAutoReroute([candidate()] as never))
    return actions
      .filter((a) => a.type === 'ADD_NOTIFICATION')
      .map((a) => a.payload)
      .filter((n) => n.type === 'TRIP_UPDATED')
  }

  it('reads in English exactly as the literal did', async () => {
    setNotifyLocale('en-US', catalogue('en-US'))
    const [alert] = await runReroute()
    expect(alert.title).toBe('Trip updated')
    expect(alert.message).toBe('Orange · in 6 min · I-35W & 98th St')
  })

  it('reads in French, title and body', async () => {
    setNotifyLocale('fr', catalogue('fr'))
    const [alert] = await runReroute()
    expect(alert.title).toBe('Trajet mis à jour')
    expect(alert.message).toBe('Orange · dans 6 min · I-35W & 98th St')
  })
})

describe('the round-trip return pushes are localized (17.25)', () => {
  const MIN = 60000
  const BASE = Date.UTC(2026, 8, 22, 23, 0, 0)
  const ORIGIN: [number, number] = [44.95, -93.29]
  const DEST: [number, number] = [44.98, -93.27]

  const fixAt = ([lat, lon]: [number, number], timestamp: number) =>
    ({
      coords: {
        accuracy: 8,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        latitude: lat,
        longitude: lon,
        speed: 0
      },
      timestamp
    } as GeolocationPosition)

  const plan = (leaveByMs: number): RoundTripPlan =>
    ({
      destination: { lat: DEST[0], lon: DEST[1], name: 'Destination' },
      leaveByMs,
      origin: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Origin' },
      plannedDepartMs: leaveByMs,
      refreshedAtMs: null,
      returnItinerary: {
        endTime: leaveByMs + 30 * MIN,
        legs: [
          {
            endTime: leaveByMs + 30 * MIN,
            mode: 'BUS',
            route: { id: '1:21' },
            routeShortName: '21',
            startTime: leaveByMs,
            transitLeg: true
          }
        ],
        startTime: leaveByMs
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      stayMinutes: 120
    } as RoundTripPlan)

  const arrive = async () => {
    const leaveByMs = BASE + 120 * MIN
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let state: any = {
      ...goModeReducer(undefined, { type: '@@INIT' }),
      activeItinerary: {
        duration: 1800,
        endTime: BASE,
        legs: [
          {
            distance: 3800,
            duration: 1800,
            endTime: BASE,
            from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Origin' },
            legGeometry: { points: encode([ORIGIN, DEST]) },
            mode: 'WALK',
            startTime: BASE - 30 * MIN,
            to: { lat: DEST[0], lon: DEST[1], name: 'Destination' },
            transitLeg: false
          }
        ],
        startTime: BASE - 30 * MIN
      },
      isActive: true,
      roundTrip: plan(leaveByMs),
      tracking: {
        ...goModeReducer(undefined, { type: '@@INIT' }).tracking,
        lastPosition: fixAt(ORIGIN, BASE - MIN)
      }
    }
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: {},
        goMode: state,
        transitIndex: { routes: {}, stops: {}, trips: {} }
      }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return undefined
      state = goModeReducer(state, action)
      return action
    }
    fakeNow = BASE
    await handlePositionUpdate(fixAt(DEST, BASE))(dispatch, getState)
    // Let armReturnPushes' awaits settle.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    return mockSend.mock.calls.map((c) => c[0])
  }

  it('keeps the ↩ marker and takes its words from the English catalogue', async () => {
    setNotifyLocale('en-US', catalogue('en-US'))
    const pushes = await arrive()
    const soon = pushes.find((p) => p.id === RETURN_LEAVE_SOON_NOTIFICATION_ID)
    const now = pushes.find((p) => p.id === RETURN_LEAVE_NOW_NOTIFICATION_ID)
    expect(soon?.title).toBe(`↩ Leave in ${RETURN_LEAVE_SOON_MIN} min`)
    expect(now?.title).toBe('↩ Leave now')
  })

  it('reads in French, marker outside the translated words', async () => {
    setNotifyLocale('fr', catalogue('fr'))
    const pushes = await arrive()
    const soon = pushes.find((p) => p.id === RETURN_LEAVE_SOON_NOTIFICATION_ID)
    const now = pushes.find((p) => p.id === RETURN_LEAVE_NOW_NOTIFICATION_ID)
    expect(soon?.title).toBe(`↩ Partir dans ${RETURN_LEAVE_SOON_MIN} min`)
    expect(now?.title).toBe('↩ Partir maintenant')
  })
})
