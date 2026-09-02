import type { Leg } from '@opentripplanner/types'

import type { RidingState } from './types'

/**
 * The rider's own say on whether they are aboard (rider ask, 2026-09-01;
 * backlog 6.10c).
 *
 * The board gate that shipped with 6.1 is strict on purpose: a GPS-only
 * establishment now needs an accurate fix, tight distance AND sixty seconds of
 * dwell within 120 m of the boarding stop, because four times across two rides
 * the app decided the rider was on a bus while they were on a bicycle — once
 * 4.3 km from the stop. A strict gate has a cost the loose one did not, and it
 * is the obvious one: a rider who really did board — early, at an unmapped
 * kerb, on a bus that is not in the vehicle feed — now has to wait for the
 * evidence to catch up.
 *
 * So the gate gets a manual override in both directions, on the trip sheet
 * the rider already opens mid-ride. Not a prompt: `feedback_no_redundant_prompts`
 * is explicit that the app must not ask what it already knows, and it knows
 * which bus is in the itinerary. A pair of buttons the rider may tap is a
 * different thing from a modal that interrupts them to ask.
 *
 * What is offered is decided here, purely, so it can be pinned in tests:
 *
 *  - nothing at all unless a transit leg is the current one or the next one.
 *    Off a bus and not heading for one, "am I on the bus" is not a question;
 *  - "I'm on the bus" while riding is unset. It resolves through the SAME
 *    `confirmVehicleSelection` the boarding prompt's own buttons use, so the
 *    riding fact it writes carries a real vehicle and trip id rather than a
 *    rider-shaped guess — and when no vehicle is matched yet, the existing
 *    boarding prompt is what opens, listing the buses actually nearby;
 *  - "Not on the bus" while riding is set, whatever established it. The rider
 *    outranks the matcher; that is the whole point.
 */

export const BOARDING_CONFIRM = 'confirm'
export const BOARDING_DENY = 'deny'

export type BoardingOffer = typeof BOARDING_CONFIRM | typeof BOARDING_DENY

/**
 * How long a denial holds the automatic board gate off.
 *
 * A rider who has just said "no, I'm still on my bike" must not watch the
 * matcher put them back on the bus on the next tick — that is the 09-01
 * complaint word for word ("Algo is too aggressive about matching me to
 * busss, I'm still on my bike"), and an override that lasts one second is
 * worse than none because it teaches the rider the button does nothing.
 *
 * Three minutes: long enough to ride clear of the stop that produced the false
 * match at any plausible speed, short enough that a rider who denies and then
 * genuinely boards the next bus is not stranded off-trip. It is a hold on
 * GPS-only establishment only — see ridingSuppressedByRider — so real evidence
 * (a matched vehicle, the rider tapping "I'm on the bus") still lands at once.
 */
export const BOARDING_DENIAL_HOLD_MS = 180000

/**
 * Is a rider's "not on the bus" still in force? False for a denial that never
 * happened or has aged out.
 */
export function boardingDenialHolds(
  deniedAtMs: number | null | undefined,
  nowMs: number
): boolean {
  if (deniedAtMs == null || !Number.isFinite(deniedAtMs)) return false
  if (!Number.isFinite(nowMs)) return false
  const age = nowMs - deniedAtMs
  return age >= 0 && age < BOARDING_DENIAL_HOLD_MS
}

/**
 * Should an automatic riding establishment be held back because the rider just
 * said they are not aboard?
 *
 * Only a decision with NO vehicle behind it is held. A rider denial is a
 * statement about the app's guess, not a veto on reality: if the matcher comes
 * back with an actual vehicle id — or the rider taps the other button — the
 * fact is evidenced and lands immediately. Retaining a riding fact that was
 * already held is likewise untouched; this only ever refuses to CREATE one.
 */
export function ridingSuppressedByRider(input: {
  deniedAtMs: number | null | undefined
  /** The riding fact the decision wants to write. */
  next: RidingState | null | undefined
  nowMs: number
  /** The riding fact already held, if any. */
  prev: RidingState | null | undefined
}): boolean {
  const { deniedAtMs, next, nowMs, prev } = input
  if (prev) return false
  if (!next) return false
  if (next.vehicleId || next.tripId) return false
  return boardingDenialHolds(deniedAtMs, nowMs)
}

/**
 * What the trip sheet should offer the rider right now, and which vehicle a
 * confirmation should name.
 */
export function resolveBoardingOffer(input: {
  currentLeg: Leg | undefined
  /** The best vehicle the matcher currently has, if any. */
  matchedVehicleId?: string | null
  nextLeg: Leg | undefined
  riding: RidingState | null | undefined
}): { offer: BoardingOffer | null; vehicleId: string | null } {
  const { currentLeg, matchedVehicleId, nextLeg, riding } = input
  const busInPlay = !!currentLeg?.transitLeg || !!nextLeg?.transitLeg
  if (!busInPlay) return { offer: null, vehicleId: null }
  if (riding) return { offer: BOARDING_DENY, vehicleId: null }
  return { offer: BOARDING_CONFIRM, vehicleId: matchedVehicleId || null }
}
