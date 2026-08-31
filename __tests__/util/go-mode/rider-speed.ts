import {
  estimateBikeSpeedMps,
  recordRiderSpeedSample,
  RIDER_SPEED_IMPLAUSIBLE_MPS,
  RIDER_SPEED_MAX_SAMPLES,
  RIDER_SPEED_MIN_SAMPLES,
  RIDER_SPEED_MIN_SPAN_MS,
  RIDER_SPEED_MOVING_MIN_MPS,
  RIDER_SPEED_WINDOW_MS,
  withObservedBikeSpeed
} from '../../../lib/util/go-mode/rider-speed'
import type { RiderSpeedSample } from '../../../lib/util/go-mode/rider-speed'

const T0 = 1_756_400_000_000

/** A run of fixes at one second apart, all at the same speed. */
const ride = (
  speedMps: number,
  count: number,
  startMs = T0
): RiderSpeedSample[] => {
  let out: RiderSpeedSample[] = []
  for (let i = 0; i < count; i++) {
    out = recordRiderSpeedSample(out, { speedMps, tMs: startMs + i * 1000 })
  }
  return out
}

describe('util > go-mode > rider-speed: what reaches the buffer', () => {
  it('keeps a plausible cycling speed', () => {
    expect(recordRiderSpeedSample([], { speedMps: 6.2, tMs: T0 })).toEqual([
      { speedMps: 6.2, tMs: T0 }
    ])
  })

  it('drops the red light', () => {
    // The whole reason this module exists: coords.speed is instantaneous, and a
    // cyclist stopped at a light reports 0. Feeding that to a plan query would
    // ask OTP to route a 2 m/s (clamped) cyclist.
    const stopped = [0, 0.3, RIDER_SPEED_MOVING_MIN_MPS - 0.01]
    stopped.forEach((speedMps) => {
      expect(recordRiderSpeedSample([], { speedMps, tMs: T0 })).toEqual([])
    })
  })

  it('drops a fix that is not a bicycle at all', () => {
    // A bus fix (or urban multipath) that got past the leg-mode gate.
    const notABike = [RIDER_SPEED_IMPLAUSIBLE_MPS + 0.01, 22, 397]
    notABike.forEach((speedMps) => {
      expect(recordRiderSpeedSample([], { speedMps, tMs: T0 })).toEqual([])
    })
  })

  it('drops a fix that carries no speed', () => {
    expect(recordRiderSpeedSample([], { speedMps: null, tMs: T0 })).toEqual([])
    expect(
      recordRiderSpeedSample([], { speedMps: undefined, tMs: T0 })
    ).toEqual([])
    expect(recordRiderSpeedSample([], { speedMps: NaN, tMs: T0 })).toEqual([])
  })

  it('ages samples out against the incoming fix, not the wall clock', () => {
    // Judged on the fix's own timestamp so a replayed ride builds exactly the
    // buffer the live one did.
    const old = ride(6, 5, T0)
    const next = recordRiderSpeedSample(old, {
      speedMps: 6,
      tMs: T0 + RIDER_SPEED_WINDOW_MS + 5000
    })
    expect(next).toHaveLength(1)
  })

  it('is memory bounded on a long ride', () => {
    let samples: RiderSpeedSample[] = []
    for (let i = 0; i < RIDER_SPEED_MAX_SAMPLES + 50; i++) {
      // 100 ms apart, so nothing ages out — only the cap can bound this.
      samples = recordRiderSpeedSample(samples, {
        speedMps: 6,
        tMs: T0 + i * 100
      })
    }
    expect(samples).toHaveLength(RIDER_SPEED_MAX_SAMPLES)
  })
})

