import {
  decideFollowCamera,
  FOLLOW_GAP_ACCEPT_MS,
  FOLLOW_ZOOM_ACCESS,
  FOLLOW_ZOOM_TRANSIT
} from '../../../lib/util/go-mode/follow-camera'

// ~1 deg latitude = ~111.2 km; offsets below are chosen against that scale.
const BASE = { lat: 44.9205, lng: -93.276 }
const T0 = 1753800000000

// ~2 m north: inside the dead-band.
const JITTER_LAT = BASE.lat + 0.000018
// ~20 m north: normal movement (20 m/s over 1 s stays under the 70 m/s spike
// threshold).
const STEP_LAT = BASE.lat + 0.00018
// ~5.2 km north: the 7/29-style garbage jump.
const SPIKE_LAT = BASE.lat + 0.047

const fix = (over: Record<string, unknown> = {}) => ({
  accuracyM: 10 as number | null,
  lat: BASE.lat,
  lng: BASE.lng,
  timestampMs: T0,
  ...over
})

const base = (over: Record<string, unknown> = {}) => ({
  fix: fix(),
  legMode: 'WALK' as string | null,
  prevAccepted: null,
  prevLegTransit: null,
  prevRejectedSpike: null,
  ...over
})

describe('util > go-mode > follow-camera', () => {
  describe('engage (no previously accepted fix)', () => {
    it('moves to the fix at the access zoom on a walk leg', () => {
      const d = decideFollowCamera(base())
      expect(d.move).toBe(true)
      expect(d.reason).toBe('engage')
      expect(d.center).toEqual([BASE.lng, BASE.lat])
      expect(d.zoom).toBe(FOLLOW_ZOOM_ACCESS)
    })

    it('uses the transit zoom on a transit leg', () => {
      expect(decideFollowCamera(base({ legMode: 'BUS' })).zoom).toBe(
        FOLLOW_ZOOM_TRANSIT
      )
    })

    it('treats an unknown leg mode as access', () => {
      expect(decideFollowCamera(base({ legMode: null })).zoom).toBe(
        FOLLOW_ZOOM_ACCESS
      )
    })
  })

  describe('accuracy gate', () => {
    it('does not move for a fix worse than the shared accuracy ceiling', () => {
      const d = decideFollowCamera(base({ fix: fix({ accuracyM: 101 }) }))
      expect(d.move).toBe(false)
      expect(d.reason).toBe('accuracy')
    })

    it('lets a null accuracy through (same philosophy as fix trust)', () => {
      expect(
        decideFollowCamera(base({ fix: fix({ accuracyM: null }) })).move
      ).toBe(true)
    })
  })

  describe('dead-band', () => {
    it('ignores GPS jitter around a stationary rider', () => {
      const d = decideFollowCamera(
        base({
          fix: fix({ lat: JITTER_LAT, timestampMs: T0 + 1000 }),
          prevAccepted: { ...BASE, timestampMs: T0 }
        })
      )
      expect(d.move).toBe(false)
      expect(d.reason).toBe('deadband')
    })

    it('follows genuine movement, without emitting zoom per fix', () => {
      const d = decideFollowCamera(
        base({
          fix: fix({ lat: STEP_LAT, timestampMs: T0 + 1000 }),
          prevAccepted: { ...BASE, timestampMs: T0 },
          prevLegTransit: false
        })
      )
      expect(d.move).toBe(true)
      expect(d.reason).toBe('follow')
      expect(d.center).toEqual([BASE.lng, STEP_LAT])
      // The rider's pinch level survives while following.
      expect(d.zoom).toBeUndefined()
    })
  })

  describe('spike gate (two-tick confirmation)', () => {
    it('rejects a teleport-scale jump once', () => {
      const d = decideFollowCamera(
        base({
          fix: fix({ lat: SPIKE_LAT, timestampMs: T0 + 1000 }),
          prevAccepted: { ...BASE, timestampMs: T0 }
        })
      )
      expect(d.move).toBe(false)
      expect(d.reason).toBe('spike-rejected')
    })

    it('accepts on the second tick when the fix lands near the rejected point', () => {
      const d = decideFollowCamera(
        base({
          // Still a spike vs prevAccepted, but ~20 m from the rejected point:
          // genuine re-acquisition, not noise.
          fix: fix({ lat: SPIKE_LAT + 0.00018, timestampMs: T0 + 2000 }),
          prevAccepted: { ...BASE, timestampMs: T0 },
          prevRejectedSpike: { lat: SPIKE_LAT, lng: BASE.lng }
        })
      )
      expect(d.move).toBe(true)
      expect(d.reason).toBe('spike-confirmed')
    })

    it('keeps rejecting when the second fix is nowhere near the first spike', () => {
      const d = decideFollowCamera(
        base({
          // A different teleport (southward): noise, not re-acquisition.
          fix: fix({ lat: BASE.lat - 0.047, timestampMs: T0 + 2000 }),
          prevAccepted: { ...BASE, timestampMs: T0 },
          prevRejectedSpike: { lat: SPIKE_LAT, lng: BASE.lng }
        })
      )
      expect(d.move).toBe(false)
      expect(d.reason).toBe('spike-rejected')
    })

    it('clamps dt to 500 ms so same-timestamp fixes cannot fake a spike', () => {
      // 20 m at dt=0 would be an infinite implied speed without the clamp;
      // with it, 20 m / 0.5 s = 40 m/s — an honest move.
      const d = decideFollowCamera(
        base({
          fix: fix({ lat: STEP_LAT, timestampMs: T0 }),
          prevAccepted: { ...BASE, timestampMs: T0 }
        })
      )
      expect(d.move).toBe(true)
    })
  })

  describe('gap acceptance', () => {
    it('accepts any jump after a long GPS gap (tunnel, backgrounded)', () => {
      const d = decideFollowCamera(
        base({
          fix: fix({
            lat: SPIKE_LAT,
            timestampMs: T0 + FOLLOW_GAP_ACCEPT_MS + 1
          }),
          prevAccepted: { ...BASE, timestampMs: T0 }
        })
      )
      expect(d.move).toBe(true)
      expect(d.reason).toBe('gap-accept')
    })
  })

  describe('zoom on leg-type change', () => {
    it('emits the transit zoom when the rider boards (access -> transit)', () => {
      const d = decideFollowCamera(
        base({
          fix: fix({ lat: STEP_LAT, timestampMs: T0 + 1000 }),
          legMode: 'BUS',
          prevAccepted: { ...BASE, timestampMs: T0 },
          prevLegTransit: false
        })
      )
      expect(d.move).toBe(true)
      expect(d.zoom).toBe(FOLLOW_ZOOM_TRANSIT)
    })

    it('emits the access zoom when the rider alights (transit -> access)', () => {
      const d = decideFollowCamera(
        base({
          fix: fix({ lat: STEP_LAT, timestampMs: T0 + 1000 }),
          legMode: 'WALK',
          prevAccepted: { ...BASE, timestampMs: T0 },
          prevLegTransit: true
        })
      )
      expect(d.zoom).toBe(FOLLOW_ZOOM_ACCESS)
    })

    it('stays silent on zoom while the leg type is unchanged', () => {
      const d = decideFollowCamera(
        base({
          fix: fix({ lat: STEP_LAT, timestampMs: T0 + 1000 }),
          legMode: 'BUS',
          prevAccepted: { ...BASE, timestampMs: T0 },
          prevLegTransit: true
        })
      )
      expect(d.zoom).toBeUndefined()
    })
  })
})
