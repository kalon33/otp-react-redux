import { pickAccessReplanCandidate } from '../../../lib/util/state'

const walkLeg = (duration = 300) => ({ duration, mode: 'WALK' })
const bikeLeg = (duration = 300) => ({ duration, mode: 'BICYCLE' })
const busLeg = (routeId: string, startTime = 0) => ({
  mode: 'BUS',
  route: { gtfsId: routeId },
  startTime,
  transitLeg: true
})
const itin = (legs: any[], duration?: number) => ({
  duration: duration ?? legs.reduce((s, l) => s + (l.duration || 600), 0),
  legs
})

describe('pickAccessReplanCandidate', () => {
  describe('with a transit boarding still ahead', () => {
    it('only accepts an itinerary boarding the SAME route', () => {
      const same = itin([bikeLeg(), busLeg('1:904', 2000)])
      const other = itin([bikeLeg(), busLeg('1:540', 1000)], 600)
      expect(
        pickAccessReplanCandidate([other, same], {
          accessMode: 'BICYCLE',
          nextTransitRouteId: '1:904'
        })
      ).toBe(same)
    })

    it('returns null when nothing boards the kept route (leave trip alone)', () => {
      const other = itin([walkLeg(), busLeg('1:540')])
      expect(
        pickAccessReplanCandidate([other], {
          accessMode: 'WALK',
          nextTransitRouteId: '1:904'
        })
      ).toBeNull()
    })

    it('prefers the earliest same-route departure, not the shortest trip', () => {
      const later = itin([bikeLeg(60), busLeg('1:904', 5000)], 500)
      const earlier = itin([bikeLeg(600), busLeg('1:904', 2000)], 2000)
      expect(
        pickAccessReplanCandidate([later, earlier], {
          accessMode: 'BICYCLE',
          nextTransitRouteId: '1:904'
        })
      ).toBe(earlier)
    })
  })

  describe('with no transit remaining (pure access to destination)', () => {
    it('picks the fastest all-access itinerary', () => {
      const slow = itin([bikeLeg(900)])
      const fast = itin([bikeLeg(400)])
      expect(
        pickAccessReplanCandidate([slow, fast], { accessMode: 'BICYCLE' })
      ).toBe(fast)
    })

    it('rejects itineraries that add a transit boarding', () => {
      const withBus = itin([walkLeg(60), busLeg('1:904')], 300)
      const pureBike = itin([bikeLeg(900)])
      expect(
        pickAccessReplanCandidate([withBus, pureBike], {
          accessMode: 'BICYCLE'
        })
      ).toBe(pureBike)
    })

    it('never downgrades a biking rider to a walk-only itinerary', () => {
      const walkOnly = itin([walkLeg(600)])
      expect(
        pickAccessReplanCandidate([walkOnly], { accessMode: 'BICYCLE' })
      ).toBeNull()
    })

    it('allows walk-only when the rider is walking', () => {
      const walkOnly = itin([walkLeg(600)])
      expect(
        pickAccessReplanCandidate([walkOnly], { accessMode: 'WALK' })
      ).toBe(walkOnly)
    })

    it('handles empty input', () => {
      expect(pickAccessReplanCandidate([], { accessMode: 'WALK' })).toBeNull()
      expect(
        pickAccessReplanCandidate(undefined as any, { accessMode: 'WALK' })
      ).toBeNull()
    })
  })
})
