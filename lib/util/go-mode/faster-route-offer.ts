import type { Itinerary, Leg } from '@opentripplanner/types'

import { bikeMetersOf, routeSetOf } from './faster-route'
import type {
  AlightOfferVerdict,
  FasterRouteKind,
  FasterRouteOfferKey,
  FasterRouteVerdict
} from './faster-route'

/**
 * The background "faster route available" OFFER (backlog 56.1, cycle 25 B2):
 * the pure half of it — when the background check may run, what the card
 * carries, when it lapses. The thunks that fetch, decide and dispatch live in
 * actions/go-mode.ts (`backgroundRouteCheck`, `acceptFasterRoute`,
 * `keepCurrentRoute`, `viewFasterRoute`); the decision itself is B1's
 * `classifyFasterRoute`. Nothing here changes the trip.
 */

/** Off the bus, the check asks every 90 s (the recorder's own cadence). */
export const BACKGROUND_CHECK_INTERVAL_MS = 90000

/**
 * No check in the minute after a new plan was installed. A swap is the moment
 * the plan has just been made from the rider's position; asking again at once
 * would compare the plan against its own echo, and the rider has not yet seen
 * it.
 */
export const FASTER_ROUTE_SWAP_QUIET_MS = 60000

/**
 * The less-biking search (55.1's second query at LOW_BIKE_RELUCTANCE) runs once
 * per leg, and not at all with less than this much biking left. B1 measured
 * it 2026-10-18: 0 new offers from 20 real re-issued requests, so a second
 * query every check would be pure server load.
 */
export const LOW_BIKE_MIN_REMAINING_BIKE_M = 1000

/** A faster route that adds biking says so on the card from this much. */
export const ADDED_BIKE_SHOW_M = 500

/**
 * Stable native id for the one locked-phone push. A second offer's push
 * REPLACES the first on the lock screen and the wrist rather than stacking,
 * and an offer that lapses (or that the rider answers) is taken back off.
 * 6, after the round trip's 4 and 5.
 */
export const FASTER_ROUTE_NOTICE_ID = 6

/** `aboard` is the get-off offer (B4); the slice has room for it now. */
export type FasterRouteOfferKind = FasterRouteKind | 'aboard'

export interface FasterRouteOffer {
  /**
   * Aboard (B4) only: what Switch needs to splice the ride — the stop, the
   * bus's arrival there and the onward plan from it (the optimizer option
   * buildOnboardItinerary takes), the bus it is about, and whether the offer
   * is the faster or the less-biking kind. The trip's stop times are not
   * copied in: Switch reads them from the transit index, fresher.
   */
  aboard?: AboardOfferDetail | null
  /** Metres of biking the offer ADDS (0 when it bikes the same or less). */
  addedBikeM: number
  /** The rider's own route as the same answer times it — for "view". */
  baseline: Itinerary | null
  /** Metres of biking the offer saves (0 when it adds). */
  bikeSavedM: number
  candidate: Itinerary
  /**
   * When the offer stops being catchable: the candidate's first boarding.
   * Null for a street-only candidate, which lapses only when a later check no
   * longer sees it.
   */
  expiresAtMs: number | null
  kind: FasterRouteOfferKind
  /** A less-biking offer that arrives later says by how much (else 0). */
  laterMs: number
  /** Stable for the life of one offer; an in-place update keeps it. */
  offerId: string
  raisedAtMs: number
  /** "14", "Blue Line → 539"; empty for bike all the way. */
  routeLabel: string
  routeSet: string
  savingMs: number
  /** Which query found it: the ordinary check or the once-per-leg less-biking one. */
  source: 'low-bike' | 'ordinary'
  /** Aboard (B4): the stop to get off at. */
  stopName?: string | null
}

export interface AboardOfferDetail {
  arrivalIsFloor: boolean
  busArrivalEpoch: number
  /** The onward plan from `stopId`. */
  itinerary: Itinerary
  kind: FasterRouteKind
  stopId: string
  stopName: string | null
  tripId: string
}

export type BackgroundCheckSkip =
  | 'aboard'
  | 'arrived'
  | 'backgrounded'
  | 'inactive'
  | 'just-swapped'
  | 'no-plan'
  | 'onboard-open'
  | 'reroute-searching'

