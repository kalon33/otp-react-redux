import { Itinerary, Leg } from '@opentripplanner/types'

import { epochMs } from './go-mode/time'
import { routeSequence } from './go-mode/round-trip'
import type { RoundTripPlan } from './go-mode/round-trip'

/**
 * Multiple stops (backlog 43.1) — the shared contract between the search form,
 * the plan request, the results card and Go Mode.
 *
 * The rider's answer (2026-10-08): "Just want overall trip stats. Then go mode
 * does each leg at a time". Defaults where they did not say: stops are visited
 * in the order the rider adds them, using the same modes the search already
 * offers.
 *
 * Arrival times and a stay at each stop (backlog 58.3, the rider's 10-16 note
 * "add a time of arrival to intermediate stops … And a dwell time"; answers
 * 10-18: the stops the rider adds, a separate stay for each, times on the card
 * AND in the step list). The stay is a MINIMUM, like the round trip's: it
 * defaults to 0 and rides on `currentQuery.stopStays`, one number of minutes
 * per stop in the same order as the stops.
 *
 * - The stops ride on `currentQuery.intermediatePlaces` — the field otp-ui's
 *   query/URL helpers already carry (`intermediatePlaces=name::lat,lon`,
 *   repeated) — and become OTP `via` VISIT locations in the plan request.
 * - OTP returns ONE itinerary through every stop: the leg that ends at a stop
 *   is followed by the leg that leaves it. `markStopLegs` finds those
 *   boundaries, renames the place to the rider's own label and records them on
 *   the itinerary as `stopLegIndexes`.
 * - Go Mode splits the itinerary at those boundaries and guides one segment at
 *   a time (`MultiStopPlan`).
 *
 * Measured against production OTP 2026-10-08 (home → Perennial Cycle → Micro
 * Center, 10:00): one via call and a chain of two searches both arrive 11:44,
 * so the one call is used for every transit search. A STREET-ONLY plan (walk
 * only, bike only) with a via comes back EMPTY with no routing error, so the
 * street-only combination is planned as a chain of direct segments and
 * stitched (`stitchSegments`).
 *
 * Everything here is pure.
 */

/** The most stops a search carries (the call-taker's AddPlaceButton cap). */
export const MAX_STOPS = 3

/** How close a leg end has to be to a stop to be that stop's boundary. */
const STOP_MATCH_M = 30

/** The stay chips the stops form offers; 0 is "no stay". */
export const STOP_STAY_OPTIONS_MINUTES = [0, 15, 30, 60]

/** The longest stay a stop takes (the round trip's own ceiling). */
export const MAX_STOP_STAY_MINUTES = 720

export interface StopPlace {
  lat: number
  lon: number
  name?: string
}

/** An itinerary that runs through the rider's stops. */
export type MultiStopItinerary = Itinerary & {
  /** Index of the leg that ENDS at each stop, in visiting order. */
  stopLegIndexes?: number[]
  /** The stay asked for at each of those stops, in minutes (58.3). */
  stopStayMinutes?: number[]
}

/**
 * What `markStopLegs` puts on the place a leg LEAVES a rider's stop from
 * (`leg.from.riderStop`): the step list's time column only sees one leg, and
 * shows both times from this (58.3).
 */
export interface RiderStopMark {
  /** When the rider gets to the stop (the leg before's endTime), epoch ms. */
  arrivalTime: number
  /** The minimum stay asked for, in minutes. */
  stayMinutes: number
}

/** When the rider reaches one stop and when the plan leaves it. */
export interface StopTimes {
  arrivalTime: number
  leaveTime: number
  name: string
  stayMinutes: number
}

/** Go Mode's view of a multi-stop trip: one segment guided at a time. */
export interface MultiStopPlan {
  /** The segment being guided now (0-based). */
  index: number
  /**
   * The return half of a round trip, when the rider asked for one. It belongs
   * to the LAST segment only, so it rides here until that segment starts.
   */
  roundTrip?: RoundTripPlan | null
  /** The planned segments, in order; the last one ends at the destination. */
  segments: Itinerary[]
  /** Where each segment ends (the stops, then the destination). */
  stopNames: string[]
}

/** A usable place: finite lat/lon. */
export function isStopPlace(place: any): place is StopPlace {
  return (
    !!place &&
    Number.isFinite(Number(place.lat)) &&
    Number.isFinite(Number(place.lon))
  )
}

