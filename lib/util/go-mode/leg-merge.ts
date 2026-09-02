import { decode, encode } from '@mapbox/polyline'
import type { Itinerary, Leg } from '@opentripplanner/types'

import { legLocationsAreEqual } from '../itinerary'

/**
 * One bus ride is one leg.
 *
 * On the 8/2 Orange Line ride the rider's single continuous ride from I-35W &
 * Lake St to 46th St was rendered as TWO legs of the same trip (1:1201789)
 * with a fake 5-minute transfer at 66th St and the fare charged twice. The
 * split came out of buildOnboardItinerary: it prepends a synthesized bus leg
 * to the onward plan, and OTP's onward plan legitimately began with the very
 * same trip continuing. Prepending was the bug; merging is the fix.
 *
 * Model: spliceAccessOntoItinerary, the repo's other sanctioned splicer —
 * untouched legs are reused BY REFERENCE and only container fields are
 * recomputed. That promise is load-bearing (7/29 "only reroute the bike leg"),
 * so every function here returns its input reference when it changes nothing.
 */

/** The trip a leg serves, in either shape the app produces. */
export function legTripId(leg: any): string | null {
  return leg?.trip?.gtfsId || leg?.tripId || null
}

/** Same physical place: prefer stop identity, fall back to coordinates. */
function stopsAreSame(a: any, b: any): boolean {
  const aId = a?.stop?.gtfsId || a?.stop?.id || a?.stopId
  const bId = b?.stop?.gtfsId || b?.stop?.id || b?.stopId
  if (aId && bId) return aId === bId
  return legLocationsAreEqual(a, b)
}

/**
 * May these two consecutive legs be one? All four must hold:
 * both transit, the same non-null trip, contiguous (a's alight IS b's board),
 * and ordered. Contiguity is what stops a loop route that serves the same trip
 * id twice non-contiguously from collapsing into one leg.
 *
 * Ordering compares startTime, NOT `b.start >= a.end`: a synthesized leg's
 * endTime can be inverted (an arrival already in the past), and the merge runs
 * before the container clamp.
 */
function legsAreOneRide(a: any, b: any): boolean {
  const tripId = legTripId(a)
  return (
    !!a?.transitLeg &&
    !!b?.transitLeg &&
    tripId != null &&
    tripId === legTripId(b) &&
    stopsAreSame(a.to, b.from) &&
    Number(b.startTime) >= Number(a.startTime)
  )
}

/** Decoded points of a leg's geometry, or [] when it has none. */
function decodePoints(leg: any): [number, number][] {
  const points = leg?.legGeometry?.points
  if (!points) return []
  try {
    return decode(points) as [number, number][]
  } catch {
    return []
  }
}

const EARTH_RADIUS_M = 6371000

