import type { Itinerary, Leg } from '@opentripplanner/types'

import {
  bikeMetersOf,
  compareAlightOffer,
  FASTER_ROUTE_MIN_SAVING_MS,
  fasterRoutePool,
  isPlannedOnward,
  LESS_BIKE_ARRIVAL_BAND_MS,
  LESS_BIKE_MIN_METERS,
  poolCandidateBlock,
  savingOverBar
} from './faster-route'
import { getLegRouteId } from './departure-anchor'
import { rankAlightOptions, scoreAlightOption } from './alight-optimizer'
import type {
  AlightOfferInput,
  AlightOfferVerdict,
  FasterRouteInput,
  FasterRoutePool,
  FasterRouteVerdict
} from './faster-route'
import type { AlightOption } from './alight-optimizer'

/**
 * Auto mode's presets (backlog 65.2, cycle 36 B1; rider Q1 = C, 2026-10-25).
 *
 * Pure: it ranks; it never switches. B2 decides whether a pick is acted on.
 * Each preset is a rule over 56.1's candidate pool (the answer's itineraries
 * on a different route set, catchable from where the rider is, not the
 * rider's own next bus with a new tail) measured against 56.1's bar (the
 * rider's own trips in the same answer, or an earlier catchable run of their
 * own route). A candidate worse on the preset's main metric never qualifies.
 *
 * - fastest: exactly 56.1's offer rule (≥ 3 min earlier at both paces, or
 *   within ±2 min with ≥ 1 km less biking), so a Fastest pick ≡ today's offer.
 * - leastBike: ≥ 1 km less biking and at most the allowance after the bar;
 *   or no more biking and ≥ 3 min earlier.
 * - simplest: fewer vehicle changes and at most the allowance after the bar;
 *   or the same changes and ≥ 3 min earlier. No biking limit (the rider
 *   chose that on 2026-10-26; see SIMPLEST_MAX_ADDED_BIKE_M).
 * - stayOnRoute: never a different route.
 */

export type AutoPreset = 'fastest' | 'leastBike' | 'simplest' | 'stayOnRoute'

export const AUTO_PRESETS: AutoPreset[] = [
  'fastest',
  'leastBike',
  'simplest',
  'stayOnRoute'
]

/**
 * How much later than the bar a Least biking / Simplest switch may arrive:
 * 56.1's ±2 min "same arrival" band. Plan rev 2 proposed +5 min, to be
 * tightened on a wrong switch, and the 2026-10-25 fixture sweep found one:
 * on ride-0930-1648 Least biking at +5 min went 904 → 18+924 (16:51:10,
 * 3.7 min later), back to 904 (16:52:40) and to 18+924 again (16:54:17,
 * 3.3 min later) — a reversal inside 3 min that ±2 min does not make (one
 * switch, 16:55:47).
 */
export const AUTO_LATER_ALLOWANCE_MS = 120000

/**
 * Simplest's biking limit: how much MORE than the bar a Simplest pick may
 * bike. The rider chose NO limit on 2026-10-26 (cycle 36 Q3 = "fewer changes
 * wins, any biking"), so this is `Infinity`; B1's sweep had found
 * h5he2i-0931 09:32:57 → route 4 (one fewer change, +4.8 km of biking). Set a
 * number here to bring the guard back.
 */
export const SIMPLEST_MAX_ADDED_BIKE_M = Infinity

/** Vehicle changes: transit legs − 1, a stay-seated interline not counted
 * (equals OTP's `transfers` on all 15,113 fixture itineraries). */
export function changesOf(itin: Itinerary | null | undefined): number {
  const boardings = ((itin?.legs || []) as Leg[]).filter(
    (leg: any) => leg.transitLeg && !leg.interlineWithPreviousLeg
  ).length
  return Math.max(0, boardings - 1)
}

/** Waiting: the gap before each transit leg after the leg before it, ms
 * (equals OTP's `waitingTime` × 1000 on all 15,113 fixture itineraries). */
export function waitMsOf(itin: Itinerary | null | undefined): number {
  const legs = (itin?.legs || []) as Leg[]
  let wait = 0
  for (let i = 1; i < legs.length; i++) {
    if (!legs[i].transitLeg) continue
    const gap = Number(legs[i].startTime) - Number(legs[i - 1].endTime)
    if (Number.isFinite(gap) && gap > 0) wait += gap
  }
  return wait
}

/** Metres walked in an itinerary. */
export function walkMetersOf(itin: Itinerary | null | undefined): number {
  return ((itin?.legs || []) as Leg[]).reduce(
    (sum, leg) => sum + (leg.mode === 'WALK' ? Number(leg.distance) || 0 : 0),
    0
  )
}

