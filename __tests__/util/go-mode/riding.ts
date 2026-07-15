import {
  clearRiding,
  setRiding,
  startGoMode,
  stopGoMode,
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
