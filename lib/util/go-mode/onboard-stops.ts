/**
 * ─── The rider's added stops on "I'm already on the bus" (backlog 63.1) ─────
 *
 * On 2026-10-20 (session `mvgplnrw-yvtqga`, 08:19 and 08:32) the search held a
 * stop the rider had added — 3322 Columbus Avenue, five minutes there — and
 * the onboard flow dropped it: every candidate plan went straight to the
 * destination with no `via`, and the trip it started carried
 * `multiStop: null`. Twice.
 *
 * The flow now carries the search's stops from the moment it opens. A stop
 * still ahead of the bus is simply kept — the candidates go through it and
 * the trip runs one segment at a time, the same as a trip started from the
 * results. A stop the bus has already left behind is the one thing the app
 * cannot decide for the rider (2026-10-20 Q2 = C, "Ask me each time"): a card
 * asks whether to still go there or skip it, and only then.
 *
 * "Behind" is measured on the bus's own run: a stop is passed when the run
 * came at least ONBOARD_STOP_PASSED_MARGIN_M nearer to it before the rider's
 * position than it ever comes after it. No absolute "near the route" line —
 * 3322 Columbus is ~580 m off the I-35W Orange Line, and the question is which
 * side of the rider the run's nearest pass is, not how near that is.
 *
 * Pure: no redux, no clock of its own.
 */
import type { Itinerary } from '@opentripplanner/types'

import {
  buildMultiStopPlan,
  markStopLegs,
  queryStops,
  queryStopStays,
  stopLabel
} from '../multi-stop'
import type { MultiStopPlan, StopPlace } from '../multi-stop'

import {
  closestApproachEitherSide,
  projectForwardOnShape,
  stopPositionsOnShape
} from './geometry'
import {
  decodeTripShape,
  ONBOARD_CONFIRM_FIX_MAX_AGE_MS
} from './onboard-confirm'
import { FIX_ACCURACY_MAX_M } from './transit-trust'
import type { RoundTripPlan } from './round-trip'

/**
 * The run must have come this much nearer to the stop behind the rider than
 * it comes ahead of them before the stop counts as passed. Wide enough that a
 * stop the run passes broadside — about as near on both sides — is never
 * asked about.
 */
export const ONBOARD_STOP_PASSED_MARGIN_M = 150

/** One of the rider's stops, as the onboard flow carries it. */
export interface OnboardStop extends StopPlace {
  /**
   * The rider has already said "Still go there" for this stop on this flow:
   * it is never asked about again. Undefined for a stop nobody asked about —
   * kept, because it was still ahead.
   */
  kept?: boolean
  /** The rider's minimum stay there, minutes (58.3); 0 for none. */
  stayMinutes: number
}

interface FixLike {
  coords?: {
    accuracy?: number | null
    latitude?: number | null
    longitude?: number | null
  } | null
  timestamp?: number | null
}

/**
 * The search's stops with their stays, as the onboard flow captures them at
 * BEGIN_ONBOARD_FLOW. `visitedNames`: stops a live multi-stop trip has already
 * reached (its segments before the current one) — those are done, not passed.
 */
export function onboardStopsFromQuery(
  query: any,
  visitedNames: string[] = []
): OnboardStop[] {
  const stays = queryStopStays(query)
  const visited = new Set(visitedNames.filter(Boolean))
  return queryStops(query)
    .map((stop, i) => ({ ...stop, stayMinutes: stays[i] ?? 0 }))
    .filter((stop) => !visited.has(stopLabel(stop)))
}

/** The same stop, by place (names can repeat; coordinates do not). */
export function sameOnboardStop(a: StopPlace, b: StopPlace): boolean {
  return a.lat === b.lat && a.lon === b.lon && (a.name ?? '') === (b.name ?? '')
}

/** A short identity for a stop list — a cache key, never shown. */
export function onboardStopsKey(
  stops: OnboardStop[] | null | undefined
): string {
  return (stops || [])
    .map((s) => `${s.lat},${s.lon}@${s.stayMinutes || 0}`)
    .join('|')
}

/**
 * What the candidate plans carry: the stops as `intermediatePlaces` and their
 * stays as `stopStays`, which planConstraintVariables turns into OTP `via`
 * visits — the same two fields a search from the planner sends.
 */
export function onboardStopsVia(stops: OnboardStop[] | null | undefined): {
  intermediatePlaces: StopPlace[]
  stopStays: number[]
} {
  const list = stops || []
  return {
    intermediatePlaces: list.map(({ lat, lon, name }) => ({ lat, lon, name })),
    stopStays: list.map((s) => s.stayMinutes || 0)
  }
}

/**
 * Where the rider is along the run, in metres from its first vertex, or null
 * when nothing says: a usable fix is projected forward from the stop before
 * the bus's next stop (or, without one, the stop before the nearest stop to
 * the fix — routes loop, so never a global nearest point); with no usable fix
 * the bus's next stop stands in for the rider.
 */
