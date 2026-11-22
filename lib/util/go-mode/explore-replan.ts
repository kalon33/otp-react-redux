/**
 * Calm / Wander in Go Mode (backlog 76.3).
 *
 * A trip started from a Calm or Wander card rides a bike leg planned by the
 * RunScout engine (util/bike-explore.ts). Go Mode re-plans the bike leg when
 * the rider drifts off it (actions/go-mode.ts quietReplanAccessLeg), and that
 * re-plan used to ask OTP alone — so the first wrong turn replaced the ride
 * the rider chose with OTP's fastest one, without a word. This module is the
 * pure half of asking the engine first: which mode the trip is in, whether the
 * leg is one the engine can re-plan, the one-candidate question, and turning
 * the answer into an access itinerary the SAME splice and the SAME acceptance
 * gate take. Every "no" here means: ask OTP exactly as before.
 *
 * The trip's mode (`goMode.exploreMode`) is the mode of the ride it started
 * with — `exploreRideOf(itinerary).mode`, Direct when the leg is OTP's — and
 * changes only when the rider uses the in-ride switch. It is NOT the
 * results-list switch's current value: that is a preference for the next
 * search, and a trip started from a Direct card (or one the engine could not
 * answer for) must stay byte-identical to the old Go Mode until the rider
 * asks otherwise. It is kept across every swap within the trip, so a bike leg
 * that OTP had to answer for once (engine unreachable, nothing feasible)
 * does not quietly turn the rest of the ride Direct.
 */
import type { Itinerary, Leg } from '@opentripplanner/types'

import {
  buildExploreRequest,
  exploreAccessItinerary,
  ExploreMode,
  ExploreResponse,
  ExploreResult,
  exploreRideOf,
  normalizeExploreMode
} from '../bike-explore'

/** The in-ride Direct / Calm / Wander switch (reducers/go-mode). */
export const SET_GO_MODE_EXPLORE_MODE = 'SET_GO_MODE_EXPLORE_MODE'

/**
 * Recording only: one per engine-first access re-plan, scalars only (no
 * coordinates, no place names). The verdict itself is AUTO_REPLAN with
 * `reason: 'quiet-replan-explore'`, like every other automatic re-plan.
 */
export const GO_MODE_EXPLORE_REPLAN = 'GO_MODE_EXPLORE_REPLAN'

/**
 * How long a moving rider's re-plan waits for the engine before asking OTP.
 * The question is one candidate: 86 ms (Calm) and 129 ms (Wander) on the live
 * engine, 2026-11-21; 651 ms for a four-stop Wander. The scoped OTP question
 * that follows is projected for its own ~0.2 s latency, so every second spent
 * here is road the rider covers before OTP is even asked — the general
 * timeout (BIKE_EXPLORE_TIMEOUT_MS, 6 s) is a results-list number.
 */
export const EXPLORE_REPLAN_TIMEOUT_MS = 1500

/** The AUTO_REPLAN reason the engine's candidate is judged under. */
export const EXPLORE_REPLAN_REASON = 'quiet-replan-explore'

/** The mode a trip starts in: its own bike ride's, else Direct. */
export function tripStartExploreMode(
  itinerary: Itinerary | null | undefined
): ExploreMode {
  return normalizeExploreMode(exploreRideOf(itinerary)?.mode)
}

/** The running trip's effective mode (Direct when unset). */
export function goModeExploreMode(goMode: any): ExploreMode {
  return normalizeExploreMode(goMode?.exploreMode)
}

/**
 * Is the stretch from `currentLegIndex` to the boarding at `boardLegIndex`
 * one the engine can re-plan? Exactly one leg: the rider's own bike, straight
 * into the bus — the shape 76.2's results list re-plans (exploreTargetOf). A
 * rented bike (the dock is where the ride must start or end), a walk, a bike
 * parked before a walk to the platform: not the engine's.
 */
export function isExploreAccessLeg(
  legs: Leg[] | null | undefined,
  currentLegIndex: number,
  boardLegIndex: number
): boolean {
  const list = legs || []
  if (boardLegIndex !== currentLegIndex + 1) return false
  const ride: any = list[currentLegIndex]
  const board: any = list[boardLegIndex]
  return (
    !!ride &&
    !!board?.transitLeg &&
    ride.mode === 'BICYCLE' &&
    !ride.transitLeg &&
    !ride.rentedBike
  )
}

