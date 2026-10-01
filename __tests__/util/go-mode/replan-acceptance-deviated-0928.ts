import { encode } from '@mapbox/polyline'
import FakeTimers from '@sinonjs/fake-timers'

import {
  acceptAutoReplan,
  accessPlanDeadByDeviation,
  DEVIATED_PLAN_DEAD_MS,
  DEVIATED_PLAN_MIN_CLOSING_M,
  nextDeviatedSince
} from '../../../lib/util/go-mode/replan-acceptance'
import {
  endGoMode,
  handlePositionUpdate,
  quietReplanAccessLeg
} from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import goMode from '../../../lib/reducers/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  }))
}))

/**
 * Backlog 35.2 — the quiet full re-plan's `arrives-later` veto had no escape
 * for a plan the rider has left. The escape is `accessPlanDeadByDeviation`:
 * deviated for `DEVIATED_PLAN_DEAD_MS` AND closed less than
 * `DEVIATED_PLAN_MIN_CLOSING_M` on the destination meanwhile. The 2026-09-28
 * streak that opened the row fails the second half by design — the rider was
 * converging, and the refusals were right (see deviated-plan-dead-0928.ts).
 */

const T0 = 1_790_635_000_000

describe('nextDeviatedSince', () => {
  it('opens on the first deviated tick with the distance then', () => {
    expect(
      nextDeviatedSince(null, {
        destinationM: 831,
        legIndex: 0,
        nowMs: T0,
        status: 'deviated'
      })
    ).toEqual({ atMs: T0, destinationM: 831, legIndex: 0 })
  })
  it('holds the onset while the streak lasts on the same leg', () => {
    const open = { atMs: T0, destinationM: 831, legIndex: 0 }
    expect(
      nextDeviatedSince(open, {
        destinationM: 700,
        legIndex: 0,
        nowMs: T0 + 60_000,
        status: 'deviated'
      })
    ).toBe(open)
  })
  it('closes on any other status and restarts on a leg change', () => {
    const open = { atMs: T0, destinationM: 831, legIndex: 0 }
    for (const status of ['on_track', 'ahead', 'behind', 'completed', null]) {
      expect(
        nextDeviatedSince(open, {
          destinationM: 700,
          legIndex: 0,
          nowMs: T0 + 5000,
          status
        })
      ).toBeNull()
    }
    expect(
      nextDeviatedSince(open, {
        destinationM: 500,
        legIndex: 2,
        nowMs: T0 + 5000,
        status: 'deviated'
      })
    ).toEqual({ atMs: T0 + 5000, destinationM: 500, legIndex: 2 })
  })
  it('keeps an unknown distance as null', () => {
    expect(
      nextDeviatedSince(null, {
        destinationM: undefined,
        legIndex: 0,
        nowMs: T0,
        status: 'deviated'
      })?.destinationM
    ).toBeNull()
  })
})

describe('accessPlanDeadByDeviation', () => {
  const streak = { atMs: T0, destinationM: 831, legIndex: 0 }
  const dead = (
    over: Partial<Parameters<typeof accessPlanDeadByDeviation>[0]>
  ) =>
    accessPlanDeadByDeviation({
      destinationM: 829,
      nowMs: T0 + DEVIATED_PLAN_DEAD_MS,
      riding: false,
      streak,
      ...over
    })

  it('is dead once the window has passed with no closing', () => {
    expect(dead({})).toBe(true)
    // ...including a rider riding AWAY from the destination.
    expect(dead({ destinationM: 900 })).toBe(true)
  })
  it('is not dead inside the window', () => {
    expect(dead({ nowMs: T0 + DEVIATED_PLAN_DEAD_MS - 1 })).toBe(false)
    // The 09-28 17:35:53 attempt, 20 s in.
    expect(dead({ nowMs: T0 + 20_000 })).toBe(false)
  })
  it('is not dead while the rider closes on the destination (2026-09-28)', () => {
    // 17:36:33, +60 s: 831 -> 734 m. 17:36:49, +76 s: ~680 m.
    expect(dead({ destinationM: 734, nowMs: T0 + 60_000 })).toBe(false)
    expect(dead({ destinationM: 680, nowMs: T0 + 76_000 })).toBe(false)
    expect(dead({ destinationM: 831 - DEVIATED_PLAN_MIN_CLOSING_M })).toBe(
      false
    )
    expect(dead({ destinationM: 831 - DEVIATED_PLAN_MIN_CLOSING_M + 1 })).toBe(
      true
    )
  })
  it('is never dead while riding, with no streak, or without distances', () => {
    expect(dead({ riding: true })).toBe(false)
    expect(dead({ streak: null })).toBe(false)
    expect(dead({ destinationM: null })).toBe(false)
    expect(dead({ streak: { ...streak, destinationM: null } })).toBe(false)
  })
})