function haversine(
  [lat1, lon1]: [number, number],
  [lat2, lon2]: [number, number]
): number {
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δφ = ((lat2 - lat1) * Math.PI) / 180
  const Δλ = ((lon2 - lon1) * Math.PI) / 180
  const h =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

/** Metres along a decoded polyline. */
export function polylineLength(points: [number, number][]): number {
  let total = 0
  for (let i = 1; i < points.length; i++)
    total += haversine(points[i - 1], points[i])
  return total
}

/** Fare products of both legs, de-duplicated by product id. */
function mergeFareProducts(a: any, b: any): any[] | undefined {
  const all = [...(a.fareProducts || []), ...(b.fareProducts || [])]
  // Never emit undefined: the fare table does
  // `transitLegs.flatMap(leg => leg.fareProducts)` and then reads `.product`
  // off each entry, so a missing array takes the trip-details panel down.
  if (!a.fareProducts && !b.fareProducts) return undefined
  const seen = new Set<string>()
  const unique: any[] = []
  for (const fp of all) {
    const id = fp?.product?.id ?? fp?.id ?? JSON.stringify(fp)
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(fp)
  }
  return unique
}

/** Field-wise prefer-defined, `a` winning ties — so a synthesized `{gtfsId}`
 * gains stoptimes/pattern from the real leg rather than shadowing them. */
function preferDefined(a: any, b: any): any {
  if (a == null) return b
  if (b == null) return a
  if (typeof a !== 'object' || typeof b !== 'object') return a
  const out: any = { ...b }
  for (const k of Object.keys(a)) {
    if (a[k] != null) out[k] = a[k]
  }
  return out
}

/**
 * The junction stop, as an intermediatePlaces entry.
 *
 * THE most important field in the merge. Without it the stop where the split
 * used to be (I-35W & 66th St Station on 8/2) simply vanishes, and the merged
 * leg is still effectively one hop — which leaves the stop counter with
 * nothing to count and the GET READY banner pinned at "1 stop remaining" for
 * the whole ride. With it, orderedStopsOnLeg genuinely counts down.
 */
function junctionPlace(a: any, b: any): any {
  const place = a.to || b.from
  return {
    arrivalTime: Number(a.endTime),
    departureTime: Number(b.startTime),
    lat: place?.lat,
    lon: place?.lon,
    name: place?.name,
    stop: place?.stop
  }
}

/** Which intermediate key a leg actually used — orderedStopsOnLeg prefers
 * intermediatePlaces and falls back to intermediateStops, so keep whichever
 * shape the data arrived in. */
function intermediateKey(
  a: any,
  b: any
): 'intermediatePlaces' | 'intermediateStops' {
  if (a.intermediatePlaces || b.intermediatePlaces) return 'intermediatePlaces'
  if (a.intermediateStops || b.intermediateStops) return 'intermediateStops'
  return 'intermediatePlaces'
}

function mergeTwo(a: any, b: any): any {
  const key = intermediateKey(a, b)
  const intermediates = [
    ...(a[key] || a.intermediatePlaces || a.intermediateStops || []),
    junctionPlace(a, b),
    ...(b[key] || b.intermediatePlaces || b.intermediateStops || [])
  ]

  const points = [...decodePoints(a), ...decodePoints(b)]
  const geometry = points.length
    ? { length: points.length, points: encode(points) }
    : a.legGeometry || b.legGeometry

  // The synthesized onboard leg carries distance: 0, which is a lie — summing
  // would inherit it. Recompute from the merged geometry whenever we have one.
  const distance = points.length
    ? polylineLength(points)
    : (a.distance || 0) + (b.distance || 0)

  const startTime = a.startTime
  const endTime = b.endTime
  const fareProducts = mergeFareProducts(a, b)
  // The list we did NOT merge into must not survive: hasDegenerateStopList
  // sums both keys as "claimed", so a leftover copy would make a perfectly
  // good merged leg read as degenerate.
  const dropped =
    key === 'intermediatePlaces' ? 'intermediateStops' : 'intermediatePlaces'

  return {
    // Every scalar the rules below don't name: prefer a's, fill a's holes
    // from b. That is what repairs the synthesized leg from the real one.
    ...b,
    ...Object.fromEntries(Object.entries(a).filter(([, v]) => v != null)),
    distance,
    duration: (Number(endTime) - Number(startTime)) / 1000,
    endTime,
    ...(fareProducts ? { fareProducts } : {}),
    [dropped]: undefined,
    from: a.from,
    [key]: intermediates,
    legGeometry: geometry,
    realTime: !!a.realTime || !!b.realTime,
    route: preferDefined(a.route, b.route),
    startTime,
    to: b.to,
    trip: preferDefined(a.trip, b.trip)
  }
}

/**
 * Collapse every run of consecutive legs serving one trip into a single leg.
 * Returns the input array itself when nothing merges.
 */
export function mergeAdjacentSameTripLegs(
  legs: Leg[] | null | undefined
): Leg[] {
  if (!legs?.length) return legs || []
  let changed = false
  const out: any[] = [legs[0]]
  for (let i = 1; i < legs.length; i++) {
    const prev = out[out.length - 1]
    if (legsAreOneRide(prev, legs[i])) {
      out[out.length - 1] = mergeTwo(prev, legs[i])
      changed = true
    } else {
      out.push(legs[i])
    }
  }
  return changed ? (out as Leg[]) : legs
}

/**
 * Shift any leg that starts before the previous one ends forward until it
 * doesn't, carrying the rest of the itinerary with it and preserving each leg's
 * own duration. Returns the input reference untouched when the itinerary is
 * already monotonic.
 *
 * 2026-08-09: the onboard optimizer grafted an onward plan anchored to a
 * poisoned realtime arrival onto the live bus leg, so leg 1 started 680,170 ms
 * BEFORE leg 0 ended and the trip sheet read 7:29 PM above 7:18 PM. The cause is
 * fixed upstream in getDownstreamStops; this is the boundary that makes the
 * symptom impossible whatever the next feed does.
 *
 * Repairs rather than refuses: refusing would leave a rider mid-ride with no
 * trip at all. The console.warn is the tripwire — telemetry captures console
 * lines, and a new redux action would be silently dropped unless added to
 * create-otp-reducer's explicit case list.
 *
 * Called ONLY from buildOnboardItinerary, where the whole grafted tail hangs
 * off one anchor and shifting it is exactly right. Deliberately NOT called from
 * beginGoMode, which looked like the natural boundary and is not: an access
 * replan legitimately produces a walk leg that overruns the next bus's
 * departure — the rider may miss it, and the app must say so rather than invent
 * a later bus. That path also promises its suffix legs are the SAME objects
 * (the 7/29 "only reroute the bike leg" fix), which any repair would break.
 * `quietReplanAccessLeg (…) applies the splice: suffix legs are the ORIGINAL
 * objects` in __tests__/util/go-mode/reroute.ts is the test that says so.
 *
 * Also not part of normalizeGoModeItinerary, whose documented invariant is that
 * startTime/endTime never move.
 */
export function repairLegTimeInversions(
  itinerary: Itinerary | null | undefined
): Itinerary | null | undefined {
  const legs = itinerary?.legs
  if (!legs?.length) return itinerary

  let shiftMs = 0
  let prevEnd: number | null = null
  const repaired: Leg[] = []
  const inversions: Array<{ byMs: number; leg: number }> = []

  for (let i = 0; i < legs.length; i++) {
    const leg: any = legs[i]
    const start = Number(leg.startTime)
    const end = Number(leg.endTime)
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      repaired.push(leg)
      prevEnd = null
      continue
    }
    if (prevEnd != null && start + shiftMs < prevEnd) {
      inversions.push({ byMs: prevEnd - (start + shiftMs), leg: i })
      shiftMs = prevEnd - start
    }
    if (shiftMs === 0) {
      repaired.push(leg)
      prevEnd = end
      continue
    }
    // Preserve the leg's own duration: both ends move by the same amount.
    const nextStart = start + shiftMs
    const nextEnd = end + shiftMs
    repaired.push({ ...leg, endTime: nextEnd, startTime: nextStart })
    prevEnd = nextEnd
  }

  if (!inversions.length) return itinerary

  // eslint-disable-next-line no-console
  console.warn(
    '[go-mode] repaired itinerary leg time inversion(s):',
    inversions
      .map((inv) => `leg ${inv.leg} started ${inv.byMs}ms early`)
      .join('; ')
  )

  // Max over every finite leg end, not just the last leg's — a trailing leg
  // with non-finite times would otherwise erase the recomputed end.
  const legEnd = repaired.reduce(
    (max: number, l: any) =>
      Number.isFinite(Number(l.endTime))
        ? Math.max(max, Number(l.endTime))
        : max,
    -Infinity
  )
  const from: any = itinerary
  const next: any = { ...from, legs: repaired }
  if (Number.isFinite(legEnd)) {
    next.endTime = Math.max(Number(from.endTime) || legEnd, legEnd)
    // Duration runs from the itinerary's own start: leg 0 never moves, so the
    // start is by construction unchanged.
    const start = Number.isFinite(Number(from.startTime))
      ? Number(from.startTime)
      : Number(repaired[0]?.startTime)
    if (Number.isFinite(start)) {
      next.duration = (Number(next.endTime) - start) / 1000
      if (from.waitingTime != null) {
        // Same definition normalizeGoModeItinerary uses: whatever the span
        // isn't spent moving. The shift lengthens the wait, not the legs.
        const moving = repaired.reduce(
          (sum: number, l: any) => sum + (Number(l.duration) || 0),
          0
        )
        next.waitingTime = Math.max(
          0,
          (Number(next.endTime) - start) / 1000 - moving
        )
      }
    }
  }
  return next as Itinerary
}