describe('util > go-mode > rider-speed: the estimate', () => {
  it('answers null until there is enough evidence to beat the default', () => {
    expect(estimateBikeSpeedMps([], T0)).toBeNull()
    expect(estimateBikeSpeedMps(null, T0)).toBeNull()
    const thin = ride(6.5, RIDER_SPEED_MIN_SAMPLES - 1, T0)
    expect(estimateBikeSpeedMps(thin, thin[thin.length - 1].tMs)).toBeNull()
  })

  it('refuses a burst that is a moment rather than a pace', () => {
    // Enough samples, but 10 fixes at 100 ms apart is one second of riding.
    let samples: RiderSpeedSample[] = []
    for (let i = 0; i < RIDER_SPEED_MIN_SAMPLES + 4; i++) {
      samples = recordRiderSpeedSample(samples, {
        speedMps: 7.5,
        tMs: T0 + i * 100
      })
    }
    expect(estimateBikeSpeedMps(samples, T0 + 2000)).toBeNull()
  })

  it('quotes the rider their own cruising pace once it has the evidence', () => {
    const samples = ride(6.4, 90, T0)
    expect(estimateBikeSpeedMps(samples, T0 + 90_000)).toBeCloseTo(6.4, 5)
  })

  it('is unmoved by the spikes a GPS stream always carries', () => {
    // The median is the point: one 14 m/s downhill blip and one 1.6 m/s crawl
    // in a 90-sample ride must not become the pace quoted to OTP. A mean would
    // move here; a high percentile would quote the blip.
    let samples = ride(6.0, 88, T0)
    samples = recordRiderSpeedSample(samples, {
      speedMps: 14.9,
      tMs: T0 + 88_000
    })
    samples = recordRiderSpeedSample(samples, {
      speedMps: 1.6,
      tMs: T0 + 89_000
    })
    expect(estimateBikeSpeedMps(samples, T0 + 90_000)).toBeCloseTo(6.0, 5)
  })

  it('forgets a pace older than the window', () => {
    const stale = ride(7.0, 40, T0)
    expect(
      estimateBikeSpeedMps(stale, T0 + RIDER_SPEED_WINDOW_MS + 60_000)
    ).toBeNull()
  })

  it('needs the span even when the samples are recent', () => {
    const samples = ride(6.0, RIDER_SPEED_MIN_SAMPLES, T0)
    const span = samples[samples.length - 1].tMs - samples[0].tMs
    expect(span).toBeLessThan(RIDER_SPEED_MIN_SPAN_MS)
    expect(estimateBikeSpeedMps(samples, T0 + span)).toBeNull()
  })

  it('clamps to the range routing-profiles enforces on every other lever', () => {
    // A whole ride of e-bike speeds still cannot put an absurd number in a query.
    const fast = ride(14.5, 90, T0)
    expect(estimateBikeSpeedMps(fast, T0 + 90_000)).toBe(8)
    const slow = ride(1.7, 90, T0)
    expect(estimateBikeSpeedMps(slow, T0 + 90_000)).toBe(2)
  })
})

describe('util > go-mode > rider-speed: merging into a re-plan', () => {
  it('fills an unset lever', () => {
    expect(withObservedBikeSpeed(undefined, 6.4)).toEqual({ bikeSpeed: 6.4 })
    expect(withObservedBikeSpeed({ transferPenalty: 600 }, 6.4)).toEqual({
      bikeSpeed: 6.4,
      transferPenalty: 600
    })
  })

  it('leaves a speed the rider chose alone', () => {
    // bike-forward's 5.5. An explicit choice outranks an inferred observation.
    expect(
      withObservedBikeSpeed({ bikeReluctance: 0.6, bikeSpeed: 5.5 }, 7.2)
    ).toEqual({ bikeReluctance: 0.6, bikeSpeed: 5.5 })
  })

  it('changes nothing when there is no observation', () => {
    const prefs = { transferPenalty: 600 }
    expect(withObservedBikeSpeed(prefs, null)).toBe(prefs)
    expect(withObservedBikeSpeed(prefs, undefined)).toBe(prefs)
    expect(withObservedBikeSpeed(undefined, null)).toBeUndefined()
  })

  it('clamps on the way in as well', () => {
    expect(withObservedBikeSpeed(undefined, 99)).toEqual({ bikeSpeed: 8 })
    expect(withObservedBikeSpeed(undefined, 0.1)).toEqual({ bikeSpeed: 2 })
  })
})