/**
 * The board time the re-plan holds the ride to: the feed's prediction when it
 * is a live one (realtime, not a floor — the same trust the acceptance gate
 * gives it, replan-acceptance liveBoardForCandidate), else the plan's.
 */
export function exploreBoardEpochMs(
  boardLeg: Leg | null | undefined,
  live:
    | {
        boardEpoch?: number | null
        boardIsFloor?: boolean
        boardRealtime?: boolean
      }
    | null
    | undefined
): number | null {
  const liveEpoch = Number(live?.boardEpoch)
  if (live?.boardRealtime && !live.boardIsFloor && Number.isFinite(liveEpoch)) {
    return liveEpoch
  }
  const planned = Number(boardLeg?.startTime)
  return Number.isFinite(planned) ? planned : null
}

/** A place's stop id, for the engine's candidate id. */
function placeStopId(place: any): string {
  return place?.stopId || place?.stop?.gtfsId || place?.stop?.id || 'board-stop'
}

export interface ExploreReplanAsk {
  /** Epoch ms the bus leaves the boarding stop. */
  boardEpochMs: number | null
  /** The boarding stop (the transit leg's `from`). */
  boardPlace: any
  mode: ExploreMode
  /** Epoch ms the ride starts: where `origin` is, when the rider is there. */
  nowMs: number
  origin: { lat: number; lon: number }
  /** m/s: what the OTP question is sent (the rider's setting, else measured). */
  speed?: number | null
}

/**
 * Body of the one-candidate engine question, or null when there is nothing to
 * ask: Direct, no board time, a bus already gone, no usable stop or origin.
 */
export function exploreReplanRequest(ask: ExploreReplanAsk): any | null {
  const { boardEpochMs, boardPlace, mode, nowMs, origin, speed } = ask
  if (mode === 'direct') return null
  if (boardEpochMs == null || !Number.isFinite(boardEpochMs)) return null
  if (!Number.isFinite(nowMs) || boardEpochMs <= nowMs) return null
  return buildExploreRequest({
    candidates: [
      {
        busEpoch: boardEpochMs,
        id: placeStopId(boardPlace),
        lat: Number(boardPlace?.lat),
        lon: Number(boardPlace?.lon),
        name: boardPlace?.name || ''
      }
    ],
    mode,
    nowMs,
    origin,
    speed: speed != null && Number.isFinite(speed) ? speed : undefined
  })
}

/** Why the engine's answer could not be offered to the gate. */
export type ExploreReplanMiss =
  | 'no-answer'
  | 'no-candidate'
  | 'infeasible'
  | 'no-leg'

export type ExploreReplanAnswer =
  | { itinerary: Itinerary; miss: null; result: ExploreResult }
  | { itinerary: null; miss: ExploreReplanMiss; result: ExploreResult | null }

/**
 * The engine's answer as an access itinerary (origin → boarding stop, one
 * BICYCLE leg starting at `startMs`), or why there is none. `feasible: false`
 * means even the fastest ride misses the bus with the margin; "already at the
 * stop" comes back feasible with no leg — both are OTP's to answer.
 */
export function exploreReplanAccess(input: {
  boardPlace: any
  from: any
  mode: ExploreMode
  response: ExploreResponse | null
  startMs: number
  stopId: string
}): ExploreReplanAnswer {
  const { boardPlace, from, mode, response, startMs, stopId } = input
  if (!response) return { itinerary: null, miss: 'no-answer', result: null }
  const result =
    (response.candidates || []).find((c) => c?.id === stopId) ||
    (response.candidates || [])[0] ||
    null
  if (!result) return { itinerary: null, miss: 'no-candidate', result: null }
  if (!result.feasible) return { itinerary: null, miss: 'infeasible', result }
  const itinerary = exploreAccessItinerary({
    busEpoch: null,
    from,
    mode,
    result,
    startMs,
    to: boardPlace
  })
  if (!itinerary) return { itinerary: null, miss: 'no-leg', result }
  return { itinerary, miss: null, result }
}

/**
 * The engine's per-mode cap on time spent over the fastest ride: (factor,
 * plus seconds, ceiling on the extra). Mirrors `CAPS` in RunScout's
 * `runscout/bike.py` — the same numbers util/bike-explore.ts states as
 * "at most 20 % + 1 min" and "60 % + 4 min, never more than 20 min".
 */
