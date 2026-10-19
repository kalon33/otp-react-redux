import { FIX_ACCURACY_MAX_M } from '../../../lib/util/go-mode/transit-trust'
import {
  pickReplanOriginFix,
  REPLAN_ORIGIN_MAX_AGE_MS
} from '../../../lib/util/go-mode/replan-origin'
import { UPDATE_POSITION } from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'

/**
 * Backlog 51.3: an automatic re-plan takes its origin from the freshest fix
 * within FIX_ACCURACY_MAX_M and REPLAN_ORIGIN_MAX_AGE_MS, else waits. The
 * numbers are ride `mv6ret6s-h5he2i`'s, 2026-10-13 09:31.
 */
const NOW = 1_791_901_885_888 // 09:31:25.888, the first 1,414 m fix

const fix = (
  lat: number,
  lon: number,
  accuracy: number | null | undefined,
  timestamp: number
) =>
  ({
    coords: {
      accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      latitude: lat,
      longitude: lon,
      speed: null
    },
    timestamp
  } as unknown as GeolocationPosition)

/** Go Mode's first watcher fix, 1,247 m south of the rider. */
const BAD = fix(44.90833, -93.27659, 1414, NOW)
/** The planner's own fix 23 s earlier. */
const PLANNER = fix(44.91979, -93.27483, 14, NOW - 23_000)
/** The first usable Go Mode fix, 09:31:48.761. */
const NINETY = fix(44.91947, -93.2745, 90.49, NOW + 22_873)

describe('util > go-mode > pickReplanOriginFix (51.3)', () => {
  it('passes over a 1,414 m fix for the 14 m planner fix 23 s older', () => {
    const pick = pickReplanOriginFix({
      goModeFix: BAD,
      lastTrustedFix: null,
      nowMs: NOW,
      plannerFix: PLANNER
    })
    expect(pick?.source).toBe('planner')
    expect(pick?.position).toBe(PLANNER)
    expect(pick?.ageMs).toBe(23_000)
  })

  it('returns null when every fix is too poor: the caller waits', () => {
    expect(
      pickReplanOriginFix({
        goModeFix: BAD,
        lastTrustedFix: null,
        nowMs: NOW,
        plannerFix: null
      })
    ).toBeNull()
  })

  it('takes the 90 m fix when it comes', () => {
    const pick = pickReplanOriginFix({
      goModeFix: NINETY,
      lastTrustedFix: NINETY,
      nowMs: NINETY.timestamp,
      plannerFix: PLANNER
    })
    expect(pick?.source).toBe('go-mode')
    expect(pick?.position).toBe(NINETY)
  })

  it('prefers the freshest usable fix, whatever its source', () => {
    const older = fix(44.9, -93.2, 5, NOW - 40_000)
    const newer = fix(44.91, -93.21, 50, NOW - 10_000)
    expect(
      pickReplanOriginFix({
        goModeFix: BAD,
        lastTrustedFix: newer,
        nowMs: NOW,
        plannerFix: older
      })?.source
    ).toBe('last-trusted')
    expect(
      pickReplanOriginFix({
        goModeFix: BAD,
        lastTrustedFix: older,
        nowMs: NOW,
        plannerFix: newer
      })?.source
    ).toBe('planner')
  })

  it('holds the accuracy bound inclusive at FIX_ACCURACY_MAX_M', () => {
    const edge = (a: number) =>
      pickReplanOriginFix({
        goModeFix: fix(44.9, -93.2, a, NOW),
        nowMs: NOW
      })
    expect(edge(FIX_ACCURACY_MAX_M)).not.toBeNull()
    expect(edge(FIX_ACCURACY_MAX_M + 0.1)).toBeNull()
  })

  it('holds the age bound at REPLAN_ORIGIN_MAX_AGE_MS, both ways', () => {
    const aged = (ageMs: number) =>
      pickReplanOriginFix({
        goModeFix: fix(44.9, -93.2, 10, NOW - ageMs),
        nowMs: NOW
      })
    expect(aged(REPLAN_ORIGIN_MAX_AGE_MS)).not.toBeNull()
    expect(aged(REPLAN_ORIGIN_MAX_AGE_MS + 1)).toBeNull()
    // A fix dated well after "now" (a wall-clock fix against a simulated
    // clock) is no evidence of where the rider is either.
    expect(aged(-REPLAN_ORIGIN_MAX_AGE_MS - 1)).toBeNull()
  })

  it('does not trust a fix that reports no accuracy, or no point', () => {
    expect(
      pickReplanOriginFix({
        goModeFix: fix(44.9, -93.2, null, NOW),
        nowMs: NOW
      })
    ).toBeNull()
    expect(
      pickReplanOriginFix({
        goModeFix: fix(NaN, -93.2, 5, NOW),
        nowMs: NOW,
        plannerFix: { coords: null } as any
      })
    ).toBeNull()
  })
})

describe('reducers > go-mode > tracking.lastTrustedPosition (51.3)', () => {
  const initial = goMode(undefined, { type: '@@INIT' })

  it('starts empty', () => {
    expect(initial.tracking.lastTrustedPosition).toBeNull()
  })

  it('keeps the last fix within FIX_ACCURACY_MAX_M through worse ones', () => {
    let s = goMode(initial, { payload: PLANNER, type: UPDATE_POSITION })
    expect(s.tracking.lastTrustedPosition).toBe(PLANNER)
    s = goMode(s, { payload: BAD, type: UPDATE_POSITION })
    expect(s.tracking.lastPosition).toBe(BAD)
    expect(s.tracking.lastTrustedPosition).toBe(PLANNER)
    s = goMode(s, { payload: NINETY, type: UPDATE_POSITION })
    expect(s.tracking.lastTrustedPosition).toBe(NINETY)
  })

  it('never takes a fix with no accuracy', () => {
    const s = goMode(initial, {
      payload: fix(44.9, -93.2, undefined, NOW),
      type: UPDATE_POSITION
    })
    expect(s.tracking.lastTrustedPosition).toBeNull()
  })
})
