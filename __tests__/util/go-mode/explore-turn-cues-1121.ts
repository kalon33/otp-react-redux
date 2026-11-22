/* globals describe, expect, it */
import {
  buildStepIndex,
  getNextCue,
  phraseInstruction
} from '../../../lib/util/go-mode/turn-by-turn'
import { exploreAccessItinerary } from '../../../lib/util/bike-explore'

/**
 * BACKLOG 76.3 item 4 — turn cues on a bike leg the RunScout engine planned.
 *
 * Both answers are REAL: POST /api/bike/access on the live engine (runscout
 * `feat/bike-explore` a09f5af, 127.0.0.1:8787), 2026-11-21, from Lynnhurst
 * (44.9145, -93.299) to I-35W & 46th St Station (44.919409, -93.274746),
 * bus in 1500 s, 5 m/s. Calm: 549 s / 2,485 m, 18 steps. Wander: 1,080 s /
 * 5,171 m via Minnehaha Creek Park, 18 steps, including an out-and-back on
 * East Minnehaha Parkway (`LEFT` 108 m, `UTURN_LEFT` stayOn 108 m, back).
 *
 * The engine's steps carry every field Go Mode's cue builder reads
 * (relativeDirection, streetName, distance, lat, lon, stayOn) plus two the
 * app's own OTP query does not ask for (`bogusName`, `walkingBike`); OTP's
 * carry `alerts` and `elevationProfile`, which nothing in Go Mode reads.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fx = require('../../test-utils/mock-data/bike-explore-gomode-46th.json')

const NOW = 1_795_000_000_000
const legOf = (mode: 'calm' | 'wander'): any => {
  const result = fx[mode].candidates[0]
  const itinerary = exploreAccessItinerary({
    busEpoch: null,
    from: { lat: 44.9145, lon: -93.299, name: 'Current location' },
    mode,
    result,
    startMs: NOW,
    to: { lat: 44.919409, lon: -93.274746, name: '46th St Station' }
  })
  return itinerary?.legs[0]
}

describe('76.3: turn cues on an engine-planned bike leg', () => {
  it('the leg Go Mode installs keeps the engine steps and geometry', () => {
    const leg = legOf('calm')
    expect(leg.steps).toHaveLength(18)
    expect(leg.legGeometry.points).toBe(
      fx.calm.candidates[0].leg.legGeometry.points
    )
    expect(leg.startTime).toBe(NOW)
    expect(leg.endTime).toBe(NOW + 549_000)
  })

  it('Calm: every turn projects in ride order, and the names read', () => {
    const cues = buildStepIndex(legOf('calm'))
    const offsets = cues.map((c) => Math.round(c.offsetMeters))
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
    expect(cues.map((c) => c.instruction)).toEqual([
      // LEFT footpath 37 m (walking the bike) — bogusName drops "footpath";
      // the 5 m bike-path jog before it and the 7 m parkway crossing after it
      // are folded as connectors (MICRO_STEP_METERS).
      'Turn left',
      'Turn right on West 49th Street',
      'Turn left on Pleasant Avenue',
      'Bear right on Rustic Lodge Avenue West',
      'Bear left on Wentworth Avenue South',
      'Turn right on West 48th Street',
      'Turn left on 1st Avenue South',
      'Turn right on East 47th Street',
      // LEFT service road 202 m, bogusName.
      'Turn left',
      'Turn right on East 46th Street',
      // The last footpath into the station, walking the bike.
      'Turn left'
    ])
    // The last turn ends at the station: within the leg's own length.
    const last = cues[cues.length - 1]
    expect(last.offsetMeters).toBeLessThan(2530)
    expect(last.offsetMeters).toBeGreaterThan(2400)
  })

  it('Wander: the turn back onto the trail after the out-and-back is announced', () => {
    // FAILS BEFORE: each step was projected onto the nearest segment of the
    // WHOLE leg, so `LEFT Minnehaha Parkway Regional Trail`, ridden after
    // the out-and-back, landed on the outbound pass: offset 3575 m, behind
    // the 3591 m turn before it, and getNextCue skipped it.
    const leg = legOf('wander')
    const cues = buildStepIndex(leg)
    const offsets = cues.map((c) => Math.round(c.offsetMeters))
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
    const parkway = cues.findIndex(
      (c) => c.instruction === 'Turn left on East Minnehaha Parkway'
    )
    const trail = cues.findIndex(
      (c) => c.instruction === 'Turn left on Minnehaha Parkway Regional Trail'
    )
    expect(parkway).toBeGreaterThan(-1)
    expect(trail).toBe(parkway + 1)
    // ~230 m on: out 108 m + Portland 16 m, back 108 m.
    expect(
      cues[trail].offsetMeters - cues[parkway].offsetMeters
    ).toBeGreaterThan(200)

    // Just past the parkway turn, the trail turn is the one coming up.
    const legLength = 5219
    const justPast = (cues[parkway].offsetMeters + 20) / legLength
    expect(getNextCue(leg, justPast).cue?.instruction).toBe(
      'Turn left on Minnehaha Parkway Regional Trail'
    )
  })

  it('phrases an engine step the way it phrases an OTP one', () => {
    const steps = fx.wander.candidates[0].leg.steps
    expect(phraseInstruction(steps[2])).toBe(
      'Continue on Minnehaha Parkway Regional Trail'
    )
    // bogusName: the engine's "bike path" is not a name to steer by.
    expect(phraseInstruction(steps[1])).toBe('Turn right')
    expect(phraseInstruction(steps[6])).toBe('U-turn on East Minnehaha Parkway')
  })
})
