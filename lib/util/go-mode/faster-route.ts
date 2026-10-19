import type { Itinerary, Leg } from '@opentripplanner/types'

import {
  acceptAutoReplan,
  accessBoardOverrunMs,
  AUTO_REPLAN_ACCESS_BOARD_SLACK_MS
} from './replan-acceptance'
import { getLegRouteId } from './departure-anchor'
import { legTripId } from './leg-merge'
import { rankAlightOptions, scoreAlightOption } from './alight-optimizer'
import { tripIdsMatch } from './trip-id'
import type {
  AlightCandidateResult,
  AlightOption,
  BoardedTrip,
  DownstreamStop
} from './alight-optimizer'

/**
 * Background "faster route available" decision (backlog 56.1, cycle 25 B1).
 *
 * Pure: no dispatch, no state, no UI. It answers one question about one
 * background plan() answer — is there a route the rider should be OFFERED? —
 * and the latch answers whether that offer may be raised again. Nothing here
 * ever changes the trip: the rider's chosen route only changes on a tap.
 *
 * THE BASELINE COMES FROM THE SAME ANSWER. The background query uses the
 * rider's observed bike speed (`withObservedBikeSpeed`) and the card does not,
 * so comparing an answer against the held plan's own `endTime` offers "4-5 min
 * faster" for the very bus the rider is riding to (orange-1639-1017: trip
 * `1:1367971` arrived 17:25:10-17:27:53 in the answers vs 17:30:05 on the
 * card). The rider's own remaining trips, as THIS answer times them, are the
 * only honest thing to beat.
 */

/** Rider Q1 (2026-10-18): offer from 3 minutes faster. */
export const FASTER_ROUTE_MIN_SAVING_MS = 180000
/** Rider Q2: "same arrival" means within 2 minutes either way... */
export const LESS_BIKE_ARRIVAL_BAND_MS = 120000
/** ...with at least 1 km less biking. */
export const LESS_BIKE_MIN_METERS = 1000
/** The held plan's board time this far in the past (rider not aboard) = missed. */
export const PLAN_DEAD_BOARD_PAST_MS = 60000

/** A Keep holds until an offer beats it by this much more... */
export const LATCH_REARM_SAVING_MS = 180000
/** ...or saves this many more metres of biking. */
export const LATCH_REARM_BIKE_M = 1000
export const MAX_FASTER_ROUTE_OFFERS_PER_RIDE = 3
export const MAX_FASTER_ROUTE_PUSHES_PER_RIDE = 2

export type FasterRouteKind = 'faster' | 'lessBike'

/**
 * Why no offer. `no-transit-left`, `aboard`, `no-baseline`, `plan-dead` and
 * `no-candidate` mean the question could not honestly be put;
 * `not-catchable` means a better-looking route exists but the rider cannot
 * start it from where they are; `same-bus` means the better option is the
 * rider's own next bus with a different tail (the aboard offer's question);
 * `not-better` means nothing clears the bar.
 */
export type FasterRouteWhy =
  | 'aboard'
  | 'no-baseline'
  | 'no-candidate'
  | 'no-transit-left'
  | 'not-better'
  | 'not-catchable'
  | 'offer'
  | 'plan-dead'
  | 'same-bus'

export type BaselineSource =
  | 'own-trips'
  | 'own-next-trip'
  /** A catchable EARLIER run of the rider's own route set in the same answer. */
  | 'own-route-earlier-run'

export type PlanDeadWhy =
  | 'missed-bus-recovery'
  | 'board-time-passed'
  | 'board-stop-unreachable'

export interface FasterRouteInput {
  /** The background plan()'s itineraries, as returned. */
  answer: Itinerary[] | null | undefined
  /** The plan the rider is following (goMode.activeItinerary). */
  current: Itinerary | null | undefined
  /** Index of the leg the rider is on; null falls back to `nowMs` vs leg times. */
  currentLegIndex?: number | null
  headingDeg?: number | null
  /** Card's live board time for the held next boarding (liveBoardForCandidate). */
  liveBoardEpochMs?: number | null
  liveBoardTripId?: string | null
  /** Missed-bus recovery is running: the plan in hand is already dead. */
  missedBusRecoveryActive?: boolean
  nowMs: number
  /** The rider's last fix as [lat, lon]. */
  position?: [number, number] | null
  /**
   * The plan's own bike pace, m/s (bikeSpeedOf(held plan)). The background
   * query rides at the OBSERVED pace, which a stop-and-wait access leg drags
   * down: on 2026-09-15 09:43 it asked at 2.47 m/s, the 3,970 m closing bike
   * leg took 27.6 min in the answer, and "the same Orange Line + a 546 hop"
   * looked 15 min faster than the rider's own trip — the rider then biked it in
   * 11 min and arrived 10:27:44, level with the "faster" route. With this set,
   * a saving must hold at BOTH paces (the smaller one is used).
   */
  referenceBikeSpeedMps?: number | null
  /** Verifiably aboard a vehicle — the off-the-bus check does not apply. */
  riding?: boolean
  speedMps?: number | null
}

