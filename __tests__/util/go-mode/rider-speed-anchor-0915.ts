/* globals describe, expect, it */
import fs from 'fs'
import path from 'path'

import {
  estimateBikeSpeedMps,
  estimateRideAnchorMps,
  recordRiderSpeedAnchorSample,
  recordRiderSpeedSample,
  RIDER_SPEED_ANCHOR_FLOOR_FRACTION
} from '../../../lib/util/go-mode/rider-speed'
import type {
  RiderSpeedAnchorBucket,
  RiderSpeedSample
} from '../../../lib/util/go-mode/rider-speed'

/**
 * The 2026-09-15 morning ride (09:31-10:28 CDT), downtown Minneapolis ->
 * 2345 Old Shakopee Rd W, bike + Orange Line + bike. Backlog 16.1.
 *
 * What went wrong is not that the estimator misread the rider. It read them
 * correctly: crossing the downtown grid the rider's moving-fix median really
 * did fall to 2.0 m/s, and 35-44 of every 60 fixes in 09:47-09:49 were under
 * RIDER_SPEED_MOVING_MIN_MPS and so were already excluded. The defect is that a
 * five-minute pace was then used to time a WHOLE access leg: every re-plan from
 * 09:43 went out at bikeSpeed 2.0-2.47, and the legs OTP installed against
 * those ran 1.29-1.60 m/s effective — the 09:43:37 one 1,173 m of one-way loops
 * for a stop 345 m away. Ten minutes earlier and forty minutes later the same
 * rider was doing 5.4-6.3 m/s.
 *
 * Two halves. First the harness is proved against the ride's own wire traffic:
 * replaying `gpsTrack` through the UNCHANGED estimator has to reproduce the
 * `bikeSpeed` each re-plan actually sent. Only then is the floor measured on it.
 *
 * The fixture is 18.6 MB and is not committed, so everything here skips when it
 * is absent.
 */

const FIXTURE_PATH = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/orange-0915-0931.json'
)

const fixture: any = fs.existsSync(FIXTURE_PATH)
  ? JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))
  : null

/** Skip cleanly rather than fail when the (untracked) recording is not here. */
const withFixture = fixture ? describe : describe.skip

const gpsTrack: any[] = [...(fixture?.gpsTrack || [])].sort(
  (a, b) => a.tMs - b.tMs
)
const snapshots: any[] = fixture?.rerouteSnapshots || []

/** What a re-plan actually put on the wire, by snapshot time. */
const sentBikeSpeed = (s: any): number | null =>
  s?.request?.variables?.bikeSpeed ?? null

/**
 * Both buffers as handlePositionUpdate builds them live: same fixes, same
 * order, trimmed against each fix's own timestamp so replay reproduces the live
 * state rather than approximating it.
 *
 * The replay is UNGATED — it feeds the whole track, where the live code records
 * only on a BICYCLE leg and not aboard. Over the first bike leg (09:31-09:55)
 * the gate is a no-op, which is why the reproduction below is exact there; from
 * the 09:56 boarding on it is not, and nothing after 09:55:29 is asserted.
 */
const buffersAt = (
  nowMs: number
): { anchor: RiderSpeedAnchorBucket[]; samples: RiderSpeedSample[] } => {
  let samples: RiderSpeedSample[] = []
  let anchor: RiderSpeedAnchorBucket[] = []
  for (const g of gpsTrack) {
    if (g.tMs > nowMs) break
    const fix = { speedMps: g.speed, tMs: g.tMs }
    samples = recordRiderSpeedSample(samples, fix)
    anchor = recordRiderSpeedAnchorSample(anchor, fix)
  }
  return { anchor, samples }
}

/** Epoch ms of the re-plans this row is about, from the fixture's own stream. */
const T_0932 = 1789482768631 // 09:32:48 — cruising, before the grid
const T_0940 = 1789483210991 // 09:40:10 — slowing, first minute with an anchor
const T_0943 = 1789483401354 // 09:43:21 — the 1,173 m loop's re-plan
const T_0949 = 1789483765450 // 09:49:25
const T_0950 = 1789483856916 // 09:50:56 — sent the bottom of the lever range
const T_0952 = 1789483938638 // 09:52:18
/** The last re-plan before the rider boards; after this the gate matters. */
const T_0955 = 1789484129182 // 09:55:29

const oldEstimate = (nowMs: number): number | null =>
  estimateBikeSpeedMps(buffersAt(nowMs).samples, nowMs)

const newEstimate = (nowMs: number): number | null => {
  const { anchor, samples } = buffersAt(nowMs)
  return estimateBikeSpeedMps(samples, nowMs, anchor)
}

