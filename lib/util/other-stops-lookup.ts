/**
 * "Other stops" looks the other stops UP (backlog 21.5, third sighting).
 *
 * 2026-09-23 15:37, Bloomington -> 5116 27th Ave S: "Why am I not getting an
 * option to get off at 46th st station???" The Orange Line row had folded 13
 * runs and every one of them got on and off at the same pair, so the control
 * the 21.5 build had just shipped showed nothing. It could not have shown 46th
 * St: OTP answers ONE alight stop per connection, and the list could only ever
 * offer what the answer held.
 *
 * So on the first tap the row asks. For its representative run:
 *
 *  - get OFF elsewhere: the LAST transit leg's trip, the stops it serves after
 *    the rider boards it, up to five picked by the onboard list's own
 *    `selectCandidateStops`, and for each one a street plan from that stop to
 *    the destination at the bus's arrival there;
 *  - get ON elsewhere: the FIRST transit leg's trip, up to three stops it
 *    serves BEFORE the boarding stop that are closer to the origin than the
 *    boarding stop is, and for each a street plan from the origin arriving by
 *    the bus's departure there.
 *
 * Each answer is spliced into a whole itinerary — the representative's own
 * legs, the transit leg cut at the other stop, the street plan — and appended
 * to the search's results, where the route-signature merge folds it into the
 * row as one more get-on / get-off pair.
 *
 * The street plans ask for the row's own access mode ONLY (bike if the row
 * bikes anywhere, else walk). That is what keeps the answer on this row: a
 * plan allowed to use transit could come back as "get off at 46th St and take
 * the 46", which is a different row's trip, not another stop for this one. It
 * is also the cheapest question OTP can be asked, which matters on a server
 * that has timed out at 20 s under load (backlog 20.1).
 *
 * Not reused, deliberately: `buildOnboardItinerary` (actions/go-mode.ts). It
 * is the onboard flow's display itinerary and presupposes the rider is ABOARD
 * — the bus leg starts at `Date.now()`, its boarding stop comes from the
 * vehicle's next stop or the rider's GPS, and it carries `fareProducts: []`.
 * Here the rider is still at home planning, the bus leaves at the timetable's
 * time, and an empty fare list would make `itinerariesAreEqual` see a
 * different fare and file the result as a row of its own. The same reasoning
 * `retargetTransitLegToRun` (leg-merge.ts) gives for not using it. What IS
 * reused: the trip fetch and `pickTripServiceInstance`, `getDownstreamStops`,
 * `selectCandidateStops`, `findStopTimeIndex`, `settleCandidatePlans` (in the
 * action), and the leg-merge helpers for geometry and time repair.
 */
import { decode } from '@mapbox/polyline'
import type { Itinerary, Leg } from '@opentripplanner/types'

import {
  anchorGraftedTail,
  polylineLength,
  repairLegTimeInversions
} from './go-mode/leg-merge'
import { calculateDistance } from './go-mode/position-matching'
import {
  DownstreamStop,
  findStopTimeIndex,
  getDownstreamStops,
  selectCandidateStops,
  TripSchedule,
  TripStop
} from './go-mode/alight-optimizer'
import { sliceTripGeometryForLeg } from './go-mode/geometry'

/** Get-off stops asked about per tap: `selectCandidateStops`' own default. */
export const OTHER_STOPS_MAX_GET_OFF = 5
/** Get-on stops asked about per tap. 5 + 3 = the 8 plans one tap may cost. */
export const OTHER_STOPS_MAX_GET_ON = 3

interface LatLon {
  lat: number
  lon: number
}

export type LookupSide = 'off' | 'on'

/** One stop to ask about, with the bus's time there. */
export interface OtherStopCandidate {
  /** Epoch ms the bus is at this stop (arrival for off, departure for on). */
  busEpoch: number
  side: LookupSide
  stop: TripStop
  /** Index of this stop in the trip's stop list. */
  stopIndexInTrip: number
}

/** Index of the row's first and last transit legs, or -1. */
export function transitLegBounds(itinerary: Itinerary | null | undefined): {
  first: number
  last: number
} {
  const legs = itinerary?.legs || []
  let first = -1
  let last = -1
  legs.forEach((leg, i) => {
    if (!leg.transitLeg) return
    if (first < 0) first = i
    last = i
  })
  return { first, last }
}

/** The trip a transit leg rides, in either shape the app produces. */
export function legTripGtfsId(leg: any): string | null {
  return leg?.trip?.gtfsId || leg?.tripId || null
}

function placeStopId(place: any): string | null {
  return place?.stop?.gtfsId || place?.stopId || place?.stop?.id || null
}