export interface FasterRouteVerdict {
  /** The rider's own trips as this answer times them. */
  baseline: Itinerary | null
  baselineSource: BaselineSource | null
  /** Best different-route-set saving before feasibility — measurement only. */
  bestRawSavingMs: number | null
  /** Metres of biking the offer saves (baseline minus candidate). */
  bikeSavedM: number
  candidate: Itinerary | null
  /** Offer kind, null when there is no offer. */
  kind: FasterRouteKind | null
  planDead: PlanDeadWhy | null
  /** acceptAutoReplan / access reasons that removed the ≥3-min candidates. */
  rejected: string[]
  routeSet: string | null
  /** Baseline arrival minus candidate arrival (positive = earlier). */
  savingMs: number
  why: FasterRouteWhy
}

const transitLegs = (itin: Itinerary | null | undefined): Leg[] =>
  ((itin?.legs || []) as Leg[]).filter((leg) => leg.transitLeg)

/**
 * The route set of an itinerary: its transit routes, sorted and joined. A
 * street-only plan (bike all the way) is the empty set — a route set of its
 * own, so it counts as different from any bus plan (rider Q5).
 */
export function routeSetOf(itin: Itinerary | null | undefined): string {
  const ids = transitLegs(itin)
    .map((leg) => getLegRouteId(leg) || '?')
    .filter((id, i, all) => all.indexOf(id) === i)
  return ids.sort().join('+')
}

/** Metres biked in an itinerary. */
export function bikeMetersOf(itin: Itinerary | null | undefined): number {
  return ((itin?.legs || []) as Leg[]).reduce(
    (sum, leg) =>
      sum + (leg.mode === 'BICYCLE' ? Number(leg.distance) || 0 : 0),
    0
  )
}

/**
 * The held plan's transit legs still ahead of (or under) the rider. By leg
 * index when the caller knows it, else by time: a leg that has not ended yet.
 */
export function remainingTransitLegs(
  current: Itinerary | null | undefined,
  nowMs: number,
  currentLegIndex?: number | null
): Leg[] {
  const legs = (current?.legs || []) as Leg[]
  if (currentLegIndex != null && currentLegIndex >= 0) {
    return legs.slice(currentLegIndex).filter((leg) => leg.transitLeg)
  }
  return legs.filter((leg) => leg.transitLeg && Number(leg.endTime) > nowMs)
}

const endOf = (itin: Itinerary): number => Number(itin.endTime)

/** Average bike pace of an itinerary's bike legs, m/s, or null if none. */
export function bikeSpeedOf(itin: Itinerary | null | undefined): number | null {
  let m = 0
  let s = 0
  for (const leg of (itin?.legs || []) as Leg[]) {
    if (leg.mode !== 'BICYCLE') continue
    m += Number(leg.distance) || 0
    s += Number(leg.duration) || 0
  }
  return m > 0 && s > 0 ? m / s : null
}

/**
 * The arrival this itinerary would have at bike pace `mps`. Only the bike legs
 * AFTER the last transit leg move the arrival (the access chain feeds a fixed
 * departure; a transfer bike is assumed made); a street-only plan is re-timed
 * whole from its start.
 */
export function arrivalAtBikeSpeed(itin: Itinerary, mps: number): number {
  const legs = (itin.legs || []) as Leg[]
  const lastTransit = legs.map((l) => !!l.transitLeg).lastIndexOf(true)
  if (lastTransit < 0) {
    return (
      Number(itin.startTime) +
      legs.reduce(
        (sum, leg) =>
          sum +
          (leg.mode === 'BICYCLE'
            ? ((Number(leg.distance) || 0) / mps) * 1000
            : (Number(leg.duration) || 0) * 1000),
        0
      )
    )
  }
  let shift = 0
  for (const leg of legs.slice(lastTransit + 1)) {
    if (leg.mode !== 'BICYCLE') continue
    shift +=
      (Number(leg.duration) || 0) * 1000 -
      ((Number(leg.distance) || 0) / mps) * 1000
  }
  return endOf(itin) - shift
}

/** Saving at the answer's own pace, and — with a reference pace — the smaller
 * of that and the saving re-timed at the reference. */
