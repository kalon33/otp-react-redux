/* globals describe, expect, it */
import fs from 'fs'
import path from 'path'

import {
  AUTO_OFF,
  decideAboardAutoSwitch
} from '../../../lib/util/go-mode/auto-switch'
import {
  AUTO_PRESETS,
  rankAlightForPreset
} from '../../../lib/util/go-mode/auto-priority'
import { legTripId } from '../../../lib/util/go-mode/leg-merge'
import {
  plannedOnwardOf,
  routeSetOf
} from '../../../lib/util/go-mode/faster-route'
import type {
  AutoPending,
  AutoState
} from '../../../lib/util/go-mode/auto-switch'
import type { AutoPreset } from '../../../lib/util/go-mode/auto-priority'

/**
 * Backlog 65.2, cycle 36 B2 — Auto aboard on two recorded rides.
 *
 * ride-1020-0907 09:20–09:26 (`slices/ride-1020-0907-auto-slice.json`, cut
 * from the 62 MB ride fixture: the plan held at 09:20 and the two aboard
 * checks on the 94, 09:22:06 and 09:25:08). On the day the rider tapped Switch
 * at 09:24:26 onto the Gold Line from 5th St & Cedar (10:11:58), and the 14:40
 * triage found that offer priced right (67.1). Each preset runs B2's real
 * aboard rule (decideAboardAutoSwitch) over both checks in order.
 *
 * ride-1019-0844 (`ride-1019-0844-aboard-offer.json`): the aboard check whose
 * phantom 16.8-min offer 56.1 removed — no preset may switch on it.
 */

const FIXTURES = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)
const load = (file: string): any =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'))
const hm = (ms: number | null | undefined): string =>
  ms == null
    ? '—'
    : new Date(ms).toLocaleTimeString('en-GB', {
        hour12: false,
        timeZone: 'America/Chicago'
      })

/** The optimizer answers, one batch per aboard check (≤ 30 s apart). */
function batches(fx: any): { results: any[]; t: number }[] {
  const ocp = [...(fx.onboardCandidatePlans || [])].sort(
    (a: any, b: any) => a.tMs - b.tMs
  )
  const out: any[][] = []
  for (const r of ocp) {
    const last = out[out.length - 1]
    if (last && r.tMs - last[last.length - 1].tMs <= 30000) last.push(r)
    else out.push([r])
  }
  return out.map((b) => ({
    results: b.map((r: any) => ({
      busArrivalEpoch: r.request?.busArrivalEpoch,
      itineraries: r.response?.data?.plan?.itineraries || [],
      realtime: true,
      stopId: r.stopId,
      stopName: r.request?.from?.name || r.stopId
    })),
    t: b[0].tMs
  }))
}

function inputFor(held: any, results: any[], t: number) {
  const ids = new Set(results.map((r) => r.stopId))
  const i = held.legs.findIndex(
    (l: any) => l.transitLeg && ids.has(l.to?.stop?.gtfsId)
  )
  const onward = held.legs.slice(i + 1).find((l: any) => l.transitLeg)
  return {
    nowMs: t,
    plannedOnward: plannedOnwardOf(held, i, null),
    plannedOnwardTripId: onward ? legTripId(onward) : null,
    plannedStopId: held.legs[i].to.stop.gtfsId,
    results
  }
}

/** Every check in order under B2's aboard rule; the first switch, if any. */
function run(fx: any, held: any, preset: AutoPreset) {
  let auto: AutoState = { ...AUTO_OFF, on: true, preset }
  let pending: AutoPending | null = null
  const log: string[] = []
  let first: {
    arrival: number
    route: string
    stop: string
    t: number
  } | null = null
  for (const { results, t } of batches(fx)) {
    const v = rankAlightForPreset(inputFor(held, results, t), preset)
    const d = decideAboardAutoSwitch(v, auto, pending)
    pending = d.pending
    log.push(
      `${hm(t)} ${d.why}` +
        (d.pick
          ? ` ${d.pick.option.stopName} [${
              routeSetOf(d.pick.option.itinerary) || 'bike'
            }] arr=${hm(d.pick.arrival)} saving=${(
              d.pick.savingMs / 60000
            ).toFixed(1)}m bike-${Math.round(d.pick.bikeSavedM)}m`
          : '')
    )
    if (d.why === 'switch' && d.pick && !first) {
      first = {
        arrival: d.pick.arrival,
        route: routeSetOf(d.pick.option.itinerary),
        stop: d.pick.option.stopName,
        t
      }
      auto = { ...auto, switches: auto.switches + 1 }
    }
  }
  return { first, log }
}

const slice = 'slices/ride-1020-0907-auto-slice.json'
const withSlice = fs.existsSync(path.join(FIXTURES, slice))
  ? describe
  : describe.skip

withSlice('65.2 B2 Auto aboard — ride 2026-10-20 09:20–09:26 on the 94', () => {
  const fx = load(slice)
  const held = fx.itinerary
  const results = Object.fromEntries(
    AUTO_PRESETS.map((p) => [p, run(fx, held, p)])
  )
  // eslint-disable-next-line no-console
  console.log(
    AUTO_PRESETS.map((p) => `[1020 ${p}] ${results[p].log.join(' | ')}`).join(
      '\n'
    )
  )

  it('the held plan is the 94 to Union Depot & Wacouta, then the bike (10:10:25 planned)', () => {
    expect(hm(held.endTime)).toBe('10:10:25')
    expect(batches(fx).map((b) => hm(b.t))).toEqual(['09:22:06', '09:25:08'])
  })

  it('Fastest takes the Gold Line from 5th St & Cedar at 09:22:06 — the 10:11:58 plan the rider tapped', () => {
    expect(results.fastest.first).toEqual({
      arrival: expect.any(Number),
      route: '1:905',
      stop: '5th St & Cedar Station',
      t: batches(fx)[0].t
    })
    expect(hm(results.fastest.first!.arrival)).toBe('10:11:58')
  })

  it('Least biking takes its own rule’s pick: the 74 from Rice Park, the fewest bike metres', () => {
    // Not the Gold Line: the 74 bikes 7.9 km less than the bar (the Gold 6.4
    // km) for 0.7 min later, inside the 2-min allowance, and Least biking
    // ranks fewest bike metres first.
    expect(results.leastBike.first).toMatchObject({
      route: '1:74',
      stop: 'Rice Park Station',
      t: batches(fx)[0].t
    })
    expect(hm(results.leastBike.first!.arrival)).toBe('10:16:39')
  })

  it('Simplest and Stay on my route do not switch', () => {
    expect(results.simplest.first).toBeNull()
    expect(results.stayOnRoute.first).toBeNull()
  })
})

const offer1019 = 'ride-1019-0844-aboard-offer.json'
const with1019 = fs.existsSync(path.join(FIXTURES, offer1019))
  ? describe
  : describe.skip

with1019(
  '65.2 B2 Auto aboard — ride 2026-10-19 08:44 (the phantom offer)',
  () => {
    const fx = load(offer1019)
    const [{ t }] = batches(fx)
    let held = fx.itinerary
    for (const s of [...(fx.itinerarySwaps || [])].sort(
      (a: any, b: any) => a.tMs - b.tMs
    )) {
      if (s.tMs <= t) held = s.itinerary
    }

    for (const preset of AUTO_PRESETS) {
      it(`${preset}: no switch on the recorded plan`, () => {
        const { first, log } = run(fx, held, preset)
        // eslint-disable-next-line no-console
        console.log(`[1019 ${preset}] ${log.join(' | ')}`)
        expect(first).toBeNull()
      })
    }
  }
)