export interface AutoScore {
  bikeM: number
  /** Bar's biking minus this candidate's (positive = less biking). */
  bikeSavedM: number
  changes: number
  itinerary: Itinerary
  /** Bar arrival minus this arrival at both paces (positive = earlier). */
  savingMs: number
  waitMs: number
  walkM: number
}

export interface AutoRankOptions {
  /** Least biking / Simplest's later-than-bar allowance (default ±2 min). */
  allowanceMs?: number
  /** The plan's own bike pace (savingOf's reference). */
  referenceBikeSpeedMps?: number | null
}

export interface AutoRank {
  pick: AutoScore | null
  preset: AutoPreset
  /** The qualifying candidates in pick order (pick = ranked[0]). */
  ranked: AutoScore[]
  why: 'switch' | 'not-better' | 'no-candidate' | 'stay-on-route'
}

export function scoreAgainstBar(
  it: Itinerary,
  bar: Itinerary,
  refMps?: number | null
): AutoScore {
  const bikeM = bikeMetersOf(it)
  return {
    bikeM,
    bikeSavedM: bikeMetersOf(bar) - bikeM,
    changes: changesOf(it),
    itinerary: it,
    savingMs: savingOverBar(bar, it, refMps),
    waitMs: waitMsOf(it),
    walkM: walkMetersOf(it)
  }
}

const isFasterOf = (s: AutoScore) => s.savingMs >= FASTER_ROUTE_MIN_SAVING_MS
const isLessBikeOf = (s: AutoScore) =>
  Math.abs(s.savingMs) <= LESS_BIKE_ARRIVAL_BAND_MS &&
  s.bikeSavedM >= LESS_BIKE_MIN_METERS

/** Does `s` qualify under `preset`, against a bar with `barChanges`? */
export function qualifiesForPreset(
  s: AutoScore,
  barChanges: number,
  preset: AutoPreset,
  allowanceMs = AUTO_LATER_ALLOWANCE_MS
): boolean {
  switch (preset) {
    case 'fastest':
      return isFasterOf(s) || isLessBikeOf(s)
    case 'leastBike':
      return (
        (s.bikeSavedM >= LESS_BIKE_MIN_METERS && s.savingMs >= -allowanceMs) ||
        (s.bikeSavedM >= 0 && isFasterOf(s))
      )
    case 'simplest':
      return (
        s.bikeSavedM >= -SIMPLEST_MAX_ADDED_BIKE_M &&
        ((s.changes < barChanges && s.savingMs >= -allowanceMs) ||
          (s.changes === barChanges && isFasterOf(s)))
      )
    default:
      return false
  }
}

type Cmp = (a: AutoScore, b: AutoScore) => number
const chain =
  (...cmps: Cmp[]): Cmp =>
  (a, b) => {
    for (const c of cmps) {
      const d = c(a, b)
      if (d) return d
    }
    return 0
  }
const bySavingDesc: Cmp = (a, b) => b.savingMs - a.savingMs
const byChanges: Cmp = (a, b) => a.changes - b.changes
const byWait: Cmp = (a, b) => a.waitMs - b.waitMs
const byBike: Cmp = (a, b) => a.bikeM - b.bikeM
const byWalk: Cmp = (a, b) => a.walkM - b.walkM

/** Stable sort: equal keys keep answer order (56.1's first-wins). */
const stableSort = (list: AutoScore[], cmp: Cmp): AutoScore[] =>
  list
    .map((s, i) => ({ i, s }))
    .sort((a, b) => cmp(a.s, b.s) || a.i - b.i)
    .map((x) => x.s)

/**
 * Rank `candidates` (pool candidates the rider can switch to now) against
 * `bar` under `preset`.
 *
 * Fastest keeps 56.1's pick: the faster group first (biggest saving, then
 * fewer changes, then less waiting), and only when it is empty the
 * less-biking group (fewest bike metres, then saving, then changes).
 * Least biking: fewest bike metres → arrival → fewer changes.
 * Simplest: fewer changes → less waiting → arrival → walking.
 */