function savingOf(
  baseline: Itinerary,
  candidate: Itinerary,
  refMps: number | null | undefined
): number {
  const raw = endOf(baseline) - endOf(candidate)
  if (!refMps || !(refMps > 0)) return raw
  const retimed =
    arrivalAtBikeSpeed(baseline, refMps) - arrivalAtBikeSpeed(candidate, refMps)
  return Math.min(raw, retimed)
}
const boardStopId = (leg: Leg | undefined): string | null => {
  const from: any = leg?.from
  return from?.stop?.gtfsId || from?.stopId || from?.stop?.id || null
}

/**
 * The rider's own remaining trips inside `answer`. Fallback chain:
 *  1. `own-trips` — every remaining transit trip, in order (earliest arrival
 *     if OTP returned the same trips more than once, e.g. via another stop);
 *  2. `own-next-trip` — the rider's NEXT trip, with whatever onward OTP chose
 *     (the onward connection the plan carried is gone from this answer);
 *  3. none — no offer. An answer that cannot say how the rider's own bus does
 *     today has nothing to beat; the held plan's endTime is NOT a fallback
 *     (different bike speed, frozen prediction — see the module comment).
 */
export function findBaseline(
  answer: Itinerary[] | null | undefined,
  remaining: Leg[]
): { itinerary: Itinerary; source: BaselineSource } | null {
  if (!remaining.length) return null
  const own = remaining.map((leg) => legTripId(leg))
  if (own.some((id) => !id)) return null
  const pickEarliest = (list: Itinerary[]) =>
    list.reduce<Itinerary | null>(
      (m, it) => (!m || endOf(it) < endOf(m) ? it : m),
      null
    )
  const all = (answer || []).filter((it) => Number.isFinite(endOf(it)))
  const exact = all.filter((it) => {
    const trips = transitLegs(it).map((leg) => legTripId(leg))
    return (
      trips.length === own.length &&
      trips.every((id, i) => tripIdsMatch(id, own[i]))
    )
  })
  const e = pickEarliest(exact)
  if (e) return { itinerary: e, source: 'own-trips' }
  const next = all.filter((it) =>
    tripIdsMatch(legTripId(transitLegs(it)[0]), own[0])
  )
  const n = pickEarliest(next)
  if (n) return { itinerary: n, source: 'own-next-trip' }
  return null
}

/**
 * Is the plan in hand already dead — so that "faster than your plan" would be
 * measured against a bus the rider is not going to catch? Then the offer is
 * the missed-bus path's job, not this one's.
 *
 * - missed-bus recovery is running;
 * - the held next boarding (live board time when the card has one) left more
 *   than a minute ago and the rider is not aboard;
 * - the answer reaches the rider's bus only at a DIFFERENT stop, later than the
 *   planned boarding: OTP is chasing the bus down the line because the planned
 *   stop is out of reach.
 */
export function planDeadWhy(
  remaining: Leg[],
  baseline: Itinerary | null,
  input: Pick<
    FasterRouteInput,
    'liveBoardEpochMs' | 'liveBoardTripId' | 'missedBusRecoveryActive' | 'nowMs'
  >
): PlanDeadWhy | null {
  if (input.missedBusRecoveryActive) return 'missed-bus-recovery'
  const next = remaining[0]
  if (!next) return null
  const live =
    input.liveBoardEpochMs != null &&
    input.liveBoardTripId &&
    tripIdsMatch(legTripId(next), input.liveBoardTripId)
      ? Number(input.liveBoardEpochMs)
      : null
  const plannedBoard = live ?? Number(next.startTime)
  if (
    Number.isFinite(plannedBoard) &&
    plannedBoard + PLAN_DEAD_BOARD_PAST_MS < input.nowMs
  ) {
    return 'board-time-passed'
  }
  const baseBoard = transitLegs(baseline)[0]
  const planned = boardStopId(next)
  const actual = boardStopId(baseBoard)
  if (
    baseBoard &&
    planned &&
    actual &&
    planned !== actual &&
    tripIdsMatch(legTripId(baseBoard), legTripId(next)) &&
    Number(baseBoard.startTime) > plannedBoard
  ) {
    return 'board-stop-unreachable'
  }
  return null
}

/**
 * Why the rider cannot start `candidate` from where they are, or null when
 * they can: the acceptAutoReplan origin checks (radius + behind-heading),
 * token hop, and an access chain that reaches its boarding in time — asked
 * with no escape, because an offer has no "plan in hand already overruns"
 * excuse. The arrival test is ours, not acceptAutoReplan's: a less-biking
 * offer may legitimately land up to 2 min later.
 */
