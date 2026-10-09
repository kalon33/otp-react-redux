/**
 * live-board-timer.ts — when the live board timer may poll (backlog 38.2).
 *
 * The boarding-stop, trip and board-route-vehicle polls used to run only
 * inside handlePositionUpdate, so they ran only when a fix arrived. On
 * 2026-09-30 (`muomy26h-g1zujp`) the rider waited on a platform under a station canopy: fixes
 * stopped at 17:06:09, and FETCHING_STOP_TIMES_FOR_STOP went from every ~20 s
 * to 17:07:03 and 17:08:03 — each riding the forced fix of a GPS watchdog
 * restart. The board the rider watched was up to a minute old.
 *
 * The timer covers that gap and nothing else. While fixes flow the tick keeps
 * the poll, because the tick also runs the departure anchor off the same
 * answer; the timer steps in only when the poll is due AND no fix has come in
 * for LIVE_BOARD_FIX_GAP_MS. One shared throttle (`lastPollAtMs`) means a
 * fix and a timer tick never both poll inside one interval.
 */
import type { Leg } from '@opentripplanner/types'

import { findBoardLegIndex } from './notification-service'

/** How often the timer looks. The poll itself is LIVE_LEG_TIMES_INTERVAL_MS. */
export const LIVE_BOARD_TIMER_MS = 3000

/**
 * How long without a fix before the timer takes the poll. Longer than a
 * healthy stream's gap (~1 s on the phone) so the tick, which also runs the
 * departure anchor, keeps the poll whenever it is there to take it.
 */
export const LIVE_BOARD_FIX_GAP_MS = 3000

export interface LiveBoardTimerInput {
  arrived: boolean
  isActive: boolean
  /** session.lastLiveLegTimesAt — the throttle the tick uses too. */
  lastPollAtMs: number
  /** session.lastPositionTickAt — the last fix handed to the tick. */
  lastPositionAtMs: number
  /** routeMatch.legIndex from the store — where the last tick put the rider. */
  legIndex: number | null | undefined
  /** Legs of the active itinerary. */
  legs: Leg[] | undefined
  nowMs: number
  /** LIVE_LEG_TIMES_INTERVAL_MS. */
  pollIntervalMs: number
  replay: boolean
  simulation: boolean
}

/** True when the timer should run the boarding-feed poll now. */
export function shouldTimerPollLiveBoard(input: LiveBoardTimerInput): boolean {
  if (!input.isActive || input.arrived) return false
  // Replay reproduces recorded data; simulation drives its own ticks.
  if (input.replay || input.simulation) return false
  if (input.nowMs - input.lastPollAtMs <= input.pollIntervalMs) return false
  // Fixes are flowing: the tick will take the poll within a second.
  if (input.nowMs - input.lastPositionAtMs < LIVE_BOARD_FIX_GAP_MS) return false
  const legs = input.legs
  const legIndex = input.legIndex
  if (!legs?.length || legIndex == null || legIndex < 0) return false
  // A transit leg current or ahead — on the last walk there is no board.
  return findBoardLegIndex(legs, legIndex) >= 0
}
