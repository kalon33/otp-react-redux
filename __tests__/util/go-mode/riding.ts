import {
  advanceToLeg,
  clearRiding,
  setRiding,
  startGoMode,
  stopGoMode,
  stopVehicleTracking,
  transitionLeg
} from '../../../lib/actions/go-mode'
import { getNextStopOnRide } from '../../../lib/util/go-mode/next-stop'
import goMode from '../../../lib/reducers/go-mode'
import type { RidingState } from '../../../lib/actions/go-mode'

const initial = goMode(undefined, { type: '@@INIT' })

const riding: RidingState = {
  boardedAt: 1000,
  headsign: 'Downtown Minneapolis',
  legIndex: 1,
  offRouteSince: null,
  routeId: '1:904',
  routeShortName: 'Orange',
  tripId: '1:trip-1',
  vehicleId: 'v-42'
}

describe('go-mode riding reducer', () => {
  it('starts with no riding fact', () => {
    expect(initial.riding).toBeNull()
  })

  it('SET_RIDING / CLEAR_RIDING round-trip', () => {
    const set = goMode(initial, setRiding(riding))
    expect(set.riding).toEqual(riding)
    expect(goMode(set, clearRiding()).riding).toBeNull()
  })

  it('TRANSITION_LEG past the bus leg clears riding (alighted)', () => {
    const set = goMode(initial, setRiding(riding))
    expect(goMode(set, transitionLeg({ legIndex: 2 })).riding).toBeNull()
  })

  it('TRANSITION_LEG onto or before the bus leg keeps riding', () => {
    const set = goMode(initial, setRiding(riding))
    expect(goMode(set, transitionLeg({ legIndex: 1 })).riding).toEqual(riding)
  })

  it('TRANSITION_LEG keeps an un-anchored riding fact (legIndex -1)', () => {
    const set = goMode(initial, setRiding({ ...riding, legIndex: -1 }))
    expect(goMode(set, transitionLeg({ legIndex: 3 })).riding).not.toBeNull()
  })

  it('TRANSITION_LEG resets routeMatch progress to the start of the new leg', () => {
    // Manual "I got off here"/onboard transitions used to inherit the old
    // leg's ~1.0 progress, flashing "1 stop remaining" (and its GET READY
    // banner) until the next GPS tick recomputed.
    const withMatch = {
      ...goMode(initial, setRiding(riding)),
      routeMatch: {
        distanceFromRoute: 12,
        isOnRoute: true,
        legIndex: 1,
        nearestPoint: [44.9, -93.2],
        progressAlongLeg: 0.98,
        progressAlongSegment: 0.6,
        segmentIndex: 7
      }
    } as any
    const next = goMode(withMatch, transitionLeg({ legIndex: 2 }))
    expect(next.routeMatch).toMatchObject({
      legIndex: 2,
      progressAlongLeg: 0,
      progressAlongSegment: 0,
      segmentIndex: 0
    })
  })

  it('START_GO_MODE re-anchors riding onto the new itinerary by tripId', () => {
    const set = goMode(initial, setRiding(riding))
    const itinerary: any = {
      legs: [
        { mode: 'WALK' },
        { mode: 'BUS', transitLeg: true, trip: { gtfsId: '1:other' } },
        { mode: 'BUS', transitLeg: true, trip: { gtfsId: '1:trip-1' } }
      ]
    }
    const state = goMode(set, startGoMode({ itinerary }))
    expect(state.riding?.legIndex).toBe(2)
  })

  it('START_GO_MODE with a spliced-bus itinerary re-anchors riding to leg 0', () => {
    // replanFromAboard's auto-apply swaps in a buildOnboardItinerary splice
    // whose FIRST leg is the boarded bus (both tripId and trip.gtfsId are
    // set on the synthesized leg) — riding must re-anchor onto it so alight
    // detection and live leg times keep tracking the ridden trip.
    const set = goMode(initial, setRiding(riding))
    const spliced: any = {
      legs: [
        {
          mode: 'BUS',
          route: { id: '1:904' },
          transitLeg: true,
          trip: { gtfsId: '1:trip-1' },
          tripId: '1:trip-1'
        },
        { mode: 'WALK' }
      ]
    }
    const state = goMode(set, startGoMode({ itinerary: spliced }))
    expect(state.riding?.legIndex).toBe(0)
    expect(state.riding?.tripId).toBe('1:trip-1')
  })

  it('re-anchors across the leg merge, which shifts every downstream index', () => {
    // normalizeGoModeItinerary collapses two legs of one trip into one, so a
    // riding fact anchored at legIndex 2 on the split itinerary must land at 1
    // on the merged one. Nothing carries the old index over — reanchorRiding
    // re-derives it from tripId, which is what makes the merge safe at the
    // beginGoMode boundary despite riding.legIndex, progress.currentLegIndex
    // and the TRANSITION_LEG comparison all being index-based.
    const set = goMode(initial, setRiding({ ...riding, legIndex: 2 }))
    const mergedItinerary: any = {
      legs: [
        { mode: 'WALK' },
        {
          mode: 'BUS',
          transitLeg: true,
          trip: { gtfsId: '1:trip-1' },
          tripId: '1:trip-1'
        },
        { mode: 'BICYCLE' }
      ]
    }
    const state = goMode(set, startGoMode({ itinerary: mergedItinerary }))
    expect(state.riding?.legIndex).toBe(1)
  })

  it('START_GO_MODE falls back to routeId, else keeps fact un-anchored', () => {
    const set = goMode(initial, setRiding(riding))
    const byRoute: any = {
      legs: [{ mode: 'BUS', route: { id: '1:904' }, transitLeg: true }]
    }
    expect(
      goMode(set, startGoMode({ itinerary: byRoute })).riding?.legIndex
    ).toBe(0)
    const noMatch: any = { legs: [{ mode: 'WALK' }] }
    const state = goMode(set, startGoMode({ itinerary: noMatch }))
    expect(state.riding?.legIndex).toBe(-1)
    expect(state.riding?.tripId).toBe('1:trip-1')
  })

  it('records WHICH trip the rider got off (8/9)', () => {
    const set = goMode(initial, setRiding(riding))
    const alighted = goMode(set, transitionLeg({ legIndex: 2 }))
    expect(alighted.alightedFrom).toEqual({
      tripId: '1:trip-1',
      vehicleId: 'v-42'
    })
    // Not an alight, not a record.
    expect(goMode(set, transitionLeg({ legIndex: 1 })).alightedFrom).toBeNull()
  })

  it('the alight fact outlives STOP_GO_MODE, like the match it disproves (8/9)', () => {
    // STOP_GO_MODE keeps a confirmed vehicleMatch on purpose. If the alight
    // were dropped here, exiting Go Mode after getting off would hand the next
    // onboard flow the match without the fact that disproves it.
    const alighted = goMode(
      goMode(initial, setRiding(riding)),
      transitionLeg({ legIndex: 2 })
    )
    expect(goMode(alighted, stopGoMode()).alightedFrom).toEqual({
      tripId: '1:trip-1',
      vehicleId: 'v-42'
    })
  })

  it('boarding again clears it — a new assertion outranks the old alight', () => {
    const alighted = goMode(
      goMode(initial, setRiding(riding)),
      transitionLeg({ legIndex: 2 })
    )
    expect(goMode(alighted, setRiding(riding)).alightedFrom).toBeNull()
    expect(
      goMode(alighted, {
        payload: { confidence: 'confirmed', tripId: '1:trip-9' },
        type: 'CONFIRM_VEHICLE'
      }).alightedFrom
    ).toBeNull()
    // Clearing the riding fact is not boarding.
    expect(goMode(alighted, clearRiding()).alightedFrom).not.toBeNull()
  })

  it('STOP_GO_MODE preserves riding — exiting a screen is not alighting', () => {
    // 7/12: the rider backed out of Go Mode and immediately reopened the
    // onboard flow; with riding wiped the app forgot the confirmed bus and
    // re-ran (failing) discovery. Alight and sustained off-route remain the
    // physical invalidators (and a stale fact self-heals in 90s off-route).
    const set = goMode(initial, setRiding(riding))
    expect(goMode(set, stopGoMode()).riding).toEqual(riding)
  })
})