/**
 * Why the off-the-bus check must not run now, or null when it may. The
 * recorder has its own rule (it records aboard too); this is the check's.
 *
 * - behind the planner (`ui.backgrounded`): the rider is browsing routes
 *   themselves, and an auto-update must not move the screen under them;
 * - after arrival; during a reroute search (one question at a time); with the
 *   onboard flow open (the rider is answering "which bus" already);
 * - within FASTER_ROUTE_SWAP_QUIET_MS of a new plan;
 * - aboard: the off-the-bus offer does not apply (B4 asks the aboard question).
 *
 * The phone being LOCKED is not a reason: that is when the push matters.
 */
export function backgroundCheckSkip(input: {
  arrived: boolean
  backgrounded: boolean
  hasPlan: boolean
  isActive: boolean
  nowMs: number
  onboardOpen: boolean
  planInstalledAtMs: number | null
  rerouteSearching: boolean
  riding: boolean
}): BackgroundCheckSkip | null {
  if (!input.isActive) return 'inactive'
  if (!input.hasPlan) return 'no-plan'
  if (input.arrived) return 'arrived'
  if (input.backgrounded) return 'backgrounded'
  if (input.onboardOpen) return 'onboard-open'
  if (input.rerouteSearching) return 'reroute-searching'
  if (
    input.planInstalledAtMs != null &&
    input.nowMs - input.planInstalledAtMs < FASTER_ROUTE_SWAP_QUIET_MS
  ) {
    return 'just-swapped'
  }
  if (input.riding) return 'aboard'
  return null
}

/**
 * Backlog 56.2 — the recorder's "settled aboard" fact, which stretches its
 * cadence from 90 s to 360 s. It used to need the vehicle match CONFIRMED; on
 * 2026-10-17 (orange-1639-1017) the match sat at `high` for the whole Orange
 * Line ride and never confirmed, so 17 snapshots went out at ~90 s from a
 * moving train. `high` is the matcher's own "this is the bus" verdict, and the
 * sticky riding fact plus the on-route test still have to agree.
 */
export function recorderSettledAboard(input: {
  confidence: string | null | undefined
  isOnRoute: boolean | null | undefined
  ridingTripId: string | null | undefined
}): boolean {
  return (
    input.ridingTripId != null &&
    input.isOnRoute === true &&
    (input.confidence === 'high' || input.confidence === 'confirmed')
  )
}

/** Metres of biking left in the plan from leg `currentLegIndex` on. */
export function remainingBikeMeters(
  itinerary: Itinerary | null | undefined,
  currentLegIndex: number | null | undefined
): number {
  const legs = (itinerary?.legs || []) as Leg[]
  const from =
    currentLegIndex != null && currentLegIndex >= 0 ? currentLegIndex : 0
  return bikeMetersOf({ legs: legs.slice(from) } as Itinerary)
}

/**
 * Should this check also ask the less-biking question? Once per leg (keyed by
 * the caller: plan + leg), only with ≥ 1 km of biking left, only when the
 * rider's own bike reluctance is below the low-bike one (otherwise the
 * ordinary query already IS the less-biking one), and only for a search that
 * bikes at all.
 */
export function shouldAskLowBike(input: {
  bikeInModes: boolean
  lastLegKey: string | null
  legKey: string
  lowBikeReluctance: number
  remainingBikeM: number
  riderBikeReluctance?: number | null
}): boolean {
  if (!input.bikeInModes) return false
  if (input.lastLegKey === input.legKey) return false
  if (input.remainingBikeM < LOW_BIKE_MIN_REMAINING_BIKE_M) return false
  if (
    typeof input.riderBikeReluctance === 'number' &&
    input.riderBikeReluctance >= input.lowBikeReluctance
  ) {
    return false
  }
  return true
}

const transitLegsOf = (itin: Itinerary | null | undefined): Leg[] =>
  ((itin?.legs || []) as Leg[]).filter((leg) => leg.transitLeg)

