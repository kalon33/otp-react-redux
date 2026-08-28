import { checkUpcomingTurn } from '../../../lib/util/go-mode/notification-service'
import { endGoMode } from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'
import type { Leg } from '@opentripplanner/types'
import type { TripProgress } from '../../../lib/util/go-mode/progress-calculator'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * The turn-announcement latch is keyed on the leg OBJECT (a WeakMap in
 * notification-service), and it is deliberately permanent for the life of that
 * object — the 7/31 fix that stopped the same "Turn right on Village Lane"
 * being pushed 14 times in 7 minutes.
 *
 * Its lifetime assumption is that a new trip means new leg objects. That holds
 * for a fresh plan, but NOT for the retry path: GoModeScreen's handleRetry
 * calls endGoMode() and then beginGoMode(goMode.activeItinerary) with the very
 * same object, and normalizeGoModeItinerary returns its input by reference when
 * nothing merges. Same legs, same WeakMap entries — so every cue already
 * announced stays latched and the rider is told nothing for the rest of the leg.
 *
 * notification-service exports resetTurnAnnouncements() for exactly this, and
 * before this test nothing called it. endGoMode is where it belongs: the trip
 * is over, so the next one starts clean. It must NOT be called from beginGoMode
 * — a quiet access replan re-enters there mid-trip with the transit legs
 * deliberately object-identical, and re-arming the latch there is the 7/31
 * storm again.
 */
describe('util > go-mode > turn latch survives its trip', () => {
  const leg = {
    endTime: 1_769_616_600_000,
    mode: 'BICYCLE',
    startTime: 1_769_616_000_000
  } as unknown as Leg

  // 53 m out at 4 m/s: inside the 120 m prepare lead, outside the 32 m act
  // lead. The 7/31 rider's own numbers.
  const progress = {
    distanceToNextTurn: 53,
    nextTurnCue: {
      index: 0,
      instruction: 'Turn right on Village Lane',
      significant: true
    },
    riderSpeedMps: 4
  } as unknown as TripProgress

  const makeStore = () => {
    let state: any = {
      ...goMode(undefined, { type: '@@INIT' }),
      activeItinerary: { legs: [leg] },
      isActive: true
    }
    const getState = () => ({
      otp: {
        config: { homeTimezone: 'America/Chicago' },
        currentQuery: {},
        goMode: state
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      state = goMode(state, action)
      return action
    }
    return { dispatch }
  }

  it('announces once per turn, then again after the trip ends', () => {
    const first = checkUpcomingTurn(progress, leg, [])
    expect(first).not.toBeNull()
    expect(first?.title).toBe('Turn right on Village Lane')

    // The latch: the same cue on the same leg says nothing more. This is the
    // 7/31 fix and must keep holding.
    expect(checkUpcomingTurn(progress, leg, [])).toBeNull()
    expect(checkUpcomingTurn(progress, leg, [])).toBeNull()

    // The trip ends — a retry, an exit, anything that tears Go Mode down.
    const store = makeStore()
    store.dispatch(endGoMode())

    // A new trip on the SAME leg object must be able to speak again.
    const afterRestart = checkUpcomingTurn(progress, leg, [])
    expect(afterRestart).not.toBeNull()
    expect(afterRestart?.title).toBe('Turn right on Village Lane')
  })
})