/**
 * The street mode the rider covers the gaps with: BICYCLE when the row bikes
 * anywhere (the rider has the bike with them either side of the ride), else
 * WALK.
 */
export function streetModeOf(itinerary: Itinerary): 'BICYCLE' | 'WALK' {
  return (itinerary.legs || []).some(
    (leg) => !leg.transitLeg && leg.mode === 'BICYCLE'
  )
    ? 'BICYCLE'
    : 'WALK'
}

/**
 * Whether the fetched trip is the service day the leg rides. findTrip picks
 * today's or yesterday's instance against the wall clock, and a search for
 * tomorrow would otherwise read today's live predictions as tomorrow's.
 * Thirty minutes covers any delay the leg itself already carries.
 */
function instanceMatchesLeg(
  trip: TripSchedule,
  boardIdx: number,
  legStartMs: number
): boolean {
  const st = trip.stopTimes[boardIdx]
  if (!st?.serviceDay) return false
  const scheduled = (st.serviceDay + st.scheduledDeparture) * 1000
  return Math.abs(scheduled - legStartMs) <= 30 * 60 * 1000
}

/** The trip with its live predictions removed, for a mismatched instance. */
function scheduleOnly(trip: TripSchedule): TripSchedule {
  return {
    ...trip,
    stopTimes: trip.stopTimes.map((st) => ({
      ...st,
      realtimeArrival: undefined,
      realtimeState: 'SCHEDULED'
    }))
  }
}

/** Where a leg boards and alights in its trip's stop list (-1 when unknown). */
export function legStopIndexes(
  trip: TripSchedule | null | undefined,
  leg: any
): { alightIdx: number; boardIdx: number } {
  const stopTimes = trip?.stopTimes || []
  return {
    alightIdx: findStopTimeIndex(
      stopTimes,
      placeStopId(leg?.to),
      leg?.to?.name
    ),
    boardIdx: findStopTimeIndex(
      stopTimes,
      placeStopId(leg?.from),
      leg?.from?.name
    )
  }
}

/**
 * Every stop the trip serves from the leg's boarding stop on, timed as if the
 * rider were standing at the boarding stop when the leg departs: the anchor is
 * the boarding stop and "now" is the leg's departure, so each later stop gets
 * the timetable's running time from there (or the feed's live arrival).
 */
export function stopsAfterBoarding(
  trip: TripSchedule,
  leg: any,
  dest: LatLon
): DownstreamStop[] {
  const { boardIdx } = legStopIndexes(trip, leg)
  const legStart = Number(leg?.startTime)
  if (boardIdx < 0 || !Number.isFinite(legStart)) return []
  const source = instanceMatchesLeg(trip, boardIdx, legStart)
    ? trip
    : scheduleOnly(trip)
  return getDownstreamStops(
    source,
    { nextStopId: trip.stopTimes[boardIdx].stop.id },
    null,
    dest,
    legStart
  )
}

/**
 * Up to five other stops to get off the leg at, by the onboard list's own
 * `selectCandidateStops`. Two stops are never asked about: the one the row
 * already alights at, and any stop no closer to the destination than the
 * boarding stop — getting off where you are no nearer than where you got on
 * cannot beat not riding.
 */
export function getOffCandidates(
  trip: TripSchedule,
  leg: any,
  dest: LatLon,
  max = OTHER_STOPS_MAX_GET_OFF
): OtherStopCandidate[] {
  const downstream = stopsAfterBoarding(trip, leg, dest)
  if (downstream.length < 2) return []
  const boarding = downstream[0]
  const { alightIdx } = legStopIndexes(trip, leg)
  const pool = downstream
    .slice(1)
    .filter(
      (d) =>
        d.stopIndexInTrip !== alightIdx &&
        d.distanceToDest < boarding.distanceToDest
    )
  return selectCandidateStops(pool, max).map((d) => ({
    busEpoch: d.busArrivalEpoch,
    side: 'off',
    stop: d.stop,
    stopIndexInTrip: d.stopIndexInTrip
  }))
}

/**
 * Up to three stops before the boarding stop to get on at instead: only those
 * closer (straight line) to the origin than the boarding stop, nearest first.
 * A stop farther from the rider than the one they have is a longer ride to an
 * earlier bus, and is not worth a request. Timed by the timetable's running
 * time back from the leg's own departure.
 */
