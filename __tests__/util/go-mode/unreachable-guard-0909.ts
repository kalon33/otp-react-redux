import FakeTimers from '@sinonjs/fake-timers'

import {
  DESTINATION_REPLAN_MOTION_MIN_M,
  DESTINATION_STALL_REPLANS,
  destinationStalled,
  noteDestinationDistance,
  noteReplanAttempt
} from '../../../lib/util/go-mode/destination-progress'
import {
  endGoMode,
  handlePositionUpdate,
  quietReplanAccessLeg
} from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import { haversineDistance } from '../../../lib/util/go-mode/geometry'
import fixture from '../../../lib/util/go-mode/replay/fixtures/ride2-orange-0905.json'
import goMode from '../../../lib/reducers/go-mode'
import type { DestinationProgressState } from '../../../lib/util/go-mode/destination-progress'

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
 * 2026-09-09 ride 2, session mtu45mqw-co4i61 — the false give-up.
 *
 * At 09:41:35.053 the app raised DESTINATION_UNREACHABLE 1,670 m from
 * 2345 Old Shakopee Road West, on the grounds that three re-plans had failed to
 * close the gap. All 27 REROUTE_SNAPSHOTs of the ride — including the four
 * issued AFTER the give-up, at 09:41:46, 09:43:07, 09:44:47 and 09:46:09 — came
 * back with itineraries ending at (44.81655, -93.30986), the requested
 * destination, gap 0 m. There was no graph hole. This is not 08-28.
 *
 * What the three "re-plans" actually were, off this fixture's own GPS track:
 *
 *  - 09:39:31 and 09:40:31, while the rider was riding 615 m EAST, away from
 *    home: 306.9 m and 276.1 m of real movement between them. Evidence.
 *  - 09:41:34.878, 37.3 m from where the previous one was asked, with the rider
 *    stopped since 09:40:47 — and its own fetch aborted at 09:41:46.878 on the
 *    12 s Go Mode timeout, 11.8 s after it had already been counted.
 *
 * The counter ran one line after the cooldown admitted the re-plan
 * (actions/go-mode.ts, before the fetch), so a request that never came back was
 * indistinguishable from a plan that came back useless, and a rider standing
 * still was indistinguishable from a rider the graph cannot serve.
 */

const f: any = fixture
const DEST_LEG = f.itinerary.legs[f.itinerary.legs.length - 1]
const DESTINATION: [number, number] = [DEST_LEG.to.lat, DEST_LEG.to.lon]
const TRACK = [...f.gpsTrack].sort((a: any, b: any) => a.tMs - b.tMs)

/** CDT wall clock to epoch ms, the way the ride report quotes it. */
const at = (hhmmss: string): number =>
  Date.parse(`2026-09-09T${hhmmss}Z`) + 5 * 3600000

/** The fix the app was holding at `tMs` — last one recorded at or before it. */
const fixAt = (tMs: number): any => {
  let held = TRACK[0]
  for (const p of TRACK) {
    if (p.tMs > tMs) break
    held = p
  }
  return held
}

const pointAt = (tMs: number): [number, number] => {
  const p = fixAt(tMs)
  return [p.lat, p.lon]
}

const distanceToDestinationAt = (tMs: number): number =>
  haversineDistance(pointAt(tMs), DESTINATION)

/** The moments the three quiet re-plans went out (debug log, ride report). */
const REPLAN_1 = at('09:39:31')
const REPLAN_2 = at('09:40:31')
const REPLAN_3 = at('09:41:34.878')
/** The rider's last movement, and the moment they stopped the trip by hand. */
const STOPPED_MOVING = at('09:40:47')
const TRIP_STOPPED = at('09:46:38')