export function candidateNotCatchable(
  candidate: Itinerary,
  baseline: Itinerary,
  input: FasterRouteInput
): string | null {
  const verdict = acceptAutoReplan(candidate, baseline, {
    headingDeg: input.headingDeg,
    position: input.position,
    riding: false,
    speedMps: input.speedMps
  })
  if (!verdict.accept && verdict.reason !== 'arrives-later') {
    return verdict.reason
  }
  const overrun = accessBoardOverrunMs(candidate)
  if (overrun != null && overrun > AUTO_REPLAN_ACCESS_BOARD_SLACK_MS) {
    return 'access-misses-board'
  }
  const start = Number(candidate.startTime)
  if (Number.isFinite(start) && start + PLAN_DEAD_BOARD_PAST_MS < input.nowMs) {
    return 'starts-in-past'
  }
  return null
}

const empty = (
  why: FasterRouteWhy,
  extra: Partial<FasterRouteVerdict> = {}
): FasterRouteVerdict => ({
  baseline: null,
  baselineSource: null,
  bestRawSavingMs: null,
  bikeSavedM: 0,
  candidate: null,
  kind: null,
  planDead: null,
  rejected: [],
  routeSet: null,
  savingMs: 0,
  why,
  ...extra
})

/**
 * Should the rider, off the bus, be offered a different route?
 *
 * Faster: the best catchable itinerary on a DIFFERENT route set from the
 * rider's remaining plan arrives ≥ 3 min before the rider's own trips in the
 * same answer. Less bike: a catchable different-route-set itinerary within
 * ±2 min of that arrival bikes ≥ 1 km less. Faster wins when both apply.
 */
export function classifyFasterRoute(
  input: FasterRouteInput
): FasterRouteVerdict {
  const remaining = remainingTransitLegs(
    input.current,
    input.nowMs,
    input.currentLegIndex
  )
  if (!remaining.length) return empty('no-transit-left')
  if (input.riding) return empty('aboard')
  const found = findBaseline(input.answer, remaining)
  if (!found && input.missedBusRecoveryActive) {
    return empty('plan-dead', { planDead: 'missed-bus-recovery' })
  }
  if (!found) return empty('no-baseline')
  const baseline = found.itinerary
  const base = {
    baseline,
    baselineSource: found.source
  }
  const heldSet = routeSetOf({ legs: remaining } as Itinerary)
  const baseArrival = endOf(baseline)
  const others = (input.answer || []).filter(
    (it) => Number.isFinite(endOf(it)) && routeSetOf(it) !== heldSet
  )
  const bestRaw = others.reduce<number | null>(
    (m, it) => Math.max(m ?? -Infinity, baseArrival - endOf(it)),
    null
  )
  const dead = planDeadWhy(remaining, baseline, input)
  if (dead) {
    return empty('plan-dead', {
      ...base,
      bestRawSavingMs: bestRaw,
      planDead: dead
    })
  }
  if (!others.length) return empty('no-candidate', base)

  // The rider's own route set may have an earlier catchable run in the same
  // answer (the held plan sits on a later bus). Moving the rider onto it is the
  // retarget's job (catch-the-run, 23.3) and never needs an offer; a DIFFERENT
  // route is only worth offering if it beats that run too — otherwise "57 min
  // faster · 465" is really "your Orange Line, 53 min sooner" (2026-09-21
  // 09:15, 0921-0902-orange-lake-st).
  let bar = baseline
  let barSource: BaselineSource = found.source
  for (const it of input.answer || []) {
    if (!Number.isFinite(endOf(it)) || routeSetOf(it) !== heldSet) continue
    if (savingOf(bar, it, input.referenceBikeSpeedMps) <= 0) continue
    if (candidateNotCatchable(it, baseline, input)) continue
    bar = it
    barSource = 'own-route-earlier-run'
  }
  const baseBike = bikeMetersOf(bar)
  const nextTripId = legTripId(remaining[0])

  const rejected: string[] = []
  let sameBus = 0
  let faster: Itinerary | null = null
  let lessBike: Itinerary | null = null
  for (const it of others) {
    const saving = savingOf(bar, it, input.referenceBikeSpeedMps)
    const bikeSaved = baseBike - bikeMetersOf(it)
    const isFaster = saving >= FASTER_ROUTE_MIN_SAVING_MS
    const isLessBike =
      Math.abs(saving) <= LESS_BIKE_ARRIVAL_BAND_MS &&
      bikeSaved >= LESS_BIKE_MIN_METERS
    if (!isFaster && !isLessBike) continue
    // Boarding the rider's own next bus and changing only the tail (a bus hop
    // instead of the closing bike, an earlier alight onto another route) is
    // not a different route to switch to now: it is the aboard get-off
    // offer's question, asked on that bus with live times (2026-09-15 09:43:
    // "Orange Line + 546" offered 15 min faster at a 2.47 m/s observed pace;
    // the rider rode the plan and arrived 10:27:44, level with it). A FEEDER
    // bus that reaches the same bus instead of the access bike stays — that
    // is the "Blue Line -> 539" less-biking case the rider asked for (55.1).
    if (nextTripId && tripIdsMatch(legTripId(transitLegs(it)[0]), nextTripId)) {
      sameBus++
      continue
    }
    const why = candidateNotCatchable(it, baseline, input)
    if (why) {
      rejected.push(why)
      continue
    }
    if (
      isFaster &&
      (!faster || saving > savingOf(bar, faster, input.referenceBikeSpeedMps))
    ) {
      faster = it
    }
    if (
      isLessBike &&
      (!lessBike || bikeMetersOf(it) < bikeMetersOf(lessBike))
    ) {
      lessBike = it
    }
  }
  const pick = faster || lessBike
  const base2 = { baseline: bar, baselineSource: barSource }
  if (!pick) {
    const why: FasterRouteWhy = rejected.length
      ? 'not-catchable'
      : sameBus
      ? 'same-bus'
      : 'not-better'
    return empty(why, {
      ...base2,
      bestRawSavingMs: bestRaw,
      rejected
    })
  }
  return {
    ...base2,
    bestRawSavingMs: bestRaw,
    bikeSavedM: Math.round(baseBike - bikeMetersOf(pick)),
    candidate: pick,
    kind: faster ? 'faster' : 'lessBike',
    planDead: null,
    rejected,
    routeSet: routeSetOf(pick),
    savingMs: savingOf(bar, pick, input.referenceBikeSpeedMps),
    why: 'offer'
  }
}