export function rankForPreset(
  candidates: Itinerary[],
  bar: Itinerary,
  preset: AutoPreset,
  opts: AutoRankOptions = {}
): AutoRank {
  if (preset === 'stayOnRoute') {
    return { pick: null, preset, ranked: [], why: 'stay-on-route' }
  }
  if (!candidates.length) {
    return { pick: null, preset, ranked: [], why: 'no-candidate' }
  }
  const allowance = opts.allowanceMs ?? AUTO_LATER_ALLOWANCE_MS
  const barChanges = changesOf(bar)
  const scored = candidates.map((it) =>
    scoreAgainstBar(it, bar, opts.referenceBikeSpeedMps)
  )
  const ok = scored.filter((s) =>
    qualifiesForPreset(s, barChanges, preset, allowance)
  )
  let ranked: AutoScore[]
  if (preset === 'fastest') {
    const faster = stableSort(
      ok.filter(isFasterOf),
      chain(bySavingDesc, byChanges, byWait)
    )
    const lessBike = stableSort(
      ok.filter((s) => !isFasterOf(s)),
      chain(byBike, bySavingDesc, byChanges)
    )
    ranked = faster.concat(lessBike)
  } else if (preset === 'leastBike') {
    ranked = stableSort(ok, chain(byBike, bySavingDesc, byChanges))
  } else {
    ranked = stableSort(ok, chain(byChanges, byWait, bySavingDesc, byWalk))
  }
  return {
    pick: ranked[0] ?? null,
    preset,
    ranked,
    why: ranked.length ? 'switch' : 'not-better'
  }
}

export interface AutoPresetVerdict extends AutoRank {
  /** Pool candidates removed before ranking, by reason. */
  blocked: Record<string, number>
  /** The pool's early verdict when the question could not be put. */
  early: FasterRouteVerdict | null
  pool: FasterRoutePool | null
}

/**
 * The off-bus Auto judgement for one background answer: 56.1's pool and
 * bar, the candidates the rider can switch to now, ranked by `preset`.
 */
export function autoPresetVerdict(
  input: FasterRouteInput,
  preset: AutoPreset,
  opts: Omit<AutoRankOptions, 'referenceBikeSpeedMps'> = {}
): AutoPresetVerdict {
  const { early, pool } = fasterRoutePool(input)
  if (!pool) {
    return {
      blocked: {},
      early,
      pick: null,
      pool: null,
      preset,
      ranked: [],
      why: 'no-candidate'
    }
  }
  const blocked: Record<string, number> = {}
  const open: Itinerary[] = []
  if (preset !== 'stayOnRoute') {
    for (const it of pool.others) {
      const why = poolCandidateBlock(pool, it, input)
      if (why) blocked[why] = (blocked[why] || 0) + 1
      else open.push(it)
    }
  }
  return {
    ...rankForPreset(open, pool.bar, preset, {
      ...opts,
      referenceBikeSpeedMps: input.referenceBikeSpeedMps
    }),
    blocked,
    early: null,
    pool
  }
}

/* ------------------------------------------------------------------------ */
/* Aboard: re-score the get-off options by preset                           */
/* ------------------------------------------------------------------------ */

export interface AutoAlightScore {
  arrival: number
  bikeM: number
  bikeSavedM: number
  /** Vehicles boarded after getting off (0 = walk/bike the rest). */
  changes: number
  option: AlightOption
  savingMs: number
  waitMs: number
  walkM: number
}

export interface AutoAlightVerdict {
  /** For Fastest: compareAlightOffer's own verdict, unchanged. */
  fastest: AlightOfferVerdict | null
  pick: AutoAlightScore | null
  preset: AutoPreset
  ranked: AutoAlightScore[]
  why: 'switch' | 'not-better' | 'no-baseline' | 'no-candidate'
}

const boardings = (itin: Itinerary): number =>
  ((itin?.legs || []) as Leg[]).filter(
    (leg: any) => leg.transitLeg && !leg.interlineWithPreviousLeg
  ).length

const firstTransit = (itin: Itinerary): Leg | undefined =>
  ((itin?.legs || []) as Leg[]).find((leg) => leg.transitLeg)

/**
 * Aboard, which get-off option does `preset` take? Fastest is
 * compareAlightOffer verbatim (today's aboard offer). The others re-score
 * every ranked option against the same baseline compareAlightOffer uses —
 * off at the planned stop onto the planned onward — with the off-bus rules
 * (changes = vehicles boarded after getting off). Stay on my route takes only
 * an option whose onward is the planned onward ROUTE from another stop, and
 * only when it clears Fastest's bar.
 */
