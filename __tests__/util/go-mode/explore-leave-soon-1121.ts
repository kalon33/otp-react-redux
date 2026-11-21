/* globals describe, expect, it */
import { checkLeaveSoon } from '../../../lib/util/go-mode/notification-service'

/**
 * BACKLOG 76.3 item 5 — "Leave in N min" on a Calm / Wander ride.
 *
 * `checkLeaveSoon` reads `progress.waitTimeAtStop`: departure − now − the
 * access leg's remaining ride time. An OTP bike leg is timed to reach the stop
 * as the bus leaves, so that slack IS the time to leave. An engine ride keeps
 * 3 min + 10 % of the ride at the stop on purpose (rider's decision,
 * 2026-11-21): the real Wander ride to 46th St Station is 1,080 s with a
 * 288 s margin. Measured against the bus alone, "Leave in 2 min" fired at
 * bus − 20:00 — 2m48s after the ride's planned start at bus − 22:48 — and a
 * rider who obeyed it reached the stop as the bus left.
 */
const busLeg: any = {
  from: { name: 'I-35W & 46th St Station' },
  mode: 'BUS',
  routeShortName: 'Orange'
}
const wanderLeg: any = {
  exploreRide: { marginS: 288, mode: 'wander' },
  mode: 'BICYCLE',
  to: { name: 'I-35W & 46th St Station' }
}
const otpLeg: any = { mode: 'BICYCLE', to: { name: 'I-35W & 46th St Station' } }

/** The rider at home, not yet moving: the whole ride is still ahead. */
const atHome = (busInS: number): any => ({
  timeUntilNextDeparture: busInS,
  waitTimeAtStop: busInS - 1080
})

describe('76.3: leave-soon keeps the engine ride’s wait at the stop', () => {
  it('fires 2 min before the PLANNED start, not 2 min before the last moment', () => {
    // Bus in 24:48: planned start in 2:00 (24:48 − 18:00 − 4:48).
    const due = checkLeaveSoon(atHome(1488), wanderLeg, busLeg, [])
    expect(due?.title).toBe('Leave in 2 min')
    // FAILS BEFORE: at bus − 20:00 this said "Leave in 2 min" — the ride
    // should have started 2m48s earlier.
    const late = checkLeaveSoon(atHome(1200), wanderLeg, busLeg, [])
    expect(late).toBeNull()
  })

  it('says "Leave now" at the planned start', () => {
    expect(checkLeaveSoon(atHome(1368), wanderLeg, busLeg, [])?.title).toBe(
      'Leave now'
    )
  })

  it('an OTP leg is measured exactly as before', () => {
    const otp = (busInS: number): any => ({
      timeUntilNextDeparture: busInS,
      waitTimeAtStop: busInS - 540
    })
    expect(checkLeaveSoon(otp(660), otpLeg, busLeg, [])?.title).toBe(
      'Leave in 2 min'
    )
    expect(checkLeaveSoon(otp(900), otpLeg, busLeg, [])).toBeNull()
  })
})