/**
 * The stops a query really carries. `intermediatePlaces` can hold empty
 * placeholders (the call-taker panel pushes `{}` for a field being typed) and,
 * straight off a URL with a single stop, a bare string — neither is a stop.
 */
export function queryStops(query: any): StopPlace[] {
  const raw = query?.intermediatePlaces
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isStopPlace)
    .slice(0, MAX_STOPS)
    .map((p: any) => ({ lat: Number(p.lat), lon: Number(p.lon), name: p.name }))
}

/** One stay, in whole minutes, within 0..MAX_STOP_STAY_MINUTES; else 0. */
export function clampStopStay(value: unknown): number {
  const minutes = Math.round(Number(value))
  if (!Number.isFinite(minutes) || minutes <= 0) return 0
  return Math.min(MAX_STOP_STAY_MINUTES, minutes)
}

/**
 * The stays as they are kept on the query: clamped, with trailing zeros
 * dropped, so "no stays" is always `[]` whatever was set and cleared — the
 * duplicate-search and URL checks compare it whole.
 */
export function canonicalStopStays(stays: unknown): number[] {
  const out = Array.isArray(stays) ? stays.map(clampStopStay) : []
  while (out.length && out[out.length - 1] === 0) out.pop()
  return out
}

/** The stay at each of the query's stops, in minutes — one per `queryStops`. */
export function queryStopStays(query: any): number[] {
  const stays = Array.isArray(query?.stopStays) ? query.stopStays : []
  return queryStops(query).map((_, i) => clampStopStay(stays[i]))
}

/**
 * The URL form of the stays, `stopStays=20,0,15`; undefined when there are
 * none. The stops travel as `intermediatePlaces=name::lat,lon`, which has no
 * room for a stay, so the stays are their own parameter.
 */
export function stopStaysParam(stays: unknown): string | undefined {
  const canonical = canonicalStopStays(stays)
  return canonical.length ? canonical.join(',') : undefined
}

/** Read `stopStays` back off the URL (a number when there is only one). */
export function parseStopStaysParam(value: unknown): number[] {
  if (value == null || value === '') return []
  return canonicalStopStays(String(value).split(','))
}

/**
 * `qs.parse` gives a repeated param as an array but a single one as a string,
 * and core-utils' planParamsToQuery calls `.map` on it — so one stop in a URL
 * would throw. Always hand it an array.
 */
export function normalizeIntermediatePlacesParam(
  params: Record<string, any>
): Record<string, any> {
  const value = params?.intermediatePlaces
  if (value == null || Array.isArray(value)) return params
  return { ...params, intermediatePlaces: [value] }
}

/** A short name for a stop: the rider's label, else its coordinates. */
export function stopLabel(stop: StopPlace): string {
  if (stop.name) return stop.name
  return `${stop.lat.toFixed(5)}, ${stop.lon.toFixed(5)}`
}

/**
 * The OTP `via` list for the rider's stops: a VISIT of each coordinate, in
 * order, with the rider's minimum stay there (`PT0S` when none). Empty when
 * there are none.
 */
export function viaVisitLocations(
  stops: StopPlace[],
  stays: number[] = []
): Array<{
  visit: {
    coordinate: { latitude: number; longitude: number }
    label: string
    minimumWaitTime: string
  }
}> {
  return stops.map((stop, i) => ({
    visit: {
      coordinate: { latitude: stop.lat, longitude: stop.lon },
      label: stopLabel(stop),
      minimumWaitTime: stays[i] > 0 ? `PT${clampStopStay(stays[i])}M` : 'PT0S'
    }
  }))
}

/** Metres between two points; small-distance equirectangular is plenty here. */
function metresBetween(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const rad = Math.PI / 180
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad)
  const y = (b.lat - a.lat) * rad
  return Math.sqrt(x * x + y * y) * 6371000
}

function placeNear(place: any, stop: StopPlace): boolean {
  if (!isStopPlace(place)) return false
  return (
    metresBetween(
      { lat: Number(place.lat), lon: Number(place.lon) },
      { lat: stop.lat, lon: stop.lon }
    ) <= STOP_MATCH_M
  )
}

