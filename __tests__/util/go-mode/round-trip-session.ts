import '../../test-utils/mock-window-url'
import {
  clearGoModeSession,
  loadGoModeSession,
  saveGoModeSession
} from '../../../lib/util/go-mode/session-persistence'
import { restoreDateNowBehavior, setTestTime } from '../../test-utils'
import goModeReducer from '../../../lib/reducers/go-mode'
import type { RoundTripPlan } from '../../../lib/util/go-mode/round-trip'

/**
 * A round trip's saved session has to survive the DWELL — the hours the rider
 * spends at the destination, which are the point of the feature.
 *
 * All three staleness windows in session-persistence were written for a one-way
 * trip, where arriving is the end of the story, and every one of them throws a
 * round trip away in the middle of it:
 *
 *  - MAX_SESSION_AGE_MS (3 h since the OUTBOUND started) expires during a
 *    matinee;
 *  - END_TIME_GRACE_MS measured off the OUTBOUND itinerary's endTime expires 45
 *    minutes after the rider walks in the door;
 *  - ARRIVED_RESUME_GRACE_MS is five minutes, and deliberately so — "the only
 *    thing a resumed arrived trip has left to show is the arrival card". On a
 *    round trip what it has left to show is the countdown to the return, so
 *    five minutes is wrong by construction.
 *
 * One window replaces all three: the RETURN departure plus the same 45 minutes
 * of grace the outbound end gets.
 */

const MIN = 60000
const HOUR = 60 * MIN
const START = Date.UTC(2026, 8, 5, 16, 0, 0)

const initial = goModeReducer(undefined, { type: '@@INIT' } as any)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const outbound: any = {
  endTime: START + 30 * MIN,
  legs: [
    {
      endTime: START + 30 * MIN,
      from: { lat: 44.9, lon: -93.3, name: 'Home' },
      mode: 'WALK',
      startTime: START,
      to: { lat: 44.86, lon: -93.29, name: 'The museum' },
      transitLeg: false
    }
  ],
  startTime: START
}

/** Stay four hours; the return leaves at 20:30, four and a half hours in. */
const plan = (leaveByMs: number): RoundTripPlan => ({
  destination: { lat: 44.86, lon: -93.29, name: 'The museum' },
  leaveByMs,
  origin: { lat: 44.9, lon: -93.3, name: 'Home' },
  plannedDepartMs: leaveByMs,
  refreshedAtMs: null,
  returnItinerary: { ...outbound, startTime: leaveByMs },
  stayMinutes: 240
})

const LEAVE_BY = START + 30 * MIN + 4 * HOUR

/**
 * Save the state a rider has at the destination: arrived at the end of the
 * outbound leg, a return plan attached, countdown not yet begun.
 */
const saveArrivedRoundTrip = (roundTrip: RoundTripPlan | null) => {
  clearGoModeSession()
  saveGoModeSession({
    ...initial,
    activeItinerary: outbound,
    arrivedAt: START + 30 * MIN,
    isActive: true,
    returnCountdown: roundTrip
      ? { leaveByMs: roundTrip.leaveByMs, stage: 'far' as const }
      : null,
    roundTrip
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

describe('util > go-mode > a round trip survives the dwell at the destination', () => {
  beforeEach(() => {
    window.localStorage.clear()
    clearGoModeSession()
    setTestTime(START)
  })

  afterEach(() => {
    restoreDateNowBehavior()
    window.localStorage.clear()
  })

  it('saves the plan and the countdown stage with the trip', () => {
    saveArrivedRoundTrip(plan(LEAVE_BY))
    setTestTime(START + HOUR)
    const loaded = loadGoModeSession()
    expect(loaded?.roundTrip?.leaveByMs).toBe(LEAVE_BY)
    expect(loaded?.returnCountdown).toEqual({
      leaveByMs: LEAVE_BY,
      stage: 'far'
    })
  })

  it('resumes three hours after arriving — the 5-minute arrived grace does not apply', () => {
    saveArrivedRoundTrip(plan(LEAVE_BY))
    setTestTime(START + 30 * MIN + 3 * HOUR)
    expect(loadGoModeSession()).not.toBeNull()
  })

  it('resumes past MAX_SESSION_AGE_MS, because the dwell is the point', () => {
    // Four and a half hours since the outbound STARTED: a one-way trip would
    // have been dropped ninety minutes ago.
    saveArrivedRoundTrip(plan(LEAVE_BY))
    setTestTime(START + 4 * HOUR + 30 * MIN)
    expect(loadGoModeSession()).not.toBeNull()
  })

  it("resumes long past the OUTBOUND itinerary's endTime + 45 min", () => {
    saveArrivedRoundTrip(plan(LEAVE_BY))
    // The outbound ended at 16:30; this is 19:00.
    setTestTime(START + 3 * HOUR)
    expect(loadGoModeSession()).not.toBeNull()
  })

  it('still resumes 44 minutes past the return departure', () => {
    saveArrivedRoundTrip(plan(LEAVE_BY))
    setTestTime(LEAVE_BY + 44 * MIN)
    expect(loadGoModeSession()).not.toBeNull()
  })

  it('drops it 46 minutes past the return departure, and clears storage', () => {
    saveArrivedRoundTrip(plan(LEAVE_BY))
    setTestTime(LEAVE_BY + 46 * MIN)
    expect(loadGoModeSession()).toBeNull()
    // Cleared as a side effect, so it cannot linger and be re-read.
    setTestTime(LEAVE_BY)
    expect(loadGoModeSession()).toBeNull()
  })

  it('leaves a ONE-WAY trip on the old windows — the arrived grace still bites', () => {
    saveArrivedRoundTrip(null)
    setTestTime(START + 30 * MIN + 4 * MIN)
    expect(loadGoModeSession()).not.toBeNull()
    saveArrivedRoundTrip(null)
    setTestTime(START + 30 * MIN + 6 * MIN)
    expect(loadGoModeSession()).toBeNull()
  })

  it('ignores a plan with an unusable leaveBy and falls back to the old windows', () => {
    saveArrivedRoundTrip({ ...plan(LEAVE_BY), leaveByMs: NaN })
    setTestTime(START + 30 * MIN + 6 * MIN)
    expect(loadGoModeSession()).toBeNull()
  })
})
