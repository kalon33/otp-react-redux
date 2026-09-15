/**
 * departure-anchor.ts — pure helpers for anchoring Go Mode to the soonest
 * live departure the rider can actually catch at the boarding stop.
 *
 * Extracted from WalkingNavigation (which still uses them for display) so the
 * action layer can dispatch the same value into goMode.departureOverride:
 * the itinerary's planned board time can be far later than the bus the rider
 * will really take (e.g. a later-departing itinerary was activated), and the
 * wait/notification math must target the real bus, not the planned one.
 */
import type { Leg } from '@opentripplanner/types'

import { epochMs } from './time'
import { mergeAndSortStopTimes } from '../stop-times'

// OTP realtimeState values that mean the time reflects live vehicle data
// (as opposed to the static schedule).
export const LIVE_REALTIME_STATES = new Set(['UPDATED', 'ADDED', 'MODIFIED'])

// Auto-anchor only when the catchable bus is at least this much earlier than
// the itinerary's planned board — small differences are realtime jitter, not
// a different bus.
export const AUTO_ANCHOR_MIN_GAIN_MS = 120000

// How long a departure stays catchable after its predicted time has passed.
// Absorbs a late bus that isn't reporting realtime; see getSoonestCatchableMs.
export const DEPARTURE_OVERDUE_GRACE_MS = 60000

// The rider must still have at least this much of the access leg left before
// the anchor is allowed to RELEASE an unreachable departure.
//
// It is the whole of the 7/22 protection. Standing at the stop the rider has
// no ride time left, so "unreachable" degenerates into "overdue" — and an
// overdue bus with no realtime is a LATE bus, not a gone one ("showed 465 at
// 0135 before mine even left"). Releasing is therefore only ever done to a
// rider who is still travelling toward the stop, where the deficit is a
// measured travel-time shortfall rather than a bus running behind.
export const RELEASE_MIN_RIDE_SECONDS = 60

export interface RouteDeparture {
  depMs: number
  realtime: boolean
  routeId?: string
  /**
   * The RUN this departure belongs to, when the feed names one. Load-bearing
   * for the card's hold (see resolveCardDeparture): a realtime->schedule flip
   * republishes the same trip at a different epoch, so a hold matched on
   * `depMs` alone would lose its bus the moment the feed went quiet and slide
   * onto the next run — the 2026-09-15 defect in miniature.
   */
  tripId?: string | null
}

/**
 * The service date `findStopTimesForStop` should be asked for so that it
 * returns the departures still runnable *now*: the local calendar date in the
 * feed's timezone, rolled back one day before the 03:30 service break
 * (SERVICE_BREAK in util/api — an after-midnight run belongs to yesterday's
 * service day). The naive `new Date().toISOString()` this replaces was the
 * UTC date, which from 7 PM CDT onward is already *tomorrow* — every evening
 * the anchor fetched a day with no catchable departures and went dead.
 */
export function currentServiceDate(nowMs: number, timeZone: string): string {
  const hourMin = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    timeZone
  }).format(nowMs)
  const beforeServiceBreak = hourMin < '03:30'
  return new Intl.DateTimeFormat('sv-SE', { timeZone }).format(
    beforeServiceBreak ? nowMs - 86400000 : nowMs
  )
}

/**
 * OTP2 returns the route as an object (leg.route.id, aliased to gtfsId);
 * legacy responses use a top-level leg.routeId. Match the stop-time gtfsId.
 */
export function getLegRouteId(leg?: Leg | null): string | null {
  const route = (leg as any)?.route
  return (
    (route && typeof route === 'object' ? route.id || route.gtfsId : null) ||
    (leg as any)?.routeId ||
    null
  )
}

/**
 * All upcoming departures of the given route at the boarding stop, from the
 * stop-times data in the transit index (sorted earliest first). Each entry
 * prefers the live (realtime) departure when the feed reports one and falls
 * back to the static schedule otherwise.
 */