/**
 * Find where an itinerary reaches each stop and say so on it.
 *
 * OTP marks a visited coordinate only by splitting the street leg there: one
 * leg ends at "<label> (lat, lon)" and the next starts from it. Stops are
 * matched in visiting order, each after the previous one's boundary, and never
 * on the final leg (that one ends at the destination). The place is renamed to
 * the rider's own label on both legs. Stops OTP did not route through are left
 * unmarked. Returns the input unchanged when nothing matched.
 *
 * With `stays` (58.3) each matched stop also gets its stay: recorded on the
 * itinerary (`stopStayMinutes`), on the leaving leg's place (`riderStop`), and
 * moved into the legs where OTP did not put it (`applyStopStays`).
 */
export function markStopLegs(
  itinerary: Itinerary,
  stops: StopPlace[],
  stays: number[] = []
): MultiStopItinerary {
  const legs = itinerary?.legs || []
  if (!stops.length || legs.length < 2) return itinerary
  const indexes: number[] = []
  // Which stop each boundary is: a stop OTP skipped is not counted, so the
  // n-th boundary is not always the n-th stop.
  const matched: number[] = []
  let from = 0
  stops.forEach((stop, n) => {
    for (let i = from; i < legs.length - 1; i++) {
      if (placeNear(legs[i].to, stop)) {
        indexes.push(i)
        matched.push(n)
        from = i + 1
        return
      }
    }
  })
  if (!indexes.length) return itinerary
  const stayMinutes = matched.map((n) => clampStopStay(stays[n]))
  const shifted = applyStopStays(
    { ...itinerary, stopLegIndexes: indexes } as MultiStopItinerary,
    stayMinutes
  )
  const named = (shifted.legs || []).map((leg) => leg)
  indexes.forEach((legIndex, k) => {
    const name = stopLabel(stops[matched[k]])
    const riderStop: RiderStopMark = {
      arrivalTime: epochMs(named[legIndex].endTime as any),
      stayMinutes: stayMinutes[k]
    }
    named[legIndex] = {
      ...named[legIndex],
      to: { ...named[legIndex].to, name }
    } as Leg
    named[legIndex + 1] = {
      ...named[legIndex + 1],
      from: { ...named[legIndex + 1].from, name, riderStop }
    } as Leg
  })
  return {
    ...shifted,
    legs: named,
    stopLegIndexes: indexes,
    stopStayMinutes: stayMinutes
  }
}

/**
 * Put each stop's stay where the rider spends it: at the stop.
 *
 * Measured against production OTP 2026-10-18 (home → Perennial Cycle → Micro
 * Center, 10:00, `minimumWaitTime: PT20M`): OTP honours the stay — arrival
 * 12:10:40 against 11:44 with none — but never as a gap at the stop. The walk
 * away from it starts the second the walk in ends (10:59:26 → 10:59:26) and
 * the 20 minutes sit inside the wait for the next bus (walk ends 11:11:16, bus
 * 11:34), so a leave time read off the legs said the rider left on arrival.
 * Here the street legs between a stop and the next transit leg are moved later
 * by the stay — never past that bus — so they leave at arrival + stay, and the
 * wait at the bus shrinks by as much. The chain path already leaves a gap
 * (each segment is asked from arrival + stay); a gap already there counts.
 * A stop with no bus after it before the next stop or the destination keeps
 * its legs: there is no wait to move. Pure; legs untouched when no stay.
 */
export function applyStopStays(
  itinerary: MultiStopItinerary,
  stayMinutes: number[]
): MultiStopItinerary {
  const legs = itinerary?.legs || []
  const cuts = itinerary?.stopLegIndexes || []
  if (!cuts.length || !stayMinutes.some((m) => m > 0)) return itinerary
  const out: Leg[] = legs.map((leg) => leg)
  let movedS = 0
  cuts.forEach((cut, k) => {
    const stayMs = clampStopStay(stayMinutes[k]) * 60000
    if (!stayMs || cut + 1 >= out.length) return
    const nextCut = cuts[k + 1] ?? out.length - 1
    let board = cut + 1
    while (board <= nextCut && !out[board].transitLeg) board++
    // No bus before the next stop (nothing to move the stay out of), or the
    // bus leaves from the stop itself (its own wait already is the stay).
    if (board > nextCut || board === cut + 1) return
    const arrive = epochMs(out[cut].endTime as any)
    const leave = epochMs(out[cut + 1].startTime as any)
    const walkEnd = epochMs(out[board - 1].endTime as any)
    const boardAt = epochMs(out[board].startTime as any)
    if (![arrive, leave, walkEnd, boardAt].every(Number.isFinite)) return
    const wanted = stayMs - Math.max(0, leave - arrive)
    const shift = Math.min(wanted, boardAt - walkEnd)
    if (shift <= 0) return
    for (let i = cut + 1; i < board; i++) {
      out[i] = {
        ...out[i],
        endTime: epochMs(out[i].endTime as any) + shift,
        startTime: epochMs(out[i].startTime as any) + shift
      } as Leg
    }
    movedS += Math.round(shift / 1000)
  })
  if (!movedS) return itinerary
  const waiting = Number((itinerary as any).waitingTime)
  return {
    ...itinerary,
    legs: out,
    ...(Number.isFinite(waiting)
      ? { waitingTime: Math.max(0, waiting - movedS) }
      : null)
  }
}

