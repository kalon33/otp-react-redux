/**
 * The minutes-until line Go Mode's cards count a bus down with.
 *
 * Lifted out of WalkingNavigation (2026-10-06, backlog 37.3) so the waiting
 * card states the countdown with the same rounding and the same floor as the
 * walking card, instead of growing a second copy that drifts.
 */

/**
 * How long past a departure time a card still counts down rather than calling
 * the bus gone. The epoch is a prediction and a bus dwells at the kerb, so a
 * few seconds either side is not evidence it has left; two minutes in the past
 * is (see formatMinutes / backlog 12.16).
 */
export const DEPARTED_GRACE_S = 30

/**
 * Minutes of an interval that is still AHEAD. `<1 min` is a floor, so a
 * negative interval must never reach it: handed −109 s at 10:09:22 on
 * 2026-09-08 it returned the floor string and the card said the bus "arrives
 * in <1 min" about a departure nearly two minutes in the past — that sentence,
 * not the wrong time, is what the rider answered with "Not true bus left"
 * (backlog 12.16). Gate a bus countdown with `hasElapsed` at its call site.
 */
export function formatMinutes(seconds: number): string {
  const mins = Math.round(seconds / 60)
  return mins <= 0 ? '<1 min' : `${mins} min`
}

/** The interval has run out — see formatMinutes. */
export function hasElapsed(seconds: number): boolean {
  return seconds < -DEPARTED_GRACE_S
}