describe('getNextStopOnRide', () => {
  // A straight north-south leg: ~2.2km of polyline with stops at fixed
  // fractions. Encoded inline (precision 5) from simple coordinates.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const polyline = require('@mapbox/polyline')
  const coords = Array.from({ length: 21 }, (_, i) => [44.9 + i * 0.001, -93.2])
  const points = polyline.encode(coords, 5)

  const leg = {
    intermediatePlaces: [
      {
        arrivalTime: 2000,
        lat: 44.905, // fraction 0.25
        lon: -93.2,
        name: 'Quarter Stop',
        stop: { gtfsId: '1:stop-25' }
      },
      {
        arrivalTime: 3000,
        lat: 44.91, // fraction 0.5
        lon: -93.2,
        name: 'Half Stop',
        stop: { gtfsId: '1:stop-50' }
      }
    ],
    legGeometry: { length: coords.length, points },
    to: {
      lat: 44.92, // end of leg
      lon: -93.2,
      name: 'Terminal',
      stop: { gtfsId: '1:stop-end' }
    },
    transitLeg: true
  }

  const buildState = (
    progressAlongLeg: number | null,
    ridingOverrides = {}
  ) => ({
    otp: {
      goMode: {
        activeItinerary: { legs: [{ mode: 'WALK' }, leg] },
        isActive: true,
        riding: { ...riding, ...ridingOverrides },
        routeMatch:
          progressAlongLeg == null ? null : { legIndex: 1, progressAlongLeg }
      },
      transitIndex: { trips: {} }
    }
  })

  it('returns the first stop geometrically ahead of the rider', () => {
    const next = getNextStopOnRide(buildState(0.1), 1500)
    expect(next?.name).toBe('Quarter Stop')
    expect(next?.stopId).toBe('1:stop-25')
    // Planned arrival preserved, floored at "now".
    expect(next?.arrivalEpoch).toBe(2000)
  })

  it('skips passed stops and offers the leg terminus last', () => {
    expect(getNextStopOnRide(buildState(0.3), 1500)?.name).toBe('Half Stop')
    expect(getNextStopOnRide(buildState(0.9), 1500)?.name).toBe('Terminal')
  })

  it('falls back to arrival times when there is no route match', () => {
    expect(getNextStopOnRide(buildState(null), 2500)?.name).toBe('Half Stop')
  })

  it('prefers the boarded trip live stop time when available', () => {
    const state: any = buildState(0.1)
    state.otp.transitIndex.trips['1:trip-1'] = {
      stopTimes: [
        {
          realtimeArrival: 3,
          realtimeState: 'UPDATED',
          scheduledDeparture: 2,
          serviceDay: 1,
          stop: {
            id: '1:stop-25',
            lat: 44.905,
            lon: -93.2,
            name: 'Quarter Stop'
          }
        }
      ]
    }
    const next = getNextStopOnRide(state, 1500)
    expect(next?.arrivalEpoch).toBe(4000) // (serviceDay 1 + arrival 3) * 1000
    expect(next?.realtime).toBe(true)
  })

  it('returns null when not anchored to a transit leg', () => {
    expect(
      getNextStopOnRide(buildState(0.1, { legIndex: -1 }), 1500)
    ).toBeNull()
    expect(getNextStopOnRide(buildState(0.1, { legIndex: 0 }), 1500)).toBeNull()
  })
})