describe('acceptAutoReplan with currentPlanLeftByRider', () => {
  const bike = (from: [number, number], start: number, end: number) =>
    ({
      endTime: end,
      from: { lat: from[0], lon: from[1], name: 'Current location' },
      mode: 'BICYCLE',
      startTime: start,
      to: { lat: 44.8259, lon: -93.2908 },
      transitLeg: false
    } as any)
  const held = {
    endTime: T0 + 300_000,
    legs: [bike([44.82, -93.3], T0, T0 + 300_000)],
    startTime: T0
  } as any
  const later = {
    endTime: T0 + 700_000,
    legs: [bike([44.82, -93.3], T0, T0 + 700_000)],
    startTime: T0
  } as any

  it('waives only the arrival test', () => {
    expect(acceptAutoReplan(later, held, {})).toEqual({
      accept: false,
      reason: 'arrives-later'
    })
    expect(
      acceptAutoReplan(later, held, { currentPlanLeftByRider: true })
    ).toEqual({ accept: true })
  })

  it('still refuses an access chain that misses its bus', () => {
    const bus = {
      endTime: T0 + 900_000,
      from: { lat: 44.8259, lon: -93.2908, name: 'Stop', stopId: '1:1' },
      mode: 'BUS',
      startTime: T0 + 400_000,
      transitLeg: true,
      tripId: '1:t'
    } as any
    const heldBus = {
      endTime: T0 + 900_000,
      legs: [bike([44.82, -93.3], T0, T0 + 390_000), bus],
      startTime: T0
    } as any
    const late = {
      endTime: T0 + 900_000,
      legs: [bike([44.82, -93.3], T0, T0 + 460_000), bus],
      startTime: T0
    } as any
    expect(
      acceptAutoReplan(late, heldBus, { currentPlanLeftByRider: true })
    ).toEqual({ accept: false, reason: 'access-misses-board' })
  })

  it('still checks the origin', () => {
    expect(
      acceptAutoReplan(later, held, {
        currentPlanLeftByRider: true,
        position: [44.822, -93.3]
      })
    ).toEqual({ accept: false, reason: 'origin-behind-rider' })
  })
})

// ---------------------------------------------------------------------------
// Wiring: the real position tick stamps the streak, the quiet full re-plan
// reads it. A due-east bike-only plan; the rider is 300 m north of it.
// ---------------------------------------------------------------------------

const initial = goMode(undefined, { type: '@@INIT' })
const mockedFetch = fetchOnboardCandidatePlan as jest.Mock

const START: [number, number] = [44.82, -93.33]
const DEST: [number, number] = [44.82, -93.3]
/** ~300 m north of the line, 1.4 km short of the destination's longitude. */
const OFF: [number, number] = [44.8227, -93.318]
/** A rider standing at OFF: n fixes with a metre or two of GPS scatter. */
const standing = (n: number): Array<[number, number]> =>
  Array.from({ length: n }, (_, i) => [
    OFF[0] + (i % 2 ? 0.00001 : -0.00001),
    OFF[1] + (i % 3) * 0.00001
  ])

const plan = (startMs: number, endMs: number, from: [number, number]) => ({
  duration: (endMs - startMs) / 1000,
  endTime: endMs,
  legs: [
    {
      distance: 2400,
      duration: (endMs - startMs) / 1000,
      endTime: endMs,
      from: { lat: from[0], lon: from[1], name: 'Current location' },
      legGeometry: { points: encode([from, DEST]) },
      mode: 'BICYCLE',
      startTime: startMs,
      to: { lat: DEST[0], lon: DEST[1], name: 'Home' },
      transitLeg: false
    }
  ],
  startTime: startMs
})