/* ------------------------------------------------------------------------ */
/* Aboard: a better stop to get off (rider Q4)                              */
/* ------------------------------------------------------------------------ */

/**
 * The planned onward transit leg AS THE CARD SHOWS IT: its route, the stop it
 * boards at and the time the card gives for that boarding. Its trip id is a
 * hint, not the key — a plan retargeted onto an earlier run once carried the
 * old run's onward trip id at a time that trip does not run (56.1, 2026-10-19:
 * `1:1262609` shown at Robert 09:16:04, really 09:35:09), and a baseline
 * taken by that id read 16.8 min "faster" for a 19 s gain.
 */
export interface PlannedOnward {
  boardMs: number | null
  boardStopId: string | null
  routeId: string | null
  tripId: string | null
}

/** How far an answer's boarding may sit from the card's and still be it. */
export const ONWARD_BOARD_MATCH_MS = 180000

/**
 * The planned onward leg after the leg at `aboardLegIndex`, as the card shows
 * it: the live board time when the card has a real one, else the plan's.
 */
export function plannedOnwardOf(
  held: Itinerary | null | undefined,
  aboardLegIndex: number,
  liveLegTimes?: Record<number, any> | any[] | null
): PlannedOnward | null {
  const legs = (held?.legs || []) as Leg[]
  for (let i = aboardLegIndex + 1; i < legs.length; i++) {
    const leg = legs[i]
    if (!leg?.transitLeg) continue
    const live: any = (liveLegTimes as any)?.[i]
    const liveBoard =
      live?.boardRealtime && !live.boardIsFloor ? Number(live.boardEpoch) : NaN
    const planned = Number(leg.startTime)
    return {
      boardMs: Number.isFinite(liveBoard)
        ? liveBoard
        : Number.isFinite(planned)
        ? planned
        : null,
      boardStopId: boardStopId(leg),
      routeId: getLegRouteId(leg),
      tripId: legTripId(leg)
    }
  }
  return null
}

export interface AlightOfferInput {
  boarded?: BoardedTrip | null
  downstream?: DownstreamStop[] | null
  nowMs?: number | null
  /**
   * The planned onward leg (plannedOnwardOf). When given, it decides; the
   * bare trip id below is the older key, kept for callers that have no leg.
   */
  plannedOnward?: PlannedOnward | null
  /** The planned onward transit trip after the alight; null = street onward. */
  plannedOnwardTripId: string | null
  /** The stop the plan gets the rider off at. */
  plannedStopId: string
  results: AlightCandidateResult[]
}