export function getOnCandidates(
  trip: TripSchedule,
  leg: any,
  origin: LatLon,
  max = OTHER_STOPS_MAX_GET_ON
): OtherStopCandidate[] {
  const stopTimes = trip?.stopTimes || []
  const { boardIdx } = legStopIndexes(trip, leg)
  const legStart = Number(leg?.startTime)
  if (boardIdx <= 0 || !Number.isFinite(legStart)) return []
  const boardSt = stopTimes[boardIdx]
  const distTo = (stop: TripStop) =>
    calculateDistance(stop.lat, stop.lon, origin.lat, origin.lon)
  const boardDist = distTo(boardSt.stop)
  const upstream: Array<OtherStopCandidate & { dist: number }> = []
  for (let i = 0; i < boardIdx; i++) {
    const st = stopTimes[i]
    if (!st?.stop || st.stop.lat == null || st.stop.lon == null) continue
    const dist = distTo(st.stop)
    if (dist >= boardDist) continue
    upstream.push({
      busEpoch:
        legStart - (boardSt.scheduledDeparture - st.scheduledDeparture) * 1000,
      dist,
      side: 'on',
      stop: st.stop,
      stopIndexInTrip: i
    })
  }
  return upstream
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max)
    .sort((a, b) => a.stopIndexInTrip - b.stopIndexInTrip)
    .map(({ dist, ...candidate }) => candidate)
}

function placeOf(stop: TripStop, extra: Record<string, unknown> = {}): any {
  return {
    lat: stop.lat,
    lon: stop.lon,
    name: stop.name,
    stop: { code: stop.code, gtfsId: stop.id, id: stop.id },
    stopCode: stop.code,
    stopId: stop.id,
    vertexType: 'TRANSIT',
    ...extra
  }
}

/**
 * The trip's time at each stop between two indexes, from the leg's own
 * departure and the timetable's running times.
 */
function timedStops(
  trip: TripSchedule,
  anchorIdx: number,
  anchorMs: number,
  fromIdx: number,
  toIdx: number
): Array<{ epoch: number; stop: TripStop }> {
  const stopTimes = trip.stopTimes
  const anchorSd = stopTimes[anchorIdx].scheduledDeparture
  const out: Array<{ epoch: number; stop: TripStop }> = []
  for (let i = fromIdx; i <= toIdx; i++) {
    const st = stopTimes[i]
    if (!st?.stop) continue
    out.push({
      epoch: anchorMs + (st.scheduledDeparture - anchorSd) * 1000,
      stop: st.stop
    })
  }
  return out
}

/**
 * The transit leg, ridden between two other stops of its own trip. Everything
 * the leg says about the ride — route, agency, fare products, headsign,
 * realtime — is kept; the ends, times, stops passed and geometry are re-cut
 * from the trip. Returns null when either stop is not on the trip.
 */
export function cutTransitLeg(
  leg: any,
  trip: TripSchedule,
  {
    endMs,
    fromIdx,
    startMs,
    toIdx
  }: { endMs: number; fromIdx: number; startMs: number; toIdx: number }
): any | null {
  const stopTimes = trip?.stopTimes || []
  const fromStop = stopTimes[fromIdx]?.stop
  const toStop = stopTimes[toIdx]?.stop
  if (!fromStop || !toStop || toIdx <= fromIdx) return null
  if (!(endMs > startMs)) return null

  const passed = timedStops(trip, fromIdx, startMs, fromIdx + 1, toIdx - 1)
  const cut: any = {
    ...leg,
    distance: leg.distance,
    duration: (endMs - startMs) / 1000,
    endTime: endMs,
    from: placeOf(fromStop, { departure: startMs }),
    intermediatePlaces: passed.map(({ epoch, stop }) => ({
      arrivalTime: epoch,
      departureTime: epoch,
      lat: stop.lat,
      lon: stop.lon,
      name: stop.name,
      stop: { code: stop.code, gtfsId: stop.id, id: stop.id }
    })),
    intermediateStops: passed.map(({ stop }) => ({
      lat: stop.lat,
      lon: stop.lon,
      name: stop.name,
      stopCode: stop.code,
      stopId: stop.id
    })),
    startTime: startMs,
    to: placeOf(toStop, { arrival: endMs }),
    // The old run's terminal stop calls describe the ride as OTP cut it.
    trip: leg.trip
      ? {
          ...leg.trip,
          arrivalStoptime: undefined,
          departureStoptime: undefined
        }
      : leg.trip
  }
  delete cut.stopCalls

  // Geometry: the trip's own shape when there is one (it covers stops past the
  // leg's end), else the leg's shape, which covers any stop inside the leg.
  const sliced =
    (trip.geometry?.points &&
      sliceTripGeometryForLeg(trip.geometry.points, cut)) ||
    (leg.legGeometry?.points &&
      sliceTripGeometryForLeg(leg.legGeometry.points, cut)) ||
    null
  if (sliced) {
    cut.legGeometry = sliced
    try {
      cut.distance = polylineLength(decode(sliced.points) as [number, number][])
    } catch {
      // Keep the leg's own distance.
    }
  }
  return cut
}