withFixture('util > go-mode > the 9/15 downtown-crawl bikeSpeed (16.1)', () => {
  describe('the harness really is the ride', () => {
    it('is the 9/15 Orange Line run, with the crawl in it', () => {
      expect(gpsTrack.length).toBeGreaterThan(3000)
      expect(snapshots.length).toBeGreaterThan(30)
      // The three re-plans the row names, still on the wire at 2.0-2.47 m/s.
      const byTime = (t: number) => snapshots.find((s) => s.tMs === t)
      expect(sentBikeSpeed(byTime(T_0943))).toBeCloseTo(2.465, 2)
      expect(sentBikeSpeed(byTime(T_0949))).toBeCloseTo(2.053, 2)
      expect(sentBikeSpeed(byTime(T_0950))).toBe(2)
      expect(sentBikeSpeed(byTime(T_0932))).toBeCloseTo(5.833, 2)
    })

    it('replays the OLD estimator back into the values that were sent', () => {
      // Every bike-leg re-plan, not a chosen few. The tolerance is 0.12 rather
      // than 0.1 for one snapshot only: `tMs` is stamped when the response
      // lands, a few seconds after the query was built, so 09:41:50 (sent
      // 3.411, replayed 3.296 at its own tMs) reproduces to 1e-9 at tMs-8s.
      // Every other snapshot is within 0.06.
      const checked: number[] = []
      for (const s of snapshots) {
        if (s.tMs > T_0955) break
        const sent = sentBikeSpeed(s)
        if (sent == null) continue
        const replayed = oldEstimate(s.tMs)
        expect(replayed).not.toBeNull()
        expect(Math.abs((replayed as number) - sent)).toBeLessThanOrEqual(0.12)
        checked.push(s.tMs)
      }
      expect(checked.length).toBe(16)
    })

    it('the old estimator is what sat on the floor of the lever range', () => {
      expect(oldEstimate(T_0949)).toBeCloseTo(2.05, 2)
      expect(oldEstimate(T_0950)).toBe(2)
      expect(oldEstimate(T_0952)).toBe(2)
    })
  })

  describe('the ride-level anchor', () => {
    it('is the cruising pace, not the crawl', () => {
      // Median of per-minute peaks over the ride so far. The plain median of
      // the ride's moving fixes at the same moment is 2.8-3.1 m/s — eleven of
      // the twenty-one bike minutes WERE the crawl — which is exactly why the
      // anchor is taken from the peaks.
      expect(
        estimateRideAnchorMps(buffersAt(T_0949).anchor, T_0949)
      ).toBeCloseTo(5.09, 1)
      expect(
        estimateRideAnchorMps(buffersAt(T_0943).anchor, T_0943)
      ).toBeCloseTo(6.44, 1)
    })

    it('holds nothing back until there is a ride behind it', () => {
      // 09:32:48 is ~90 s in: fewer than RIDER_SPEED_ANCHOR_MIN_BUCKETS
      // minutes of riding, so there is no floor and no change at all.
      expect(estimateRideAnchorMps(buffersAt(T_0932).anchor, T_0932)).toBeNull()
      expect(newEstimate(T_0932)).toBe(oldEstimate(T_0932))
    })
  })

  describe('what the re-plans would now be timed at', () => {
    it('never drops below 3.5 m/s through the crawl', () => {
      for (const t of [T_0949, T_0950, T_0952]) {
        expect(newEstimate(t) as number).toBeGreaterThanOrEqual(3.5)
      }
      expect(newEstimate(T_0949)).toBeCloseTo(3.56, 1)
      expect(newEstimate(T_0950)).toBeCloseTo(3.54, 1)
      expect(newEstimate(T_0952)).toBeCloseTo(3.54, 1)
    })

    it('lifts the 09:43 re-plan — the 1,173 m loop — off 2.47', () => {
      expect(newEstimate(T_0943)).toBeCloseTo(4.51, 1)
      expect(newEstimate(T_0940)).toBeCloseTo(4.87, 1)
    })

    it('still tracks the rider when the rider is the slow one', () => {
      // The floor only ever raises, and only to the fraction: cruising is
      // untouched at 09:32:48, and every crawl value lands on the fraction of
      // its own anchor rather than on some constant.
      expect(newEstimate(T_0932)).toBeCloseTo(5.89, 1)
      for (const t of [T_0940, T_0943, T_0949, T_0950, T_0952]) {
        const { anchor, samples } = buffersAt(t)
        const floor =
          (estimateRideAnchorMps(anchor, t) as number) *
          RIDER_SPEED_ANCHOR_FLOOR_FRACTION
        expect(newEstimate(t)).toBeCloseTo(floor, 5)
        expect(newEstimate(t) as number).toBeGreaterThan(
          estimateBikeSpeedMps(samples, t) as number
        )
      }
    })

    it('leaves every re-plan the old code got right exactly where it was', () => {
      // 09:32:48 - 09:38:48: no anchor yet, so byte-for-byte the old answer.
      for (const s of snapshots) {
        if (s.tMs >= T_0940) break
        expect(newEstimate(s.tMs)).toBe(oldEstimate(s.tMs))
      }
    })
  })
})