const ENGINE_EXTRA_CAPS: Record<'calm' | 'wander', [number, number, number]> = {
  calm: [1.2, 60, 480],
  wander: [1.6, 240, 1200]
}

/**
 * Was the ride cut short by the BUS, not by the mode? `preference < 1` says
 * the engine settled for a blend toward the fastest ride, but it says so for
 * two reasons: the time before the bus did not fit the full ride, or the
 * mode's own cap on extra time did not. Only the first is "short on time".
 * The engine's limit is the ride that leaves a margin of 3 min + 10 % before
 * the bus: (depart_s − 180) / 1.1.
 */
export function exploreShortOnTime(input: {
  departS: number | null | undefined
  directDurationS: number | null | undefined
  mode: ExploreMode
  preference: number | null | undefined
  /**
   * The engine's own word on it (`time_limited`, engine ec090c0 and later):
   * the bus, not the mode's allowance, held the ride back. When present it
   * decides; the arithmetic below is for an engine that does not say.
   */
  timeLimited?: boolean | null
}): boolean {
  const { departS, directDurationS, mode, preference, timeLimited } = input
  if (mode === 'direct') return false
  if (preference == null || !Number.isFinite(preference) || preference >= 1) {
    return false
  }
  if (typeof timeLimited === 'boolean') return timeLimited
  if (
    departS == null ||
    !Number.isFinite(departS) ||
    directDurationS == null ||
    !Number.isFinite(directDurationS)
  ) {
    return false
  }
  const [factor, plus, ceiling] = ENGINE_EXTRA_CAPS[mode]
  const modeCap =
    directDurationS + Math.min(directDurationS * (factor - 1) + plus, ceiling)
  const timeLimit = (departS - 180) / 1.1
  return timeLimit < modeCap
}

/**
 * What an applied engine re-plan leaves on its bike leg for the card: the
 * ride was cut toward the fastest one because the bus was close (`partial`),
 * or all the way (`fastest`). Absent when the ride is the mode's own.
 */
export type ExploreShortfall = 'partial' | 'fastest'

/** The shortfall an applied ride carries, read off the current leg. */
export function legExploreShortfall(
  leg: Leg | null | undefined
): ExploreShortfall | null {
  const value = (leg as any)?.exploreShortfall
  return value === 'partial' || value === 'fastest' ? value : null
}

/**
 * Mark the access itinerary's bike leg with its shortfall (a new object; the
 * input is not touched). Unchanged when the ride is the mode's own.
 */
export function withExploreShortfall(
  access: Itinerary,
  shortOnTime: boolean,
  preference: number | null | undefined
): Itinerary {
  if (!shortOnTime) return access
  const shortfall: ExploreShortfall =
    preference != null && preference <= 0 ? 'fastest' : 'partial'
  return {
    ...access,
    legs: (access.legs || []).map((leg: any, i: number) =>
      i === 0 ? { ...leg, exploreShortfall: shortfall } : leg
    )
  } as Itinerary
}

/**
 * The GO_MODE_EXPLORE_REPLAN payload: how the engine question went, in
 * scalars. No coordinates and no place names (the ride's `via` and `places`
 * are where the rider is going).
 */
export function exploreReplanRecord(input: {
  answer: ExploreReplanAnswer | null
  departS: number | null
  elapsedMs: number
  mode: ExploreMode
  outcome: 'applied' | 'refused' | 'gone' | ExploreReplanMiss | 'not-asked'
  refusedBecause?: string | null
  riderAsked: boolean
  shortOnTime?: boolean
  speed: number | null
  tMs: number
}): Record<string, unknown> {
  const result = input.answer?.result || null
  return {
    calm: result?.calm ?? null,
    departS: input.departS,
    directDurationS: result?.direct?.duration_s ?? null,
    durationS: result?.duration_s ?? null,
    elapsedMs: input.elapsedMs,
    engineReason: result?.reason ?? null,
    feasible: result ? !!result.feasible : null,
    marginS: result?.margin_s ?? null,
    mode: input.mode,
    outcome: input.outcome,
    preference: result?.preference ?? null,
    refusedBecause: input.refusedBecause ?? null,
    riderAsked: input.riderAsked,
    shortOnTime: !!input.shortOnTime,
    speed: input.speed,
    tMs: input.tMs
  }
}