export function getRouteDepartures(
  stopData: any,
  routeId: string | null
): RouteDeparture[] {
  if (!stopData || !routeId) return []
  try {
    return mergeAndSortStopTimes(stopData)
      .map((st: any) => {
        const live =
          LIVE_REALTIME_STATES.has(st.realtimeState) &&
          st.realtimeDeparture != null
        const secs = live ? st.realtimeDeparture : st.scheduledDeparture
        return {
          depMs: (st.serviceDay + secs) * 1000,
          realtime: live,
          routeId: st.route?.gtfsId || st.trip?.route?.gtfsId,
          tripId: st.trip?.gtfsId ?? st.trip?.id ?? null
        }
      })
      .filter((d: RouteDeparture) => d.routeId === routeId)
      .sort((a: RouteDeparture, b: RouteDeparture) => a.depMs - b.depMs)
  } catch {
    return []
  }
}

/**
 * Soonest departure the rider has a chance at. Leaving now they'd reach the
 * stop in ~`rideSecondsRemaining`, but OTP's bike-time estimate is
 * conservative — so also surface departures they'd reach by riding up to 25%
 * faster (capped at 3 min). If there's a chance, you see it.
 *
 * `graceMs` keeps a departure that is slightly overdue in the running. Standing
 * at the stop, `rideSecondsRemaining` is ~0, so without it a bus running a
 * minute late with no realtime update drops out of the list the instant its
 * scheduled time passes — and the anchor slides onto the NEXT trip while the
 * rider's bus is still on its way (7/22: "showed 465 at 0135 before mine even
 * left"). Whether a bus is truly gone is classifyMissedBus's call, not this
 * function's.
 */
export function getSoonestCatchableMs(
  departures: RouteDeparture[],
  nowMs: number,
  rideSecondsRemaining: number,
  graceMs = 0
): number | null {
  const optimismMs = Math.min(180000, rideSecondsRemaining * 1000 * 0.25)
  const reachable = departures.find(
    (d) => d.depMs - nowMs >= rideSecondsRemaining * 1000 - optimismMs - graceMs
  )
  return reachable?.depMs ?? null
}

/**
 * Whether a departure already in force is one the rider provably cannot make —
 * the exact negation of the test `getSoonestCatchableMs` applies when it picks
 * one, so a departure this calls unreachable is one that function would skip.
 *
 * Guarded by RELEASE_MIN_RIDE_SECONDS: with no ride time left the inequality
 * says nothing but "overdue", and an overdue bus may simply be late.
 *
 * 2026-09-08, session mtssjvee-mtc2dx. A `departureOverride` of 10:07:33 was
 * restored from the saved session at 09:57:39. OTP's own bike leg put the
 * rider at the boarding stop at 10:12:59 — five and a half minutes after that
 * bus — and the first progress tick measured `waitTimeAtStop` at -281 s. The
 * override was never re-examined: the anchor leaves alone any override it did
 * not itself set, START_GO_MODE does not clear it, and missed-bus deliberately
 * ignores an override naming another run. So the card headlined 10:07 AM for
 * the whole 11.7-minute ride and, 109 s after the bus had gone, still read
 * "arrives in <1 min" (a negative countdown rounds to "<1 min"), with the
 * rider's actual bus — the live 10:25 — demoted to a "Later departures" row.
 */
export function departureIsUnreachable(
  departureMs: number | null | undefined,
  nowMs: number,
  rideSecondsRemaining: number,
  graceMs = DEPARTURE_OVERDUE_GRACE_MS
): boolean {
  if (departureMs == null || !Number.isFinite(departureMs)) return false
  if (rideSecondsRemaining <= RELEASE_MIN_RIDE_SECONDS) return false
  const optimismMs = Math.min(180000, rideSecondsRemaining * 1000 * 0.25)
  return (
    departureMs - nowMs < rideSecondsRemaining * 1000 - optimismMs - graceMs
  )
}