/** The routes a rider would read: short names in riding order, " → " between. */
export function routeLabelOf(itin: Itinerary | null | undefined): string {
  const names = transitLegsOf(itin)
    .map((leg: any) =>
      String(
        leg.routeShortName ||
          leg.route?.shortName ||
          leg.routeLongName ||
          leg.route?.longName ||
          ''
      ).trim()
    )
    .filter(Boolean)
  return names.filter((n, i) => i === 0 || n !== names[i - 1]).join(' → ')
}

/** The candidate's first boarding, or null for a street-only plan. */
export function offerExpiresAtMs(candidate: Itinerary): number | null {
  const board = Number(transitLegsOf(candidate)[0]?.startTime)
  return Number.isFinite(board) && board > 0 ? board : null
}

/** The card's content for a verdict that offers, or null when it does not. */
export function offerFromVerdict(
  v: FasterRouteVerdict,
  ctx: { nowMs: number; offerId: string; source: FasterRouteOffer['source'] }
): FasterRouteOffer | null {
  if (v.why !== 'offer' || !v.kind || !v.candidate || v.routeSet == null) {
    return null
  }
  const baseBike = bikeMetersOf(v.baseline)
  const candBike = bikeMetersOf(v.candidate)
  return {
    addedBikeM: Math.max(0, Math.round(candBike - baseBike)),
    baseline: v.baseline,
    bikeSavedM: Math.max(0, v.bikeSavedM),
    candidate: v.candidate,
    expiresAtMs: offerExpiresAtMs(v.candidate),
    kind: v.kind,
    laterMs: v.kind === 'lessBike' ? Math.max(0, -v.savingMs) : 0,
    offerId: ctx.offerId,
    raisedAtMs: ctx.nowMs,
    routeLabel: routeLabelOf(v.candidate),
    routeSet: v.routeSet,
    savingMs: v.savingMs,
    source: ctx.source
  }
}

/** faster | lessBike, whichever surface the offer is on. */
export function offerSubKind(
  offer: Pick<FasterRouteOffer, 'aboard' | 'kind'>
): FasterRouteKind {
  if (offer.kind === 'aboard') return offer.aboard?.kind ?? 'faster'
  return offer.kind
}

/** What the latch remembers of an offer. */
export function offerKeyOf(offer: FasterRouteOffer): FasterRouteOfferKey {
  return {
    bikeSavedM: offer.bikeSavedM,
    kind: offerSubKind(offer),
    routeSet: offer.routeSet,
    savingMs: offer.savingMs
  }
}

/** Has the offer's boarding gone? */
export function offerExpired(
  offer: FasterRouteOffer | null | undefined,
  nowMs: number
): boolean {
  return !!offer && offer.expiresAtMs != null && nowMs >= offer.expiresAtMs
}

/* ------------------------------------------------------------------------ */
/* Aboard: "4 min faster · off at 30th Ave" (rider Q4, cycle 25 B4)          */
/* ------------------------------------------------------------------------ */

/**
 * Aboard, the get-off check asks every 6 minutes — not the off-bus 90 s. Each
 * check is one trip read plus the optimizer's onward plan from every candidate
 * stop (the sampled five plus the planned stop and the three before it, so
 * 6-9 plans), which is the heaviest question Go Mode asks. 56.2's recorder
 * slows to the same 360 s aboard.
 */
export const ABOARD_CHECK_INTERVAL_MS = 360000

/** Not until the bus is this many stops beyond the boarding stop. */
export const ABOARD_MIN_STOPS_AFTER_BOARD = 2

/** No more checks with this many stops or fewer left to the planned stop... */
export const ABOARD_STOP_STOPS_LEFT = 2

/** ...or with the planned stop less than this far away. */
export const ABOARD_STOP_MS_LEFT = 240000

/**
 * Fallback when the boarding stop is not on the trip read (the rider caught a
 * run the plan did not name, boarding somewhere else): this long aboard stands
 * in for "two stops in".
 */
export const ABOARD_MIN_RIDDEN_MS = 240000

/**
 * An offer whose stop is closer than this is not raised — there is no time to
 * ring the bell — and an offer up lapses this long before the bus reaches its
 * stop.
 */
export const ABOARD_OFFER_LEAD_MS = 60000