export function rankAlightForPreset(
  input: AlightOfferInput,
  preset: AutoPreset,
  opts: Omit<AutoRankOptions, 'referenceBikeSpeedMps'> = {}
): AutoAlightVerdict {
  const none = (
    why: AutoAlightVerdict['why'],
    fastest: AlightOfferVerdict | null = null
  ): AutoAlightVerdict => ({ fastest, pick: null, preset, ranked: [], why })
  if (preset === 'fastest') {
    const v = compareAlightOffer(input)
    if (v.why !== 'offer' || !v.candidate) {
      return none(
        v.why === 'no-baseline'
          ? 'no-baseline'
          : v.why === 'no-candidate'
          ? 'no-candidate'
          : 'not-better',
        v
      )
    }
    const it = v.candidate.itinerary
    const pick: AutoAlightScore = {
      arrival: Number(v.candidateArrival),
      bikeM: bikeMetersOf(it),
      bikeSavedM: v.bikeSavedM,
      changes: boardings(it),
      option: v.candidate,
      savingMs: v.savingMs,
      waitMs: waitMsOf(it),
      walkM: walkMetersOf(it)
    }
    return { fastest: v, pick, preset, ranked: [pick], why: 'switch' }
  }
  // The baseline, exactly as compareAlightOffer finds it.
  let baseArrival: number | null = null
  let baseItin: Itinerary | null = null
  for (const r of input.results || []) {
    if (!r || r.error || r.stopId !== input.plannedStopId) continue
    for (const itin of r.itineraries || []) {
      if (!isPlannedOnward(itin, input)) continue
      const arrival = scoreAlightOption(r.busArrivalEpoch, itin)
      if (baseArrival == null || arrival < baseArrival) {
        baseArrival = arrival
        baseItin = itin
      }
    }
  }
  if (baseArrival == null || !baseItin) return none('no-baseline')
  const options = rankAlightOptions(input.results || [], {
    boarded: input.boarded ?? null,
    downstream: input.downstream ?? null,
    limit: 500,
    nowMs: input.nowMs ?? null
  }).filter(
    (o) =>
      !(o.stopId === input.plannedStopId && isPlannedOnward(o.itinerary, input))
  )
  if (!options.length) return none('no-candidate')
  const baseBike = bikeMetersOf(baseItin)
  const baseChanges = boardings(baseItin)
  const scored: AutoAlightScore[] = options.map((o) => {
    const arrival = scoreAlightOption(o.busArrivalEpoch, o.itinerary, {
      arrivalIsFloor: o.arrivalIsFloor
    })
    const bikeM = bikeMetersOf(o.itinerary)
    return {
      arrival,
      bikeM,
      bikeSavedM: baseBike - bikeM,
      changes: boardings(o.itinerary),
      option: o,
      savingMs: (baseArrival as number) - arrival,
      waitMs: waitMsOf(o.itinerary),
      walkM: walkMetersOf(o.itinerary)
    }
  })
  const allowance = opts.allowanceMs ?? AUTO_LATER_ALLOWANCE_MS
  const asScore = (s: AutoAlightScore): AutoScore => ({
    bikeM: s.bikeM,
    bikeSavedM: s.bikeSavedM,
    changes: s.changes,
    itinerary: s.option.itinerary,
    savingMs: s.savingMs,
    waitMs: s.waitMs,
    walkM: s.walkM
  })
  let ok: AutoAlightScore[]
  if (preset === 'stayOnRoute') {
    const routeId = input.plannedOnward?.routeId ?? null
    ok = scored.filter((s) => {
      const first = firstTransit(s.option.itinerary)
      return (
        !!routeId &&
        !!first &&
        getLegRouteId(first) === routeId &&
        s.option.stopId !== input.plannedStopId &&
        qualifiesForPreset(asScore(s), baseChanges, 'fastest', allowance)
      )
    })
  } else {
    ok = scored.filter((s) =>
      qualifiesForPreset(asScore(s), baseChanges, preset, allowance)
    )
  }
  const cmp: (a: AutoAlightScore, b: AutoAlightScore) => number =
    preset === 'leastBike'
      ? (a, b) =>
          a.bikeM - b.bikeM || a.arrival - b.arrival || a.changes - b.changes
      : preset === 'simplest'
      ? (a, b) =>
          a.changes - b.changes ||
          a.waitMs - b.waitMs ||
          a.arrival - b.arrival ||
          a.walkM - b.walkM
      : (a, b) => a.arrival - b.arrival || a.changes - b.changes
  const ranked = ok
    .map((s, i) => ({ i, s }))
    .sort((a, b) => cmp(a.s, b.s) || a.i - b.i)
    .map((x) => x.s)
  return {
    fastest: null,
    pick: ranked[0] ?? null,
    preset,
    ranked,
    why: ranked.length ? 'switch' : 'not-better'
  }
}