/**
 * Whether the anchor should adopt `candidateMs` over the departure currently in
 * force (a previous anchor, else the plan's board time).
 *
 * The comparison must be against the EFFECTIVE departure, never the planned
 * one: on 2026-07-22 the anchor had already moved to an earlier bus, that bus
 * ran late with no realtime, and the next trip — still far earlier than the
 * plan — looked like a fresh gain, so the display skipped to it while the
 * rider's bus was still coming ("showed 465 at 0135 before mine even left").
 * The anchor may only ever move earlier; giving up on a bus is the missed-bus
 * path's call, and that one keeps the rider's route.
 */
export function shouldAdoptAnchor(
  candidateMs: number | null,
  effectiveDepartureMs: number
): boolean {
  if (candidateMs == null || !Number.isFinite(effectiveDepartureMs)) {
    return false
  }
  return effectiveDepartureMs - candidateMs >= AUTO_ANCHOR_MIN_GAIN_MS
}

/**
 * The boarding stop whose departures the anchor needs this tick, or null when
 * the anchor does not apply — it runs only while the rider is on a walk/bike
 * leg heading into a transit leg.
 *
 * Separate from the decision below because the caller has to go and fetch the
 * departures in between: the trip-start snapshot goes stale, and an earlier bus
 * only ever shows up in a fresh poll.
 */
export function anchorBoardingStopId(
  currentLeg: Leg | undefined,
  nextLeg: Leg | undefined
): string | null {
  const onAccessLeg =
    currentLeg?.mode === 'WALK' || currentLeg?.mode === 'BICYCLE'
  if (!onAccessLeg || !nextLeg?.transitLeg) return null
  return (nextLeg as any)?.from?.stop?.gtfsId ?? null
}

export interface AnchorDecision {
  /** The departure to anchor to, or null to leave the override alone. */
  anchorMs: number | null
  /**
   * Drop the override in force — it names a bus the rider cannot reach. Not
   * the same as `anchorMs: null`, which means "leave it alone"; the caller
   * must dispatch an explicit null so the card falls back to the soonest
   * departure the rider CAN catch.
   */
  clear?: boolean
  /** The last auto-anchored departure, to carry into the next tick. */
  next: number | null
}

/**
 * Decide whether to move the rider onto an earlier same-route departure.
 *
 * `prev` is the departure this anchor last chose — the caller keeps it so it
 * can tell its own override apart from one the rider picked by hand. A manual
 * pick (or a reset) sets `manualLock` and the anchor stays out of the way for
 * the rest of that boarding.
 */
export function evaluateDepartureAnchor(
  prev: number | null,
  input: {
    /** goMode.departureOverride — the departure currently in force. */
    departureOverride: number | null
    /** Departures at the boarding stop for the boarding route, sorted. */
    departures: RouteDeparture[]
    /** True once the rider has chosen a departure themselves. */
    manualLock: boolean
    nowMs: number
    /** The boarding leg's planned start; `number | string` on the wire. */
    plannedBoardMs: number | string | null | undefined
    /** Seconds of walking/riding left before reaching the stop. */
    rideSecondsRemaining: number
  }
): AnchorDecision {
  const {
    departureOverride,
    departures,
    manualLock,
    nowMs,
    plannedBoardMs,
    rideSecondsRemaining
  } = input

  // Never fight the rider's own choice, and never overwrite an override this
  // anchor did not set.
  if (manualLock) return { anchorMs: null, next: prev }

  // ...but "leave it alone" cannot mean "keep it forever". An override naming
  // a departure the rider is measurably too far away to reach is not a choice
  // any more, whoever set it — including one restored from a saved session,
  // which arrives with `prev` rebuilt as null and so is frozen by the very
  // guard below (9/8, see departureIsUnreachable). Release it and let the
  // ordinary path re-acquire: with the override gone the display and the
  // anchor both fall back to the soonest departure the rider CAN catch, which
  // is the same route's next run — the rider's standing rule.
  if (
    departureOverride != null &&
    departureIsUnreachable(departureOverride, nowMs, rideSecondsRemaining)
  ) {
    return { anchorMs: null, clear: true, next: null }
  }

  if (departureOverride != null && departureOverride !== prev) {
    return { anchorMs: null, next: prev }
  }

  const soonest = getSoonestCatchableMs(
    departures,
    nowMs,
    rideSecondsRemaining,
    DEPARTURE_OVERDUE_GRACE_MS
  )

  // Measured against the departure currently in force, never the plan's — see
  // shouldAdoptAnchor for the 7/22 ride that rule comes from. epochMs rather
  // than Number(): the planned board time is `number | string`, and Number()
  // on an ISO string is NaN, which would silently disable the anchor.
  const effectiveDeparture = departureOverride ?? epochMs(plannedBoardMs)
  if (!shouldAdoptAnchor(soonest, effectiveDeparture)) {
    return { anchorMs: null, next: prev }
  }
  if (soonest === departureOverride) return { anchorMs: null, next: prev }

  return { anchorMs: soonest, next: soonest }
}