describe('the destination that was reachable all along (2026-09-09)', () => {
  it('is the ride the fixture recorded', () => {
    expect(f.meta.session).toBe('mtu45mqw-co4i61')
    expect(DEST_LEG.to.name).toContain('2345 Old Shakopee Road West')
    // Every reroute snapshot of the ride reaches the door. The app's give-up
    // was about the graph; the graph was never the problem.
    expect(f.rerouteSnapshots).toHaveLength(27)
    const gaps = f.rerouteSnapshots.map((s: any) => {
      const its = s.response?.data?.plan?.itineraries || []
      return Math.min(
        ...its.map((it: any) => {
          const last = it.legs[it.legs.length - 1]
          return haversineDistance([last.to.lat, last.to.lon], DESTINATION)
        })
      )
    })
    expect(Math.max(...gaps)).toBeLessThan(1)
  })

  it('had a rider who stopped, not a destination that moved', () => {
    // 615 m east between 09:38:09 and 09:40:47, then nothing.
    expect(
      haversineDistance(pointAt(REPLAN_1), pointAt(REPLAN_2))
    ).toBeGreaterThan(DESTINATION_REPLAN_MOTION_MIN_M)
    expect(
      haversineDistance(pointAt(REPLAN_2), pointAt(REPLAN_3))
    ).toBeLessThan(DESTINATION_REPLAN_MOTION_MIN_M)
    // ...and still nothing, for the five minutes of trip that were left.
    expect(
      haversineDistance(pointAt(STOPPED_MOVING), pointAt(TRIP_STOPPED))
    ).toBeLessThan(DESTINATION_REPLAN_MOTION_MIN_M)
  })

  describe('the arithmetic, over the ride as it was recorded', () => {
    /** Fold every fix from `fromMs` to the end of the ride in, re-planning at
     * the moments the app re-planned, with the outcomes it actually got. */
    const replay = (
      replans: Array<{ atMs: number; returned: boolean }>,
      opts: { motion: boolean } = { motion: true }
    ): DestinationProgressState | null => {
      let state: DestinationProgressState | null = null
      const pending = [...replans]
      for (const p of TRACK) {
        state = noteDestinationDistance(
          state,
          haversineDistance([p.lat, p.lon], DESTINATION)
        )
        while (pending.length && pending[0].atMs <= p.tMs) {
          const replan = pending.shift()
          if (!replan) break
          state = noteReplanAttempt(state, 'BICYCLE', {
            point: opts.motion ? pointAt(replan.atMs) : null,
            returned: replan.returned
          })
        }
      }
      return state
    }

    const RIDE_AS_IT_HAPPENED = [
      { atMs: REPLAN_1, returned: true },
      { atMs: REPLAN_2, returned: true },
      // Aborted 09:41:46.878, 12 s after it was issued. Nothing came back.
      { atMs: REPLAN_3, returned: false }
    ]

    it('reproduces the give-up when re-plans are counted on issue', () => {
      // The pre-fix count: every admitted re-plan, no position, no outcome.
      // This is the bug, and the fixture holds its shape.
      const stalled = replay(RIDE_AS_IT_HAPPENED, { motion: false }) as any
      const legacy = RIDE_AS_IT_HAPPENED.reduce(
        (s: DestinationProgressState | null) => noteReplanAttempt(s, 'BICYCLE'),
        noteDestinationDistance(null, distanceToDestinationAt(REPLAN_1))
      )
      expect(legacy?.replansSinceGain).toBe(DESTINATION_STALL_REPLANS)
      expect(destinationStalled(legacy, 'BICYCLE')).toBe(true)
      // Without the motion term, only the timeout rule is holding the line.
      expect(stalled.replansSinceGain).toBe(2)
    })

    it('does not retire the mode on this ride', () => {
      const state = replay(RIDE_AS_IT_HAPPENED)
      expect(destinationStalled(state, 'BICYCLE')).toBe(false)
      expect(state?.replansSinceGain).toBe(2)
      // The closest the rider ever came, to 0.1 m (client and daemon agreed to
      // 13 decimal places on 1670.2396900513465).
      expect(state?.bestDistanceM).toBeCloseTo(1670.0, 0)
    })

    it('still would not retire it had the third re-plan answered', () => {
      // Even with a plan in hand at 09:41:34, the rider had been 37 m from
      // where the last one was asked. One question from one doorstep is one
      // piece of evidence, however many times it is asked.
      const state = replay([
        { atMs: REPLAN_1, returned: true },
        { atMs: REPLAN_2, returned: true },
        { atMs: REPLAN_3, returned: true }
      ])
      expect(destinationStalled(state, 'BICYCLE')).toBe(false)
    })

    it('keeps counting for a rider who is going somewhere', () => {
      // The same three moments for a rider who kept riding: the guard is not
      // disarmed, it is told what an attempt is worth. 08-28's rider moved
      // hundreds of metres between re-plans (8889 m -> 8106 m -> 670 m of bike
      // leg) and would be retired here exactly as they are today.
      const moving = [
        { atMs: REPLAN_1, returned: true },
        { atMs: REPLAN_2, returned: true },
        { atMs: at('09:38:09'), returned: true }
      ]
      let state = noteDestinationDistance(
        null,
        distanceToDestinationAt(REPLAN_1)
      )
      for (const r of moving) {
        state = noteReplanAttempt(state, 'BICYCLE', {
          point: pointAt(r.atMs),
          returned: r.returned
        })
      }
      expect(destinationStalled(state, 'BICYCLE')).toBe(true)
    })
  })

  describe('through the tick, with the fetches the ride got', () => {
    const initial = goMode(undefined, { type: '@@INIT' })
    const mockedFetch = fetchOnboardCandidatePlan as jest.Mock

    const positionAt = (tMs: number): GeolocationPosition => {
      const p = fixAt(tMs)
      return {
        coords: {
          accuracy: p.accuracy ?? 10,
          altitude: null,
          altitudeAccuracy: null,
          heading: p.heading ?? null,
          latitude: p.lat,
          longitude: p.lon,
          speed: p.speed ?? null
        },
        timestamp: tMs
      } as GeolocationPosition
    }

    const makeStore = () => {
      let runThunks = false
      let goModeState: any = {
        ...initial,
        activeItinerary: f.itinerary,
        isActive: true,
        // The last leg: the rider is off the bus and riding home.
        routeMatch: { legIndex: 2, progressAlongLeg: 0 },
        tracking: {
          ...initial.tracking,
          lastPosition: positionAt(at('09:36:39'))
        }
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
        run: (thunk: any) => thunk(dispatch, getState),
        setRunThunks: (on: boolean) => {
          runThunks = on
        }
      }
    }

    let dateFaker: FakeTimers.InstalledClock | undefined
    let store: ReturnType<typeof makeStore> | undefined

    /** One real fix, then the re-plan the tick would have admitted. */
    const tickAndReplan = async (tMs: number) => {
      dateFaker?.setSystemTime(tMs)
      store?.setRunThunks(false)
      store?.run(handlePositionUpdate(positionAt(tMs)))
      store?.setRunThunks(true)
      await store?.run(quietReplanAccessLeg())
    }

    const unreachableNotifications = () =>
      (store?.actions || []).filter(
        (a: any) =>
          a.type === 'ADD_NOTIFICATION' &&
          a.payload?.type === 'DESTINATION_UNREACHABLE'
      )

    beforeEach(() => {
      mockedFetch.mockReset()
      dateFaker = FakeTimers.install({ now: at('09:36:39'), toFake: ['Date'] })
      store = makeStore()
    })
    afterEach(() => {
      store?.setRunThunks(false)
      store?.run(endGoMode())
      store = undefined
      dateFaker?.uninstall()
      dateFaker = undefined
    })

    it('never tells this rider that routing stops here', async () => {
      // Empty answers, except the third — which is the one that timed out.
      // Nothing here fabricates an itinerary; the ride's own re-plans produced
      // no swap either (the fixture holds 0 onboardCandidatePlans).
      const outcomes = [
        { error: false, itineraries: [] },
        { error: false, itineraries: [] },
        { error: true, itineraries: [] }
      ]
      mockedFetch.mockImplementation(
        () => () =>
          Promise.resolve(outcomes.shift() || { error: false, itineraries: [] })
      )

      await tickAndReplan(REPLAN_1)
      await tickAndReplan(REPLAN_2)
      await tickAndReplan(REPLAN_3)
      expect(mockedFetch).toHaveBeenCalledTimes(3)
      // 09:41:35.053: 175 ms after the third re-plan, the tick that fired it.
      await tickAndReplan(at('09:41:35.053'))
      expect(unreachableNotifications()).toHaveLength(0)

      // ...and not for the rest of the trip, standing in the same place, with
      // the burst window letting another re-plan through at ~09:44:31.
      for (const t of ['09:42:34', '09:43:34', '09:44:47', '09:46:09']) {
        await tickAndReplan(at(t))
      }
      expect(unreachableNotifications()).toHaveLength(0)
    })

    it('keeps the quiet re-planning it never had reason to retire', async () => {
      mockedFetch.mockReturnValue(() =>
        Promise.resolve({ error: false, itineraries: [] })
      )
      await tickAndReplan(REPLAN_1)
      await tickAndReplan(REPLAN_2)
      await tickAndReplan(REPLAN_3)
      const beforeBurst = mockedFetch.mock.calls.length
      expect(beforeBurst).toBe(3)
      // Past the 5-minute burst window: still re-planning, still quiet.
      await tickAndReplan(at('09:44:47'))
      expect(mockedFetch.mock.calls.length).toBeGreaterThan(beforeBurst)
      expect(unreachableNotifications()).toHaveLength(0)
    })
  })
})
