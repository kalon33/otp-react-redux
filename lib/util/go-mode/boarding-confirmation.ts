import type { Leg } from '@opentripplanner/types'

import { matchProvesAboard } from './transit-trust'
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

/** What the boarding sheet shows under its title. */
export type BoardingPromptBody =
  | 'failed'
  | 'none'
  | 'routes'
  | 'searching'
  | 'vehicles'

/**
 * Which body the boarding prompt shows.
 *
 * The order matters, and the only interesting rule is the last one: an empty
 * vehicle list is NOT the same fact as a search that has not answered yet.
 * On 2026-09-13 the sheet said "No buses detected nearby" to a rider sitting
 * on a train 76 m away, because on an access leg nothing had ever written the
 * list it was reporting on. "No buses" is a finding, so it is reachable only
 * once a poll has been compared against the rider's position; while the search
 * is running the sheet says it is looking, and the manual route picker waits
 * too rather than pre-empting an answer that is seconds away.
 *
 * `failed` is the third member of that family and the same distinction one
 * step further out (17.5): a read that never came back is not a finding about
 * the world either. It ranks BELOW anything real — a vehicle the app did get,
 * or a route list to pick from, is worth more to the rider than an apology —
 * and above "none", which would otherwise report an outage as an empty street.
 */
export function boardingPromptBody(input: {
  nearbyRouteCount: number
  nearbyVehicleCount: number
  /** The last search's reads did not answer (timeout / unreachable). */
  searchFailed?: boolean
  searching: boolean
}): BoardingPromptBody {
  const { nearbyRouteCount, nearbyVehicleCount, searchFailed, searching } =
    input
  if (nearbyVehicleCount > 0) return 'vehicles'
  if (searching) return 'searching'
  if (nearbyRouteCount > 0) return 'routes'
  if (searchFailed) return 'failed'
  return 'none'
}

/**
 * A vehicle the app has ALREADY established the rider is on, if it holds one.
 *
 * The bus picker's fallback row (17.5). On 2026-09-15 at 15:47:25 the picker
 * showed the rider a blank body and "Which bus are you on? Pick it below."
 * while Go Mode was holding Orange Line trip 1:1346665 / vehicle 1:8140
 * underneath the whole time — every backing request was timing out (17.8), so
 * nothing could refill the list, and the one answer the app was sure of was
 * the one thing it did not offer.
 *
 * This is not a prompt and must not read as one (`feedback_no_redundant_prompts`
 * — the app never asks what it already knows). The picker is already open
 * because a search failed; the row is a shortcut through it, so the rider can
 * take the answer the app has instead of re-running a search that is timing
 * out.
 *
 * `tripId` is required: without one the onboard flow cannot anchor a schedule
 * or plan anything from it, so a row promising otherwise would be a dead end —
 * which is the bug, not the fix. A synthetic `route:<id>` vehicle (what
 * beginOnboardFlow builds when riding has no vehicle) is not a vehicle the
 * rider can be asked to accept either.
 */
export function knownAboardVehicle(input: {
  /** `goMode.alightedFrom` — the trip the rider last got OFF. */
  alightedFrom?: { tripId?: string | null; vehicleId?: string | null } | null
  /** `goMode.vehicleMatch.match`. */
  match?: {
    confidence?: string | null
    label?: string | null
    nextStopId?: string | null
    routeId?: string | null
    tripId?: string | null
    vehicleId?: string | null
  } | null
  /** `goMode.onboard.vehicle` — the flow's own adopted vehicle. */
  onboardVehicle?: {
    label?: string | null
    nextStopId?: string | null
    routeId?: string | null
    tripId?: string | null
    vehicleId?: string | null
  } | null
  riding?: RidingState | null
}): {
  label: string | null
  nextStopId: string | null
  routeId: string | null
  tripId: string
  vehicleId: string
} | null {
  const { alightedFrom, match, onboardVehicle, riding } = input
  // Order of trust: the vehicle THIS flow adopted, then a confirmed match
  // (the rider's own assertion, or the matcher's), then the riding fact. The
  // match is the only one that can outlive an alight, so it is the only one
  // asked to prove it still does.
  const candidates = [
    onboardVehicle,
    match?.confidence === 'confirmed' &&
    matchProvesAboard(match, alightedFrom ?? null)
      ? match
      : null,
    riding
      ? {
          label: riding.routeShortName ?? riding.headsign ?? riding.routeId,
          nextStopId: null,
          routeId: riding.routeId,
          tripId: riding.tripId,
          vehicleId: riding.vehicleId
        }
      : null
  ]
  for (const c of candidates) {
    const vehicleId = c?.vehicleId
    if (!c?.tripId || !vehicleId || vehicleId.startsWith('route:')) continue
    return {
      label: c.label ?? c.routeId ?? null,
      nextStopId: c.nextStopId ?? null,
      routeId: c.routeId ?? null,
      tripId: c.tripId,
      vehicleId
    }
  }
  return null
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