export type AboardWindowWhy =
  | 'just-boarded'
  | 'near-planned-stop'
  | 'no-position'
  | 'planned-stop-not-ahead'
  | null

/**
 * May the aboard check ask now? From the stop indexes on the boarded trip's
 * stop times: the stop the plan boarded at, the bus's next stop (the
 * optimizer's own anchor — the first downstream stop) and the planned alight
 * stop, plus the bus's arrival at that stop. Null = yes.
 *
 * "Two stops after boarding": the anchor (the bus's next stop, or the stop
 * nearest the rider when the feed gives none) is board+2 or later. Before that
 * the onboard flow and the boarded-earlier re-plan have only just had their
 * say. "Two stops away" counts the planned stop itself, as the stop counter
 * does: next stop = planned stop is one. Read stricter ("two stops PASSED"),
 * the window was EMPTY on every four-stop Orange Line leg in the recorded
 * rides (board 6 -> planned 10 on 2026-09-30 16:48 and 07-29); read this way
 * such a leg gets its one check, at the middle stop.
 */
export function aboardCheckWindow(input: {
  anchorIdx: number | null
  boardIdx: number | null
  boardedAtMs?: number | null
  nowMs: number
  plannedArrivalMs: number | null
  plannedIdx: number | null
}): AboardWindowWhy {
  const { anchorIdx, boardIdx, nowMs, plannedIdx } = input
  if (anchorIdx == null || anchorIdx < 0) return 'no-position'
  if (plannedIdx == null || plannedIdx < 0 || plannedIdx < anchorIdx) {
    return 'planned-stop-not-ahead'
  }
  if (boardIdx != null && boardIdx >= 0 && boardIdx <= anchorIdx) {
    if (anchorIdx - boardIdx < ABOARD_MIN_STOPS_AFTER_BOARD) {
      return 'just-boarded'
    }
  } else if (
    input.boardedAtMs == null ||
    nowMs - input.boardedAtMs < ABOARD_MIN_RIDDEN_MS
  ) {
    return 'just-boarded'
  }
  if (plannedIdx - anchorIdx + 1 <= ABOARD_STOP_STOPS_LEFT) {
    return 'near-planned-stop'
  }
  if (
    input.plannedArrivalMs != null &&
    input.plannedArrivalMs - nowMs < ABOARD_STOP_MS_LEFT
  ) {
    return 'near-planned-stop'
  }
  return null
}

/**
 * The card's content for an aboard verdict that offers, or null. `candidate`
 * is the spliced ride (on this bus to the stop, then the onward plan) so the
 * record and any later reader see a whole itinerary; Switch splices again at
 * the tap with fresher stop times.
 */
export function aboardOfferFromVerdict(
  v: AlightOfferVerdict,
  ctx: {
    nowMs: number
    offerId: string
    spliced: Itinerary
    tripId: string
  }
): FasterRouteOffer | null {
  if (v.why !== 'offer' || !v.kind || !v.candidate) return null
  const top = v.candidate
  const onwardSet = routeSetOf(top.itinerary)
  const savedM = v.bikeSavedM
  return {
    aboard: {
      arrivalIsFloor: !!top.arrivalIsFloor,
      busArrivalEpoch: top.busArrivalEpoch,
      itinerary: top.itinerary,
      kind: v.kind,
      stopId: top.stopId,
      stopName: top.stopName ?? null,
      tripId: ctx.tripId
    },
    addedBikeM: Math.max(0, -savedM),
    baseline: null,
    bikeSavedM: Math.max(0, savedM),
    candidate: ctx.spliced,
    expiresAtMs: top.busArrivalEpoch - ABOARD_OFFER_LEAD_MS,
    kind: 'aboard',
    laterMs: v.kind === 'lessBike' ? Math.max(0, -v.savingMs) : 0,
    offerId: ctx.offerId,
    raisedAtMs: ctx.nowMs,
    routeLabel: routeLabelOf(top.itinerary),
    // Stop AND onward routes: "off at 30th Ave for the 14" and "off at 30th
    // Ave, bike home" are different offers to the latch.
    routeSet: `${top.stopId}|${onwardSet}`,
    savingMs: v.savingMs,
    source: 'ordinary',
    stopName: top.stopName ?? null
  }
}
