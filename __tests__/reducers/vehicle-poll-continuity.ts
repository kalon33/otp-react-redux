import '../test-utils/mock-window-url'
import { existsSync } from 'fs'
import path from 'path'

import { MAX_CARRIED_EMPTY_VEHICLE_POLLS } from '../../lib/util/go-mode/vehicle-matching'
import { restoreDateNowBehavior, setDefaultTestTime } from '../test-utils'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'

/**
 * Backlog 25.4: an empty but successful vehicle poll used to erase the
 * route's whole vehicle list until the next poll refilled it. The reducer now
 * carries the last non-empty list across up to MAX_CARRIED_EMPTY_VEHICLE_POLLS
 * empty responses, counts them on the route entry, and empties the list past
 * that bound exactly as before.
 */

const ROUTE = '1:904'
const bus = (vehicleId: string, seconds: number) => ({
  lat: 44.9,
  lon: -93.27,
  routeId: ROUTE,
  seconds,
  tripId: `trip-${vehicleId}`,
  vehicleId
})
const poll = (vehicles: any[], routeId = ROUTE) => ({
  payload: { routeId, vehicles },
  type: 'REALTIME_VEHICLE_POSITIONS_RESPONSE'
})

describe('lib > reducers > vehicle poll continuity (25.4)', () => {
  afterEach(restoreDateNowBehavior)

  const setup = () => {
    setDefaultTestTime()
    const reducer = createOtpReducer({})
    return { initial: reducer(undefined, { type: '@@INIT' }), reducer }
  }

  it('one empty poll keeps the last list, its own timestamps, and counts itself', () => {
    const { initial, reducer } = setup()
    const full = [bus('1:8142', 1790028324), bus('1:8216', 1790028330)]
    const s1 = reducer(initial, poll(full))
    expect(s1.transitIndex.routes[ROUTE].vehicles).toEqual(full)

    const s2 = reducer(s1, poll([]))
    // Same records, untouched — their feed `seconds` still say how old they are.
    expect(s2.transitIndex.routes[ROUTE].vehicles).toBe(
      s1.transitIndex.routes[ROUTE].vehicles
    )
    expect(s2.transitIndex.routes[ROUTE].emptyVehiclePolls).toBe(1)

    // The next real poll replaces the list and resets the count.
    const next = [bus('1:8142', 1790028345)]
    const s3 = reducer(s2, poll(next))
    expect(s3.transitIndex.routes[ROUTE].vehicles).toEqual(next)
    expect(s3.transitIndex.routes[ROUTE].emptyVehiclePolls).toBe(0)
  })

  it('past the bound the list empties, as it always did', () => {
    const { initial, reducer } = setup()
    let s = reducer(initial, poll([bus('1:8142', 1790028324)]))
    for (let i = 1; i <= MAX_CARRIED_EMPTY_VEHICLE_POLLS; i++) {
      s = reducer(s, poll([]))
      expect(s.transitIndex.routes[ROUTE].vehicles).toHaveLength(1)
      expect(s.transitIndex.routes[ROUTE].emptyVehiclePolls).toBe(i)
    }
    s = reducer(s, poll([]))
    expect(s.transitIndex.routes[ROUTE].vehicles).toEqual([])
    expect(s.transitIndex.routes[ROUTE].emptyVehiclePolls).toBe(
      MAX_CARRIED_EMPTY_VEHICLE_POLLS + 1
    )
    // …and it stays empty: nothing is resurrected by a later empty poll.
    s = reducer(s, poll([]))
    expect(s.transitIndex.routes[ROUTE].vehicles).toEqual([])
  })

  it('a route that never published a vehicle has nothing to carry', () => {
    const { initial, reducer } = setup()
    // First poll creates the entry empty (MVTA before its feed was wired up).
    let s = reducer(initial, poll([], '2:465'))
    expect(s.transitIndex.routes['2:465'].vehicles).toEqual([])
    s = reducer(s, poll([], '2:465'))
    expect(s.transitIndex.routes['2:465'].vehicles).toEqual([])
    expect(s.transitIndex.routes['2:465'].emptyVehiclePolls).toBe(1)
  })

  it('other routes are untouched by one route s empty poll', () => {
    const { initial, reducer } = setup()
    let s = reducer(initial, poll([bus('1:8142', 1)]))
    s = reducer(s, poll([bus('1:SL-1', 2)], '1:902'))
    s = reducer(s, poll([], '1:902'))
    expect(s.transitIndex.routes[ROUTE].vehicles).toHaveLength(1)
    expect(s.transitIndex.routes['1:902'].vehicles).toHaveLength(1)
  })
})

// The ride the row was written from. Untracked recording (too large to
// commit), so this half skips on a fresh clone — the 25.5 pattern.
const FIXTURE = path.join(
  __dirname,
  '../../lib/util/go-mode/replay/fixtures/0921-1646-orange-missedbus.json'
)
const withFixture = existsSync(FIXTURE) ? describe : describe.skip

withFixture('25.4 replayed on 2026-09-21 16:46 (mubq7tfx-8dz3ar)', () => {
  afterEach(restoreDateNowBehavior)

  it('BEFORE 15 of 124 polls blanked route 1:904; AFTER none does', () => {
    setDefaultTestTime()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fx = require(FIXTURE)
    const snaps = [...fx.vehicleSnapshots].sort(
      (a: any, b: any) => a.tMs - b.tMs
    )
    expect(snaps).toHaveLength(124)
    const emptyResponses = snaps.filter(
      (s: any) => s.payload.vehicles.length === 0
    )
    expect(emptyResponses).toHaveLength(15)

    const reducer = createOtpReducer({})
    let state = reducer(undefined, { type: '@@INIT' })
    let blankAfterFirstFill = 0
    let filled = false
    let maxCarried = 0
    for (const snap of snaps) {
      state = reducer(state, {
        payload: snap.payload,
        type: 'REALTIME_VEHICLE_POSITIONS_RESPONSE'
      })
      const route = state.transitIndex.routes['1:904']
      if (route.vehicles.length > 0) filled = true
      else if (filled) blankAfterFirstFill++
      maxCarried = Math.max(maxCarried, route.emptyVehiclePolls || 0)
    }
    expect(blankAfterFirstFill).toBe(0)
    // The longest run of empties on this ride was four polls.
    expect(maxCarried).toBe(4)
  })
})
