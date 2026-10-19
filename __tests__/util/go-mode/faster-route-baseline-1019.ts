/* globals describe, expect, it */
import '../../test-utils/mock-window-url'
import fs from 'fs'
import path from 'path'

import {
  compareAlightOffer,
  plannedOnwardOf
} from '../../../lib/util/go-mode/faster-route'
import {
  legTripId,
  retargetTransitLegToRun
} from '../../../lib/util/go-mode/leg-merge'
import { onwardRunsFromStore } from '../../../lib/actions/go-mode'

/**
 * Backlog 56.1, cycle 25 re-build after the 2026-10-19 Verify FAIL (ride
 * `mvfb1a71-x3jjwm` 08:44-09:01, DEV 2026.1018.5). The first real aboard
 * get-off offer was a phantom: "16.8 min faster · off at Rice Park, +1.7 km
 * bike" for what was a 19 s gain (held 10:00:25 -> switched 10:00:06, same
 * Gold Line run 1:1344457, same 6,818 m bike).
 *
 * Two defects, both replayed here from the recorded ride:
 *  1. 08:48:29 PLAN_RETARGET moved the 94 19:03 earlier and shifted the Gold
 *     leg by the same delta KEEPING its trip id: `1:1262609` at Robert
 *     09:16:04 — a time that trip does not run there (it boards 09:35:09).
 *  2. compareAlightOffer took the baseline by that trip id -> the real
 *     1:1262609 continuation 10:16:53 -> 16.8 min "faster".
 * And the rule the rider gets on a tie: staying on to the planned stop wins.
 */

const FIXTURE = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/ride-1019-0844-aboard-offer.json'
)
const EARLIER = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/orange-0806-1019.json'
)
const ROBERT = '1:57418'
const GOLD_PLANNED = '1:1262609'
const GOLD_REAL = '1:1344457'
const MIN = 60000

const hm = (ms: number | null | undefined): string =>
  ms == null
    ? '—'
    : new Date(ms).toLocaleTimeString('en-GB', {
        hour12: false,
        timeZone: 'America/Chicago'
      })

const load = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'))

function heldAt(fx: any, t: number): any {
  let held = fx.itinerary
  for (const s of [...(fx.itinerarySwaps || [])].sort(
    (a: any, b: any) => a.tMs - b.tMs
  ))
    if (s.tMs <= t) held = s.itinerary
  return held
}

/** The optimizer answers of the one aboard check, as the caller hands them. */
function aboardBatch(fx: any): { results: any[]; t: number } {
  const ocp = [...(fx.onboardCandidatePlans || [])].sort(
    (a: any, b: any) => a.tMs - b.tMs
  )
  const t = ocp[0].tMs
  return {
    results: ocp
      .filter((r: any) => r.tMs - t <= 30000)
      .map((r: any) => ({
        busArrivalEpoch: r.request?.busArrivalEpoch,
        itineraries: r.response?.data?.plan?.itineraries || [],
        realtime: true,
        stopId: r.stopId,
        stopName: r.request?.from?.name || r.stopId
      })),
    t
  }
}

/** The aboard leg: the transit leg whose alight is one of the asked stops. */
function aboardLegIndex(held: any, results: any[]): number {
  const ids = new Set(results.map((r) => r.stopId))
  return (held.legs || []).findIndex(
    (l: any) => l.transitLeg && ids.has(l.to?.stop?.gtfsId)
  )
}

/** A transitIndex holding the stop-times answers recorded before `t`. */
function storeAt(fx: any, t: number): any {
  const stops: Record<string, any> = {}
  for (const s of fx.stopTimeSnapshots || []) {
    if (s.tMs <= t) stops[s.stopId] = s.payload
  }
  return { otp: { transitIndex: { stops } } }
}

const withFixture = fs.existsSync(FIXTURE) ? describe : describe.skip