function finishItinerary(
  representative: Itinerary,
  legs: Leg[],
  side: LookupSide,
  stopId: string
): Itinerary | null {
  if (!legs.length) return null
  const startTime = Number(legs[0].startTime)
  const endTime = Number(legs[legs.length - 1].endTime)
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null
  const moving = legs.reduce(
    (sum, l: any) => sum + (Number(l.duration) || 0),
    0
  )
  const duration = (endTime - startTime) / 1000
  const {
    allStartTimes,
    index,
    rank,
    sameShapeVariants,
    totalFare,
    transitFare,
    ...base
  } = representative as any
  const spliced: any = {
    ...base,
    duration,
    endTime,
    legs,
    // Marked, so the merge never hands it the row, telemetry can count it,
    // and a test can tell a looked-up run from one OTP returned.
    otherStopsLookup: { side, stopId },
    startTime,
    transfers: Math.max(0, legs.filter((l) => l.transitLeg).length - 1),
    waitingTime: Math.max(0, duration - moving),
    walkTime: legs
      .filter((l) => l.mode === 'WALK')
      .reduce((sum, l: any) => sum + (Number(l.duration) || 0), 0)
  }
  return (repairLegTimeInversions(spliced) as Itinerary) || null
}

/**
 * The representative with its LAST transit leg ending at another stop, and
 * the street plan from there on to the destination.
 */
export function spliceGetOff(
  representative: Itinerary,
  trip: TripSchedule,
  candidate: OtherStopCandidate,
  onward: Itinerary
): Itinerary | null {
  const { last } = transitLegBounds(representative)
  if (last < 0 || !onward?.legs?.length) return null
  const leg: any = representative.legs[last]
  const { boardIdx } = legStopIndexes(trip, leg)
  const cut = cutTransitLeg(leg, trip, {
    endMs: candidate.busEpoch,
    fromIdx: boardIdx,
    startMs: Number(leg.startTime),
    toIdx: candidate.stopIndexInTrip
  })
  if (!cut) return null
  // The street plan was asked for at the bus's arrival, but a plan's time is
  // whole minutes: measured on the 15:37 replay, every one of the five came
  // back starting 8-47 s BEFORE the bus got there. Street legs have no
  // timetable, so push them onto the arrival...
  const onwardStart = Number(onward.legs[0]?.startTime)
  const push =
    Number.isFinite(onwardStart) && onwardStart < cut.endTime
      ? cut.endTime - onwardStart
      : 0
  const onwardLegs = (onward.legs as any[]).map((l) =>
    push && !l.transitLeg
      ? {
          ...l,
          endTime: Number(l.endTime) + push,
          startTime: Number(l.startTime) + push
        }
      : l
  )
  // ...and pull a later one back onto it, so there is no hole either.
  const tail =
    anchorGraftedTail([cut, ...onwardLegs] as Leg[]) ||
    ([cut, ...onwardLegs] as Leg[])
  return finishItinerary(
    representative,
    [...representative.legs.slice(0, last), ...tail],
    'off',
    candidate.stop.id
  )
}

/**
 * The representative with its FIRST transit leg starting at another stop, and
 * the street plan from the origin arriving there in time for it.
 */
export function spliceGetOn(
  representative: Itinerary,
  trip: TripSchedule,
  candidate: OtherStopCandidate,
  access: Itinerary
): Itinerary | null {
  const { first } = transitLegBounds(representative)
  if (first < 0 || !access?.legs?.length) return null
  const leg: any = representative.legs[first]
  const { alightIdx } = legStopIndexes(trip, leg)
  const cut = cutTransitLeg(leg, trip, {
    endMs: Number(leg.endTime),
    fromIdx: candidate.stopIndexInTrip,
    startMs: candidate.busEpoch,
    toIdx: alightIdx
  })
  if (!cut) return null
  const accessLegs = access.legs as Leg[]
  const arrive = Number(accessLegs[accessLegs.length - 1]?.endTime)
  // An access plan that cannot make the bus is not a way to catch it.
  if (!Number.isFinite(arrive) || arrive > candidate.busEpoch) return null
  return finishItinerary(
    representative,
    [...accessLegs, cut, ...representative.legs.slice(first + 1)],
    'on',
    candidate.stop.id
  )
}