/**
 * How long a held departure stays on the card after its own time has passed
 * before "the feed no longer lists this run" is allowed to count as evidence
 * the bus has gone.
 *
 * Longer than DEPARTURE_OVERDUE_GRACE_MS on purpose. That one decides whether
 * a departure is still worth OFFERING; this one decides whether to take a
 * departure the rider is already counting down to AWAY from them, which is the
 * move the rider asked to be slow about ("it has been way too quick to drop
 * the timed pickup to the next"). A stop-times poll drops a run shortly after
 * its predicted time whether or not the bus has actually called, so the two
 * minutes are there to outlast a poll that rolled forward early.
 */
export const CARD_HOLD_RELEASE_GRACE_MS = 120000

/** The departure the card has committed to, carried between renders. */
export interface HeldDeparture {
  /** Last known epoch for the run — refreshed from the feed while it lasts. */
  departureMs: number
  /** The run itself. Null when the feed named no trip; then depMs matches. */
  tripId: string | null
}

export type CardDepartureReason =
  /** The rider picked this departure (or the anchor set an override). */
  | 'override'
  /** Nothing held yet — the projection chose the first anchor. */
  | 'seeded'
  /** Held through this tick; the projection was not allowed to move it. */
  | 'held'
  /** A meaningfully EARLIER run of the same route showed up. */
  | 'adopted-earlier'
  /** Released: the missed-bus classifier called the boarding definitively gone. */
  | 'released-missed'
  /** Released: the run left the feed and its time is more than grace past. */
  | 'released-gone'
  /** No departure could be resolved at all. */
  | 'none'

export interface CardDepartureDecision {
  departureMs: number | null
  held: HeldDeparture | null
  reason: CardDepartureReason
}

/** The feed's current entry for a held run: by trip id, else by exact epoch. */
function findHeld(
  departures: RouteDeparture[],
  held: HeldDeparture
): RouteDeparture | null {
  if (held.tripId) {
    return departures.find((d) => d.tripId === held.tripId) ?? null
  }
  return departures.find((d) => d.depMs === held.departureMs) ?? null
}

function holdFor(
  departureMs: number,
  departures: RouteDeparture[]
): HeldDeparture {
  const match = departures.find((d) => d.depMs === departureMs)
  return { departureMs, tripId: match?.tripId ?? null }
}