describe('advanceToLeg tears vehicle tracking down on the leg it lands on (8/9)', () => {
  // The 8/9 shape exactly: bus leg 0, bike leg 1, and by the time the GPS-driven
  // transition dispatches, the matcher has ALREADY moved routeMatch.legIndex to
  // 1. Reading the leg being left from that index made `previousLeg` the bike
  // leg, so the transit teardown was skipped and the confirmed match for
  // vehicle 1:8150 outlived the alight by 90 s — which the onboard flow then
  // read as proof the rider was still aboard.
  const itinerary: any = {
    legs: [
      {
        mode: 'BUS',
        route: { id: '1:904' },
        transitLeg: true,
        trip: { gtfsId: '1:1085482' }
      },
      { mode: 'BICYCLE', transitLeg: false }
    ]
  }

  const makeStore = (routeMatchLegIndex: number) => {
    let state: any = {
      ...goMode(initial, {
        payload: {
          confidence: 'confirmed',
          label: '8150',
          lastSeen: 1786321742376,
          nextStopId: '1:53311',
          routeId: '1:904',
          tripId: '1:1085482',
          vehicleId: '1:8150'
        },
        type: 'CONFIRM_VEHICLE'
      }),
      activeItinerary: itinerary,
      isActive: true,
      routeMatch: { legIndex: routeMatchLegIndex }
    }
    const types: string[] = []
    const getState = () => ({ otp: { config: {}, goMode: state } })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      types.push(action.type)
      state = goMode(state, action)
      return action
    }
    return { dispatch, getGoMode: () => state, types }
  }

  afterEach(() => {
    stopVehicleTracking()(() => undefined)
  })

  it('clears the match when the matcher has already advanced (the 8/9 miss)', () => {
    const store = makeStore(1)
    store.dispatch(advanceToLeg(1))
    expect(store.types).toContain('CLEAR_VEHICLE_MATCH')
    expect(store.getGoMode().vehicleMatch.match).toBeNull()
  })

  it('clears it just the same when the matcher is still on the bus leg', () => {
    const store = makeStore(0)
    store.dispatch(advanceToLeg(1))
    expect(store.getGoMode().vehicleMatch.match).toBeNull()
  })

  it('leaves a walk-to-walk transition alone — nothing to tear down', () => {
    let state: any = {
      ...initial,
      activeItinerary: { legs: [{ mode: 'WALK' }, { mode: 'WALK' }] },
      isActive: true,
      routeMatch: { legIndex: 0 }
    }
    const types: string[] = []
    const getState = () => ({ otp: { config: {}, goMode: state } })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      types.push(action.type)
      state = goMode(state, action)
      return action
    }
    dispatch(advanceToLeg(1))
    expect(types).not.toContain('CLEAR_VEHICLE_MATCH')
  })
})