/**
 * When the rider reaches each stop and when the plan leaves it, with the stay
 * asked for there (58.3). Read off the legs, so it is whatever the card's
 * own itinerary says.
 */
export function itineraryStopTimes(itinerary: any): StopTimes[] {
  const indexes: number[] = itinerary?.stopLegIndexes || []
  const legs = itinerary?.legs || []
  const stays: number[] = itinerary?.stopStayMinutes || []
  const out: StopTimes[] = []
  indexes.forEach((i, k) => {
    const arriving = legs[i]
    const leaving = legs[i + 1]
    if (!arriving || !leaving) return
    out.push({
      arrivalTime: epochMs(arriving.endTime),
      leaveTime: epochMs(leaving.startTime),
      name: arriving.to?.name || '',
      stayMinutes: clampStopStay(stays[k])
    })
  })
  return out
}

/** The names of the stops an itinerary runs through, in order. */
export function itineraryStopNames(itinerary: any): string[] {
  const indexes: number[] = itinerary?.stopLegIndexes || []
  const legs = itinerary?.legs || []
  return indexes.map((i) => legs[i]?.to?.name).filter(Boolean)
}

/** Total distance of every leg, in metres. */
export function itineraryDistanceM(itinerary: any): number {
  return (itinerary?.legs || []).reduce(
    (sum: number, leg: any) => sum + (Number(leg?.distance) || 0),
    0
  )
}

/** Recompute the whole-itinerary totals for a run of legs. */
function itineraryOf(base: any, legs: Leg[]): Itinerary {
  const start = epochMs(legs[0]?.startTime as any)
  const end = epochMs(legs[legs.length - 1]?.endTime as any)
  const walkLegs = legs.filter((l) => l.mode === 'WALK')
  const transitLegs = legs.filter((l) => l.transitLeg)
  const next: any = {
    ...base,
    duration:
      Number.isFinite(start) && Number.isFinite(end)
        ? Math.round((end - start) / 1000)
        : base.duration,
    endTime: legs[legs.length - 1]?.endTime,
    legs,
    startTime: legs[0]?.startTime,
    transfers: Math.max(0, transitLegs.length - 1),
    transitTime: transitLegs.reduce((s, l) => s + (l.duration || 0), 0),
    walkDistance: walkLegs.reduce((s, l) => s + (l.distance || 0), 0),
    walkTime: walkLegs.reduce((s, l) => s + (l.duration || 0), 0)
  }
  // The pieces are not themselves multi-stop.
  delete next.stopLegIndexes
  delete next.stopStayMinutes
  return next as Itinerary
}

/**
 * Split a multi-stop itinerary at its stops: segment k runs from the previous
 * stop (or the origin) to stop k, and the last one to the destination. A plain
 * itinerary comes back as a single segment.
 */
export function splitAtStops(itinerary: MultiStopItinerary): Itinerary[] {
  const legs = itinerary?.legs || []
  const cuts = (itinerary?.stopLegIndexes || []).filter(
    (i) => i >= 0 && i < legs.length - 1
  )
  if (!cuts.length) return [itinerary]
  const segments: Itinerary[] = []
  let start = 0
  cuts.forEach((cut) => {
    segments.push(itineraryOf(itinerary, legs.slice(start, cut + 1)))
    start = cut + 1
  })
  segments.push(itineraryOf(itinerary, legs.slice(start)))
  return segments
}

/**
 * Go Mode's plan for a multi-stop itinerary, starting at the first segment.
 * Null for a plain one — Go Mode then runs exactly as it always has.
 */
export function buildMultiStopPlan(
  itinerary: MultiStopItinerary | null | undefined,
  roundTrip: RoundTripPlan | null = null
): MultiStopPlan | null {
  if (!itinerary?.stopLegIndexes?.length) return null
  const segments = splitAtStops(itinerary)
  if (segments.length < 2) return null
  return {
    index: 0,
    roundTrip,
    segments,
    stopNames: segments.map((s) => {
      const legs = s.legs || []
      return legs[legs.length - 1]?.to?.name || ''
    })
  }
}