export interface AlightOfferVerdict {
  baselineArrival: number | null
  bikeSavedM: number
  candidate: AlightOption | null
  candidateArrival: number | null
  kind: FasterRouteKind | null
  savingMs: number
  why:
    | 'no-baseline'
    | 'no-candidate'
    | 'same-as-plan'
    | 'not-better'
    | 'planned-stop-ties'
    | 'offer'
}

/**
 * Is this onward itinerary the plan's own continuation from its stop? With a
 * PlannedOnward: its first transit leg is the planned route from the planned
 * boarding stop within ONWARD_BOARD_MATCH_MS of the card's board time — or the
 * planned trip itself (still a real run of the plan; the earliest wins in the
 * caller). Without one, by trip id alone, as before.
 */
function isPlannedOnward(
  itin: Itinerary,
  input: Pick<AlightOfferInput, 'plannedOnward' | 'plannedOnwardTripId'>
): boolean {
  const first = transitLegs(itin)[0]
  const planned = input.plannedOnward
  if (planned === undefined) {
    if (!input.plannedOnwardTripId) return !first
    return !!first && tripIdsMatch(legTripId(first), input.plannedOnwardTripId)
  }
  if (!planned) return !first
  if (!first) return false
  if (planned.tripId && tripIdsMatch(legTripId(first), planned.tripId)) {
    return true
  }
  const start = Number(first.startTime)
  return (
    !!planned.routeId &&
    getLegRouteId(first) === planned.routeId &&
    !!planned.boardStopId &&
    boardStopId(first) === planned.boardStopId &&
    planned.boardMs != null &&
    Number.isFinite(start) &&
    Math.abs(start - planned.boardMs) <= ONWARD_BOARD_MATCH_MS
  )
}

/**
 * Aboard, should the rider be offered a different stop to get off and
 * continue? Read-only over the optimizer: the candidate is the top of
 * `rankAlightOptions` (its own comparator, no keep-route bias — the rider's
 * route is the BASELINE here, not a tie-breaker); the baseline is the option in
 * the same optimizer answer that gets off at the planned stop and continues on
 * the planned onward trip. Same thresholds as off the bus.
 */
export function compareAlightOffer(
  input: AlightOfferInput
): AlightOfferVerdict {
  const none = (
    why: AlightOfferVerdict['why'],
    extra: Partial<AlightOfferVerdict> = {}
  ): AlightOfferVerdict => ({
    baselineArrival: null,
    bikeSavedM: 0,
    candidate: null,
    candidateArrival: null,
    kind: null,
    savingMs: 0,
    why,
    ...extra
  })
  let baselineArrival: number | null = null
  let baselineBike = 0
  for (const r of input.results || []) {
    if (!r || r.error || r.stopId !== input.plannedStopId) continue
    for (const itin of r.itineraries || []) {
      if (!isPlannedOnward(itin, input)) continue
      const arrival = scoreAlightOption(r.busArrivalEpoch, itin)
      if (baselineArrival == null || arrival < baselineArrival) {
        baselineArrival = arrival
        baselineBike = bikeMetersOf(itin)
      }
    }
  }
  if (baselineArrival == null) return none('no-baseline')
  const ranked = rankAlightOptions(input.results || [], {
    boarded: input.boarded ?? null,
    downstream: input.downstream ?? null,
    limit: 1,
    nowMs: input.nowMs ?? null
  })
  const winner = ranked[0]
  if (!winner) return none('no-candidate', { baselineArrival })
  const arrivalOf = (o: AlightOption) =>
    scoreAlightOption(o.busArrivalEpoch, o.itinerary, {
      arrivalIsFloor: o.arrivalIsFloor
    })
  // A tie goes to the planned stop (56.1, 2026-10-19: 5th St & Cedar and Rice
  // Park arrived 10:00:06 on Gold Line run 1:1344457 — and so did staying on
  // to 5th St & Robert). When getting off at the planned stop, onto ANY onward
  // in the same answer, arrives within the same-arrival band of the winner and
  // the winner does not save a kilometre of biking over it, that stay is the
  // candidate: the plan itself (no offer), or the planned stop with a better
  // onward — never a different stop for no gain.
  const stay = preferPlannedStop(input, winner, arrivalOf(winner))
  if (stay && !stay.ties) {
    // Staying arrives as early, and the winner's only gain is the biking:
    // measured against the stay, not against the planned onward.
    const stayArrival = arrivalOf(stay.option)
    const winnerArrival = arrivalOf(winner)
    const stayExtra = {
      baselineArrival: stayArrival,
      bikeSavedM: Math.round(
        bikeMetersOf(stay.option.itinerary) - bikeMetersOf(winner.itinerary)
      ),
      candidate: winner,
      candidateArrival: winnerArrival,
      savingMs: stayArrival - winnerArrival
    }
    return Math.abs(stayExtra.savingMs) <= LESS_BIKE_ARRIVAL_BAND_MS
      ? { ...stayExtra, kind: 'lessBike', why: 'offer' }
      : none('planned-stop-ties', stayExtra)
  }
  const top = stay?.option ?? winner
  const candidateArrival = arrivalOf(top)
  const savingMs = baselineArrival - candidateArrival
  const bikeSavedM = Math.round(baselineBike - bikeMetersOf(top.itinerary))
  const extra = {
    baselineArrival,
    bikeSavedM,
    candidate: top,
    candidateArrival,
    savingMs
  }
  if (
    top.stopId === input.plannedStopId &&
    isPlannedOnward(top.itinerary, input)
  ) {
    return none(top === winner ? 'same-as-plan' : 'planned-stop-ties', extra)
  }
  if (savingMs >= FASTER_ROUTE_MIN_SAVING_MS) {
    return { ...extra, kind: 'faster', why: 'offer' }
  }
  if (
    Math.abs(savingMs) <= LESS_BIKE_ARRIVAL_BAND_MS &&
    bikeSavedM >= LESS_BIKE_MIN_METERS
  ) {
    return { ...extra, kind: 'lessBike', why: 'offer' }
  }
  return none('not-better', extra)
}

