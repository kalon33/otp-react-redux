import {
  buildRoundTripPlan,
  evaluateReturnCountdown,
  formatCountdown,
  pickRefreshedReturn,
  pickReturnItinerary,
  RETURN_LEAVE_NOW_NOTIFICATION_ID,
  RETURN_LEAVE_SOON_NOTIFICATION_ID,
  returnDepartureMs,
  routeSequence,
  shouldRefreshReturnPlan
} from '../../../lib/util/go-mode/round-trip'
import type {
  ReturnCountdownState,
  RoundTripPlan
} from '../../../lib/util/go-mode/round-trip'

/**
 * The round-trip contract: the pure half of the feature, shared by the planner
 * (which builds the plan) and Go Mode (which counts it down). Everything that
 * decides WHEN the rider is told to leave for the return lives here, so this is
 * where the cadence is proved — the tick itself is only wiring.
 */

const MIN = 60000
const NOW = 1_788_537_600_000

const walk = (startMs: number, endMs: number) => ({
  endTime: endMs,
  from: { lat: 44.9, lon: -93.3, name: 'A' },
  mode: 'WALK',
  startTime: startMs,
  to: { lat: 44.86, lon: -93.29, name: 'B' },
  transitLeg: false
})

const bus = (routeId: string, startMs: number, endMs: number) => ({
  endTime: endMs,
  from: { lat: 44.9, lon: -93.3, name: 'Stop A' },
  mode: 'BUS',
  route: { id: routeId },
  routeShortName: routeId.split(':')[1],
  startTime: startMs,
  to: { lat: 44.86, lon: -93.29, name: 'Stop B' },
  transitLeg: true
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const itin = (startMs: number, endMs: number, legs: any[]): any => ({
  endTime: endMs,
  legs,
  startTime: startMs
})

const outbound = itin(NOW, NOW + 30 * MIN, [
  walk(NOW, NOW + 5 * MIN),
  bus('1:21', NOW + 5 * MIN, NOW + 28 * MIN),
  walk(NOW + 28 * MIN, NOW + 30 * MIN)
])

const returnItinerary = itin(NOW + 150 * MIN, NOW + 180 * MIN, [
  walk(NOW + 150 * MIN, NOW + 152 * MIN),
  bus('1:21', NOW + 152 * MIN, NOW + 178 * MIN),
  walk(NOW + 178 * MIN, NOW + 180 * MIN)
])

const plan = (): RoundTripPlan =>
  buildRoundTripPlan({
    outbound,
    returnItinerary,
    stayMinutes: 120
  }) as RoundTripPlan

describe('util > go-mode > round-trip', () => {
  describe('buildRoundTripPlan', () => {
    it('reads the return ends off the OUTBOUND itinerary, reversed', () => {
      const p = plan()
      // Origin is where the rider started; destination is where they are
      // staying. The return runs destination -> origin.
      expect(p.origin).toEqual({ lat: 44.9, lon: -93.3, name: 'A' })
      expect(p.destination).toEqual({ lat: 44.86, lon: -93.29, name: 'B' })
    })

    it("takes leaveByMs from the return itinerary's OWN start, not the stay", () => {
      const p = plan()
      // The stay says "leave at +150 min"; OTP answered with a departure at
      // +150 exactly here, but the two are different facts and the countdown
      // must follow the itinerary the rider will actually ride.
      expect(p.plannedDepartMs).toBe(returnDepartureMs(outbound, 120))
      expect(p.leaveByMs).toBe(NOW + 150 * MIN)
      expect(p.refreshedAtMs).toBeNull()
    })

    it('returns null when the outbound has no usable end', () => {
      expect(
        buildRoundTripPlan({
          outbound: itin(NOW, NaN, [walk(NOW, NOW + 5 * MIN)]),
          returnItinerary,
          stayMinutes: 60
        })
      ).toBeNull()
    })
  })

  describe('routeSequence', () => {
    it('is the transit route ids in order, and ignores the access legs', () => {
      expect(routeSequence(returnItinerary)).toBe('1:21')
      expect(
        routeSequence(
          itin(NOW, NOW + MIN, [
            walk(NOW, NOW + MIN),
            bus('1:21', NOW, NOW + MIN),
            bus('1:4', NOW, NOW + MIN)
          ])
        )
      ).toBe('1:21>1:4')
    })

    it('distinguishes a transfer from the same routes in the other order', () => {
      const a = itin(NOW, NOW + MIN, [
        bus('1:21', NOW, NOW + MIN),
        bus('1:4', NOW, NOW + MIN)
      ])
      const b = itin(NOW, NOW + MIN, [
        bus('1:4', NOW, NOW + MIN),
        bus('1:21', NOW, NOW + MIN)
      ])
      expect(routeSequence(a)).not.toBe(routeSequence(b))
    })

    it('is empty for a walk-only itinerary and for nothing at all', () => {
      expect(routeSequence(itin(NOW, NOW + MIN, [walk(NOW, NOW + MIN)]))).toBe(
        ''
      )
      expect(routeSequence(null)).toBe('')
    })
  })

  describe('pickReturnItinerary', () => {
    const sameRoute = itin(NOW + 200 * MIN, NOW + 230 * MIN, [
      bus('1:21', NOW + 200 * MIN, NOW + 230 * MIN)
    ])
    const otherRoute = itin(NOW + 190 * MIN, NOW + 220 * MIN, [
      bus('1:4', NOW + 190 * MIN, NOW + 220 * MIN)
    ])

    it("keeps the rider's chosen route even when another leaves sooner", () => {
      // The standing rule: automatic updates keep the chosen route and take the
      // next departure of it. A sooner bus on a different route is not an
      // improvement, it is a route change nobody asked for.
      expect(
        pickReturnItinerary([otherRoute, sameRoute], returnItinerary)
      ).toBe(sameRoute)
    })

    it('falls back to the first candidate when the route is gone', () => {
      expect(pickReturnItinerary([otherRoute], returnItinerary)).toBe(
        otherRoute
      )
    })

    it('is null when there is nothing to pick', () => {
      expect(pickReturnItinerary([], returnItinerary)).toBeNull()
      expect(pickReturnItinerary(null, returnItinerary)).toBeNull()
    })
  })

  describe('pickRefreshedReturn', () => {
    // A refresh is narrower than a pick: it may move the rider to a different
    // DEPARTURE of their sequence, never to a different route.
    const early = itin(NOW + 140 * MIN, NOW + 170 * MIN, [
      bus('1:21', NOW + 140 * MIN, NOW + 170 * MIN)
    ])
    const near = itin(NOW + 153 * MIN, NOW + 182 * MIN, [
      bus('1:21', NOW + 153 * MIN, NOW + 182 * MIN)
    ])
    const other = itin(NOW + 149 * MIN, NOW + 175 * MIN, [
      bus('1:4', NOW + 149 * MIN, NOW + 175 * MIN)
    ])

    it('takes the run CLOSEST to the planned departure, not the soonest', () => {
      expect(pickRefreshedReturn([early, near], plan())).toBe(near)
    })

    it('never adopts a different route, even one departing closer', () => {
      // `other` departs 1 min from leaveBy and `near` 3 min — but `other` is a
      // different bus, so the answer is `near`.
      expect(pickRefreshedReturn([other, near], plan())).toBe(near)
    })

    it('is null when nothing matches, which means "keep what we have"', () => {
      expect(pickRefreshedReturn([other], plan())).toBeNull()
      expect(pickRefreshedReturn([], plan())).toBeNull()
    })
  })

  describe('evaluateReturnCountdown', () => {
    const leaveByMs = NOW + 150 * MIN
    const at = (minsBefore: number, prev: ReturnCountdownState | null = null) =>
      evaluateReturnCountdown(prev, {
        leaveByMs,
        nowMs: leaveByMs - minsBefore * MIN
      })

    it('says nothing while the departure is far off', () => {
      const d = at(45)
      expect(d.next.stage).toBe('far')
      expect(d.post).toBeNull()
    })

    it('fires id 4 once when far -> soon, with the minutes and no clock time', () => {
      const far = at(45).next
      const d = at(9, far)
      expect(d.next.stage).toBe('soon')
      expect(d.post?.id).toBe(RETURN_LEAVE_SOON_NOTIFICATION_ID)
      expect(d.post?.title).toBe('↩ Leave in 9 min')
      // Rider rule: the copy is the number they act on. No clock time, no
      // coaching phrase, nothing to read at arm's length.
      expect(d.post?.message).toBe('')
      expect(d.post?.title).not.toMatch(/:\d\d/)
    })

    it('does not re-fire across the 30 s ticks that follow', () => {
      let state = at(45).next
      let posts = 0
      // Every 30 s from 12 min out to 30 s out: one crossing, one alert.
      for (let s = 12 * 60; s >= 30; s -= 30) {
        const d = evaluateReturnCountdown(state, {
          leaveByMs,
          nowMs: leaveByMs - s * 1000
        })
        if (d.post) posts++
        state = d.next
      }
      expect(posts).toBe(1)
      expect(state.stage).toBe('soon')
    })

    it('fires id 5 once when soon -> now', () => {
      const soon = at(9, at(45).next).next
      const d = at(-1, soon)
      expect(d.next.stage).toBe('now')
      expect(d.post?.id).toBe(RETURN_LEAVE_NOW_NOTIFICATION_ID)
      expect(d.post?.title).toBe('↩ Leave now')
      // ...and the next tick after that says nothing.
      expect(at(-2, d.next).post).toBeNull()
    })

    it('fires nothing on a FIRST evaluation deep in "missed"', () => {
      // A resume 40 minutes past the departure must not buzz "leave now" for a
      // bus that has long gone.
      const d = at(-40)
      expect(d.next.stage).toBe('missed')
      expect(d.post).toBeNull()
    })

    it('does alert on a first evaluation already inside a live window', () => {
      // The other half of that rule: arriving 6 min before the return IS worth
      // the buzz, and there is no prev to have crossed from.
      expect(at(6).post?.id).toBe(RETURN_LEAVE_SOON_NOTIFICATION_ID)
    })

    it('re-arms when a refresh moves leaveBy, without alerting for the move', () => {
      const soon = at(9, at(45).next).next
      expect(soon.stage).toBe('soon')
      // The refresh adopted a later run: 40 min out again.
      const later = leaveByMs + 31 * MIN
      const d = evaluateReturnCountdown(soon, {
        leaveByMs: later,
        nowMs: leaveByMs - 9 * MIN
      })
      expect(d.next).toEqual({ leaveByMs: later, stage: 'far' })
      expect(d.post).toBeNull()
      // ...and the new departure's own "soon" still fires when it arrives.
      expect(
        evaluateReturnCountdown(d.next, {
          leaveByMs: later,
          nowMs: later - 8 * MIN
        }).post?.id
      ).toBe(RETURN_LEAVE_SOON_NOTIFICATION_ID)
    })
  })

  describe('shouldRefreshReturnPlan', () => {
    const p = plan()
    const leaveByMs = p.leaveByMs

    it('is false outside the window and true inside it', () => {
      expect(shouldRefreshReturnPlan(p, leaveByMs - 20 * MIN)).toBe(false)
      expect(shouldRefreshReturnPlan(p, leaveByMs - 14 * MIN)).toBe(true)
      expect(shouldRefreshReturnPlan(p, leaveByMs - MIN)).toBe(true)
    })

    it('is false once the plan has been refreshed — one per plan', () => {
      expect(
        shouldRefreshReturnPlan(
          { ...p, refreshedAtMs: leaveByMs - 14 * MIN },
          leaveByMs - 10 * MIN
        )
      ).toBe(false)
    })

    it('gives up rather than re-planning a departure long gone', () => {
      expect(shouldRefreshReturnPlan(p, leaveByMs + 25 * MIN)).toBe(false)
    })

    it('is false for no plan at all', () => {
      expect(shouldRefreshReturnPlan(null, leaveByMs)).toBe(false)
    })
  })

  describe('formatCountdown', () => {
    it('is m:ss under an hour and h:mm:ss over it', () => {
      expect(formatCountdown(42 * MIN)).toBe('42:00')
      expect(formatCountdown(9 * MIN + 5000)).toBe('9:05')
      expect(formatCountdown(0)).toBe('0:00')
      expect(formatCountdown(2 * 3600000 + 3 * MIN + 4000)).toBe('2:03:04')
    })

    it('shows a passed departure as negative rather than counting up from zero', () => {
      expect(formatCountdown(-90000)).toBe('-1:30')
    })
  })
})
