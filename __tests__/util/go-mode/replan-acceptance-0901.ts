import path from 'path'

import {
  acceptAutoReplan,
  AUTO_REPLAN_ARRIVAL_SLACK_MS,
  AUTO_REPLAN_ORIGIN_MAX_M
} from '../../../lib/util/go-mode/replan-acceptance'

/**
 * Ride 3 of 2026-09-01 (`mtin0l9c-yieexg`, 10:48 local): the closing bike leg
 * took three automatic itinerary replacements in 83 seconds, the remaining trip
 * getting longer each time while the rider closed on home. Backlog 6.12, with
 * 6.2's "route match not rebuilt on swap" symptom as its second half.
 *
 * The fixture is the record of that ride, so the expectations below are the
 * ride's own numbers rather than invented ones.
 */
const FIXTURE = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/ride-1048-orange-bike.json'
)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fixture = require(FIXTURE)

/** The rider's last recorded fix at or before `tMs`. */
function positionAt(tMs: number): [number, number] {
  let best = fixture.gpsTrack[0]
  for (const fix of fixture.gpsTrack) {
    if (fix.tMs > tMs) break
    best = fix
  }
  return [best.lat, best.lon]
}

const swaps = fixture.itinerarySwaps
const iso = (ms: number) => new Date(ms).toISOString().slice(11, 19)

describe('the 2026-09-01 ride 3 swap cascade', () => {
  it('is the cascade the backlog describes: three swaps in 83s, arrival sliding out', () => {
    expect(swaps).toHaveLength(3)
    expect(swaps.map((s: any) => iso(s.tMs))).toEqual([
      '16:08:09',
      '16:09:02',
      '16:09:32'
    ])
    expect(swaps.map((s: any) => s.itinerary.duration)).toEqual([213, 244, 371])
    // Every one of them collapsed the plan to a single bike leg.
    for (const swap of swaps) {
      expect(swap.itinerary.legs.map((l: any) => l.mode)).toEqual(['BICYCLE'])
    }
  })

  it('accepts the first swap: it arrives EARLIER than the plan in hand', () => {
    // 16:11:33 against the original plan's 16:12:57.
    expect(iso(fixture.itinerary.endTime)).toBe('16:12:57')
    expect(iso(swaps[0].itinerary.endTime)).toBe('16:11:33')
    expect(
      acceptAutoReplan(swaps[0].itinerary, fixture.itinerary, {
        position: positionAt(swaps[0].tMs)
      })
    ).toEqual({ accept: true })
  })

  it('refuses the second swap: its plan starts 91m behind the rider', () => {
    // Planned from the fix of 16:08:49 and applied at 16:09:02, by which time
    // the rider had ridden 91 m past its first leg's start at 7.7 m/s. The
    // projection then pinned to the start of a polyline the rider was never on
    // — progressAlongLeg 0.0000, segmentIndex 0, distanceFromRoute climbing
    // 91 -> 335 m — which is the whole of 6.2's symptom.
    const verdict = acceptAutoReplan(swaps[1].itinerary, swaps[0].itinerary, {
      position: positionAt(swaps[1].tMs)
    })
    expect(verdict).toEqual({ accept: false, reason: 'origin-behind-rider' })
  })

  it('refuses the third swap: it arrives 3m38s later than the plan in hand', () => {
    // 16:15:11 against the 16:11:33 the rider already had.
    expect(iso(swaps[2].itinerary.endTime)).toBe('16:15:11')
    const verdict = acceptAutoReplan(swaps[2].itinerary, swaps[0].itinerary, {
      position: positionAt(swaps[2].tMs)
    })
    expect(verdict).toEqual({ accept: false, reason: 'arrives-later' })
  })

  it('still refuses the third swap if the second one had been allowed through', () => {
    // The gate must not depend on the earlier refusal having happened.
    expect(
      acceptAutoReplan(swaps[2].itinerary, swaps[1].itinerary, {
        position: positionAt(swaps[2].tMs)
      })
    ).toEqual({ accept: false, reason: 'arrives-later' })
  })
})

describe('acceptAutoReplan', () => {
  const bikeLeg = (from: any) => ({ from, mode: 'BICYCLE' })
  const busLeg = (from: any) => ({ from, mode: 'BUS', transitLeg: true })
  const plan = (endTime: number, legs: any[]) => ({ endTime, legs })
  const here = { lat: 44.816, lon: -93.305 }
  const at = (m: number) => ({ lat: 44.816 + m / 111320, lon: -93.305 })
  const pos: [number, number] = [here.lat, here.lon]

  it('allows an arrival inside the slack', () => {
    const current = plan(1000000, [bikeLeg(here)])
    const candidate = plan(1000000 + AUTO_REPLAN_ARRIVAL_SLACK_MS, [
      bikeLeg(here)
    ])
    expect(acceptAutoReplan(candidate, current, { position: pos })).toEqual({
      accept: true
    })
  })

  it('refuses an arrival one second past the slack', () => {
    const current = plan(1000000, [bikeLeg(here)])
    const candidate = plan(1000000 + AUTO_REPLAN_ARRIVAL_SLACK_MS + 1000, [
      bikeLeg(here)
    ])
    expect(acceptAutoReplan(candidate, current, { position: pos })).toEqual({
      accept: false,
      reason: 'arrives-later'
    })
  })

  it('does not defend the arrival of a plan that is already dead', () => {
    const current = plan(1000000, [bikeLeg(here)])
    const candidate = plan(1000000 + 600000, [bikeLeg(here)])
    expect(
      acceptAutoReplan(candidate, current, {
        currentPlanIsDead: true,
        position: pos
      })
    ).toEqual({ accept: true })
  })

  it('allows an access origin inside the radius', () => {
    const current = plan(1000000, [bikeLeg(here)])
    const candidate = plan(900000, [bikeLeg(at(AUTO_REPLAN_ORIGIN_MAX_M - 10))])
    expect(acceptAutoReplan(candidate, current, { position: pos })).toEqual({
      accept: true
    })
  })

  it('refuses an access origin outside the radius', () => {
    const current = plan(1000000, [bikeLeg(here)])
    const candidate = plan(900000, [bikeLeg(at(AUTO_REPLAN_ORIGIN_MAX_M + 25))])
    expect(acceptAutoReplan(candidate, current, { position: pos })).toEqual({
      accept: false,
      reason: 'origin-behind-rider'
    })
  })

  it('never applies the origin check to a plan that starts on the boarded bus', () => {
    // buildOnboardItinerary's first leg IS the ridden vehicle, whose `from` is
    // the stop it was boarded at — kilometres behind by design.
    const current = plan(1000000, [busLeg(here)])
    const candidate = plan(900000, [busLeg(at(4000))])
    expect(
      acceptAutoReplan(candidate, current, { position: pos, riding: true })
    ).toEqual({ accept: true })
  })

  it('fails open when there is no arrival, and no position, to compare', () => {
    const current = plan(1000000, [bikeLeg(here)])
    // No plan in hand: nothing to be worse than. The origin check still runs,
    // so this candidate starts where the rider is.
    expect(
      acceptAutoReplan(plan(9999999, [bikeLeg(here)]), null, { position: pos })
    ).toEqual({ accept: true })
    // No fix: nothing to measure the origin against.
    expect(
      acceptAutoReplan(plan(900000, [bikeLeg(at(5000))]), current, {
        position: null
      })
    ).toEqual({ accept: true })
  })
})