/**
 * The planned stop's own option that arrives no later than the same-arrival
 * band after `winner` (a different stop) — the planned onward first, else the
 * ranker's best. `ties` when the winner does not save LESS_BIKE_MIN_METERS of
 * biking over it. Null when the winner is already at the planned stop or
 * nothing there comes close.
 */
function preferPlannedStop(
  input: AlightOfferInput,
  winner: AlightOption,
  winnerArrival: number
): { option: AlightOption; ties: boolean } | null {
  if (winner.stopId === input.plannedStopId) return null
  const close = rankAlightOptions(
    (input.results || []).filter((r) => r?.stopId === input.plannedStopId),
    {
      boarded: input.boarded ?? null,
      downstream: input.downstream ?? null,
      limit: 50,
      nowMs: input.nowMs ?? null
    }
  ).filter(
    (o) =>
      scoreAlightOption(o.busArrivalEpoch, o.itinerary, {
        arrivalIsFloor: o.arrivalIsFloor
      }) -
        winnerArrival <=
      LESS_BIKE_ARRIVAL_BAND_MS
  )
  if (!close.length) return null
  const savesOver = (o: AlightOption) =>
    bikeMetersOf(o.itinerary) - bikeMetersOf(winner.itinerary)
  const tied = close.filter((o) => savesOver(o) < LESS_BIKE_MIN_METERS)
  if (tied.length) {
    return {
      option: tied.find((o) => isPlannedOnward(o.itinerary, input)) ?? tied[0],
      ties: true
    }
  }
  // Every close stay bikes a kilometre more: the least-biking one is the bar.
  const least = close.reduce((m, o) => (savesOver(o) < savesOver(m) ? o : m))
  return { option: least, ties: false }
}

/**
 * Why the plan's own continuation from the planned stop is already lost, aboard
 * (cycle 25 B4) — or null when it still stands. compareAlightOffer measures
 * every candidate against "off at the planned stop, onto the planned onward
 * trip"; if that connection cannot be made, the saving is measured against a
 * trip the rider is not going to get, and putting it on a card as "4 min
 * faster" misstates it. That is the missed-bus path's question, not this one's.
 *
 * - missed-bus recovery is running;
 * - `connection-lost`: the bus reaches the planned stop (live, from the same
 *   optimizer run) too late to make the planned onward boarding — the plan's
 *   own transfer legs between them still have to be walked or biked — by more
 *   than PLAN_DEAD_BOARD_PAST_MS;
 * - `board-stop-unreachable`: the only way the answer from the planned stop
 *   still catches the onward trip is at a DIFFERENT stop, later than planned
 *   (OTP chasing the bus down the line), the aboard twin of planDeadWhy's.
 *
 * A street-only onward has no connection to lose: only missed-bus recovery.
 */
export type AboardPlanDeadWhy =
  | 'board-stop-unreachable'
  | 'connection-lost'
  | 'missed-bus-recovery'

