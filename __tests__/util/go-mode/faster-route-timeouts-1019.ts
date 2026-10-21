/* globals describe, expect, it */
import '../../test-utils/mock-window-url'
import fs from 'fs'
import path from 'path'

import {
  compareAlightOffer,
  plannedOnwardOf
} from '../../../lib/util/go-mode/faster-route'
import { legTripId } from '../../../lib/util/go-mode/leg-merge'

/**
 * Backlog 56.1, cycle 25 second re-build (rider Q6 = A, 2026-10-19): the
 * aboard get-off check went blind because the planned stop's own plan timed
 * out. Ride `mvfqu4i0-yd2epd`, the 16:06:09-16:31:05 Gold Line leg (plan: Gold
 * to 6th St & Washington 1:11863, 94 `1:1186627`, 904, bike; card end
 * 17:56:50). Four checks; the recorded batches (fixture, trimmed from the day
 * file; steps/alerts/geometry stripped):
 *
 *   16:07:39  8 asked: 1 answered, 2 answered >1 MB (stubbed), 5 timed out
 *             at 12 s — Washington among them
 *   16:13:39  7 asked: Washington + Tamarack answered, 1 stubbed, 4 timed out
 *   16:19:43  7 asked: 1 answered, 2 stubbed, 4 timed out — Washington too
 *   16:25:45  7 asked: 1 answered, 2 stubbed, 4 timed out — Washington too
 *
 * compareAlightOffer takes its baseline only from the planned stop's answer,
 * so a check whose Washington plan timed out ends `no-baseline`. The fix is in
 * how the plans are SENT (paceCandidatePlans: planned stop alone first, then
 * two at a time — alone it answers in 1.4-2.0 s on the Linode, measured
 * 2026-10-19 evening); this replay pins what the comparator then concludes.
 * Washington was recorded once (16:13:46); the other checks are replayed with
 * that answer standing in for the one that timed out — the same 94 run.
 */

const FIXTURE = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/batches/ride-1019-1606-aboard-timeouts.json'
)
const WASHINGTON = '1:11863'
const GOLD_TRIP = '1:1343603'
const RUN_94 = '1:1186627'

const hm = (ms: number | null | undefined): string =>
  ms == null
    ? '—'
    : new Date(ms).toLocaleTimeString('en-GB', {
        hour12: false,
        timeZone: 'America/Chicago'
      })

const withFixture = fs.existsSync(FIXTURE) ? describe : describe.skip

withFixture(
  '56.1 aboard check timeouts — ride 2026-10-19 16:06 Gold Line',
  () => {
    const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
    const held = fx.itinerary
    const startMs = (hms: string) =>
      new Date(`2026-10-19T${hms}-05:00`).getTime()
    const resultOf = (a: any) => ({
      busArrivalEpoch: a.busArrivalEpoch,
      itineraries: a.itineraries,
      realtime: true,
      stopId: a.stopId,
      stopName: a.stopName
    })
    const failed = (stopId: string) => ({
      busArrivalEpoch: 0,
      error: true,
      itineraries: [],
      realtime: false,
      stopId,
      stopName: stopId
    })
    const washington = fx.checks
      .flatMap((c: any) => c.answers)
      .find((a: any) => a.stopId === WASHINGTON)
    const judge = (check: any, results: any[]) =>
      compareAlightOffer({
        boarded: { routeId: '1:905', tripId: GOLD_TRIP },
        downstream: null,
        nowMs: startMs(check.start),
        plannedOnward: plannedOnwardOf(held, 0, check.liveLegTimes),
        plannedOnwardTripId: legTripId(held.legs[1]),
        plannedStopId: WASHINGTON,
        results
      })
    const recorded = (check: any) => [
      ...check.answers.map(resultOf),
      ...(check.timedOutStopIds || []).map(failed)
    ]
    const lines: string[] = []

    it('the held plan alights at Washington for the 94', () => {
      expect(held.legs[0].to.stop.gtfsId).toBe(WASHINGTON)
      expect(legTripId(held.legs[1])).toBe(RUN_94)
      expect(washington).toBeTruthy()
    })

    it('BEFORE: the three checks whose Washington plan timed out had no baseline', () => {
      const verdicts = fx.checks.map((c: any) => {
        const v = judge(c, recorded(c))
        lines.push(
          `before ${c.start}: asked ${
            c.answers.length + c.stubs + c.timeouts
          }, answered ${c.answers.length}+${c.stubs} stubbed, timed out ${
            c.timeouts
          } [${(c.timedOutStopIds || []).join(' ')}] -> ${v.why} baseline ${hm(
            v.baselineArrival
          )}`
        )
        return [c.start, v.why]
      })
      expect(verdicts).toEqual([
        ['16:07:39', 'no-baseline'],
        ['16:13:39', 'same-as-plan'],
        ['16:19:43', 'no-baseline'],
        ['16:25:45', 'no-baseline']
      ])
    })

    it('AFTER: with the planned stop answered, every check has a baseline and still offers nothing', () => {
      const after = fx.checks.map((c: any) => {
        const results = [
          ...c.answers
            .filter((a: any) => a.stopId !== WASHINGTON)
            .map(resultOf),
          resultOf(washington),
          ...(c.timedOutStopIds || [])
            .filter((id: string) => id !== WASHINGTON)
            .map(failed)
        ]
        const v = judge(c, results)
        lines.push(
          `after  ${c.start}: ${v.why} baseline ${hm(
            v.baselineArrival
          )} best ${hm(v.candidateArrival)} at ${
            v.candidate?.stopName ?? '—'
          } saving ${Math.round(v.savingMs / 1000)} s`
        )
        return v
      })
      for (const v of after) {
        expect(v.baselineArrival).not.toBeNull()
        expect(hm(v.baselineArrival)).toBe('17:54:28')
        expect(v.why).not.toBe('offer')
        expect(v.why).not.toBe('no-baseline')
      }
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'))
    })
  }
)
