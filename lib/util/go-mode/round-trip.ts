import { Itinerary, Leg } from '@opentripplanner/types'

import { epochMs } from './time'
import { getLegRouteId } from './departure-anchor'

/**
 * Round-trip planning — the shared contract between the planner side (the
 * search form, the return-options panel under an outbound itinerary) and the
 * Go Mode side (the countdown at the destination, the "leave for the return"
 * alerts, and starting the return trip).
 *
 * Model: the rider plans OUT to a destination and says how long they will stay.
 * The return is planned as a second, isolated OTP query from the outbound
 * itinerary's `to` back to its `from`, departing at
 * `outbound.endTime + stayMinutes`. The chosen return itinerary rides into Go
 * Mode with the outbound one; once the rider has arrived, Go Mode counts down
 * to `leaveByMs` — the return itinerary's own `startTime`, which in OTP already
 * includes the access walk to the first stop — and lets them start the return
 * as a fresh trip.
 *
 * Everything in here is pure: no clock, no store, no bridge. Clocks come in as
 * `nowMs` so the cadence is unit-testable and follows the simulated clock.
 */

export const DEFAULT_STAY_MINUTES = 60

/** The chips the form offers. "Custom" is any other positive integer. */
export const STAY_OPTIONS_MINUTES = [30, 60, 90, 120, 180, 240]

export interface RoundTripPlace {
  lat: number
  lon: number
  name?: string
}

export interface RoundTripPlan {
  /** Where the rider is staying — the outbound `to`. */
  destination: RoundTripPlace
  /**
   * When the rider has to leave the destination: `epochMs(returnItinerary.startTime)`.
   * Recomputed whenever `returnItinerary` is replaced by a fresher plan.
   */
  leaveByMs: number
  /** Where the return ends — the outbound `from`. */
  origin: RoundTripPlace
  /** outbound.endTime + stayMinutes: the departure the return was planned for. */
  plannedDepartMs: number
  /**
   * Set once the return plan has been re-fetched with live data near the
   * departure (see `shouldRefreshReturnPlan`). Null until then.
   */
  refreshedAtMs: number | null
  returnItinerary: Itinerary
  stayMinutes: number
}

/** Departure the return query asks for. NaN when the outbound has no usable end. */
export function returnDepartureMs(
  outbound: Itinerary | null | undefined,
  stayMinutes: number
): number {
  const end = epochMs(outbound?.endTime)
  if (!Number.isFinite(end)) return NaN
  return end + Math.max(0, stayMinutes) * 60000
}