export function aboardPlanDeadWhy(input: {
  /** The held plan's legs AFTER the leg the rider is riding. */
  heldTail: Leg[]
  missedBusRecoveryActive?: boolean
  nowMs: number
  /** The planned onward leg's live board time, when the card has one. */
  onwardLiveBoardMs?: number | null
  /** The bus's arrival at the planned alight stop (the optimizer's own). */
  plannedStopArrivalMs: number | null
  plannedStopId: string
  results: AlightCandidateResult[]
}): AboardPlanDeadWhy | null {
  if (input.missedBusRecoveryActive) return 'missed-bus-recovery'
  const onwardIdx = (input.heldTail || []).findIndex((l) => l?.transitLeg)
  if (onwardIdx < 0) return null
  const onward = input.heldTail[onwardIdx]
  const board =
    input.onwardLiveBoardMs != null && Number.isFinite(input.onwardLiveBoardMs)
      ? Number(input.onwardLiveBoardMs)
      : Number(onward.startTime)
  if (!Number.isFinite(board)) return null
  const transferMs = input.heldTail
    .slice(0, onwardIdx)
    .reduce((sum, leg) => sum + (Number(leg.duration) || 0) * 1000, 0)
  const reach =
    input.plannedStopArrivalMs != null &&
    Number.isFinite(input.plannedStopArrivalMs)
      ? Number(input.plannedStopArrivalMs) + transferMs
      : input.nowMs
  if (reach > board + PLAN_DEAD_BOARD_PAST_MS) return 'connection-lost'
  const onwardTrip = legTripId(onward)
  const onwardStop = boardStopId(onward)
  const chased: Leg[] = []
  for (const r of input.results || []) {
    if (!r || r.error || r.stopId !== input.plannedStopId) continue
    for (const itin of r.itineraries || []) {
      const first = transitLegs(itin)[0]
      if (first && tripIdsMatch(legTripId(first), onwardTrip))
        chased.push(first)
    }
  }
  if (
    chased.length &&
    onwardStop &&
    chased.every(
      (leg) =>
        boardStopId(leg) != null &&
        boardStopId(leg) !== onwardStop &&
        Number(leg.startTime) > board
    )
  ) {
    return 'board-stop-unreachable'
  }
  return null
}

/* ------------------------------------------------------------------------ */
/* Latch                                                                    */
/* ------------------------------------------------------------------------ */

export interface FasterRouteOfferKey {
  bikeSavedM: number
  kind: FasterRouteKind
  /** routeSetOf(candidate), or for an aboard offer `stopId|routeSet`. */
  routeSet: string
  savingMs: number
}

export interface FasterRouteLatch {
  /** The offer the rider kept (or let lapse); a new one must beat it. */
  held: FasterRouteOfferKey | null
  /** Every route set raised this ride — never raised again. */
  offeredRouteSets: string[]
  offers: number
  pushes: number
}

export const EMPTY_FASTER_ROUTE_LATCH: FasterRouteLatch = {
  held: null,
  offeredRouteSets: [],
  offers: 0,
  pushes: 0
}

export type LatchWhy = 'ok' | 'offer-cap' | 'same-route-set' | 'held-by-keep'

/**
 * May this offer be raised? A Keep (or an offer the rider let pass) holds
 * until something beats it by +3 min or +1 km more; a route set already
 * offered this ride never comes back; at most 3 offers and 2 pushes a ride.
 * `push` says whether a push is still within the cap — whether to SEND one
 * (phone locked) is the caller's call.
 */
export function latchAllows(
  latch: FasterRouteLatch,
  offer: FasterRouteOfferKey
): { allow: boolean; push: boolean; why: LatchWhy } {
  const push = latch.pushes < MAX_FASTER_ROUTE_PUSHES_PER_RIDE
  if (latch.offers >= MAX_FASTER_ROUTE_OFFERS_PER_RIDE) {
    return { allow: false, push: false, why: 'offer-cap' }
  }
  if (latch.offeredRouteSets.indexOf(offer.routeSet) >= 0) {
    return { allow: false, push: false, why: 'same-route-set' }
  }
  const held = latch.held
  if (held) {
    const beatsTime = offer.savingMs >= held.savingMs + LATCH_REARM_SAVING_MS
    const beatsBike = offer.bikeSavedM >= held.bikeSavedM + LATCH_REARM_BIKE_M
    if (!beatsTime && !beatsBike) {
      return { allow: false, push: false, why: 'held-by-keep' }
    }
  }
  return { allow: true, push, why: 'ok' }
}

/** The latch after an offer is raised (and, if `pushed`, a push sent). */
export function latchRecordOffer(
  latch: FasterRouteLatch,
  offer: FasterRouteOfferKey,
  pushed = false
): FasterRouteLatch {
  return {
    held: offer,
    offeredRouteSets: latch.offeredRouteSets.concat(offer.routeSet),
    offers: latch.offers + 1,
    pushes: latch.pushes + (pushed ? 1 : 0)
  }
}
