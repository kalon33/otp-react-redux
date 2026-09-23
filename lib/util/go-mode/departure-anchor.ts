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
import { patternDirectionId, tripIdsMatch } from './trip-id'

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
  /**
   * Which way this run goes, from the direction half of its pattern id. Null
   * when the feed named no pattern. See patternDirectionId (util/go-mode/
   * trip-id) for why the variant is dropped.
   */
  directionId?: string | null
  /** What the bus says on the front — the rider's own word for direction. */
  headsign?: string | null
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
 * Which run, out of all the ones a stop publishes for a route, the rider is
 * actually waiting for — everything the BOARDING LEG knows about its own bus.
 *
 * Measured on the 2026-09-21 16:05 ride's fixture (`0921-1605-465-wrongdir`):
 * an itinerary transit leg carries `headsign` ("North to UMN") and
 * `trip.gtfsId` / `trip.id`, and nothing else about direction — no
 * `directionId`, no `pattern`. (The plan query asks for those on the TRIP
 * query, not on a leg: `leg.trip` comes back with exactly
 * `arrivalStoptime, departureStoptime, gtfsId, id`.) So the direction of the
 * leg is either its headsign, or the direction of whatever pattern the stop's
 * own feed files its trip under.
 */
export interface BoardingDirection {
  headsign?: string | null
  tripId?: string | null
}

/** What the boarding leg knows about which way its bus is going. */
export function legBoardingDirection(leg?: Leg | null): BoardingDirection {
  const l = leg as any
  return {
    headsign: l?.headsign ?? l?.trip?.tripHeadsign ?? null,
    tripId: l?.trip?.gtfsId ?? l?.tripId ?? l?.trip?.id ?? null
  }
}

const normalizeHeadsign = (raw: unknown): string | null => {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return s || null
}

/**
 * The departures at the boarding stop that go the rider's WAY.
 *
 * 2026-09-21 16:15:31, ride `mubq7tfx-8dz3ar`, backlog 19.1. I-35W & 98th
 * Street Station Gate E (`2:51825`) serves both 465 patterns, and the stop's
 * candidate list at that instant held exactly two departures:
 *
 *   16:18:20 LIVE  South to Burnsville TS  2:465:1:01  2:t609-b15C-sl1C-v64
 *   16:21:02 LIVE  North to UMN            2:465:0:01  2:t64A-b156-sl1C-v64
 *
 * The second is the rider's — their leg's own trip. `getRouteDepartures`
 * filtered on `routeId` alone, so the SOUTHBOUND run was a legitimate
 * candidate, it was 162 s earlier than the held northbound (over
 * AUTO_ANCHOR_MIN_GAIN_MS), and `resolveCardDeparture` adopted it:
 * `CARD_DEPARTURE_MISMATCH reason 'adopted-earlier'` at 16:15:31 holding
 * `Trip:2:t609-b15C-sl1C-v64`, then five `held` records to 16:17:34. Vehicle
 * 4834 (directionId 1) passed the gate at 16:17:18 and the card said
 * "4:16 PM · departed" while the rider's northbound 4051 was 5 km south.
 *
 * Three keys, strongest first:
 *
 *  1. the leg's own trip, found in the list: its pattern gives the direction
 *     id, and that is the feed's own answer — no string matching at all;
 *  2. the leg's headsign against the departures' — what the rider reads off
 *     the front of the bus, and what the stop query publishes per stoptime;
 *  3. nothing: the leg says nothing about direction, so neither does this.
 *     The list comes back untouched, exactly as before.
 *
 * A stop that publishes ONE headsign for the route is left alone whatever the
 * leg says: there is no other direction to confuse it with, so a headsign that
 * fails to match is a spelling difference, not a wrong bus, and filtering on
 * it would blind the anchor for no gain. Where there IS more than one, the
 * filter is strict even when it empties the list — an empty candidate list
 * falls back to the planned departure, which is the rider's own bus, and that
 * is the safe direction to fail in.
 */