export function placeOf(place: any): RoundTripPlace | null {
  if (!place) return null
  const lat = Number(place.lat)
  const lon = Number(place.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { lat, lon, name: place.name }
}

/**
 * The transit identity of an itinerary: its route ids in order. Two departures
 * of "walk, 18, walk" share a sequence; "18 then 4" does not. This is the
 * identity the rider's choice is about — a fresher plan that keeps it is the
 * same trip at a later time, which is the standing rule for automatic updates
 * (same route, next departure; never a different route without asking).
 */
export function routeSequence(itinerary: Itinerary | null | undefined): string {
  if (!itinerary) return ''
  return (itinerary.legs || [])
    .filter((l: Leg) => l.transitLeg || !!getLegRouteId(l))
    .map((l: Leg) => getLegRouteId(l) || l.mode)
    .join('>')
}

/**
 * Among fresh candidates, the one that keeps the rider's chosen routes; else
 * the first candidate; else null. Candidates are assumed already sorted the
 * way the planner sorts them (soonest / cheapest first).
 */
export function pickReturnItinerary(
  candidates: Itinerary[] | null | undefined,
  preferred: Itinerary | null | undefined
): Itinerary | null {
  if (!candidates || candidates.length === 0) return null
  const want = routeSequence(preferred)
  if (want) {
    const same = candidates.find((c) => routeSequence(c) === want)
    if (same) return same
  }
  return candidates[0]
}

export function buildRoundTripPlan(input: {
  outbound: Itinerary
  returnItinerary: Itinerary
  stayMinutes: number
}): RoundTripPlan | null {
  const { outbound, returnItinerary, stayMinutes } = input
  const legs = outbound.legs || []
  const origin = placeOf(legs[0]?.from)
  const destination = placeOf(legs[legs.length - 1]?.to)
  const plannedDepartMs = returnDepartureMs(outbound, stayMinutes)
  const leaveByMs = epochMs(returnItinerary.startTime)
  if (
    !origin ||
    !destination ||
    !Number.isFinite(plannedDepartMs) ||
    !Number.isFinite(leaveByMs)
  ) {
    return null
  }
  return {
    destination,
    leaveByMs,
    origin,
    plannedDepartMs,
    refreshedAtMs: null,
    returnItinerary,
    stayMinutes
  }
}

/** A plan with a fresher return itinerary swapped in (leaveByMs follows it). */
export function withReturnItinerary(
  plan: RoundTripPlan,
  returnItinerary: Itinerary,
  nowMs: number
): RoundTripPlan {
  const leaveByMs = epochMs(returnItinerary.startTime)
  if (!Number.isFinite(leaveByMs)) return plan
  return { ...plan, leaveByMs, refreshedAtMs: nowMs, returnItinerary }
}

// ---------------------------------------------------------------------------
// The countdown at the destination
// ---------------------------------------------------------------------------

/**
 * Stable native notification ids — see TURN_CARD_NOTIFICATION_ID (=1),
 * PACING_CARD_NOTIFICATION_ID (=2) and MISSED_BUS_NOTICE_ID (=3) for why small
 * ints are safe. Two ids, not one: "leave in 10 min" and "leave now" are both
 * worth a buzz, and a replace-by-id would swallow the second one on the wrist
 * if it arrived while the first was still showing.
 */
export const RETURN_LEAVE_SOON_NOTIFICATION_ID = 4
export const RETURN_LEAVE_NOW_NOTIFICATION_ID = 5

/** Minutes before leaveBy at which the "leave soon" alert fires. */
export const RETURN_LEAVE_SOON_MIN = 10
/** Minutes before leaveBy at which the return plan is refreshed with live data. */
export const RETURN_REFRESH_BEFORE_MIN = 15
/**
 * How long past leaveBy the countdown is still shown as "leave now" before it
 * is treated as missed. Post-arrival ticks run every 30 s, so a threshold is
 * never crossed exactly; the floor is what lets a late tick still deliver.
 */
export const RETURN_MISSED_AFTER_MIN = 20

export type ReturnCountdownStage = 'far' | 'soon' | 'now' | 'missed'

export interface ReturnCountdownState {
  /** leaveByMs the stage was computed against; a refreshed plan re-arms it. */
  leaveByMs: number
  stage: ReturnCountdownStage
}

export interface ReturnCountdownPost {
  id: number
  message: string
  passive: boolean
  title: string
}

export interface ReturnCountdownDecision {
  next: ReturnCountdownState
  /** An alert to raise on this tick; at most one. */
  post: ReturnCountdownPost | null
}

export function returnCountdownStage(
  nowMs: number,
  leaveByMs: number
): ReturnCountdownStage {
  const remainingMin = (leaveByMs - nowMs) / 60000
  if (remainingMin <= -RETURN_MISSED_AFTER_MIN) return 'missed'
  if (remainingMin <= 0) return 'now'
  if (remainingMin <= RETURN_LEAVE_SOON_MIN) return 'soon'
  return 'far'
}

/**
 * Pure stage machine. Alerts fire on a stage TRANSITION only, so a 30 s tick
 * cadence raises each of them once; a restart at the destination resumes from
 * the persisted `prev` and does not re-fire. When the plan's leaveBy moves
 * (a refresh adopted a later departure) the stage is recomputed against the
 * new time and can legitimately go backwards without alerting.
 *
 * Copy is the numbers the rider acts on, no clock times, no coaching.
 */
export function evaluateReturnCountdown(
  prev: ReturnCountdownState | null,
  input: { leaveByMs: number; nowMs: number }
): ReturnCountdownDecision {
  const { leaveByMs, nowMs } = input
  const stage = returnCountdownStage(nowMs, leaveByMs)
  const next: ReturnCountdownState = { leaveByMs, stage }
  const rearmed = !prev || prev.leaveByMs !== leaveByMs
  const prevStage = rearmed ? null : prev!.stage

  let post: ReturnCountdownPost | null = null
  const order: ReturnCountdownStage[] = ['far', 'soon', 'now', 'missed']
  const advanced =
    prevStage == null
      ? // First evaluation: only alert if we are already inside a live window,
        // never for a stage the rider has sat in since before this evaluator
        // existed (a resume long past leaveBy should not buzz "leave now").
        stage === 'soon' || stage === 'now'
      : order.indexOf(stage) > order.indexOf(prevStage)

  if (advanced && stage === 'soon') {
    const min = Math.max(1, Math.round((leaveByMs - nowMs) / 60000))
    post = {
      id: RETURN_LEAVE_SOON_NOTIFICATION_ID,
      message: '',
      passive: false,
      title: `↩ Leave in ${min} min`
    }
  } else if (advanced && stage === 'now') {
    post = {
      id: RETURN_LEAVE_NOW_NOTIFICATION_ID,
      message: '',
      passive: false,
      title: '↩ Leave now'
    }
  }
  return { next, post }
}

/**
 * The candidate a live REFRESH should adopt, or null to keep what the rider
 * already has.
 *
 * Different question from {@link pickReturnItinerary}, which is "start the
 * return now, what do I ride". A refresh is not a new choice: the rider picked
 * a route sequence when they planned the round trip, and the only thing a
 * refresh may change is WHICH RUN of it they are counting down to. So
 * candidates on a different route sequence are not considered at all (returning
 * null keeps the stored itinerary), and among the ones that match, the closest
 * departure to the old `leaveByMs` wins rather than the soonest — a refresh
 * that jumped the rider onto a run 40 minutes earlier because it happened to be
 * first in the list would be a forced route change by another name.
 */
export function pickRefreshedReturn(
  candidates: Itinerary[] | null | undefined,
  plan: RoundTripPlan | null | undefined
): Itinerary | null {
  if (!candidates || candidates.length === 0 || !plan) return null
  const want = routeSequence(plan.returnItinerary)
  if (!want) return null
  let best: Itinerary | null = null
  let bestDelta = Infinity
  candidates.forEach((c) => {
    if (routeSequence(c) !== want) return
    const start = epochMs(c.startTime)
    if (!Number.isFinite(start)) return
    const delta = Math.abs(start - plan.leaveByMs)
    if (delta < bestDelta) {
      best = c
      bestDelta = delta
    }
  })
  return best
}

/** One live refresh, inside the window, never repeated. */
export function shouldRefreshReturnPlan(
  plan: RoundTripPlan | null | undefined,
  nowMs: number
): boolean {
  if (!plan || plan.refreshedAtMs != null) return false
  const remainingMin = (plan.leaveByMs - nowMs) / 60000
  return (
    remainingMin <= RETURN_REFRESH_BEFORE_MIN &&
    remainingMin > -RETURN_MISSED_AFTER_MIN
  )
}

/** mm:ss (or h:mm:ss) for the on-screen countdown; negative shows as "-m:ss". */
export function formatCountdown(remainingMs: number): string {
  const neg = remainingMs < 0
  const total = Math.floor(Math.abs(remainingMs) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const body = `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
  return neg ? `-${body}` : body
}
