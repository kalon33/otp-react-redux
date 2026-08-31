import {
  checkForNotifications,
  checkRouteDeviation,
  resetConnectionWarnings,
  resetTurnAnnouncements
} from '../../../lib/util/go-mode/notification-service'
import { willQuietReplanAccessLeg } from '../../../lib/util/go-mode/deviation'

/**
 * "Off Route" on the 2026-08-27 and 08-28 rides: five cards in 27 minutes on the
 * afternoon, five more on the evening, under a dedup window that was 120 s the
 * whole time and never once matched.
 *
 * The window was not too short. It was being destroyed. checkRouteDeviation
 * dedups on `sentNotifications`, and START_GO_MODE (reducers/go-mode.ts) keeps
 * only the stop-keyed ids across an itinerary swap — so every swap wipes
 * `ROUTE_DEVIATION_deviation_*`. The swap is the quiet access-leg re-plan, and
 * the deviation is what asks for it: the alert was erasing its own suppression
 * through the fix it requested. Every sub-window repeat on the evening ride sits
 * on the far side of one of those swaps, ~1.8 s after the card that caused it:
 *
 *   17:12:57.065  Off Route (121 m)
 *   17:12:58.893  START_GO_MODE   <- dedup memory wiped here
 *   17:14:45.054  Off Route (121 m)     108 s after the first
 *   17:36:33.048  Off Route (124 m)
 *   17:36:34.922  START_GO_MODE   <- and here
 *   17:37:28.052  Off Route (120 m)      55 s after
 *
 * The times below are those events' real epochs, from
 * otp-debug-logs/debug-2026-08-28.jsonl (session mtdh67f3-0z5p24) and
 * debug-2026-08-27.jsonl (session mtbtyif4-axo9cm).
 */

const bikeLeg = { mode: 'BICYCLE', transitLeg: false } as any

// 8/28 evening, the second storm.
const FIRST_CARD_MS = 1787956593048 // 17:36:33.048
const SWAP_MS = 1787956594922 // 17:36:34.922, START_GO_MODE
const SECOND_CARD_MS = 1787956648052 // 17:37:28.052, 55.0 s later

// 8/27 afternoon: geometry moving under the rider, not a rider going off course.
const LEG_TRANSITION_MS = 1787854578814 // 13:16:18.814, TRANSITION_LEG
const AFTER_TRANSITION_MS = 1787854580064 // 13:16:20.064, "5464m from route"
const BOARDED_EARLIER_SWAP_MS = 1787854443175 // 13:14:03.175, START_GO_MODE
const AFTER_SWAP_MS = 1787854444084 // 13:14:04.084, 0.909 s later