export function departuresInBoardingDirection(
  departures: RouteDeparture[],
  boarding: BoardingDirection | null | undefined
): RouteDeparture[] {
  if (!boarding || !departures?.length) return departures

  const own = boarding.tripId
    ? departures.find((d) => tripIdsMatch(d.tripId, boarding.tripId))
    : undefined

  const direction = own?.directionId ?? null
  if (direction != null) {
    return departures.filter((d) => d.directionId === direction)
  }

  const headsign = normalizeHeadsign(own?.headsign ?? boarding.headsign)
  if (!headsign) return departures

  const published = new Set(
    departures.map((d) => normalizeHeadsign(d.headsign)).filter(Boolean)
  )
  if (published.size <= 1) return departures

  return departures.filter((d) => normalizeHeadsign(d.headsign) === headsign)
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
 *
 * `boarding` — the leg's own answer to "which way is my bus going" — narrows
 * the list to that direction. Optional so a caller with no boarding leg in
 * hand keeps the old behaviour, but every Go Mode caller passes one: a route
 * id alone is not a bus, it is a corridor, and on 2026-09-21 that put a
 * southbound 465 on the card of a rider waiting for the northbound (19.1).
 */
export function getRouteDepartures(
  stopData: any,
  routeId: string | null,
  boarding?: BoardingDirection | null
): RouteDeparture[] {
  if (!stopData || !routeId) return []
  try {
    const ofRoute = mergeAndSortStopTimes(stopData)
      .map((st: any) => {
        const live =
          LIVE_REALTIME_STATES.has(st.realtimeState) &&
          st.realtimeDeparture != null
        const secs = live ? st.realtimeDeparture : st.scheduledDeparture
        return {
          depMs: (st.serviceDay + secs) * 1000,
          directionId: patternDirectionId(st.trip?.pattern?.id),
          headsign: st.headsign ?? null,
          realtime: live,
          routeId: st.route?.gtfsId || st.trip?.route?.gtfsId,
          tripId: st.trip?.gtfsId ?? st.trip?.id ?? null
        }
      })
      .filter((d: RouteDeparture) => d.routeId === routeId)
      .sort((a: RouteDeparture, b: RouteDeparture) => a.depMs - b.depMs)
    return departuresInBoardingDirection(ofRoute, boarding)
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

/**
 * The boarding stop whose departures the tick should RE-POLL, or null.
 *
 * Wider than {@link anchorBoardingStopId} on purpose, and only for the poll.
 * The trip steps onto the transit leg BEFORE the bus leaves (13.1 — it has to,
 * `advanceToLeg` is where vehicle tracking starts), so for the whole platform
 * wait the current leg is the bus leg and the anchor's walk/bike test is false.
 * Measured 2026-09-22 (backlog 26.1, session `mucordp1-jqcrp2`): the last
 * `FETCHING_STOP_TIMES_FOR_STOP {stopId: '1:56831'}` was 08:19:05,
 * `TRANSITION_LEG {legIndex: 1}` came 08:19:21, and there was not another poll
 * until 08:39:16 — twenty minutes of a rider standing at the stop with the
 * one stop-specific live departure going stale. 180 s later
 * (`STOP_SNAPSHOT_MAX_AGE_MS`) the board time fell through to the trip query's
 * scheduled 08:15:00, published live.
 *
 * So the poll also runs while the rider is WAITING at the current transit
 * leg's boarding stop — `waitingAtBoardingStop` (18.6), the spatial fact that
 * ends on the riding fact or 150 m down the line. Everything else the anchor
 * does (the departure override, 23.3's plan re-target) keeps the narrow gate:
 * re-targeting the plan onto other runs while the rider stands at the kerb is
 * not what this is for.
 */
export function boardingStopToPoll(
  currentLeg: Leg | undefined,
  nextLeg: Leg | undefined,
  waitingAtBoardingStop: boolean | undefined
): string | null {
  const anchorStopId = anchorBoardingStopId(currentLeg, nextLeg)
  if (anchorStopId) return anchorStopId
  if (!waitingAtBoardingStop || !currentLeg?.transitLeg) return null
  return (currentLeg as any)?.from?.stop?.gtfsId ?? null
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
  /**
   * The card was holding a run the trip is not on, and has been put back on
   * the trip's own run. See resolveCardDeparture (backlog 19.1).
   */
  | 'released-split'
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
 *
 * ONE RUN, NOT TWO (backlog 19.1, 2026-09-21). `tickTripId` is the run the
 * trip itself is on — the boarding leg's trip — and the card may not hold a
 * different one. It used to be able to, and did:
 *
 *  - 16:05 ride, 16:15:31: the projection offered a SOUTHBOUND 465 (the stop
 *    serves both directions and getRouteDepartures filtered on routeId alone)
 *    and the hold adopted it, `reason: adopted-earlier`, then held it for five
 *    more records to 16:17:34 while the tick counted down to the rider's
 *    northbound. The southbound passed the gate at 16:17:18 and the card said
 *    "departed". The direction filter above is what stops that one.
 *  - 09:02 ride: 26 records 09:05:51-09:20:17 with the card on the 09:15
 *    (`Trip:1:1268952`) and the tick on the 10:12 (`1:1348464`) — the card was
 *    RIGHT about the bus and the plan was wrong, which is why 23.3 re-targets
 *    the itinerary onto the adopted run instead of arguing with it. Once the
 *    plan follows, `tickTripId` IS the adopted run and the hold agrees.
 *
 * So an earlier run reaches the card by the plan moving to it, and the hold
 * then catches up (still `adopted-earlier` when the new run is meaningfully
 * earlier — the rider is being shown an earlier bus). A hold on any other run
 * is a split screen and is released. There is no oscillation in that pair
 * because both outcomes put the card on the trip's own run.
 *
 * `tickTripId` null — a boarding leg with no trip id at all — leaves every
 * rule below exactly as it was.
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
  /**
   * The run the tick pipeline is counting down to — the boarding leg's trip,
   * in the gtfsId spelling. Null when the leg names no trip, which leaves
   * every rule here as it was.
   */
  tickTripId?: string | null
}): CardDepartureDecision {
  const {
    boardingMiss,
    candidateMs,
    departureOverride,
    departures,
    graceMs = CARD_HOLD_RELEASE_GRACE_MS,
    held,
    nowMs,
    plannedDepartureMs,
    tickTripId
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

    // 19.1: the card and the trip must name ONE run. When they disagree the
    // card goes to the trip's, whichever way that moves the clock — earlier
    // (the plan has followed the anchor onto a better bus: 23.3) or later
    // (the card had wandered). Either way the split is over in one render.
    const splitFromTrip =
      tickTripId != null &&
      held.tripId != null &&
      !tripIdsMatch(held.tripId, tickTripId)
    if (splitFromTrip && !missed) {
      const onTrip = departures.find((d) => tripIdsMatch(d.tripId, tickTripId))
      const next = onTrip?.depMs ?? plannedDepartureMs ?? null
      if (next != null && Number.isFinite(next)) {
        return {
          departureMs: next,
          held: onTrip
            ? { departureMs: onTrip.depMs, tripId: onTrip.tripId ?? null }
            : holdFor(next, departures),
          reason: shouldAdoptAnchor(next, heldMs)
            ? 'adopted-earlier'
            : 'released-split'
        }
      }
    }

    if (!missed && !leftTheFeed) {
      if (shouldAdoptAnchor(candidateMs, heldMs)) {
        // Only ever onto the run the trip is on. A projection that fancies a
        // different bus is a proposal for the ANCHOR to make (and for 23.3's
        // re-target to carry into the plan), not a headline the card may
        // publish on its own.
        const candidateIsTheTrip =
          tickTripId == null ||
          departures.some(
            (d) => d.depMs === candidateMs && tripIdsMatch(d.tripId, tickTripId)
          )
        if (candidateIsTheTrip) {
          return {
            departureMs: candidateMs,
            held: holdFor(candidateMs as number, departures),
            reason: 'adopted-earlier'
          }
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
