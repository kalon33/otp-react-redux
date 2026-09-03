/* globals describe, expect, it, jest */
import {
  acceptAutoReplan,
  pickHopFreeSibling
} from '../../../lib/util/go-mode/replan-acceptance'
import {
  applyAutoReroute,
  stopVehicleTracking
} from '../../../lib/actions/go-mode'
import { rankAlightOptions } from '../../../lib/util/go-mode/alight-optimizer'
import goModeReducer from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * The reroute half of the 602 m bus leg (2026-08-31 17:32, "Lmfao what is this
 * route haha").
 *
 * Wave 1 fixed the list: `demoteTokenTransitHops` reorders what the rider is
 * SHOWN. It says nothing about an automatic swap, and the leg survived four
 * replans precisely there — `keepRouteId` pins the route the rider chose, the
 * picker takes the earliest departure on it, and nothing ever asked whether the
 * leg being kept was worth keeping.
 *
 * Numbers below are the recorded ones: board 98th St Gate C, ride the 539 for
 * 602 m to 98th & Dupont, then cycle 1743 m home, arriving 17:58:19; against
 * the same trip minus the hop — Orange Line then bike 3970 m — arriving
 * 18:01:24, 3m05s later.
 */
describe('token transit hops survive no replan (2026-08-31, 4.2 reroute half)', () => {
  const t = (hhmm: string) => {
    const [h, m, sec] = hhmm.split(':').map(Number)
    return Date.UTC(2026, 7, 31, h + 5, m, sec || 0)
  }
  const street = (distance: number) => ({
    distance,
    mode: 'BICYCLE',
    transitLeg: false
  })
  const bus = (routeId: string, distance: number, startTime = t('17:37')) => ({
    distance,
    mode: 'BUS',
    route: { id: routeId },
    routeId,
    startTime,
    transitLeg: true
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const itin = (endTime: number, legs: any[]) => ({ endTime, legs } as never)

  // Orange Line > bike 70 m > 539 (602 m) > bike 1743 m
  const withHop = itin(t('17:58:19'), [
    bus('1:904', 13279),
    street(70),
    bus('1:539', 602),
    street(1743)
  ])
  // The same journey minus the hop: Orange Line > bike 3970 m
  const hopFree = itin(t('18:01:24'), [bus('1:904', 13279), street(3970)])
  // A different trip entirely — same closing hop, but it never rode the Orange
  // Line, so it is not the hop-free version of anything above.
  const otherLine = itin(t('17:59'), [bus('1:535', 9000), street(3970)])

  describe('pickHopFreeSibling', () => {
    it('takes the hop-free version of the journey the picker chose', () => {
      // FAILS BEFORE: nothing existed between the picker and beginGoMode, so
      // the 602 m hop was applied exactly as the sort handed it over.
      expect(pickHopFreeSibling(withHop, [withHop, hopFree, otherLine])).toBe(
        hopFree
      )
    })

    it('keeps the rider on the route they chose', () => {
      // The sibling has to board the same route. Without this an itinerary
      // whose token hop is its ONLY transit leg would be silently downgraded to
      // biking the whole way — the one thing the rider has ruled out.
      const soloHop = itin(t('17:49'), [
        street(7),
        bus('1:539', 602),
        street(1743)
      ])
      const bikeOnly = itin(t('17:48'), [street(3970)])
      expect(
        pickHopFreeSibling(soloHop, [soloHop, bikeOnly], {
          requireRouteId: '1:539'
        })
      ).toBe(soloHop)
      // With no route to keep, the hop-free trip is the better answer.
      expect(pickHopFreeSibling(soloHop, [soloHop, bikeOnly])).toBe(bikeOnly)
    })

    it('leaves a genuine ride alone', () => {
      // 1273 m was the nearest real ride in the same OTP response.
      const realRide = itin(t('17:59'), [
        bus('1:904', 13279),
        street(70),
        bus('1:540', 1273),
        street(1408)
      ])
      expect(pickHopFreeSibling(realRide, [realRide, hopFree])).toBe(realRide)
    })

    it('will not trade the hop for a sibling that arrives much later', () => {
      const muchLater = itin(t('18:20'), [bus('1:904', 13279), street(3970)])
      expect(pickHopFreeSibling(withHop, [withHop, muchLater])).toBe(withHop)
    })

    it('keeps the hop when the pool holds no hop-free version', () => {
      expect(pickHopFreeSibling(withHop, [withHop, otherLine])).toBe(withHop)
    })

    it('passes a null candidate straight through', () => {
      expect(pickHopFreeSibling(null, [hopFree])).toBeNull()
    })
  })

  describe('acceptAutoReplan', () => {
    it('refuses to swap the plan in hand for the same trip plus a token hop', () => {
      // FAILS BEFORE: the hop arrives 3m05s EARLIER, so the arrival check waves
      // it through — arriving earlier is exactly what a 602 m ride between two
      // bike legs buys, and it is not worth having.
      expect(acceptAutoReplan(withHop, hopFree)).toEqual({
        accept: false,
        reason: 'token-transit-hop'
      })
    })

    it('still applies one when the current plan cannot happen', () => {
      // A rider who has missed their bus needs A plan; refusing this one leaves
      // them with none.
      expect(
        acceptAutoReplan(withHop, hopFree, { currentPlanIsDead: true })
      ).toEqual({ accept: true })
    })

    it('says nothing about a swap that is not the same journey', () => {
      expect(acceptAutoReplan(otherLine, hopFree)).toEqual({ accept: true })
    })

    it('refuses the reverse swap on ARRIVAL, not on the hop rule', () => {
      // hopFree arrives 3m05s after withHop, well past the 60 s slack, so this
      // is check 1 talking. Pinned so a later session does not read it as the
      // hop rule firing backwards.
      expect(acceptAutoReplan(hopFree, withHop)).toEqual({
        accept: false,
        reason: 'arrives-later'
      })
    })
  })

  describe('rankAlightOptions', () => {
    // The onboard optimizer's own answer, from the 17:37:11
    // ONBOARD_CANDIDATE_SNAPSHOT: the onward plans from two candidate alight
    // stops, one ending in the 602 m hop and one just riding home.
    const busArrivalEpoch = t('17:37')
    const onwardWithHop = {
      duration: 1200,
      endTime: t('17:58:19'),
      legs: [street(70), bus('1:539', 602, t('17:40')), street(1743)],
      startTime: t('17:40'),
      walkDistance: 0
    } as never
    const onwardHopFree = {
      duration: 1300,
      endTime: t('18:01:24'),
      legs: [street(3970)],
      startTime: t('17:40'),
      walkDistance: 0
    } as never

    it('ranks the hop-free onward plan above the 602 m hop', () => {
      // FAILS BEFORE: ranking is by arrival, and the hop arrives 3m05s earlier,
      // so "get off here and catch the 539 two blocks" was the recommendation.
      const ranked = rankAlightOptions(
        [
          {
            busArrivalEpoch,
            itineraries: [onwardWithHop],
            realtime: true,
            stopId: '1:53543',
            stopName: '98th St Gate C'
          },
          {
            busArrivalEpoch,
            itineraries: [onwardHopFree],
            realtime: true,
            stopId: '1:52719',
            stopName: 'I-35W & 98th St'
          }
        ],
        { nowMs: t('17:37') }
      )
      expect(ranked.map((o) => o.stopId)).toEqual(['1:52719', '1:53543'])
    })

    it('drops neither of them', () => {
      const ranked = rankAlightOptions(
        [
          {
            busArrivalEpoch,
            itineraries: [onwardWithHop],
            realtime: true,
            stopId: '1:53543',
            stopName: '98th St Gate C'
          },
          {
            busArrivalEpoch,
            itineraries: [onwardHopFree],
            realtime: true,
            stopId: '1:52719',
            stopName: 'I-35W & 98th St'
          }
        ],
        { nowMs: t('17:37') }
      )
      expect(ranked).toHaveLength(2)
    })
  })
})

/* eslint-disable sort-keys */
describe('applyAutoReroute takes the hop-free sibling (4.2 reroute half)', () => {
  const t = (hhmm: string) => {
    const [h, m, sec] = hhmm.split(':').map(Number)
    return Date.UTC(2026, 7, 31, h + 5, m, sec || 0)
  }
  const orangeLeg = () => ({
    distance: 13279,
    from: { lat: 44.86, lon: -93.28, name: 'I-35W & 98th St' },
    mode: 'BUS',
    route: { id: '1:904' },
    routeId: '1:904',
    routeShortName: 'Orange',
    startTime: t('17:37'),
    to: { lat: 44.94, lon: -93.28, name: 'Lake St Station' },
    transitLeg: true
  })
  const bike = (distance: number, name: string) => ({
    distance,
    from: { lat: 44.94, lon: -93.28, name: 'Lake St Station' },
    mode: 'BICYCLE',
    to: { lat: 44.95, lon: -93.279, name },
    transitLeg: false
  })
  const hop539 = () => ({
    distance: 602,
    from: { lat: 44.94, lon: -93.28, name: '98th St Gate C' },
    mode: 'BUS',
    route: { id: '1:539' },
    routeId: '1:539',
    routeShortName: '539',
    startTime: t('17:50'),
    to: { lat: 44.945, lon: -93.279, name: '98th & Dupont' },
    transitLeg: true
  })

  // Orange Line > bike 70 m > 539 (602 m) > bike 1743 m, arriving 17:58:19.
  const withHop = {
    duration: 1279,
    endTime: t('17:58:19'),
    legs: [
      orangeLeg(),
      bike(70, '98th St Gate C'),
      hop539(),
      bike(1743, 'Home')
    ],
    startTime: t('17:37')
  }
  // The same journey minus the hop, arriving 3m05s later.
  const hopFree = {
    duration: 1464,
    endTime: t('18:01:24'),
    legs: [orangeLeg(), bike(3970, 'Home')],
    startTime: t('17:37')
  }

  it('applies the trip without the 602 m leg, on the same Orange Line departure', async () => {
    // FAILS BEFORE: pickSameRouteReroute sorts by first-transit-leg departure —
    // identical here, both being the same Orange Line run — and hands back
    // whichever came first, which was the shorter-duration hop version. The
    // 602 m leg then rode straight through beginGoMode, four replans running.
    const reducer = goModeReducer
    let state: any = {
      ...reducer(undefined, { type: '@@INIT' }),
      activeItinerary: {
        duration: 900,
        endTime: t('17:45'),
        legs: [orangeLeg()],
        startTime: t('17:30')
      },
      isActive: true,
      reRoute: {
        autoApply: true,
        keepRouteId: '1:904',
        reason: 'missed-bus',
        searchId: 's1',
        startedAtMs: t('17:36'),
        status: 'searching'
      },
      tracking: {
        lastPosition: { coords: { latitude: 44.86, longitude: -93.28 } }
      }
    }
    const actions: any[] = []
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: {},
        goMode: state,
        transitIndex: { routes: {}, trips: {} }
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      actions.push(action)
      state = reducer(state, action)
      return action
    }

    // The hop version is listed first and is the shorter trip — the ordering
    // the recorded response actually had.
    await dispatch(applyAutoReroute([withHop, hopFree] as never))
    stopVehicleTracking()(() => undefined)

    const started = actions.find((a) => a.type === 'START_GO_MODE')
    expect(started).toBeTruthy()
    const applied = started.payload.itinerary
    expect(applied.legs.map((l: any) => l.routeId ?? l.mode)).toEqual([
      '1:904',
      'BICYCLE'
    ])
  })
})