/** True while the segment being guided ends at a stop, not the destination. */
export function hasNextSegment(
  plan: MultiStopPlan | null | undefined
): boolean {
  return (
    !!plan &&
    Array.isArray(plan.segments) &&
    plan.index >= 0 &&
    plan.index < plan.segments.length - 1
  )
}

/** The street mode a segment rides when it has no transit, else null. */
export function segmentStreetMode(segment: Itinerary | null | undefined) {
  const legs = segment?.legs || []
  if (!legs.length || legs.some((l) => l.transitLeg)) return null
  return legs.find((l) => l.mode !== 'WALK')?.mode || 'WALK'
}

/**
 * The fresh plan for the next segment that is still the trip the rider chose:
 * the same routes in the same order, ridden the same way (a bike segment stays
 * a bike segment, a walk stays a walk). Null when the fresh answer has no such
 * option — the caller then keeps the stored segment, and Go Mode's own
 * missed-bus handling moves it to the next departure of the same route. Never
 * another route or mode: those are the rider's to choose, from the reroute
 * button (backlog 43.1; the no-forced-route-changes rule).
 */
export function pickNextSegment(
  fresh: Itinerary[] | null | undefined,
  stored: Itinerary | null | undefined
): Itinerary | null {
  if (!fresh?.length || !stored) return null
  const want = routeSequence(stored)
  const bikes = (it: Itinerary) =>
    (it.legs || []).some((l) => l.mode === 'BICYCLE')
  const streetMode = segmentStreetMode(stored)
  return (
    fresh.find(
      (c) =>
        routeSequence(c) === want &&
        bikes(c) === bikes(stored) &&
        (want || segmentStreetMode(c) === streetMode)
    ) || null
  )
}

/**
 * Stitch per-segment itineraries into one trip (the chain used where OTP's via
 * does not apply). Null if any segment is missing.
 *
 * By default each segment's legs are shifted so it starts when the previous
 * one ends — right for street-only segments, which leave whenever the rider
 * does. `keepTimes` leaves every leg at the time it was planned: a transit
 * segment's bus runs on its schedule, so the time between one segment's
 * arrival and the next one's departure is the rider waiting at the stop
 * (backlog 52.1). `stopLegIndexes` are the same either way.
 *
 * `stays` (58.3), minutes per stop: shifted segments start that long after the
 * previous one ends; with `keepTimes` the stay is not counted as waiting.
 */
export function stitchSegments(
  segments: Array<Itinerary | null | undefined>,
  {
    keepTimes = false,
    stays = []
  }: { keepTimes?: boolean; stays?: number[] } = {}
): MultiStopItinerary | null {
  if (!segments.length || segments.some((s) => !s?.legs?.length)) return null
  const legs: Leg[] = []
  const stopLegIndexes: number[] = []
  let cursor = epochMs((segments[0] as Itinerary).startTime as any)
  let waitingS = 0
  segments.forEach((segment, n) => {
    const seg = segment as Itinerary
    const segStart = epochMs(seg.startTime as any)
    if (keepTimes) {
      if (n > 0 && Number.isFinite(cursor) && Number.isFinite(segStart)) {
        const stayS = clampStopStay(stays[n - 1]) * 60
        waitingS += Math.max(0, Math.round((segStart - cursor) / 1000) - stayS)
      }
      waitingS += Number((seg as any).waitingTime) || 0
    }
    const shift =
      !keepTimes && Number.isFinite(cursor) && Number.isFinite(segStart)
        ? cursor - segStart
        : 0
    seg.legs.forEach((leg) => {
      legs.push({
        ...leg,
        endTime: epochMs(leg.endTime as any) + shift,
        startTime: epochMs(leg.startTime as any) + shift
      } as Leg)
    })
    cursor = epochMs(legs[legs.length - 1].endTime as any)
    if (n < segments.length - 1) {
      stopLegIndexes.push(legs.length - 1)
      // The next segment starts once the stay here is over (shifted only).
      if (!keepTimes) cursor += clampStopStay(stays[n]) * 60000
    }
  })
  return {
    ...itineraryOf(segments[0], legs),
    ...(keepTimes ? { waitingTime: waitingS } : null),
    stopLegIndexes
  }
}
