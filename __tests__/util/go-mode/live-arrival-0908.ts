import type { Itinerary } from '@opentripplanner/types'

import { liveArrivalMs } from '../../../lib/util/go-mode/live-itinerary'

/**
 * 12.8, second half. Session mtsvo7ss-4nzccy, 2026-09-08.
 *
 * The return banner said "Arrive 11:50 AM" on every tick from 11:29 while the
 * trip sheet said 11:57 and the rider actually arrived at 11:58:08
 * (SET_ARRIVED 1788886688060). The banner read `progress.estimatedArrival`,
 * which is `now + timeRemaining`, and timeRemaining is anchored on
 * `liveTripEndMs` (progress-calculator.ts):
 *
 *     liveAlightMs + Σ (leg.duration) for the legs after the current one
 *
 * A duration sum carries no WAIT. The Orange Line's live alight was 11:41:09,
 * the walk plus the 546 ride are 532 s of moving time, and 11:41:09 + 532 s is
 * exactly the 11:50:01 recorded on all 2118 UPDATE_PROGRESS ticks — the eight
 * minutes standing at the stop for the 546 (boarded 11:51:20) had been spent
 * twice over. buildLiveItinerary anchors each access leg to the transit leg
 * before it instead of summing, so it keeps the gap; liveArrivalMs is the end
 * of its last leg, i.e. the figure the sheet already prints.
 */
const BASE = 1788884400000
const MIN = 60000

/** Bus → walk → 8-minute wait → bus, with the first bus running a minute late. */
const itinerary = {
  duration: 37 * 60,
  endTime: BASE + 37 * MIN,
  legs: [
    {
      duration: 20 * 60,
      endTime: BASE + 20 * MIN,
      mode: 'BUS',
      startTime: BASE,
      transitLeg: true
    },
    {
      duration: 2 * 60,
      endTime: BASE + 22 * MIN,
      mode: 'WALK',
      startTime: BASE + 20 * MIN
    },
    {
      duration: 7 * 60,
      endTime: BASE + 37 * MIN,
      mode: 'BUS',
      startTime: BASE + 30 * MIN,
      transitLeg: true
    }
  ],
  startTime: BASE
} as unknown as Itinerary

const liveLegTimes = {
  0: {
    alightEpoch: BASE + 21 * MIN,
    alightRealtime: true,
    realtime: true
  }
}

describe('util > go-mode > liveArrivalMs', () => {
  it('keeps the transfer wait the timeRemaining duration-sum spends', () => {
    // What progress-calculator's liveTripEndMs computes: live alight plus the
    // MOVING time of the legs after it. Seven minutes early, because the wait
    // for the second bus is nowhere in the sum.
    const durationSum =
      (liveLegTimes[0].alightEpoch as number) + (2 * 60 + 7 * 60) * 1000
    expect(durationSum).toBe(BASE + 30 * MIN)

    // FAILS BEFORE: the banner rendered the line above.
    expect(liveArrivalMs(itinerary, liveLegTimes)).toBe(BASE + 37 * MIN)
  })

  it('carries a late first bus into the arrival when the tail is contiguous', () => {
    // Same trip with no transfer: walk straight off the bus to the door. The
    // minute of lateness must move the arrival, which is what anchoring does.
    const contiguous = {
      ...itinerary,
      legs: [itinerary.legs[0], itinerary.legs[1]]
    } as unknown as Itinerary
    expect(liveArrivalMs(contiguous, liveLegTimes)).toBe(BASE + 23 * MIN)
  })

  it('falls back to the plan when there are no live times', () => {
    expect(liveArrivalMs(itinerary, {})).toBe(BASE + 37 * MIN)
  })

  it('returns null when there is nothing to measure', () => {
    expect(liveArrivalMs(null, {})).toBeNull()
    expect(liveArrivalMs({ legs: [] } as unknown as Itinerary, {})).toBeNull()
  })
})