/**
 * The boundary pass every itinerary entering Go Mode goes through: merge the
 * legs, then recompute only the container fields the merge can invalidate.
 *
 * `transfers` is defined by the transit leg count, so a merge lowers it (1 → 0
 * on 8/2 — visible in the trip sheet and itinerary summary, and correct).
 * transitTime/waitingTime are recomputed only when the itinerary already
 * carried them. startTime/endTime never move: the merge cannot change when the
 * trip begins or ends.
 *
 * Returns the input reference when no legs merged — spliceAccessOntoItinerary
 * promises its suffix legs are the SAME objects, and this sits downstream of
 * it in beginGoMode.
 */
export function normalizeGoModeItinerary(
  itinerary: Itinerary | null | undefined
): Itinerary | null | undefined {
  if (!itinerary?.legs?.length) return itinerary
  const legs = mergeAdjacentSameTripLegs(itinerary.legs)
  if (legs === itinerary.legs) return itinerary

  const transitLegs = legs.filter((l: any) => l.transitLeg)
  const next: any = {
    ...itinerary,
    legs,
    transfers: Math.max(0, transitLegs.length - 1)
  }
  if ((itinerary as any).transitTime != null) {
    next.transitTime = transitLegs.reduce(
      (sum: number, l: any) => sum + (Number(l.duration) || 0),
      0
    )
  }
  if ((itinerary as any).waitingTime != null) {
    // Wait is whatever the trip's span isn't spent moving.
    const moving = legs.reduce(
      (sum: number, l: any) => sum + (Number(l.duration) || 0),
      0
    )
    next.waitingTime = Math.max(
      0,
      (Number(itinerary.endTime) - Number(itinerary.startTime)) / 1000 - moving
    )
  }
  return next as Itinerary
}