/**
 * The departure the current-leg card should headline, with HYSTERESIS: once a
 * departure has been shown, only physical evidence moves it on.
 *
 * 2026-09-15, 09:44:45. The card headlined the 10:09 Orange Line while the
 * tick pipeline was still counting down to the 09:54:02 the rider went on to
 * board. Nothing had happened to the bus. `getSoonestCatchableMs` keeps a
 * departure while `depMs - now >= rideSecondsRemaining - min(180 s, 25 %)`,
 * and `rideSecondsRemaining` was `leg.duration x (1 - progress/100)` on an
 * 847 s leg whose progress was frozen at 0 % — so the threshold came out at
 * 09:54:07 against a departure of 09:54:02. Five seconds of a projection, and
 * the anchor slid to the next trip; the rider read the new headline as "you
 * missed your bus". No MISSED_BUS notification fired all ride, because none
 * was warranted: realtime for the leg had simply dropped between 09:43:29 and
 * 09:50:19 and the board had fallen back to the scheduled time.
 *
 * So a projection may pick the FIRST anchor and may make the card read tight —
 * it may never move the anchor forward. Moving forward needs one of:
 *
 *  - `boardingMiss.definitive` — the missed-bus classifier's own verdict,
 *    reused rather than re-derived. It is already the app's definition of
 *    "gone": realtime says the bus left, or the departure is past its grace
 *    and the rider is provably not at the stop. Its AMBIGUOUS verdict (past
 *    its time, schedule-only data, rider standing at the stop) deliberately
 *    does NOT release — that is a late bus, not a gone one.
 *  - the run leaving `routeDepartures` altogether, more than
 *    CARD_HOLD_RELEASE_GRACE_MS after its own time. A stop-times poll stops
 *    listing a run once it has called; before the grace, it is a poll that
 *    rolled forward.
 *
 * A realtime->schedule flip is neither. The run is still in the feed, so the
 * hold follows it to whatever epoch the feed now publishes for THAT trip —
 * a new prediction for the same bus is not a different bus.
 *
 * Moving EARLIER is not "abandoning the timed pickup" and stays allowed, on
 * the same >= AUTO_ANCHOR_MIN_GAIN_MS terms shouldAdoptAnchor applies
 * everywhere else.
 */
export function resolveCardDeparture(input: {
  /**
   * The previous tick's classifyMissedBus verdict for the upcoming boarding,
   * as carried on TripProgress. Null when the classifier had nothing to say.
   */
  boardingMiss?: { definitive: boolean } | null
  /** What the projection would pick on its own (getSoonestCatchableMs). */
  candidateMs: number | null
  /** goMode.departureOverride — the rider's own pick outranks everything. */
  departureOverride?: number | null
  /** Departures of the boarding route at the boarding stop, sorted. */
  departures: RouteDeparture[]
  graceMs?: number
  /** What the card showed last render, or null on the first one. */
  held: HeldDeparture | null
  nowMs: number
  /** OTP's planned board time, the last resort when there is no feed. */
  plannedDepartureMs?: number | null
}): CardDepartureDecision {
  const {
    boardingMiss,
    candidateMs,
    departureOverride,
    departures,
    graceMs = CARD_HOLD_RELEASE_GRACE_MS,
    held,
    nowMs,
    plannedDepartureMs
  } = input

  // The rider's own choice is not a projection and is never held against.
  if (departureOverride != null && Number.isFinite(departureOverride)) {
    return {
      departureMs: departureOverride,
      held: holdFor(departureOverride, departures),
      reason: 'override'
    }
  }

  if (held != null && Number.isFinite(held.departureMs)) {
    const current = findHeld(departures, held)
    // The same run at whatever time the feed publishes for it now. This is the
    // realtime<->schedule flip: it moves the NUMBER, never the bus.
    const heldMs = current?.depMs ?? held.departureMs

    const missed = boardingMiss?.definitive === true
    const leftTheFeed = !current && nowMs > held.departureMs + graceMs

    if (!missed && !leftTheFeed) {
      if (shouldAdoptAnchor(candidateMs, heldMs)) {
        return {
          departureMs: candidateMs,
          held: holdFor(candidateMs as number, departures),
          reason: 'adopted-earlier'
        }
      }
      return {
        departureMs: heldMs,
        held: { departureMs: heldMs, tripId: held.tripId },
        reason: 'held'
      }
    }

    // Released. Fall through to re-seed on whatever the rider can still catch.
    const next = candidateMs ?? plannedDepartureMs ?? null
    return {
      departureMs: next,
      held: next == null ? null : holdFor(next, departures),
      reason: missed ? 'released-missed' : 'released-gone'
    }
  }

  const seeded = candidateMs ?? plannedDepartureMs ?? null
  if (seeded == null) return { departureMs: null, held: null, reason: 'none' }
  return {
    departureMs: seeded,
    held: holdFor(seeded, departures),
    reason: 'seeded'
  }
}