const fixAt = (
  [lat, lon]: [number, number],
  timestamp: number,
  speed = 0
): GeolocationPosition =>
  ({
    coords: {
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: lat,
      longitude: lon,
      speed
    },
    timestamp
  } as GeolocationPosition)

const makeStore = (heldPlan: any) => {
  let runThunks = false
  let goModeState: any = {
    ...initial,
    activeItinerary: heldPlan,
    isActive: true,
    routeMatch: { legIndex: 0, progressAlongLeg: 0.4 },
    tracking: { ...initial.tracking, lastPosition: fixAt(START, T0) }
  }
  const actions: any[] = []
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') {
      return runThunks ? action(dispatch, getState) : undefined
    }
    actions.push(action)
    goModeState = goMode(goModeState, action)
    return action
  }
  return {
    actions,
    getGoMode: () => goModeState,
    run: (thunk: any) => thunk(dispatch, getState),
    setRunThunks: (on: boolean) => {
      runThunks = on
    }
  }
}

describe('quiet full re-plan wiring (35.2)', () => {
  let clock: FakeTimers.InstalledClock | undefined
  let store: ReturnType<typeof makeStore> | undefined

  beforeEach(() => {
    mockedFetch.mockReset()
    clock = FakeTimers.install({ now: T0, toFake: ['Date'] })
  })
  afterEach(() => {
    store?.setRunThunks(false)
    store?.run(endGoMode())
    store = undefined
    clock?.uninstall()
    clock = undefined
  })

  /** Ticks every 5 s over `track`, then one quiet re-plan answered with a
   * candidate from the last point that arrives `laterBy` after the held plan. */
  const run = async (track: Array<[number, number]>, laterBy = 400_000) => {
    const held = plan(T0, T0 + 600_000, START)
    store = makeStore(held)
    let t = T0
    for (const p of track) {
      t += 5000
      clock?.setSystemTime(t)
      store.run(handlePositionUpdate(fixAt(p, t)))
    }
    const statusAtAsk = store.getGoMode().progress?.status
    const last = track[track.length - 1]
    mockedFetch.mockReturnValue(() =>
      Promise.resolve({
        error: false,
        itineraries: [plan(t, held.endTime + laterBy, last)]
      })
    )
    store.setRunThunks(true)
    await store.run(quietReplanAccessLeg())
    const autoReplans = store.actions.filter((a) => a.type === 'AUTO_REPLAN')
    return {
      autoReplan: autoReplans[autoReplans.length - 1]?.payload,
      status: statusAtAsk,
      swapped: store.getGoMode().activeItinerary !== held
    }
  }

  it('accepts a later plan once the rider has sat off the line for the window', async () => {
    // Stopped 300 m off the plan: ten ticks, 50 s.
    const r = await run(standing(10))
    expect(r.status).toBe('deviated')
    expect(r.autoReplan).toMatchObject({
      accepted: true,
      planLeftByRider: true,
      reason: 'quiet-replan-full'
    })
    expect(r.swapped).toBe(true)
  })

  it('keeps the veto inside the window', async () => {
    const r = await run(standing(4)) // 20 s
    expect(r.status).toBe('deviated')
    expect(r.autoReplan).toMatchObject({
      accepted: false,
      planLeftByRider: false,
      refusedBecause: 'arrives-later'
    })
    expect(r.swapped).toBe(false)
  })

  it('keeps the veto for a rider converging on a parallel street', async () => {
    // 300 m north, heading east at ~5.5 m/s: 0.0007 deg lon = ~55 m per tick.
    const track = Array.from(
      { length: 10 },
      (_, i) => [OFF[0], OFF[1] + i * 0.0007] as [number, number]
    )
    const r = await run(track)
    expect(r.status).toBe('deviated')
    expect(r.autoReplan).toMatchObject({
      accepted: false,
      planLeftByRider: false,
      refusedBecause: 'arrives-later'
    })
    expect(r.swapped).toBe(false)
  })

  it('a streak broken by an on-route tick starts over', async () => {
    const r = await run([...standing(6), START, ...standing(4)])
    expect(r.autoReplan).toMatchObject({
      accepted: false,
      planLeftByRider: false,
      refusedBecause: 'arrives-later'
    })
  })
})