function riderAlongM(
  shape: Array<[number, number]>,
  stops: any[],
  point: [number, number] | null,
  nextStopId: string | null | undefined
): number | null {
  const positions = stopPositionsOnShape(shape, stops)
  const idOf = (s: any) => s?.id ?? s?.gtfsId ?? null
  const nextIdx = nextStopId
    ? stops.findIndex((s) => idOf(s) === nextStopId)
    : -1
  if (point) {
    let anchorIdx = nextIdx >= 0 ? nextIdx - 1 : -1
    if (nextIdx < 0) {
      let best = Infinity
      stops.forEach((s, i) => {
        if (s?.lat == null || s?.lon == null) return
        const d = Math.hypot(
          (s.lat - point[0]) * 111320,
          (s.lon - point[1]) * 111320 * Math.cos((point[0] * Math.PI) / 180)
        )
        if (d < best) {
          best = d
          anchorIdx = i - 1
        }
      })
    }
    const anchor =
      anchorIdx >= 0
        ? positions
            .slice(0, anchorIdx + 1)
            .reverse()
            .find((p) => p != null) ?? null
        : null
    const pos = projectForwardOnShape(shape, point, anchor ?? 0)
    if (pos) return pos.alongM
  }
  if (nextIdx >= 0) return positions[nextIdx]?.alongM ?? null
  return null
}

/**
 * Which of the rider's stops the bus has already left behind — undecided ones
 * only (a stop the rider has answered for is never asked about twice). Empty
 * when nothing says where the rider is: no usable fix and no next stop means
 * the app does not know, and a stop it cannot place is kept, not asked about.
 */
export function passedOnboardStops(input: {
  lastPosition: FixLike | null | undefined
  nextStopId?: string | null
  nowMs: number
  stops: OnboardStop[] | null | undefined
  trip: any
}): OnboardStop[] {
  const { lastPosition, nextStopId, nowMs, trip } = input
  const undecided = (input.stops || []).filter((s) => !s.kept)
  if (!undecided.length || !trip) return []
  const tripStops: any[] = (trip.stopTimes || []).map(
    (st: any) => st?.stop ?? null
  )
  // The trip's own shape; without one, the line through its stops.
  const shape =
    decodeTripShape(trip) ||
    (tripStops
      .filter((s) => s?.lat != null && s?.lon != null)
      .map((s) => [s.lat, s.lon]) as Array<[number, number]>)
  if (!shape.length) return []

  const lat = lastPosition?.coords?.latitude
  const lon = lastPosition?.coords?.longitude
  const accuracy = lastPosition?.coords?.accuracy
  const fixAgeMs =
    typeof lastPosition?.timestamp === 'number'
      ? nowMs - lastPosition.timestamp
      : null
  const usable =
    lat != null &&
    lon != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    (accuracy == null ||
      !Number.isFinite(accuracy) ||
      accuracy <= FIX_ACCURACY_MAX_M) &&
    (fixAgeMs == null || fixAgeMs <= ONBOARD_CONFIRM_FIX_MAX_AGE_MS)
  const point: [number, number] | null = usable
    ? [lat as number, lon as number]
    : null

  const along = riderAlongM(shape, tripStops, point, nextStopId)
  if (along == null) return []
  return undecided.filter((stop) => {
    const sides = closestApproachEitherSide(shape, [stop.lat, stop.lon], along)
    if (!sides || sides.behindM == null) return false
    return (
      sides.aheadM == null ||
      sides.behindM + ONBOARD_STOP_PASSED_MARGIN_M <= sides.aheadM
    )
  })
}

/** An itinerary without the multi-stop marks a plan it was cut from carried. */
function unmarked(itinerary: Itinerary): Itinerary {
  const { stopLegIndexes, stopStayMinutes, ...rest } = itinerary as any
  return rest as Itinerary
}

/**
 * Does this itinerary go through any of these stops? (The rider's plan, when
 * the rider has just skipped one of them: a plan that still detours there is
 * no longer their plan.)
 */
export function itineraryVisitsStops(
  itinerary: Itinerary | null | undefined,
  stops: StopPlace[]
): boolean {
  if (!itinerary || !stops.length) return false
  const marked = markStopLegs(unmarked(itinerary), stops) as any
  return !!marked?.stopLegIndexes?.length
}

/**
 * The trip an onboard Confirm starts, through the rider's stops: the
 * itinerary marked at each stop it reaches (markStopLegs) and split into
 * segments (buildMultiStopPlan) — exactly what a trip started from the
 * results gets (metro-itinerary.tsx). `itinerary` is segment 0 when there is a
 * plan; with no stop reached (every one skipped, or OTP routed round them)
 * the plan is null and the itinerary is the whole trip.
 */
export function onboardMultiStopStart(
  itinerary: Itinerary,
  stops: OnboardStop[] | null | undefined,
  roundTrip: RoundTripPlan | null = null
): { itinerary: Itinerary; multiStop: MultiStopPlan | null } {
  const list = stops || []
  if (!list.length) return { itinerary, multiStop: null }
  const { intermediatePlaces, stopStays } = onboardStopsVia(list)
  const marked = markStopLegs(
    unmarked(itinerary),
    intermediatePlaces,
    stopStays
  )
  const multiStop = buildMultiStopPlan(marked, roundTrip)
  return multiStop
    ? { itinerary: multiStop.segments[0], multiStop }
    : { itinerary, multiStop: null }
}
