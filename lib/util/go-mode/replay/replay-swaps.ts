/**
 * The rider's own plan changes, re-applied when a replay reaches them (75.30).
 *
 * A fixture's `itinerarySwaps` are every itinerary Go Mode installed after the
 * trip began. The replay engine serves OTP's answers, but a swap the RIDER
 * made — Start on another planner result, the onboard Confirm, the
 * faster-route Switch, "I'm on this bus", a departure pick — is not an OTP
 * read, and until this a replay simply lost it: 2026-10-26 12:17:00 the rider
 * replaced the D Line plan with an Orange Line plan from the planner, and the
 * replay of that ride guided the abandoned D Line plan for the next 44
 * minutes — leg 0 to the end, "Routing stops here" at 12:37:12, "Leave in
 * 1 min" for the D Line at 12:52:51 and a missed-bus push at 12:59:08 for a
 * rider 79 m from their door.
 *
 * Only the rider's swaps are re-applied. A swap the APP made (a quiet access
 * re-plan, a missed-bus update, a re-target, Auto's switches) is the app's
 * decision, the thing a replay exists to test: force-feeding it would replay
 * the ride's answer instead of asking the app for its own. Who made each swap
 * is written into the fixture by build-fixture.js (`swapCause`, and
 * `--annotate-swaps` for a fixture cut before it existed); a swap without
 * that record is left to the app like an app swap.
 *
 * Kept free of actions/* imports, like replay-engine.ts, so go-mode.ts can use
 * it without a cycle.
 */
import type { Itinerary, Leg } from '@opentripplanner/types'

import { getLegRouteId } from '../departure-anchor'

/** build-fixture.js `swapCause`: who installed the swap's itinerary. */
export type SwapAuthor = 'rider' | 'app' | 'unknown'

export interface RecordedSwap {
  /** Absent on a fixture built (and not annotated) before 2026-10-29. */
  by?: SwapAuthor
  /** The control, re-plan reason or marker `by` was read from. */
  cause?: string | null
  itinerary: any
  /** Start Trip on a planner result: the START_GO_MODE said `newTrip`. */
  newTrip?: boolean
  tMs: number
}

/** Why a swap the replay reached was left alone. */
export type SwapSkipReason =
  /** The app installed it on the ride; the replayed app decides for itself. */
  | 'app-made'
  /** The day file showed no cause for it (a ride before the markers). */
  | 'cause-unknown'
  /** The fixture does not say who made it (not annotated). */
  | 'cause-not-recorded'
  /** The replayed app is on this plan already (its own doing or a swap's). */
  | 'already-installed'
  /** Go Mode is not running in the replay any more. */
  | 'no-trip'
  /** The recorded track ended before the swap's time. */
  | 'after-track'

export type SwapVerdict =
  | { apply: true }
  | { apply: false; why: SwapSkipReason }

/**
 * The swaps a replay that starts at `startMs` will reach, oldest first. A
 * swap at the start itself is part of the start (`fixture.itinerary` is the
 * start's own plan), so only later ones count.
 */
export function pendingReplaySwaps(
  swaps: RecordedSwap[] | null | undefined,
  startMs: number
): RecordedSwap[] {
  return (swaps || [])
    .filter((s) => s?.itinerary && Number.isFinite(s.tMs) && s.tMs > startMs)
    .sort((a, b) => a.tMs - b.tMs)
}

/**
 * A plan as the rider rides it: the run each transit leg takes — its trip id,
 * or where a leg names none, its route, boarding stop and departure minute.
 * Access legs are left out on purpose: the app re-plans them from wherever
 * the rider is, so two installs of the same bus differ there by design.
 */
export function transitPlanKey(
  itinerary: Itinerary | null | undefined
): string {
  return (itinerary?.legs || [])
    .filter((l: Leg) => l?.transitLeg)
    .map((l: Leg) => {
      const tripId = (l as any).trip?.gtfsId || (l as any).tripId
      if (tripId) return String(tripId)
      const stopId = (l.from as any)?.stop?.gtfsId || (l.from as any)?.stopId
      return `${getLegRouteId(l) || ''}@${stopId || ''}@${Math.floor(
        Number(l.startTime) / 60000
      )}`
    })
    .join('|')
}

/** Same runs from the same stops; with no transit at all, the same modes. */
function samePlan(a: Itinerary, b: Itinerary): boolean {
  const ka = transitPlanKey(a)
  const kb = transitPlanKey(b)
  if (ka || kb) return ka === kb
  const modes = (it: Itinerary) => (it.legs || []).map((l) => l.mode).join('|')
  return modes(a) === modes(b)
}

/**
 * Whether the replay re-applies `swap` now: only the rider's, only onto a
 * running trip, and only when the replayed app is not already on that plan.
 */
export function replaySwapVerdict(
  swap: RecordedSwap,
  goMode: { activeItinerary?: Itinerary | null; isActive?: boolean } | null
): SwapVerdict {
  if (swap.by == null) return { apply: false, why: 'cause-not-recorded' }
  if (swap.by === 'app') return { apply: false, why: 'app-made' }
  if (swap.by !== 'rider') return { apply: false, why: 'cause-unknown' }
  if (!goMode?.isActive || !goMode.activeItinerary) {
    return { apply: false, why: 'no-trip' }
  }
  if (samePlan(goMode.activeItinerary, swap.itinerary)) {
    return { apply: false, why: 'already-installed' }
  }
  return { apply: true }
}