withFixture('56.1 aboard offer baseline — ride 2026-10-19 08:44', () => {
  const fx = load(FIXTURE)
  const { results, t } = aboardBatch(fx)
  const RETARGET_MS = fx.itinerarySwaps
    .map((s: any) => s.tMs)
    .sort((a: number, b: number) => a - b)[0]
  const recordedHeld = heldAt(fx, t) // the 08:48:29 retarget's output
  const original = fx.itinerary
  const run94 = recordedHeld.legs[1]

  it('BEFORE: the recorded retarget left the Gold leg on 1:1262609 at 09:16', () => {
    const gold = recordedHeld.legs[2]
    expect(legTripId(gold)).toBe(GOLD_PLANNED)
    expect(hm(gold.startTime)).toBe('09:16:04')
    // ...and the old retarget (no onward runs) still reproduces it.
    const legacy = retargetTransitLegToRun(original, 1, {
      departureMs: run94.startTime,
      realtime: true,
      tripId: legTripId(run94) as string
    })!
    expect(legTripId(legacy.legs[2])).toBe(GOLD_PLANNED)
    expect(legacy.legs[2].startTime).toBe(gold.startTime)
  })

  it('BEFORE: a baseline taken by that trip id reads 10:16:53 — 16.8 min', () => {
    const i = aboardLegIndex(recordedHeld, results)
    const onward = recordedHeld.legs.slice(i + 1).find((l: any) => l.transitLeg)
    const v = compareAlightOffer({
      nowMs: t,
      plannedOnwardTripId: legTripId(onward),
      plannedStopId: recordedHeld.legs[i].to.stop.gtfsId,
      results
    })
    // eslint-disable-next-line no-console
    console.log(
      `[56.1 before] ${hm(t)} base=${hm(v.baselineArrival)} top=${hm(
        v.candidateArrival
      )}@${v.candidate?.stopName} saving=${(v.savingMs / MIN).toFixed(
        1
      )}min bike-${v.bikeSavedM}m -> ${v.why}:${v.kind}`
    )
    // The trip-id baseline is the phantom one: the 08:59:57 offer's 16.8 min
    // (FASTER_ROUTE_OFFER savingMin 16.8 on the ride; main b6f006a98 gives
    // offer:faster 16.78 min, bike -1737 m, off at 5th St & Cedar). The
    // caller no longer asks this way (it passes plannedOnward).
    expect(Math.round(v.savingMs / 6000) / 10).toBe(16.8)
    expect(hm(v.baselineArrival)).toBe('10:16:53')
    expect(hm(v.candidateArrival)).toBe('10:00:06')
    // Even so, the tie with staying on to Robert keeps it off other stops.
    expect(v.candidate?.stopId).toBe(ROBERT)
  })

  it('AFTER: the retarget puts the Gold leg on the run that boards Robert then', () => {
    const state = storeAt(fx, RETARGET_MS)
    const next = retargetTransitLegToRun(
      original,
      1,
      {
        departureMs: run94.startTime,
        realtime: true,
        tripId: legTripId(run94) as string
      },
      { onwardRuns: (leg) => onwardRunsFromStore(state, leg) }
    )!
    const gold = next.legs[2]
    // eslint-disable-next-line no-console
    console.log(
      `[56.1 retarget] 94 ${hm(next.legs[1].startTime)}->${hm(
        next.legs[1].endTime
      )}; Gold ${legTripId(gold)} ${hm(gold.startTime)}->${hm(
        gold.endTime
      )}; arrive ${hm(next.endTime as number)} (recorded swap: ${legTripId(
        recordedHeld.legs[2]
      )} ${hm(recordedHeld.legs[2].startTime)}, arrive ${hm(
        recordedHeld.endTime
      )})`
    )
    expect(legTripId(gold)).toBe(GOLD_REAL)
    expect(gold.from.stop.gtfsId).toBe(ROBERT)
    expect(hm(gold.startTime)).toBe('09:16:27')
    // The bike home moves with it; the trip still ends after the Gold leg.
    expect(next.legs[3].startTime).toBe(gold.endTime)
    expect(next.endTime).toBe(next.legs[3].endTime)
    // The 94 still arrives before the Gold leaves.
    expect(next.legs[1].endTime).toBeLessThanOrEqual(gold.startTime)
  })

  it('AFTER: no stop data and the planned run still made -> it is kept as is', () => {
    const next = retargetTransitLegToRun(
      original,
      1,
      {
        departureMs: run94.startTime,
        realtime: true,
        tripId: legTripId(run94) as string
      },
      { onwardRuns: () => null }
    )!
    expect(next.legs[2]).toBe(original.legs[2])
    expect(next.legs[3]).toBe(original.legs[3])
    expect(next.endTime).toBe(original.endTime)
  })

  it('AFTER: no stop data and the connection broken -> refused', () => {
    let unresolved: number | null = null
    const next = retargetTransitLegToRun(
      original,
      1,
      {
        departureMs: Number(original.legs[1].startTime) + 10 * MIN,
        realtime: true,
        tripId: '1:LATER'
      },
      {
        onUnresolved: (i) => {
          unresolved = i
        },
        onwardRuns: () => null
      }
    )
    expect(next).toBeNull()
    expect(unresolved).toBe(2)
  })

  it('AFTER: the card-shaped baseline on the recorded plan makes no offer', () => {
    const i = aboardLegIndex(recordedHeld, results)
    const onward = recordedHeld.legs.slice(i + 1).find((l: any) => l.transitLeg)
    const v = compareAlightOffer({
      nowMs: t,
      plannedOnward: plannedOnwardOf(recordedHeld, i, null),
      plannedOnwardTripId: legTripId(onward),
      plannedStopId: recordedHeld.legs[i].to.stop.gtfsId,
      results
    })
    // eslint-disable-next-line no-console
    console.log(
      `[56.1 after, recorded plan] base=${hm(v.baselineArrival)} top=${hm(
        v.candidateArrival
      )}@${v.candidate?.stopName} saving=${(v.savingMs / 1000).toFixed(
        0
      )}s bike-${v.bikeSavedM}m -> ${v.why}`
    )
    expect(v.kind).toBeNull()
    expect(hm(v.baselineArrival)).toBe('10:00:06')
    expect(Math.abs(v.savingMs)).toBeLessThan(MIN)
  })

  it('AFTER: on the re-resolved plan the planned stop is the plan — no offer', () => {
    const state = storeAt(fx, RETARGET_MS)
    const fixed = retargetTransitLegToRun(
      original,
      1,
      {
        departureMs: run94.startTime,
        realtime: true,
        tripId: legTripId(run94) as string
      },
      { onwardRuns: (leg) => onwardRunsFromStore(state, leg) }
    )!
    const i = aboardLegIndex(fixed, results)
    const v = compareAlightOffer({
      nowMs: t,
      plannedOnward: plannedOnwardOf(fixed, i, null),
      plannedOnwardTripId: legTripId(fixed.legs[i + 1]),
      plannedStopId: fixed.legs[i].to.stop.gtfsId,
      results
    })
    // eslint-disable-next-line no-console
    console.log(
      `[56.1 after, re-resolved plan] base=${hm(v.baselineArrival)} top=${hm(
        v.candidateArrival
      )}@${v.candidate?.stopName} -> ${v.why}`
    )
    expect(v.kind).toBeNull()
    expect(hm(v.baselineArrival)).toBe('10:00:06')
  })

  it('a plan really on the 09:35 Gold: the offer is Robert + the earlier Gold, not another stop', () => {
    // Had the plan truly held 1:1262609 at 09:35, staying on to Robert for
    // the 09:16 Gold IS 16.8 min faster — and Robert is where to get off.
    const i = aboardLegIndex(recordedHeld, results)
    const v = compareAlightOffer({
      nowMs: t,
      plannedOnward: {
        boardMs: Number(recordedHeld.legs[i + 1].startTime) + 19 * MIN,
        boardStopId: ROBERT,
        routeId: '1:905',
        tripId: GOLD_PLANNED
      },
      plannedOnwardTripId: GOLD_PLANNED,
      plannedStopId: recordedHeld.legs[i].to.stop.gtfsId,
      results
    })
    expect(v.kind).toBe('faster')
    expect(v.candidate?.stopId).toBe(ROBERT)
    expect(hm(v.candidateArrival)).toBe('10:00:06')
  })
})

const withEarlier = fs.existsSync(EARLIER) ? describe : describe.skip

withEarlier(
  '56.1 aboard offer baseline — earlier ride 2026-10-19 08:06',
  () => {
    it('still no offer at the 08:19:53 check', () => {
      const fx = load(EARLIER)
      const { results, t } = aboardBatch(fx)
      const held = heldAt(fx, t)
      const i = aboardLegIndex(held, results)
      expect(i).toBeGreaterThanOrEqual(0)
      const onward = held.legs.slice(i + 1).find((l: any) => l.transitLeg)
      const v = compareAlightOffer({
        nowMs: t,
        plannedOnward: plannedOnwardOf(held, i, null),
        plannedOnwardTripId: onward ? legTripId(onward) : null,
        plannedStopId: held.legs[i].to.stop.gtfsId,
        results
      })
      // eslint-disable-next-line no-console
      console.log(
        `[56.1 earlier ride] ${hm(t)} base=${hm(v.baselineArrival)} top=${hm(
          v.candidateArrival
        )}@${v.candidate?.stopName} -> ${v.why}`
      )
      expect(v.kind).toBeNull()
    })
  }
)