describe('go-mode > the 2026-08-28 route-deviation storm', () => {
  beforeEach(() => {
    resetTurnAnnouncements()
    resetConnectionWarnings()
  })

  describe('a swap cannot reopen the window it just wiped', () => {
    it('holds 55 s after the last card even with the sent list emptied', () => {
      // sentNotifications is [] exactly as START_GO_MODE leaves it: the ONLY
      // memory of the 17:36:33 card is the session stamp.
      expect(
        checkRouteDeviation(124, [], bikeLeg, {
          geometryChangedAtMs: SWAP_MS,
          handledAtMs: FIRST_CARD_MS,
          nowMs: SECOND_CARD_MS
        })
      ).toBeNull()
    })

    it("holds 108 s after the last card, the evening ride's other repeat", () => {
      const firstCard = 1787955177065 // 17:12:57.065
      const swap = 1787955178893 // 17:12:58.893
      const repeat = 1787955285054 // 17:14:45.054
      expect(
        checkRouteDeviation(121, [], bikeLeg, {
          geometryChangedAtMs: swap,
          handledAtMs: firstCard,
          nowMs: repeat
        })
      ).toBeNull()
    })

    it('still speaks up for a rider who is simply, persistently off route', () => {
      // Past the 120 s cooldown, past the settle window, and nothing coming to
      // fix it. One card per deviation, not zero cards.
      const event = checkRouteDeviation(240, [], bikeLeg, {
        geometryChangedAtMs: FIRST_CARD_MS - 600000,
        handledAtMs: SECOND_CARD_MS - 121000,
        nowMs: SECOND_CARD_MS
      })
      expect(event).not.toBeNull()
      expect(event!.type).toBe('ROUTE_DEVIATION')
      expect(event!.message).toContain('240m')
    })
  })

  describe('geometry moving under the rider is not the rider drifting', () => {
    it('says nothing 1.25 s after a leg transition (08-27 13:16:20)', () => {
      expect(
        checkRouteDeviation(5464, [], bikeLeg, {
          geometryChangedAtMs: LEG_TRANSITION_MS,
          nowMs: AFTER_TRANSITION_MS
        })
      ).toBeNull()
    })

    it('says nothing 0.9 s after an itinerary swap (08-27 13:14:04)', () => {
      expect(
        checkRouteDeviation(239, [], bikeLeg, {
          geometryChangedAtMs: BOARDED_EARLIER_SWAP_MS,
          nowMs: AFTER_SWAP_MS
        })
      ).toBeNull()
    })

    it('speaks again once the rider has had time to converge', () => {
      // 25 s on from the swap: whatever the rider is doing now is their own.
      expect(
        checkRouteDeviation(239, [], bikeLeg, {
          geometryChangedAtMs: BOARDED_EARLIER_SWAP_MS,
          nowMs: BOARDED_EARLIER_SWAP_MS + 25001
        })
      ).not.toBeNull()
    })
  })

  describe('a problem the app is about to fix silently', () => {
    it('does not push while a quiet access-leg re-plan is imminent', () => {
      expect(
        checkRouteDeviation(121, [], bikeLeg, {
          nowMs: FIRST_CARD_MS,
          replanImminent: true
        })
      ).toBeNull()
    })

    it('pushes when nothing is coming', () => {
      expect(
        checkRouteDeviation(121, [], bikeLeg, {
          nowMs: FIRST_CARD_MS,
          replanImminent: false
        })
      ).not.toBeNull()
    })
  })

  describe('willQuietReplanAccessLeg — the question asked before the cards', () => {
    const base = {
      currentLeg: bikeLeg,
      distanceFromRoute: 124,
      lastReplanAtMs: FIRST_CARD_MS - 90000,
      nowMs: FIRST_CARD_MS,
      recentReplanAtMs: [],
      remainingAccessMeters: 670,
      reRouteStatus: 'idle'
    }

    it('is true for the drift that swapped the itinerary 1.9 s later', () => {
      expect(willQuietReplanAccessLeg(base)).toBe(true)
    })

    it('is false on a transit leg, which never quietly re-plans', () => {
      expect(
        willQuietReplanAccessLeg({
          ...base,
          currentLeg: { mode: 'BUS', transitLeg: true } as any,
          distanceFromRoute: 411
        })
      ).toBe(false)
    })

    it('is false while the drift is inside the mode threshold', () => {
      expect(
        willQuietReplanAccessLeg({ ...base, distanceFromRoute: 119 })
      ).toBe(false)
    })

    it('is false while the re-plan cooldown still has time to run', () => {
      // 670 m of leg left scales the cooldown to its 25 s floor.
      expect(
        willQuietReplanAccessLeg({
          ...base,
          lastReplanAtMs: FIRST_CARD_MS - 10000
        })
      ).toBe(false)
    })

    it('is false once the burst cap has closed re-planning down', () => {
      expect(
        willQuietReplanAccessLeg({
          ...base,
          recentReplanAtMs: [
            FIRST_CARD_MS - 200000,
            FIRST_CARD_MS - 150000,
            FIRST_CARD_MS - 90000
          ]
        })
      ).toBe(false)
    })
  })

  describe('the gate reaches checkRouteDeviation through checkForNotifications', () => {
    const progress = {
      currentLegIndex: 0,
      currentLegProgress: 40,
      estimatedArrival: new Date(SECOND_CARD_MS + 600000),
      overallProgress: 40,
      status: 'on_track' as const,
      timeRemaining: 600
    }
    const config = {
      enabled: true,
      soundEnabled: false,
      vibrationEnabled: true
    }

    it("suppresses the whole tick's card, not just the leaf call", () => {
      const notifications = checkForNotifications(
        progress as any,
        bikeLeg,
        0,
        undefined,
        124,
        [],
        config,
        [bikeLeg],
        undefined,
        {
          geometryChangedAtMs: SWAP_MS,
          handledAtMs: FIRST_CARD_MS,
          nowMs: SECOND_CARD_MS
        }
      )
      expect(
        notifications.filter((n) => n.type === 'ROUTE_DEVIATION')
      ).toHaveLength(0)
    })

    it('and lets it through when the gate has nothing to say', () => {
      const notifications = checkForNotifications(
        progress as any,
        bikeLeg,
        0,
        undefined,
        124,
        [],
        config,
        [bikeLeg],
        undefined,
        { nowMs: SECOND_CARD_MS }
      )
      expect(
        notifications.filter((n) => n.type === 'ROUTE_DEVIATION')
      ).toHaveLength(1)
    })
  })
})
